// Admin-only data pages: CSV import (preview, then confirm), CSV of all patients, and the full zip.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { Router } from 'express';
import { audit } from '../audit.js';
import { parseCodeCell, patientDirExists } from '../lib/files.js';
import { validatePatient, STATUSES } from '../lib/patient-form.js';
import { insertPatient } from '../lib/patient-store.js';
import { toXlsx, XLSX_TYPE } from '../lib/xlsx.js';
import { patientsCsv, patientTable, templateCsv, parsePatientCsv, CsvError, MAX_CSV_BYTES, MAX_CSV_ROWS, TEMPLATE_FIELDS, COLUMNS } from '../lib/csv.js';
import { streamFullExport } from '../lib/full-export.js';
import { toJalaliInput, localDay } from '../lib/jalali.js';
import { can } from '../lib/perms.js';
import { faKey } from '../lib/normalize.js';
import { shownCustomBoxes, customColumns } from '../lib/layouts.js';
import { liveCustomBoxes, checkCustomValue, writeCustomValues, addCustomCells } from '../lib/custom-boxes.js';

const router = Router();

const PREVIEW_ROWS = 200;
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGE_TTL_MS = 60 * 60 * 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_BYTES, files: 1, fields: 4, fieldSize: 1000, parts: 6 },
}).single('csv_file');

const tmpDir = (req) => path.join(req.app.locals.dataDir, 'tmp');
const stagePath = (req, token) => path.join(tmpDir(req), `import-${token}.json`);

// Parsed rows wait on disk between the preview and the confirm step. Old ones are removed.
function sweepStaged(req) {
  let names = [];
  try { names = fs.readdirSync(tmpDir(req)); } catch { return; }
  for (const n of names) {
    if (!/^import-[0-9a-f-]{36}\.json$/.test(n)) continue;
    const p = path.join(tmpDir(req), n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > STAGE_TTL_MS) fs.rmSync(p, { force: true }); } catch { /* already gone */ }
  }
}

// Custom box names map to their cell keys for the import: faKey(name) -> 'c<id>'.
// The raw custom cells of a line (c<id> keys), staged as typed; the confirm step checks them again.
const rawCells = (body) => Object.fromEntries(Object.entries(body).filter(([k]) => /^c\d+$/.test(k)));
const customKeys = (db) => new Map(liveCustomBoxes(db).map((b) => [faKey(b.label), `c${b.id}`]));

// The custom cells of one CSV line, checked against the boxes as they are now (labels only). Returns { custom, error }.
// Required is not checked (spec D53); hidden boxes are filled too.
function checkCells(boxes, cells, { confirm = false, labels = {} } = {}) {
  const custom = {};
  let error = null;
  for (const box of boxes) {
    const raw = cells[`c${box.id}`];
    if (raw === undefined) continue;
    const checked = checkCustomValue(box, raw, { byLabel: true });
    if (checked.error) {
      // At confirm, a choice that was removed or hidden since the preview is named as gone, not as a bad label.
      const text = confirm && box.type === 'choice' ? 'این کادر یا گزینه دیگر وجود ندارد.' : checked.error;
      error = error ?? `«${box.label}»: ${text}`;
      continue;
    }
    if (checked.value !== null) custom[box.id] = checked.value;
  }
  // A cell whose box was deleted since the preview fails its line too.
  const live = new Set(boxes.map((b) => `c${b.id}`));
  for (const key of Object.keys(cells)) {
    if (!live.has(key)) { error = error ?? `«${labels[key] ?? 'کادر سفارشی'}»: این کادر یا گزینه دیگر وجود ندارد.`; break; }
  }
  return { custom, error };
}

function renderData(req, res, extra = {}) {
  res.status(extra.status ?? 200).render('data/index', {
    active: 'data', error: null, preview: null, result: null, STATUSES,
    templateColumns: [...TEMPLATE_FIELDS.map((f) => COLUMNS.find(([k]) => k === f)[1]), ...shownCustomBoxes(req.app.locals.db).map((b) => b.label)],
    maxRows: MAX_CSV_ROWS, ...extra,
  });
}

router.get('/data', (req, res) => renderData(req, res));

router.get('/data/template.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="patients-template.csv"' });
  res.send(templateCsv(shownCustomBoxes(req.app.locals.db).map((b) => b.label)));
});

