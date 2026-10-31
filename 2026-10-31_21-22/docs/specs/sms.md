# SMS reminders and messages: spec (D32+)

Status 2026-10-24: **built** (slices 1-4: base, provider and engine, timer, routes and screens, docs). `npm test` 338 pass. The feature is dormant until a clinic registers its key and switches it on. Browser-checked at 1440, 900 and 375 px, light and dark. Live send from the app to the owner's phone verified: the provider answers 422 without `number_format` (its docs call it optional), so every send carries `number_format: 'persian'`. Until the screens exist the permission editor lists an «پیامک» area that opens nothing. Wayfinder map: https://github.com/MMACABRE/AfshinAmini.clinic.icu/issues/15 (tickets for reminder rules and the owner's later requests are closed or commented there; the sending-engine and screens tickets were **decided by the agent** from the owner's answers and are for the owner to review).

## Owner decisions (grilled, 2026-10-24)

- Provider: IranPayamak (same service as the FarazSMS docs). Each clinic uses its **own** account and types its API key into the SMS settings. The owner's personal test key lives only in git-ignored `.env`.
- Reminders run on an automatic server timer. The send button exists only for custom messages: to one patient (profile) and bulk to a saved advanced search.
- Lead time per visit, chosen on the visit form (field «یادآوری»): `now` right after booking, `h2` two hours before, `d1` one day before at the clinic's send hour (default 17:00), `d2` two days before, `none`. The clinic sets a default; empty on the visit means the default.
- Sending window 08:00 to 21:00 (server clock, `TZ=Asia/Tehran`). Due outside it: "hours before" earlier than 08:00 moves to 21:00 the evening before; later than 21:00 moves to 21:00 the same day. A message that is due but sent late waits for 08:00. A visit that has already started gets nothing («زمان ارسال گذشته است»).
- Maximum 2 reminders per visit. Visit moved before sending: follows the new time. Moved after sending: one new reminder. Cancelled or done: nothing; cancelled after sending: no message. One message per visit, even on the same day.
- Skipped with a visible reason (log and visit card): patient opted out, archived, no valid mobile (patient `phone`, normalized to `09XXXXXXXXX`), reminder cap reached.
- Switching SMS on: existing planned visits get reminders with the default lead, but only after the clerk confirms the count shown on the settings page.
- Wording: filled from data, never typed per visit. Draggable buttons for name, date, time; the rest typed. Sent as plain free text (no provider pattern). **Final default wording, digit style and date format are deferred by the owner** until most of the code exists; `DEFAULT_TEMPLATE` in `sms-rules.js` is provisional.
- Low-credit alert: when the balance falls to the threshold (messages left, default 10), one SMS goes to one number chosen in the settings; sent once per drop, again only after the balance recovers above the threshold. A screen warning also shows on the dashboard (an alert SMS cannot be sent at zero credit).
- All SMS screens live behind one sidebar button «پیامک».
- Permissions: area `sms` (none/view/edit), flags `sms_bulk` and `sms_key` (API key and alert number). Staff preset gets `sms: edit`, no flags. The whole area also needs patients view (it lists patient names).

## Agent decisions (owner to review)

