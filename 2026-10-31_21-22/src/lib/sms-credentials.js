// The clinic's own SMS provider key. Stored encrypted (AES-256-GCM) in the database; the encryption key is a random
// file next to the data folder contents (data/sms.key), so a stolen database or backup cannot send messages.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const API_KEY_PATTERN = /^[A-Za-z0-9_.-]{20,200}$/;

const keyFile = (dataDir) => path.join(dataDir, 'sms.key');

// Reads the key file; creates it on first use. `wx` means two starts racing never overwrite each other.
function fileKey(dataDir, { create }) {
  const file = keyFile(dataDir);
  if (create && !fs.existsSync(file)) {
    try { fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  try {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch { return null; }
}

function seal(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

function open(secret, key) {
  try {
    if (!secret.startsWith('v1:')) return null;
    const raw = Buffer.from(secret.slice(3), 'base64');
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

// Returns { error } for a key that cannot be right; the caller shows it. The key itself is never echoed.
export function saveKey(db, dataDir, apiKey, userId = null) {
  const value = String(apiKey ?? '').trim();
  if (!API_KEY_PATTERN.test(value)) return { error: 'کلید واردشده درست نیست.' };
  const key = fileKey(dataDir, { create: true });
  if (!key) return { error: 'پرونده‌ی رمزنگاری کلید خراب است.' };
  db.prepare(`INSERT INTO sms_credentials (id, secret, hint, updated_at, updated_by) VALUES (1, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
    ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, hint = excluded.hint, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(seal(value, key), value.slice(-4), userId);
  return { error: null };
}

export function removeKey(db) {
  db.prepare('DELETE FROM sms_credentials WHERE id = 1').run();
}

// The plain key, or null when none is stored or it cannot be read (missing or replaced key file): treated as "no key".
export function loadKey(db, dataDir) {
  const row = db.prepare('SELECT secret FROM sms_credentials WHERE id = 1').get();
  if (!row) return null;
  const key = fileKey(dataDir, { create: false });
  return key ? open(row.secret, key) : null;
}

// For screens: whether a key row exists and its last 4 characters; `usable` false when the key file no longer fits.
export function keyInfo(db, dataDir) {
  const row = db.prepare('SELECT hint, updated_at FROM sms_credentials WHERE id = 1').get();
  if (!row) return null;
  return { hint: row.hint, updatedAt: row.updated_at, usable: loadKey(db, dataDir) !== null };
}
