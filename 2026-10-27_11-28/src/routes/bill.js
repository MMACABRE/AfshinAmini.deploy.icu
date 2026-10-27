// Visit page with its bill and payments (D27-D28), the doctor's note, and the patient's «سوابق درمان و مالی».
// Access is decided in src/lib/route-perms.js; bill rules live in src/lib/bill.js.
import { Router } from 'express';
import { audit } from '../audit.js';
import { normalizeText } from '../lib/normalize.js';
import { parseJalali, toJalaliInput, localDay, faDigits } from '../lib/jalali.js';
import { parseMoney, parseDiscount } from '../lib/money.js';
import { isPatientCode } from '../lib/files.js';
import { can } from '../lib/perms.js';
import { available, StockShortError, shortMessage } from '../lib/stock.js';
import { parseQty } from '../lib/qty.js';
import { markOverdue } from './visits.js';
import { idOf, notFound as notFoundPage } from '../lib/http.js';
import {
  billFor, visitNumber, addLine, lineTooLarge, TOO_LARGE, deleteLine, addPayment, moveCredit, deletePayment, assertNotOverdrawn, activeMethods, activeAccounts, BillError,
} from '../lib/bill.js';

const router = Router();

function findVisit(db, id) {
  return db.prepare(`SELECT v.*, p.code, p.first_name, p.last_name, p.status AS patient_status, p.disc_kind AS p_disc_kind,
                            p.disc_value AS p_disc_value
                     FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = ?`).get(idOf(id));
}
const notFound = (res, message = 'ویزیت مورد نظر پیدا نشد.') => notFoundPage(res, message);

// Catalog entries a line may use, items with their usable count.
function catalogChoices(db) {
  const rows = db.prepare('SELECT * FROM catalog WHERE active = 1 ORDER BY fixed DESC, kind DESC, name').all();
  const today = localDay();
  return rows.map((r) => (r.kind === 'item' ? { ...r, usable: available(db, r.id, today) } : r));
}

// Other visits of the same patient that credit can move to.
const moveTargets = (db, visit) => db.prepare(`SELECT id, visit_date, visit_time FROM visits
  WHERE patient_id = ? AND id <> ? AND status <> 'cancelled' ORDER BY visit_date DESC, visit_time DESC LIMIT 30`).all(visit.patient_id, visit.id);

function renderVisit(req, res, visit, { status = 200, errors = {}, values = {}, notice = null, editPayment = null } = {}) {
  const { db } = req.app.locals;
  const [marked] = markOverdue([visit]);
  const finance = can(req.user, 'finance');
  res.status(status).render('visits/show', {
    active: 'visits', visit: marked, number: visitNumber(db, visit),
    bill: finance ? billFor(db, visit) : null,
    catalog: can(req.user, 'finance', 2) ? catalogChoices(db) : [],
    methods: activeMethods(db), accounts: activeAccounts(db),
    targets: finance ? moveTargets(db, visit) : [],
    errors, values, notice, editPayment, today: toJalaliInput(localDay()),
  });
}

const NOTICES = { line: 'به صورتحساب اضافه شد.', paid: 'پرداخت ثبت شد.', saved: 'ذخیره شد.', removed: 'حذف شد.', refund: 'بازپرداخت ثبت شد.', moved: 'اعتبار منتقل شد.' };
const done = (res, visit, what) => res.redirect(303, `/visits/${visit.id}?ok=${what}#bill`);

router.get('/visits/:id', (req, res) => {
  const visit = findVisit(req.app.locals.db, req.params.id);
  if (!visit) return notFound(res);
  renderVisit(req, res, visit, { notice: NOTICES[req.query.ok] ?? null });
});

// Runs fn; a BillError or a stock shortage re-renders the visit page with the message instead of failing.
function attempt(req, res, visit, fn, { values = {} } = {}) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof BillError) { renderVisit(req, res, visit, { status: err.status, errors: { bill: err.message }, values }); return false; }
    if (err instanceof StockShortError) {
      renderVisit(req, res, visit, { status: 409, errors: { line: shortMessage(values.entryName ?? '', err.available) }, values });
      return false;
    }
    throw err;
  }
}