1. **Key storage.** `sms_credentials` row (id = 1) holds the key as AES-256-GCM text. The encryption key is a random 32-byte file `data/sms.key` (mode 600, created on first use with `wx`). It is not in the database, nightly backups or the full zip, so a stolen backup cannot send SMS. Restoring a DB onto a new server means typing the key again. Show only the last 4 characters (`hint`). Never log or audit the key or message text; audit "key set" and "key removed". Check a new key with the balance call before saving.
2. **No double sends.** One reminder row per `(visit_id, stamp)` (unique index; `stamp` = visit date + time). A tick claims a row with `UPDATE ... SET status='sending' WHERE status='pending'` and checks `changes`. A row left in `sending` after a crash becomes `failed` with «نتیجه نامشخص» and is never resent automatically; staff can press «ارسال دوباره» on it. Timeouts and 5xx answers are "unknown" and not retried. Only a connection error that proves the request never reached the provider (`ENOTFOUND`, `ECONNREFUSED`, `EAI_AGAIN`, `ENETUNREACH`) is retried, 5 minutes apart, 3 attempts at most.
3. **Text made at send time.** A reminder's body is built from the current visit and template when it is sent and stored afterwards, so a changed time or template is always right.
4. **Provider client** `src/lib/sms-provider.js`: Node `fetch` (no dependency), fixed base `https://api.iranpayamak.com/ws/v1/`, `Api-Key` header, `redirect: 'error'`, 15 s timeout, JSON body in UTF-8. Calls: `GET account/balance`, `POST sms/simple`. Provider answer `data.status` `insufficient-balance` becomes failed «اعتبار کافی نیست». `pending-approval`, `in-queue`, `sent` count as accepted. Tests inject a fake `fetch` (`createApp({ smsFetch })`); no test touches the network. Never test with `curl` from Git Bash (it mangles Persian; Node `fetch` is fine).
5. **Not built in v1.** Delivery-status polling, inbox polling and «لغو۱۱» replies (shared service lines cannot receive replies; the operator-side «لغو۱۱» block shows up as provider failures). Opt-out is a checkbox on the patient form. Other triggers (birthday, balance, closure) and SMS cost in finance stay in the fog. The message log is not in the full zip (it holds names and numbers).
6. **Retention.** `sms_messages` rows older than 180 days are deleted once a day. Rows of a deleted patient or visit go with them (`ON DELETE CASCADE`).
7. **Bulk.** Needs `sms_bulk`. Recipients come from one of the user's own saved searches (users with `manage_users` see all, like the search page). Skips opted-out, archived and invalid numbers and counts them. Cap 500 per send. Two steps: preview (eligible count, skipped count, SMS parts) then confirm, which must repeat the count; a changed count re-shows the preview. Text supports `{نام}` only.
8. **Tick.** Every 60 s in `src/server.js` next to the nightly backup (`scheduleSms`), guarded against overlap, `unref()`ed, stopped on shutdown. Custom and bulk rows are not held by the sending window; reminders are. After a send, or at most every 30 minutes, the engine reads the balance for the low-credit rule.

## Data (migration 011, built)

`patients.sms_optout`, `visits.reminder_lead` (NULL = default), `sms_credentials`, `sms_messages` (kind reminder/custom/bulk/alert/test; status pending/sending/sent/failed/skipped/cancelled; `reason`, `due_at` epoch ms, `attempts`, `provider_id`), settings keys `sms_enabled sms_line sms_lead sms_hour sms_template sms_alert_phone sms_low_threshold sms_low_alerted sms_balance sms_balance_at`. Add `sms_template` and `sms_enabled` etc. to `DEFAULTS` in `src/lib/settings.js` (`setSettings` refuses unknown keys; migration 011 seeds all but `sms_template`, which falls back to `DEFAULT_TEMPLATE`).

## Build slices (in order, each with tests and `npm test` green)

1. **Base (done):** migration, permissions, `sms-rules.js`. Still to add in this slice: `test/sms-rules.test.js` (mobile numbers, template check and fill, date text «پنجشنبه ۳۰ام مهرماه», parts, `reminderDue` and window cases, DST-free), `src/lib/sms-credentials.js` + test (round trip, wrong key file, hint, no plaintext in the DB file), settings `DEFAULTS`.
2. **Provider and engine:** `sms-provider.js`, `sms-engine.js` (`planReminders`, `sendDue`, `refreshBalance`, `pump`, stuck-row recovery, retention) with a fake `fetch`. Tests: a moved visit, cancelled/done, cap of 2, skip reasons and later un-skip, window hold, double tick sends once, crash recovery, unknown result not retried, connection error retried, low-credit alert once.
3. **Routes and screens** (`src/routes/sms.js`, `views/sms/`, `public/css/page-sms.css`): `/sms` log with filters and «ارسال دوباره»; `/sms/settings`; `POST /sms/key`, `POST /sms/test` (needs `sms_key`); `/patients/:code/sms` custom message; `/sms/bulk`. Rules in `src/lib/route-perms.js` (`test/permissions.test.js` fails without them). Sidebar button, dashboard warning card, opt-out checkbox on the patient form (set only when the form sends a marker field, so CSV import never resets it), `reminder_lead` select on the visit form (shown when SMS is on), reminder chip on the visit card (`visit-item.ejs`; one query for the latest reminder per visit). Template editor: text box plus draggable buttons that also insert on click (`app.js` `enhanceSmsTemplate`, native drop into the textarea); works without JavaScript by typing `{نام}`.
4. **Timer and docs:** `scheduleSms` in `server.js`; `docs/SETUP.md` client checklist (account on at least the نقره‌ای plan, API key from panel → وب‌سرویس, sender line, identity verification, terms rule 2); `docs/DEPLOY-AGENT.md` note that `data/sms.key` must survive updates; `CLAUDE.md` and `Plan.md` status; `ce-code-review` and `security-and-hardening` pass; browser check at 1440, 900, 375 px light and dark.

