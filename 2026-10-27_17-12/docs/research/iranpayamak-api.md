# IranPayamak API: what it can do and under which rules

Research for issue #16 (wayfinder:research, parent #15). Blocks #17, #18, #19.
Date of research: 2026-10-21. Method: raw OpenAPI markdown of every page listed in
`https://docs.iranpayamak.com/llms.txt` was downloaded and read (103 pages). Provider
website read via WebFetch.

## Read this first: three problems that affect the plan

1. **The docs site is branded FarazSMS, not IranPayamak.** The title of the index
   `https://docs.iranpayamak.com/llms.txt` is "# FarazSMS Public APIs", and example
   data in the pages uses "فراز اس‌ام‌اس" (`https://docs.iranpayamak.com/profile-13716723e0.md`).
   The provider's own site `https://iranpayamak.com` names its operator as
   Zarin Ertebatat Asia (شرکت زرین ارتباطات آسیا). The docs and the product may belong to
   the same company or the docs may be copied from another provider's template. **Unverified.**
   Ask the provider before building on these docs.
2. **The docs are incomplete and partly contradictory.** Many pages contain no request or
   response fields (`properties: {}`), several endpoints share a path, and one schema
   (`SimpleRequestDto`) uses different field names from the real endpoint. See "Doc defects".
3. **Nothing about the rules is in the docs.** No page states sender-line rules, pattern
   approval time, IP allow-listing, rate limits, sending hours, webhooks, sandbox mode,
   credit cost per SMS part, or personal vs business limits (beyond one enum value).
   These are marked "unknown — docs silent" below.

## Auth

- Base URL: `https://api.iranpayamak.com` (server "Prod Env"), with paths under `/ws/v1/`.
  Source: `https://docs.iranpayamak.com/login-24945813e0.md`
- Every endpoint carries the security scheme `apikey-header-Api-Key`, type `apiKey`,
  location header, name `Api-Key`. Source: `https://docs.iranpayamak.com/login-24945813e0.md`
  (and the same block in every page).
- A `bearer` scheme is also defined in `components.securitySchemes`, but no endpoint
  uses it. Source: `https://docs.iranpayamak.com/login-24945813e0.md`
- **How an API key is created in the panel, and its scope: unknown — docs silent.**
- Login: `POST /ws/v1/auth/login`. Request body: `username`, `password`, `method`
  (nullable, `sms` or `ga`). Response: schema has no fields (`properties: {}`); a
  "Success" response is listed. Source: `https://docs.iranpayamak.com/login-24945813e0.md`
- 2FA: `POST /ws/v1/auth/verify-2fa`. Request body: `token`, `code`, `method` (nullable,
  `sms` or `ga`). Response: no fields documented. Source:
  `https://docs.iranpayamak.com/verify-2fa-24945819e0.md`
- Logout: `POST /ws/v1/auth/logout`. Source: `https://docs.iranpayamak.com/logout-24946032e0.md`
- Register (account): `POST /ws/v1/auth/register`. Request fields: `plan_id`,
  `person_type` (example value `"personal"`; other values unknown), `username`,
  `first_name`, `last_name`, `national_code`, `mobile`, `discount_code`, `seller_id`,
  `should_notify_user`, `redirect_url`. Source: `https://docs.iranpayamak.com/register-24945818e0.md`
- Also listed: `POST /ws/v1/account/register`
  (`https://docs.iranpayamak.com/register-23342012e0.md`, same body shape),
  `GET /ws/v1/auth/show_register_form` (`https://docs.iranpayamak.com/show-register-form-24945820e0.md`).

## Account, balance, lines

- Profile: `GET /ws/v1/account/profile`. Response `data`: `displayName`, `mobile`,
  `verified` (bool), `blocked` (bool), `plan` {`id`, `title`, `expiryDate`},
  `permissions` (string; example `01ffffffffffffffffff`, meaning not documented).
  Source: `https://docs.iranpayamak.com/profile-13716723e0.md`. The page description is a
  copy of the Login description (defect).
- Balance: `GET /ws/v1/account/balance`. Response `data`: `balanceAmount` (example 5000,
  described as "موجودی تومانی", toman balance), `balanceCount` (example 25), `details[]`
  with `count` (SMS count), `rate` (tariff per SMS, example 200), `amount`. Source:
  `https://docs.iranpayamak.com/account-balance-13717911e0.md`. Unit of `rate` is
  implied to be toman; the docs do not say so explicitly.
- Charge wallet: `POST /ws/v1/account/wallet/charge`. Fields: unknown — docs silent beyond
  the path. Source: `https://docs.iranpayamak.com/charge-wallet-23341923e0.md`
