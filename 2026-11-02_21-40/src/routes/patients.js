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
import { layoutRoutes } from '../lib/layout-routes.js';
import { readLayout, shownBoxIds, requiredBoxIds, customFormValues, checkLayout, layoutFromFields, saveLayout, undoLayout, resetLayout, withSpan, previewLocals } from '../lib/layouts.js';
import { BOXES, CARDS, CUSTOM_TYPES } from '../lib/layout-catalogue.js';
import { takenNameKeys } from '../lib/custom-boxes.js';
import { LIMITS } from '../lib/layout-catalogue.js';
import { customValues, liveCustomBoxes, checkCustomValue, writeCustomValues, customDisplay, createCustomBox, deleteCustomBox, addChoices, setChoiceHidden, removeChoice } from '../lib/custom-boxes.js';

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

// Values for the edit form: the stored row with the birth date shown in Jalali, and the custom box values.
function formValuesFrom(row) {
  return { ...row, birth_date: toJalaliInput(row.birth_date) };
}
const editValues = (db, patient) => ({ ...formValuesFrom(patient), ...customFormValues(db, patient.id) });

// What the form needs from the patient form layout (D52): the layout, the live custom boxes by id, and whether the
// edit form's extra card «سایر کادرها» is open (GET ?all=1, or show_all after a failed save). Edit forms only.
function formContext(req, patient) {
  const { db } = req.app.locals;
  return {
    layout: readLayout(db, 'patient_form'),
    customBoxes: Object.fromEntries(liveCustomBoxes(db).map((b) => [b.id, withSpan(b)])),
    showAll: Boolean(patient) && (req.method === 'GET' ? req.query.all === '1' : req.body.show_all === '1'),
    builtin: { cards: CARDS, boxes: BOXES },
  };
}

// Checks what the layout asks for and reads the custom boxes (D52, D53). Changes `values` and `errors` in place:
// on edit a hidden built-in field is dropped from `values`, so it never overwrites a stored value. Returns the
// custom values to write, by box id (null clears the value).
function checkLayoutBoxes({ db, layout, shown: postedShown, body, values, errors, stored, editing }) {
  const required = requiredBoxIds(layout);
  // A new patient must give every box the server's layout requires, whatever the posted list says. An edit only
  // checks the required boxes that the form showed (a hidden box keeps its stored value).
  const shown = editing ? postedShown : new Set([...postedShown, ...required]);
  for (const b of BOXES) {
    if (shown.has(b.id)) continue;
    delete errors[b.id];
    if (editing) delete values[b.id];
  }
  for (const b of BOXES) {
    if (!shown.has(b.id) || !required.has(b.id) || b.id === 'sms_optout' || errors[b.id]) continue;
    const v = values[b.id];
    if (v === null || v === undefined || v === '') errors[b.id] = `${b.label} را وارد کنید.`;
  }
  const writes = {};
  for (const box of liveCustomBoxes(db)) {
    if (!shown.has(`c:${box.id}`)) continue;
    const key = `c_${box.id}`;
    const r = checkCustomValue(box, body[key], { keep: stored?.[box.id] });
    if (r.error) errors[key] = r.error;
    else if (r.value === null && required.has(`c:${box.id}`)) errors[key] = `${box.label} را وارد کنید.`;
    else writes[box.id] = r.value;
  }
  return writes;
}

// Custom box values for the profile's «سایر اطلاعات» section: live and deleted boxes that hold a value, by id.
function customInfoFor(db, patientId) {
  return db.prepare(`SELECT cb.id, cb.type, cb.label, cb.choices, pv.value FROM patient_values pv
    JOIN custom_boxes cb ON cb.id = pv.box_id WHERE pv.patient_id = ? ORDER BY cb.id`).all(patientId)
    .map((r) => ({
      label: r.label,
      text: customDisplay({ type: r.type, choices: r.choices ? JSON.parse(r.choices) : null }, r.value),
    }));
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
    ...formContext(req, patient),
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
  const writes = checkLayoutBoxes({
    db, layout: readLayout(db, 'patient_form'), shown: shownBoxIds(db, req.body.boxes), body: req.body, values, errors, editing: false,
  });
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
    writeCustomValues(db, patient.id, writes);
    const meta = { category, title: null, doc_date: null, notes: null };
    files.forEach((f) => saveDocument(db, dataDir, patient, f, meta, req.user.id));
    return c;
  })();
  res.redirect(303, `/patients/${code}${files.length ? '#docs' : ''}`);
}

// ---- Patient form layout editor (D52, D53). Registered before /patients/:code, so "layout" is never a code. ----

// The editor page. `error` (layout) and `boxError` / `choiceError` (custom boxes) come back with status 422.
// A refused JSON layout is echoed back as the draft (never stored, never trusted): an object, at most 64 KB.
function draftOf(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > LIMITS.json) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? text : null;
  } catch {
    return null;
  }
}

