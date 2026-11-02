import { normalizeText, faKey } from './normalize.js';
import { parseJalali, toJalaliInput, faDigits } from './jalali.js';
import { reservedHeaderKeys } from './csv.js';
import { audit } from '../audit.js';
import { BOXES, CUSTOM_TYPES, LIMITS, CUSTOM_TYPE_IDS, hasVisible, len, Reject } from './layout-catalogue.js';

// Custom boxes (D53): their names and choices, the values a patient has, and the readable text for each value.
const parseBox = (row) => ({ ...row, choices: row.choices ? JSON.parse(row.choices) : null });

// Live custom boxes in creation order, choices parsed.
export function liveCustomBoxes(db) {
  return db.prepare('SELECT * FROM custom_boxes WHERE deleted_at IS NULL ORDER BY id').all().map(parseBox);
}

// Splits the choices text on «,» and «،», trims, drops empty items and checks count, length and uniqueness.
// `min` is 2 for a new choice box and 1 when labels are appended to an existing one.
export function splitChoices(raw, min = LIMITS.choicesMin, existing = []) {
  const items = String(raw ?? '').split(/[,،]/).map((s) => normalizeText(s)).filter((s) => hasVisible(s));
  if (items.length < min) {
    return { error: min === 1 ? 'گزینه‌ی تازه را بنویسید.' : 'برای انتخاب از فهرست ۲ تا ۳۰ گزینه لازم است.' };
  }
  if (items.length > LIMITS.choicesMax - existing.length) return { error: 'هر فهرست بیشتر از ۳۰ گزینه ندارد.' };
  if (items.some((s) => len(s) > LIMITS.boxName)) return { error: 'هر گزینه باید بین ۱ تا ۶۰ نویسه باشد.' };
  const keys = new Set(existing.map((c) => faKey(c.label)));
  if (items.some((s) => keys.has(faKey(s)))) return { error: 'گزینه‌ها نباید تکراری باشند.' };
  if (new Set(items.map(faKey)).size !== items.length) return { error: 'گزینه‌ها نباید تکراری باشند.' };
  return { labels: items };
}

// A custom box name: 1 to 60 visible characters, not a built-in label, a live custom label, a CSV header or a name
// already in `pending` (other new boxes of the same layout). Returns { name, key } or { error }.
// The keys a new custom box name may not have (faKey): every built-in box label, every built-in CSV header and
// English field name, and every live custom box label. The editor gets the same list (data-taken).
export function takenNameKeys(db) {
  return new Set([
    ...BOXES.map((b) => faKey(b.label)),
    ...reservedHeaderKeys(),
    ...liveCustomBoxes(db).map((b) => faKey(b.label)),
  ]);
}

export function checkName(db, label, pending = new Set()) {
  const name = normalizeText(label);
  if (!hasVisible(name) || len(name) > LIMITS.boxName) return { error: 'نام کادر باید بین ۱ تا ۶۰ نویسه باشد.' };
  const key = faKey(name);
  const taken = takenNameKeys(db).has(key);
  if (taken || pending.has(key)) return { error: 'این نام قبلاً برای کادر دیگری استفاده شده است.' };
  return { name, key };
}

// Choice ids are never reused: the next id is one more than the highest ever handed out (choice_seq) or in use.
// `?? 0`: a row read from before the column existed has no value.
const nextChoiceId = (box) => Math.max(box.choice_seq ?? 0, ...box.choices.map((c) => c.id)) + 1;

const liveBox = (db, id) => db.prepare('SELECT * FROM custom_boxes WHERE id = ? AND deleted_at IS NULL').get(id);

// Creates a custom box. Its name must be unique after faKey among live custom boxes, built-in box names and CSV
// headers. Returns { box } or { error }.
export function createCustomBox(db, { type, label, choices }, userId) {
  return db.transaction(() => {
    if (!CUSTOM_TYPE_IDS.has(type)) return { error: 'نوع کادر را انتخاب کنید.' };
    const checked = checkName(db, label);
    if (checked.error) return checked;
    const { name } = checked;
    let stored = null;
    let seq = 0;
    if (type === 'choice') {
      const split = splitChoices(choices);
      if (split.error) return { error: split.error };
      stored = split.labels.map((text, i) => ({ id: i + 1, label: text, hidden: false }));
      seq = stored.length;
    }
    const info = db.prepare('INSERT INTO custom_boxes (type, label, choices, created_at, choice_seq) VALUES (?, ?, ?, ?, ?)')
      .run(type, name, stored ? JSON.stringify(stored) : null, new Date().toISOString(), seq);
    const id = Number(info.lastInsertRowid);
    audit(db, { userId, action: 'custom_box.create', detail: `${id} ${type} ${name}` });
    return { box: parseBox(db.prepare('SELECT * FROM custom_boxes WHERE id = ?').get(id)) };
  })();
}

