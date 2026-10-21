// Site-wide settings (finance settings page): display currency, alert defaults, letterhead. Key/value table.
export const DEFAULTS = { currency: 'T', low_warn: '10', low_crit: '5', clinic_name: 'کلینیک', clinic_address: '', clinic_phone: '' };

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return {
    ...s,
    currency: s.currency === 'R' ? 'R' : 'T',
    low_warn: Math.max(0, Number.parseInt(s.low_warn, 10) || 0),
    low_crit: Math.max(0, Number.parseInt(s.low_crit, 10) || 0),
  };
}

export function setSettings(db, values) {
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(values)) {
    if (!Object.hasOwn(DEFAULTS, k)) throw new Error(`unknown setting ${k}`);
    put.run(k, String(v));
  }
}
