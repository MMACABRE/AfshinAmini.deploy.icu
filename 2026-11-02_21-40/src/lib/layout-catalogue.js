// Form and custom-box catalogue shared by the layout modules: the cards, boxes, custom types and limits, plus the
// small helpers and the error type the readers use. No imports from the other layout modules.
export const CARDS = [
  { id: 'identity', label: 'هویت' },
  { id: 'visit', label: 'مراجعه' },
  { id: 'contact', label: 'تماس و نشانی' },
  { id: 'emergency', label: 'تماس اضطراری' },
  { id: 'insurance', label: 'بیمه' },
  { id: 'medical', label: 'اطلاعات پزشکی' },
];

// Built-in boxes in today's form order (views/patients/form.ejs). `full` boxes take the whole card width.
export const BOXES = [
  { id: 'first_name', label: 'نام', card: 'identity', full: false },
  { id: 'last_name', label: 'نام خانوادگی', card: 'identity', full: false },
  { id: 'father_name', label: 'نام پدر', card: 'identity', full: false },
  { id: 'national_id', label: 'کد ملی', card: 'identity', full: false },
  { id: 'birth_date', label: 'تاریخ تولد', card: 'identity', full: false },
  { id: 'sex', label: 'جنسیت', card: 'identity', full: false },
  { id: 'status', label: 'وضعیت', card: 'identity', full: false },
  { id: 'visit_reason', label: 'علت مراجعه', card: 'visit', full: true },
  { id: 'referral', label: 'معرف', card: 'visit', full: false },
  { id: 'phone', label: 'تلفن همراه', card: 'contact', full: false },
  { id: 'email', label: 'ایمیل', card: 'contact', full: false },
  { id: 'city', label: 'شهر', card: 'contact', full: false },
  { id: 'sms_optout', label: 'دریافت نکردن پیامک', card: 'contact', full: false },
  { id: 'address', label: 'نشانی', card: 'contact', full: true },
  { id: 'emergency_name', label: 'نام', card: 'emergency', full: false },
  { id: 'emergency_phone', label: 'تلفن', card: 'emergency', full: false },
  { id: 'emergency_relation', label: 'نسبت', card: 'emergency', full: false },
  { id: 'insurance_name', label: 'نوع بیمه', card: 'insurance', full: false },
  { id: 'insurance_number', label: 'شماره بیمه', card: 'insurance', full: false },
  { id: 'blood_type', label: 'گروه خونی', card: 'medical', full: false },
  { id: 'blood_pressure', label: 'فشار خون', card: 'medical', full: false },
  { id: 'height_cm', label: 'قد (سانتی‌متر)', card: 'medical', full: false },
  { id: 'weight_kg', label: 'وزن (کیلوگرم)', card: 'medical', full: false },
  { id: 'allergies', label: 'حساسیت‌ها', card: 'medical', full: true },
  { id: 'conditions', label: 'بیماری‌های زمینه‌ای', card: 'medical', full: true },
  { id: 'medical_notes', label: 'یادداشت‌های بالینی', card: 'medical', full: true },
];

export const CUSTOM_TYPES = [
  { id: 'short_text', label: 'متن کوتاه', full: false },
  { id: 'long_text', label: 'متن بلند', full: true },
  { id: 'number', label: 'عدد', full: false },
  { id: 'date', label: 'تاریخ', full: false },
  { id: 'choice', label: 'انتخاب از فهرست', full: false },
  { id: 'yes_no', label: 'بله / خیر', full: false },
];

export const LIMITS = {
  cards: 12, boxes: 80, json: 64 * 1024, cardLabel: 40, boxName: 60, shortText: 200, longText: 5000,
  choicesMin: 2, choicesMax: 30,
};

export const CUSTOM_TYPE_IDS = new Set(CUSTOM_TYPES.map((t) => t.id));

// Thrown by the strict pass; checkLayout turns it into the message the form shows.
export class Reject extends Error {}

// Length in characters (code points), so a Persian letter with a combining mark counts as one.
export const len = (s) => [...s].length;
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// True when the text has at least one character that is not whitespace or an invisible format mark (zero-width
// space, joiners, marks, word joiner, BOM). Names and labels must pass it; ZWNJ inside a word stays in the text.
const INVISIBLE_ONLY = /^[\s​-‏⁠﻿]*$/;
export const hasVisible = (s) => !INVISIBLE_ONLY.test(String(s));

export const BAD_SHAPE = 'شکل چیدمان درست نیست.';
