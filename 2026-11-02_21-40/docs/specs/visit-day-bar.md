# Spec: day bar and length dial for visits (D50, D51)

Source: wayfinder map "Wayfinder map: day bar for picking visit times, and a length dial" (issue #29). The owner settled the behaviour on 2026-10-31. Points marked **(agent)** were decided by the agent while the owner was away and wait for the owner's review. The owner said the look matters a great deal to them, so every look choice below is open to change after they see it in a browser.

## Objective

When staff plan a visit, they should see which times of that day are free and which are booked, and pick a start time by pointing at it. The clinic has one doctor, so two visits on one day never overlap (D23). The server already refuses a clash with 422/409. The day bar only shows that rule before saving.

Users: both roles that may edit visits (permission area "visits", edit). The `/visits` bar is visible to anyone with the visits view.

## Terms

From `GLOSSARY.md`: **day bar** «نوار ساعت روز», **booked time**, **length dial** «صفحه‌ی مدت». The day bar is distinct from a patient's visit timeline.

## D50: the day bar

### Data

- `dayBookings(db, isoDate, excludeId)` in `src/lib/visits.js` returns the scheduled and done visits of the day, plus the tail of a visit from the day before that runs past midnight. Each entry has `start` and `end` in minutes since midnight (clipped to 0..1440), `time`, `until`, `name`, `status` and `fromYesterday`. Cancelled visits book nothing.
- `GET /visits/day?d=<Jalali date>&exclude=<visit id>` returns `{ date, today, bookings }` as JSON with `Cache-Control: no-store`. An invalid date gets 400 with a Persian error. The route falls under the existing rule `GET /visits(/seg)?` (visits view), and every `/visits` path also needs the patients view (`needsPatients` in `src/lib/route-perms.js`), so names may be included. The list is capped at 400 entries.
- The dropdown fetches the day each time it opens and whenever the date box changes, so a time booked by someone else since the last open shows up. **(agent)**

### On the visit form (add and edit)

- The time box stays a plain text box. Typing a time by hand always works, and the bar is only a suggestion.
- Without JavaScript, a line under the time box lists the day's booked times (`ساعت‌های رزروشده‌ی این روز: ۰۹:۰۰ تا ۰۹:۳۰، …`), or says the day has none. Names are not listed.
- With JavaScript, clicking or focusing the time box opens the day bar as a dropdown, below the box, or above it when there is no room below. A small clock button inside the box also opens it.
- The dropdown is wider than the box and never covers half the screen **(agent)**: 640 px on wide screens, at most the viewport width minus 32 px, and shifted sideways so it stays inside the viewport.
- The ruler runs left to right from 00:00 to 24:00. One hour is 120 px (96 px under 600 px wide), so about five hours show at once on a desktop and about three and a half on a phone. The rest is reached by scrolling or swiping sideways. When it opens, the bar scrolls to the typed time, else to 30 minutes before the first booking, else to 08:00. **(agent)**
- Each booked visit is a highlighted block. Scheduled visits use the sage tint with a sage edge, and done visits use a muted tint. The edited visit is not drawn as booked; it is the movable pick. **(agent)**
- A click or tap on a free spot sets only the start, snapped to 5 minutes. With a mouse, dragging moves the pick. On touch, the marker's handle can be dragged, and swiping elsewhere scrolls the bar. The time box is filled in, and the dropdown stays open until the user clicks outside it or presses Esc.
- A click on a booked block does not pick. Hover (or a tap on touch) shows a small card with the patient's name, the time span and length, and «از دیروز» for a tail from the previous day. Names are never shown without hover or tap.
- The pick marker is a sage line with a terracotta knob, following the "terracotta tip on a green line" motif. A faint dashed block from the pick shows the chosen length. If it overlaps a booked visit, it turns to the critical colours and the status line names the clash. **(agent; owner wants to see this before agreeing)**
- On today's bar, a thin terracotta line marks the current time.
- Picking stops at 23:55. A start that runs past midnight can be typed by hand.
- Keyboard: the ruler is a `role="slider"` (`aria-valuetext` such as «۰۹:۳۰»). The arrow keys move 5 minutes, Page Up and Page Down move an hour, Home and End go to 00:00 and 23:55, and Esc closes and returns focus to the time box. A polite live line reports the pick and any clash. **(agent)**
- Motion: the dropdown fades in and rises 4 px in 160 ms with ease-out. The marker glides 120 ms when it is set by click or key, and does not glide while dragging. Reduced motion turns both off. **(agent)**

### On `/visits`

- A full-width card «نوار ساعت روز» sits above the list. It shows the day chosen with `?d=`, else today. It has the Jalali date, a «امروز» chip, a summary (`۳ ویزیت · ۱ ساعت و ۱۵ دقیقه رزرو`, or «همه‌ی روز آزاد است»), and previous-day, today and next-day links.
- The server draws it as plain HTML and SVG, with no inline styles (CSP `default-src 'self'`). Hour labels are 24 equal cells, and booked blocks are SVG rects positioned by attributes. Each block's `<title>` shows the name on hover. A block links to the visit's page.
- Without JavaScript, each hour is a link to «ویزیت جدید» at that hour (only with the visits edit permission). With JavaScript, a click on a free spot goes to «ویزیت جدید» at the exact 5-minute time, and hovering free space shows the time under the pointer. **(agent)**
- The track is at least 960 px wide. A desktop shows the whole day, and a phone scrolls sideways (JavaScript scrolls it to the first booking, the current time, or 08:00).
- «ویزیت جدید» carries `d` and `t` through the patient search to the form, which starts with that date and time.

## D51: the length dial

- Lengths: 5 to 60 in steps of 5, then 75 and 90 (`DURATIONS`). The server maximum rises from 60 to 90. This changes D23. **(agent)**
- Without JavaScript, the plain select stays as it is.
- With JavaScript, the select is hidden but still submits, and a button styled like the select («۱۵ دقیقه») opens the dial as a dropdown below the box, or above it when there is no room below.
- The dial is a clock face, about 220 px across (240 px on phones). The twelve values 5 to 60 sit where the minutes sit on a clock (5 at one o'clock, 60 at twelve). A sage arc runs clockwise from twelve to the chosen value and ends in a terracotta knob. The centre shows the value large, with «دقیقه». Below the face, the pills «۷۵» and «۹۰» sit under the label «بیش از یک ساعت». **(agent)**
- Tap or click a value or pill, or drag the knob around the ring, which snaps to the nearest value. The arrow keys step through the values. Like the day bar, the dial stays open until the user clicks outside it or presses Esc. **(agent)**
- Changing the length updates the day bar's dashed block straight away.

## Out of scope

Several doctors or rooms on one bar, setting the length by dragging the bar, a bar on the dashboard card «ویزیت‌های امروز» (could come later), and highlighting a list row when its block is hovered.

## Code style and layout

- Server: `src/lib/visits.js` (`dayBookings`, `DURATIONS`) and `src/routes/visits.js` (`renderForm`, `newValues`, `GET /visits/day`, bar data on `/visits`, `when` on the pick page).
- Views: `views/partials/day-bar.ejs` (the `/visits` bar), `views/visits/form.ejs` (the `data-day-bar` and `data-dial` hooks and the fallback line), `views/visits/pick.ejs`, `views/visits/list.ejs`.
- Client: `public/js/app.js` only (`enhanceDayBar`, `enhancePageBar`, `enhanceDial`), using its `el()`/`icon()` helpers, with no inline script. Positioning uses `element.style` from the script, which the CSP allows. The ruler is LTR, so physical `left` in the script is correct there. CSS uses logical properties.
- CSS: `public/css/page-visits.css`, with tokens only (`--accent*`, `--terra*`, `--crit-*`, `--mute-*`, surfaces). Light and dark both come from the tokens.
- Sprite: add `i-clock` to `views/partials/sprite.ejs`.

## Testing

- `node:test` in `test/visits.test.js` and `test/day-bar.test.js`:
  - `dayBookings` covers cancelled visits, the previous day's tail, `excludeId` and clipping.
  - `GET /visits/day` covers the JSON shape, a 400 for a bad date, `no-store`, the `exclude` id, refusal without the visits view, and refusal without the patients view.
  - The form fallback line covers both cases (some bookings and none).
  - The `/visits` bar covers the rects, the hour links only with edit, and the prev and next links.
  - The pick page and the form carry `d` and `t`, and a bad `t` is ignored.
  - Durations: 75 and 90 accepted, 61, 65 and 95 refused.
- `npm test` all green; `npm audit --omit=dev` 0.
- Browser checks at 1440, 900 and 375 px, light and dark: dropdown placement and flipping, keeping inside the viewport, picking, dragging, hover cards, the clash colour, the dial, the `/visits` bar, no horizontal page scroll, and no console errors.

## Boundaries

- Always: parameterized SQL, the permission gate, Persian UI text, and pages that work without JavaScript.
- Ask first: new dependencies (none needed), publishing to the public repo.
- Never: inline script or style, names shown without hover, a change to an applied migration (none needed).

## Success criteria

1. On the visit form, a click on the time box opens the bar. A click on a free spot fills the time and the bar stays open. Esc or a click outside closes it.
2. Booked blocks match the server's clash rule: a pick the bar shows as free saves without 422, and one it shows red gets the clash error.
3. The dial sets 5 to 90 and the form saves it.
4. `/visits` shows the bar for the chosen day, and a click on a free spot starts a new visit at that time.
5. Every point above works without JavaScript in its plain form.
