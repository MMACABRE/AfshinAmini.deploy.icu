// SMS screens (D32+): message log, settings, bulk send and a single message to one patient.
// Access is decided in src/lib/route-perms.js. Reminders themselves are made and sent by src/lib/sms-engine.js.
import { Router } from 'express';
import { audit } from '../audit.js';
import { has } from '../lib/perms.js';
import { toAsciiDigits } from '../lib/normalize.js';
import { localDay } from '../lib/jalali.js';
import { isPatientCode } from '../lib/files.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { saveKey, removeKey, keyInfo, API_KEY_PATTERN } from '../lib/sms-credentials.js';
import { LEADS, LEAD_KEYS, renderTemplate, visitDateText, visitTimeText, smsParts, normalizeMobile, DEFAULT_TEMPLATE, validateTemplate } from '../lib/sms-rules.js';
import { validateSmsSettings, plannedReminderCount } from '../lib/sms-settings.js';
import { BULK_MAX, validateBody, fillName, whyNot, recipientsFor, partsTotal, queueMessage } from '../lib/sms-bulk.js';
import { idOf, notFound } from '../lib/http.js';

const router = Router();
const PAGE_SIZE = 50;

export const KIND_LABEL = { reminder: 'یادآوری', custom: 'پیام تکی', bulk: 'پیام گروهی', alert: 'هشدار اعتبار', test: 'آزمایشی' };
export const STATUS_LABEL = {
  pending: ['در انتظار', 'chip-info'], sending: ['در حال ارسال', 'chip-info'], sent: ['ارسال شد', 'chip-ok'],
  failed: ['ناموفق', 'chip-crit'], skipped: ['ارسال نشد', 'chip-mute'], cancelled: ['لغو شد', 'chip-mute'],
};
const WHY_LABEL = { optout: 'بیمار پیامک نمی‌خواهد', archived: 'پرونده بایگانی‌شده است', phone: 'شماره‌ی موبایل معتبر نیست' };
const TEST_NOTICE = { sent: 'پیامک آزمایشی ارسال شد.', failed: 'پیامک آزمایشی ارسال نشد؛ دلیل در گزارش ارسال هست.', 'no-key': 'کلید پیامک ثبت نشده است.', requeued: 'اتصال به سامانه‌ی پیامک برقرار نشد؛ پیامک آزمایشی در صف ماند و چند دقیقه بعد دوباره فرستاده می‌شود.' };


// Switched on, with a key that can be read: messages can go out.
function readiness(db, dataDir) {
  const s = getSettings(db);
  const info = keyInfo(db, dataDir);
  return { s, info, on: s.sms_enabled === '1', hasKey: Boolean(info?.usable) };
}
const notReadyText = (r) => (!r.on ? 'پیامک غیرفعال است. آن را از «تنظیمات» روشن کنید.' : !r.hasKey ? 'کلید پیامک ثبت نشده است.' : null);

// Users who manage users see every saved search, like the search page.
function savedFor(db, user) {
  const sql = 'SELECT id, user_id, name, query_json FROM saved_searches';
  return has(user, 'manage_users') ? db.prepare(`${sql} ORDER BY id DESC`).all() : db.prepare(`${sql} WHERE user_id = ? ORDER BY id DESC`).all(user.id);
}
const findSaved = (db, user, id) => savedFor(db, user).find((r) => r.id === idOf(id));

// ---- log ----

