import { Router } from 'express';
import { audit } from '../audit.js';
import { normalizeText } from '../lib/normalize.js';
import { ageFrom } from '../lib/jalali.js';
import { patientsCsv, patientTable } from '../lib/csv.js';
import { toXlsx, XLSX_TYPE } from '../lib/xlsx.js';
import { FIELDS, OPERATORS, MAX_RULES, STATUS_KEYS, SearchError, buildWhere, queryFromForm, statusFilter } from '../lib/search-sql.js';
import { STATUS } from '../lib/labels.js';

const router = Router();
const PAGE_SIZE = 25;
const MAX_SAVED_PER_USER = 50;
const hasRule = (r) => r && String(r.field ?? '').trim() !== '' && String(r.value ?? '').trim() !== '';

// A query object back to URL parameters (join, f1..f6, o1..o6, v1..v6, w1..w6).
function queryToParams(query) {
  const p = new URLSearchParams({ join: query.join });
  query.rules.slice(0, MAX_RULES).forEach((r, i) => {
    const n = i + 1;
    for (const [key, v] of [['f', r.field], ['o', r.op], ['v', r.value], ['w', r.value2]]) {
      if (v !== undefined && v !== null && String(v) !== '') p.set(`${key}${n}`, String(v));
    }
  });
  if (statusFilter(query.status)) p.set('s', query.status);
  return p;
}

// Plain-language summary of the active rules, shown beside the results.
function describe(query) {
  const rules = query.rules.filter(hasRule);
  const status = statusFilter(query.status);
  if (!rules.length && !status) return '';
  const lines = rules.map((r) => {
    const field = Object.hasOwn(FIELDS, r.field) ? FIELDS[r.field] : null;
    const op = field && Object.hasOwn(OPERATORS[field.type], r.op) ? OPERATORS[field.type][r.op] : '؟';
    const value = String(r.value).slice(0, 60) + (op === 'بین' && r.value2 ? ` و ${String(r.value2).slice(0, 60)}` : '');
    return `(${field ? field.label : '؟'} ${op} ${value})`;
  });
  const head = query.join === 'or' ? 'ترکیب: هر یک از شرط‌ها (یا)' : 'ترکیب: همه‌ی شرط‌ها (و)';
  const body = lines.map((l, i) => (i ? `${query.join === 'or' ? 'یا' : 'و'} ${l}` : l));
  return [...(rules.length ? [head, ...body] : []), ...(status ? [`وضعیت: ${STATUS[status].label}`] : [])].join('\n');
}

const canSee = (user, row) => row && (user.role === 'admin' || row.user_id === user.id);

function savedFor(db, user) {
  const sql = `SELECT s.id, s.user_id, s.name, s.created_at, u.display_name AS owner
               FROM saved_searches s LEFT JOIN users u ON u.id = s.user_id`;
  return user.role === 'admin'
    ? db.prepare(`${sql} ORDER BY s.id DESC`).all()
    : db.prepare(`${sql} WHERE s.user_id = ? ORDER BY s.id DESC`).all(user.id);
}

function render(req, res, { status = 200, ...extra } = {}) {
  const { db } = req.app.locals;
  const query = extra.query ?? queryFromForm(req.query);
  res.status(status).render('search/index', {
    active: 'search', FIELDS, OPERATORS, MAX_RULES, STATUS_KEYS, STATUS, query, error: null, results: null,
    saved: savedFor(db, req.user), summary: describe(query), saveError: null,
    params: queryToParams(query).toString(), ...extra,
  });
}

