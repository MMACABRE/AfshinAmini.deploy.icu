// Persian text and digit normalization.
// Apply normalizeText() to every user-entered text field before saving,
// and faKey() (also registered in SQLite as fa_key) when comparing for search.

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function toAsciiDigits(s) {
  return String(s).replace(/[۰-۹٠-٩]/g, (d) => {
    const i = FA_DIGITS.indexOf(d);
    return String(i >= 0 ? i : AR_DIGITS.indexOf(d));
  });
}

// For storage: Arabic letter forms to Persian, ASCII digits, no tatweel, tidy spaces.
export function normalizeText(s) {
  if (s === null || s === undefined) return '';
  return toAsciiDigits(String(s).normalize('NFC'))
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ـ/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// For comparison only: also ignores zero-width non-joiners, spaces and case, and folds Arabic letter
// forms that Persian keyboards rarely type (ة أ إ ٱ ؤ), so "فاطمة" finds "فاطمه".
export function faKey(s) {
  return normalizeText(s).replace(/[‌\s]+/g, '').replace(/ة/g, 'ه').replace(/[أإٱ]/g, 'ا').replace(/ؤ/g, 'و')
    .toLowerCase();
}

// Escape user text for use inside LIKE '%...%' with ESCAPE '\'.
export function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}
