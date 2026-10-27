-- Owner request 2026-10-25: the patient's father's name «نام پدر», optional text like the other identity fields.
ALTER TABLE patients ADD COLUMN father_name TEXT;
