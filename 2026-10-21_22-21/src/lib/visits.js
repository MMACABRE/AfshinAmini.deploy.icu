// Visit rules shared by the routes: form validation and the date ranges of /visits.
import * as jalaali from 'jalaali-js';
import { parseJalali, localDay } from './jalali.js';
import { normalizeText, toAsciiDigits } from './normalize.js';

export const VISIT_STATUSES = ['scheduled', 'done', 'cancelled'];

export const STATUS_LABEL_FA = { scheduled: 'برنامه‌ریزی‌شده', done: 'انجام‌شده', cancelled: 'لغو‌شده' };

export const DURATIONS = Array.from({ length: 12 }, (_, i) => (i + 1) * 5); // 5, 10, ... 60
export const DEFAULT_DURATION = 15;

const pad = (n) => String(n).padStart(2, '0');

// '09:30', '۹:۳۰', '9.30' -> '09:30'. Returns null when empty or not a 24 h time.
export function parseTime(input) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(toAsciiDigits(String(input ?? '')).trim());
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h > 23 || min > 59 ? null : `${pad(h)}:${m[2]}`;
}

// Form body -> { values, errors }. Date comes in as Jalali text, is stored as ISO.
export function validateVisit(body) {
  const errors = {};
  const date = parseJalali(body.visit_date);
  if (!date) errors.visit_date = 'تاریخ را به صورت ۱۴۰۳/۰۵/۱۲ وارد کنید.';
  const time = parseTime(body.visit_time);
  if (!time) errors.visit_time = 'ساعت را به صورت ۰۹:۳۰ وارد کنید.';
  // Only the lengths the form offers (5, 10, ... 60); a blank field means the default.
  const askedText = toAsciiDigits(String(body.duration_min ?? '')).trim();
  const duration = askedText === '' ? DEFAULT_DURATION : /^\d{1,2}$/.test(askedText) ? Number(askedText) : NaN;
  if (!DURATIONS.includes(duration)) errors.duration_min = 'مدت ویزیت باید بین ۵ تا ۶۰ دقیقه باشد.';
  const status = VISIT_STATUSES.includes(body.status) ? body.status : 'scheduled';
  return {
    errors,
    values: {
      visit_date: date, visit_time: time, duration_min: duration, status,
      reason: normalizeText(body.reason).slice(0, 200) || null,
      notes: normalizeText(body.notes).slice(0, 1000) || null,
    },
  };
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n));
}

// First and last ISO day of the Jalali month that contains `iso`, shifted by `offset` months.
function jalaliMonth(iso, offset = 0) {
  const [y, m, d] = iso.split('-').map(Number);
  let { jy, jm } = jalaali.toJalaali(y, m, d);
  jm += offset;
  if (jm > 12) { jm -= 12; jy += 1; }
  const iso2 = ({ gy, gm, gd }) => `${gy}-${pad(gm)}-${pad(gd)}`;
  return { from: iso2(jalaali.toGregorian(jy, jm, 1)), to: iso2(jalaali.toGregorian(jy, jm, jalaali.jalaaliMonthLength(jy, jm))) };
}

export const RANGES = {
  today: 'امروز', tomorrow: 'فردا', week: '۷ روز آینده', month: 'این ماه', nextmonth: 'ماه آینده', past: 'گذشته', all: 'همه',
};

// Name -> { from, to } (inclusive ISO days; null = open end) and sort direction. Unknown names mean "today".
export function rangeFor(name, today = localDay()) {
  switch (name) {
    case 'tomorrow': { const d = addDays(today, 1); return { name, from: d, to: d, desc: false }; }
    case 'week': return { name, from: today, to: addDays(today, 6), desc: false };
    case 'month': return { name, ...jalaliMonth(today), desc: false };
    case 'nextmonth': return { name, ...jalaliMonth(today, 1), desc: false };
    case 'past': return { name, from: null, to: addDays(today, -1), desc: true };
    case 'all': return { name, from: null, to: null, desc: false };
    default: return { name: 'today', from: today, to: today, desc: false };
  }
}

const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

// '09:30' + 45 -> '10:15'. Past midnight wraps ('23:50' + 30 -> '00:20').
export function endTime(time, duration) {
  const m = (toMinutes(time) + duration) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// Minutes since 1970-01-01 of an ISO day and a time, so spans that cross midnight compare correctly.
const absMinutes = (date, time) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 60000 + toMinutes(time);
};

// The one doctor sees one patient at a time: another visit whose time span meets [time, time + duration) is a clash,
// including a visit from the day before that runs past midnight. Cancelled visits free their slot. `excludeId` skips
// the visit being edited. Returns the clashing row or undefined.
export function findOverlap(db, { date, time, duration, excludeId = 0 }) {
  const start = absMinutes(date, time);
  const end = start + duration;
  return db.prepare(`SELECT v.id, v.visit_date, v.visit_time, v.duration_min, p.first_name, p.last_name FROM visits v JOIN patients p ON p.id = v.patient_id
                     WHERE v.visit_date BETWEEN ? AND ? AND v.status <> 'cancelled' AND v.id <> ? ORDER BY v.visit_date, v.visit_time`)
    .all(addDays(date, -1), addDays(date, 1), excludeId)
    .find((o) => { const s = absMinutes(o.visit_date, o.visit_time); return s < end && start < s + o.duration_min; });
}

export function overlapMessage(o) {
  return `این بازه با ویزیت ${o.first_name} ${o.last_name} (ساعت ${o.visit_time} تا ${endTime(o.visit_time, o.duration_min)}) هم‌پوشانی دارد.`.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
}
