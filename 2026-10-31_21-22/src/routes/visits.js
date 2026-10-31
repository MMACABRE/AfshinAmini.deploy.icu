// Visits timeline (D23): the /visits page, the add and edit forms, status changes and delete.
// A patient's own timeline is rendered by the profile page from visitsFor() below.
import { Router } from 'express';
import { audit } from '../audit.js';
import { normalizeText, faKey, likeEscape } from '../lib/normalize.js';
import { parseJalali, toJalaliInput, localDay, addDays } from '../lib/jalali.js';
import { isPatientCode } from '../lib/files.js';
import { validateVisit, rangeFor, RANGES, VISIT_STATUSES, findOverlap, overlapMessage, endTime, dayBookings, parseTime } from '../lib/visits.js';
import { syncStockForStatus, visitHasPayments, releaseStock, BillError, PAYMENTS_BLOCK } from '../lib/bill.js';
import { notFound as notFoundPage } from '../lib/http.js';

const router = Router();
const PAGE_SIZE = 50;

function findPatient(db, code) {
  return isPatientCode(code) ? db.prepare('SELECT * FROM patients WHERE code = ?').get(code) : undefined;
}

function findVisit(db, id) {
  if (!/^[1-9]\d{0,15}$/.test(String(id))) return undefined; // '1abc' or '1e1' must not reach visit 1
  return db.prepare(`SELECT v.*, p.code, p.first_name, p.last_name, p.status AS patient_status FROM visits v JOIN patients p ON p.id = v.patient_id
                     WHERE v.id = ?`).get(Number(id));
}

const archivedMessage = 'پرونده بایگانی‌شده است. برای ثبت ویزیت جدید، نخست آن را از بایگانی خارج کنید.';

// An archived patient gets no new planned visits. Bringing back a cancelled or done visit as planned is a new plan
// too; a visit that is already planned may still be moved, finished or cancelled.
const replansArchived = (visit, status) => visit.patient_status === 'archived' && status === 'scheduled' && visit.status !== 'scheduled';

const notFound = (res, message = 'ویزیت مورد نظر پیدا نشد.') => notFoundPage(res, message);

// A planned visit is "ongoing" while now is inside its span and "overdue" once its span has ended without a result.
// Both are derived, never stored. Spans are compared as moments, so one that crosses midnight stays ongoing until it ends.
export function markOverdue(rows, now = new Date()) {
  return rows.map((v) => {
    const [y, m, d] = v.visit_date.split('-').map(Number);
    const start = new Date(y, m - 1, d, Number(v.visit_time.slice(0, 2)), Number(v.visit_time.slice(3, 5)));
    const end = new Date(start.getTime() + v.duration_min * 60000);
    const planned = v.status === 'scheduled';
    return { ...v, overdue: planned && end <= now, ongoing: planned && start <= now && now < end };
  });
}

// One patient's visits for the profile: the next planned visit, then planned ones soonest first, then the past.
export function visitsFor(db, patientId) {
  const today = localDay();
  const rows = markOverdue(db.prepare('SELECT * FROM visits WHERE patient_id = ? ORDER BY visit_date DESC, visit_time DESC').all(patientId));
  const upcoming = rows.filter((v) => v.status === 'scheduled' && !v.overdue).reverse();
  const rest = rows.filter((v) => !upcoming.includes(v));
  return { next: upcoming[0] ?? null, upcoming, rest, today };
}

// Today's visits for the dashboard card.
export function todaysVisits(db) {
  const today = localDay();
  return markOverdue(db.prepare(`SELECT v.*, p.code, p.first_name, p.last_name FROM visits v JOIN patients p ON p.id = v.patient_id
                                 WHERE v.visit_date = ? AND v.status <> 'cancelled' ORDER BY v.visit_time, v.id`).all(today));
}

// The visit form, with the booked times of the form's day listed under the time box: the day bar without
// JavaScript (D50). The visit being edited is left out of its own day.
function renderForm(req, res, locals, status = 200) {
  const day = parseJalali(locals.values.visit_date);
  const booked = day ? dayBookings(req.app.locals.db, day, locals.visit?.id ?? 0) : [];
  res.status(status).render('visits/form', { active: 'visits', ...locals, booked });
}

// A new visit starts on today, or on the day and time picked on the /visits day bar (?d=1403/05/12&t=09:30).
function newValues(query) {
  const day = parseJalali(query.d);
  return { visit_date: toJalaliInput(day ?? localDay()), visit_time: parseTime(query.t) ?? '' };
}

