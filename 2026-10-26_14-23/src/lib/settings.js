// Site-wide settings (finance settings page): display currency, alert defaults, letterhead. Key/value table.
import { DEFAULT_TEMPLATE } from './sms-rules.js';
import { roundQty } from './qty.js';

export const DEFAULTS = {
  currency: 'T', low_warn: '10', low_crit: '5', clinic_name: 'کلینیک', clinic_address: '', clinic_phone: '',
  sms_enabled: '0', sms_line: '90008361', sms_lead: 'd1', sms_hour: '17', sms_template: DEFAULT_TEMPLATE,
  sms_alert_phone: '', sms_low_threshold: '10', sms_low_alerted: '0', sms_balance: '', sms_balance_at: '',
};

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return {
    ...s,
    currency: s.currency === 'R' ? 'R' : 'T',
    low_warn: Math.max(0, roundQty(s.low_warn)),
    low_crit: Math.max(0, roundQty(s.low_crit)),
  };
}

// The clinic's name is also the website's name (tab title, sidebar, sign-in page). Read on every request, so one row only.
export function clinicName(db) {
  return db.prepare("SELECT value FROM settings WHERE key = 'clinic_name'").pluck().get() || DEFAULTS.clinic_name;
}

export function setSettings(db, values) {
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(values)) {
    if (!Object.hasOwn(DEFAULTS, k)) throw new Error(`unknown setting ${k}`);
    put.run(k, String(v));
  }
}
