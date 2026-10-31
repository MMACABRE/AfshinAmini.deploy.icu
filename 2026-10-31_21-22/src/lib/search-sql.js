// Advanced search: turns a rule list from the search form into a parameterized WHERE clause.
// Field names and operators come ONLY from the whitelists below; user values are always
// bound as parameters. Never interpolate anything from the request into SQL.
import { faKey, likeEscape, normalizeText, toAsciiDigits } from './normalize.js';
import { STATUS, SEX } from './labels.js';
import { parseJalali, faDigits } from './jalali.js';

export class SearchError extends Error {}

// 'localtime' = the server's time zone (Asia/Tehran), so ages and days match what the pages show.
const AGE_SQL = `(CAST(strftime('%Y','now','localtime') AS INTEGER) - CAST(strftime('%Y', birth_date) AS INTEGER)
  - (strftime('%m-%d','now','localtime') < strftime('%m-%d', birth_date)))`;

// key -> { sql, type, label, values? }. `label` is the Persian text for the form.
export const FIELDS = {
  name:        { sql: "fa_key(first_name || ' ' || last_name)", type: 'text', label: 'نام و نام خانوادگی' },
  father_name: { sql: 'fa_key(father_name)', type: 'text', label: 'نام پدر' },
  code:        { sql: 'code', type: 'text', label: 'کد بیمار' },
  national_id: { sql: 'national_id', type: 'text', label: 'کد ملی' },
  phone:       { sql: 'phone', type: 'text', label: 'تلفن' },
  city:        { sql: 'fa_key(city)', type: 'text', label: 'شهر' },
  allergies:   { sql: 'fa_key(allergies)', type: 'text', label: 'حساسیت‌ها' },
  conditions:  { sql: 'fa_key(conditions)', type: 'text', label: 'بیماری‌ها' },
  visit_reason: { sql: 'fa_key(visit_reason)', type: 'text', label: 'علت مراجعه' },
  referral:    { sql: 'fa_key(referral)', type: 'text', label: 'معرف' },
  blood_type:  { sql: 'blood_type', type: 'enum', label: 'گروه خونی',
                 values: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] },
  sex:         { sql: 'sex', type: 'enum', label: 'جنسیت', values: ['female', 'male'], valueLabels: SEX },
  status:      { sql: 'status', type: 'enum', label: 'وضعیت', values: ['active', 'pending', 'critical', 'archived'],
                 valueLabels: Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label])) },
  age:         { sql: AGE_SQL, type: 'number', label: 'سن' },
  birth_date:  { sql: 'birth_date', type: 'date', label: 'تاریخ تولد' },
  created_at:  { sql: "date(created_at, 'localtime')", type: 'date', label: 'تاریخ ثبت پرونده' },
  updated_at:  { sql: "date(updated_at, 'localtime')", type: 'date', label: 'آخرین تغییر' },
};

// The operators the form offers per kind of field. The server still accepts every operator of the field's type
// (OPERATORS below), so searches saved earlier keep working; the form just stops offering the ones that do not fit.
const UI_OPS = {
  text:   ['contains', 'not_contains', 'equals'],
  code:   ['contains', 'equals'],           // identifiers: a code or number is never "less than" another
  number: ['eq', 'lt', 'gt', 'between'],
  date:   ['before', 'after', 'between'],
  enum:   ['is', 'is_not'],
};
const CODE_FIELDS = new Set(['code', 'national_id', 'phone']);
// Kept only so older saved searches and links keep working. The form shows a status switch instead.
const HIDDEN_FIELDS = new Set(['status']);
for (const [key, f] of Object.entries(FIELDS)) {
  f.ops = UI_OPS[CODE_FIELDS.has(key) ? 'code' : f.type];
  f.hidden = HIDDEN_FIELDS.has(key);
  if (f.type === 'enum' && !f.hidden) f.choices = f.values.map((v) => [v, f.valueLabels?.[v] ?? v]); // shown as buttons
}

export const OPERATORS = {
  text:   { contains: 'شامل', not_contains: 'شامل نباشد', equals: 'برابر' },
  number: { eq: 'برابر', lt: 'کمتر از', gt: 'بیشتر از', between: 'بین' },
  date:   { eq: 'برابر', before: 'قبل از', after: 'بعد از', between: 'بین' },
  enum:   { is: 'باشد', is_not: 'نباشد' },
};

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

function numberValue(v) {
  const n = Number(toAsciiDigits(String(v).trim()));
  if (!Number.isFinite(n)) throw new SearchError('مقدار عددی نامعتبر است.');
  return n;
}

function dateValue(v) {
  const iso = parseJalali(v);
  // Persian digits: an ASCII "1405/13/40" inside Persian text is reordered by the bidi algorithm.
  if (!iso) throw new SearchError(`تاریخ «${faDigits(String(v).slice(0, 20))}» نامعتبر است. نمونه: ۱۴۰۳/۰۵/۱۲`);
  return iso;
}

