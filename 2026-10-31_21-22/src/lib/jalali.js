// Jalali <-> ISO Gregorian. The database stores 'YYYY-MM-DD' Gregorian; users see and type Jalali.
import * as jalaali from 'jalaali-js';
import { toAsciiDigits } from './normalize.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');

// '1403/05/12', '۱۴۰۳-۵-۱۲', '1403.05.12' -> '2024-08-02'. Returns null when empty or invalid.
export function parseJalali(input) {
  const s = toAsciiDigits(String(input ?? '')).trim();
  const m = /^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/.exec(s);
  if (!m) return null;
  const [jy, jm, jd] = m.slice(1).map(Number);
  // 1200-1600 (Gregorian 1821-2222), the same range as the date picker in public/js/jalali-math.js. Anything
  // else is a typo or a Gregorian date typed by mistake (2024-08-02 would otherwise become 2645-10-24).
  if (jy < 1200 || jy > 1600 || !jalaali.isValidJalaaliDate(jy, jm, jd)) return null;
  const { gy, gm, gd } = jalaali.toGregorian(jy, jm, jd);
  return `${gy}-${pad(gm)}-${pad(gd)}`;
}

function isoParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? m.slice(1).map(Number) : null;
}

// '2024-08-02' -> '1403/05/12' (ASCII digits, for form inputs).
export function toJalaliInput(iso) {
  const p = isoParts(iso);
  if (!p) return '';
  const { jy, jm, jd } = jalaali.toJalaali(p[0], p[1], p[2]);
  return `${jy}/${pad(jm)}/${pad(jd)}`;
}

// '2024-08-02' -> '۱۲ مرداد ۱۴۰۳' (style 'long') or '۱۴۰۳/۰۵/۱۲' (style 'short').
export function formatJalali(iso, style = 'long') {
  const p = isoParts(iso);
  if (!p) return '';
  const date = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  const opts = style === 'short'
    ? { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }
    : { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', opts).format(date);
}

// 'YYYY-MM-DD' of a moment (Date or ISO timestamp) in the server's local time zone (TZ=Asia/Tehran in Docker).
// Use this, not toISOString().slice(0, 10), which is the UTC day and is one day behind from 00:00 to 03:30 in Tehran.
// A plain date ('2024-08-02') is already a day and is returned unchanged.
export function localDay(ts = new Date()) {
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Full years between an ISO birth date and today (or `today`, ISO).
export function ageFrom(iso, today = localDay()) {
  const b = isoParts(iso);
  const t = isoParts(today);
  if (!b || !t) return null;
  let age = t[0] - b[0];
  if (t[1] < b[1] || (t[1] === b[1] && t[2] < b[2])) age -= 1;
  return age;
}

// Persian digits for display of any number or string. A dot between digits becomes the Persian decimal sign,
// so a fractional quantity shows as ۰٫۵.
export function faDigits(s) {
  return String(s ?? '').replace(/(\d)\.(?=\d)/g, '$1٫').replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

// '2026-10-16T08:15:00Z' -> '۱۴۰۵/۰۷/۲۴ ۱۱:۴۵' in Tehran time.
export function formatJalaliDateTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tehran' };
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', opts).format(d).replace(/[،,]/g, '');
}

// ---- Day arithmetic on ISO dates (finance reports) -------------------------------
const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export function addDays(iso, n) {
  const p = isoParts(iso);
  return isoOf(new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)));
}

// The Saturday that starts the Iranian week holding `iso`.
export function weekStart(iso) {
  const p = isoParts(iso);
  const dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); // 0 Sunday … 6 Saturday
  return addDays(iso, -((dow + 1) % 7));
}

// First and last ISO day of the Jalali month holding `iso`; `shift` moves that many months (-1 = the month before).
export function jalaliMonth(iso, shift = 0) {
  const p = isoParts(iso);
  const j = jalaali.toJalaali(p[0], p[1], p[2]);
  let jy = j.jy;
  let jm = j.jm + shift;
  while (jm < 1) { jm += 12; jy -= 1; }
  while (jm > 12) { jm -= 12; jy += 1; }
  const first = jalaali.toGregorian(jy, jm, 1);
  const last = jalaali.toGregorian(jy, jm, jalaali.jalaaliMonthLength(jy, jm));
  const iso2 = (g) => `${g.gy}-${pad(g.gm)}-${pad(g.gd)}`;
  return { from: iso2(first), to: iso2(last), jy, jm };
}

export const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

// '2026-10-20' -> { weekday: 'سه‌شنبه', day: '۲۸', month: 'مهر', year: '۱۴۰۵' } for date headers.
export function dayParts(iso) {
  const p = isoParts(iso);
  if (!p) return { weekday: '', day: '', month: '', year: '' };
  const date = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  const parts = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).formatToParts(date);
  const get = (t) => parts.find((x) => x.type === t)?.value ?? '';
  return { weekday: get('weekday'), day: get('day'), month: get('month'), year: get('year') };
}
