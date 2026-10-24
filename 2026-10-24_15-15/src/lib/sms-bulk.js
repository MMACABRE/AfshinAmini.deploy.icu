// Bulk and custom messages (D32+): who gets a message, and putting it in the queue.
import { buildWhere, statusFilter, MAX_RULES, SearchError } from './search-sql.js';
import { normalizeMobile, smsParts, cleanText, MESSAGE_MAX } from './sms-rules.js';
import { normalizeText } from './normalize.js';

export const BULK_MAX = 500;

// Message text typed by staff. {نام} is the only blank; any other brace is refused.
export function validateBody(input, { allowName }) {
  const text = cleanText(input);
  if (!text) return { text, error: 'متن پیامک را وارد کنید.' };
  if (Array.from(text).length > MESSAGE_MAX) return { text, error: 'متن پیامک نباید بیش از ۵۰۰ نویسه باشد.' };
  const stripped = allowName ? text.replaceAll('{نام}', '') : text;
  if (/[{}]/.test(stripped)) return { text, error: allowName ? 'فقط {نام} به‌عنوان جای‌گزین مجاز است.' : 'نویسه‌های { و } مجاز نیستند.' };
  return { text, error: null };
}

export const fillName = (text, patient) => text.replaceAll('{نام}', normalizeText(`${patient.first_name} ${patient.last_name}`)).slice(0, MESSAGE_MAX);

export function whyNot(p) {
  if (p.sms_optout) return 'optout';
  if (p.status === 'archived') return 'archived';
  if (!normalizeMobile(p.phone)) return 'phone';
  return null;
}

// Saved-search row -> { eligible: [{id, first_name, last_name, phone}], skipped: {optout, archived, phone, duplicate}, total } | null (search cannot run).
export function recipientsFor(db, savedRow) {
  let stored;
  try { stored = JSON.parse(savedRow.query_json); } catch { return null; }
  const query = {
    join: stored?.join === 'or' ? 'or' : 'and',
    status: statusFilter(stored?.status),
    rules: Array.isArray(stored?.rules) ? stored.rules.slice(0, MAX_RULES) : [],
  };
  let built;
  try { built = buildWhere(query); } catch (e) { if (e instanceof SearchError) return null; throw e; }
  const rows = db.prepare(`SELECT id, first_name, last_name, phone, sms_optout, status FROM patients WHERE ${built.where} ORDER BY id`).all(...built.params);
  const skipped = { optout: 0, archived: 0, phone: 0, duplicate: 0 };
  const seen = new Set();
  const eligible = [];
  for (const p of rows) {
    const why = whyNot(p);
    if (why) { skipped[why]++; continue; }
    const phone = normalizeMobile(p.phone);
    if (seen.has(phone)) { skipped.duplicate++; continue; }
    seen.add(phone);
    eligible.push({ id: p.id, first_name: p.first_name, last_name: p.last_name, phone });
  }
  return { eligible, skipped, total: rows.length };
}

export function partsTotal(text, eligible) {
  return eligible.reduce((n, p) => n + smsParts(fillName(text, p)), 0);
}

export function queueMessage(db, { kind, patientId = null, phone, body, userId = null, now = Date.now() }) {
  return db.prepare(`INSERT INTO sms_messages (kind, patient_id, phone, body, status, due_at, created_by) VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
    .run(kind, patientId, phone, body, now, userId).lastInsertRowid;
}