// Enum values may be typed as the stored key ("critical", "o+") or the Persian label ("بحرانی").
function enumValue(field, v) {
  const typed = normalizeText(v);
  const key = field.values.find((k) => k.toLowerCase() === typed.toLowerCase())
    ?? field.values.find((k) => field.valueLabels?.[k] && faKey(field.valueLabels[k]) === faKey(typed));
  if (!key) throw new SearchError('مقدار انتخاب‌شده نامعتبر است.');
  return key;
}

function textValue(field, v) {
  // Columns wrapped in fa_key() are compared against faKey(value); plain columns get digit-normalized text,
  // in the shape they are stored: codes upper case, phone and national ID without spaces or dashes.
  if (field.sql.startsWith('fa_key(')) return faKey(v);
  const s = toAsciiDigits(String(v).trim());
  if (field.sql === 'code') return s.toUpperCase();
  if (field.sql === 'phone' || field.sql === 'national_id') return s.replace(/[\s-]/g, '');
  return s;
}

function ruleSql(rule) {
  // hasOwn, not FIELDS[x]: names like "constructor" would otherwise hit Object.prototype.
  if (typeof rule.field !== 'string' || !Object.hasOwn(FIELDS, rule.field)) throw new SearchError('فیلد جستجو نامعتبر است.');
  const field = FIELDS[rule.field];
  const ops = OPERATORS[field.type];
  if (!Object.hasOwn(ops, rule.op)) throw new SearchError('عملگر جستجو نامعتبر است.');
  const col = field.sql;
  const { op, value, value2 } = rule;

  switch (field.type) {
    case 'text': {
      const v = textValue(field, value);
      if (op === 'equals') return { sql: `${col} = ?`, params: [v] };
      const like = `%${likeEscape(v)}%`;
      if (op === 'contains') return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [like] };
      return { sql: `(${col} IS NULL OR ${col} NOT LIKE ? ESCAPE '\\')`, params: [like] };
    }
    case 'enum': {
      const v = enumValue(field, value);
      return op === 'is' ? { sql: `${col} = ?`, params: [v] } : { sql: `(${col} IS NULL OR ${col} <> ?)`, params: [v] };
    }
    case 'number':
    case 'date': {
      const conv = field.type === 'number' ? numberValue : dateValue;
      if (op === 'between') {
        if (isBlank(value2)) throw new SearchError('برای «بین» هر دو مقدار لازم است.');
        const [lo, hi] = [conv(value), conv(value2)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // "60 to 30" means 30-60
        return { sql: `${col} BETWEEN ? AND ?`, params: [lo, hi] };
      }
      const cmp = { eq: '=', lt: '<', gt: '>', before: '<', after: '>' }[op];
      return { sql: `${col} ${cmp} ?`, params: [conv(value)] };
    }
    default:
      throw new SearchError('نوع فیلد نامعتبر است.');
  }
}

// query = { join: 'and' | 'or', rules: [{ field, op, value, value2 }] }
// Rules with an empty value are ignored. Returns { where, params } where `where` is '1' when no rules apply.
export const MAX_RULES = 6;

// The status switch above the rules. '' means every status.
export const STATUS_KEYS = ['active', 'pending', 'critical', 'archived'];
export const statusFilter = (v) => (typeof v === 'string' && STATUS_KEYS.includes(v) ? v : '');

export function buildWhere(query) {
  const join = query?.join === 'or' ? ' OR ' : ' AND ';
  const rules = Array.isArray(query?.rules) ? query.rules.slice(0, MAX_RULES) : [];
  const parts = [];
  const params = [];
  for (const rule of rules) {
    if (!rule || isBlank(rule.field) || isBlank(rule.value)) continue;
    const { sql, params: p } = ruleSql(rule);
    parts.push(`(${sql})`);
    params.push(...p);
  }
  const status = statusFilter(query?.status);
  if (status) {
    // The switch narrows the whole rule group, so the group is wrapped before it is ANDed.
    return { where: parts.length ? `(${parts.join(join)}) AND status = ?` : 'status = ?', params: [...params, status] };
  }
  return { where: parts.length ? parts.join(join) : '1', params };
}

// Reads the search form (GET query string: join, f1..f6, o1..o6, v1..v6, w1..w6) into a query object.
export function queryFromForm(q = {}) {
  const rules = [];
  for (let i = 1; i <= MAX_RULES; i++) {
    rules.push({ field: q[`f${i}`], op: q[`o${i}`], value: q[`v${i}`], value2: q[`w${i}`] });
  }
  return { join: q.join === 'or' ? 'or' : 'and', status: statusFilter(q.s), rules };
}
