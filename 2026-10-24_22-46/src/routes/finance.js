// Finance tab «امور مالی» (D29): overview with charts, the payments list, recording a payment from here, and the
// finance settings (currency, letterhead, alert defaults, catalog, payment methods, clinic accounts).
// Access is decided in src/lib/route-perms.js.
import { Router } from 'express';
import { audit } from '../audit.js';
import { normalizeText, faKey, likeEscape } from '../lib/normalize.js';
import { parseJalali, toJalaliInput, localDay, addDays, weekStart, jalaliMonth, JALALI_MONTHS, faDigits, formatJalali } from '../lib/jalali.js';
import { formatMoney, parseMoney } from '../lib/money.js';
import { can } from '../lib/perms.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { barChart, hbarChart } from '../lib/charts.js';
import { incomeBetween, incomeByDay, outstanding, revenueBySource, usageByDay } from '../lib/finance.js';
import { billFor, visitNumber, activeMethods, activeAccounts } from '../lib/bill.js';
import { readItemForm } from './storage.js';
import { parseQty } from '../lib/qty.js';

const router = Router();
const PAGE_SIZE = 50;
const idOf = (s) => (/^[1-9]\d{0,15}$/.test(String(s)) ? Number(s) : 0);

// Short axis text for money: 1.2M, 350K (in the display currency).
const shortMoney = (cur) => (rial) => {
  const n = cur === 'R' ? rial : rial / 10;
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
};

router.get('/finance', (req, res) => {
  const { db } = req.app.locals;
  const cur = res.locals.cur;
  const today = localDay();
  const month = jalaliMonth(today);
  const week = { from: weekStart(today), to: today };
  const figures = {
    today: incomeBetween(db, today, today),
    week: incomeBetween(db, week.from, today),
    month: incomeBetween(db, month.from, today),
    ...outstanding(db),
  };
  const fmt = shortMoney(cur);
  // 1. Income per day, last 30 days, newest at the right edge (RTL start).
  const days = incomeByDay(db, addDays(today, -29), today).reverse();
  const daily = days.map((d) => ({ label: faDigits(formatJalali(d.day, 'short').slice(-2)), value: d.total, title: `${formatJalali(d.day)}: ${formatMoney(d.total, cur)}`, highlight: d.day === today }));
  // 2. Income per Jalali month, last 6 months.
  const months = [];
  for (let i = 0; i < 6; i += 1) {
    const m = jalaliMonth(today, -i);
    const inc = incomeBetween(db, m.from, i === 0 ? today : m.to).total;
    months.push({ label: JALALI_MONTHS[m.jm - 1], value: inc, title: `${JALALI_MONTHS[m.jm - 1]} ${faDigits(m.jy)}: ${formatMoney(inc, cur)}`, highlight: i === 0 });
  }
  // 3. Billed this month by source.
  const source = revenueBySource(db, month.from, month.to);
  const sourceRows = [
    { label: 'خدمات', value: source.byKind.service },
    { label: 'کالاها', value: source.byKind.item },
  ];
  // 4. Pieces used per day (storage view only).
  const usage = can(req.user, 'storage') ? usageByDay(db, addDays(today, -29), today).reverse() : null;
  res.render('finance/index', {
    active: 'finance', figures, today, month, week,
    monthName: `${JALALI_MONTHS[month.jm - 1]} ${faDigits(month.jy)}`,
    charts: {
      daily: barChart(daily, { fmt, tick: 5, label: 'درآمد روزانه‌ی ۳۰ روز اخیر' }),
      monthly: barChart(months, { fmt, label: 'درآمد ۶ ماه اخیر' }),
      source: hbarChart(sourceRows, { fmt: (v) => formatMoney(v, cur), label: 'فروش این ماه بر اساس نوع' }),
      top: source.top.length ? hbarChart(source.top.slice(0, 8), { fmt: (v) => formatMoney(v, cur), label: 'پرفروش‌ترین موارد این ماه' }) : '',
      usage: usage ? barChart(usage.map((d) => ({ label: faDigits(formatJalali(d.day, 'short').slice(-2)), value: d.total, title: `${formatJalali(d.day)}: ${faDigits(d.total)} عدد` })), { fmt: (v) => faDigits(Math.round(v)), tick: 5, label: 'تعداد کالای مصرف‌شده در ۳۰ روز اخیر' }) : '',
    },
    tables: { days, months, sourceRows, top: source.top.slice(0, 8), usage, billDisc: source.billDisc },
  });
});

