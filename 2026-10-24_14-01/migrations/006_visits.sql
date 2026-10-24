-- Visits timeline (D23): past and planned visits of a patient.
CREATE TABLE visits (
  id          INTEGER PRIMARY KEY,
  patient_id  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_date  TEXT NOT NULL,                       -- Gregorian ISO YYYY-MM-DD
  visit_time  TEXT NOT NULL,                       -- 24 h HH:MM
  reason      TEXT,
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','done','cancelled')),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_visits_when ON visits (visit_date, visit_time);
CREATE INDEX idx_visits_patient ON visits (patient_id, visit_date);