- Accessible sender lines: `GET /ws/v1/lines/accessible`. Source:
  `https://docs.iranpayamak.com/lines-27039797e0.md` (response fields not read in detail).
- Account update: `POST /ws/v1/account/update`. Source: `https://docs.iranpayamak.com/update-22119667e0.md`

## Sending

Every send takes a sender line in `line_number` (string, digits). The docs do not say how a
line is assigned to an account or what lines a personal account may use; use
`GET /ws/v1/lines/accessible` for that. **Sender-line rules: unknown — docs silent.**

| Purpose | Method and path | Request fields (from docs) | Response | Source |
|---|---|---|---|---|
| Plain SMS, many recipients | `POST /ws/v1/sms/simple` | `text`, `line_number`, `recipients` (array of strings), `number_format` (`english`/`persian`, nullable), `schedule` (nullable, example `"2026-05-23 12:58:00"`) | 201, `ApiResultNumber` | `https://docs.iranpayamak.com/send-simple-sms-13909967e0.md` |
| Plain SMS from Excel | `POST /ws/v1/sms/simple-file` | file upload (fields in page) | 201 expected (not verified) | `https://docs.iranpayamak.com/send-simple-sms-from-excel-13909968e0.md` |
| Plain SMS from phone book | `POST /ws/v1/sms/simple` (same path as above) | `text`, `selectedPhoneBooks[]` {`id`, `offset`, `limit`}, `line_number`, `number_format`, `schedule` | not stated | `https://docs.iranpayamak.com/send-simple-sms-from-phonebook-31206570e0.md` |
| Sample to account owner | `POST /ws/v1/sms/sample` | `text`, `line_number`, … | not stated | `https://docs.iranpayamak.com/send-sample-sms-13909966e0.md` |
| Many recipients, filtered by geography and gender | `POST /ws/v1/sms/bulk/send` | `filters[]` (`province_id`, `county_id`, `city_id`, `postal_code`, `gender_id`, `operator`, `age_from`, `age_to`, `number_prefix`, `row_from`, `row_count`), `text`, `line_number`, `number_format`, `schedule` | 200 | `https://docs.iranpayamak.com/send-bulk-sms-40274705e0.md` |
| Bulk recipient count | `GET /ws/v1/sms/bulk/get-receiver-count` | filter params | not stated | `https://docs.iranpayamak.com/get-receiver-count-40274703e0.md` |
| Pattern (template) SMS | `POST /ws/v1/sms/pattern` | `code` (pattern code), `attributes` (object var name → string), `recipient` (one number), `line_number`, `number_format`, `schedule` (nullable) | not stated | `https://docs.iranpayamak.com/send-pattern-based-sms-13925177e0.md` |
| Variables in text | `POST /ws/v1/sms/keywords` | text with `%name%` tokens, attributes from phone book | not stated | `https://docs.iranpayamak.com/send-sms-with-variables-13909969e0.md` |
| Peer-to-peer (different text per recipient) | `POST /ws/v1/sms/peer-to-peer` and `.../peer-to-peer-file` | per-peer text and recipient | "each peer generates a separate send request record" | `https://docs.iranpayamak.com/send-peer-to-peer-sms-13909971e0.md` |
| Voice message | `POST /ws/v1/sms/voice/send`; upload `POST /ws/v1/sms/voice/upload-file`; download `GET /ws/v1/sms/voice/download-file` | `file_id`, `recipients`, `selectedPhoneBooks`, `schedule` | 201, `ApiResultNumber` | `https://docs.iranpayamak.com/send-voice-message-31200965e0.md` |
| Postal-code send | `POST /ws/v1/sms/calculate-cost` (shared path, see defects); lists `GET /ws/v1/sms/postal/get-available-lines`, `.../get-genders`, `.../get-receiver-count` | `maxLength 99999` and `maximum 1500` appear in the page | not stated | `https://docs.iranpayamak.com/send-postal-code-sms-31206192e0.md` |
| Send to number bank | `POST /ws/v1/sms/bank` | `text`, `recipients[]` {`bank_id`, `limit`, `offset`}, `line_number`, `number_format`, `schedule` | not stated | `https://docs.iranpayamak.com/send-to-number-bank-31283521e0.md` |

Schedule: format `YYYY-MM-DD HH:MM:SS` in examples; one example uses ISO
`2026-03-20T10:00:00Z`. Docs do not state the time zone. Sending window rules: **unknown — docs silent.**