// ---- Doctor's note --------------------------------------------------------
router.post('/visits/:id/note', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const note = String(req.body.doctor_note ?? '').replace(/\r\n/g, '\n').normalize('NFC').trim().slice(0, 5000);
  db.transaction(() => {
    db.prepare("UPDATE visits SET doctor_note = ?, updated_at = datetime('now') WHERE id = ?").run(note || null, visit.id);
    audit(db, { userId: req.user.id, action: 'visit_note', patientId: visit.patient_id, detail: `visit=${visit.id}` });
  })();
  res.redirect(303, `/visits/${visit.id}?ok=saved#note`);
});

// ---- Lines ----------------------------------------------------------------
router.post('/visits/:id/lines', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const typed = normalizeText(req.body.entry).slice(0, 120);
  // The search box sends the name; catalog_id is still accepted from older pages.
  const found = typed
    ? db.prepare('SELECT * FROM catalog WHERE active = 1 AND fa_key(name) = fa_key(?) LIMIT 2').all(typed)
    : db.prepare('SELECT * FROM catalog WHERE id = ? AND active = 1').all(idOf(req.body.catalog_id));
  const entry = found.length === 1 ? found[0] : null;
  const qty = parseQty(req.body.qty || '1');
  const values = { entry: typed, qty: String(req.body.qty ?? ''), entryName: entry?.name };
  if (found.length > 1) return renderVisit(req, res, visit, { status: 422, errors: { line: `چند مورد با نام «${typed}» در فهرست قیمت هست؛ نام یکی را در تنظیمات مالی عوض کنید.` }, values });
  if (!entry) return renderVisit(req, res, visit, { status: 422, errors: { line: typed ? `«${typed}» در فهرست خدمات و کالاها پیدا نشد؛ از پیشنهادهای فهرست انتخاب کنید.` : 'یک خدمت یا کالا انتخاب کنید.' }, values });
  if (!qty) return renderVisit(req, res, visit, { status: 422, errors: { line: 'تعداد را به عدد وارد کنید (تا دو رقم اعشار، مثل ۰٫۵).' }, values });
  const id = attempt(req, res, visit, () => db.transaction(() => {
    const lineId = addLine(db, { visit, entry, qty, userId: req.user.id });
    audit(db, { userId: req.user.id, action: 'bill_line_add', patientId: visit.patient_id, detail: `visit=${visit.id} line=${lineId} catalog=${entry.id} qty=${qty}` });
    return lineId;
  })(), { values });
  if (id) done(res, visit, 'line');
});

function findLine(db, visit, id) {
  return db.prepare('SELECT * FROM bill_lines WHERE id = ? AND visit_id = ?').get(idOf(id), visit.id);
}

router.post('/visits/:id/lines/:line/delete', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const line = findLine(db, visit, req.params.line);
  if (!line) return notFound(res, 'این ردیف پیدا نشد.');
  db.transaction(() => {
    deleteLine(db, { line, userId: req.user.id });
    audit(db, { userId: req.user.id, action: 'bill_line_delete', patientId: visit.patient_id, detail: `visit=${visit.id} line=${line.id} qty=${line.qty}` });
  })();
  done(res, visit, 'removed');
});

router.post('/visits/:id/lines/:line/discount', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const line = findLine(db, visit, req.params.line);
  if (!line) return notFound(res, 'این ردیف پیدا نشد.');
  const d = parseDiscount(req.body.disc_kind, req.body.disc_value, res.locals.cur);
  if (d?.error) return renderVisit(req, res, visit, { status: 422, errors: { [`line${line.id}`]: d.error } });
  db.transaction(() => {
    db.prepare('UPDATE bill_lines SET disc_kind = ?, disc_value = ? WHERE id = ?').run(d?.kind ?? null, d?.value ?? 0, line.id);
    audit(db, { userId: req.user.id, action: 'bill_discount', patientId: visit.patient_id, detail: `line=${line.id} ${d ? `${d.kind}=${d.value}` : 'none'}` });
  })();
  done(res, visit, 'saved');
});

