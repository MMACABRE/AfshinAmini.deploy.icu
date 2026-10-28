// Pure SMS rules (D32+): mobile numbers, message wording, SMS parts, when a reminder is due. No database, no network.
import { toAsciiDigits } from './normalize.js';
import { dayParts, faDigits } from './jalali.js';

// ---- mobile numbers ----

// '0912 345 6789', '+98 912 345 6789', '۹۱۲۳۴۵۶۷۸۹' -> '09123456789'. Anything that is not an Iranian mobile -> null.
export function normalizeMobile(input) {
  let s = toAsciiDigits(String(input ?? '')).replace(/[\s\-()]/g, '');
  if (s.startsWith('+98')) s = `0${s.slice(3)}`;
  else if (s.startsWith('0098')) s = `0${s.slice(4)}`;
  else if (/^98\d{10}$/.test(s)) s = `0${s.slice(2)}`;
  else if (/^9\d{9}$/.test(s)) s = `0${s}`;
  return /^09\d{9}$/.test(s) ? s : null;
}

// ---- wording ----

export const TOKENS = { 'نام': 'name', 'تاریخ': 'date', 'ساعت': 'time' };
export const TEMPLATE_MAX = 300;
export const MESSAGE_MAX = 500;
// Provisional wording until the owner settles it (map note: deferred). The clinic edits it in the SMS settings.
export const DEFAULT_TEMPLATE = '{نام} عزیز، نوبت شما {تاریخ} ساعت {ساعت} ثبت شده است.';

// Text typed by a person: line breaks kept, other control characters dropped.
export function cleanText(input) {
  return toAsciiDigitsKeep(String(input ?? '')).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F‎‏‪-‮⁦-⁩]/g, '').trim();
}
// Digits stay as typed (the clinic may write Persian digits); only the Arabic letters are unified, like everywhere else.
function toAsciiDigitsKeep(s) {
  return s.replace(/ي/g, 'ی').replace(/ك/g, 'ک');
}

// Returns { text, error }. A reminder must say when, so {تاریخ} and {ساعت} are both required; any other {...} is refused.
export function validateTemplate(input) {
  const text = cleanText(input);
  if (!text) return { text, error: 'متن پیامک را وارد کنید.' };
  if (Array.from(text).length > TEMPLATE_MAX) return { text, error: `متن پیامک نباید بیش از ${faDigits(TEMPLATE_MAX)} نویسه باشد.` };
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!Object.hasOwn(TOKENS, m[1])) return { text, error: `«{${m[1]}}» شناخته‌شده نیست. فقط {نام}، {تاریخ} و {ساعت} مجاز است.` };
  }
  if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ''))) return { text, error: 'آکولاد باز یا بسته‌ی بی‌جفت در متن هست.' };
  if (!text.includes('{تاریخ}') || !text.includes('{ساعت}')) return { text, error: 'متن یادآوری باید {تاریخ} و {ساعت} را داشته باشد.' };
  return { text, error: null };
}

const NO_JOIN = /[رزژدذوا]$/; // letters that do not connect to the next one: «مهرماه», but «آبان‌ماه»

// '2026-10-22' -> 'پنجشنبه ۳۰ام مهرماه' (Persian digits).
export function visitDateText(iso) {
  const p = dayParts(iso);
  return `${p.weekday} ${p.day}ام ${p.month}${NO_JOIN.test(p.month) ? '' : '‌'}ماه`;
}

// '09:10' -> '۹:۱۰'
export function visitTimeText(time) {
  const [h, m] = String(time).split(':');
  return faDigits(`${Number(h)}:${m}`);
}

// Fills the blanks. `vars` = { name, date, time } as text. Result is capped, never longer than the provider takes.
export function renderTemplate(template, vars) {
  const out = String(template).replace(/\{([^{}]*)\}/g, (all, key) => (Object.hasOwn(TOKENS, key) ? String(vars[TOKENS[key]] ?? '') : all));
  return cleanText(out).slice(0, MESSAGE_MAX);
}

// Persian text goes out as UCS-2: 70 characters in one part, 67 in each part of a longer message.
export function smsParts(text) {
  const n = Array.from(String(text)).length;
  return n === 0 ? 0 : n <= 70 ? 1 : Math.ceil(n / 67);
}

// ---- when a reminder goes out ----

export const LEADS = { none: 'بدون یادآوری', now: 'همین الان', h2: '۲ ساعت قبل', d1: '۱ روز قبل', d2: '۲ روز قبل' };
export const LEAD_KEYS = Object.keys(LEADS);
export const WINDOW_START = 8 * 60;  // 08:00
export const WINDOW_END = 21 * 60;   // 21:00, inclusive

export const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();
export const inWindow = (d) => minutesOfDay(d) >= WINDOW_START && minutesOfDay(d) <= WINDOW_END;

// Server local time (TZ=Asia/Tehran in Docker), like every other date in the app.
export function visitStart(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, Number(time.slice(0, 2)), Number(time.slice(3, 5)));
}

// A time before 08:00 moves to 21:00 the evening before; one after 21:00 moves back to 21:00 the same day.
export function pullIntoWindow(d) {
  const m = minutesOfDay(d);
  if (m >= WINDOW_START && m <= WINDOW_END) return d;
  const x = new Date(d);
  if (m < WINDOW_START) x.setDate(x.getDate() - 1);
  x.setHours(21, 0, 0, 0);
  return x;
}

// Send hour setting: a whole hour inside the window, else 17.
export const sendHourOf = (v) => (Number.isInteger(Number(v)) && Number(v) >= 8 && Number(v) <= 21 ? Number(v) : 17);

// The moment a reminder is meant to go out; null for «none». Whether it may go out *now* is a separate check (inWindow).
export function reminderDue(lead, visit, { sendHour = 17, now = new Date() } = {}) {
  if (lead === 'none' || !LEAD_KEYS.includes(lead)) return null;
  if (lead === 'now') return now;
  const start = visitStart(visit.visit_date, visit.visit_time);
  if (lead === 'h2') return pullIntoWindow(new Date(start.getTime() - 2 * 3600 * 1000));
  const days = lead === 'd2' ? 2 : 1;
  const [y, m, d] = visit.visit_date.split('-').map(Number);
  return new Date(y, m - 1, d - days, sendHourOf(sendHour), 0, 0, 0);
}
