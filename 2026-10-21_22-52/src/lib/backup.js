// Nightly database backup: data/backups/clinic-YYYY-MM-DD.db, the newest 14 kept.
// Patient files already live as plain files in data/patients/, so the database is the only thing to snapshot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const KEEP_BACKUPS = 14;
const NAME_RE = /^clinic-\d{4}-\d{2}-\d{2}\.db$/;

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const backupDir = (dataDir) => path.join(dataDir, 'backups');

// Writes today's backup (replacing an earlier one from the same day) and prunes old ones.
// db.backup() takes a consistent snapshot while the app keeps running.
export async function backupNow(db, dataDir, now = new Date()) {
  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, `clinic-${localDay(now)}.db`);
  // Unique per run, so the nightly job and a manual `scripts/backup.js` never touch each other's file.
  const partial = `${final}.${process.pid}-${crypto.randomUUID().slice(0, 8)}.partial`;
  try {
    await db.backup(partial);
    fs.renameSync(partial, final); // a half-written file never carries the real name
  } finally {
    fs.rmSync(partial, { force: true });
  }
  const names = fs.readdirSync(dir);
  const old = names.filter((n) => NAME_RE.test(n)).sort().reverse().slice(KEEP_BACKUPS);
  // A run killed mid-copy (power loss, container stop) leaves a .partial behind; remove those older than a day.
  const stale = names.filter((n) => n.endsWith('.partial') && now - fs.statSync(path.join(dir, n)).mtimeMs > 24 * 3600 * 1000);
  for (const n of [...old, ...stale]) fs.rmSync(path.join(dir, n), { force: true });
  return final;
}

export function hasBackupFor(dataDir, now = new Date()) {
  return fs.existsSync(path.join(backupDir(dataDir), `clinic-${localDay(now)}.db`));
}

// Milliseconds until the next `hour`:00 in server local time.
export function msUntilNext(hour, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

// Runs a backup at `hour`:00 every day. Also backs up at start-up when today has none yet,
// so a server that was off at 03:00 still gets one. Returns a function that stops the schedule.
export function scheduleNightlyBackup(db, dataDir, { hour = 3, log = console } = {}) {
  let timer;
  const run = async () => {
    try {
      log.log(`backup written: ${path.basename(await backupNow(db, dataDir))}`);
    } catch (err) {
      log.error('backup failed:', err.message);
    }
  };
  const arm = () => {
    timer = setTimeout(async () => { await run(); arm(); }, msUntilNext(hour));
    timer.unref();
  };
  if (!hasBackupFor(dataDir)) run();
  arm();
  return () => clearTimeout(timer);
}