// Price override for this bill only (flag price_override). Empty brings back the frozen catalog price.
router.post('/visits/:id/lines/:line/price', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const line = findLine(db, visit, req.params.line);
  if (!line) return notFound(res, 'این ردیف پیدا نشد.');
  const text = String(req.body.price ?? '').trim();
  const price = text ? parseMoney(text, res.locals.cur) : null;
  if (text && price === null) return renderVisit(req, res, visit, { status: 422, errors: { [`line${line.id}`]: 'قیمت تازه را به عدد وارد کنید.' } });
  if (price !== null && lineTooLarge({ ...line, override_price: price })) return renderVisit(req, res, visit, { status: 422, errors: { [`line${line.id}`]: TOO_LARGE } });
  const next = price === line.unit_price ? null : price;
  db.transaction(() => {
    db.prepare('UPDATE bill_lines SET override_price = ? WHERE id = ?').run(next, line.id);
    audit(db, { userId: req.user.id, action: 'price_override', patientId: visit.patient_id, detail: `line=${line.id} from=${line.override_price ?? line.unit_price} to=${next ?? line.unit_price}` });
  })();
  done(res, visit, 'saved');
});

router.post('/visits/:id/discount', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const d = parseDiscount(req.body.disc_kind, req.body.disc_value, res.locals.cur);
  if (d?.error) return renderVisit(req, res, visit, { status: 422, errors: { billDisc: d.error } });
  db.transaction(() => {
    db.prepare('UPDATE visits SET disc_kind = ?, disc_value = ? WHERE id = ?').run(d?.kind ?? null, d?.value ?? 0, visit.id);
    audit(db, { userId: req.user.id, action: 'bill_discount', patientId: visit.patient_id, detail: `visit=${visit.id} ${d ? `${d.kind}=${d.value}` : 'none'}` });
  })();
  done(res, visit, 'saved');
});

// ---- Payments -------------------------------------------------------------
// Reads amount, date, method and account. Returns { values, errors, row }.
function readPayment(db, body, cur, { needMethod = true } = {}) {
  const values = {
    amount: String(body.amount ?? '').slice(0, 30), paid_on: String(body.paid_on ?? '').slice(0, 20),
    method_id: String(body.method_id ?? ''), account_id: String(body.account_id ?? ''), note: normalizeText(body.note).slice(0, 200),
  };
  const errors = {};
  const amount = parseMoney(values.amount, cur);
  if (!amount) errors.amount = 'مبلغ را به عدد و بیشتر از صفر وارد کنید.';
  const paidOn = values.paid_on.trim() ? parseJalali(values.paid_on) : localDay();
  if (!paidOn) errors.paid_on = 'تاریخ را به شکل ۱۴۰۵/۰۸/۰۱ وارد کنید.';
  else if (paidOn > localDay()) errors.paid_on = 'تاریخ پرداخت نمی‌تواند بعد از امروز باشد.';
  const method = db.prepare('SELECT * FROM pay_methods WHERE id = ? AND active = 1').get(idOf(values.method_id));
  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND active = 1').get(idOf(values.account_id) || method?.default_account || 0);
  if (needMethod && !method) errors.method_id = 'روش پرداخت را انتخاب کنید.';
  if (needMethod && !account) errors.account_id = 'حساب را انتخاب کنید.';
  return { values, errors, row: { amount, paidOn, methodId: method?.id ?? null, accountId: account?.id ?? null, note: values.note } };
}

const backTo = (req, visit) => (req.body.back === 'pay' ? `/finance/pay?visit=${visit.id}&ok=1` : null);

