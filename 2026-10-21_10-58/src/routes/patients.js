import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { audit } from '../audit.js';
import { normalizeText, faKey, likeEscape } from '../lib/normalize.js';
import { toJalaliInput, ageFrom } from '../lib/jalali.js';
import { isPatientCode, ensurePatientDir, patientDir, resolvePatientFile } from '../lib/files.js';
import { documentsFor } from './documents.js';
import { visitsFor } from './visits.js';
import { validatePatient, STATUSES, SEXES } from '../lib/patient-form.js';
import { insertPatient } from '../lib/patient-store.js';
import { patientHasPayments, releaseStock, PATIENT_PAYMENTS_BLOCK, patientBalance } from '../lib/bill.js';
import { can } from '../lib/perms.js';

const router = Router();
const PAGE_SIZE = 25;

const SORTS = {
  updated: 'updated_at DESC, id DESC',
  name: 'last_name COLLATE NOCASE, first_name COLLATE NOCASE, id',
  birth_desc: 'birth_date IS NULL, birth_date DESC, id',
  birth_asc: 'birth_date IS NULL, birth_date, id',
  code: 'code',
};

const FORM_FIELDS = [
  'first_name', 'last_name', 'national_id', 'birth_date', 'sex', 'phone', 'email', 'address', 'city',
  'emergency_name', 'emergency_phone', 'emergency_relation', 'insurance_name', 'insurance_number',
  'status', 'visit_reason', 'referral', 'blood_type', 'allergies', 'conditions', 'medical_notes', 'height_cm', 'weight_kg', 'blood_pressure',
];

function findPatient(db, code) {
  return isPatientCode(code) ? db.prepare('SELECT * FROM patients WHERE code = ?').get(code) : undefined;
}

function notFound(res) {
  return res.status(404).render('error', { status: 404, message: 'پرونده‌ی مورد نظر پیدا نشد.' });
}

// Values for the edit form: the stored row with the birth date shown in Jalali.
function formValuesFrom(row) {
  return { ...row, birth_date: toJalaliInput(row.birth_date) };
}

// Earlier values of a free-text field, most used first, offered as a dropdown on the form.
// `column` is always one of the fixed names below, never user input.
const SUGGEST_COLUMNS = ['visit_reason', 'referral'];
function suggestions(db) {
  return Object.fromEntries(SUGGEST_COLUMNS.map((column) => [column, db.prepare(
    `SELECT ${column} AS v FROM patients WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY COUNT(*) DESC, ${column} LIMIT 200`,
  ).pluck().all()]));
}

function renderForm(req, res, patient, values, errors = {}) {
  res.status(Object.keys(errors).length ? 422 : 200).render('patients/form', {
    active: 'patients', patient, values, errors, suggestions: suggestions(req.app.locals.db),
  });
}

function listQuery(q) {
  // The form sends the current status as a hidden field; a clicked status chip adds a second value, which wins.
  const wanted = Array.isArray(q.status) ? q.status.at(-1) : q.status;
  const status = STATUSES.includes(wanted) ? wanted : '';
  const sex = SEXES.includes(q.sex) ? q.sex : '';
  const sort = Object.hasOwn(SORTS, q.sort) ? q.sort : 'updated';
  const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const text = normalizeText(String(q.q ?? '').slice(0, 100));
  return { status, sex, sort, page, text };
}

