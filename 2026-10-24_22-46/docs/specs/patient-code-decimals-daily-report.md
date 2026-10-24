# Spec: editable patient code, decimal quantities, daily reports, thousands grouping

Status: built on 2026-10-24 (slices 24-27). Map: https://github.com/MMACABRE/AfshinAmini.clinic.icu/issues/23.
The owner set the scope while charting and then asked the agent to decide every open ticket and build the result
in one go. Lines marked **(agent)** are the agent's decisions for the owner's review; the rest came from the owner.

Vocabulary: `GLOSSARY.md` terms "Patient code", "Stock item", "Full daily report", "Daily product report", "Stock on hand", "Thousands grouping".

## 1. Changing a patient code (D36, ticket #24)

Owner: staff can change a patient's code by hand, the format stays `P-` plus 6 digits, and a permission checkbox
guards it. This replaces "immutable" in D13 and D31.

- **(agent)** New flag `patient_code` «تغییر کد بیمار» in the patients area (needs patients edit). The «مدیر»
  preset has it; migration `012` adds it to existing users on that preset; «کارمند» does not have it. The owner
  always has every flag.
- **(agent)** Its own small form «تغییر کد بیمار» at the bottom of the patient's edit page (`#code`), separate from
  the main form so nobody changes a code by accident while fixing a name. The new code is typed twice. It accepts
  `P-000123`, `p-123`, `123` and Persian digits, the same as the CSV column (`parseCodeCell`).
