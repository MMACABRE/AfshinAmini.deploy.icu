-- Visit length up to 90 minutes (D51): the length dial offers 5 to 60 in steps of 5, then 75 and 90.
-- SQLite cannot change a CHECK constraint in place, and rebuilding the visits table would touch every table that
-- refers to it (bills, payments, reminders). So the column is swapped: the old one is renamed, a new one with the
-- wider check takes its name and its values, and the old one is dropped (its own CHECK goes with it).
ALTER TABLE visits RENAME COLUMN duration_min TO duration_min_old;
ALTER TABLE visits ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 15 CHECK (duration_min BETWEEN 5 AND 90);
UPDATE visits SET duration_min = duration_min_old;
ALTER TABLE visits DROP COLUMN duration_min_old;
