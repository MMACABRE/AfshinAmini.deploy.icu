// SMS engine (D32+): plans reminder rows from visits, sends due rows, reads the balance, cleans old rows.
// One tick at a time. A reminder row is made per (visit, date+time); its text is built when it is sent. Nothing here
// throws to the caller and nothing logs a number, a name, a text or the key.
import { getSettings, setSettings } from './settings.js';
import { loadKey } from './sms-credentials.js';
import { createProvider } from './sms-provider.js';
import {
  normalizeMobile, validateTemplate, renderTemplate, visitDateText, visitTimeText, reminderDue, visitStart, inWindow,
  DEFAULT_TEMPLATE, LEAD_KEYS, sendHourOf,
} from './sms-rules.js';
import { localDay } from './jalali.js';
import { normalizeText } from './normalize.js';

export const MAX_REMINDERS = 2;
export const MAX_ATTEMPTS = 3;
export const RETRY_MS = 5 * 60 * 1000;
export const BALANCE_EVERY_MS = 30 * 60 * 1000;
export const RETENTION_DAYS = 180;
const BATCH = 20;

export const REASON = {
  optout: 'بیمار پیامک نمی‌خواهد.',
  archived: 'پرونده‌ی بیمار بایگانی‌شده است.',
  phone: 'شماره‌ی موبایل معتبر نیست.',
  cap: `حداکثر ${MAX_REMINDERS} یادآوری برای هر ویزیت ارسال می‌شود.`,
  late: 'زمان ارسال گذشته است.',
  unknown: 'نتیجه نامشخص است.',
  gone: 'ویزیت دیگر برنامه‌ریزی‌شده نیست.',
  noLead: 'یادآوری برای این ویزیت برداشته شد.',
};
// Reasons that go away when the clerk fixes the patient; such a row is revived by the next plan.
const RECOVERABLE = [REASON.optout, REASON.archived, REASON.phone];

