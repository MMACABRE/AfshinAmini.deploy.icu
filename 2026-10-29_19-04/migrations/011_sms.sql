-- SMS reminders and messages (D32+): opt-out on the patient, reminder lead on the visit, the message queue and log,
-- the clinic's own provider key (encrypted; the encryption key lives in a file outside the database), permissions.

ALTER TABLE patients ADD COLUMN sms_optout INTEGER NOT NULL DEFAULT 0 CHECK (sms_optout IN (0, 1));

-- NULL = use the clinic default from the SMS settings.
ALTER TABLE visits ADD COLUMN reminder_lead TEXT CHECK (reminder_lead IN ('none', 'now', 'h2', 'd1', 'd2') OR reminder_lead IS NULL);

-- One row. `secret` is AES-256-GCM text (src/lib/sms-credentials.js); `hint` is the last 4 characters, for display.
CREATE TABLE sms_credentials (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  secret     TEXT NOT NULL,
  hint       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by INTEGER REFERENCES users(id)
);

-- Queue and log in one table. A reminder row is created per visit and schedule (`stamp` = visit date + time), so a
-- restart or a second tick cannot create a second one. Its text is made when it is sent, from the then-current visit.
CREATE TABLE sms_messages (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('reminder', 'custom', 'bulk', 'alert', 'test')),
  patient_id  INTEGER REFERENCES patients(id) ON DELETE CASCADE,
  visit_id    INTEGER REFERENCES visits(id) ON DELETE CASCADE,
  stamp       TEXT,
  phone       TEXT,
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'cancelled')),
  reason      TEXT,
  due_at      INTEGER NOT NULL,           -- epoch ms
  attempts    INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  sent_at     TEXT
);
CREATE UNIQUE INDEX idx_sms_reminder_once ON sms_messages (visit_id, stamp) WHERE kind = 'reminder';
CREATE INDEX idx_sms_status_due ON sms_messages (status, due_at);
CREATE INDEX idx_sms_patient ON sms_messages (patient_id, id);
CREATE INDEX idx_sms_visit ON sms_messages (visit_id, id);

INSERT INTO settings (key, value) VALUES ('sms_enabled', '0'), ('sms_line', '90008361'), ('sms_lead', 'd1'), ('sms_hour', '17'),
  ('sms_alert_phone', ''), ('sms_low_threshold', '10'), ('sms_low_alerted', '0'), ('sms_balance', ''), ('sms_balance_at', '')
  ON CONFLICT(key) DO NOTHING;

-- Permissions: new area `sms`. Admins also get the two flags; staff may use the area (the key stays with the flag).
UPDATE users SET perms = json_set(perms, '$.sms', 2, '$.flags', json_insert(json_extract(perms, '$.flags'), '$[#]', 'sms_bulk', '$[#]', 'sms_key'))
  WHERE role = 'admin' AND json_valid(perms) AND json_type(perms, '$.flags') = 'array';
UPDATE users SET perms = json_set(perms, '$.sms', 2) WHERE role = 'staff' AND json_valid(perms);
