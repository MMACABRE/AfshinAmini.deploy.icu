-- D26: storage. Catalog of services and stock items, lots with expiry, and a ledger of stock moves.
-- Money is whole Rial (INTEGER). Dates are ISO Gregorian text. Spec: docs/specs/finance-storage-forms.md §2.
CREATE TABLE catalog (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('service', 'item')),
  name          TEXT NOT NULL,
  sale_price    INTEGER NOT NULL CHECK (sale_price >= 0),
  purchase_cost INTEGER CHECK (purchase_cost >= 0),       -- items only, never charged to a patient
  fixed         INTEGER NOT NULL DEFAULT 0 CHECK (fixed IN (0, 1)),  -- listed first in finance settings
  low_warn      INTEGER CHECK (low_warn >= 0),            -- per-item alert levels; NULL = settings default
  low_crit      INTEGER CHECK (low_crit >= 0),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE lots (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES catalog(id),
  received_on TEXT NOT NULL,
  qty_in      INTEGER NOT NULL CHECK (qty_in > 0),
  remaining   INTEGER NOT NULL CHECK (remaining >= 0),    -- kept in step with stock_moves by src/lib/stock.js
  expires_on  TEXT,
  unit_cost   INTEGER CHECK (unit_cost >= 0),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_lots_item ON lots(item_id, expires_on);

CREATE TABLE stock_moves (
  id      INTEGER PRIMARY KEY,
  lot_id  INTEGER NOT NULL REFERENCES lots(id),
  qty     INTEGER NOT NULL CHECK (qty <> 0),              -- negative takes stock out
  reason  TEXT NOT NULL CHECK (reason IN ('in', 'use', 'return', 'count', 'waste')),
  line_id INTEGER,                                        -- bill line for use and return
  note    TEXT,
  user_id INTEGER REFERENCES users(id),
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_moves_lot ON stock_moves(lot_id);
CREATE INDEX idx_moves_line ON stock_moves(line_id);
CREATE INDEX idx_moves_ts ON stock_moves(ts);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings (key, value) VALUES ('currency', 'T'), ('low_warn', '10'), ('low_crit', '5'),
  ('clinic_name', 'کلینیک'), ('clinic_address', ''), ('clinic_phone', '');
