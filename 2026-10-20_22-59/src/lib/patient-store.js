// Inserting a patient row. Shared by the patient form and CSV import so ids and codes are never reused.
import { audit } from '../audit.js';
import { patientCode } from './files.js';

// Must run inside the caller's transaction. `values` are validated database-ready columns.
export function insertPatient(db, values, userId, auditDetail = null) {
  const cols = Object.keys(values);
  const id = db.prepare(`INSERT INTO patient_seq (id)
                         SELECT MAX(COALESCE((SELECT MAX(id) FROM patients), 0), COALESCE((SELECT MAX(id) FROM patient_seq), 0)) + 1`)
    .run().lastInsertRowid;
  const code = patientCode(id);
  db.prepare(`INSERT INTO patients (id, code, updated_by, ${cols.join(', ')})
              VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})`)
    .run(id, code, userId, ...cols.map((k) => values[k]));
  audit(db, { userId, action: 'patient_create', patientId: Number(id), detail: auditDetail ?? code });
  return code;
}
