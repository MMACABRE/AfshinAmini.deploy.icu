import { normalizeText, faKey } from './normalize.js';
import { toJalaliInput } from './jalali.js';
import { audit } from '../audit.js';
import { STATUS } from './labels.js';
import { CARDS, BOXES, CUSTOM_TYPES, LIMITS, CUSTOM_TYPE_IDS, hasVisible, len, isObj, Reject, BAD_SHAPE } from './layout-catalogue.js';
import { defaultDashboardLayout, cleanDashboard, dashboardFromFields, dashboardFieldsOk } from './dashboard.js';
import {
  liveCustomBoxes, createCustomBox, checkName, splitChoices, customValues, customColumns as columnsOf, shownCustomBoxes as shownOf,
} from './custom-boxes.js';

// Shared by the search, the full zip and the CSV export, which do not hold the form layout: the layout is read here.
export { liveCustomBoxes, addCustomCells } from './custom-boxes.js';
export const shownCustomBoxes = (db) => shownOf(db, readLayout(db, 'patient_form'));
export const customColumns = (db) => columnsOf(db, readLayout(db, 'patient_form'));

// Patient form layout and dashboard layout (D52-D54) and the custom boxes they use (D53). A layout is JSON in the
// `layouts` table; no row means the default. readLayout is forgiving, so a bad row never breaks a page. checkLayout
// is strict and guards every save. Both build their result only from known ids.

const CARD_IDS = new Set(CARDS.map((c) => c.id));
const BOX_BY_ID = new Map(BOXES.map((b) => [b.id, b]));
const NAME_BOXES = ['first_name', 'last_name'];

export function defaultFormLayout() {
  return {
    v: 1,
    cards: CARDS.map((card) => ({
      id: card.id,
      boxes: BOXES.filter((b) => b.card === card.id)
        .map((b) => (NAME_BOXES.includes(b.id) ? { id: b.id, req: true } : { id: b.id })),
    })),
  };
}

// One entry per layout name: the default, the reader (strict or forgiving), and what a save stores. The form's
// `new:<k>` boxes are created first, in the same transaction. Object.hasOwn keeps names like constructor out.
const KINDS = {
  patient_form: {
    make: () => defaultFormLayout(),
    fieldsOk: (body) => Object.keys(body).some((k) => k.startsWith('card_order_')),
    fromFields: (db, body) => layoutFromFields(db, body),
    clean: (db, input, strict) => cleanForm(db, input, customIndex(db), strict),
    materialize: (db, layout, userId) => ({
      v: 1,
      cards: layout.cards.map((card) => ({
        ...card,
        boxes: card.boxes.map((b) => {
          if (!b.id.startsWith('new:')) return b;
          const made = createCustomBox(db, { type: b.type, label: b.label, choices: b.choices?.join(',') }, userId);
          if (made.error) throw new Error(`new custom box refused: ${made.error}`);
          return b.req ? { id: `c:${made.box.id}`, req: true } : { id: `c:${made.box.id}` };
        }),
      })),
    }),
  },
  dashboard: {
    make: () => defaultDashboardLayout(),
    fieldsOk: dashboardFieldsOk,
    fromFields: (db, body) => dashboardFromFields(body),
    clean: (db, input, strict) => cleanDashboard(input, strict),
    materialize: (db, layout) => layout,
  },
};

function kindOf(name) {
  if (!Object.hasOwn(KINDS, name)) throw new Error(`unknown layout ${name}`);
  return KINDS[name];
}

// The kind of one layout, for the routes: fieldsOk(body) and fromFields(db, body).
export const layoutKind = kindOf;

const defaultFor = (name) => kindOf(name).make();
const assertName = (name) => kindOf(name);

// Every custom box id, deleted ones included, so a stale reference can say why it is refused.
function customIndex(db) {
  return new Map(db.prepare('SELECT id, deleted_at FROM custom_boxes').all().map((r) => [r.id, r]));
}

// Resolves one box reference. Built-in ids pass; `c:<n>` needs a live custom box with that id.
function boxRef(id, customs) {
  if (typeof id !== 'string') return { error: 'کادر ناشناخته.' };
  if (BOX_BY_ID.has(id)) return { id };
  const m = /^c:(\d+)$/.exec(id);
  if (!m) return { error: 'کادر ناشناخته.' };
  const n = Number(m[1]);
  const row = customs.get(n);
  if (!row) return { error: 'کادر سفارشی ناشناخته.' };
  if (row.deleted_at) return { error: 'این کادر سفارشی حذف شده است.' };
  return { id: `c:${n}` };
}

