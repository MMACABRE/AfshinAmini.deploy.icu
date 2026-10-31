import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { audit } from '../audit.js';
import { notFound as notFoundPage } from '../lib/http.js';
import { normalizeText, faKey, likeEscape } from '../lib/normalize.js';
import { toJalaliInput, ageFrom } from '../lib/jalali.js';
import { isPatientCode, patientDir, resolvePatientFile, parseCodeCell } from '../lib/files.js';
import { documentsFor, receiveNewPatientFiles, saveDocument, CATEGORIES, NEW_FILES_MAX } from './documents.js';
import { visitsFor } from './visits.js';
import { validatePatient, STATUSES, SEXES } from '../lib/patient-form.js';
import { insertPatient, changePatientCode, codeTakenError, nextPatientCode, CODE_FORMAT_ERROR } from '../lib/patient-store.js';
import { patientHasPayments, releaseStock, PATIENT_PAYMENTS_BLOCK, patientBalance } from '../lib/bill.js';
import { can, has, EDIT } from '../lib/perms.js';
import { KIND_LABEL, STATUS_LABEL } from './sms.js';

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
  'first_name', 'last_name', 'father_name', 'national_id', 'birth_date', 'sex', 'phone', 'email', 'address', 'city',
  'emergency_name', 'emergency_phone', 'emergency_relation', 'insurance_name', 'insurance_number',
  'status', 'visit_reason', 'referral', 'blood_type', 'allergies', 'conditions', 'medical_notes', 'height_cm', 'weight_kg', 'blood_pressure',
];

function findPatient(db, code) {
  return isPatientCode(code) ? db.prepare('SELECT * FROM patients WHERE code = ?').get(code) : undefined;
}

const notFound = (res) => notFoundPage(res, 'پرونده‌ی مورد نظر پیدا نشد.');

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
  const { db, dataDir } = req.app.locals;
  res.status(Object.keys(errors).length ? 422 : 200).render('patients/form', {
    active: 'patients', patient, values, errors, suggestions: suggestions(db),
    // The new-patient form shows which code an empty code box will get (only to users who may pick one).
    nextCode: !patient && has(req.user, 'patient_code') ? nextPatientCode(db, dataDir) : null,
    newFilesMax: NEW_FILES_MAX,
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
    const digits = `%${likeEscape(f.text.replace(/[\s-]/g, ''))}%`; // phone and national ID are stored without spaces or dashes
    where.push("(fa_key(first_name || ' ' || last_name) LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR national_id LIKE ? ESCAPE '\\')");
    params.push(name, raw, digits, digits);
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
  renderForm(req, res, null, { status: 'active', doc_category: 'other' });
});

router.post('/patients', async (req, res) => {
  const { db, dataDir } = req.app.locals;
  // The form is multipart (D49): this also parses the patient fields into req.body.
  const up = await receiveNewPatientFiles(req, res);
  try {
    return createPatient(req, res, up);
  } finally {
    up.discard();
  }
});

function createPatient(req, res, up) {
  const { db, dataDir } = req.app.locals;
  const { values, errors } = validatePatient(req.body);
  if (up.error) errors.files = up.error;
  // First documents (D49): only for users who may upload; otherwise the box is not shown and files are dropped.
  const files = can(req.user, 'documents', EDIT) ? up.files : [];
  const category = CATEGORIES.includes(req.body.doc_category) ? req.body.doc_category : 'other';
  // An optional code typed on the form (D36 flag). Without the flag the box is not shown and a posted value is
  // ignored, so the next code is given out as before.
  const chosen = has(req.user, 'patient_code') ? parseCodeCell(String(req.body.code ?? '').slice(0, 20)) : null;
  if (chosen === undefined) errors.code = CODE_FORMAT_ERROR;
  else if (chosen) {
    const taken = codeTakenError(db, dataDir, chosen);
    if (taken) errors.code = taken;
  }
  if (Object.keys(errors).length) {
    // A browser cannot refill a file box, so say the chosen files were not kept.
    if (files.length && !errors.files) errors.files = 'پرونده ذخیره نشد؛ فایل‌ها را دوباره انتخاب کنید.';
    return renderForm(req, res, null, req.body, errors);
  }
  const code = db.transaction(() => {
    const c = insertPatient(db, dataDir, values, req.user.id, { code: chosen });
    const patient = { id: db.prepare('SELECT id FROM patients WHERE code = ?').get(c).id, code: c };
    const meta = { category, title: null, doc_date: null, notes: null };
    files.forEach((f) => saveDocument(db, dataDir, patient, f, meta, req.user.id));
    return c;
  })();
  res.redirect(303, `/patients/${code}${files.length ? '#docs' : ''}`);
}

router.get('/patients/:code', (req, res) => {
  const db = req.app.locals.db;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  res.render('patients/show', { active: 'patients', ...showData(req, patient), medError: null, codeChanged: req.query.code === 'changed' });
});

// Fixed messages for ?photo=<key> after a failed photo upload (see routes/documents.js).
const PHOTO_ERRORS = {
  type: 'عکس باید فایل JPG یا PNG باشد.',
  size: 'حجم عکس بیش از ۳۰ مگابایت است.',
  missing: 'فایلی انتخاب نشده است.',
  bad: 'درخواست بارگذاری معتبر نیست.',
};

// The patient's newest message, for the line under the contact details.
function lastSmsOf(db, patientId) {
  const m = db.prepare('SELECT kind, status FROM sms_messages WHERE patient_id = ? ORDER BY id DESC LIMIT 1').get(patientId);
  return m ? { kindText: KIND_LABEL[m.kind], statusText: STATUS_LABEL[m.status][0], chip: STATUS_LABEL[m.status][1] } : null;
}

function showData(req, patient) {
  const { db, dataDir } = req.app.locals;
  return {
    patient,
    hasPhoto: !!(patient.photo && resolvePatientFile(dataDir, patient.code, patient.photo)),
    photoError: Object.hasOwn(PHOTO_ERRORS, req.query.photo) ? PHOTO_ERRORS[req.query.photo] : null,
    files: documentsFor(db, dataDir, patient),
    age: ageFrom(patient.birth_date),
    visits: visitsFor(db, patient.id),
    lastSms: can(req.user, 'sms') ? lastSmsOf(db, patient.id) : null,
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

// Changing the code by hand (D36): the new code typed twice, so one slip cannot move a patient's folder.
router.post('/patients/:code/code', (req, res) => {
  const { db, dataDir } = req.app.locals;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  const typed = String(req.body.new_code ?? '').slice(0, 20);
  const again = String(req.body.new_code2 ?? '').slice(0, 20);
  const fail = (text) => res.status(422).render('patients/form', {
    active: 'patients', patient, values: formValuesFrom(patient), errors: {}, suggestions: suggestions(db), codeError: text, codeValues: { typed, again },
  });
  if (parseCodeCell(typed) !== parseCodeCell(again)) return fail('دو کدی که وارد کردید یکی نیستند.');
  const result = changePatientCode(db, dataDir, patient, typed, req.user.id);
  if (result.error) return fail(result.error);
  res.redirect(303, `/patients/${result.code}?code=changed`);
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
