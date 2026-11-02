import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { Router } from 'express';
import { audit } from '../audit.js';
import { normalizeText, faKey } from '../lib/normalize.js';
import { parseJalali, toJalaliInput, faDigits } from '../lib/jalali.js';
import { notFound as notFoundPage } from '../lib/http.js';
import {
  isPatientCode, ensurePatientDir, safeName, uniqueName, trashName, resolvePatientFile, listPatientFiles,
} from '../lib/files.js';
import { checkUpload, MAX_UPLOAD_BYTES, HEAD_BYTES, MIME, EXT_TYPE } from '../lib/uploads.js';

const router = Router();
export const CATEGORIES = ['consent', 'lab', 'imaging', 'surgery', 'other'];
const INLINE_TYPES = new Set(['pdf', 'jpg', 'png']);

// Uploads land in data/tmp first and are only moved into the patient folder after every check passes.
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const tmp = path.join(req.app.locals.dataDir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    cb(null, tmp);
  },
  filename: (req, file, cb) => cb(null, crypto.randomUUID()),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 12, fieldSize: 10_000, parts: 14 },
}).single('file');

// The new-patient form (D49) is multipart so it can carry the first documents along with every patient field.
// All files together stay at most NEW_FILES_BYTES, below the 35 MB Caddy body limit.
export const NEW_FILES_MAX = 10;
export const NEW_FILES_BYTES = MAX_UPLOAD_BYTES;
const newPatientUpload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: NEW_FILES_MAX, fields: 60, fieldSize: 100_000, parts: 72 },
}).array('files', NEW_FILES_MAX);

function findPatient(db, code) {
  return isPatientCode(code) ? db.prepare('SELECT * FROM patients WHERE code = ?').get(code) : undefined;
}

