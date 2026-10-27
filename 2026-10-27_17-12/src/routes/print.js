// PDF documents «فرم‌های چاپی» (D30): print-styled HTML pages in one shared frame (views/print/, public/css/print.css).
// The browser's Print / Save as PDF turns them into PDF today; a server engine can later render the same pages once the
// owner approves its dependency (see the spike ticket #13). The pdf area is checked in src/lib/route-perms.js; each
// document also checks every area whose data it shows, here.
import { Router } from 'express';
import { audit } from '../audit.js';
import { parseJalali, toJalaliInput, localDay, jalaliMonth, formatJalaliDateTime } from '../lib/jalali.js';
import { isPatientCode } from '../lib/files.js';
import { documentsFor } from './documents.js';
import { discountOf } from '../lib/money.js';
import { can, VIEW } from '../lib/perms.js';
import { forbidden } from '../auth.js';
import { getSettings } from '../lib/settings.js';
import { billFor, visitNumber, lineGross } from '../lib/bill.js';
import { roundQty } from '../lib/qty.js';
import { itemsWithStock, expiryLevel, daysUntil } from '../lib/stock.js';
import { idOf, notFound } from '../lib/http.js';

const router = Router();

// A day from the query string: `fallback` when missing. A typed date that is not valid renders an error page and
// gives null, instead of silently showing another day's report.
function dayOf(req, res, key, fallback) {
  const raw = String(req.query[key] ?? '').trim();
  if (!raw) return fallback;
  const iso = parseJalali(raw);
  if (!iso) res.status(422).render('error', { status: 422, message: 'تاریخ نامعتبر است. نمونه: ۱۴۰۵/۰۸/۰۱' });
  return iso;
}

// Every document gets the letterhead, the generated-at stamp and the user's name.
function show(req, res, view, data, { doc, patientId = null }) {
  const { db } = req.app.locals;
  audit(db, { userId: req.user.id, action: 'print', patientId, detail: doc });
  res.render(`print/${view}`, {
    ...data, clinic: getSettings(db), generated: formatJalaliDateTime(new Date()), by: req.user.displayName,
  });
}

const needs = (req, ...areas) => areas.every((a) => can(req.user, a, VIEW));

router.get('/print', (req, res) => {
  const today = localDay();
  res.render('print/index', { active: 'print', today: toJalaliInput(today), monthFrom: toJalaliInput(jalaliMonth(today).from) });
});

// 1. Daily finance report: income counted by payment day (D28).
router.get('/print/finance/day', (req, res) => {
  if (!needs(req, 'finance', 'patients')) return forbidden(res);
  const { db } = req.app.locals;
  const day = dayOf(req, res, 'd', localDay());
  if (!day) return;
  const rows = db.prepare(`SELECT p.*, m.name AS method, a.name AS account, v.visit_date, pt.code, pt.first_name, pt.last_name
                           FROM payments p JOIN visits v ON v.id = p.visit_id JOIN patients pt ON pt.id = v.patient_id
                           LEFT JOIN pay_methods m ON m.id = p.method_id LEFT JOIN accounts a ON a.id = p.account_id
                           WHERE p.paid_on = ? AND p.kind IN ('payment', 'refund') ORDER BY p.created_at, p.id`).all(day);
  const group = (key) => [...rows.reduce((m, r) => m.set(r[key] ?? '—', (m.get(r[key] ?? '—') ?? 0) + r.amount), new Map())];
  show(req, res, 'finance-day', {
    day, rows, total: rows.reduce((s, r) => s + r.amount, 0), byMethod: group('method'), byAccount: group('account'),
  }, { doc: `finance_day ${day}` });
});

// 2. Day visit list (owner's request): «پرداخت» is paid in total on that visit so far, explained in a footnote.
router.get('/print/visits/day', (req, res) => {
  if (!needs(req, 'visits', 'patients', 'finance')) return forbidden(res);
  const { db } = req.app.locals;
  const day = dayOf(req, res, 'd', localDay());
  if (!day) return;
  const visits = db.prepare(`SELECT v.*, p.code, p.first_name, p.last_name FROM visits v JOIN patients p ON p.id = v.patient_id
                             WHERE v.visit_date = ? AND v.status <> 'cancelled' ORDER BY v.visit_time, v.id`).all(day)
    .map((v) => {
      const bill = billFor(db, v);
      const uniq = (k) => [...new Set(bill.payments.filter((p) => p[k]).map((p) => p[k]))].join('، ');
      return { ...v, number: visitNumber(db, v), bill, methods: uniq('method'), accounts: uniq('account') };
    });
  const sum = (k) => visits.reduce((s, v) => s + v.bill[k], 0);
  show(req, res, 'visits-day', { day, visits, totals: { owed: sum('owed'), paid: sum('paid'), remaining: sum('remaining') } }, { doc: `visits_day ${day}` });
});