const nowIso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function createEngine({ db, dataDir, provider = createProvider(), now = () => new Date(), log = console } = {}) {
  let running = false;
  let lastRetentionDay = '';

  const settings = () => getSettings(db);
  const isOn = (s) => s.sms_enabled === '1';

  function templateOf(s) {
    return validateTemplate(s.sms_template).error ? DEFAULT_TEMPLATE : validateTemplate(s.sms_template).text;
  }

  function leadOf(visit, s) {
    if (LEAD_KEYS.includes(visit.reminder_lead)) return visit.reminder_lead;
    return LEAD_KEYS.includes(s.sms_lead) ? s.sms_lead : 'd1';
  }

  // Why this patient cannot get a message, or null.
  function blockReason(p) {
    if (p.sms_optout) return REASON.optout;
    if (p.status === 'archived') return REASON.archived;
    if (!normalizeMobile(p.phone)) return REASON.phone;
    return null;
  }

  // ---- planning ----

  function planReminders() {
    const s = settings();
    const t = now();
    const sendHour = sendHourOf(s.sms_hour);
    const stats = { created: 0, moved: 0, revived: 0, cancelled: 0, skipped: 0 };

    // Visits that are no longer planned lose their waiting reminders.
    stats.cancelled += db.prepare(`UPDATE sms_messages SET status = 'cancelled', reason = ? WHERE kind = 'reminder' AND status = 'pending'
      AND visit_id IN (SELECT id FROM visits WHERE status != 'scheduled')`).run(REASON.gone).changes;

    const visits = db.prepare(`SELECT v.id, v.visit_date, v.visit_time, v.reminder_lead, p.id AS patient_id, p.phone, p.sms_optout, p.status AS patient_status
      FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.status = 'scheduled' AND v.visit_date >= ?`).all(localDay(t));
    const rowsOf = db.prepare(`SELECT id, stamp, status, reason, due_at FROM sms_messages WHERE kind = 'reminder' AND visit_id = ? ORDER BY id`);
    const insert = db.prepare(`INSERT INTO sms_messages (kind, patient_id, visit_id, stamp, status, reason, due_at) VALUES ('reminder', ?, ?, ?, ?, ?, ?)`);
    const setRow = db.prepare('UPDATE sms_messages SET status = ?, reason = ?, stamp = ?, due_at = ? WHERE id = ?');

    for (const v of visits) {
      const rows = rowsOf.all(v.id);
      const lead = leadOf(v, s);
      const stamp = `${v.visit_date} ${v.visit_time}`;
      const pending = rows.filter((r) => r.status === 'pending');

      if (lead === 'none') {
        for (const r of pending) { setRow.run('cancelled', REASON.noLead, r.stamp, t.getTime(), r.id); stats.cancelled++; }
        continue;
      }
      if (visitStart(v.visit_date, v.visit_time) <= t) continue;
      const due = reminderDue(lead, v, { sendHour, now: t }).getTime();
      const block = blockReason({ sms_optout: v.sms_optout, status: v.patient_status, phone: v.phone });

      const same = rows.find((r) => r.stamp === stamp);
      if (same) {
        if (same.status === 'pending') {
          if (block) { setRow.run('skipped', block, stamp, due, same.id); stats.skipped++; }
          else if (lead !== 'now') db.prepare('UPDATE sms_messages SET due_at = ? WHERE id = ?').run(due, same.id);
        } else if ((same.status === 'skipped' && RECOVERABLE.includes(same.reason)) || same.status === 'cancelled') {
          if (!block) { setRow.run('pending', null, stamp, due, same.id); stats.revived++; }
        }
        continue;
      }
      // Moved before it was sent: the waiting reminder follows the new time.
      const waiting = pending[0];
      if (waiting) {
        if (block) setRow.run('skipped', block, stamp, due, waiting.id);
        else setRow.run('pending', null, stamp, lead === 'now' ? waiting.due_at : due, waiting.id);
        stats.moved++;
        continue;
      }
      const counted = rows.filter((r) => ['pending', 'sending', 'sent', 'failed'].includes(r.status)).length;
      if (counted >= MAX_REMINDERS) { insert.run(v.patient_id, v.id, stamp, 'skipped', REASON.cap, due); stats.skipped++; continue; }
      if (block) { insert.run(v.patient_id, v.id, stamp, 'skipped', block, due); stats.skipped++; continue; }
      insert.run(v.patient_id, v.id, stamp, 'pending', null, due);
      stats.created++;
    }
    return stats;
  }

  // ---- sending ----

  const finish = (id, status, reason = null, extra = {}) => db.prepare(
    `UPDATE sms_messages SET status = ?, reason = ?, provider_id = ?, body = COALESCE(?, body), phone = COALESCE(?, phone), sent_at = ? WHERE id = ?`,
  ).run(status, reason, extra.providerId ?? null, extra.body ?? null, extra.phone ?? null, status === 'sent' ? nowIso(now()) : null, id);

  // Builds what a row will say, or says why it cannot go. Returns { phone, body } or { skip }.
  function prepare(row, s) {
    if (row.kind !== 'reminder') {
      // A custom or bulk message waits in the queue; a patient who opted out meanwhile must not get it.
      const p = row.patient_id ? db.prepare('SELECT sms_optout FROM patients WHERE id = ?').get(row.patient_id) : null;
      if (p?.sms_optout) return { skip: REASON.optout };
      return { phone: row.phone, body: row.body };
    }
    const v = db.prepare(`SELECT v.visit_date, v.visit_time, v.status, p.first_name, p.last_name, p.phone, p.sms_optout, p.status AS patient_status
      FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = ?`).get(row.visit_id);
    if (!v || v.status !== 'scheduled') return { skip: REASON.gone, status: 'cancelled' };
    if (visitStart(v.visit_date, v.visit_time) <= now()) return { skip: REASON.late };
    const block = blockReason({ sms_optout: v.sms_optout, status: v.patient_status, phone: v.phone });
    if (block) return { skip: block };
    const body = renderTemplate(templateOf(s), {
      name: normalizeText(`${v.first_name} ${v.last_name}`), date: visitDateText(v.visit_date), time: visitTimeText(v.visit_time),
    });
    return { phone: normalizeMobile(v.phone), body };
  }

  // Claims one pending row and sends it. Returns 'sent' | 'failed' | 'skipped' | 'requeued' | 'busy'.
  async function process(row, apiKey, s) {
    const claim = db.prepare(`UPDATE sms_messages SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'`).run(row.id);
    if (claim.changes !== 1) return 'busy';
    const attempts = row.attempts + 1;
    const job = prepare(row, s);
    if (job.skip) { finish(row.id, job.status ?? 'skipped', job.skip); return 'skipped'; }
    if (!job.phone || !job.body) { finish(row.id, 'failed', REASON.phone); return 'failed'; }
    const r = await provider.send(apiKey, s.sms_line, job.phone, job.body);
    if (r.ok) { finish(row.id, 'sent', null, { providerId: r.id, body: job.body, phone: job.phone }); return 'sent'; }
    if (r.retry && attempts < MAX_ATTEMPTS) {
      db.prepare(`UPDATE sms_messages SET status = 'pending', due_at = ?, body = ?, phone = ? WHERE id = ?`).run(now().getTime() + RETRY_MS, job.body, job.phone, row.id);
      return 'requeued';
    }
    finish(row.id, 'failed', r.text, { body: job.body, phone: job.phone });
    return 'failed';
  }

  async function sendDue(apiKey, s) {
    const t = now();
    const out = { sent: 0, failed: 0, skipped: 0, requeued: 0 };
    const rows = db.prepare(`SELECT * FROM sms_messages WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id LIMIT ?`).all(t.getTime(), BATCH * 5);
    let taken = 0;
    for (const row of rows) {
      if (taken >= BATCH) break;
      if (row.kind === 'reminder' && !inWindow(t)) continue;
      const outcome = await process(row, apiKey, s);
      if (outcome === 'busy') continue;
      taken++;
      out[outcome]++;
    }
    return out;
  }

  // Sends one pending row now (the settings page's test message). Works while SMS is switched off.
  async function sendOne(id) {
    const apiKey = loadKey(db, dataDir);
    if (!apiKey) return 'no-key';
    const row = db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(id);
    if (!row) return 'gone';
    try { return await process(row, apiKey, settings()); } catch (e) {
      log.error(`sms send failed: ${e?.code || e?.name || 'error'}`);
      return 'failed';
    }
  }

  // A row left 'sending' can only come from a crash (one tick at a time): the result is unknown, so it is not resent.
  function recoverStuck() {
    return db.prepare(`UPDATE sms_messages SET status = 'failed', reason = ? WHERE status = 'sending'`).run(REASON.unknown).changes;
  }

  // Staff pressed «ارسال دوباره».
  function retry(id) {
    return db.prepare(`UPDATE sms_messages SET status = 'pending', reason = NULL, attempts = 0, due_at = ? WHERE id = ? AND status = 'failed'`).run(now().getTime(), id).changes === 1;
  }

  // ---- balance and low-credit alert ----

  async function refreshBalance(apiKey, s = settings()) {
    const r = await provider.balance(apiKey);
    if (!r.ok) return r;
    const threshold = Math.min(1000, Math.max(1, Number.parseInt(s.sms_low_threshold, 10) || 10));
    const update = { sms_balance: String(r.count), sms_balance_at: nowIso(now()) };
    if (r.count <= threshold && s.sms_low_alerted !== '1') {
      const phone = normalizeMobile(s.sms_alert_phone);
      if (phone) {
        db.prepare(`INSERT INTO sms_messages (kind, phone, body, status, due_at) VALUES ('alert', ?, ?, 'pending', ?)`)
          .run(phone, `اعتبار پیامک کلینیک رو به پایان است؛ ${r.count} پیام باقی مانده.`, now().getTime());
        update.sms_low_alerted = '1';
      }
    } else if (r.count > threshold && s.sms_low_alerted === '1') update.sms_low_alerted = '0';
    setSettings(db, update);
    return r;
  }

  function purgeOld() {
    const day = localDay(now());
    if (day === lastRetentionDay) return 0;
    lastRetentionDay = day;
    const cutoff = nowIso(new Date(now().getTime() - RETENTION_DAYS * 86400000));
    return db.prepare('DELETE FROM sms_messages WHERE created_at < ?').run(cutoff).changes;
  }

  // ---- the tick ----

  async function tick() {
    if (running) return { skipped: 'busy' };
    running = true;
    try {
      recoverStuck();
      purgeOld();
      const s = settings();
      if (!isOn(s)) return { skipped: 'off' };
      const apiKey = loadKey(db, dataDir);
      if (!apiKey) return { skipped: 'no-key' };
      const plan = planReminders();
      const sent = await sendDue(apiKey, s);
      const last = Date.parse(s.sms_balance_at);
      let balance = null;
      if (sent.sent > 0 || !(now().getTime() - last < BALANCE_EVERY_MS)) balance = await refreshBalance(apiKey, getSettings(db));
      return { plan, sent, balanceOk: balance ? balance.ok : null };
    } catch (e) {
      log.error(`sms tick failed: ${e?.code || e?.name || 'error'}`);
      return { skipped: 'error' };
    } finally { running = false; }
  }

  return { planReminders, sendDue, sendOne, recoverStuck, retry, refreshBalance, purgeOld, tick };
}

// Timer used by src/server.js: one tick a minute, never overlapping, does not keep the process alive. Returns a stopper.
export function scheduleSms(engine, { intervalMs = 60000 } = {}) {
  engine.recoverStuck();
  const timer = setInterval(() => { engine.tick(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