function renderLayout(req, res, { status = 200, error = null, boxError = null, boxValues = {}, choiceError = null, draft = null } = {}) {
  const { db } = req.app.locals;
  const row = db.prepare("SELECT previous FROM layouts WHERE name = 'patient_form'").get();
  const usedChoices = {};
  for (const r of db.prepare('SELECT DISTINCT box_id, value FROM patient_values').all()) {
    (usedChoices[r.box_id] ??= new Set()).add(r.value);
  }
  res.status(status).render('patients/layout', {
    active: 'patients',
    layout: readLayout(db, 'patient_form'),
    catalogue: { cards: CARDS, boxes: BOXES, types: CUSTOM_TYPES },
    customBoxes: liveCustomBoxes(db),
    usedBoxes: new Set(db.prepare('SELECT DISTINCT box_id FROM patient_values').pluck().all()),
    usedChoices,
    hasPrevious: Boolean(row && row.previous !== null),
    previewLocals, // the drag editor renders each box's real input through form-box.ejs, disabled
    flash: req.query,
    error, boxError, boxValues, choiceError,
    draft, // the refused draft, echoed to the editor (root data-draft)
    taken: [...takenNameKeys(db)],
    limits: { boxName: LIMITS.boxName, cardLabel: LIMITS.cardLabel, choicesMin: LIMITS.choicesMin, choicesMax: LIMITS.choicesMax, choiceLabel: LIMITS.boxName },
  });
}

// The box id in the URL, when it is digits only and names a live custom box; otherwise null.
function liveBoxFromParam(db, raw) {
  if (!/^\d+$/.test(raw)) return null;
  return liveCustomBoxes(db).find((b) => b.id === Number(raw)) ?? null;
}

router.get('/patients/layout', (req, res) => renderLayout(req, res));

// The page's fields become a layout (checked like the JS editor's JSON), or a posted JSON `layout` is used as is.
layoutRoutes(router, 'patient_form', {
  path: '/patients/layout',
  back: (query) => `/patients/layout?${query}`,
  fail: (req, res, error) => renderLayout(req, res, { status: 422, error, draft: draftOf(req.body.layout) }),
});

router.post('/patients/layout/boxes', (req, res) => {
  const made = createCustomBox(req.app.locals.db, { type: req.body.type, label: req.body.label, choices: req.body.choices }, req.user.id);
  if (made.error) return renderLayout(req, res, { status: 422, boxError: made.error, boxValues: req.body });
  res.redirect(303, `/patients/layout?created=${made.box.id}`);
});

router.get('/patients/layout/boxes/:id/delete', (req, res) => {
  const { db } = req.app.locals;
  const box = liveBoxFromParam(db, req.params.id);
  if (!box) return notFound(res);
  res.render('patients/layout-delete', { active: 'patients', box });
});

router.post('/patients/layout/boxes/:id/delete', (req, res) => {
  const { db } = req.app.locals;
  const box = liveBoxFromParam(db, req.params.id);
  if (!box) return notFound(res);
  const result = deleteCustomBox(db, box.id, req.user.id);
  if (result.error) return res.status(409).render('error', { status: 409, message: result.error });
  res.redirect(303, '/patients/layout?deleted=1');
});

router.post('/patients/layout/boxes/:id/choices', (req, res) => {
  const { db } = req.app.locals;
  const box = liveBoxFromParam(db, req.params.id);
  if (!box) return notFound(res);
  const uid = req.user.id;
  const action = req.body.action;
  let result;
  if (action === 'add') result = addChoices(db, box.id, req.body.text, uid);
  else if (action === 'hide' || action === 'show') result = setChoiceHidden(db, box.id, req.body.choice, action === 'hide', uid);
  else if (action === 'remove') result = removeChoice(db, box.id, req.body.choice, uid);
  else return renderLayout(req, res, { status: 422, choiceError: { id: box.id, text: 'این کار را نمی‌شناسیم.' } });
  if (result.error) return renderLayout(req, res, { status: 422, choiceError: { id: box.id, text: result.error } });
  res.redirect(303, `/patients/layout#box-${box.id}`);
});

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
    customInfo: customInfoFor(db, patient.id),
  };
}

router.get('/patients/:code/edit', (req, res) => {
  const { db } = req.app.locals;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  renderForm(req, res, patient, editValues(db, patient));
});

router.post('/patients/:code', (req, res) => {
  const db = req.app.locals.db;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res);
  const { values, errors } = validatePatient(req.body);
  const writes = checkLayoutBoxes({
    db, layout: readLayout(db, 'patient_form'), shown: shownBoxIds(db, req.body.boxes), body: req.body, values, errors,
    stored: customValues(db, patient.id), editing: true,
  });
  if (Object.keys(errors).length) {
    return renderForm(req, res, patient, req.body, errors);
  }
  const changed = FORM_FIELDS.filter((k) => k in values && (values[k] ?? null) !== (patient[k] ?? null));
  const before = customValues(db, patient.id);
  for (const [id, value] of Object.entries(writes)) {
    if ((before[id] ?? null) !== (value ?? null)) changed.push(`c:${id}`);
  }
  const cols = Object.keys(values);
  db.transaction(() => {
    db.prepare(`UPDATE patients SET ${cols.map((k) => `${k} = ?`).join(', ')},
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_by = ? WHERE id = ?`)
      .run(...cols.map((k) => values[k]), req.user.id, patient.id);
    writeCustomValues(db, patient.id, writes);
    audit(db, { userId: req.user.id, action: 'patient_edit', patientId: patient.id, detail: changed.join(',') });
    // Archiving through the edit form is recorded the same way as the archive button.
    if ('status' in values && (values.status === 'archived') !== (patient.status === 'archived')) {
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
    active: 'patients', patient, values: editValues(db, patient), errors: {}, suggestions: suggestions(db), codeError: text, codeValues: { typed, again },
    ...formContext(req, patient),
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
