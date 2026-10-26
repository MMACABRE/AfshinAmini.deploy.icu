// Money (D28). Amounts are stored as whole Rial integers and shown in the site-wide display currency:
// 'T' (Toman = Rial / 10) or 'R'. Display: Latin digits, comma groups, no decimals, suffix: `1,250,000 T`.
import { toAsciiDigits } from './normalize.js';

export const CURRENCIES = { T: 'تومان', R: 'ریال' };
const MAX_RIAL = 1e14; // far beyond any clinic bill; keeps every sum a safe integer

// Rial -> display text. Toman rounds half away from zero, so -5 Rial shows as -1 T.
export function formatMoney(rial, cur = 'T') {
  const n = Number(rial) || 0;
  const shown = cur === 'R' ? n : Math.sign(n) * Math.round(Math.abs(n) / 10);
  return `${shown.toLocaleString('en-US')} ${cur === 'R' ? 'R' : 'T'}`;
}

// Rial -> the number a form field shows in the display currency ("1250000"), '' for null.
export function moneyInput(rial, cur = 'T') {
  if (rial === null || rial === undefined || rial === '') return '';
  return String(cur === 'R' ? rial : Math.round(rial / 10));
}

// User text -> Rial integer, or null when empty or not a whole non-negative amount. Accepts Persian and Arabic
// digits, comma and space groups, Persian thousands separators, and a trailing T/R/تومان/ریال. A suffix wins over
// the display currency, so "50000 R" means Rial even on a Toman site.
export function parseMoney(text, cur = 'T') {
  let s = toAsciiDigits(String(text ?? '')).replace(/[,،٬\s]/g, '').trim();
  if (!s) return null;
  let unit = cur;
  const m = /^(\d+)(t|r|تومان|ریال)?$/i.exec(s);
  if (!m) return null;
  s = m[1];
  if (m[2]) unit = /^(t|تومان)$/i.test(m[2]) ? 'T' : 'R';
  const n = Number(s) * (unit === 'R' ? 1 : 10);
  return Number.isSafeInteger(n) && n <= MAX_RIAL ? n : null;
}

// A discount as typed: amount (in the display currency) or percent 0-100. Returns { kind, value } or null for none,
// or { error } when it is not valid.
export function parseDiscount(kind, text, cur = 'T') {
  const raw = String(text ?? '').trim();
  if (!raw || raw === '0') return null;
  if (kind === 'percent') {
    const p = Number(toAsciiDigits(raw).replace(/[%٪\s]/g, ''));
    return Number.isInteger(p) && p >= 0 && p <= 100 ? (p ? { kind: 'percent', value: p } : null) : { error: 'درصد تخفیف باید عددی صحیح از ۰ تا ۱۰۰ باشد.' };
  }
  const rial = parseMoney(raw, cur);
  return rial === null ? { error: 'مبلغ تخفیف درست نیست.' } : rial ? { kind: 'amount', value: rial } : null;
}

// How much a discount takes off `gross` (Rial). Percent rounds to whole Rial; never more than gross.
export function discountOf(gross, kind, value) {
  if (!kind || !value || gross <= 0) return 0;
  const d = kind === 'percent' ? Math.round((gross * value) / 100) : value;
  return Math.min(Math.max(d, 0), gross);
}

// Short text for a discount, e.g. "۱۰٪" or "50,000 T".
export const describeDiscount = (kind, value, cur = 'T') =>
  !kind || !value ? '' : kind === 'percent' ? `${value}٪` : formatMoney(value, cur);
