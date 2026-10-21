# Spec: permissions, storage, finance and PDF documents

Implementation status (2026-10-21): slices 16-20 built and merged. Not built yet: the search fields `balance` and `has_credit` (§5 Reach), page numbers on print documents (§5), the server PDF engine (needs the owner's approval). The full zip always contains `clinic.db`, so the finance CSVs being gated by finance view is a readability choice, not a protection; the full-zip flag itself is the protection.

Status: written 2026-10-21 from the wayfinder map (GitHub issue #1) and its closed tickets #2-#10 and #13. Tickets #4-#10 were decided by the agent at the owner's request ("agent decision, owner to review"); the owner may overturn any point. Vocabulary: `GLOSSARY.md`. Decisions: `Plan.md` D25-D30.

## Objective

The clinic gets three new sidebar tabs (Storage «انبار», Finance «امور مالی», PDF documents «فرم‌های چاپی») and per-user permissions instead of the fixed admin/staff roles. A doctor's visit becomes a bill: service and item lines, discounts, payments (split, prepaid, refunded, moved). Stock is counted in pieces, in lots with expiry. Finance shows income by payment day with server-drawn charts. Styled print documents cover daily finance, the day's visits, items used, a visit bill and a full patient record.

Success means: an owner can give a receptionist payments but not patient deletion; a visit's items reduce stock and never drive it below zero; the daily report adds up to the payments recorded that day; every page works without JavaScript, at 375 px, in light and dark mode.

## Slice order

| Slice | Content | Migration |
|---|---|---|
| 16 | Permissions (D25) | `008_permissions.sql` |
| 17 | Storage (D26) | `009_storage.sql` |
| 18 | Visit bill and payments (D27, D28) | `010_finance.sql` |
| 19 | Finance tab and charts (D29) | none |
| 20 | PDF documents (print HTML) and app-wide reach (D30) | none |

Each slice: tests first (`node:test`, `test/<slice>.test.js`), `npm test` green, commit.

## 1. Permissions (slice 16, D25)

### Model

`users.perms` is a JSON text column; `users.is_owner` is 0/1 with at most one owner (partial unique index). The `role` column stays for history and is no longer read.

```js
// src/lib/perms.js
export const AREAS = ['patients', 'documents', 'visits', 'storage', 'finance', 'pdf', 'data', 'users'];
// Areas whose highest level is view.
export const VIEW_ONLY = ['pdf', 'data', 'users'];
export const FLAGS = { // flag -> [area, level the area needs]
  patient_delete: ['patients', 2], document_delete: ['documents', 2],
  full_zip: ['data', 1], csv_import: ['data', 1],
  manage_users: ['users', 1], audit_log: ['users', 1],
  stock_adjust: ['storage', 2], finance_settings: ['finance', 2], price_override: ['finance', 2],
};
```

Levels: 0 none, 1 view, 2 edit. `parsePerms(text)` returns a clean object (unknown keys dropped, bad values become 0, a flag whose area is too low is off). The owner's object is always "everything". `can(user, area, level)` and `has(user, flag)` are the only checks used by routes and views.

Presets (code, not editable):

- «مدیر» `admin`: every area at its highest level, every flag.
- «کارمند» `staff`: patients 2, documents 2, visits 2, storage 1, pdf 1, the rest 0; flag `document_delete`.

Migration `008`: admins get the `admin` preset, staff the `staff` preset; the oldest active, not deleted admin becomes owner.

### Area meanings

| Area | View | Edit adds |
|---|---|---|
| patients | `/patients`, profile, `/search` and its exports, saved searches | new, edit, archive/unarchive, medications, standing discount needs finance edit |
| documents | gallery, open, download, photo view | upload, classify, photo change/remove |
| visits | `/visits`, timeline, today card, visit page, doctor's note | add, edit, status, delete visit, doctor's note |
| storage | `/storage`, item page with lots, alerts card | stock-in |
| finance | `/finance`, payments list, bill on visit page, history page, balance strip | lines, discounts, payments, refunds, moves, `/finance/pay` |
| pdf | `/print/*` (also needs view on each area the document shows) | — |
| data | `/data`, patients CSV/XLSX export | — |
| users | `/admin/users` list | — |

Flags: `patient_delete` → `/patients/:code/delete`; `document_delete` → file delete; `full_zip` → `/data/export/full.zip`; `csv_import` → `/data/import*`; `manage_users` → create, edit, password reset, (de)activate, delete users, permissions page, sees every saved search; `audit_log` → `/admin/audit`; `stock_adjust` → count correction and waste; `finance_settings` → `/finance/settings*` and catalog; `price_override` → line price override.

Patients view is a prerequisite: without it the user cannot reach any per-patient page (documents, visits, bills).

### Owner rules

- The owner always has everything; their perms cannot be edited, and they cannot be deactivated, deleted, or have their password reset by another user.
- `scripts/create-user.js <username> <admin|staff|owner>`: `owner` creates an admin-preset user and marks them owner if there is none yet.
- `scripts/set-owner.js <username>` moves ownership (server only).

### Routes and enforcement

- `requirePerm(area, level)` and `requireFlag(flag)` middleware in `src/auth.js` reply 403 with a Persian message; `requireAdmin` is removed.
- `loadSession` selects `perms` and `is_owner`; changes apply on the next request.
- Views use `can`/`has` through `res.locals` helpers; nothing the user may not do is shown (sidebar, tab bar, home tiles, profile buttons).
- `/admin/users/:id/permissions` GET/POST: preset select + «اعمال»; one card per area with radios and its flags; «ذخیره». Audited `user_perms` with `user=<id>`.
- New users: create form gets a preset select (default «کارمند»).

### Acceptance

- Migrated admin/staff behave exactly as before (existing test suite passes after replacing `role` checks).
- A user with patients view only gets 403 on `POST /patients`; the edit button is absent.
- Owner cannot be restricted, deactivated or deleted (403/400 with message); `set-owner.js` moves ownership.
- Flag without its area level has no effect.

## 2. Storage (slice 17, D26)

### Tables (`009_storage.sql`)

```sql
CREATE TABLE catalog (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('service','item')),
  name TEXT NOT NULL,
  sale_price INTEGER NOT NULL CHECK (sale_price >= 0),      -- Rial
  purchase_cost INTEGER CHECK (purchase_cost >= 0),          -- Rial, items only, never charged
  fixed INTEGER NOT NULL DEFAULT 0,                          -- shown first in settings (visit fee)
  low_warn INTEGER, low_crit INTEGER,                        -- per-item overrides, null = global
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE lots (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES catalog(id),
  received_on TEXT NOT NULL,                                 -- ISO date
  qty_in INTEGER NOT NULL CHECK (qty_in > 0),
  remaining INTEGER NOT NULL CHECK (remaining >= 0),
  expires_on TEXT,                                           -- ISO date or null
  unit_cost INTEGER CHECK (unit_cost >= 0),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE stock_moves (
  id INTEGER PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  qty INTEGER NOT NULL CHECK (qty <> 0),                     -- negative = out
  reason TEXT NOT NULL CHECK (reason IN ('in','use','return','count','waste')),
  line_id INTEGER,                                           -- bill line for use/return
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Settings keys: `currency` (`T`/`R`, default `T`), `low_warn` (10), `low_crit` (5), `clinic_name`, `clinic_address`, `clinic_phone`.

### Rules (`src/lib/stock.js`)

- Usable lot: `remaining > 0` and (`expires_on` is null or `expires_on >= today`). Order: `expires_on IS NULL, expires_on, id`.
- `takeStock(db, itemId, qty, {lineId, userId})`: inside `db.transaction`, sum usable remaining; if short, throw `StockShortError(available)`; else decrement lots in order and write one `use` move per lot touched.
- `returnStock(db, lineId, userId)`: reverse every `use` move of the line with `return` moves to the same lots.
- Adjustment (`stock_adjust`): count correction on one lot to a new remaining count (move = difference); waste on one lot (move negative, reason `waste`, note required).
- Item level: warning at `low_warn`, critical at `low_crit` (per-item override, else settings). Lot expiry: yellow when ≤30 days, red when ≤10 days, «منقضی شده» when past and remaining > 0.

### Pages

- `/storage`: items table (name, available, nearest expiry, alert chip), filter by alert; «کالای جدید» (needs `finance_settings`, because it creates a catalog row with a sale price), «ورود کالا» per item.
- `/storage/items/:id`: lots table (received, expiry chip, in, remaining, cost), stock-in form (quantity, Jalali expiry optional, unit cost optional), adjustment forms per lot (with `stock_adjust`), last 50 moves.
- Dashboard «هشدارها» card (storage view): red first, then yellow, each linking to the item.

### Acceptance

- Using 5 when lots hold 3 (expiring sooner) and 4 takes 3+2 and leaves 0 and 2.
- Using more than available writes nothing and returns the available count.
- An expired lot is never used and shows «منقضی شده» on the card until written off.
- Remaining can never go below zero (`CHECK` plus transaction).

## 3. Visit bill and payments (slice 18, D27-D28)

### Tables (`010_finance.sql`)

```sql
ALTER TABLE visits ADD COLUMN doctor_note TEXT;
ALTER TABLE visits ADD COLUMN disc_kind TEXT CHECK (disc_kind IN ('amount','percent'));
ALTER TABLE visits ADD COLUMN disc_value INTEGER NOT NULL DEFAULT 0 CHECK (disc_value >= 0);
ALTER TABLE patients ADD COLUMN disc_kind TEXT CHECK (disc_kind IN ('amount','percent'));
ALTER TABLE patients ADD COLUMN disc_value INTEGER NOT NULL DEFAULT 0 CHECK (disc_value >= 0);
CREATE TABLE bill_lines (
  id INTEGER PRIMARY KEY,
  visit_id INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  catalog_id INTEGER NOT NULL REFERENCES catalog(id),
  kind TEXT NOT NULL CHECK (kind IN ('service','item')),
  name TEXT NOT NULL,                       -- copied at the time
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),   -- frozen catalog price
  override_price INTEGER CHECK (override_price >= 0),
  disc_kind TEXT CHECK (disc_kind IN ('amount','percent')),
  disc_value INTEGER NOT NULL DEFAULT 0 CHECK (disc_value >= 0),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE pay_methods (id INTEGER PRIMARY KEY, name TEXT NOT NULL, default_account INTEGER, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  visit_id INTEGER NOT NULL REFERENCES visits(id),        -- no cascade: a visit with payments cannot be deleted
  amount INTEGER NOT NULL CHECK (amount <> 0),            -- Rial, negative for refund and move-out
  kind TEXT NOT NULL CHECK (kind IN ('payment','refund','move_out','move_in')),
  paid_on TEXT NOT NULL,                                  -- ISO date
  method_id INTEGER REFERENCES pay_methods(id),
  account_id INTEGER REFERENCES accounts(id),
  move_id INTEGER,                                        -- pairs move_out with move_in
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

Seeds: methods «نقدی», «کارت‌خوان», «کارت به کارت»; accounts «صندوق», «حساب بانکی»; method defaults point at them; a fixed service «ویزیت» priced 0 for the owner to set.

### Money (`src/lib/money.js`)

- Stored as whole Rial integers. Display: `formatMoney(rial, cur)` gives `1,250,000 T` (Toman = Rial / 10 rounded) or `12,500,000 R`; Latin digits, comma groups, no decimals.
- Input: `parseMoney(text, cur)` accepts Persian/Arabic digits, commas, spaces, an optional `T`/`R`/«تومان»/«ریال» suffix; returns Rial (Toman × 10) or null.

### Bill maths (`src/lib/bill.js`)

```
line gross  = (override_price ?? unit_price) × qty
line disc   = amount: min(value, gross); percent: round(gross × value / 100)
line net    = gross − line disc
subtotal    = Σ line net
bill disc   = same rule on subtotal (visit's disc_kind/value)
owed        = cancelled visit ? 0 : subtotal − bill disc
paid        = Σ payments.amount (all kinds)
remaining   = max(owed − paid, 0);  credit = max(paid − owed, 0)
```

The patient's standing discount is copied into the visit's bill discount when the first line is added (only if the visit has none).

### Behaviour

- Adding an item line takes stock in the same transaction; deleting it returns stock. Changing an item line's quantity is delete + add.
- Status change to cancelled returns stock of every item line; back to scheduled/done takes it again (refused if short).
- Deleting a visit or patient with any payment row: refused (409) with «ابتدا پرداخت‌ها را بازپرداخت یا منتقل کنید.» Otherwise stock is returned, then rows cascade.
- «پرداخت کامل» records the current remaining amount (refused when zero).
- Refund: amount ≤ credit, method and account required. Move: amount ≤ credit, target visit of the same patient, not cancelled.
- Payment edit/delete: finance edit; amounts keep their sign rules; moves are deleted as a pair.
- Audit: `bill_line_add line=<id> visit=<id> catalog=<id> qty=<n>`, `price_override`, `payment visit=<id> amount=<rial>`, etc. No names.

### Pages

- `/visits/:id` visit page (see #6): header, «شرح پزشک», «صورتحساب» lines with add row and green «افزودن», discounts, totals, «پرداخت‌ها», print links.
- `/patients/:code/history` «سوابق درمان و مالی».

### Acceptance

- Line price is frozen: changing the catalog price later leaves old lines unchanged.
- 1,000,000 R with 10% line discount and 50,000 R bill discount owes 850,000 R.
- Prepayment on a scheduled visit counts on its payment day.
- Cancelling a paid visit shows credit; a refund brings it to zero; moving it shows on the target visit.
- Visit with payments cannot be deleted.

## 4. Finance tab (slice 19, D29)

- `/finance` overview: income today / this Jalali week (Saturday start) / this Jalali month; total remaining and total credit across all visits; four SVG charts: income per day (30 days), income per Jalali month (6 months), revenue by source this month (services vs items, top services), pieces used per day (30 days, storage view).
- `/finance/payments`: filters `from`, `to` (Jalali), `method`, `account`, `kind`; 50 per page; totals of the filtered rows.
- `/finance/pay`: patient search (`q`), then the patient's unpaid or planned visits, then the payment form (posts to the visit's payment route, returns to `/finance/pay`).
- `/finance/settings` (`finance_settings`): currency, clinic letterhead, alert defaults, catalog (add, edit price, deactivate, delete if never used), methods, accounts (same rules).
- Charts: `src/lib/charts.js` returns SVG strings built from numbers only (no user text except escaped labels), styled with CSS classes; `role="img"` and an `aria-label` summary, plus a visually hidden table.

### Acceptance

- Overview income today equals the sum of today's payment rows.
- Charts render without JavaScript and pass the CSP.
- Settings refused (403) without `finance_settings`.

## 5. PDF documents and app-wide reach (slice 20, D30)

### Documents (print-styled HTML, `views/print/*`, `public/css/print.css`)

| Route | Document | Needs |
|---|---|---|
| `/print/finance/day?d=` | Daily finance report | pdf, finance view |
| `/print/visits/day?d=` | Day visit list | pdf, visits view, finance view |
| `/print/stock/usage?from=&to=&by=item\|patient` | Items used | pdf, storage view |
| `/print/visits/:id/bill` | Visit bill (A5) | pdf, finance view |
| `/print/patients/:code` | Full patient record | pdf, patients view (bills only with finance view) |

The frame: letterhead, thin sage border with corner ornaments, faint watermark, title block with parameters, tables, totals card, footer with generated time and user. Pages carry a «چاپ / ذخیره PDF» link that works without JS (`window.print` is not used; the link explains Ctrl+P), and `@media print` hides it. Downloading one is audited `print <doc>`.

A server PDF engine (headless Chromium per the spike, or Typst) is a later step that needs the owner's approval for the dependency; the HTML pages are its input.

### Reach

- Profile balance strip and history link (finance view); standing discount form (finance edit).
- Search fields `balance` (number) and `has_credit` (yes/no), only with finance view.
- Full zip: `bills.csv` per patient folder and `finance/payments.csv` with finance view; `storage/lots.csv`, `storage/moves.csv` with storage view.
- Dashboard: «هشدارها» (storage view), «درآمد امروز» (finance view).

## Boundaries

- Always: parameterized SQL, whitelisted fields, same-origin POST, audit without patient data, logical CSS properties, Persian UI, Jalali display.
- Ask first: new npm dependency (PDF engine), public repo release.
- Never: inline script or style attribute, physical left/right CSS, money as floats, deleting payment history.
