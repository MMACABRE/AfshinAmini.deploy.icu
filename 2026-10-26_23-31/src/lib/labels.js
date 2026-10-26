// Persian labels and chip styles shared by the views.
export const STATUS = {
  active:   { label: 'فعال',        chip: 'chip-ok' },
  pending:  { label: 'در انتظار',    chip: 'chip-warn' },
  critical: { label: 'بحرانی',       chip: 'chip-crit' },
  archived: { label: 'بایگانی‌شده',   chip: 'chip-mute' },
};

export { LEADS } from './sms-rules.js';
export const SEX = { female: 'زن', male: 'مرد' };

export const CATEGORY = {
  consent: 'رضایت‌نامه', lab: 'آزمایش', imaging: 'تصویربرداری', surgery: 'جراحی', other: 'سایر',
};

// Persian names for audit_log.action values (shown on /admin/audit).
export const AUDIT_ACTIONS = {
  login: 'ورود', logout: 'خروج', login_failed: 'ورود ناموفق', login_locked: 'ورود مسدودشده',
  patient_create: 'ثبت بیمار', patient_edit: 'ویرایش بیمار', patient_archive: 'بایگانی بیمار',
  patient_unarchive: 'خارج‌کردن از بایگانی', patient_delete: 'حذف بیمار', patient_code: 'تغییر کد بیمار', patient_import: 'ورود بیماران از CSV',
  medication_add: 'افزودن دارو', medication_remove: 'حذف دارو',
  visit_add: 'ثبت ویزیت', visit_edit: 'ویرایش ویزیت', visit_status: 'تغییر وضعیت ویزیت', visit_delete: 'حذف ویزیت',
  document_upload: 'بارگذاری سند', document_edit: 'ویرایش سند', document_download: 'دریافت سند', document_delete: 'حذف سند',
  photo_set: 'تنظیم عکس بیمار', photo_remove: 'برداشتن عکس بیمار',
  export_search: 'خروجی نتیجه‌ی جستجو', export_patients: 'خروجی فهرست بیماران', export_full: 'دریافت فایل کامل',
  user_create: 'ساخت کاربر', user_deactivate: 'غیرفعال‌کردن کاربر', user_activate: 'فعال‌کردن کاربر', user_delete: 'حذف کاربر',
  user_password_reset: 'تنظیم رمز کاربر', password_change: 'تغییر رمز', user_perms: 'تغییر دسترسی کاربر',
  visit_note: 'ثبت شرح پزشک',
  catalog_add: 'افزودن به فهرست قیمت', catalog_edit: 'ویرایش فهرست قیمت', catalog_delete: 'حذف از فهرست قیمت',
  stock_in: 'ورود کالا', stock_count: 'اصلاح شمارش انبار', stock_waste: 'ثبت ضایعات', stock_move_delete: 'حذف ردیف گردش کالا',
  data_wipe: 'حذف داده‌ها',
  bill_line_add: 'افزودن به صورتحساب', bill_line_delete: 'حذف از صورتحساب', bill_discount: 'تخفیف صورتحساب',
  price_override: 'تغییر قیمت در صورتحساب', patient_discount: 'تخفیف دائمی بیمار',
  payment_add: 'ثبت پرداخت', payment_edit: 'ویرایش پرداخت', payment_delete: 'حذف پرداخت',
  payment_refund: 'بازپرداخت', payment_move: 'انتقال اعتبار',
  finance_settings: 'تغییر تنظیمات مالی', print: 'دریافت فرم چاپی',
  sms_settings: 'تغییر تنظیمات پیامک', sms_key_set: 'ثبت کلید پیامک', sms_key_remove: 'حذف کلید پیامک', sms_test: 'پیامک آزمایشی',
  sms_send: 'ارسال پیامک', sms_bulk: 'ارسال پیامک گروهی', sms_retry: 'ارسال دوباره‌ی پیامک',
};
