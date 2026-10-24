// Inserting a patient row. Shared by the patient form and CSV import.
// Row ids are never reused (the audit log points at them). Codes are separate from ids (D31): a CSV may set
// one, otherwise the next code is the highest code in use plus one, starting at P-000000. So deleting the
// newest patient frees its code again, while deleting an older one leaves a gap.
import { audit } from '../audit.js';
import { patientCode, patientDirExists, ensurePatientDir } from './files.js';

const MAX_CODE = 999_999;

export function nextPatientCode(db, dataDir) {
  let n = db.prepare("SELECT COALESCE(MAX(CAST(substr(code, 3) AS INTEGER)), -1) + 1 FROM patients WHERE code LIKE 'P-%'").pluck().get();
  while (n <= MAX_CODE && patientDirExists(dataDir, patientCode(n))) n += 1;
  if (n <= MAX_CODE) return patientCode(n);
  // Nothing is left above the highest code (a CSV row may set P-999999, and codes never change): the lowest code
  // that no patient holds and no folder uses, so new patients can still be saved.
  const taken = new Set(db.prepare('SELECT code FROM patients').pluck().all());
  for (let i = 0; i <= MAX_CODE; i += 1) {
    const c = patientCode(i);
    if (!taken.has(c) && !patientDirExists(dataDir, c)) return c;
  }
  throw new Error('patient codes exhausted');
}

// Must run inside the caller's transaction. `values` are validated database-ready columns. `code`, when
// given, must already be checked as free (callers show their own message); its folder is created here.
export function insertPatient(db, dataDir, values, userId, { code = null, auditDetail = null } = {}) {
  const cols = Object.keys(values);
  const id = db.prepare(`INSERT INTO patient_seq (id)
                         SELECT MAX(COALESCE((SELECT MAX(id) FROM patients), 0), COALESCE((SELECT MAX(id) FROM patient_seq), 0)) + 1`)
    .run().lastInsertRowid;
  if (code && patientDirExists(dataDir, code)) throw new Error('patient folder already exists');
  const c = code ?? nextPatientCode(db, dataDir);
  db.prepare(`INSERT INTO patients (id, code, updated_by, ${cols.join(', ')})
              VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})`)
    .run(id, c, userId, ...cols.map((k) => values[k]));
  ensurePatientDir(dataDir, c); // inside the transaction: if it fails, no row is left without a folder
  audit(db, { userId, action: 'patient_create', patientId: Number(id), detail: auditDetail ?? c });
  return c;
}