## Routes and access (add each to `RULES` in `src/lib/route-perms.js`)

Every `/sms` page also needs patients view (it shows patient names). Order matters: first match wins.

| Method and path | Needs | What it does |
|---|---|---|
| `POST /sms/key` | flag `sms_key` | Save or remove the API key (field `action=remove`). Checks the key with the balance call first. |
| `POST /sms/test` | flag `sms_key` | Sends one plain test message to the alert number. |
| `GET,POST /sms/bulk`, `POST /sms/bulk/confirm` | flag `sms_bulk` and patients view | Bulk message: pick saved search and text, preview, confirm. |
| `POST /sms/settings` | `sms` edit | Save the settings. |
| `POST /sms/:id/retry` | `sms` edit | Put one failed message back in the queue. |
| `GET /sms`, `GET /sms/settings` | `sms` view | Log and settings page. |
| `GET,POST /patients/:code/sms` | `sms` edit | Send one custom message to a patient. |

`test/permissions.test.js` fails on a route without a rule. Add tests that a user with `sms` view cannot POST, a user without `sms_key` cannot change the key or alert number, and `%2F` and odd spellings of these paths still hit the gate.

## Screens (Persian text; keep the existing look; every page works without JavaScript)

- **Sidebar:** one button «پیامک» (`i-mail` icon, `active: 'sms'`) under the workspace group, shown when `can('sms') && can('patients')`. A segmented sub-nav like `views/finance/nav.ejs`: «گزارش ارسال» · «ارسال گروهی» (only with `sms_bulk`) · «تنظیمات».
- **Log (`/sms`):** table, newest first, 50 per page. Columns: date and time (Jalali), patient (link) and number, kind, text, status chip, reason. Filters: status, kind. Status chips: pending «در انتظار» (info), sent «ارسال شد» (ok), failed «ناموفق» (crit) with a «ارسال دوباره» button, skipped «ارسال نشد» (mute) with the reason, cancelled «لغو شد» (mute). Top strip: balance and time it was read, «پیامک غیرفعال است» or «کلید ثبت نشده» when relevant. Empty state text when there are no messages.
- **Settings (`/sms/settings`):** (1) on/off switch. Switching on from off shows «این کار برای N ویزیت پیامک می‌فرستد» and a checkbox that must be ticked; the server compares the count again (Q13). (2) Sender line (default `90008361`; letters and digits, 3 to 20 characters). (3) Default lead time and send hour (8 to 21). (4) Wording editor (below). (5) Only with `sms_key`: API key box (shows `••••` + last 4, «تغییر کلید», «حذف کلید»), alert number, low-credit threshold in messages (1 to 1000), «پیامک آزمایشی» button. The key field is `type=password`, `autocomplete=off`, and is never put back in the page.
- **Wording editor:** a textarea (`name=sms_template`, max 300 characters, `dir=rtl`) above three draggable buttons «نام» «تاریخ» «ساعت» (`draggable`, `data-token`). Dropping a button on the textarea inserts `{نام}` and so on (native behavior); a click inserts at the cursor (`enhanceSmsTemplate` in `app.js`). Below: live count of characters and SMS parts (`smsParts`) and a sample line built with a made-up name and a real upcoming-looking date. Saving runs `validateTemplate`. No inline script.
- **Patient profile:** button «ارسال پیامک» (needs `sms` edit) opens `/patients/:code/sms` with a textarea (max 500), live parts count, the number it will go to, and a note when the patient opted out or has no valid mobile (send disabled, reason shown). Opt-out checkbox «دریافت نکردن پیامک» on the patient form (`name=sms_optout`, with hidden `sms_optout_form=1` so CSV import never resets it); the profile shows a chip «بدون پیامک» when set. Under the patient's contact line show the last message state.
- **Visit form:** select «یادآوری» with the five lead choices and the first option «پیش‌فرض کلینیک (…)», shown only when `smsOn`. Value stored in `visits.reminder_lead` (NULL for the default). The visit card (`visit-item.ejs`) shows one extra chip from the latest reminder row: «یادآوری ارسال شد»، «یادآوری در انتظار» (with the due time), «یادآوری ناموفق: <reason>» (warn), «یادآوری ارسال نمی‌شود: <reason>» (mute). A visit with lead `none` shows nothing.
- **Bulk:** step 1 select one of the user's saved searches and write the text (max 500, `{نام}` allowed). Step 2 preview shows: recipients who will get it, skipped (opted out, archived, invalid number) with counts, SMS parts per message, total parts, current balance, and a field to type the recipient count again. Step 3 queues the messages (status pending, `kind='bulk'`) and shows the log. More than 500 recipients: refuse with «حداکثر ۵۰۰ گیرنده در هر ارسال». Same number twice in one bulk goes once.
- **Dashboard:** card «پیامک» shown with `can('sms')` when SMS is on and something needs attention: no key, balance at or under the threshold, failed messages in the last 24 hours (count and link to the log filtered to failed). No card when all is well.

