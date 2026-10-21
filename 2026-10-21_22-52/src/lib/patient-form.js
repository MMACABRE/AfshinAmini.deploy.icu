// Validates and normalizes the patient form. Returns { values, errors }.
// `values` holds database-ready strings or numbers (empty becomes null); `errors` maps a field to a Persian message.
import { normalizeText } from './normalize.js';
import { parseJalali, localDay } from './jalali.js';

export const STATUSES = ['active', 'pending', 'critical', 'archived'];
export const SEXES = ['female', 'male'];
export const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const TEXT_FIELDS = {
  city: 100, emergency_name: 100, emergency_relation: 60, insurance_name: 100, insurance_number: 60,
  blood_pressure: 20, referral: 120,
};
const LONG_TEXT_FIELDS = { address: 2000, medical_notes: 5000, visit_reason: 1000 };

export function validatePatient(body = {}) {
  const errors = {};
  const get = (k) => normalizeText(body[k] ?? '');
  const values = {};

  for (const [field, label] of [['first_name', 'نام'], ['last_name', 'نام خانوادگی']]) {
    const v = get(field);
    if (!v) errors[field] = `${label} را وارد کنید.`;
    else if (v.length > 80) errors[field] = `${label} بیش از حد طولانی است.`;
    values[field] = v;
  }

  const nid = get('national_id');
  if (nid && !/^\d{10}$/.test(nid)) errors.national_id = 'کد ملی باید ۱۰ رقم باشد.';
  values.national_id = nid || null;

  for (const field of ['phone', 'emergency_phone']) {
    const v = get(field).replace(/[\s-]/g, '');
    if (v && !/^\+?\d{7,15}$/.test(v)) errors[field] = 'شماره تلفن معتبر نیست.';
    values[field] = v || null;
  }

  const email = get('email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'نشانی ایمیل معتبر نیست.';
  values.email = email || null;

  const rawDate = get('birth_date');
  if (rawDate) {
    const iso = parseJalali(rawDate);
    if (!iso) errors.birth_date = 'تاریخ را به شکل ۱۴۰۳/۰۵/۱۲ وارد کنید.';
    else if (iso > localDay()) errors.birth_date = 'تاریخ تولد نمی‌تواند در آینده باشد.';
    values.birth_date = iso;
  } else {
    values.birth_date = null;
  }

  const sex = get('sex');
  if (sex && !SEXES.includes(sex)) errors.sex = 'جنسیت نامعتبر است.';
  values.sex = sex || null;

  const status = get('status') || 'active';
  if (!STATUSES.includes(status)) errors.status = 'وضعیت نامعتبر است.';
  values.status = status;

  const blood = get('blood_type');
  if (blood && !BLOOD_TYPES.includes(blood)) errors.blood_type = 'گروه خونی نامعتبر است.';
  values.blood_type = blood || null;

  for (const [field, label, min, max] of [['height_cm', 'قد', 30, 250], ['weight_kg', 'وزن', 1, 500]]) {
    // Plain decimals only ("172", "68.5", "68٫5"); Number() alone would also accept "0x64" or "1e2".
    const raw = get(field).replace(/[٫,]/g, '.');
    const n = /^\d{1,3}(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
    if (raw && !(Number.isFinite(n) && n >= min && n <= max)) errors[field] = `${label} باید عددی بین ${min} و ${max} باشد.`;
    values[field] = raw && !errors[field] ? n : null;
  }

  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    const v = get(field);
    if (v.length > max) errors[field] = 'متن بیش از حد طولانی است.';
    values[field] = v || null;
  }
  for (const [field, max] of Object.entries(LONG_TEXT_FIELDS)) {
    const v = get(field);
    if (v.length > max) errors[field] = 'متن بیش از حد طولانی است.';
    values[field] = v || null;
  }

  for (const field of ['allergies', 'conditions']) {
    const items = get(field).split(/[,،]/).map((s) => s.trim()).filter(Boolean);
    const joined = items.join(', ');
    if (joined.length > 1000) errors[field] = 'فهرست بیش از حد طولانی است.';
    values[field] = joined || null;
  }

  return { values, errors };
}
