-- D27-D28: the visit is the bill. Lines freeze name and price; payments are signed Rial rows.
-- Spec: docs/specs/finance-storage-forms.md §3.
ALTER TABLE visits ADD COLUMN doctor_note TEXT;
ALTER TABLE visits ADD COLUMN disc_kind TEXT CHECK (disc_kind IN ('amount', 'percent'));
ALTER TABLE visits ADD COLUMN disc_value INTEGER NOT NULL DEFAULT 0 CHECK (disc_value >= 0);
ALTER TABLE patients ADD COLUMN disc_kind TEXT CHECK (disc_kind IN ('amount', 'percent'));
ALTER TABLE patients ADD COLUMN disc_value INTEGER NOT NULL DEFAULT 0 CHECK (disc_value >= 0);

CREATE TABLE bill_lines (
  id             INTEGER PRIMARY KEY,
  visit_id       INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  catalog_id     INTEGER NOT NULL REFERENCES catalog(id),   -- a used catalog entry can no longer be deleted
  kind           TEXT NOT NULL CHECK (kind IN ('service', 'item')),
  name           TEXT NOT NULL,                             -- copied when added
  qty            INTEGER NOT NULL CHECK (qty > 0),
  unit_price     INTEGER NOT NULL CHECK (unit_price >= 0),  -- catalog price frozen when added
  override_price INTEGER CHECK (override_price >= 0),
  disc_kind      TEXT CHECK (disc_kind IN ('amount', 'percent')),
  disc_value     INTEGER NOT NULL DEFAULT 0 CHECK (disc_value >= 0),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_lines_visit ON bill_lines(visit_id);

CREATE TABLE accounts (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE TABLE pay_methods (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  default_account INTEGER REFERENCES accounts(id),
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- No ON DELETE: a visit (and so a patient) that has payments cannot be deleted; the app refuses first with a message.
CREATE TABLE payments (
  id         INTEGER PRIMARY KEY,
  visit_id   INTEGER NOT NULL REFERENCES visits(id),
  amount     INTEGER NOT NULL CHECK (amount <> 0),          -- Rial; negative for refund and move_out
  kind       TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'move_out', 'move_in')),
  paid_on    TEXT NOT NULL,
  method_id  INTEGER REFERENCES pay_methods(id),
  account_id INTEGER REFERENCES accounts(id),
  move_id    INTEGER,                                       -- pairs a move_out with its move_in
  note       TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_payments_visit ON payments(visit_id);
CREATE INDEX idx_payments_day ON payments(paid_on);

INSERT INTO accounts (id, name) VALUES (1, 'صندوق'), (2, 'حساب بانکی');
INSERT INTO pay_methods (name, default_account) VALUES ('نقدی', 1), ('کارت‌خوان', 2), ('کارت به کارت', 2);
INSERT INTO catalog (kind, name, sale_price, fixed) VALUES ('service', 'ویزیت', 0, 1);