## Validation and limits

Mobile numbers through `normalizeMobile` only. Settings: `sms_line` `/^[A-Za-z0-9]{3,20}$/`; `sms_lead` one of the five keys; `sms_hour` through `sendHourOf`; `sms_low_threshold` integer 1 to 1000; `sms_alert_phone` a valid mobile or empty. Message text through `cleanText`, cap `MESSAGE_MAX`. API key `/^[A-Za-z0-9_.-]{20,200}$/`. Log page size 50. All form input normalized like the rest of the app (Persian digits to ASCII where a number is expected).

## Audit

`sms_settings` (no values), `sms_key_set`, `sms_key_remove`, `sms_test`, `sms_send` (detail `1 recipient`), `sms_bulk` (detail `N recipients`), `sms_retry`. Reminders sent by the timer write no audit row (the log is the record). Never put a key, a number or a message text in `detail`.

## Security checklist (the main agent reviews this itself, `security-and-hardening`)

- The key never reaches a view, a log line, an error message, the audit log, the database in plain text, a backup or the zip. Errors from the provider are shown shortened and never include request headers.
- Outbound calls go only to the fixed base URL; no user input becomes a URL or a header; `redirect: 'error'`; timeout set.
- Every SQL statement parameterized. Message text is output through EJS escaping.
- CSRF: the global same-origin check covers all POSTs. Bulk needs the typed count, so a stray POST cannot send.
- Failure is safe: no key, disabled, or a provider error never blocks saving a visit or any other page; the engine catches everything and logs only a short code.
- A leaked or wrong `sms.key` file only makes the stored key unreadable (treated as «کلید ثبت نشده»); it never crashes start-up.

## Tests each slice needs

Slice 1: `sms-rules` (numbers: `0912…`, `+98 912…`, Persian digits, `912…`, junk, landline; template: unknown token, missing token, stray brace, too long; fill; date text for every weekday and month spelling; time `09:10` gives «۹:۱۰»; parts at 70, 71, 134, 135; `reminderDue` for all leads, midnight, a visit at 07:00 with `h2`, one at 23:30; `pullIntoWindow` edges 07:59, 08:00, 21:00, 21:01), credentials. Slice 2: engine cases listed in the slice. Slice 3: permission matrix per route, form round trips, visit card chip text, patient opt-out round trip, CSV import keeps opt-out, bulk preview and confirm mismatch, key never in any response body (search every page for the test key). Slice 4: `server.js` starts and stops the timer without leaving handles; end-to-end with a fake provider: book a visit, tick, one message, tick again, still one.

## Client setup checklist (for `docs/SETUP.md`, slice 4)

1. Account at iranpayamak.com on the نقره‌ای plan or higher (the economy plan has no API). 2. Verify identity in the panel (unverified panels are blocked). 3. Panel → وب‌سرویس → لیست کلیدهای دسترسی → create a key. 4. Ask support in writing whether visit reminders from a clinic need the Medical Council letter (terms rule 2) and keep the answer. 5. Paste the key in the app: «پیامک» → «تنظیمات», press «پیامک آزمایشی», check it arrives. 6. Shared lines may land in the spam folder; a dedicated line needs business documents and takes about 72 working hours.

## Open questions (all need the owner)

Final default wording, digit style and date format. Whether staff should get `sms` edit by default (the migration and preset say yes). Whether the message log should join the full zip (decided no). Whether to build delivery-status polling and «لغو۱۱» inbox handling later.

## Provider facts to remember

Verified live 2026-10-24 with the owner's personal panel (نقره‌ای plan): `GET account/profile`, `GET account/balance` (`balance_amount` toman, `balance_count` messages), `GET lines/accessible` (shared lines, 248 toman each; `90008361` is the web-service line), `POST sms/simple` (200, `data.id`, `data.status` `pending-approval`, still delivered), `GET send_request/{id}`. Plain Persian text is delivered when sent as UTF-8 JSON. Economy plan has no API. Terms rule 2 (medical field, Medical Council letter): the owner asked support on 2026-10-24 and was told the letter is **not needed** for a clinic's own visit reminders (map ticket 22).
