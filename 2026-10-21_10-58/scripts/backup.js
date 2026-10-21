// Manual backup: node scripts/backup.js
// In Docker: docker compose exec app node scripts/backup.js
// Writes data/backups/clinic-YYYY-MM-DD.db (the same file the nightly job writes).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { backupNow } from '../src/lib/backup.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const db = openDb(path.join(dataDir, 'clinic.db'));
console.log(`backup written: ${await backupNow(db, dataDir)}`);
db.close();
