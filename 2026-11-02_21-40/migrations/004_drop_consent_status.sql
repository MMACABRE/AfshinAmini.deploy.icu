-- D21: documents no longer track a signed/pending consent status. The category 'consent' stays as a plain type.
-- SQLite allows dropping a column whose only CHECK constraint is its own.
ALTER TABLE documents DROP COLUMN consent_status;
