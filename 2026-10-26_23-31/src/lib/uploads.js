// Upload rules (Plan.md D19): PDF, JPG, PNG and DICOM only, at most 30 MB, and the first bytes must
// match the extension. Files are never decoded or resized, only stored and served back.
import path from 'node:path';
import { faDigits } from './jalali.js';

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / 1024 / 1024;
export const HEAD_BYTES = 132; // enough to see "DICM" at offset 128

const EXT_TYPE = { '.pdf': 'pdf', '.jpg': 'jpg', '.jpeg': 'jpg', '.png': 'png', '.dcm': 'dcm' };

export const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', dcm: 'application/dicom' };

const starts = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);

// Returns 'pdf' | 'jpg' | 'png' | 'dcm' from the file's first bytes, or null.
export function detectType(head) {
  if (starts(head, [0x25, 0x50, 0x44, 0x46])) return 'pdf';                              // %PDF
  if (starts(head, [0xff, 0xd8, 0xff])) return 'jpg';
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (head.length >= 132 && starts(head, [0x44, 0x49, 0x43, 0x4d], 128)) return 'dcm';  // DICM
  return null;
}

// -> { ok: true, type } or { ok: false, error } with a Persian message.
export function checkUpload({ originalName, size, head }) {
  const ext = path.extname(String(originalName ?? '')).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    return { ok: false, error: 'فرمت HEIC پشتیبانی نمی‌شود. عکس را به JPG تبدیل کنید و دوباره بارگذاری کنید.' };
  }
  const expected = EXT_TYPE[ext];
  if (!expected) return { ok: false, error: 'فقط فایل‌های PDF، JPG، PNG و DCM مجاز است.' };
  if (!size) return { ok: false, error: 'فایل خالی است.' };
  if (size > MAX_UPLOAD_BYTES) return { ok: false, error: `حجم فایل بیش از ${faDigits(MAX_UPLOAD_MB)} مگابایت است.` };
  if (detectType(head) !== expected) return { ok: false, error: 'محتوای فایل با پسوند آن نمی‌خواند.' };
  return { ok: true, type: expected };
}
