-- Initial schema. Never edit this file once it has run anywhere; add 002_*.sql instead.
-- Dates are ISO Gregorian text (YYYY-MM-DD); timestamps are ISO text in UTC.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,  -- epoch ms, absolute limit
  last_seen  INTEGER NOT NULL   -- epoch ms, for idle timeout
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE login_attempts (
  key TEXT NOT NULL,            -- lower(username) || '|' || ip
  ip  TEXT NOT NULL,
  ts  INTEGER NOT NULL          -- epoch ms
);
CREATE INDEX idx_login_attempts_key ON login_attempts(key, ts);
CREATE INDEX idx_login_attempts_ip  ON login_attempts(ip, ts);

CREATE TABLE patients (
  id                 INTEGER PRIMARY KEY,
  code               TEXT UNIQUE,  -- 'P-000123', set right after insert from id
  first_name         TEXT NOT NULL,
  last_name          TEXT NOT NULL,
  national_id        TEXT,
  birth_date         TEXT,
  sex                TEXT CHECK (sex IN ('female', 'male', 'other') OR sex IS NULL),
  phone              TEXT,
  email              TEXT,
  address            TEXT,
  city               TEXT,
  emergency_name     TEXT,
  emergency_phone    TEXT,
  emergency_relation TEXT,
  insurance_name     TEXT,
  insurance_number   TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'pending', 'critical', 'archived')),
  blood_type         TEXT,
  allergies          TEXT,  -- comma-separated, shown as chips
  conditions         TEXT,  -- comma-separated, shown as chips
  medical_notes      TEXT,
  height_cm          REAL,
  weight_kg          REAL,
  blood_pressure     TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by         INTEGER REFERENCES users(id)
);
CREATE INDEX idx_patients_last_name   ON patients(last_name);
CREATE INDEX idx_patients_status      ON patients(status);
CREATE INDEX idx_patients_updated_at  ON patients(updated_at);
CREATE INDEX idx_patients_national_id ON patients(national_id);

CREATE TABLE medications (
  id         INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  dosage     TEXT,
  frequency  TEXT,
  since      TEXT
);
CREATE INDEX idx_medications_patient ON medications(patient_id);

-- Metadata only. The patient folder on disk is the source of truth for which files exist.
CREATE TABLE documents (
  id             INTEGER PRIMARY KEY,
  patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'other'
                 CHECK (category IN ('consent', 'lab', 'imaging', 'surgery', 'other')),
  title          TEXT,
  doc_date       TEXT,
  consent_status TEXT CHECK (consent_status IN ('signed', 'pending') OR consent_status IS NULL),
  notes          TEXT,
  uploaded_by    INTEGER REFERENCES users(id),
  uploaded_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (patient_id, filename)
);

CREATE TABLE saved_searches (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  query_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  patient_id INTEGER,          -- no FK: entries must survive patient deletion
  detail     TEXT,
  ts         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
