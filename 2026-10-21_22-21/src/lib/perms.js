// Per-user permissions (D25). Each area has a level: 0 none, 1 view, 2 edit. Flags allow single dangerous actions.
// A user's permissions are stored as JSON in users.perms and always pass through parsePerms, so a damaged or
// hand-edited value can only ever give less, never more. The owner (users.is_owner) always has everything.

export const NONE = 0;
export const VIEW = 1;
export const EDIT = 2;

export const AREAS = ['patients', 'documents', 'visits', 'storage', 'finance', 'pdf', 'data', 'users'];
// Highest level each area can have; pdf, data and users have view only (their dangerous parts are flags).
export const AREA_MAX = { patients: EDIT, documents: EDIT, visits: EDIT, storage: EDIT, finance: EDIT, pdf: VIEW, data: VIEW, users: VIEW };

// flag -> [area, level that area needs for the flag to count]
export const FLAGS = {
  patient_delete: ['patients', EDIT],
  document_delete: ['documents', EDIT],
  full_zip: ['data', VIEW],
  csv_import: ['data', VIEW],
  manage_users: ['users', VIEW],
  audit_log: ['users', VIEW],
  stock_adjust: ['storage', EDIT],
  finance_settings: ['finance', EDIT],
  price_override: ['finance', EDIT],
};

export const AREA_LABELS = {
  patients: 'بیماران', documents: 'مدارک', visits: 'ویزیت‌ها', storage: 'انبار',
  finance: 'امور مالی', pdf: 'فرم‌های چاپی', data: 'داده‌ها', users: 'کاربران',
};
export const LEVEL_LABELS = ['بدون دسترسی', 'مشاهده', 'ویرایش'];
export const FLAG_LABELS = {
  patient_delete: 'حذف بیمار',
  document_delete: 'حذف مدرک',
  full_zip: 'دریافت فایل کامل (zip)',
  csv_import: 'ورود بیماران از CSV',
  manage_users: 'مدیریت کاربران و دسترسی‌ها',
  audit_log: 'گزارش رویدادها',
  stock_adjust: 'اصلاح موجودی و ضایعات',
  finance_settings: 'تنظیمات مالی و قیمت‌ها',
  price_override: 'تغییر قیمت در صورتحساب',
};

const all = () => ({
  ...Object.fromEntries(AREAS.map((a) => [a, AREA_MAX[a]])),
  flags: Object.keys(FLAGS),
});

export const PRESETS = {
  admin: { label: 'مدیر', perms: all() },
  staff: {
    label: 'کارمند',
    perms: { patients: EDIT, documents: EDIT, visits: EDIT, storage: VIEW, finance: NONE, pdf: VIEW, data: NONE, users: NONE, flags: ['document_delete'] },
  },
};

// Any input (JSON text, object, junk) to a clean permission object.
export function parsePerms(input) {
  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const out = {};
  for (const a of AREAS) {
    const v = raw[a];
    out[a] = Number.isInteger(v) && v >= NONE && v <= AREA_MAX[a] ? v : NONE;
  }
  const flags = Array.isArray(raw.flags) ? raw.flags : [];
  out.flags = Object.keys(FLAGS).filter((f) => flags.includes(f) && out[FLAGS[f][0]] >= FLAGS[f][1]);
  return out;
}

export const ownerPerms = () => parsePerms(all());

// Reads the permission form (area radios named "a_<area>", flag checkboxes named "f_<flag>").
export function permsFromForm(body) {
  const raw = { flags: [] };
  for (const a of AREAS) raw[a] = Number(body[`a_${a}`]);
  for (const f of Object.keys(FLAGS)) if (body[`f_${f}`] === '1') raw.flags.push(f);
  return parsePerms(raw);
}

export const can = (user, area, level = VIEW) => Boolean(user?.perms && user.perms[area] >= level);
export const has = (user, flag) => Boolean(user?.perms?.flags.includes(flag));

// Short text for the audit log: "patients=2 documents=1 … +patient_delete".
export const describePerms = (p) => [...AREAS.map((a) => `${a}=${p[a]}`), ...p.flags.map((f) => `+${f}`)].join(' ');

// The preset whose contents equal p, or null (shown as «سفارشی» in the user list).
export function presetOf(p) {
  const key = describePerms(p);
  return Object.keys(PRESETS).find((k) => describePerms(parsePerms(PRESETS[k].perms)) === key) ?? null;
}

// «مالک», a preset's name, or «سفارشی».
export const roleLabel = (owner, p) => (owner ? 'مالک' : PRESETS[presetOf(p)]?.label ?? 'سفارشی');