// `full` comes from resolvePatientFile(). The folder is passed as `root` so the dotfile rule applies to the
// filename only: an absolute path with a dot-directory in it (for example a data folder under ~/.local) must still work.
function sendPatientFile(res, full) {
  res.sendFile(path.basename(full), { root: path.dirname(full), dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

const notFound = (res) => notFoundPage(res, 'پرونده یا فایل مورد نظر پیدا نشد.');

// Content-Disposition with an ASCII fallback plus the UTF-8 name, so Persian filenames survive.
function disposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// Validates the metadata fields shared by upload and classify. Returns { values, errors }.
function validateMeta(body) {
  const errors = {};
  const category = normalizeText(body.category) || 'other';
  if (!CATEGORIES.includes(category)) errors.category = 'طبقه‌بندی نامعتبر است.';
  const rawDate = normalizeText(body.doc_date);
  let docDate = null;
  if (rawDate) {
    docDate = parseJalali(rawDate);
    if (!docDate) errors.doc_date = 'تاریخ را به شکل ۱۴۰۳/۰۵/۱۲ وارد کنید.';
  }
  const title = normalizeText(body.title);
  const notes = normalizeText(body.notes);
  if (title.length > 200) errors.title = 'عنوان بیش از حد طولانی است.';
  if (notes.length > 2000) errors.notes = 'یادداشت بیش از حد طولانی است.';
  return { values: { category, doc_date: docDate, title: title || null, notes: notes || null }, errors };
}

// The folder on disk decides which files exist; database rows only add metadata.
export function documentsFor(db, dataDir, patient, { category = '', q = '' } = {}) {
  const meta = new Map(db.prepare('SELECT * FROM documents WHERE patient_id = ?').all(patient.id).map((r) => [r.filename, r]));
  const needle = faKey(q);
  return listPatientFiles(dataDir, patient.code)
    .map((f) => ({ ...f, row: meta.get(f.filename) ?? null }))
    .filter((d) => {
      if (category === 'unclassified') return !d.row;
      if (CATEGORIES.includes(category) && d.row?.category !== category) return false;
      if (needle && !faKey(`${d.filename} ${d.row?.title ?? ''}`).includes(needle)) return false;
      return true;
    });
}

function renderDocuments(req, res, patient, { status = 200, error = null, values = {}, errors = {} } = {}) {
  const { db, dataDir } = req.app.locals;
  const category = String(req.query.category ?? '');
  const q = normalizeText(String(req.query.q ?? '').slice(0, 100));
  res.status(status).render('documents/index', {
    active: 'patients', patient, error, values, errors, category, q,
    docs: documentsFor(db, dataDir, patient, { category, q }),
    toJalaliInput,
  });
}

router.get('/patients/:code/documents', (req, res) => {
  const patient = findPatient(req.app.locals.db, req.params.code);
  if (!patient) return notFound(res);
  renderDocuments(req, res, patient);
});

// Runs multer, then applies the D19 checks to the received file. Resolves to an upload ({ tmpPath, originalName,
// check, discard }) or to { problem } with problem 'size' | 'bad' | 'missing' | 'type' (plus a Persian `message`
// for 'type'). The temp file is removed on every problem; unexpected errors are thrown to the error handler.
async function receiveUpload(req, res) {
  const err = await new Promise((resolve) => upload(req, res, resolve));
  const tmpPath = req.file?.path;
  const discard = () => { if (tmpPath) fs.rmSync(tmpPath, { force: true }); };
  if (err) {
    discard();
    if (err instanceof multer.MulterError) return { problem: err.code === 'LIMIT_FILE_SIZE' ? 'size' : 'bad' };
    if (err.errno === undefined) return { problem: 'bad' }; // malformed or cut-off multipart from the client
    throw err; // a server-side failure such as a full disk
  }
  if (!req.file) return { problem: 'missing' };
  try {
    const up = checkReceived(req.file);
    if (!up.check.ok) { discard(); return { problem: 'type', message: up.check.error }; }
    return { ...up, discard };
  } catch (e) {
    discard();
    throw e;
  }
}

// Applies the D19 checks to one file multer has written to data/tmp: { tmpPath, originalName, check }.
function checkReceived(file) {
  // busboy decodes multipart filenames as latin1; recover the UTF-8 bytes.
  const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const head = Buffer.alloc(HEAD_BYTES);
  const fd = fs.openSync(file.path, 'r');
  let read;
  try { read = fs.readSync(fd, head, 0, HEAD_BYTES, 0); } finally { fs.closeSync(fd); }
  return { tmpPath: file.path, originalName, check: checkUpload({ originalName, size: file.size, head: head.subarray(0, read) }) };
}

// Parses the multipart new-patient form (it also fills req.body) and checks every attached file.
// Resolves to { files, error, discard }: `files` are checked uploads ready for saveDocument(), `error` a Persian
// message when the request or any file fails (then no file may be kept). discard() removes what is still in data/tmp.
export async function receiveNewPatientFiles(req, res) {
  const err = await new Promise((resolve) => newPatientUpload(req, res, resolve));
  const received = req.files ?? [];
  const discard = () => received.forEach((f) => fs.rmSync(f.path, { force: true }));
  if (err) {
    discard();
    if (!(err instanceof multer.MulterError) && err.errno !== undefined) throw err; // a server-side failure such as a full disk
    const error = err.code === 'LIMIT_FILE_SIZE' ? UPLOAD_MESSAGES.size
      : err.code === 'LIMIT_FILE_COUNT' ? `حداکثر ${faDigits(NEW_FILES_MAX)} فایل را می‌توان یک‌جا بارگذاری کرد.`
        : UPLOAD_MESSAGES.bad;
    return { files: [], error, discard };
  }
  try {
    if (received.reduce((n, f) => n + f.size, 0) > NEW_FILES_BYTES) {
      return { files: [], error: `حجم همه‌ی فایل‌ها با هم بیش از ${faDigits(NEW_FILES_BYTES / 1048576)} مگابایت است.`, discard };
    }
    const files = received.map(checkReceived);
    const bad = files.find((up) => !up.check.ok);
    if (bad) return { files: [], error: `${bad.originalName}: ${bad.check.error}`, discard };
    return { files, error: null, discard };
  } catch (e) {
    discard();
    throw e;
  }
}

// Moves a checked upload into the patient folder and records its metadata. Call inside a transaction.
export function saveDocument(db, dataDir, patient, up, values, userId) {
  const filename = storeUpload(dataDir, patient.code, up);
  db.prepare(`INSERT INTO documents (patient_id, filename, category, title, doc_date, notes, uploaded_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (patient_id, filename) DO UPDATE SET category = excluded.category, title = excluded.title,
                doc_date = excluded.doc_date, notes = excluded.notes,
                uploaded_by = excluded.uploaded_by, uploaded_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`)
    .run(patient.id, filename, values.category, values.title, values.doc_date, values.notes, userId);
  audit(db, { userId, action: 'document_upload', patientId: patient.id, detail: up.check.type });
}

// Moves a checked upload into the patient folder under a safe, unused name and returns that name.
function storeUpload(dataDir, code, up) {
  const dir = ensurePatientDir(dataDir, code);
  let name = safeName(up.originalName);
  // Cleaning can eat a leading dot ("..pdf" becomes "pdf"). The stored name must still end in the extension
  // that matches the checked content, or the file is later served as an unknown download.
  if (EXT_TYPE[path.extname(name).toLowerCase()] !== up.check.type) name += `.${up.check.type}`;
  const filename = uniqueName(dir, name);
  fs.renameSync(up.tmpPath, path.join(dir, filename));
  return filename;
}

const UPLOAD_MESSAGES = {
  size: `حجم فایل بیش از ${Math.round(MAX_UPLOAD_BYTES / 1048576).toLocaleString('fa-IR')} مگابایت است.`,
  bad: 'درخواست بارگذاری معتبر نیست.',
  missing: 'فایلی انتخاب نشده است.',
};

router.post('/patients/:code/documents', async (req, res) => {
  const { db, dataDir } = req.app.locals;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  const up = await receiveUpload(req, res);
  const fail = (error, errors = {}) => {
    up.discard?.();
    renderDocuments(req, res, patient, { status: 422, error, values: req.body, errors });
  };
  if (up.problem) return fail(up.message ?? UPLOAD_MESSAGES[up.problem]);
  try {
    const { values, errors } = validateMeta(req.body);
    if (Object.keys(errors).length) return fail('لطفاً خطاهای مشخص‌شده را برطرف کنید.', errors);
    db.transaction(() => saveDocument(db, dataDir, patient, up, values, req.user.id))();
  } finally {
    up.discard();
  }
  res.redirect(303, req.body.back === 'profile' ? `/patients/${patient.code}#docs` : `/patients/${patient.code}/documents`);
});

// Profile photo: an ordinary JPG or PNG in the patient folder, also listed among the documents.
// Errors go back to the profile as a fixed key (?photo=...) so no user text is reflected.
const PHOTO_TYPES = new Set(['jpg', 'png']);

router.post('/patients/:code/photo', async (req, res) => {
  const { db, dataDir } = req.app.locals;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  const up = await receiveUpload(req, res);
  if (up.problem || !PHOTO_TYPES.has(up.check.type)) {
    up.discard?.();
    return res.redirect(303, `/patients/${patient.code}?photo=${up.problem === 'type' || !up.problem ? 'type' : up.problem}`);
  }
  try {
    const filename = storeUpload(dataDir, patient.code, up);
    db.transaction(() => {
      // DO UPDATE: a row may be left over from a file of the same name deleted by hand on the server.
      db.prepare(`INSERT INTO documents (patient_id, filename, category, title, uploaded_by) VALUES (?, ?, 'other', ?, ?)
                  ON CONFLICT (patient_id, filename) DO UPDATE SET category = 'other', title = excluded.title, doc_date = NULL,
                    notes = NULL, uploaded_by = excluded.uploaded_by, uploaded_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`)
        .run(patient.id, filename, 'عکس پروفایل', req.user.id);
      db.prepare("UPDATE patients SET photo = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_by = ? WHERE id = ?")
        .run(filename, req.user.id, patient.id);
      audit(db, { userId: req.user.id, action: 'photo_set', patientId: patient.id, detail: up.check.type });
    })();
  } finally {
    up.discard();
  }
  res.redirect(303, `/patients/${patient.code}`);
});

// Unlinks the photo from the profile. The file itself stays in the folder like every other document.
router.post('/patients/:code/photo/remove', (req, res) => {
  const db = req.app.locals.db;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  db.transaction(() => {
    db.prepare("UPDATE patients SET photo = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_by = ? WHERE id = ?")
      .run(req.user.id, patient.id);
    audit(db, { userId: req.user.id, action: 'photo_remove', patientId: patient.id });
  })();
  res.redirect(303, `/patients/${patient.code}`);
});

// Serves the photo for <img> on the profile. Not audited, like viewing the profile itself.
router.get('/patients/:code/photo', (req, res) => {
  const { db, dataDir } = req.app.locals;
  const patient = findPatient(db, req.params.code);
  const full = patient?.photo ? resolvePatientFile(dataDir, patient.code, patient.photo) : null;
  const type = full ? EXT_TYPE[path.extname(full).toLowerCase()] : null;
  if (!PHOTO_TYPES.has(type)) return res.status(404).end();
  res.set({
    'Content-Type': MIME[type],
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, no-store',
  });
  sendPatientFile(res, full);
});

// Adds or edits the metadata of a file that exists in the patient folder (for example one copied in by hand).
router.post('/patients/:code/documents/classify', (req, res) => {
  const { db, dataDir } = req.app.locals;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  const filename = String(req.body.filename ?? '');
  if (!resolvePatientFile(dataDir, patient.code, filename)) return notFound(res);
  const { values, errors } = validateMeta(req.body);
  if (Object.keys(errors).length) {
    return renderDocuments(req, res, patient, { status: 422, error: 'لطفاً خطاهای مشخص‌شده را برطرف کنید.', errors });
  }
  db.transaction(() => {
    db.prepare(`INSERT INTO documents (patient_id, filename, category, title, doc_date, notes, uploaded_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (patient_id, filename) DO UPDATE SET category = excluded.category, title = excluded.title,
                  doc_date = excluded.doc_date, notes = excluded.notes`)
      .run(patient.id, filename, values.category, values.title, values.doc_date, values.notes, req.user.id);
    audit(db, { userId: req.user.id, action: 'document_edit', patientId: patient.id });
  })();
  res.redirect(303, `/patients/${patient.code}/documents`);
});

// Staff and admin may delete a document (D21). The file is moved to data/trash/<code>/, never destroyed,
// so it can be recovered by hand on the server. File first: if the move fails nothing else changes.
router.post('/patients/:code/files/:name/delete', (req, res) => {
  const { db, dataDir } = req.app.locals;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  const full = resolvePatientFile(dataDir, patient.code, req.params.name);
  if (!full) return notFound(res);
  const name = path.basename(full);
  const trash = path.join(dataDir, 'trash', patient.code);
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(full, path.join(trash, trashName(new Date().toISOString().replace(/[:.]/g, '-'), name)));
  db.transaction(() => {
    db.prepare('DELETE FROM documents WHERE patient_id = ? AND filename = ?').run(patient.id, name);
    if (patient.photo === name) {
      db.prepare("UPDATE patients SET photo = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_by = ? WHERE id = ?")
        .run(req.user.id, patient.id);
    }
    audit(db, { userId: req.user.id, action: 'document_delete', patientId: patient.id, detail: EXT_TYPE[path.extname(name).toLowerCase()] ?? 'other' });
  })();
  res.redirect(303, req.body.back === 'documents' ? `/patients/${patient.code}/documents` : `/patients/${patient.code}`);
});

// Files are served only through this authenticated route, never as static files.
router.get('/patients/:code/files/:name', (req, res) => {
  const { db, dataDir } = req.app.locals;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  const full = resolvePatientFile(dataDir, patient.code, req.params.name);
  if (!full) return notFound(res);
  const name = path.basename(full);
  const type = EXT_TYPE[path.extname(name).toLowerCase()];
  const inline = req.query.inline === '1' && INLINE_TYPES.has(type);
  // A preview embedded in the profile gallery (an <img>) counts like viewing the profile, which is not
  // audited either; otherwise every profile view would add one row per image and bury real downloads.
  const embeddedPreview = inline && req.get('sec-fetch-dest') === 'image';
  if (!embeddedPreview) audit(db, { userId: req.user.id, action: 'document_download', patientId: patient.id, detail: type ?? 'other' });
  res.set({
    'Content-Type': MIME[type] ?? 'application/octet-stream',
    'Content-Disposition': disposition(inline ? 'inline' : 'attachment', name),
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, no-store',
  });
  sendPatientFile(res, full);
});

export default router;