router.post('/visits/:id/payments', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const bill = billFor(db, visit);
  const body = { ...req.body };
  // «پرداخت کامل» pays exactly what is left, worked out here, never trusted from the form.
  if (body.full === '1') {
    if (!bill.remaining) return renderVisit(req, res, visit, { status: 422, errors: { pay: 'مانده‌ای برای پرداخت نیست.' }, values: body });
    body.amount = `${bill.remaining}R`;
  }
  const { values, errors, row } = readPayment(db, body, res.locals.cur);
  if (Object.keys(errors).length) return renderVisit(req, res, visit, { status: 422, errors: { pay: Object.values(errors)[0], ...errors }, values });
  const id = attempt(req, res, visit, () => db.transaction(() => {
    const pid = addPayment(db, { visit, ...row, userId: req.user.id });
    audit(db, { userId: req.user.id, action: 'payment_add', patientId: visit.patient_id, detail: `visit=${visit.id} payment=${pid} amount=${row.amount} method=${row.methodId} account=${row.accountId}` });
    return pid;
  })(), { values });
  if (!id) return;
  const back = backTo(req, visit);
  return back ? res.redirect(303, back) : done(res, visit, 'paid');
});

router.post('/visits/:id/refund', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const bill = billFor(db, visit);
  const { values, errors, row } = readPayment(db, req.body, res.locals.cur);
  if (!errors.amount && row.amount > bill.credit) errors.amount = 'مبلغ بازپرداخت از بستانکاری بیشتر است.';
  if (Object.keys(errors).length) return renderVisit(req, res, visit, { status: 422, errors: { refund: Object.values(errors)[0] }, values });
  db.transaction(() => {
    const pid = addPayment(db, { visit, ...row, kind: 'refund', userId: req.user.id });
    audit(db, { userId: req.user.id, action: 'payment_refund', patientId: visit.patient_id, detail: `visit=${visit.id} payment=${pid} amount=${row.amount}` });
  })();
  done(res, visit, 'refund');
});

router.post('/visits/:id/move', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const bill = billFor(db, visit);
  const to = db.prepare("SELECT * FROM visits WHERE id = ? AND patient_id = ? AND id <> ? AND status <> 'cancelled'").get(idOf(req.body.to), visit.patient_id, visit.id);
  const amount = parseMoney(req.body.amount, res.locals.cur);
  let error = null;
  if (!to) error = 'ویزیت مقصد را از ویزیت‌های همین بیمار انتخاب کنید.';
  else if (!amount) error = 'مبلغ را به عدد و بیشتر از صفر وارد کنید.';
  else if (amount > bill.credit) error = 'مبلغ انتقال از بستانکاری بیشتر است.';
  if (error) return renderVisit(req, res, visit, { status: 422, errors: { move: error } });
  db.transaction(() => {
    const moveId = moveCredit(db, { from: visit, to, amount, paidOn: localDay(), userId: req.user.id });
    audit(db, { userId: req.user.id, action: 'payment_move', patientId: visit.patient_id, detail: `from=${visit.id} to=${to.id} amount=${amount} move=${moveId}` });
  })();
  done(res, visit, 'moved');
});

function findPayment(db, visit, id) {
  return db.prepare('SELECT * FROM payments WHERE id = ? AND visit_id = ?').get(idOf(id), visit.id);
}

router.get('/visits/:id/payments/:pid/edit', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const p = findPayment(db, visit, req.params.pid);
  if (!p || p.move_id) return notFound(res, 'این پرداخت پیدا نشد یا قابل ویرایش نیست.');
  renderVisit(req, res, visit, { editPayment: p });
});