- **(agent)** Refused with a Persian message (422): a code another patient holds; a code whose folder exists in
  `data/patients/` (a deleted patient's leftover or a hand copy, D31); the patient's current code; a malformed
  value; two entries that differ. Trash folders do not block a code.
- **(agent)** The row update, the audit row and the folder rename run in one transaction, with the rename last, so a
  failed rename rolls the row back. If the commit fails after the rename, the folder is renamed back. Every other
  table points at the row id, so screens, the full zip, CSV exports, printed documents, the SMS log and saved
  searches by name follow at once.
- **(agent)** The old code is free afterwards, like a deleted patient's code (D31). The next automatic code stays
  "highest code + 1", so typing `P-900000` makes the next new patient `P-900001`.
- **(agent)** Audit action `patient_code`, detail `P-000005 → P-000123`. The audit search by code finds the patient
  by either side. Saved searches that filter on the old code stop matching. Old links to `/patients/P-old` show
  "not found"; there is no redirect.
- Known edge: a file copied by hand into the old folder at the very moment of the change lands in a new folder with
  the old code. That folder then keeps the old code from being given out, so the file never reaches another patient.

Code: `changePatientCode` in `src/lib/patient-store.js`, `POST /patients/:code/code` in `src/routes/patients.js`,
form in `views/patients/form.ejs`, `migrations/012_patient_code_flag.sql`. Tests: `test/patient-code-change.test.js`.

## 2. Decimal quantities (D37, ticket #25)

Owner: a bill line's quantity may be a decimal number, and stock counts follow, so stock may hold part of a piece.
This changes "pieces only" in D26.

- **(agent)** Every stock item and every service may take a fraction. There is no per-item "divisible" switch and
  no unit name; a unit name can come later if the clinic asks.
- **(agent)** At most two decimal places (`0.5`, `1.25`). The box accepts Persian and Arabic digits and the decimal
  signs `.`, `٫`, `/` and a comma before one or two digits (`0,5`). A comma before exactly three digits is a
  thousands group (`1,000`). The quantity boxes open the decimal keyboard on phones (`inputmode="decimal"`).
- **(agent)** Stock-in, count corrections, waste, and the low-stock levels (global and per item) take fractions too.
- **(agent)** A line amount is unit price × quantity, rounded to whole Rial per line, half up
  (`lineGross` in `src/lib/bill.js`). Discounts and totals then work on whole Rial as before.
- **(agent)** Storage: SQLite keeps a fraction as REAL in the existing INTEGER columns (`bill_lines.qty`,
  `lots.qty_in`, `lots.remaining`, `stock_moves.qty`, `catalog.low_*`), so no migration was needed and existing whole
  numbers stay exactly as they are. Every sum and difference is rounded to two places in SQL (`ROUND(..., 2)`) and in
  JavaScript (`roundQty`), so float noise such as 0.1 + 0.2 never reaches a comparison or the screen.
- **(agent)** Display: Persian digits with the Persian decimal sign («۰٫۵»), on screen and in printed documents
  (`faDigits` turns a dot between digits into «٫»). CSV exports keep Latin digits and a dot.

Code: `src/lib/qty.js` (`parseQty`, `roundQty`), `src/lib/stock.js`, `src/lib/bill.js`, the storage, bill and
finance-settings routes. Tests: `test/decimals.test.js`.

## 3. Full daily report (D38, ticket #26)

Owner: a new daily report on the printed forms page `/print`, built from the visits held that day, labelled
«بر اساس روز ویزیت». Per visit: patient code, name, visit reason, every line (services and stock items) with
quantity, unit price and amount, what the patient had to pay («قابل پرداخت»), and one row per payment with method
and clinic account. It ends with only a sum per clinic account, plus total owed and total paid.

- Owner after review (2026-10-24): title «گزارش کامل روزانه»; a thick sage rule between two patients; the visit hour larger (a framed box); product rows highlighted apart from services (warm tint, a bar on the start edge, a filled «کالا» chip; the footnote explains the colour).
- **(agent)** Route `GET /print/visits/report?d=<Jalali day>`, A4 portrait like the
  other daily forms. A card on `/print` with a day picker. Needs finance, visits and patients view (the same as the
  day visit list); audited as `print` with detail `visits_report <day>`.
- **(agent)** One block per visit, ordered by time: a tinted head row (number, code, name, time, visit reason), the
  lines, a line discount as a small note under its line, a bill discount as its own negative row, «قابل پرداخت»,
  then the payments, then «مانده» or «بستانکار» when not zero. A block stays on one printed page where it fits.
- **(agent)** Cancelled visits are left out. A visit with no lines or no payment says so in a muted row.
- **(agent)** Payments show whatever day they were made; one made on another day (a prepayment) shows its date in
  brackets. Refunds show as negative rows and are subtracted in the account sum. Credit moved between visits shows on
  both visits but has no account, so it stays out of the account sum; the footnote says so.
- **(agent)** No CSV or Excel download for this report in this version. The daily finance report stays as it was.

Code: `src/routes/print.js`, `views/print/visits-report.ejs`, report rules in `public/css/print.css`, card in
`views/print/index.ejs`. Tests: `test/visits-report.test.js`.

## 4. Thousands grouping while typing (D39, ticket #27)

Owner: every box where an amount is typed shows commas while the user types (`1,250,000`). Quantity and percent
boxes are not grouped.

- **(agent)** Applies to every `input.input-money` (catalog prices, purchase cost, stock-in unit cost, amount
  discounts, payments, refunds, price overrides). A percent typed into a discount box has at most three digits, so
  it never gets a comma.
- **(agent)** Persian and Arabic digits become Latin digits at once, matching how amounts are shown.
- **(agent)** The cursor keeps its place among the digits. Backspace just after a comma, or Delete just before one,
  removes the digit beyond the comma.
- **(agent)** A pasted value with anything other than digits and separators (`50000 R`, `1,250,000 T`) is left as
  typed, so the server reads the currency suffix (`parseMoney`) instead of the box silently dropping it.
- Without JavaScript the box is a plain text box and the server strips the commas, as before (D20).

Code: `enhanceMoney` in `public/js/app.js`. Checked in Chrome; there is no unit test for browser code in this repo.

## 5. Daily product report (D40, owner 2026-10-24)

Owner: another form like the full daily report that only covers the used products and who used them.

- **(agent)** «گزارش روزانه‌ی مصرف کالا», `GET /print/stock/day?d=<Jalali day>`, card on `/print`. Needs storage, patients and visits view (it names patients and visit times).
- **(agent)** The same visit blocks (number, code, name, hour, reason), only stock-item lines with quantity, unit price and amount after the line discount. Services, payments and patients who used no product are left out; cancelled visits too (their stock went back).
- **(agent)** Then «جمع به تفکیک کالا»: per item the number of patients, the total quantity and the amount, plus the total amount.

Code: `src/routes/print.js`, `views/print/stock-day.ejs`. Tests: `test/stock-print.test.js`.

## 6. Stock on hand (D41, owner 2026-10-24)

Owner: a form with all storage products, how much there is, and until when (expiry).

- **(agent)** «موجودی انبار», `GET /print/stock/inventory`, card on `/print` and a «چاپ موجودی انبار» button on `/storage`. Needs storage view. Shows today's state; no date picker.
- **(agent)** One block per active stock item: name, usable count (expired lots excluded), a low or critical stock chip. Under it one row per lot still holding stock, earliest expiry first: received date, quantity in, remaining, expiry date with days left or past, and a state chip (سالم, انقضا در ۳۰ روز, انقضای نزدیک, منقضی شده). An item with no stock says so.

Code: `src/routes/print.js`, `views/print/stock-inventory.ejs`. Tests: `test/stock-print.test.js`.

## Slices and checks

| Slice | Content | Commit |
|---|---|---|
| 24 | Decimal quantities (D37) | `feat(stock): allow decimal quantities up to two places` |
| 25 | Patient code change (D36) and thousands grouping (D39) | `feat(patients): change a patient code by hand` |
| 26 | Daily visit report (D38) | `feat(print): add the daily visit report` |
| 27 | Full daily report polish, daily product report (D40), stock on hand (D41) | `feat(print): add the daily product report and stock on hand` |

`npm test` 353/354 (1 skipped on Windows). Headless Chrome at 1440, 900 and 375 px, light and dark, on the visit
page, the report, the edit page with the code form, the profile, storage list and item, `/print` and finance
settings: no horizontal scroll, no console errors.

## Open for the owner

- Review every **(agent)** line above.
- Persian wording of the new strings (form labels, errors, the report footnote).
- Whether stock items need a unit name (ml, gram) beside fractional quantities.
- Ready to publish to the public repo when the owner says so (CLAUDE.md rule 9).
