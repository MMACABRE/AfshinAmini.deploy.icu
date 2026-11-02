// Moves the owner role (D25) to another active user. Server only; there is no web page for this on purpose.
//   node scripts/set-owner.js <username>
// In Docker: docker compose exec app node scripts/set-owner.js <username>
// The previous owner keeps the «مدیر» preset, so nobody loses access by this step.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { setOwner } from '../src/auth.js';

const [username] = process.argv.slice(2);
if (!username) {
  console.error('Usage: node scripts/set-owner.js <username>');
  process.exit(1);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const db = openDb(path.join(dataDir, 'clinic.db'));
try {
  const id = setOwner(db, username);
  console.log(`"${username}" (id ${id}) is now the owner.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
