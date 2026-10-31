-- Visit length in minutes (5 to 60). Existing visits get 15.
ALTER TABLE visits ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 15 CHECK (duration_min BETWEEN 5 AND 60);
