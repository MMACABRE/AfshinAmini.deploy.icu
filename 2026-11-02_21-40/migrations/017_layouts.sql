-- D52-D54: patient form and dashboard layouts, custom boxes and their values (see docs/specs/layouts.md).
-- No layouts row means the default layout, so nothing changes until a clinic saves one.
CREATE TABLE layouts (
  name TEXT PRIMARY KEY CHECK (name IN ('patient_form', 'dashboard')),
  current TEXT NOT NULL,
  previous TEXT,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);
CREATE TABLE custom_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('short_text', 'long_text', 'number', 'date', 'choice', 'yes_no')),
  label TEXT NOT NULL,
  choices TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE patient_values (
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  box_id INTEGER NOT NULL REFERENCES custom_boxes(id),
  value TEXT NOT NULL,
  PRIMARY KEY (patient_id, box_id)
);

-- Layout editing is a new permission flag. Users on the «مدیر» preset get it, like 011 and 012, so their
-- permissions still match the preset; the owner always has every flag.
UPDATE users SET perms = json_set(perms, '$.flags', json_insert(json_extract(perms, '$.flags'), '$[#]', 'layout'))
  WHERE role = 'admin' AND json_valid(perms) AND json_type(perms, '$.flags') = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(perms, '$.flags') WHERE value = 'layout');
