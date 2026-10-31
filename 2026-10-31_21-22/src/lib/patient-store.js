// Inserting a patient row. Shared by the patient form and CSV import.
// Row ids are never reused (the audit log points at them). Codes are separate from ids (D31): a CSV may set
// one, otherwise the next code is the highest code in use plus one, starting at P-000000. So deleting the
// newest patient frees its code again, while deleting an older one leaves a gap.
import fs from 'node:fs';
import { audit } from '../audit.js';
import { patientCode, patientDir, patientDirExists, ensurePatientDir, parseCodeCell } from './files.js';

const MAX_CODE = 999_999;

export function nextPatientCode(db, dataDir) {
  let n = db.prepare("SELECT COALESCE(MAX(CAST(substr(code, 3) AS INTEGER)), -1) + 1 FROM patients WHERE code LIKE 'P-%'").pluck().get();
  while (n <= MAX_CODE && patientDirExists(dataDir, patientCode(n))) n += 1;
  if (n <= MAX_CODE) return patientCode(n);
  // Nothing is left above the highest code (a CSV row or a hand change may set P-999999): the lowest code
  // that no patient holds and no folder uses, so new patients can still be saved.
  const taken = new Set(db.prepare('SELECT code FROM patients').pluck().all());
  for (let i = 0; i <= MAX_CODE; i += 1) {
    const c = patientCode(i);
    if (!taken.has(c) && !patientDirExists(dataDir, c)) return c;
  }
  throw new Error('patient codes exhausted');
}

// Changing a patient's code by hand (D36). The code also names the folder, so the row and the folder move together:
// the folder is renamed last inside the transaction, so a failed rename rolls the row back, and a failed commit
// renames the folder back. Every other table points at the row id, so screens, exports and the SMS log follow at
// once. The old code is free afterwards, like a deleted patient's (D31). Returns { code } or { error } in Persian.
// A file someone copies into the old folder by hand at the same moment lands in a new old-code folder, which then
// keeps that code from being given out (patientDirExists), so the file is never shown to another patient.
export const CODE_FORMAT_ERROR = 'کد را به شکل P-000123 یا فقط عدد آن (تا ۶ رقم) وارد کنید.';

// Why a well-formed code cannot be given to a patient, in Persian, or null when it is free. Shared by the
// code change below and the new-patient form.
export function codeTakenError(db, dataDir, code) {
  if (db.prepare('SELECT 1 FROM patients WHERE code = ?').get(code)) return `کد ${code} مال بیمار دیگری است.`;
  if (patientDirExists(dataDir, code)) return `پوشه‌ی ${code} روی سرور هنوز وجود دارد (پرونده‌ی حذف‌شده یا کپی دستی)؛ این کد داده نمی‌شود.`;
  return null;
}

export function changePatientCode(db, dataDir, patient, typed, userId) {
  const code = parseCodeCell(typed);
  if (!code) return { error: CODE_FORMAT_ERROR };
  if (code === patient.code) return { error: 'این همان کد فعلی بیمار است.' };
  const taken = codeTakenError(db, dataDir, code);
  if (taken) return { error: taken };
  const from = patientDir(dataDir, patient.code);
  const to = patientDir(dataDir, code);
  let moved = false;
  try {
    db.transaction(() => {
      db.prepare(`UPDATE patients SET code = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_by = ? WHERE id = ?`)
        .run(code, userId, patient.id);
      audit(db, { userId, action: 'patient_code', patientId: patient.id, detail: `${patient.code} → ${code}` });
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
        moved = true;
      } else {
        ensurePatientDir(dataDir, code);
      }
    })();
  } catch (err) {
    if (moved) {
      try { fs.renameSync(to, from); } catch { /* both paths are logged below for a person to fix */ }
    }
    console.error(`patient code change ${patient.code} -> ${code} failed: ${err.code ?? err.message}`);
    return { error: 'تغییر کد انجام نشد؛ پوشه‌ی بیمار روی سرور جابه‌جا نشد. دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.' };
  }
  return { code };
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
