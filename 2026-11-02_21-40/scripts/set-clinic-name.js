// Sets the clinic's name (setting clinic_name). It is also the website's name: browser tab, sidebar, sign-in page and
// the letterhead of every printed form. Admins can change it later under «مالی → تنظیمات».
//   node scripts/set-clinic-name.js "<name>"         e.g. "KLERK | کلرک"
//   node scripts/set-clinic-name.js                  prints the current name
// In Docker: docker compose exec app node scripts/set-clinic-name.js "<name>"
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { clinicName, setSettings } from '../src/lib/settings.js';
import { normalizeText } from '../src/lib/normalize.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const db = openDb(path.join(dataDir, 'clinic.db'));
try {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(`Current name: ${clinicName(db)}`);
  } else {
    // The same clean-up and limit as the settings form (src/routes/finance.js).
    const name = normalizeText(args.join(' ')).trim().slice(0, 120);
    if (!name) throw new Error('The name is empty.');
    setSettings(db, { clinic_name: name });
    console.log(`Clinic name set to: ${name}`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