router.get('/sms', (req, res) => {
  const { db, dataDir } = req.app.locals;
  const status = Object.hasOwn(STATUS_LABEL, req.query.status) ? req.query.status : '';
  const kind = Object.hasOwn(KIND_LABEL, req.query.kind) ? req.query.kind : '';
  const where = [];
  const params = [];
  if (status) { where.push('m.status = ?'); params.push(status); }
  if (kind) { where.push('m.kind = ?'); params.push(kind); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM sms_messages m ${clause}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number.parseInt(req.query.page, 10) || 1), pages);
  const rows = db.prepare(`SELECT m.*, p.code, p.first_name, p.last_name FROM sms_messages m LEFT JOIN patients p ON p.id = m.patient_id
                           ${clause} ORDER BY m.id DESC LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  res.render('sms/log', { active: 'sms', here: 'log', rows, total, page, pages, status, kind, KIND_LABEL, STATUS_LABEL, ready: readiness(db, dataDir) });
});

router.post('/sms/:id/retry', (req, res) => {
  const { db, smsEngine } = req.app.locals;
  const id = idOf(req.params.id);
  const row = id ? db.prepare('SELECT patient_id FROM sms_messages WHERE id = ?').get(id) : null;
  if (!row) return notFound(res, 'پیام مورد نظر پیدا نشد.');
  if (smsEngine.retry(id)) audit(db, { userId: req.user.id, action: 'sms_retry', patientId: row.patient_id });
  res.redirect(303, '/sms');
});

// ---- settings ----

function sampleFor(template) {
  const t = validateTemplate(template).error ? DEFAULT_TEMPLATE : template;
  const day = localDay();
  return renderTemplate(t, { name: 'علی رضایی', date: visitDateText(day), time: visitTimeText('09:30') });
}

function renderSettings(req, res, { status = 200, errors = {}, values = null, notice = '', keyError = '' } = {}) {
  const { db, dataDir } = req.app.locals;
  const ready = readiness(db, dataDir);
  const shown = values ?? { ...ready.s, sms_enabled: ready.s.sms_enabled };
  const day = localDay();
  res.status(status).render('sms/settings', {
    active: 'sms', here: 'settings', settings: ready.s, values: shown, errors, notice, keyError, key: ready.info, ready,
    planned: plannedReminderCount(db, LEAD_KEYS.includes(shown.sms_lead) ? shown.sms_lead : ready.s.sms_lead),
    LEADS, LEAD_KEYS, canKey: has(req.user, 'sms_key'), TOKENS_SAMPLE: { name: 'علی رضایی', date: visitDateText(day), time: visitTimeText('09:30') },
    sample: sampleFor(shown.sms_template ?? ready.s.sms_template),
  });
}

router.get('/sms/settings', (req, res) => {
  const notice = req.query.saved === '1' ? 'تنظیمات ذخیره شد.' : req.query.key === 'set' ? 'کلید ذخیره شد.' : req.query.key === 'removed' ? 'کلید پاک شد.'
    : Object.hasOwn(TEST_NOTICE, req.query.test) ? TEST_NOTICE[req.query.test] : '';
  renderSettings(req, res, { notice });
});

router.post('/sms/settings', (req, res) => {
  const { db } = req.app.locals;
  const before = getSettings(db);
  const canKey = has(req.user, 'sms_key');
  const { values, errors } = validateSmsSettings(req.body, { canKey });
  const wantOn = req.body.sms_enabled === '1';
  if (wantOn && before.sms_enabled !== '1' && !errors.sms_lead) {
    // Switching on makes reminders for the visits already planned; the clerk confirms the number shown on the page.
    const planned = plannedReminderCount(db, values.sms_lead);
    if (req.body.confirm !== '1' || toAsciiDigits(String(req.body.expected_count ?? '')) !== String(planned)) {
      errors.sms_enabled = `روشن کردن پیامک برای ${planned} ویزیتِ برنامه‌ریزی‌شده یادآوری می‌فرستد؛ تیک تأیید را بزنید.`;
    }
  }
  if (Object.keys(errors).length) return renderSettings(req, res, { status: 422, errors, values: { ...req.body, sms_enabled: wantOn ? '1' : '0' } });
  setSettings(db, { ...values, sms_enabled: wantOn ? '1' : '0' });
  audit(db, { userId: req.user.id, action: 'sms_settings' });
  res.redirect(303, '/sms/settings?saved=1');
});

router.post('/sms/key', async (req, res) => {
  const { db, dataDir, smsProvider } = req.app.locals;
  if (req.body.action === 'remove') {
    removeKey(db);
    setSettings(db, { sms_balance: '', sms_balance_at: '', sms_low_alerted: '0' });
    audit(db, { userId: req.user.id, action: 'sms_key_remove' });
    return res.redirect(303, '/sms/settings?key=removed');
  }
  const apiKey = String(req.body.api_key ?? '').trim();
  if (!API_KEY_PATTERN.test(apiKey)) return renderSettings(req, res, { status: 422, keyError: 'کلید واردشده درست نیست.' });
  const check = await smsProvider.balance(apiKey); // a key that cannot read the balance is not saved
  if (!check.ok) return renderSettings(req, res, { status: 422, keyError: check.text });
  const saved = saveKey(db, dataDir, apiKey, req.user.id);
  if (saved.error) return renderSettings(req, res, { status: 422, keyError: saved.error });
  setSettings(db, { sms_balance: String(check.count), sms_balance_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), sms_low_alerted: '0' });
  audit(db, { userId: req.user.id, action: 'sms_key_set' });
  res.redirect(303, '/sms/settings?key=set');
});

router.post('/sms/test', async (req, res) => {
  const { db, smsEngine } = req.app.locals;
  const s = getSettings(db);
  const phone = normalizeMobile(s.sms_alert_phone);
  if (!phone) return renderSettings(req, res, { status: 422, errors: { sms_alert_phone: 'نخست شماره‌ی موبایل هشدار را ذخیره کنید.' } });
  const id = queueMessage(db, { kind: 'test', phone, body: `پیامک آزمایشی ${s.clinic_name}`, userId: req.user.id });
  const outcome = await smsEngine.sendOne(id);
  audit(db, { userId: req.user.id, action: 'sms_test' });
  res.redirect(303, `/sms/settings?test=${Object.hasOwn(TEST_NOTICE, outcome) ? outcome : 'failed'}`);
});

// ---- bulk ----

function renderBulk(req, res, extra = {}) {
  const { db, dataDir } = req.app.locals;
  res.status(extra.status ?? 200).render('sms/bulk', {
    active: 'sms', here: 'bulk', saved: savedFor(db, req.user), values: { saved: '', text: '' }, error: '', preview: null,
    ready: readiness(db, dataDir), BULK_MAX, ...extra,
  });
}

router.get('/sms/bulk', (req, res) => renderBulk(req, res));

// Both steps read the same fields and recompute the recipients, so the preview can never go stale between the two.
function bulkState(req) {
  const { db, dataDir } = req.app.locals;
  const ready = readiness(db, dataDir);
  const values = { saved: String(req.body.saved ?? ''), text: String(req.body.text ?? '') };
  const fail = (error) => ({ error, values });
  const notReady = notReadyText(ready);
  if (notReady) return fail(notReady);
  const row = findSaved(db, req.user, values.saved);
  if (!row) return fail('جستجوی ذخیره‌شده را انتخاب کنید.');
  const body = validateBody(values.text, { allowName: true });
  if (body.error) return fail(body.error);
  const found = recipientsFor(db, row);
  if (!found) return fail('این جستجو اجرا نمی‌شود. آن را در صفحه‌ی جستجو درست کنید.');
  if (!found.eligible.length) return fail('این جستجو گیرنده‌ی مجازی ندارد.');
  if (found.eligible.length > BULK_MAX) return fail(`حداکثر ${BULK_MAX} گیرنده در هر ارسال. جستجو را محدودتر کنید.`);
  values.text = body.text;
  return { found, text: body.text, values, row, balance: ready.s.sms_balance };
}

router.post('/sms/bulk', (req, res) => {
  const st = bulkState(req);
  if (st.error) return renderBulk(req, res, { status: 422, values: st.values, error: st.error });
  const { found, text } = st;
  renderBulk(req, res, {
    values: st.values,
    preview: {
      count: found.eligible.length, skipped: found.skipped, sample: fillName(text, found.eligible[0]),
      partsEach: smsParts(fillName(text, found.eligible[0])), partsTotal: partsTotal(text, found.eligible), balance: st.balance,
    },
  });
});

router.post('/sms/bulk/confirm', (req, res) => {
  const { db } = req.app.locals;
  const st = bulkState(req);
  if (st.error) return renderBulk(req, res, { status: 422, values: st.values, error: st.error });
  const { found, text } = st;
  if (toAsciiDigits(String(req.body.confirm_count ?? '')).trim() !== String(found.eligible.length)) {
    return renderBulk(req, res, {
      status: 422, values: st.values, error: 'تعداد واردشده با تعداد گیرندگان یکی نیست. پیش‌نمایش دوباره نشان داده شد.',
      preview: {
        count: found.eligible.length, skipped: found.skipped, sample: fillName(text, found.eligible[0]),
        partsEach: smsParts(fillName(text, found.eligible[0])), partsTotal: partsTotal(text, found.eligible), balance: st.balance,
      },
    });
  }
  db.transaction(() => {
    for (const p of found.eligible) queueMessage(db, { kind: 'bulk', patientId: p.id, phone: p.phone, body: fillName(text, p), userId: req.user.id });
    audit(db, { userId: req.user.id, action: 'sms_bulk', detail: `${found.eligible.length} recipients` });
  })();
  res.redirect(303, '/sms?kind=bulk');
});

// ---- one patient ----

function patientFor(db, code) {
  return isPatientCode(code) ? db.prepare('SELECT * FROM patients WHERE code = ?').get(code) : undefined;
}

function renderPatient(req, res, patient, extra = {}) {
  const { db, dataDir } = req.app.locals;
  const why = whyNot(patient);
  res.status(extra.status ?? 200).render('sms/patient', {
    active: 'patients', patient, phone: normalizeMobile(patient.phone), blocked: why ? WHY_LABEL[why] : notReadyText(readiness(db, dataDir)),
    text: '', error: '', ...extra,
  });
}

router.get('/patients/:code/sms', (req, res) => {
  const patient = patientFor(req.app.locals.db, req.params.code);
  if (!patient) return notFound(res, 'پرونده‌ی مورد نظر پیدا نشد.');
  renderPatient(req, res, patient);
});

router.post('/patients/:code/sms', (req, res) => {
  const { db } = req.app.locals;
  const patient = patientFor(db, req.params.code);
  if (!patient) return notFound(res, 'پرونده‌ی مورد نظر پیدا نشد.');
  const body = validateBody(req.body.text, { allowName: false });
  const phone = normalizeMobile(patient.phone);
  const why = whyNot(patient);
  const blockedText = why ? WHY_LABEL[why] : notReadyText(readiness(db, req.app.locals.dataDir));
  if (blockedText) return renderPatient(req, res, patient, { status: 409, text: body.text, error: blockedText });
  if (body.error) return renderPatient(req, res, patient, { status: 422, text: body.text, error: body.error });
  db.transaction(() => {
    queueMessage(db, { kind: 'custom', patientId: patient.id, phone, body: body.text, userId: req.user.id });
    audit(db, { userId: req.user.id, action: 'sms_send', patientId: patient.id, detail: '1 recipient' });
  })();
  res.redirect(303, '/sms?kind=custom');
});

export default router;