router.post('/data/import', async (req, res) => {
  // async + a promise around multer: anything unexpected reaches the error page instead of crashing the process.
  const err = await new Promise((resolve) => upload(req, res, resolve));
  const fail = (error) => renderData(req, res, { status: 422, error });
  if (err instanceof multer.MulterError) {
    return fail(err.code === 'LIMIT_FILE_SIZE' ? 'حجم فایل بیش از ۵ مگابایت است.' : 'درخواست بارگذاری معتبر نیست.');
  }
  if (err && err.errno === undefined) return fail('درخواست بارگذاری معتبر نیست.'); // malformed multipart
  if (err) throw err;
  if (!req.file) return fail('فایلی انتخاب نشده است.');
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  if (path.extname(name).toLowerCase() !== '.csv') return fail('فقط فایل CSV پذیرفته می‌شود.');

  const { db, dataDir } = req.app.locals;
  let records;
  try { records = parsePatientCsv(req.file.buffer, { custom: customKeys(db) }); } catch (e) {
    if (e instanceof CsvError) return fail(e.message);
    throw e;
  }
  if (!records.length) return fail('فایل ردیفی ندارد.');

  const existing = new Set(db.prepare('SELECT national_id FROM patients WHERE national_id IS NOT NULL').all().map((r) => r.national_id));
  const takenCode = db.prepare('SELECT 1 FROM patients WHERE code = ?');
  const seen = new Set();
  const seenCodes = new Set();
  const rows = [];
  const boxes = liveCustomBoxes(db);
  for (const { line, body } of records) {
    const { values, errors } = validatePatient(body);
    const { error: customError } = checkCells(boxes, rawCells(body));
    const code = parseCodeCell(body.code);
    const first = Object.values(errors)[0] ?? customError;
    let state = 'valid';
    let note = 'بدون خطا';
    if (first) { state = 'invalid'; note = first; } else if (code === undefined) {
      state = 'invalid'; note = 'کد بیمار را به شکل P-000123 بنویسید یا خالی بگذارید تا خودکار داده شود.';
    } else if (code && takenCode.get(code)) {
      state = 'duplicate'; note = 'کد بیمار در سامانه ثبت شده است؛ رد می‌شود';
    } else if (code && seenCodes.has(code)) {
      state = 'duplicate'; note = 'کد بیمار در همین فایل تکرار شده است؛ رد می‌شود';
    } else if (code && patientDirExists(dataDir, code)) {
      state = 'invalid'; note = 'پوشهٔ این کد بیمار روی سرور هست ولی بیماری با این کد ثبت نشده است؛ رد می‌شود';
    } else if (values.national_id && existing.has(values.national_id)) {
      state = 'duplicate'; note = 'کد ملی در سامانه ثبت شده است؛ رد می‌شود';
    } else if (values.national_id && seen.has(values.national_id)) {
      state = 'duplicate'; note = 'کد ملی در همین فایل تکرار شده است؛ رد می‌شود';
    }
    if (state === 'valid' && values.national_id) seen.add(values.national_id);
    if (state === 'valid' && code) seenCodes.add(code);
    rows.push({ line, state, note, values, code, cells: rawCells(body) });
  }
  const counts = { valid: 0, invalid: 0, duplicate: 0 };
  for (const r of rows) counts[r.state] += 1;

  sweepStaged(req);
  const token = crypto.randomUUID();
  fs.mkdirSync(tmpDir(req), { recursive: true });
  const labels = Object.fromEntries(boxes.map((b) => [`c${b.id}`, b.label]));
  fs.writeFileSync(stagePath(req, token), JSON.stringify({ userId: req.user.id, labels, rows: rows.filter((r) => r.state === 'valid').map(({ line, values, code, cells }) => ({ line, values, code, cells })) }), { mode: 0o600 });

  renderData(req, res, {
    preview: {
      token, fileName: name, size: req.file.size, total: rows.length, counts, shown: rows.slice(0, PREVIEW_ROWS),
      shownDate: (v) => toJalaliInput(v.birth_date),
    },
  });
});