// 2b. Daily visit report (D38): every non-cancelled visit of one day with its reason, lines, discounts and payments
// (whatever day they were paid), ending with a sum per clinic account. Moves between visits carry no account, so
// they show on their visit but stay out of the account sum.
router.get('/print/visits/report', (req, res) => {
  if (!needs(req, 'visits', 'patients', 'finance')) return forbidden(res);
  const { db } = req.app.locals;
  const day = dayOf(req, res, 'd', localDay());
  if (!day) return;
  const visits = db.prepare(`SELECT v.*, p.code, p.first_name, p.last_name FROM visits v JOIN patients p ON p.id = v.patient_id
                             WHERE v.visit_date = ? AND v.status <> 'cancelled' ORDER BY v.visit_time, v.id`).all(day)
    .map((v) => ({ ...v, bill: billFor(db, v) }));
  const byAccount = new Map();
  for (const v of visits) {
    for (const p of v.bill.payments) {
      if (p.kind !== 'payment' && p.kind !== 'refund') continue;
      const key = p.account ?? '—';
      byAccount.set(key, (byAccount.get(key) ?? 0) + p.amount);
    }
  }
  const sum = (k) => visits.reduce((s, v) => s + v.bill[k], 0);
  show(req, res, 'visits-report', {
    day, visits, byAccount: [...byAccount], accountTotal: [...byAccount.values()].reduce((s, n) => s + n, 0),
    totals: { owed: sum('owed'), paid: sum('paid'), remaining: sum('remaining'), credit: sum('credit') },
  }, { doc: `visits_report ${day}` });
});

// 3. Items used in a range, by item or by patient (bill lines of non-cancelled visits dated in the range).
router.get('/print/stock/usage', (req, res) => {
  if (!needs(req, 'storage')) return forbidden(res);
  const byPatient = req.query.by === 'patient';
  if (byPatient && !needs(req, 'patients')) return forbidden(res);
  const { db } = req.app.locals;
  const today = localDay();
  const from = dayOf(req, res, 'from', jalaliMonth(today).from);
  if (!from) return;
  const to = dayOf(req, res, 'to', today);
  if (!to) return;
  const lines = db.prepare(`SELECT l.*, v.visit_date, p.code, p.first_name, p.last_name FROM bill_lines l
                            JOIN visits v ON v.id = l.visit_id JOIN patients p ON p.id = v.patient_id
                            WHERE l.kind = 'item' AND v.status <> 'cancelled' AND v.visit_date BETWEEN ? AND ?
                            ORDER BY ${byPatient ? 'p.last_name, p.first_name, p.code, l.name' : 'l.name'}`).all(from, to)
    .map((l) => ({ ...l, net: lineGross(l) - discountOf(lineGross(l), l.disc_kind, l.disc_value) })); // after line discount
  let rows;
  if (byPatient) {
    rows = lines.map((l) => ({ code: l.code, name: `${l.first_name} ${l.last_name}`, item: l.name, qty: l.qty, amount: l.net, day: l.visit_date }));
  } else {
    const m = new Map();
    for (const l of lines) {
      const r = m.get(l.name) ?? { item: l.name, qty: 0, amount: 0 };
      r.qty = roundQty(r.qty + l.qty);
      r.amount += l.net;
      m.set(l.name, r);
    }
    rows = [...m.values()];
  }
  show(req, res, 'stock-usage', {
    from, to, byPatient, rows, totalQty: roundQty(rows.reduce((s, r) => s + r.qty, 0)), totalAmount: rows.reduce((s, r) => s + r.amount, 0),
  }, { doc: `stock_usage ${from} ${to} ${byPatient ? 'patient' : 'item'}` });
});