// Shows or hides one choice of a live choice box. A hidden choice stays on the profile and in exports.
export function setChoiceHidden(db, boxId, choiceId, hidden, userId) {
  return db.transaction(() => {
    const row = liveBox(db, boxId);
    if (!row || row.type !== 'choice') return { error: 'کادر پیدا نشد.' };
    const box = parseBox(row);
    const choice = box.choices.find((c) => c.id === Number(choiceId));
    if (!choice) return { error: 'گزینه پیدا نشد.' };
    choice.hidden = Boolean(hidden);
    db.prepare('UPDATE custom_boxes SET choices = ? WHERE id = ?').run(JSON.stringify(box.choices), box.id);
    audit(db, { userId, action: 'custom_box.edit', detail: `${box.id} ${hidden ? 'hide' : 'show'} ${choice.id}` });
    return { ok: true };
  })();
}

// Removes a choice. Refused while any patient holds it; the next choice id still moves past it (choice_seq).
export function removeChoice(db, boxId, choiceId, userId) {
  return db.transaction(() => {
    const row = liveBox(db, boxId);
    if (!row || row.type !== 'choice') return { error: 'کادر پیدا نشد.' };
    const box = parseBox(row);
    const id = Number(choiceId);
    if (!box.choices.some((c) => c.id === id)) return { error: 'گزینه پیدا نشد.' };
    const held = db.prepare('SELECT 1 FROM patient_values WHERE box_id = ? AND value = ? LIMIT 1').get(box.id, String(id));
    if (held) return { error: 'بیماری این گزینه را دارد و حذف نمی‌شود. آن را از فرم پنهان کنید.' };
    const rest = box.choices.filter((c) => c.id !== id);
    db.prepare('UPDATE custom_boxes SET choices = ?, choice_seq = ? WHERE id = ?')
      .run(JSON.stringify(rest), nextChoiceId(box) - 1, box.id);
    audit(db, { userId, action: 'custom_box.edit', detail: `${box.id} remove ${id}` });
    return { ok: true };
  })();
}

// Appends labels to a choice box. Same split and checks as create (labels unique across the box, 30 at most in all).
export function addChoices(db, boxId, text, userId) {
  return db.transaction(() => {
    const row = liveBox(db, boxId);
    if (!row || row.type !== 'choice') return { error: 'کادر پیدا نشد.' };
    const box = parseBox(row);
    const split = splitChoices(text, 1, box.choices);
    if (split.error) return { error: split.error };
    let next = nextChoiceId(box);
    const added = split.labels.map((label) => ({ id: next++, label, hidden: false }));
    const all = [...box.choices, ...added];
    db.prepare('UPDATE custom_boxes SET choices = ?, choice_seq = ? WHERE id = ?')
      .run(JSON.stringify(all), next - 1, box.id);
    for (const c of added) audit(db, { userId, action: 'custom_box.edit', detail: `${box.id} add ${c.id}` });
    return { ok: true };
  })();
}