// Checks one `new:<k>` box of a layout the way createCustomBox would, and returns it as a clean item. `pending` holds
// the keys and names of the new boxes already checked in the same layout. Throws Reject (strict reads only).
function checkNewBox(db, box, pending) {
  const m = /^new:(\d{1,2})$/.exec(box.id);
  const k = m ? Number(m[1]) : 0;
  if (!m || k < 1 || k > 99 || pending.keys.has(k)) throw new Reject('کادر تازه‌ی چیدمان نامعتبر است.');
  pending.keys.add(k);
  if (!CUSTOM_TYPE_IDS.has(box.type)) throw new Reject('نوع کادر تازه را انتخاب کنید.');
  const name = checkName(db, box.label, pending.names);
  if (name.error) throw new Reject(name.error);
  pending.names.add(name.key);
  let choices = null;
  if (box.type === 'choice') {
    const split = splitChoices(box.choices);
    if (split.error) throw new Reject(split.error);
    choices = split.labels;
  }
  return { id: `new:${k}`, type: box.type, label: name.name, choices };
}

// Shared pass for both readers. In strict mode a problem throws Reject; in forgiving mode the problem is
// dropped and the pass goes on. Returns null for a wrong top-level shape in forgiving mode.
function cleanForm(db, input, customs, strict) {
  const reject = (msg) => { if (strict) throw new Reject(msg); };
  const pending = { keys: new Set(), names: new Set() };
  if (!isObj(input) || input.v !== 1 || !Array.isArray(input.cards)) {
    reject(BAD_SHAPE);
    return null;
  }
  const cards = [];
  const cardIds = new Set();
  const placed = new Set();
  let boxCount = 0;
  for (const card of input.cards) {
    let out = null;
    if (isObj(card) && typeof card.id === 'string') {
      if (CARD_IDS.has(card.id)) {
        out = { id: card.id }; // a built-in card label is ignored, not an error
      } else {
        const m = /^card:(\d{1,3})$/.exec(card.id);
        const n = m ? Number(m[1]) : 0;
        const label = typeof card.label === 'string' ? normalizeText(card.label) : '';
        if (m && n >= 1 && n <= 999 && hasVisible(label) && len(label) <= LIMITS.cardLabel) {
          out = { id: `card:${n}`, label };
        }
      }
    }
    if (!out) { reject('کارت ناشناخته یا نام کارت نامعتبر است.'); continue; }
    if (cardIds.has(out.id)) { reject('کارت تکراری است.'); continue; }
    if (cards.length >= LIMITS.cards) { reject('بیش از ۱۲ کارت نمی‌شود.'); continue; }
    cardIds.add(out.id);

    if (!Array.isArray(card.boxes)) reject('کادرهای کارت نامعتبر است.');
    const boxes = [];
    for (const box of Array.isArray(card.boxes) ? card.boxes : []) {
      if (strict && isObj(box) && typeof box.id === 'string' && box.id.startsWith('new:')) {
        if (boxCount >= LIMITS.boxes) throw new Reject('بیش از ۸۰ کادر نمی‌شود.');
        const fresh = checkNewBox(db, box, pending);
        boxCount += 1;
        const item = { ...fresh };
        if (box.req === true) item.req = true;
        boxes.push(item);
        continue;
      }
      const ref = boxRef(isObj(box) ? box.id : undefined, customs);
      if (ref.error) { reject(ref.error); continue; }
      if (placed.has(ref.id)) { reject('کادر تکراری است.'); continue; }
      if (boxCount >= LIMITS.boxes) { reject('بیش از ۸۰ کادر نمی‌شود.'); continue; }
      placed.add(ref.id);
      boxCount += 1;
      const item = { id: ref.id };
      if (NAME_BOXES.includes(ref.id) || box.req === true) item.req = true;
      boxes.push(item);
    }
    const item = { id: out.id };
    if (out.label !== undefined) item.label = out.label;
    item.boxes = boxes;
    cards.push(item);
  }

  // First and last name can never be left out. A forgiving read puts them back at the start of the first card.
  const missing = NAME_BOXES.filter((id) => !placed.has(id));
  if (missing.length) {
    reject('نام و نام خانوادگی باید در فرم باشند.');
    if (!cards.length) cards.push({ id: 'identity', boxes: [] });
    cards[0].boxes.unshift(...missing.map((id) => ({ id, req: true })));
  }
  return { v: 1, cards };
}