// Day bar data for one day (?d= Jalali). Read-only; names stay in the page and show only on hover (D50).
const DAY_LIMIT = 400; // more visits than any one day can hold (5-minute visits fill a day with 288)
router.get('/visits/day', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const day = parseJalali(req.query.d);
  if (!day) return res.status(400).json({ error: 'تاریخ نامعتبر است.' });
  const exclude = /^[1-9]\d{0,15}$/.test(String(req.query.exclude ?? '')) ? Number(req.query.exclude) : 0;
  const bookings = dayBookings(req.app.locals.db, day, exclude).slice(0, DAY_LIMIT)
    .map(({ start, end, time, until, name, status, fromYesterday }) => ({ start, end, time, until, name, status, fromYesterday }));
  res.json({ date: day, today: day === localDay(), bookings });
});

// Only a same-site path may be used as a return address (same rule as the theme button).
const safeBack = (b, fallback) => (/^\/(?![/\\])[^\r\n]*$/.test(String(b ?? '')) ? String(b) : fallback);

router.get('/visits', (req, res) => {
  const db = req.app.locals.db;
  const today = localDay();
  const day = parseJalali(req.query.d);
  const range = day ? { name: '', from: day, to: day, desc: false } : rangeFor(String(req.query.range ?? ''), today);
  const status = VISIT_STATUSES.includes(req.query.status) ? req.query.status : '';
  const where = [];
  const params = [];
  if (range.from) { where.push('v.visit_date >= ?'); params.push(range.from); }
  if (range.to) { where.push('v.visit_date <= ?'); params.push(range.to); }
  if (status) { where.push('v.status = ?'); params.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM visits v ${clause}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number.parseInt(req.query.page, 10) || 1), pages);
  const dir = range.desc ? 'DESC' : 'ASC';
  const rows = markOverdue(db.prepare(`SELECT v.*, p.code, p.first_name, p.last_name, p.status AS patient_status FROM visits v JOIN patients p ON p.id = v.patient_id
                                       ${clause} ORDER BY v.visit_date ${dir}, v.visit_time ${dir}, v.id LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE));
  // Day bar on top (D50): the chosen day, the one day of a range such as "tomorrow", otherwise today.
  const barDay = day ?? (range.from && range.from === range.to ? range.from : today);
  const bar = {
    date: barDay, input: toJalaliInput(barDay), prev: toJalaliInput(addDays(barDay, -1)), next: toJalaliInput(addDays(barDay, 1)),
    isToday: barDay === today, bookings: dayBookings(db, barDay),
  };
  res.render('visits/list', {
    active: 'visits', rows, total, page, pages, status, today, ranges: RANGES, bar,
    rangeName: day ? '' : range.name, dayInput: day ? toJalaliInput(day) : '',
  });
});

// New visit. Without ?patient= it first asks which patient (search by name, code or phone).
router.get('/visits/new', (req, res) => {
  const db = req.app.locals.db;
  const patient = findPatient(db, String(req.query.patient ?? ''));
  if (patient?.status === 'archived') return res.status(409).render('error', { status: 409, message: archivedMessage });
  if (patient) {
    return renderForm(req, res, { patient, visit: null, values: newValues(req.query), errors: {}, back: '' });
  }
  const text = normalizeText(String(req.query.q ?? '').slice(0, 100));
  let found = [];
  if (text) {
    const name = `%${likeEscape(faKey(text))}%`;
    const raw = `%${likeEscape(text)}%`;
    const digits = `%${likeEscape(text.replace(/[\s-]/g, ''))}%`; // phones are stored without spaces or dashes
    found = db.prepare(`SELECT code, first_name, last_name FROM patients
      WHERE status <> 'archived' AND (fa_key(first_name || ' ' || last_name) LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')
      ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE LIMIT 20`).all(name, raw, digits);
  }
  // A day and time picked on the /visits day bar ride along to the form.
  const when = { d: parseJalali(req.query.d) ? toJalaliInput(parseJalali(req.query.d)) : '', t: parseTime(req.query.t) ?? '' };
  res.render('visits/pick', { active: 'visits', text, found, when });
});

router.post('/patients/:code/visits', (req, res) => {
  const db = req.app.locals.db;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res, 'پرونده‌ی مورد نظر پیدا نشد.');
  if (patient.status === 'archived') return res.status(409).render('error', { status: 409, message: archivedMessage });
  const { values, errors } = validateVisit(req.body);
  const back = req.body.back === 'profile' ? 'profile' : '';
  if (Object.keys(errors).length) {
    return renderForm(req, res, { patient, visit: null, values: req.body, errors, back }, 422);
  }
  const clash = values.status === 'cancelled' ? undefined : findOverlap(db, { date: values.visit_date, time: values.visit_time, duration: values.duration_min });
  if (clash) {
    return renderForm(req, res, { patient, visit: null, values: req.body, errors: { visit_time: overlapMessage(clash) }, back }, 422);
  }
  db.transaction(() => {
    db.prepare(`INSERT INTO visits (patient_id, visit_date, visit_time, duration_min, reason, notes, status, reminder_lead, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(patient.id, values.visit_date, values.visit_time, values.duration_min, values.reason, values.notes, values.status, values.reminder_lead ?? null, req.user.id);
    audit(db, { userId: req.user.id, action: 'visit_add', patientId: patient.id });
  })();
  res.redirect(303, back === 'profile' ? `/patients/${patient.code}#visits` : `/visits?d=${encodeURIComponent(toJalaliInput(values.visit_date))}`);
});

router.get('/visits/:id/edit', (req, res) => {
  const visit = findVisit(req.app.locals.db, req.params.id);
  if (!visit) return notFound(res);
  renderForm(req, res, {
    patient: visit, visit,
    values: { ...visit, visit_date: toJalaliInput(visit.visit_date) }, errors: {}, back: safeBack(req.query.back, ''),
  });
});

router.post('/visits/:id', (req, res) => {
  const db = req.app.locals.db;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const { values, errors } = validateVisit(req.body);
  const back = safeBack(req.body.back, '');
  if (Object.keys(errors).length) {
    return renderForm(req, res, { patient: visit, visit, values: req.body, errors, back }, 422);
  }
  if (replansArchived(visit, values.status)) return res.status(409).render('error', { status: 409, message: archivedMessage });
  const clash = values.status === 'cancelled' ? undefined : findOverlap(db, { date: values.visit_date, time: values.visit_time, duration: values.duration_min, excludeId: visit.id });
  if (clash) {
    return renderForm(req, res, { patient: visit, visit, values: req.body, errors: { visit_time: overlapMessage(clash) }, back }, 422);
  }
  try {
    db.transaction(() => {
      syncStockForStatus(db, { visit, status: values.status, userId: req.user.id });
      db.prepare(`UPDATE visits SET visit_date = ?, visit_time = ?, duration_min = ?, reason = ?, notes = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(values.visit_date, values.visit_time, values.duration_min, values.reason, values.notes, values.status, visit.id);
      if (values.reminder_lead !== undefined) db.prepare('UPDATE visits SET reminder_lead = ? WHERE id = ?').run(values.reminder_lead, visit.id);
      audit(db, { userId: req.user.id, action: 'visit_edit', patientId: visit.patient_id });
    })();
  } catch (err) {
    if (!(err instanceof BillError)) throw err;
    return res.status(err.status).render('error', { status: err.status, message: err.message });
  }
  res.redirect(303, back || `/patients/${visit.code}#visits`);
});

router.post('/visits/:id/status', (req, res) => {
  const db = req.app.locals.db;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  if (VISIT_STATUSES.includes(req.body.status)) {
    if (replansArchived(visit, req.body.status)) return res.status(409).render('error', { status: 409, message: archivedMessage });
    if (req.body.status !== 'cancelled' && visit.status === 'cancelled') {
      const clash = findOverlap(db, { date: visit.visit_date, time: visit.visit_time, duration: visit.duration_min, excludeId: visit.id });
      if (clash) return res.status(409).render('error', { status: 409, message: overlapMessage(clash) });
    }
    try {
      db.transaction(() => {
        // Cancelling gives a bill's items back to the store; bringing the visit back takes them again (D27).
        syncStockForStatus(db, { visit, status: req.body.status, userId: req.user.id });
        db.prepare("UPDATE visits SET status = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.status, visit.id);
        audit(db, { userId: req.user.id, action: 'visit_status', patientId: visit.patient_id, detail: req.body.status });
      })();
    } catch (err) {
      if (!(err instanceof BillError)) throw err;
      return res.status(err.status).render('error', { status: err.status, message: err.message });
    }
  }
  res.redirect(303, safeBack(req.body.back, `/patients/${visit.code}#visits`));
});

router.post('/visits/:id/delete', (req, res) => {
  const db = req.app.locals.db;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  // Payment history must never vanish (D28): refund or move the money first.
  if (visitHasPayments(db, visit.id)) return res.status(409).render('error', { status: 409, message: PAYMENTS_BLOCK });
  db.transaction(() => {
    releaseStock(db, { visitIds: [visit.id], userId: req.user.id });
    db.prepare('DELETE FROM visits WHERE id = ?').run(visit.id);
    audit(db, { userId: req.user.id, action: 'visit_delete', patientId: visit.patient_id });
  })();
  res.redirect(303, safeBack(req.body.back, `/patients/${visit.code}#visits`));
});

export default router;
