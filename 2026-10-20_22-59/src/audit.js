// Records who did what. Never put patient field values or passwords in `detail`.
export function audit(db, { userId = null, action, patientId = null, detail = null }) {
  db.prepare('INSERT INTO audit_log (user_id, action, patient_id, detail) VALUES (?, ?, ?, ?)')
    .run(userId, action, patientId, detail);
}