Response shape `ApiResultNumber` (https://docs.iranpayamak.com/apiresultnumber-5179921d0.md):
`status` (`success` | `error`), `data` (number, probably the send-request id; not stated),
`messages` (string, array of strings, or object of string arrays, or null).
Message id semantics: **unknown — docs silent.**

Schema defect: the `SimpleRequestDto` schema (https://docs.iranpayamak.com/simplerequestdto-5179915d0.md)
uses `text` (min length 3), `from` (digits), `recipients` (pattern `^09\d{9}$`), `numberFormat`
(`en`/`fa`), `schedule` (date-time, must be in the future). The endpoint page uses
`line_number` and `number_format`. Which is correct for the live API: **unknown, test needed.**
Recipient format `09XXXXXXXXX` is stated in the schema.

Bulk limits: the only stated limit is **500 contacts per request for bulk phone-book
upsert** (`https://docs.iranpayamak.com/add-bulk-contact-34585784e0.md`). Excel contact import:
"No limit to import with Excel" (`https://docs.iranpayamak.com/add-excel-contact-34615972e0.md`).
Per-request recipient limit for send endpoints: **unknown — docs silent.**

## Pattern (template) creation and approval

- Create: `POST /ws/v1/patterns`. Fields: `text`, `description` (nullable), `share` (described
  as boolean, but typed integer), `website`, `category` (`1` = OTP, `2` = club, `3` = order,
  `255` = others), `vars[]` {`var`, `length`, `type` (`int`, `str`, `date`)}. Source:
  `https://docs.iranpayamak.com/create-new-pattern-13925176e0.md`
- Get: `GET /ws/v1/patterns/{code}` (`https://docs.iranpayamak.com/get-pattern-details-16297027e0.md`).
  List: `GET /ws/v1/patterns` (`https://docs.iranpayamak.com/get-list-of-users-patterns-21747971e0.md`).
  Edit: `PUT /ws/v1/patterns/{code}` (`https://docs.iranpayamak.com/edit-pattern-21747970e0.md`).
- The pattern is referenced by `code` when sending (for example `SJ3FgPrE0C` in the example).
  The send page says the pattern "must be created and get from user panel"
  (`https://docs.iranpayamak.com/send-pattern-based-sms-13925177e0.md`), so a pattern may
  have to be created in the web panel, not only by API. Not confirmed.
- **Approval process, approval time, and allowed or forbidden text: unknown — docs silent.**
  The response of create-pattern is not documented in the fetched page beyond the schema
  reference.
- Provider's own site: "با پترن کمتر از 5 ثانیه" ("with a pattern under 5 seconds") is
  advertised for OTP messages (`https://iranpayamak.com`). This is a marketing claim, not a rule.

## Delivery status, replies, opt-outs

- Send requests: `GET /ws/v1/send_request` with `status` filter. Documented status values:
  `init`, `pending-approval`, `insufficient-balance`, `cancelled`, `rejected`, `in-queue`, `sent`.
  Source: `https://docs.iranpayamak.com/get-send-requests-27724579e0.md`
- Send request detail: `GET /ws/v1/send_request/{send_request_id}` and items:
  `GET /ws/v1/send_request/{send_request_id}/items`. Per-recipient delivery state: **unknown — docs silent.**
  Sources: `https://docs.iranpayamak.com/show-send-request-details-27724809e0.md`,
  `https://docs.iranpayamak.com/get-send-request-items-27724811e0.md`
- Inbound messages (replies): `GET /ws/v1/inbox` (paged, `page`, `limit`). Message fields:
  `from` (`09XXXXXXXXX`), `to` (digits), `text`, `recievedAt` (sic; date-time).
  Source: `https://docs.iranpayamak.com/get-paged-inbox-messages-13925178e0.md`,
  `https://docs.iranpayamak.com/inboxmessage-5191119d0.md`
- Polling is the only documented way to read inbound messages. **Webhook or push: unknown — docs silent.**
- Opt-out «لغو۱۱»: **not mentioned in the API docs.** The API has no opt-out endpoint or field.
  See the regulation section for the secondary source.

## Credits, cost, errors, limits

- Cost calculator: `POST /ws/v1/sms/calculate-cost` (types: Simple, Sample, PostalCode, Pattern;
  fields `text`, `receiver_count`, `line_number`, `number_format`).
  Source: `https://docs.iranpayamak.com/calculate-send-sms-cost-31206056e0.md`.
  Peer-to-peer variant: `POST /ws/v1/sms/calculate-cost/peer-to-peer`
  (`https://docs.iranpayamak.com/calculate-send-sms-peer-to-peer-40276691e0.md`).
  Response fields: not stated in the fetched page.
- Price per SMS: the balance example has `rate` 200. The provider site lists tiers
  218 / 193 / 169 / 145 toman and "هر پیامک ۱۲۰ تومان" (120 toman per SMS, lowest advertised)
  (`https://iranpayamak.com`). Tariff depends on plan; **which tariff applies to this clinic: unknown.**
- Persian text length per SMS part (70 vs 67 characters, UCS-2 split): **unknown — docs silent.**
- Error codes: `ApiStatus` enum is `success` | `error` only
  (`https://docs.iranpayamak.com/apistatus-5068902d0.md`). Specific error codes: **unknown — docs silent.**
  A 401 response is listed on the balance page without a body schema
  (`https://docs.iranpayamak.com/account-balance-13717911e0.md`).
- Rate limits: **unknown — docs silent.**

## Network, accounts, rules

- IP allow-listing: **unknown — docs silent.** No page mentions IP restriction.
- Rejection of requests from outside Iran (VPS abroad): **unknown — docs silent.** Test needed.
- Personal vs business: the register example uses `person_type: "personal"`
  (`https://docs.iranpayamak.com/register-24945818e0.md`). Other values, limits for personal
  accounts, and any business-only features: **unknown — docs silent.** The provider's
  site says its line is "suited to individuals and websites" (`افراد حقیقی و وب‌سایت‌ها`)
  and does not state legal-entity rules (`https://iranpayamak.com`).
- Account plan and permissions come back from profile (`plan`, `permissions`), but the
  meaning of the `permissions` string is not documented.
- Sandbox or test mode: **not in the API docs.** The provider site lists a "نسخه آزمایشی
  (demo)" linked to registration, with no detail (`https://iranpayamak.com`). Whether it
  is an API sandbox: **unknown**.
- Support tickets: `POST /ws/v1/ticket`, `POST /ws/v1/ticket/replay`,
  `POST /ws/v1/ticket/closed`, `GET /ws/v1/ticket`. Priority enum: `less_important | normal | important | very_important`
  (`https://docs.iranpayamak.com/create-new-ticket-31114014e0.md`).

## Regulation (secondary sources, not verified against an official text)

Searched Persian news and blog results. Official regulator text was not reached.

- Bulk promotional or notification SMS to a subscriber without prior consent is forbidden,
  under the regulator's content-service rules. Secondary:
  `https://aftabnews.ir/fa/news/989541/...` (in search results).
- Notification SMS from service lines must carry «لغو ۱۱» at the end; recipient sends 11 to
  the same line to opt out; 12 re-enables service SMS. Secondary: aftabnews and iqna
  (`https://iqna.ir/fa/news/4283351/...`). One critical article says the opt-out applies only
  to that line (`https://dmboard.media/pick/laghv11/`). Most of these results are older.
- Sending hours: unofficial sources mention restrictions (one says sending from 22:00 to 08:00
  is inappropriate, `https://sorenad.com/...`). **No official sending-hour rule was found.**
  Needs the regulator's own publication.

## Doc defects found

- Index title says FarazSMS (see top).
- Profile page description copies the Login page's text.
- Send Requests pages say "Get paged list of phonebooks" in their description (copy error).
- Several paths are used by more than one page with different meaning:
  `/ws/v1/sms/simple` (simple, phone book), `/ws/v1/sms/calculate-cost` (cost, postal),
  `/ws/v1/sms/voice/upload-file` (upload, cost of voice).
- Most response schemas are empty (`properties: {}`), so response fields are unknown
  for login, verify-2fa, and most send endpoints.
- `share` on create-pattern is described as boolean but typed integer.
- The "Send" index page has no content (`https://docs.iranpayamak.com/send-2959532f0.md`).
- The login example contains a real-looking username and password. Not reproduced here.

## Open items for the plan (need a person or a test account)

1. Confirm with the provider which company runs the API (FarazSMS vs IranPayamak). **needs input:**
2. Ask for the panel path to create an API key, its scope, and whether a personal account can have one.
3. Ask: pattern approval process, approval time, allowed text, and whether patterns must be created in the panel.
4. Ask: sender-line rules for personal accounts, and whether `line_number` must be one of `lines/accessible`.
5. Ask: per-request recipient limit, delivery-status endpoint or webhook, opt-out handling, rate limits, IP restriction, and sandbox.
6. Test from the server's IP (VPS outside Iran) with one account before committing.
7. Obtain the official regulator text on sending hours and «لغو ۱۱» for service lines.
