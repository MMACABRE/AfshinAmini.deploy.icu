# Spec: patient form layout and dashboard layout (D52, D53, D54)

Source: wayfinder map "Wayfinder map: patient form layout and dashboard layout" (issue #34). The owner settled the scope and behaviour on 2026-11-02. On the same day the owner asked the agent to resolve the remaining tickets and leave the build alone. Points marked **(agent)** were decided by the agent and wait for the owner's review. The look was picked by the agent from three prototypes per editor (throwaway branch `prototype/layouts`) and is open to change once the owner sees it in a browser.

**The owner approved this spec, including the (agent) points and the variant A looks, on 2026-11-02.** The owner decides the build workflow next.

## Objective

Different clinics record different things about a patient. Today the «بیمار جدید» form shows about 25 boxes in seven cards to every clinic. Each clinic should be able to keep only the boxes it uses, put them in its own order, mark some as required, and add boxes of its own. The dashboard gets the same treatment: the clinic chooses which widgets show, where, and at which size.

Users: anyone with the new permission flag `layout` («تنظیم فرم بیمار»), which is in the «مدیر» preset and not in «کارمند». Everyone else sees the result.

## Terms

From `GLOSSARY.md`: **patient form layout** «چیدمان فرم بیمار», **box** «کادر», **custom box**, **hidden box**, **dashboard layout** «چیدمان داشبورد». A dashboard piece is a **widget**. The word is never used for a box on the patient form.

## D52: patient form layout

### Where it applies

- The «بیمار جدید» form and the edit form follow the layout.
- The edit form has a link «نمایش همه‌ی کادرها» under the last card. It opens the hidden boxes in one extra card «سایر کادرها», so a value saved before a box was hidden can still be read and changed.
- The profile page does not change and shows every saved value.
- The search builder, CSV import and export, and the full zip keep every box, built-in and custom, shown or hidden (D53).

### Rules

- Cards hold boxes on a strict grid: two columns, one under 600 px. A box is never resized: long text, address, allergies, conditions, clinical notes and visit reason are full width; every other box is half width.
- Box names and built-in card names are fixed. A custom box or card is named once, when created.
- First name and last name can never be hidden. Hiding the phone box is allowed, but the editor warns that SMS reminders need it, and the SMS screens already handle a patient without a phone.
- «کد بیمار» stays fixed on top of the new-patient form, and the «مدارک» drop box stays fixed at the bottom (D48, D49). Neither is part of the layout.
- A card with no boxes is not shown on the form.
- Any box may be marked required. Required is checked on both forms. A patient saved before a box became required stays valid. Their edit form shows the box as required, and saving asks for it like any required field. CSV import does not check "required" (D53). **(agent)**
- Up to 12 cards and 80 boxes in total; the limits stop runaway data, not real use. **(agent)**

### The editor (look picked from the prototype, variant A) **(agent)**

- Page `GET /patients/layout`, titled «چیدمان فرم بیمار». A «چیدمان فرم» button in the patients list page head opens it, shown only with the `layout` flag.
- The editor shows the form as staff will see it. Each box keeps its real input, greyed and not editable, under a tool row: a grip (drag handle), the name, a «الزامی» pill and a × that removes the box. The pill turns terracotta when on, and the label gets a terracotta `*`. First and last name show a grey «همیشه» chip instead of pill and ×. The tools sit at 55 % opacity until the box is hovered or focused, and at full opacity on touch screens.
- Card header: grip, name, box count («۶ کادر»), and ↑ ↓ buttons. A card with no boxes says «خالی، در فرم دیده نمی‌شود» and shows a dashed drop area.
- «کد بیمار» and «مدارک پزشکی» show as fixed grey bars at top and bottom.
- Tray «افزودن کادر» at the inline end, 320 px wide and sticky. It lists the hidden built-in boxes, the custom boxes that are hidden, the six new box types as a two-column grid of small icon tiles, and a dashed «کارت تازه» button. Items can be dragged onto the form, or tapped to land at the end of the first card. Under 900 px the tray is a bottom sheet opened by a floating «افزودن کادر» button.
- A new box or card is named where it lands. There is an input, a second input «گزینه‌ها، با ویرگول جدا» for a choice box, a «ثبت نام» button, and the note «نام بعداً عوض نمی‌شود.». Until it has a name, the draft cannot be saved.
- Dragging: the box lifts with a soft shadow and a slight tilt. The drop spot is a terracotta dashed outline on a pale terracotta wash. A dropped box flashes sage once (no animation under `prefers-reduced-motion`).
- A draft bar is sticky at the foot. It shows «بدون تغییر», or «n تغییر ذخیره‌نشده» with a terracotta dot. It holds the SMS warning chip when the phone box is hidden, and the buttons «بازگشت به پیش‌فرض», «چیدمان قبلی», «انصراف» and «ذخیره». On phones only the state, «انصراف» and «ذخیره» stay in the bar; the other two move to the foot of the page.
- Leaving the page with unsaved changes does not warn (no `beforeunload`). «انصراف» reloads the saved layout.

## D53: custom boxes

### Types

| Type | Input | Stored value | Size |
|---|---|---|---|
| `short_text` «متن کوتاه» | text, up to 200 characters | text after `normalizeText` | half |
| `long_text` «متن بلند» | textarea, up to 5000 characters | text after `normalizeText` | full |
| `number` «عدد» | text, `inputmode="decimal"`, up to two decimal places | ASCII decimal (`68.5`) | half |
| `date` «تاریخ» | Jalali date text box, like birth date | ISO `YYYY-MM-DD` | half |
| `choice` «انتخاب از فهرست» | select, 2 to 30 choices | choice id | half |
| `yes_no` «بله / خیر» | two radio buttons «بله» «خیر» plus none | `1` or `0` | half |

**(agent)** for the limits.

### Rules

- A name is 1 to 60 characters and unique among live custom boxes and built-in box names, compared after `faKey`. CSV headers therefore never clash.
- Choices keep an id for life. A choice no patient uses can be removed. A used choice can only be hidden from the form; it still shows on the profile and in exports. **(agent)**
- Removing a custom box from the layout hides it. Deleting it for good is allowed only while no patient has a value in it, and asks for confirmation with the confirm-delete partial. The row then gets `deleted_at` and its id is never given out again.
- Values are checked on the server with the same rules as the form, and through the same function for the form and for CSV import.

### Search, CSV, zip (agent)

- **Search builder:** every live custom box, shown or hidden, joins the field list under its name, key `c<id>`. The server accepts the key only for a live box id read from the table. The SQL is fixed per type: `EXISTS (SELECT 1 FROM patient_values pv WHERE pv.patient_id = patients.id AND pv.box_id = ? AND <operator on pv.value>)`, with the box id and the value bound as parameters. Operators reuse today's sets: text gets `contains`, `not_contains` and `equals` through `fa_key`; number gets `eq`, `lt`, `gt` and `between` on `CAST(pv.value AS REAL)`; date gets `before`, `after` and `between`; choice gets `is` and `is_not`; yes/no gets `is`. "Not contains" and "is not" also match patients with no value, as built-in fields do today.
- **CSV export, Excel, `patients.csv` and every `info.csv`:** custom columns come after the built-in columns, in layout order, then hidden custom boxes in creation order. The header is the box name. A cell holds what people read: the text, the number with `.` as decimal point, the Jalali date `1403/05/12`, the choice label, «بله» or «خیر». `safeCell` guards every cell. One shared function builds all four.
- **CSV import:** a header matches a live custom box by name after `faKey`. Each cell goes through the form's check: a choice label must match exactly after normalization, and yes/no takes «بله» / «خیر» / `1` / `0` / `yes` / `no`. A bad cell fails its line with a Persian message. Import fills hidden boxes too and does not check required. The import template lists the custom boxes shown on the form after the built-in template columns.

## D54: dashboard layout

### Rules

- One dashboard layout per clinic, the same for every user. A widget the user has no permission for is left out of their grid, and dense packing closes the gap.
- A strict grid: 4 columns, rows 148 px, `grid-auto-flow: dense`. Under 900 px: 2 columns, a 4-wide widget becomes 2 wide, and rows grow with their content (at least 120 px).
- Each widget has 2 or 3 allowed sizes (columns × rows); resizing steps through them, never a free size. The first size is the default. **(agent)**

| Widget | Sizes |
|---|---|
| «دسترسی سریع» | 4×2, 4×1, 2×2 |
| «بیماران فعال», «در انتظار», «بحرانی» | 1×1, 2×1 |
| «درآمد امروز» | 2×1, 1×1 |
| «ویزیت‌های امروز» | 2×2, 4×2, 2×3 |
| «هشدارها» | 2×2, 2×1 |
| «پیامک» | 2×1, 2×2 |
| «آخرین پرونده‌های به‌روزشده» | 4×2, 2×2 |

- «دسترسی سریع» holds an ordered list of buttons from today's tile list (`views/home.ejs`). Buttons can be added, removed and reordered. A user sees only the buttons their permissions allow. The first button the user sees keeps today's large sage style.
- The clock card stays in the page head, outside the layout.

### Edit mode (look picked from the prototype, variant A) **(agent)**

- A «چیدمان» button in the dashboard page head, shown only with the `layout` flag. It links to `/?edit=1`. While edit mode is on the button is filled dark (ink), and the draft bar from D52 appears.
- Every widget keeps its real content and gets a dashed sage outline, solid on hover. Its header has a grip, the name, a size pill and ×. The pill draws a tiny 4×3 grid with the widget's cells filled in sage, next to «۲×۲»; each press steps to the next allowed size.
- The last cell is a dashed «افزودن کارت» tile listing the removed widgets as chips. Drag one in, or tap it.
- Inside «دسترسی سریع» each button gets a grip and ×. A dashed «+ دکمه» cell opens a short list of the buttons not shown.

## Shared behaviour of both editors

### Moving things (from the research ticket on drag and drop)

- Pointer Events only, no library, no HTML Drag and Drop API. `touch-action: none` sits on the grip alone, so the page still scrolls under a finger elsewhere. `setPointerCapture` on the grip. The page scrolls by itself when a dragged item is within 72 px of the top or bottom edge. A move under 6 px is a tap, not a drag.
- Keyboard on a grip: Space or Enter picks the item up, the arrow keys move it one place, Enter drops it, Esc puts it back. In right-to-left, ArrowRight and ArrowUp move earlier. A box at the start or end of a card moves into the previous or next card. Each move is announced in a polite live region, for example «جای ۳ از ۷ در «هویت»». Moving a focused node blurs it: the code re-focuses the grip and ignores that blur.
- Single-pointer alternatives without dragging (WCAG 2.5.7): the ↑ ↓ buttons on cards, tapping a tray item to add it, the size pill, and ×. Every control is at least 44 px on phones.

### Draft, save, undo, reset

- Edits are a draft in the page until «ذخیره». Saving posts the whole layout as JSON in a hidden form field (`layout`) to `POST /patients/layout` or `POST /dashboard/layout`, with the usual same-origin check.
- «چیدمان قبلی» posts to `.../undo`, which swaps the current and previous saved layouts, so an undo can itself be undone. One step is kept.
- «بازگشت به پیش‌فرض» posts to `.../reset`. It saves the default layout as the current one (the old one becomes the previous one, so a reset can be undone). Custom boxes stay defined but end up hidden.

### Without JavaScript (D20)

- Patient form editor: one plain form. Each card has an order number. Each box has a «نمایش» checkbox, a card select, an order number and a «الزامی» checkbox. Below it a separate form creates a custom box (type select, name, choices textarea) and lists custom boxes with their delete button. The server builds the layout from these fields and checks it like the JSON.
- Dashboard: `/?edit=1` without JS shows the same widgets with a «نمایش» checkbox, a size select and an order number each, plus checkboxes and order numbers for the quick buttons, and one save button.
- The fallbacks get no design effort beyond the app's normal form styles.

## Data (agent)

Migration `017_layouts.sql`, append only:

```sql
CREATE TABLE layouts (
  name TEXT PRIMARY KEY CHECK (name IN ('patient_form', 'dashboard')),
  current TEXT NOT NULL,
  previous TEXT,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);
CREATE TABLE custom_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('short_text', 'long_text', 'number', 'date', 'choice', 'yes_no')),
  label TEXT NOT NULL,
  choices TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE patient_values (
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  box_id INTEGER NOT NULL REFERENCES custom_boxes(id),
  value TEXT NOT NULL,
  PRIMARY KEY (patient_id, box_id)
);
```

- No `layouts` row means the default: today's form and today's dashboard. An update therefore changes nothing until a clinic edits.
- Layout JSON, version 1:
  - patient form: `{"v":1,"cards":[{"id":"identity","boxes":[{"id":"first_name","req":true},{"id":"c:3"}]},{"id":"card:2","label":"پوست","boxes":[]}]}`
  - dashboard: `{"v":1,"widgets":[{"id":"today_visits","size":"2x2"}],"quick":["new_patient","search"]}`

  Built-in card ids: `identity`, `visit`, `contact`, `emergency`, `insurance`, `medical`. Custom cards are `card:<n>` and carry their label.
- `choices` is JSON `[{"id":1,"label":"خشک","hidden":false}]`.
- An empty custom box has no `patient_values` row. Saving a patient writes their custom values in the same transaction as the patient row.
- Everything lives in `clinic.db`, so the nightly backup and the DB snapshot in the full zip carry it with no new code. With several clinics per server (`multiple-clinic.md`, not built), each clinic has its own database and so its own layouts.

### `src/lib/layouts.js`

One module owns both layouts and custom boxes:

- `defaultFormLayout()`, `defaultDashboardLayout()`.
- `readLayout(db, name)` is forgiving. It drops unknown ids and duplicates, puts first and last name back into their card when missing, and returns the default for a row that does not parse, logging one line with no patient data. A broken row can never break the form.
- `checkLayout(db, name, json)` is strict, for saving. It rejects anything over 64 KB, an unknown or deleted id, a duplicate, missing first or last name, an unknown size for a widget, a card label outside 1-40 characters, and anything over the limits. It returns a clean object built only from known ids; the request's JSON is never stored as sent.
- `saveLayout`, `undoLayout`, `resetLayout`, each in one transaction, each audited.
- `createCustomBox`, `deleteCustomBox` (refuses while values exist), `customValues(db, patientId)`, `checkCustomValue(box, raw)` shared by the form and CSV import.

## Routes and permissions

New flag `layout` («تنظیم فرم بیمار») in `FLAGS` (`src/lib/perms.js`), in the «مدیر» preset. Rules in `src/lib/route-perms.js`, placed **before** the open `GET /patients(/seg)?` rule:

| Method | Path | Rule |
|---|---|---|
| GET, POST | `/patients/layout` | flag `layout` (plus patients view, as for every `/patients` path) |
| POST | `/patients/layout/(undo\|reset)` | flag `layout` |
| POST | `/patients/layout/boxes`, `/patients/layout/boxes/<id>/delete` | flag `layout` |
| POST | `/dashboard/layout(/undo\|/reset)?` | flag `layout` |

- `GET /?edit=1` stays on the open `/` rule; the view enters edit mode only with the flag.
- The patients router must register `/patients/layout` before `/patients/:code`. `layout` can never be a patient code (`P-` plus digits), but the order makes that obvious.
- Audit actions: `layout.save`, `layout.undo`, `layout.reset` (detail: `patient_form` or `dashboard`), `custom_box.create`, `custom_box.delete` (detail: the box id and type, never the name if it could hold patient data; box names are clinic vocabulary, so the name is allowed). Values of custom boxes go through the existing patient create and edit audit lines.

## CSS and markup rules learned from the prototype

- The CSP (`default-src 'self'`) blocks `style=""` attributes. Widget sizes and box spans come from `data-size` (and the existing `span-2` class) matched in CSS. Never write an inline style attribute in a view. Setting `el.style` from `app.js` is allowed (the drag ghost uses it).
- The editors' styles go in a new `public/css/page-layouts.css`, with the dashboard grid rules in `page-dashboard.css`. Logical properties only. Sage leads; terracotta marks only the required mark, unsaved changes and the drop spot.
- All behaviour goes in `public/js/app.js` as enhancers. No new script file and no inline script (`OTHER_SCRIPT` test).

## Tests to write

- `checkLayout`: unknown id, duplicate, missing first name, a size not allowed for a widget, oversize JSON, a deleted custom box, and a custom card label that is too long are each rejected. A good layout comes back clean.
- `readLayout`: a broken row gives the default; an unknown id is dropped; a missing last name is put back.
- Routes: 403 without the flag for every new route; save, undo, undo again and reset round-trip; `permissions.test.js` stays green.
- New-patient and edit forms: a hidden box is not rendered; a required custom box is enforced; an old patient missing a newly required value is asked for it on edit; «نمایش همه‌ی کادرها» shows hidden boxes with their values.
- Custom boxes: create, name clash with a built-in box after `faKey`, delete refused while values exist, a used choice cannot be removed.
- Search on each custom type, including that the box id and value are bound parameters and an unknown `c<id>` is rejected.
- CSV export and import round-trip with custom columns; a bad choice label fails its line; import ignores required.
- Dashboard: a widget the user may not see is not rendered; quick buttons respect permissions; a default install renders exactly as today.
- Browser: 1440, 900 and 375 px, light and dark; mouse drag, keyboard moves across cards, tray add, size stepping; no console errors; the no-JS fallbacks submit.

## Out of scope

- Renaming built-in boxes or cards; resizing patient form boxes (owner).
- A dashboard layout per user (owner chose one per clinic).
- Changing the profile page layout (owner: the setting is for entering information).
- Custom boxes in SMS templates and print documents. **(agent)** These can come later as their own effort; the SMS template placeholders and the print documents stay as they are.

## Open for the owner

- The picks of variant A for both editors, and the size table.
- The build workflow (owner, after approving this spec).
- Real-phone touch check, and a screen-reader pass by a person, once built.
