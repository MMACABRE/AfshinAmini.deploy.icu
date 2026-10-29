import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { faKey } from './lib/normalize.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Opens (or creates) the database and applies any migrations not yet recorded.
// Pass ':memory:' in tests.
export function openDb(file) {
  if (file !== ':memory:') {
    // Everything this process creates from now on (database, WAL, backups, patient files and folders) is
    // private to its owner. Other accounts on the server must not be able to read patient records.
    process.umask(0o077);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The data folder itself is closed too, even when an older release or a person made it with mode 755; with it
    // closed, the older files inside cannot be reached either. Only the folder's owner can do this.
    try {
      fs.chmodSync(path.dirname(file), 0o700);
    } catch (err) {
      if (err.code === 'EPERM') console.warn(`data folder ${path.dirname(file)} is not owned by this user, so it could not be set private (chmod 700)`);
    }
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // fa_key(text): Persian-normalized comparison key, used by search (see src/lib/normalize.js).
  db.function('fa_key', { deterministic: true }, (s) => (s === null ? null : faKey(s)));
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all());
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
}