// Deletes a custom box for good. Refused while any patient has a value in it. Returns { ok } or { error }.
export function deleteCustomBox(db, id, userId) {
  return db.transaction(() => {
    const box = db.prepare('SELECT * FROM custom_boxes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!box) return { error: 'کادر پیدا نشد.' };
    const used = db.prepare('SELECT 1 FROM patient_values WHERE box_id = ? LIMIT 1').get(box.id);
    if (used) return { error: 'این کادر مقدار دارد و حذف نمی‌شود. آن را از فرم پنهان کنید.' };
    db.prepare('UPDATE custom_boxes SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), box.id);
    audit(db, { userId, action: 'custom_box.delete', detail: `${box.id} ${box.type}` });
    return { ok: true };
  })();
}

// Checks one raw value of a custom box, the same way for the form and for CSV import. Without `byLabel` a choice
// takes its id only (the form). With `byLabel` (CSV) a choice takes its label only, and yes/no also takes «بله»,
// «خیر», yes and no. `keep` is the value the patient already holds; it may be a hidden choice.
// Returns { value } (text for storage, null when empty) or { error } (Persian).
export function checkCustomValue(box, raw, { byLabel = false, keep } = {}) {
  const text = normalizeText(raw);
  switch (box.type) {
    case 'short_text':
    case 'long_text': {
      if (text === '') return { value: null };
      const [max, msg] = box.type === 'long_text'
        ? [LIMITS.longText, 'بیش از ۵۰۰۰ نویسه است.']
        : [LIMITS.shortText, 'بیش از ۲۰۰ نویسه است.'];
      return len(text) > max ? { error: msg } : { value: text };
    }
    case 'number': {
      if (text === '') return { value: null };
      if (text.includes(',')) return { error: 'عدد را بدون جداکننده‌ی هزارگان و با ممیز بنویسید.' };
      const s = text.replace('٫', '.');
      if (!/^-?\d{1,9}(\.\d{1,2})?$/.test(s)) return { error: 'عدد را درست وارد کنید، مثلاً ۶۸٫۵ یا -۳٫۵.' };
      return { value: String(Number(s)) };
    }
    case 'date': {
      if (text === '') return { value: null };
      const iso = parseJalali(text);
      return iso ? { value: iso } : { error: 'تاریخ را به شکل ۱۴۰۳/۰۵/۱۲ وارد کنید.' };
    }
    case 'choice': {
      if (text === '') return { value: null };
      const choices = box.choices ?? [];
      // The form sends ids. CSV (byLabel) sends labels only. A hidden choice is refused, unless it is the value
      // the patient already holds (`keep`), so an old value stays saveable.
      const hit = byLabel
        ? choices.find((c) => !c.hidden && normalizeText(c.label) === text)
        : choices.find((c) => /^\d+$/.test(text) && c.id === Number(text) && (!c.hidden || text === String(keep)));
      if (hit) return { value: String(hit.id) };
      return { error: 'گزینه را از فهرست انتخاب کنید.' };
    }
    case 'yes_no': {
      if (text === '') return { value: null };
      if (text === '1' || text === '0') return { value: text };
      if (byLabel) {
        const key = faKey(text);
        if (key === 'بله' || key === 'yes') return { value: '1' };
        if (key === 'خیر' || key === 'no') return { value: '0' };
      }
      return { error: 'بله یا خیر را انتخاب کنید.' };
    }
    default:
      return { error: 'نوع کادر نامعتبر است.' };
  }
}

// The text people read for a stored value: the choice label, «بله» / «خیر», a Jalali date (1403/05/12), a number.
// `ascii: true` keeps ASCII digits (CSV); otherwise digits are Persian (profile).
export function customDisplay(box, value, { ascii = false } = {}) {
  if (value === null || value === undefined || value === '') return '';
  const digits = (s) => (ascii ? s : faDigits(s));
  switch (box.type) {
    case 'date': return digits(toJalaliInput(value));
    case 'number': return digits(value);
    case 'choice': {
      const choice = (box.choices ?? []).find((c) => String(c.id) === String(value));
      return choice ? choice.label : '(گزینه‌ی حذف‌شده)';
    }
    case 'yes_no': return value === '1' ? 'بله' : 'خیر';
    default: return String(value);
  }
}

// The live custom boxes the saved form layout shows, in layout order (the CSV template's custom columns).
export function shownCustomBoxes(db, layout) {
  const live = new Map(liveCustomBoxes(db).map((b) => [b.id, b]));
  return layout.cards.flatMap((c) => c.boxes.map((b) => b.id))
    .filter((id) => id.startsWith('c:')).map((id) => live.get(Number(id.slice(2)))).filter(Boolean);
}

// Export columns of the custom boxes: [[key, name]] with key `c<id>`. The shown ones come first, in layout order,
// then the hidden live ones by id. Deleted boxes are left out.
export function customColumns(db, layout) {
  const live = new Map(liveCustomBoxes(db).map((b) => [b.id, b]));
  const shown = shownCustomBoxes(db, layout).map((b) => b.id);
  const hidden = [...live.keys()].filter((id) => !shown.includes(id));
  return [...shown, ...hidden].map((id) => [`c${id}`, live.get(id).label]);
}

// The rows with their custom cells: `row['c<id>']` is the readable text of each value the patient has. A value
// of a choice that was removed is left out (the cell stays empty). One query for all rows.
export function addCustomCells(db, rows) {
  const boxes = liveCustomBoxes(db);
  if (!boxes.length || !rows.length) return rows;
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const held = db.prepare(`SELECT patient_id, box_id, value FROM patient_values WHERE box_id IN (${boxes.map(() => '?').join(',')})`)
    .all(...boxes.map((b) => b.id));
  const cells = new Map();
  for (const { patient_id: patientId, box_id: boxId, value } of held) {
    const box = byId.get(boxId);
    if (box.type === 'choice' && !box.choices.some((c) => String(c.id) === value)) continue;
    const text = customDisplay(box, value, { ascii: true });
    if (text === '') continue;
    if (!cells.has(patientId)) cells.set(patientId, {});
    cells.get(patientId)[`c${boxId}`] = text;
  }
  return rows.map((r) => (cells.has(r.id) ? { ...r, ...cells.get(r.id) } : r));
}

// Stored custom values of one patient, as { [boxId]: value }.
export function customValues(db, patientId) {
  return Object.fromEntries(
    db.prepare('SELECT box_id, value FROM patient_values WHERE patient_id = ?').all(patientId)
      .map((r) => [r.box_id, r.value]),
  );
}

// Writes the given custom values: an upsert, or a delete when the value is null. Ids that are not live custom
// boxes are skipped, and ids not given are not touched. Call it inside the caller's transaction (the patient save),
// so the patient row and its values commit together.
export function writeCustomValues(db, patientId, valuesByBoxId) {
  const live = new Set(db.prepare('SELECT id FROM custom_boxes WHERE deleted_at IS NULL').pluck().all());
  for (const [key, value] of Object.entries(valuesByBoxId)) {
    if (value === undefined) continue;
    const boxId = Number(key);
    if (!live.has(boxId)) continue;
    if (value === null) {
      db.prepare('DELETE FROM patient_values WHERE patient_id = ? AND box_id = ?').run(patientId, boxId);
    } else {
      db.prepare(`INSERT INTO patient_values (patient_id, box_id, value) VALUES (?, ?, ?)
        ON CONFLICT(patient_id, box_id) DO UPDATE SET value = excluded.value`).run(patientId, boxId, String(value));
    }
  }
}
