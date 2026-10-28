# Glossary

Shared language for the clinic app. Persian UI term in brackets where one is fixed.

## Patients and visits

**Patient** — a person with a record and a patient code.

**Patient code** — the patient's number, such as `P-000123`, which also names the patient's folder. Staff with permission can change it by hand; no two patients share one.

**Visit** [ویزیت] — one planned or past appointment of a patient with the clinic's single doctor. Has a status: scheduled, done or cancelled.

**Visit number** — the position of a visit among the patient's non-cancelled visits, by date ("first, second…"). May shift when an earlier visit is cancelled.

**Doctor's note** [شرح پزشک] — what the doctor writes about a visit. Distinct from the visit's general notes.

**Treatment and finance history** [سوابق درمان و مالی] — the page of one patient listing all their visits, services, items, bills and payments.

**Uploaded document** [مدارک] — a file stored in the patient's folder (PDF, image, DICOM). Never called a "PDF document" or "form".

## Storage

**Stock item** [کالا] — something the clinic keeps and uses on patients, such as an ampoule or a glove. Counted in pieces, never boxes. A count may be part of a piece, such as 0.5 of an ampoule.

**Stock-in** [ورود کالا] — recording that the clinic bought some quantity of a stock item, with an optional purchase cost and an optional expiry date.

**Lot** — the stock left from one stock-in, with its own expiry date and remaining count. A stock item is the sum of its lots.

**Use** — taking stock out for a visit. Always taken from the earliest-expiring usable lot first.

**Adjustment** — a correction to stock outside a visit: a count correction or waste, always with a reason. Writing off an expired lot is waste.

**Low-stock alert** — a warning (default at 10 pieces) or critical (default at 5) level, set globally and overridable per stock item.

**Expiry alert** — yellow from 30 days before a lot's expiry, red from 10 days before, and «منقضی شده» once expired until the lot is written off. An expired lot cannot be used.

**Alerts card** [هشدارها] — the dashboard card listing low-stock and expiry alerts.

## Finance

**Catalog** — the clinic-defined list of services and stock items with their sale prices. Includes fixed prices such as the visit fee.

**Service** [خدمت] — a chargeable act that is not stock, such as a visit fee or an operation fee.

**Sale price** — what a patient is charged for a catalog entry. Required.

**Purchase cost** — what the clinic paid a provider for a stock item. Optional, never charged to the patient.

**Visit bill** [صورتحساب] — the charges of one visit: its lines, discounts and payments.

**Line** — one service or stock item on a visit bill, with quantity and the price frozen at the moment it was added. Its price may be overridden for that bill only.

**Discount** [تخفیف] — a reduction given as an amount or a percent, on a line, on a whole bill, or as a patient's standing discount applied to their new bills.

**Payment** [پرداخت] — money received for one visit, with an amount, a date, a payment method and a clinic account. A bill may have several.

**Prepayment** [پیش‌پرداخت] — a payment made before the visit has happened.

**Refund** — money paid back to a patient, recorded with a method and account.

**Payment method** — how money moved: cash, card, mobile transfer and so on. An editable list.

**Clinic account** — where the money went: the cash box or a bank account. An editable list.

**Remaining** [مانده] — what a patient still owes on a bill: total minus discounts minus payments.

**Credit** [بستانکار] — money a patient has paid beyond what a bill now owes, for example after a cancelled visit with a prepayment.

**Income** — payments counted on the day they were received, never on the visit's day.

**Display currency** — Rial or Toman, one switch for the whole site. Every amount carries an `R` or `T`.

## PDF documents

**PDF document** [فرم چاپی] — a generated, styled, ready-to-print report such as a daily finance report or a visit bill. Never called just "document", which means an uploaded document.

**Full daily report** [گزارش کامل روزانه] — a PDF document listing the visits held on one day: for each visit, the patient, the visit time and reason, every line with its quantity and amount (stock items highlighted), what the patient had to pay, and each payment with its method and clinic account. It ends with a sum per clinic account. Distinct from the daily finance report, which lists the payments received on one day.

**Daily product report** [گزارش روزانه‌ی مصرف کالا] — a PDF document listing only the stock items used in the visits of one day, per patient, with a sum per stock item.

**Stock on hand** [موجودی انبار] — a PDF document listing every stock item with its usable count and each lot still holding stock, with its expiry date and alert.

**Thousands grouping** — the commas that split a typed amount into groups of three digits (`1,250,000`) while it is being typed.

## Messaging

**SMS provider** — the outside company that delivers the clinic's text messages to patients' phones. The clinic holds its own account there and pays for its credit.

**Reminder** [یادآوری] — a text message sent automatically, with no one pressing a button, to tell a patient about a scheduled visit. It is filled from the patient's profile and the visit, never typed by the clerk.

**Lead time** [زمان یادآوری] — how long before a visit its reminder goes out: right away, 2 hours, 1 day, 2 days, or none. The clinic sets a default and the clerk can change it for one visit.

**Sending window** — the hours of the day when the clinic allows text messages to go out, 08:00 to 21:00. A message due outside it waits for the window to open.

**Reminder state** — what the visit card says about the visit's reminder: waiting for its send time, sent, failed with the reason, or skipped with the reason.

**Custom message** [پیامک دستی] — a text message a staff member writes and sends to one patient.

**Bulk message** [پیامک گروهی] — one custom message sent by a staff member to a group of patients at once, such as the result of a saved search.

**Message template** — the clinic's wording for a kind of message, with blanks such as the patient's name and the visit time filled in when it is sent. Never holds medical information.

**SMS opt-out** — a patient's choice not to receive any text messages from the clinic. Patients receive messages unless they opt out.

## Access

**Owner** — the protected account of the person who runs the site. Always has every permission and cannot be restricted or deleted.

**Permission** — what one user may do in one area: none, view or edit, plus extra checkboxes for dangerous actions. A missing permission means the feature is both hidden and refused.

**Preset** — a named set of permissions applied to a user in one step, then fine-tuned.
