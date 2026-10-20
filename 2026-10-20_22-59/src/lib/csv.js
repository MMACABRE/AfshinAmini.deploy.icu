// CSV for patient exports and imports. Exports are UTF-8 with a BOM so Excel shows Persian correctly.
import { parse } from 'csv-parse/sync';
import { STATUS, SEX } from './labels.js';
import { toJalaliInput, localDay } from './jalali.js';
import { normalizeText, faKey, toAsciiDigits } from './normalize.js';

export const BOM = '﻿';

// field -> Persian header. The same table is used for export, the import template and import parsing.
export const COLUMNS = [
  ['code', 'کد بیمار'],
  ['national_id', 'کد ملی'],
  ['first_name', 'نام'],
  ['last_name', 'نام خانوادگی'],
  ['birth_date', 'تاریخ تولد'],
  ['sex', 'جنسیت'],
  ['phone', 'تلفن'],
  ['email', 'ایمیل'],
  ['address', 'نشانی'],
  ['city', 'شهر'],
  ['emergency_name', 'نام تماس اضطراری'],
  ['emergency_phone', 'تلفن تماس اضطراری'],
  ['emergency_relation', 'نسبت تماس اضطراری'],
  ['insurance_name', 'بیمه'],
  ['insurance_number', 'شماره بیمه'],
  ['status', 'وضعیت'],
  ['visit_reason', 'علت مراجعه'],
  ['referral', 'معرف'],
  ['blood_type', 'گروه خونی'],
  ['allergies', 'حساسیت‌ها'],
  ['conditions', 'بیماری‌ها'],
  ['medical_notes', 'یادداشت پزشکی'],
  ['height_cm', 'قد (سانتی‌متر)'],
  ['weight_kg', 'وزن (کیلوگرم)'],
  ['blood_pressure', 'فشار خون'],
  ['updated_at', 'آخرین تغییر'],
];

// Columns that make up the downloadable import template.
export const TEMPLATE_FIELDS = ['national_id', 'first_name', 'last_name', 'birth_date', 'sex', 'phone', 'city', 'allergies', 'conditions'];

const headerOf = Object.fromEntries(COLUMNS);

// Spreadsheet programs run text that starts with = + - @ as a formula. Prefix such cells with an
// apostrophe, but leave plain numbers and phone numbers alone.
function safeCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d[\d\s.\-]*$/.test(s)) return `'${s}`;
  return s;
}

function quote(s) {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map((h) => quote(safeCell(h))).join(',')];
  for (const row of rows) lines.push(row.map((c) => quote(safeCell(c))).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

// A patient database row as the display values used in CSV (Jalali date, Persian sex and status).
function cell(field, row) {
  const v = row[field];
  if (v === null || v === undefined) return '';
  if (field === 'birth_date') return toJalaliInput(v);
  if (field === 'updated_at') return toJalaliInput(localDay(v));
  if (field === 'sex') return SEX[v] ?? v;
  if (field === 'status') return STATUS[v]?.label ?? v;
  return v;
}

// Patient rows as display headers and cells; shared by the CSV and the Excel export.
export function patientTable(rows, extra = []) {
  const fields = COLUMNS.map(([f]) => f);
  return {
    headers: [...COLUMNS.map(([, h]) => h), ...extra.map(([, h]) => h)],
    rows: rows.map((r) => [...fields.map((f) => cell(f, r)), ...extra.map(([k]) => r[k] ?? '')]),
  };
}

export function patientsCsv(rows, extra = []) {
  const t = patientTable(rows, extra);
  return toCsv(t.headers, t.rows);
}

export function templateCsv() {
  return toCsv(TEMPLATE_FIELDS.map((f) => headerOf[f]), [
    ['0012345678', 'سارا', 'احمدی', '1368/04/12', 'زن', '09121234567', 'تهران', 'پنی‌سیلین', 'دیابت'],
  ]);
}

// ---- import ----

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 5000;

const fieldOfHeader = new Map([
  ...COLUMNS.map(([f, h]) => [faKey(h), f]),
  ...COLUMNS.map(([f]) => [faKey(f), f]), // English field names also work
]);
const skipOnImport = new Set(['code', 'updated_at']);

const reverse = (labels) => new Map(Object.entries(labels).flatMap(([k, v]) => [[faKey(k), k], [faKey(typeof v === 'string' ? v : v.label), k]]));
const SEX_IN = reverse(SEX);
const STATUS_IN = reverse(STATUS);

export class CsvError extends Error {}

// Excel reads 0012345678 and 09121234567 as numbers and saves them as 12345678 and 9121234567. National IDs
// are always 10 digits and every domestic Iranian phone number starts with 0, so the lost zeros can be put back.
// Only these exact shapes are touched: a 7-digit ID is a typo and is still refused by validatePatient().
function restoreLeadingZeros(body) {
  const digits = (v) => toAsciiDigits(String(v ?? '')).trim();
  const nid = digits(body.national_id);
  if (/^\d{8,9}$/.test(nid)) body.national_id = nid.padStart(10, '0');
  for (const field of ['phone', 'emergency_phone']) {
    const phone = digits(body[field]);
    if (/^[1-9]\d{9}$/.test(phone)) body[field] = `0${phone}`;
  }
}

// -> [{ line, body }] where `body` has patient form field names, ready for validatePatient().
// The delimiter is the one used in the header line (Excel writes ';' or tab in some locales). Only that one
// splits cells, so a ';' inside an address in a comma file stays part of the text.
function detectDelimiter(buffer) {
  const head = buffer.subarray(0, 4096).toString('utf8').split(/\r?\n/)[0];
  return [',', ';', '\t'].map((d) => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
}

export function parsePatientCsv(buffer) {
  let records;
  let duplicate = null;
  try {
    records = parse(buffer, {
      bom: true, skip_empty_lines: true, relax_column_count: true, trim: true, info: true,
      delimiter: detectDelimiter(buffer), max_record_size: 100_000,
      columns: (header) => {
        const fields = header.map((x) => fieldOfHeader.get(faKey(x)) ?? null);
        duplicate = header.find((x, i) => fields[i] && fields.indexOf(fields[i]) !== i) ?? null;
        return fields;
      },
    });
  } catch {
    throw new CsvError('فایل CSV خوانده نشد. فایل را با الگوی سامانه بسازید و با کدگذاری UTF-8 ذخیره کنید.');
  }
  if (duplicate !== null) throw new CsvError(`ستون «${String(duplicate).slice(0, 40)}» دو بار آمده است. هر ستون فقط یک بار مجاز است.`);
  if (records.length > MAX_CSV_ROWS) throw new CsvError(`حداکثر ${MAX_CSV_ROWS} ردیف در هر بار ورود مجاز است.`);
  // Rows that hold only delimiters (spreadsheets often add ",,,,") are not records.
  return records.filter(({ record }) => Object.values(record).some((v) => String(v ?? '').trim() !== '')).map(({ record, info }) => {
    const body = {};
    for (const [field, raw] of Object.entries(record)) {
      if (!field || skipOnImport.has(field)) continue;
      // Undo the formula guard of safeCell(), so an exported file imports back unchanged.
      body[field] = typeof raw === 'string' && /^'[=+\-@]/.test(raw) ? raw.slice(1) : raw;
    }
    restoreLeadingZeros(body);
    if (body.sex) body.sex = SEX_IN.get(faKey(normalizeText(body.sex))) ?? body.sex;
    if (body.status) body.status = STATUS_IN.get(faKey(normalizeText(body.status))) ?? body.status;
    return { line: info.lines, body }; // the file line where this record ends; line 1 is the header
  });
}