// ---- Payments list ----------------------------------------------------------
const KINDS = ['payment', 'refund', 'move_out', 'move_in'];

router.get('/finance/payments', (req, res) => {
  const { db } = req.app.locals;
  const today = localDay();
  const from = parseJalali(req.query.from) ?? jalaliMonth(today).from;
  const to = parseJalali(req.query.to) ?? today;
  const method = idOf(req.query.method);
  const account = idOf(req.query.account);
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : '';
  const where = ['p.paid_on BETWEEN ? AND ?'];
  const params = [from, to];
  if (method) { where.push('p.method_id = ?'); params.push(method); }
  if (account) { where.push('p.account_id = ?'); params.push(account); }
  if (kind) { where.push('p.kind = ?'); params.push(kind); }
  const clause = `WHERE ${where.join(' AND ')}`;
  const sum = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(p.amount), 0) AS total,
                                 COALESCE(SUM(CASE WHEN p.kind IN ('payment','refund') THEN p.amount END), 0) AS income
                          FROM payments p ${clause}`).get(...params);
  const pages = Math.max(1, Math.ceil(sum.n / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number.parseInt(req.query.page, 10) || 1), pages);
  const rows = db.prepare(`SELECT p.*, m.name AS method, a.name AS account, v.visit_date, v.id AS visit_id, pt.code, pt.first_name, pt.last_name
                           FROM payments p JOIN visits v ON v.id = p.visit_id JOIN patients pt ON pt.id = v.patient_id
                           LEFT JOIN pay_methods m ON m.id = p.method_id LEFT JOIN accounts a ON a.id = p.account_id
                           ${clause} ORDER BY p.paid_on DESC, p.id DESC LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  res.render('finance/payments', {
    active: 'finance', rows, sum, page, pages,
    filters: { from: toJalaliInput(from), to: toJalaliInput(to), method, account, kind },
    methods: db.prepare('SELECT * FROM pay_methods ORDER BY id').all(), accounts: db.prepare('SELECT * FROM accounts ORDER BY id').all(),
  });
});

// ---- Record a payment from the Finance tab ---------------------------------------
// Pick a patient (search by name, code or phone), then one of their visits; the form posts to the visit's own
// payment route with back=pay, so both places share one form and one set of rules.
router.get('/finance/pay', (req, res) => {
  const { db } = req.app.locals;
  let patient = null;
  const fromVisit = idOf(req.query.visit) ? db.prepare('SELECT patient_id FROM visits WHERE id = ?').get(idOf(req.query.visit)) : null;
  if (fromVisit) patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(fromVisit.patient_id);
  else if (/^P-\d{6}$/.test(String(req.query.patient ?? ''))) patient = db.prepare('SELECT * FROM patients WHERE code = ?').get(req.query.patient);
  const text = normalizeText(String(req.query.q ?? '').slice(0, 100));
  let found = [];
  if (!patient && text) {
    const name = `%${likeEscape(faKey(text))}%`;
    const raw = `%${likeEscape(text)}%`;
    found = db.prepare(`SELECT code, first_name, last_name, phone FROM patients
      WHERE fa_key(first_name || ' ' || last_name) LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
      ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE LIMIT 20`).all(name, raw, raw);
  }
  let visits = [];
  if (patient) {
    // Unpaid visits first, then planned ones (for prepayment); newest first inside each group.
    visits = db.prepare("SELECT * FROM visits WHERE patient_id = ? AND status <> 'cancelled' ORDER BY visit_date DESC, visit_time DESC").all(patient.id)
      .map((v) => ({ ...v, number: visitNumber(db, v), bill: billFor(db, v) }))
      .filter((v) => v.bill.remaining > 0 || v.status === 'scheduled' || v.id === idOf(req.query.visit));
  }
  res.render('finance/pay', {
    active: 'finance', text, found, patient, visits, chosen: idOf(req.query.visit),
    notice: req.query.ok === '1' ? 'پرداخت ثبت شد.' : null,
    methods: activeMethods(db), accounts: activeAccounts(db), today: toJalaliInput(localDay()),
  });
});