router.post('/visits/:id/payments/:pid/edit', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const p = findPayment(db, visit, req.params.pid);
  if (!p || p.move_id) return notFound(res, 'این پرداخت پیدا نشد یا قابل ویرایش نیست.');
  const { errors, row } = readPayment(db, req.body, res.locals.cur);
  if (!errors.amount && p.kind === 'refund') {
    // Same rule as a new refund: at most the credit, counted as if this refund were not there.
    const bill = billFor(db, visit);
    if (row.amount > Math.max(bill.paid - p.amount - bill.owed, 0)) errors.amount = 'مبلغ بازپرداخت از بستانکاری بیشتر است.';
  }
  if (Object.keys(errors).length) return renderVisit(req, res, visit, { status: 422, editPayment: p, errors: { edit: Object.values(errors)[0] } });
  // Same rule as a new payment: a cancelled visit takes no more money.
  if (visit.status === 'cancelled' && p.kind === 'payment' && row.amount > p.amount) {
    return renderVisit(req, res, visit, { status: 409, editPayment: p, errors: { edit: 'ویزیت لغو شده است؛ پرداخت آن را نمی‌توان بیشتر کرد.' } });
  }
  const signed = p.kind === 'refund' ? -row.amount : row.amount;
  try {
    db.transaction(() => {
      db.prepare('UPDATE payments SET amount = ?, paid_on = ?, method_id = ?, account_id = ?, note = ? WHERE id = ?')
        .run(signed, row.paidOn, row.methodId, row.accountId, row.note || null, p.id);
      assertNotOverdrawn(db, [visit.id]);
      audit(db, { userId: req.user.id, action: 'payment_edit', patientId: visit.patient_id, detail: `payment=${p.id} from=${p.amount} to=${signed} day=${row.paidOn}` });
    })();
  } catch (err) {
    if (!(err instanceof BillError)) throw err;
    return renderVisit(req, res, visit, { status: 422, editPayment: p, errors: { edit: err.message } });
  }
  done(res, visit, 'saved');
});

router.post('/visits/:id/payments/:pid/delete', (req, res) => {
  const { db } = req.app.locals;
  const visit = findVisit(db, req.params.id);
  if (!visit) return notFound(res);
  const p = findPayment(db, visit, req.params.pid);
  if (!p) return notFound(res, 'این پرداخت پیدا نشد.');
  const ok = attempt(req, res, visit, () => db.transaction(() => {
    deletePayment(db, p);
    audit(db, { userId: req.user.id, action: 'payment_delete', patientId: visit.patient_id, detail: `payment=${p.id} amount=${p.amount} kind=${p.kind}${p.move_id ? ` move=${p.move_id}` : ''}` });
    return true;
  })());
  if (ok) done(res, visit, 'removed');
});

// ---- Patient: standing discount and «سوابق درمان و مالی» ------------------------
const findPatient = (db, code) => (isPatientCode(code) ? db.prepare('SELECT * FROM patients WHERE code = ?').get(code) : undefined);

router.post('/patients/:code/discount', (req, res) => {
  const { db } = req.app.locals;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res, 'پرونده‌ی مورد نظر پیدا نشد.');
  const d = parseDiscount(req.body.disc_kind, req.body.disc_value, res.locals.cur);
  if (d?.error) return res.status(422).render('error', { status: 422, message: d.error });
  db.transaction(() => {
    db.prepare('UPDATE patients SET disc_kind = ?, disc_value = ? WHERE id = ?').run(d?.kind ?? null, d?.value ?? 0, patient.id);
    audit(db, { userId: req.user.id, action: 'patient_discount', patientId: patient.id, detail: d ? `${d.kind}=${d.value}` : 'none' });
  })();
  res.redirect(303, `/patients/${patient.code}/history`);
});

// Every visit of one patient with its bill, newest first, plus the totals across them.
export function historyFor(db, patient) {
  const visits = db.prepare('SELECT * FROM visits WHERE patient_id = ? ORDER BY visit_date DESC, visit_time DESC, id DESC').all(patient.id)
    .map((v) => ({ ...v, number: visitNumber(db, v), bill: billFor(db, v) }));
  const sum = (k) => visits.reduce((s, v) => s + v.bill[k], 0);
  return { visits, totals: { owed: sum('owed'), paid: sum('paid'), remaining: sum('remaining'), credit: sum('credit') } };
}

router.get('/patients/:code/history', (req, res) => {
  const { db } = req.app.locals;
  const patient = findPatient(db, req.params.code);
  if (!patient) return notFound(res, 'پرونده‌ی مورد نظر پیدا نشد.');
  res.render('patients/history', { active: 'patients', patient, ...historyFor(db, patient), faDigits });
});

export default router;
