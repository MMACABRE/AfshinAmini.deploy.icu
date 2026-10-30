-- D25: per-user permissions replace the fixed admin/staff roles. The role column stays for history only.
-- perms is JSON read through src/lib/perms.js parsePerms; the presets below must match PRESETS there.
ALTER TABLE users ADD COLUMN perms TEXT NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1));
CREATE UNIQUE INDEX idx_users_one_owner ON users(is_owner) WHERE is_owner = 1;

UPDATE users SET perms = '{"patients":2,"documents":2,"visits":2,"storage":2,"finance":2,"pdf":1,"data":1,"users":1,"flags":["patient_delete","document_delete","full_zip","csv_import","manage_users","audit_log","stock_adjust","finance_settings","price_override"]}'
  WHERE role = 'admin';
UPDATE users SET perms = '{"patients":2,"documents":2,"visits":2,"storage":1,"finance":0,"pdf":1,"data":0,"users":0,"flags":["document_delete"]}'
  WHERE role = 'staff';

-- The oldest active admin that is not deleted becomes the owner.
UPDATE users SET is_owner = 1 WHERE id = (
  SELECT id FROM users WHERE role = 'admin' AND active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1
);
