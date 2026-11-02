-- Patient ids come from this table so they are never reused after a patient is deleted.
-- (A plain INTEGER PRIMARY KEY reuses the highest id, which would give a new patient a deleted patient's code.)
CREATE TABLE patient_seq (id INTEGER PRIMARY KEY AUTOINCREMENT);
INSERT INTO patient_seq (id) SELECT COALESCE(MAX(id), 0) + 1 FROM patients;