router.get('/patients', (req, res) => {
  const db = req.app.locals.db;
  const f = listQuery(req.query);
  const where = [];
  const params = [];
  if (f.text) {
    const name = `%${likeEscape(faKey(f.text))}%`;
    const raw = `%${likeEscape(f.text)}%`;
    where.push("(fa_key(first_name || ' ' || last_name) LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR national_id LIKE ? ESCAPE '\\')");
    params.push(name, raw, raw, raw);
  }
  if (f.status) { where.push('status = ?'); params.push(f.status); } else { where.push("status <> 'archived'"); }
  if (f.sex) { where.push('sex = ?'); params.push(f.sex); }
  const clause = `WHERE ${where.join(' AND ')}`;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM patients ${clause}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const rows = db.prepare(`SELECT id, code, first_name, last_name, birth_date, sex, status, updated_at
                           FROM patients ${clause} ORDER BY ${SORTS[f.sort]} LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .map((r) => ({ ...r, age: ageFrom(r.birth_date) }));
  res.render('patients/list', { active: 'patients', rows, total, page, pages, pageSize: PAGE_SIZE, filters: { ...f, page } });
});

router.get('/patients/new', (req, res) => {
  renderForm(req, res, null, { status: 'active' });
});

router.post('/patients', (req, res) => {
  const db = req.app.locals.db;
  const { values, errors } = validatePatient(req.body);
  if (Object.keys(errors).length) {
    return renderForm(req, res, null, req.body, errors);
  }
  // The folder is made inside the transaction: if it cannot be created, no patient row is left behind.
  const code = db.transaction(() => {
    const c = insertPatient(db, values, req.user.id);
    ensurePatientDir(req.app.locals.dataDir, c);
    return c;
  })();
  res.redirect(303, `/patients/${code}`);
});

router.get('/patients/:code', (req, res) => {
  const db = req.app.locals.db;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  res.render('patients/show', { active: 'patients', ...showData(req, patient), medError: null });
});

// Fixed messages for ?photo=<key> after a failed photo upload (see routes/documents.js).
const PHOTO_ERRORS = {
  type: 'عکس باید فایل JPG یا PNG باشد.',
  size: 'حجم عکس بیش از ۳۰ مگابایت است.',
  missing: 'فایلی انتخاب نشده است.',
  bad: 'درخواست بارگذاری معتبر نیست.',
};

function showData(req, patient) {
  const { db, dataDir } = req.app.locals;
  return {
    patient,
    hasPhoto: !!(patient.photo && resolvePatientFile(dataDir, patient.code, patient.photo)),
    photoError: Object.hasOwn(PHOTO_ERRORS, req.query.photo) ? PHOTO_ERRORS[req.query.photo] : null,
    files: documentsFor(db, dataDir, patient),
    age: ageFrom(patient.birth_date),
    visits: visitsFor(db, patient.id),
    medications: db.prepare('SELECT * FROM medications WHERE patient_id = ? ORDER BY id').all(patient.id),
    balance: can(req.user, 'finance') ? patientBalance(db, patient.id) : null, // D30 strip, finance view only
  };
}

router.get('/patients/:code/edit', (req, res) => {
  const patient = findPatient(req.app.locals.db, req.params.code);
  if (!patient) return notFound(res);
  renderForm(req, res, patient, formValuesFrom(patient));
});

router.post('/patients/:code', (req, res) => {
  const db = req.app.locals.db;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  const { values, errors } = validatePatient(req.body);
  if (Object.keys(errors).length) {
    return renderForm(req, res, patient, req.body, errors);
  }
  const changed = FORM_FIELDS.filter((k) => (values[k] ?? null) !== (patient[k] ?? null));
  const cols = Object.keys(values);
  db.transaction(() => {
    db.prepare(`UPDATE patients SET ${cols.map((k) => `${k} = ?`).join(', ')},
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_by = ? WHERE id = ?`)
      .run(...cols.map((k) => values[k]), req.user.id, patient.id);
    audit(db, { userId: req.user.id, action: 'patient_edit', patientId: patient.id, detail: changed.join(',') });
    // Archiving through the edit form is recorded the same way as the archive button.
    if ((values.status === 'archived') !== (patient.status === 'archived')) {
      audit(db, { userId: req.user.id, action: values.status === 'archived' ? 'patient_archive' : 'patient_unarchive', patientId: patient.id });
    }
  })();
  res.redirect(303, `/patients/${patient.code}`);
});

function setStatus(status, action) {
  return (req, res) => {
    const db = req.app.locals.db;
    const patient = findPatient(db, req.params.code);
    if (!patient) return notFound(res);
    db.transaction(() => {
      db.prepare(`UPDATE patients SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_by = ? WHERE id = ?`)
        .run(status, req.user.id, patient.id);
      audit(db, { userId: req.user.id, action, patientId: patient.id });
    })();
    res.redirect(303, `/patients/${patient.code}`);
  };
}
router.post('/patients/:code/archive', setStatus('archived', 'patient_archive'));
router.post('/patients/:code/unarchive', setStatus('active', 'patient_unarchive'));

router.get('/patients/:code/delete', (req, res) => {
  const patient = findPatient(req.app.locals.db, req.params.code);
  if (!patient) return notFound(res);
  res.render('patients/delete', { active: 'patients', patient });
});

// The row is removed; the folder is moved to data/trash/ so files are never destroyed by the app.
router.post('/patients/:code/delete', (req, res) => {
  const { db, dataDir } = req.app.locals;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  if (patientHasPayments(db, patient.id)) return res.status(409).render('error', { status: 409, message: PATIENT_PAYMENTS_BLOCK });
  // Row first: if the move to trash then fails, the folder stays in data/patients/ (ids, and so codes,
  // are never reused) and no record is left pointing at files that disappeared.
  db.transaction(() => {
    releaseStock(db, { visitIds: db.prepare('SELECT id FROM visits WHERE patient_id = ?').pluck().all(patient.id), userId: req.user.id });
    db.prepare('DELETE FROM patients WHERE id = ?').run(patient.id);
    audit(db, { userId: req.user.id, action: 'patient_delete', patientId: patient.id, detail: patient.code });
  })();
  const dir = patientDir(dataDir, patient.code);
  try {
    if (fs.existsSync(dir)) {
      const trash = path.join(dataDir, 'trash');
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(dir, path.join(trash, `${patient.code}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
    }
  } catch (err) {
    console.error(`patient ${patient.code} deleted, but its folder could not be moved to trash: ${err.code ?? err.message}`);
  }
  res.redirect(303, '/patients');
});

router.post('/patients/:code/medications', (req, res) => {
  const db = req.app.locals.db;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  const name = normalizeText(req.body.name).slice(0, 100);
  if (!name) {
    return res.status(422).render('patients/show', { active: 'patients', ...showData(req, patient), medError: 'نام دارو را وارد کنید.' });
  }
  db.transaction(() => {
    db.prepare('INSERT INTO medications (patient_id, name, dosage, frequency) VALUES (?, ?, ?, ?)')
      .run(patient.id, name, normalizeText(req.body.dosage).slice(0, 60) || null, normalizeText(req.body.frequency).slice(0, 60) || null);
    audit(db, { userId: req.user.id, action: 'medication_add', patientId: patient.id });
  })();
  res.redirect(303, `/patients/${patient.code}`);
});

router.post('/patients/:code/medications/:id/delete', (req, res) => {
  const db = req.app.locals.db;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  db.transaction(() => {
    const r = db.prepare('DELETE FROM medications WHERE id = ? AND patient_id = ?').run(Number(req.params.id) || 0, patient.id);
    if (r.changes) audit(db, { userId: req.user.id, action: 'medication_remove', patientId: patient.id });
  })();
  res.redirect(303, `/patients/${patient.code}`);
});

export default router;