router.post('/data/import/confirm', (req, res) => {
  const { db, dataDir } = req.app.locals;
  const token = String(req.body.token ?? '');
  if (!TOKEN_RE.test(token)) return renderData(req, res, { status: 422, error: 'درخواست نامعتبر است.' });
  const file = stagePath(req, token);
  let staged;
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > STAGE_TTL_MS) throw new Error('expired');
    staged = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fs.rmSync(file, { force: true });
    return renderData(req, res, { status: 422, error: 'این پیش‌نمایش منقضی شده است. فایل را دوباره بارگذاری کنید.' });
  }
  if (staged.userId !== req.user.id) return renderData(req, res, { status: 403, error: 'این پیش‌نمایش متعلق به کاربر دیگری است.' });
  fs.rmSync(file, { force: true });

  const codes = [];
  const failed = [];
  let skipped = 0;
  // The custom cells are checked again against the boxes as they are now: a box deleted or a choice removed since the
  // preview fails its line, which is then not written at all.
  const boxes = liveCustomBoxes(db);
  db.transaction(() => {
    const hasNid = db.prepare('SELECT 1 FROM patients WHERE national_id = ?');
    const hasCode = db.prepare('SELECT 1 FROM patients WHERE code = ?');
    // Rows with a code from the file go first, so an automatic code never takes a code the file asks for.
    const ordered = [...staged.rows.filter((r) => r.code), ...staged.rows.filter((r) => !r.code)];
    for (const { line, values, code, cells } of ordered) {
      const taken = code && (hasCode.get(code) || patientDirExists(dataDir, code));
      if (taken || (values.national_id && hasNid.get(values.national_id))) { skipped += 1; continue; } // added since the preview
      const { custom, error } = checkCells(boxes, cells ?? {}, { confirm: true, labels: staged.labels });
      if (error) { failed.push({ line, message: error }); continue; }
      const inserted = insertPatient(db, dataDir, values, req.user.id, { code, auditDetail: 'import' });
      codes.push(inserted);
      writeCustomValues(db, db.prepare('SELECT id FROM patients WHERE code = ?').get(inserted).id, custom ?? {});
    }
    audit(db, { userId: req.user.id, action: 'patient_import', detail: `inserted ${codes.length}, skipped ${skipped}, failed ${failed.length}` });
  })();
  renderData(req, res, { result: { inserted: codes.length, skipped, failed } });
});

router.post('/data/import/cancel', (req, res) => {
  const token = String(req.body.token ?? '');
  if (TOKEN_RE.test(token)) fs.rmSync(stagePath(req, token), { force: true });
  res.redirect(303, '/data');
});

// All patients (optionally one status) as CSV or as a right-to-left Excel sheet.
function exportPatients(format) {
  return async (req, res) => {
    const { db } = req.app.locals;
    const status = STATUSES.includes(req.body?.status) ? req.body.status : null;
    const rows = status
      ? db.prepare('SELECT * FROM patients WHERE status = ? ORDER BY id').all(status)
      : db.prepare('SELECT * FROM patients ORDER BY id').all();
    audit(db, { userId: req.user.id, action: 'export_patients', detail: `${rows.length} rows, ${format}${status ? `, ${status}` : ''}` });
    res.set({ 'Content-Disposition': `attachment; filename="patients.${format}"`, 'Cache-Control': 'private, no-store' });
    // Custom boxes come after the built-in columns; their cells are the readable text (ASCII digits, Jalali dates).
    const extra = customColumns(db);
    const withCustom = addCustomCells(db, rows);
    if (format === 'csv') return res.type('text/csv; charset=utf-8').send(patientsCsv(withCustom, extra));
    const t = patientTable(withCustom, extra);
    res.type(XLSX_TYPE).send(await toXlsx(t.headers, t.rows, 'بیماران'));
  };
}
router.post('/data/export/patients.csv', exportPatients('csv'));
router.post('/data/export/patients.xlsx', exportPatients('xlsx'));

router.post('/data/export/full.zip', async (req, res, next) => {
  const { db, dataDir } = req.app.locals;
  try {
    audit(db, { userId: req.user.id, action: 'export_full' });
    await streamFullExport(db, dataDir, res, localDay(), { finance: can(req.user, 'finance'), storage: can(req.user, 'storage') });
  } catch (err) {
    if (res.headersSent) res.destroy(err); else next(err);
  }
});

export default router;