// ---- Settings ---------------------------------------------------------------
function renderSettings(req, res, { status = 200, errors = {}, notice = null, values = {} } = {}) {
  const { db } = req.app.locals;
  const used = (table, col, id) => Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1`).get(id));
  res.status(status).render('finance/settings', {
    active: 'finance', settings: getSettings(db), errors, notice, values,
    catalog: db.prepare('SELECT * FROM catalog ORDER BY fixed DESC, kind DESC, active DESC, name').all()
      .map((c) => ({ ...c, used: used('bill_lines', 'catalog_id', c.id) || used('lots', 'item_id', c.id) })),
    methods: db.prepare('SELECT * FROM pay_methods ORDER BY id').all().map((m) => ({ ...m, used: used('payments', 'method_id', m.id) })),
    accounts: db.prepare('SELECT * FROM accounts ORDER BY id').all()
      .map((a) => ({ ...a, used: used('payments', 'account_id', a.id) || used('pay_methods', 'default_account', a.id) })),
  });
}

const NOTICES = { saved: 'تنظیمات ذخیره شد.', added: 'اضافه شد.', removed: 'حذف شد.' };
router.get('/finance/settings', (req, res) => renderSettings(req, res, { notice: NOTICES[req.query.ok] ?? null }));
const back = (res, ok, anchor = '') => res.redirect(303, `/finance/settings?ok=${ok}${anchor}`);

router.post('/finance/settings', (req, res) => {
  const { db } = req.app.locals;
  const errors = {};
  const currency = req.body.currency === 'R' ? 'R' : 'T';
  const warn = parseQty(req.body.low_warn, { allowZero: true });
  const crit = parseQty(req.body.low_crit, { allowZero: true });
  if (warn === null || Number.isNaN(warn)) errors.low_warn = 'یک عدد وارد کنید (تا دو رقم اعشار).';
  if (crit === null || Number.isNaN(crit)) errors.low_crit = 'یک عدد وارد کنید (تا دو رقم اعشار).';
  if (!errors.low_warn && !errors.low_crit && crit > warn) errors.low_crit = 'حد بحرانی نباید از حد هشدار بیشتر باشد.';
  const name = normalizeText(req.body.clinic_name).slice(0, 120);
  if (!name) errors.clinic_name = 'نام کلینیک را وارد کنید.';
  if (Object.keys(errors).length) return renderSettings(req, res, { status: 422, errors, values: req.body });
  db.transaction(() => {
    setSettings(db, {
      currency, low_warn: warn, low_crit: crit, clinic_name: name,
      clinic_address: normalizeText(req.body.clinic_address).slice(0, 300), clinic_phone: normalizeText(req.body.clinic_phone).slice(0, 60),
    });
    audit(db, { userId: req.user.id, action: 'finance_settings', detail: `currency=${currency} warn=${warn} crit=${crit}` });
  })();
  back(res, 'saved');
});

// Catalog: a new service or item, edits, deactivation, and deletion of entries no bill or lot has used.
router.post('/finance/settings/catalog', (req, res) => {
  const { db } = req.app.locals;
  const kind = req.body.kind === 'item' ? 'item' : 'service';
  const { errors, row } = readItemForm(req.body, res.locals.cur);
  if (Object.keys(errors).length) return renderSettings(req, res, { status: 422, errors: { catalog: Object.values(errors)[0] }, values: req.body });
  db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO catalog (kind, name, sale_price, purchase_cost, low_warn, low_crit) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kind, row.name, row.sale_price, kind === 'item' ? row.purchase_cost : null, kind === 'item' ? row.low_warn : null, kind === 'item' ? row.low_crit : null).lastInsertRowid);
    audit(db, { userId: req.user.id, action: 'catalog_add', detail: `${kind}=${id} price=${row.sale_price}` });
  })();
  back(res, 'added', '#catalog');
});

router.post('/finance/settings/catalog/:id', (req, res) => {
  const { db } = req.app.locals;
  const entry = db.prepare('SELECT * FROM catalog WHERE id = ?').get(idOf(req.params.id));
  if (!entry) return res.status(404).render('error', { status: 404, message: 'این مورد پیدا نشد.' });
  const name = normalizeText(req.body.name).slice(0, 120);
  const price = parseMoney(req.body.sale_price, res.locals.cur);
  if (!name || price === null) return renderSettings(req, res, { status: 422, errors: { [`c${entry.id}`]: 'نام و قیمت فروش را درست وارد کنید.' } });
  const active = req.body.active === '1' ? 1 : 0;
  db.transaction(() => {
    db.prepare('UPDATE catalog SET name = ?, sale_price = ?, active = ? WHERE id = ?').run(name, price, active, entry.id);
    audit(db, { userId: req.user.id, action: 'catalog_edit', detail: `catalog=${entry.id} price=${entry.sale_price}->${price} active=${active}` });
  })();
  back(res, 'saved', '#catalog');
});

router.post('/finance/settings/catalog/:id/delete', (req, res) => {
  const { db } = req.app.locals;
  const entry = db.prepare('SELECT * FROM catalog WHERE id = ?').get(idOf(req.params.id));
  if (!entry) return res.status(404).render('error', { status: 404, message: 'این مورد پیدا نشد.' });
  const used = db.prepare('SELECT 1 FROM bill_lines WHERE catalog_id = ? UNION SELECT 1 FROM lots WHERE item_id = ? LIMIT 1').get(entry.id, entry.id);
  if (used) return renderSettings(req, res, { status: 409, errors: { [`c${entry.id}`]: 'این مورد در صورتحساب یا انبار به کار رفته است؛ فقط می‌توان آن را غیرفعال کرد.' } });
  db.transaction(() => {
    db.prepare('DELETE FROM catalog WHERE id = ?').run(entry.id);
    audit(db, { userId: req.user.id, action: 'catalog_delete', detail: `catalog=${entry.id}` });
  })();
  back(res, 'removed', '#catalog');
});

// Payment methods and clinic accounts: small editable lists; a used row can only be deactivated.
function listRoutes(kind) {
  const table = kind === 'method' ? 'pay_methods' : 'accounts';
  const usedSql = kind === 'method' ? 'SELECT 1 FROM payments WHERE method_id = ? LIMIT 1'
    : 'SELECT 1 FROM payments WHERE account_id = ? UNION SELECT 1 FROM pay_methods WHERE default_account = ? LIMIT 1';
  const base = `/finance/settings/${kind}s`;
  const readAccount = (db, v) => (idOf(v) && db.prepare('SELECT id FROM accounts WHERE id = ?').get(idOf(v)) ? idOf(v) : null);

  router.post(base, (req, res) => {
    const { db } = req.app.locals;
    const name = normalizeText(req.body.name).slice(0, 80);
    if (!name) return renderSettings(req, res, { status: 422, errors: { [kind]: 'نام را وارد کنید.' } });
    db.transaction(() => {
      const id = kind === 'method'
        ? db.prepare('INSERT INTO pay_methods (name, default_account) VALUES (?, ?)').run(name, readAccount(db, req.body.default_account)).lastInsertRowid
        : db.prepare('INSERT INTO accounts (name) VALUES (?)').run(name).lastInsertRowid;
      audit(db, { userId: req.user.id, action: 'finance_settings', detail: `${kind}_add=${id}` });
    })();
    back(res, 'added', `#${kind}s`);
  });

  router.post(`${base}/:id`, (req, res) => {
    const { db } = req.app.locals;
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(idOf(req.params.id));
    if (!row) return res.status(404).render('error', { status: 404, message: 'این مورد پیدا نشد.' });
    const name = normalizeText(req.body.name).slice(0, 80);
    if (!name) return renderSettings(req, res, { status: 422, errors: { [kind]: 'نام را وارد کنید.' } });
    const active = req.body.active === '1' ? 1 : 0;
    db.transaction(() => {
      if (kind === 'method') db.prepare('UPDATE pay_methods SET name = ?, default_account = ?, active = ? WHERE id = ?').run(name, readAccount(db, req.body.default_account), active, row.id);
      else db.prepare('UPDATE accounts SET name = ?, active = ? WHERE id = ?').run(name, active, row.id);
      audit(db, { userId: req.user.id, action: 'finance_settings', detail: `${kind}_edit=${row.id} active=${active}` });
    })();
    back(res, 'saved', `#${kind}s`);
  });

  router.post(`${base}/:id/delete`, (req, res) => {
    const { db } = req.app.locals;
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(idOf(req.params.id));
    if (!row) return res.status(404).render('error', { status: 404, message: 'این مورد پیدا نشد.' });
    if (db.prepare(usedSql).get(...(kind === 'method' ? [row.id] : [row.id, row.id]))) {
      return renderSettings(req, res, { status: 409, errors: { [kind]: 'این مورد به کار رفته است؛ فقط می‌توان آن را غیرفعال کرد.' } });
    }
    db.transaction(() => {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
      audit(db, { userId: req.user.id, action: 'finance_settings', detail: `${kind}_delete=${row.id}` });
    })();
    back(res, 'removed', `#${kind}s`);
  });
}
listRoutes('method');
listRoutes('account');

export default router;
