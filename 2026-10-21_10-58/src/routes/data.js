// Admin-only data pages: CSV import (preview, then confirm), CSV of all patients, and the full zip.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { Router } from 'express';
import { audit } from '../audit.js';
import { ensurePatientDir } from '../lib/files.js';
import { validatePatient, STATUSES } from '../lib/patient-form.js';
import { insertPatient } from '../lib/patient-store.js';
import { toXlsx, XLSX_TYPE } from '../lib/xlsx.js';
import { patientsCsv, patientTable, templateCsv, parsePatientCsv, CsvError, MAX_CSV_BYTES, MAX_CSV_ROWS, TEMPLATE_FIELDS, COLUMNS } from '../lib/csv.js';
import { streamFullExport } from '../lib/full-export.js';
import { toJalaliInput, localDay } from '../lib/jalali.js';
import { can } from '../lib/perms.js';

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

function renderData(req, res, extra = {}) {
  res.status(extra.status ?? 200).render('data/index', {
    active: 'data', error: null, preview: null, result: null, STATUSES,
    templateColumns: TEMPLATE_FIELDS.map((f) => COLUMNS.find(([k]) => k === f)[1]),
    maxRows: MAX_CSV_ROWS, ...extra,
  });
}

router.get('/data', (req, res) => renderData(req, res));

router.get('/data/template.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="patients-template.csv"' });
  res.send(templateCsv());
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

  let records;
  try { records = parsePatientCsv(req.file.buffer); } catch (e) {
    if (e instanceof CsvError) return fail(e.message);
    throw e;
  }
  if (!records.length) return fail('فایل ردیفی ندارد.');

  const { db } = req.app.locals;
  const existing = new Set(db.prepare('SELECT national_id FROM patients WHERE national_id IS NOT NULL').all().map((r) => r.national_id));
  const seen = new Set();
  const rows = [];
  for (const { line, body } of records) {
    const { values, errors } = validatePatient(body);
    const first = Object.values(errors)[0];
    let state = 'valid';
    let note = 'بدون خطا';
    if (first) { state = 'invalid'; note = first; } else if (values.national_id && existing.has(values.national_id)) {
      state = 'duplicate'; note = 'کد ملی در سامانه ثبت شده است؛ رد می‌شود';
    } else if (values.national_id && seen.has(values.national_id)) {
      state = 'duplicate'; note = 'کد ملی در همین فایل تکرار شده است؛ رد می‌شود';
    }
    if (state === 'valid' && values.national_id) seen.add(values.national_id);
    rows.push({ line, state, note, values });
  }
  const counts = { valid: 0, invalid: 0, duplicate: 0 };
  for (const r of rows) counts[r.state] += 1;

  sweepStaged(req);
  const token = crypto.randomUUID();
  fs.mkdirSync(tmpDir(req), { recursive: true });
  fs.writeFileSync(stagePath(req, token), JSON.stringify({ userId: req.user.id, rows: rows.filter((r) => r.state === 'valid').map((r) => r.values) }), { mode: 0o600 });

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
  let skipped = 0;
  db.transaction(() => {
    const hasNid = db.prepare('SELECT 1 FROM patients WHERE national_id = ?');
    for (const values of staged.rows) {
      if (values.national_id && hasNid.get(values.national_id)) { skipped += 1; continue; } // added since the preview
      const code = insertPatient(db, values, req.user.id, 'import');
      ensurePatientDir(dataDir, code); // inside the transaction, like the patient form
      codes.push(code);
    }
    audit(db, { userId: req.user.id, action: 'patient_import', detail: `inserted ${codes.length}, skipped ${skipped}` });
  })();
  renderData(req, res, { result: { inserted: codes.length, skipped } });
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
    if (format === 'csv') return res.type('text/csv; charset=utf-8').send(patientsCsv(rows));
    const t = patientTable(rows);
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
