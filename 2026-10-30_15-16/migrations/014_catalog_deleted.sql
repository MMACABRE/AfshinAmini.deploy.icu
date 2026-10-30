-- Deleting a stock item with its history (owner request 2026-10-27). An item that a visit bill still names cannot
-- lose its catalog row (bill_lines.catalog_id), so it is kept hidden: deleted_at set, active 0. Hidden rows show
-- nowhere and cannot be edited or billed again.
ALTER TABLE catalog ADD COLUMN deleted_at TEXT;