router.get('/search', (req, res) => {
  const { db } = req.app.locals;
  const query = queryFromForm(req.query);
  if (!('join' in req.query)) return render(req, res, { query }); // first visit: just the form

  let built;
  try {
    built = buildWhere(query);
  } catch (err) {
    if (err instanceof SearchError) return render(req, res, { status: 422, query, error: err.message });
    throw err;
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM patients WHERE ${built.where}`).get(...built.params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number.parseInt(req.query.page, 10) || 1), pages);
  const rows = db.prepare(`SELECT id, code, first_name, last_name, birth_date, sex, status, updated_at
                           FROM patients WHERE ${built.where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...built.params, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .map((r) => ({ ...r, age: ageFrom(r.birth_date) }));
  render(req, res, { query, results: { rows, total, page, pages, pageSize: PAGE_SIZE } });
});

// Every patient matching the current rules, as CSV or as a right-to-left Excel sheet. Audited, never cached.
function exportSearch(format) {
  return async (req, res) => {
    const { db } = req.app.locals;
    let built;
    try {
      built = buildWhere(queryFromForm(req.query));
    } catch (err) {
      if (err instanceof SearchError) return res.status(422).render('error', { status: 422, message: err.message });
      throw err;
    }
    const rows = db.prepare(`SELECT * FROM patients WHERE ${built.where} ORDER BY id`).all(...built.params);
    audit(db, { userId: req.user.id, action: 'export_search', detail: `${rows.length} rows, ${format}` });
    res.set({ 'Content-Disposition': `attachment; filename="patients-search.${format}"`, 'Cache-Control': 'private, no-store' });
    if (format === 'csv') return res.type('text/csv; charset=utf-8').send(patientsCsv(rows));
    const t = patientTable(rows);
    res.type(XLSX_TYPE).send(await toXlsx(t.headers, t.rows, 'نتیجه‌ی جستجو'));
  };
}
router.get('/search/export.csv', exportSearch('csv'));
router.get('/search/export.xlsx', exportSearch('xlsx'));

router.post('/search/saved', (req, res) => {
  const { db } = req.app.locals;
  const query = queryFromForm(req.body);
  const name = normalizeText(String(req.body.name ?? '')).slice(0, 80);
  const fail = (saveError) => render(req, res, { status: 422, query, saveError });
  if (!name) return fail('برای جستجو یک نام وارد کنید.');
  try {
    buildWhere(query); // refuse to save a search that cannot run
  } catch (err) {
    if (err instanceof SearchError) return fail(err.message);
    throw err;
  }
  const active = { join: query.join, status: query.status, rules: query.rules.filter(hasRule).map(({ field, op, value, value2 }) => ({ field, op, value, value2 })) };
  if (!active.rules.length && !active.status) return fail('حداقل یک شرط با مقدار لازم است.');
  const count = db.prepare('SELECT COUNT(*) AS n FROM saved_searches WHERE user_id = ?').get(req.user.id).n;
  if (count >= MAX_SAVED_PER_USER) return fail('تعداد جستجوهای ذخیره‌شده به سقف رسیده است. چند مورد را حذف کنید.');
  db.prepare('INSERT INTO saved_searches (user_id, name, query_json) VALUES (?, ?, ?)').run(req.user.id, name, JSON.stringify(active));
  res.redirect(303, `/search?${queryToParams(query)}`);
});

function findSaved(req) {
  const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
  const row = req.app.locals.db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(id);
  return canSee(req.user, row) ? row : null;
}

router.get('/search/saved/:id', (req, res) => {
  const row = findSaved(req);
  if (!row) return res.status(404).render('error', { status: 404, message: 'جستجوی ذخیره‌شده پیدا نشد.' });
  let stored;
  try { stored = JSON.parse(row.query_json); } catch { stored = { join: 'and', rules: [] }; }
  res.redirect(303, `/search?${queryToParams({ join: stored.join === 'or' ? 'or' : 'and', status: statusFilter(stored.status), rules: Array.isArray(stored.rules) ? stored.rules : [] })}`);
});

router.post('/search/saved/:id/delete', (req, res) => {
  const row = findSaved(req);
  if (!row) return res.status(404).render('error', { status: 404, message: 'جستجوی ذخیره‌شده پیدا نشد.' });
  req.app.locals.db.prepare('DELETE FROM saved_searches WHERE id = ?').run(row.id);
  res.redirect(303, '/search');
});

export default router;