function clean(db, name, input, strict) {
  return kindOf(name).clean(db, input, strict);
}

// Forgiving read. Unknown and duplicate ids are dropped, bad sizes become the default size, and a missing first
// or last name goes back into the first card. A row that does not parse gets the default and one log line that
// names only the layout.
export function readLayout(db, name) {
  assertName(name);
  const row = db.prepare('SELECT current FROM layouts WHERE name = ?').get(name);
  if (!row) return defaultFor(name);
  let input;
  try {
    input = JSON.parse(row.current);
  } catch {
    input = undefined;
  }
  const layout = input === undefined ? null : clean(db, name, input, false);
  if (!layout) {
    console.error(`layout ${name}: stored layout is unreadable, the default is used`);
    return defaultFor(name);
  }
  return layout;
}

// Strict check for a save. `json` is the raw text of the form field. Returns { layout } built only from known
// ids and checked values, or { error } with a Persian message.
export function checkLayout(db, name, json) {
  assertName(name);
  const text = typeof json === 'string' ? json : '';
  if (Buffer.byteLength(text, 'utf8') > LIMITS.json) return { error: 'چیدمان خیلی بزرگ است.' };
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return { error: 'چیدمان خوانده نشد. دوباره تلاش کنید.' };
  }
  try {
    return { layout: clean(db, name, input, true) };
  } catch (err) {
    if (err instanceof Reject) return { error: err.message };
    throw err;
  }
}

// Builds the patient form layout from the no-JS editor's fields and returns it as JSON text for checkLayout.
// Cards: the saved layout's cards, then the built-in cards not in it; sorted by `card_order_<id>` (ties: list order).
// Boxes: names always, any other box only with `show_<id>` = '1'; placed in `card_of_<id>` and sorted by `order_<id>`
// (ties: catalogue order, custom boxes after built-ins by id). `req_<id>` = '1' marks a box required.
export function layoutFromFields(db, body) {
  const saved = readLayout(db, 'patient_form');
  const savedCards = new Map(saved.cards.map((c) => [c.id, c]));
  const cardIds = [...saved.cards.map((c) => c.id), ...CARDS.map((c) => c.id).filter((id) => !savedCards.has(id))];
  const cardRank = new Map(cardIds.map((id, i) => [id, i]));
  const number = (v, fallback) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));
  const savedCardOf = new Map(saved.cards.flatMap((c) => c.boxes.map((b) => [b.id, c.id])));

  const boxes = [
    ...BOXES.map((b, i) => ({ id: b.id, rank: i, home: b.card })),
    ...liveCustomBoxes(db).map((b) => ({ id: `c:${b.id}`, rank: BOXES.length + b.id, home: cardIds[0] })),
  ];
  const placed = new Map(cardIds.map((id) => [id, []]));
  for (const box of boxes) {
    const names = NAME_BOXES.includes(box.id);
    if (!names && body[`show_${box.id}`] !== '1') continue;
    const posted = body[`card_of_${box.id}`];
    const card = cardRank.has(posted) ? posted : (savedCardOf.get(box.id) ?? (cardRank.has(box.home) ? box.home : cardIds[0]));
    placed.get(card).push({ ...box, order: number(body[`order_${box.id}`], 1e9), req: names || body[`req_${box.id}`] === '1' });
  }
  const byOrder = (a, b) => a.order - b.order || a.rank - b.rank;
  const cards = cardIds
    .map((id) => ({ id, order: number(body[`card_order_${id}`], cardRank.get(id) + 1), boxes: placed.get(id) }))
    .sort((a, b) => a.order - b.order || cardRank.get(a.id) - cardRank.get(b.id))
    .map((c) => {
      const out = { id: c.id };
      if (c.id.startsWith('card:')) out.label = savedCards.get(c.id).label;
      out.boxes = c.boxes.sort(byOrder).map((b) => (b.req ? { id: b.id, req: true } : { id: b.id }));
      return out;
    });
  return JSON.stringify({ v: 1, cards });
}