// 3b. Daily product report (D40): the stock items used on one day, per patient, then a sum per item. Same visit
// blocks as the full daily report, without services or payments.
router.get('/print/stock/day', (req, res) => {
  if (!needs(req, 'storage', 'patients', 'visits')) return forbidden(res);
  const { db } = req.app.locals;
  const day = dayOf(req, res, 'd', localDay());
  if (!day) return;
  const visits = db.prepare(`SELECT v.*, p.code, p.first_name, p.last_name FROM visits v JOIN patients p ON p.id = v.patient_id
                             WHERE v.visit_date = ? AND v.status <> 'cancelled' ORDER BY v.visit_time, v.id`).all(day)
    .map((v) => ({ ...v, lines: billFor(db, v).lines.filter((l) => l.kind === 'item') }))
    .filter((v) => v.lines.length);
  const byItem = new Map();
  for (const l of visits.flatMap((v) => v.lines)) {
    const r = byItem.get(l.name) ?? { item: l.name, qty: 0, amount: 0, patients: 0 };
    r.qty = roundQty(r.qty + l.qty);
    r.amount += l.net;
    byItem.set(l.name, r);
  }
  for (const r of byItem.values()) r.patients = new Set(visits.filter((v) => v.lines.some((l) => l.name === r.item)).map((v) => v.patient_id)).size;
  const items = [...byItem.values()].sort((a, b) => a.item.localeCompare(b.item, 'fa'));
  show(req, res, 'stock-day', {
    day, visits, items, patientCount: new Set(visits.map((v) => v.patient_id)).size, totalAmount: items.reduce((s, r) => s + r.amount, 0),
  }, { doc: `stock_day ${day}` });
});

// 3c. Stock on hand (D41): every active stock item with its usable count and each lot still holding stock, with its
// expiry and alert, so the clinic can count the shelves and see what runs out or expires first.
router.get('/print/stock/inventory', (req, res) => {
  if (!needs(req, 'storage')) return forbidden(res);
  const { db } = req.app.locals;
  const settings = getSettings(db);
  const today = localDay();
  const lots = db.prepare('SELECT * FROM lots WHERE remaining > 0 ORDER BY expires_on IS NULL, expires_on, id').all();
  const items = itemsWithStock(db, settings, today).map((it) => ({
    ...it,
    lots: lots.filter((l) => l.item_id === it.id).map((l) => ({ ...l, level: expiryLevel(l, today), days: l.expires_on ? daysUntil(l.expires_on, today) : null })),
  }));
  show(req, res, 'stock-inventory', {
    day: today, items, alertCount: items.filter((i) => i.low || i.expiry).length,
  }, { doc: 'stock_inventory' });
});

// 4. Visit bill (A5).
router.get('/print/visits/:id/bill', (req, res) => {
  if (!needs(req, 'finance', 'patients')) return forbidden(res);
  const { db } = req.app.locals;
  const visit = db.prepare(`SELECT v.*, p.code, p.first_name, p.last_name, p.national_id FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = ?`)
    .get(idOf(req.params.id));
  if (!visit) return notFound(res, 'ویزیت مورد نظر پیدا نشد.');
  show(req, res, 'bill', { visit, number: visitNumber(db, visit), bill: billFor(db, visit) }, { doc: `bill visit=${visit.id}`, patientId: visit.patient_id });
});

// 5. Full patient record: info, medications, visits; bills only with finance view, files only with documents view.
router.get('/print/patients/:code', (req, res) => {
  if (!needs(req, 'patients')) return forbidden(res);
  const { db, dataDir } = req.app.locals;
  const patient = isPatientCode(req.params.code) ? db.prepare('SELECT * FROM patients WHERE code = ?').get(req.params.code) : undefined;
  if (!patient) return notFound(res, 'پرونده‌ی مورد نظر پیدا نشد.');
  const finance = can(req.user, 'finance');
  const visits = can(req.user, 'visits')
    ? db.prepare('SELECT * FROM visits WHERE patient_id = ? ORDER BY visit_date, visit_time').all(patient.id)
      .map((v) => ({ ...v, number: visitNumber(db, v), bill: finance ? billFor(db, v) : null }))
    : null;
  const files = can(req.user, 'documents') ? documentsFor(db, dataDir, patient) : null; // listed, never embedded
  show(req, res, 'patient', {
    patient, visits, files, finance,
    medications: db.prepare('SELECT * FROM medications WHERE patient_id = ? ORDER BY id').all(patient.id),
  }, { doc: `patient ${patient.code}`, patientId: patient.id });
});

export default router;
