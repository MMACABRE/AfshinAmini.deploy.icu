// SMS settings form (D32+): validation, and the number shown before SMS is switched on.
import { toAsciiDigits } from './normalize.js';
import { localDay } from './jalali.js';
import { LEAD_KEYS, validateTemplate, normalizeMobile } from './sms-rules.js';

export const SENDER_LINE = /^[A-Za-z0-9]{3,20}$/;

// Body -> { values, errors }. Alert number and threshold are only read when the user holds the key flag.
export function validateSmsSettings(body, { canKey }) {
  const errors = {};
  const values = {};
  const line = String(body.sms_line ?? '').trim();
  if (!SENDER_LINE.test(line)) errors.sms_line = 'شماره‌ی خط فرستنده باید ۳ تا ۲۰ حرف یا رقم لاتین باشد.';
  values.sms_line = line;

  if (!LEAD_KEYS.includes(body.sms_lead)) errors.sms_lead = 'زمان پیش‌فرض یادآوری معتبر نیست.';
  values.sms_lead = body.sms_lead;

  const hourText = toAsciiDigits(String(body.sms_hour ?? '')).trim();
  const hour = /^\d{1,2}$/.test(hourText) ? Number(hourText) : NaN;
  if (!(hour >= 8 && hour <= 21)) errors.sms_hour = 'ساعت ارسال باید بین ۸ و ۲۱ باشد.';
  values.sms_hour = String(hour);

  const tpl = validateTemplate(body.sms_template);
  if (tpl.error) errors.sms_template = tpl.error;
  values.sms_template = tpl.text;

  if (canKey) {
    const alertText = String(body.sms_alert_phone ?? '').trim();
    const phone = alertText ? normalizeMobile(alertText) : '';
    if (alertText && !phone) errors.sms_alert_phone = 'شماره‌ی موبایل هشدار معتبر نیست.';
    values.sms_alert_phone = phone ?? '';

    const thText = toAsciiDigits(String(body.sms_low_threshold ?? '')).trim();
    const th = /^\d{1,4}$/.test(thText) ? Number(thText) : NaN;
    if (!(th >= 1 && th <= 1000)) errors.sms_low_threshold = 'حد اعتبار باید عددی بین ۱ تا ۱۰۰۰ پیام باشد.';
    values.sms_low_threshold = String(th);
  }
  return { values, errors };
}

// How many planned future visits would get a reminder if SMS were switched on now (the clerk confirms this number).
export function plannedReminderCount(db, defaultLead, today = localDay()) {
  const rows = db.prepare(`SELECT v.reminder_lead, p.phone, p.sms_optout, p.status FROM visits v JOIN patients p ON p.id = v.patient_id
                           WHERE v.status = 'scheduled' AND v.visit_date >= ?`).all(today);
  return rows.filter((r) => (r.reminder_lead ?? defaultLead) !== 'none' && !r.sms_optout && r.status !== 'archived' && normalizeMobile(r.phone)).length;
}
