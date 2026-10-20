// Creates a user from the command line. Used to create the first admin on a new server:
//   node scripts/create-user.js <username> <admin|staff> ["Display name"]
// In Docker: docker compose exec app node scripts/create-user.js admin admin "مدیر سیستم"
// The password is asked for twice and never appears in shell history.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createUser, checkPasswordPolicy } from '../src/auth.js';

const [username, role, displayName] = process.argv.slice(2);
if (!username || !['admin', 'staff'].includes(role)) {
  console.error('Usage: node scripts/create-user.js <username> <admin|staff> ["Display name"]');
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };  // hide typed characters
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const password = process.env.NEW_USER_PASSWORD ?? await askHidden('Password: ');
if (process.env.NEW_USER_PASSWORD === undefined && (await askHidden('Repeat password: ')) !== password) {
  console.error('Passwords do not match.');
  process.exit(1);
}
const problem = checkPasswordPolicy(password);
if (problem) { console.error(problem); process.exit(1); }

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const db = openDb(path.join(dataDir, 'clinic.db'));
try {
  const id = createUser(db, { username, displayName, role, password });
  console.log(`Created ${role} "${username}" (id ${id}).`);
} catch (err) {
  console.error(err.message.includes('UNIQUE') ? `User "${username}" already exists.` : err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