function selectRow(db, name) {
  return db.prepare('SELECT current, previous FROM layouts WHERE name = ?').get(name);
}

// The stored text before a change; with no row, the default layout.
const currentText = (row, name) => (row ? row.current : JSON.stringify(defaultFor(name)));

function store(db, name, current, previous, userId) {
  db.prepare(`INSERT INTO layouts (name, current, previous, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET current = excluded.current, previous = excluded.previous,
    updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(name, current, previous, new Date().toISOString(), userId);
}

// `layout` must come from checkLayout. The old layout becomes the previous one, so one step can be undone.
// Each `new:<k>` box is created first (same code path and audit as the «کادر تازه» form), and the stored layout
// carries its real `c:<id>`. The whole save is one transaction: a failing box creation stores nothing.
export function saveLayout(db, name, layout, userId) {
  assertName(name);
  db.transaction(() => {
    const stored = kindOf(name).materialize(db, layout, userId);
    const row = selectRow(db, name);
    store(db, name, JSON.stringify(stored), currentText(row, name), userId);
    audit(db, { userId, action: 'layout.save', detail: name });
  })();
}

// Swaps the current and previous layouts, so an undo can itself be undone. Returns false when there is no previous.
export function undoLayout(db, name, userId) {
  assertName(name);
  return db.transaction(() => {
    const row = selectRow(db, name);
    if (!row || row.previous === null) return false;
    store(db, name, row.previous, row.current, userId);
    audit(db, { userId, action: 'layout.undo', detail: name });
    return true;
  })();
}

// Saves the default layout as the current one; the old one becomes the previous one.
export function resetLayout(db, name, userId) {
  assertName(name);
  db.transaction(() => {
    const row = selectRow(db, name);
    store(db, name, JSON.stringify(defaultFor(name)), currentText(row, name), userId);
    audit(db, { userId, action: 'layout.reset', detail: name });
  })();
}

// A box with its full-width mark from the catalogue: built-in entries carry `full`, a custom row takes it from its type.
export function withSpan(box) {
  const full = box.type !== undefined ? CUSTOM_TYPES.find((t) => t.id === box.type).full : box.full;
  return { ...box, full: full === true };
}

// Every local the form-box partial reads, for a preview or a test. `values` and `errors` are plain objects.
export function previewLocals(box, { required = false, values = {}, errors = {}, disabled = false } = {}) {
  return {
    box: withSpan(box),
    required,
    v: (k) => values[k] ?? '',
    err: (k) => errors[k],
    suggestions: { visit_reason: [], referral: [] },
    disabled,
    nextCode: '',
    options: [],
    labels: { STATUS },
  };
}

// The box ids a form posted (its `boxes` field): built-in ids and `c:<n>` of live custom boxes. Anything else is
// dropped. The first and last name are always shown (they can never be hidden). When the field is missing or is not
// one string (an old client, a repeated field, a test that posts fields directly), the boxes the saved layout shows
// count as shown, never every box.
export function shownBoxIds(db, boxesField) {
  const live = liveCustomBoxes(db).map((b) => `c:${b.id}`);
  if (typeof boxesField !== 'string') {
    const saved = readLayout(db, 'patient_form').cards.flatMap((c) => c.boxes.map((b) => b.id));
    return new Set([...NAME_BOXES, ...saved]);
  }
  const liveSet = new Set(live);
  const posted = boxesField.split(',').map((s) => s.trim()).filter((id) => BOX_BY_ID.has(id) || liveSet.has(id));
  return new Set([...NAME_BOXES, ...posted]);
}

// Ids of the boxes marked required in a layout.
export function requiredBoxIds(layout) {
  return new Set(layout.cards.flatMap((c) => c.boxes.filter((b) => b.req).map((b) => b.id)));
}

// Stored custom values as form input: { c_<id>: text }, with a date shown as Jalali.
export function customFormValues(db, patientId) {
  const types = new Map(db.prepare('SELECT id, type FROM custom_boxes').all().map((r) => [r.id, r.type]));
  return Object.fromEntries(Object.entries(customValues(db, patientId)).map(([id, value]) => [
    `c_${id}`, types.get(Number(id)) === 'date' ? toJalaliInput(value) : value,
  ]));
}
