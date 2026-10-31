-- D21: admins can delete a user. The row stays (audit_log, patients.updated_by and documents.uploaded_by point
-- at it, so the history keeps the person's name); deleted_at hides it from the user list for good.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
