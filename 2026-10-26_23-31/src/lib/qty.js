// Quantities (D37). Stock and bill lines count pieces with up to two decimal places, such as 0.5 of an ampoule.
// SQLite keeps a whole number as INTEGER and a fraction as REAL in the same column, so no migration was needed.
// Every sum or difference goes through roundQty(), so float noise (0.1 + 0.2) never reaches a comparison or the screen.
import { toAsciiDigits } from './normalize.js';

export const MAX_QTY = 1_000_000;

export const roundQty = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A quantity typed in a form: '' -> null, junk -> NaN. Accepts Persian and Arabic digits and these decimal signs:
// '.', '٫', '/' (common in Persian typing) and a comma followed by one or two digits ('0,5'). A comma before
// exactly three digits is a thousands group ('1,000'). At most two decimal places.
export function parseQty(text, { allowZero = false } = {}) {
  let s = toAsciiDigits(String(text ?? '')).replace(/[٬\s]/g, '');
  if (!s) return null;
  if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(/^(\d*)[.٫/,،](\d+)$/, '$1.$2');
  if (!/^(\d{1,7}(\.\d{1,2})?|\.\d{1,2})$/.test(s)) return Number.NaN;
  const n = roundQty(Number(s));
  return (allowZero ? n >= 0 : n > 0) && n <= MAX_QTY ? n : Number.NaN;
}

// For CSV exports: plain Latin digits and '.', no float noise.
export const qtyText = (n) => String(roundQty(n));
