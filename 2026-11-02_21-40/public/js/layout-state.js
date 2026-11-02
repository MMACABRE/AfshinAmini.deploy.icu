// State of the patient form layout editor (D52, D53). Pure functions only: no DOM, no fetch, no globals. Every
// operation returns a new state and never changes its input. app.js renders the DOM from this state and posts
// toLayout(state); the server checks the result with checkLayout, the same as any other layout.
//
// State: { cards: [{ id, label?, boxes: [{ id, req }] }], hidden: [boxId], meta, cardLabels, news }
//   meta: { boxId: { label, type?, full?, locked? } } from the server data-boxes (built-in and live custom boxes)
//   cardLabels: { builtInCardId: label } from the server data-cards
//   news: { 'new:<k>': { type, label, choices } } for boxes added in this draft (label '' until named)
//
// The text rules (normalizeText, faKey, the visible-character check) are copies of src/lib/normalize.js and
// src/lib/layout-catalogue.js, unchanged; test/layout-state.test.js checks them against the server.

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function toAsciiDigits(s) {
  return String(s).replace(/[۰-۹٠-٩]/g, (d) => {
    const i = FA_DIGITS.indexOf(d);
    return String(i >= 0 ? i : AR_DIGITS.indexOf(d));
  });
}

// For storage: Arabic letter forms to Persian, ASCII digits, no tatweel, tidy spaces.
export function normalizeText(s) {
  if (s === null || s === undefined) return '';
  return toAsciiDigits(String(s).normalize('NFC'))
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ـ/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// For comparison only: also ignores zero-width non-joiners, spaces and case, and folds Arabic letter
// forms that Persian keyboards rarely type (ة أ إ ٱ ؤ), so "فاطمة" finds "فاطمه".
export function faKey(s) {
  return normalizeText(s).replace(/[‌\s]+/g, '').replace(/ة/g, 'ه').replace(/[أإٱ]/g, 'ا').replace(/ؤ/g, 'و')
    .toLowerCase();
}


const INVISIBLE_ONLY = /^[\s​-‏⁠﻿]*$/;

export const TYPES = ['short_text', 'long_text', 'number', 'date', 'choice', 'yes_no'];
const NAMES = ['first_name', 'last_name'];
const LIMITS = { cards: 12, boxes: 80, boxName: 60, cardLabel: 40, choicesMin: 2, choicesMax: 30, newBoxes: 99 };
const visible = (s) => !INVISIBLE_ONLY.test(String(s));
const lengthOf = (s) => [...s].length;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ---- reading and writing ----

// The state for a saved layout. Built-in cards the layout does not list are added (empty) at the end.
export function fromLayout(layout, boxes, cards) {
  const list = layout.cards.map((c) => {
    const boxesOf = c.boxes.map((b) => ({ id: b.id, req: b.req === true }));
    return c.label !== undefined ? { id: c.id, label: c.label, boxes: boxesOf } : { id: c.id, boxes: boxesOf };
  });
  for (const id of Object.keys(cards)) {
    if (!list.some((c) => c.id === id)) list.push({ id, boxes: [] });
  }
  return withHidden({ cards: list, meta: boxes, cardLabels: cards, news: {}, hidden: [] });
}

// The draft a refused save echoed back (root data-draft), read tolerantly. Unknown or deleted ids are dropped,
// duplicates too, `new:<k>` items are re-created as new boxes (checked like nameBox), first and last name are put
// back. Anything else wrong gives null, and the editor shows the saved layout instead.
export function fromDraft(draft, boxes, cards) {
  try {
    const input = typeof draft === 'string' ? JSON.parse(draft) : draft;
    if (input === null || typeof input !== 'object' || Array.isArray(input) || input.v !== 1 || !Array.isArray(input.cards)) return null;
    if (input.cards.length > LIMITS.cards) return null;
    const rawBoxes = input.cards.reduce((n, c) => n + (c && Array.isArray(c.boxes) ? c.boxes.length : 0), 0);
    if (rawBoxes > LIMITS.boxes) return null; // a hostile draft, not a real one
    const news = {};
    const seenCards = new Set();
    const seenBoxes = new Set();
    const layout = { v: 1, cards: [] };
    let boxCount = 0;
    for (const c of input.cards) {
      if (c === null || typeof c !== 'object' || typeof c.id !== 'string') continue;
      let card = null;
      if (own(cards, c.id)) card = { id: c.id, boxes: [] };
      else if (/^card:[1-9]\d{0,2}$/.test(c.id) && typeof c.label === 'string') {
        const label = normalizeText(c.label);
        if (visible(label) && lengthOf(label) <= LIMITS.cardLabel) card = { id: c.id, label, boxes: [] };
      }
      if (!card || seenCards.has(card.id)) continue;
      seenCards.add(card.id);
      for (const b of Array.isArray(c.boxes) ? c.boxes : []) {
        if (b === null || typeof b !== 'object' || typeof b.id !== 'string') continue;
        let id = null;
        if (own(boxes, b.id)) id = b.id;
        else if (/^new:(\d{1,2})$/.test(b.id)) {
          const k = Number(b.id.slice(4));
          const made = k >= 1 && k <= LIMITS.newBoxes && TYPES.includes(b.type) ? newBoxFrom(b, news, k) : null;
          if (made) id = made;
        }
        if (!id || seenBoxes.has(id) || boxCount >= LIMITS.boxes) {
          if (boxCount >= LIMITS.boxes) return null;
          continue;
        }
        seenBoxes.add(id);
        boxCount += 1;
        card.boxes.push(b.req === true ? { id, req: true } : { id, req: false });
      }
      layout.cards.push(card);
    }
    const missing = NAMES.filter((name) => !seenBoxes.has(name));
    if (missing.length) {
      if (!layout.cards.length) layout.cards.push({ id: 'identity', boxes: [] });
      layout.cards[0].boxes.unshift(...missing.map((id) => ({ id, req: true })));
    }
    return { ...fromLayout(layout, boxes, cards), news };
  } catch {
    return null;
  }
}

// Checks a new box from a draft or a name; fills `news` and returns its id, or null when it is not usable.
function newBoxFrom(b, news, k) {
  const id = `new:${k}`;
  const label = normalizeText(typeof b.label === 'string' ? b.label : '');
  if (!visible(label) || lengthOf(label) > LIMITS.boxName) return null;
  let choices = null;
  if (b.type === 'choice') {
    const checked = checkChoices(typeof b.choices === 'string' ? b.choices : '');
    if (checked.error) return null;
    choices = checked.list;
  }
  news[id] = { type: b.type, label, choices };
  return id;
}

// The JSON object to post. New boxes carry their type and label (choices as one comma-separated text).
export function toLayout(state) {
  return {
    v: 1,
    cards: state.cards.map((card) => {
      const out = card.label !== undefined ? { id: card.id, label: card.label } : { id: card.id };
      out.boxes = card.boxes.map((b) => {
        const item = b.id.startsWith('new:')
          ? { id: b.id, type: state.news[b.id].type, label: state.news[b.id].label }
          : { id: b.id };
        if (item.type === 'choice') item.choices = (state.news[b.id].choices ?? []).join(',');
        if (b.req) item.req = true;
        return item;
      });
      return out;
    }),
  };
}

// ---- helpers ----

function withHidden(state) {
  const placed = new Set(state.cards.flatMap((c) => c.boxes.map((b) => b.id)));
  const hidden = Object.keys(state.meta).filter((id) => !placed.has(id) && !state.meta[id].locked);
  return { ...state, hidden };
}

const find = (state, boxId) => {
  for (let ci = 0; ci < state.cards.length; ci += 1) {
    const index = state.cards[ci].boxes.findIndex((b) => b.id === boxId);
    if (index >= 0) return { ci, index };
  }
  return null;
};

const clamp = (n, max) => Math.max(0, Math.min(n, max));
const cardIndex = (state, cardId) => state.cards.findIndex((c) => c.id === cardId);
const firstCardId = (state) => state.cards[0].id;
const setCards = (state, cards) => withHidden({ ...state, cards });

// ---- boxes ----

// Moves a placed box to a card at an index (counted after the box is removed). A box that is not placed is shown.
export function moveBox(state, boxId, toCardId, toIndex) {
  const at = find(state, boxId);
  if (!at) return showBox(state, boxId, toCardId, toIndex);
  const target = cardIndex(state, toCardId);
  if (target < 0) return state;
  const cards = state.cards.map((c) => ({ ...c, boxes: [...c.boxes] }));
  const [box] = cards[at.ci].boxes.splice(at.index, 1);
  cards[target].boxes.splice(clamp(toIndex, cards[target].boxes.length), 0, box);
  return setCards(state, cards);
}

export function moveCard(state, cardId, toIndex) {
  const from = cardIndex(state, cardId);
  if (from < 0) return state;
  const cards = [...state.cards];
  const [card] = cards.splice(from, 1);
  cards.splice(clamp(toIndex, cards.length), 0, card);
  return setCards(state, cards);
}

// Takes a box off the form. A locked name stays; a new box is dropped entirely.
export function hideBox(state, boxId) {
  const at = find(state, boxId);
  if (!at || (state.meta[boxId] && state.meta[boxId].locked)) return state;
  const cards = state.cards.map((c) => ({ ...c, boxes: c.boxes.filter((b) => b.id !== boxId) }));
  const nextNews = { ...state.news };
  if (boxId.startsWith('new:')) delete nextNews[boxId];
  return withHidden({ ...state, cards, news: nextNews });
}

// Puts a hidden box on a card (the first card, at the end, by default). A placed box stays where it is.
export function showBox(state, boxId, cardId = firstCardId(state), index = Infinity) {
  if (find(state, boxId) || !own(state.meta, boxId)) return state;
  const target = cardIndex(state, cardId);
  if (target < 0) return state;
  const cards = state.cards.map((c) => ({ ...c, boxes: [...c.boxes] }));
  cards[target].boxes.splice(clamp(index, cards[target].boxes.length), 0, { id: boxId, req: false });
  return setCards(state, cards);
}

export function toggleReq(state, boxId) {
  const at = find(state, boxId);
  if (!at || (state.meta[boxId] && state.meta[boxId].locked)) return state;
  const cards = state.cards.map((c) => ({ ...c, boxes: c.boxes.map((b) => ({ ...b })) }));
  const box = cards[at.ci].boxes[at.index];
  box.req = !box.req;
  return setCards(state, cards);
}

// Adds a new box (no name yet) to a card, under the lowest free key 1-99. Returns { state, key }, { key: null } for
// an unknown type, or { error } when 99 new boxes are already in the draft.
export function addNewBox(state, type, cardId = firstCardId(state), index = Infinity) {
  if (!TYPES.includes(type)) return { state, key: null };
  const target = cardIndex(state, cardId);
  if (target < 0) return { state, key: null };
  let key = 1;
  while (own(state.news, `new:${key}`)) key += 1;
  if (key > LIMITS.newBoxes) return { error: 'بیش از ۹۹ کادر تازه در یک بار نمی‌شود؛ اول ذخیره کنید.' };
  const id = `new:${key}`;
  const cards = state.cards.map((c) => ({ ...c, boxes: [...c.boxes] }));
  cards[target].boxes.splice(clamp(index, cards[target].boxes.length), 0, { id, req: false });
  const news = { ...state.news, [id]: { type, label: '', choices: null } };
  return { state: withHidden({ ...state, cards, news }), key };
}

// The choices text of a choice box: split on «,» and «،», trimmed, empties dropped; 2 to 30 items, each 1 to 60
// visible characters, no duplicate keys. Returns { list } or { error }.
function checkChoices(raw) {
  const list = String(raw).split(/[,،]/).map((s) => normalizeText(s)).filter((s) => visible(s));
  if (list.length < LIMITS.choicesMin || list.length > LIMITS.choicesMax) {
    return { error: 'برای انتخاب از فهرست ۲ تا ۳۰ گزینه لازم است.' };
  }
  if (list.some((s) => lengthOf(s) > LIMITS.boxName)) return { error: 'هر گزینه باید بین ۱ تا ۶۰ نویسه باشد.' };
  if (new Set(list.map(faKey)).size !== list.length) return { error: 'گزینه‌ها نباید تکراری باشند.' };
  return { list };
}

// Names a new box. `taken` is the server's list of keys (data-taken). Returns { state } or { error }.
export function nameBox(state, key, label, choices = '', taken = []) {
  const id = `new:${key}`;
  if (!own(state.news, id)) return { error: 'کادر پیدا نشد.' };
  const name = normalizeText(label);
  if (!visible(name)) return { error: 'نام کادر را بنویسید.' };
  if (lengthOf(name) > LIMITS.boxName) return { error: 'نام کادر باید بین ۱ تا ۶۰ نویسه باشد.' };
  const k = faKey(name);
  const others = Object.entries(state.news).filter(([nid, r]) => nid !== id && r.label).map(([, r]) => faKey(r.label));
  if (taken.includes(k) || others.includes(k)) return { error: 'این نام قبلاً استفاده شده است.' };
  const rec = state.news[id];
  let list = null;
  if (rec.type === 'choice') {
    const checked = checkChoices(choices);
    if (checked.error) return { error: checked.error };
    list = checked.list;
  }
  return { state: { ...state, news: { ...state.news, [id]: { type: rec.type, label: name, choices: list } } } };
}

// ---- cards ----

// Adds an empty card at an index (the end by default). Returns { state, id }; its label is '' until named.
export function addCard(state, index = Infinity) {
  const top = state.cards.reduce((n, c) => {
    const m = /^card:(\d+)$/.exec(c.id);
    return m ? Math.max(n, Number(m[1])) : n;
  }, 0);
  const id = `card:${top + 1}`;
  const cards = [...state.cards];
  cards.splice(clamp(index, cards.length), 0, { id, label: '', boxes: [] });
  return { state: setCards(state, cards), id };
}

// Names a card. Returns { state } or { error }.
export function nameCard(state, cardId, label) {
  const i = cardIndex(state, cardId);
  if (i < 0) return { error: 'کارت پیدا نشد.' };
  const name = String(label).trim();
  if (!visible(name)) return { error: 'نام کارت را بنویسید.' };
  if (lengthOf(name) > LIMITS.cardLabel) return { error: 'نام کارت باید بین ۱ تا ۴۰ نویسه باشد.' };
  const cards = state.cards.map((c, j) => (j === i ? { ...c, label: name } : c));
  return { state: setCards(state, cards) };
}

// ---- draft ----

// The draft differs from the loaded layout (a move and a move back is not a change).
export function isDirty(state, initial) {
  return JSON.stringify(toLayout(state)) !== JSON.stringify(toLayout(initial));
}

// Save is allowed only when every new box and card has a name.
export function canSave(state) {
  const boxesNamed = Object.values(state.news).every((r) => r.label !== '');
  const cardsNamed = state.cards.every((c) => !c.id.startsWith('card:') || (c.label !== undefined && c.label !== ''));
  return boxesNamed && cardsNamed;
}

// How much the draft changed, counted per rule: a box added or removed is 1; a box on another card than before is 1;
// a box whose required mark changed is 1; a card present in both whose common boxes changed order is 1; the common
// cards changing order is 1; a card added or removed is 1. Zero exactly when isDirty is false.
export function changeCount(state, initial) {
  const where = (s) => new Map(s.cards.flatMap((c) => c.boxes.map((b) => [b.id, { card: c.id, req: !!b.req }])));
  const a = where(state);
  const b = where(initial);
  let count = 0;
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(id) || !b.has(id)) { count += 1; continue; }
    if (a.get(id).card !== b.get(id).card) count += 1;
    if (a.get(id).req !== b.get(id).req) count += 1;
  }
  // The boxes that stay on the same card in both states, in the order of that card.
  const stayed = (s, card, other) => s.cards.find((c) => c.id === card.id).boxes.map((x) => x.id)
    .filter((x) => other.has(x) && other.get(x).card === card.id);
  for (const card of state.cards) {
    if (!initial.cards.some((c) => c.id === card.id)) continue;
    if (stayed(state, card, b).join('|') !== stayed(initial, card, a).join('|')) count += 1;
  }
  const commonCards = (s, other) => s.cards.map((c) => c.id).filter((id) => other.some((c) => c.id === id));
  if (commonCards(state, initial.cards).join('|') !== commonCards(initial, state.cards).join('|')) count += 1;
  const cardIds = new Set([...state.cards.map((c) => c.id), ...initial.cards.map((c) => c.id)]);
  for (const id of cardIds) {
    if (!state.cards.some((c) => c.id === id) || !initial.cards.some((c) => c.id === id)) count += 1;
  }
  return count;
}

// ---- moving with the keyboard and by drag (round 8) ----

// One place earlier (dir -1) or later (dir +1) for a box or a card. A box at the start of a card goes to the end of
// the card before it; at the end, to the start of the card after it. Empty cards are targets like any other card.
// At the very start or end nothing changes.
export function stepItem(state, kind, id, dir) {
  if (kind === 'card') {
    const i = cardIndex(state, id);
    if (i < 0 || i + dir < 0 || i + dir >= state.cards.length) return state;
    return moveCard(state, id, i + dir);
  }
  const at = find(state, id);
  if (!at) return state;
  const card = state.cards[at.ci];
  if (dir < 0) {
    if (at.index > 0) return moveBox(state, id, card.id, at.index - 1);
    if (at.ci > 0) {
      const prev = state.cards[at.ci - 1];
      return moveBox(state, id, prev.id, prev.boxes.length);
    }
    return state;
  }
  if (at.index < card.boxes.length - 1) return moveBox(state, id, card.id, at.index + 1);
  if (at.ci < state.cards.length - 1) return moveBox(state, id, state.cards[at.ci + 1].id, 0);
  return state;
}

// The index (in the list) to insert a dragged item at: rects in list order, the pointer at (x, y). The item is
// inserted before the nearest rect when the pointer is before its centre in reading order (above its row, or on its
// row and before its centre: to its right in right-to-left), otherwise after it.
export function dropIndex(rects, x, y, rtl) {
  if (!rects.length) return 0;
  let best = 0;
  let bestDist = Infinity;
  rects.forEach((r, i) => {
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; best = i; }
  });
  const r = rects[best];
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let before;
  if (y < cy - r.height / 2) before = true;
  else if (y > cy + r.height / 2) before = false;
  else before = rtl ? x > cx : x < cx;
  return before ? best : best + 1;
}

// ---- the dashboard layout editor (round 8, part C). Same rules as the form: pure, immutable, posted as JSON. ----

// State: { widgets: [{ id, size }], quick: [id], sizes: { widgetId: [allowed sizes] }, quickAll: [id] }.
// `widgets` and `quick` are the catalogue (data-widgets, data-quick); `layout` is the saved dashboard layout.
export function dashFromLayout(layout, widgets, quick) {
  return {
    widgets: layout.widgets.map((w) => ({ id: w.id, size: w.size })),
    quick: [...layout.quick],
    sizes: Object.fromEntries(widgets.map((w) => [w.id, w.sizes])),
    quickAll: quick.map((q) => q.id),
  };
}

export function dashToLayout(state) {
  return { v: 1, widgets: state.widgets.map((w) => ({ id: w.id, size: w.size })), quick: [...state.quick] };
}

// Moves a shown widget to a place in the list. A widget that is not shown is left alone.
export function moveWidget(state, id, toIndex) {
  const from = state.widgets.findIndex((w) => w.id === id);
  if (from < 0) return state;
  const widgets = [...state.widgets];
  const [w] = widgets.splice(from, 1);
  widgets.splice(clamp(toIndex, widgets.length), 0, w);
  return { ...state, widgets };
}

export function hideWidget(state, id) {
  if (!state.widgets.some((w) => w.id === id)) return state;
  return { ...state, widgets: state.widgets.filter((w) => w.id !== id) };
}

// Shows a widget that is not on the page, at the end, with its first size.
export function showWidget(state, id) {
  if (state.widgets.some((w) => w.id === id) || !state.sizes[id]) return state;
  return { ...state, widgets: [...state.widgets, { id, size: state.sizes[id][0] }] };
}

// The next allowed size of a widget (wraps to the first).
export function stepSize(state, id) {
  const w = state.widgets.find((x) => x.id === id);
  if (!w) return state;
  const list = state.sizes[id];
  const next = list[(list.indexOf(w.size) + 1) % list.length];
  return { ...state, widgets: state.widgets.map((x) => (x.id === id ? { ...x, size: next } : x)) };
}

export function moveQuick(state, id, toIndex) {
  const from = state.quick.indexOf(id);
  if (from < 0) return state;
  const quick = [...state.quick];
  quick.splice(from, 1);
  quick.splice(clamp(toIndex, quick.length), 0, id);
  return { ...state, quick };
}

export function hideQuick(state, id) {
  if (!state.quick.includes(id)) return state;
  return { ...state, quick: state.quick.filter((q) => q !== id) };
}

export function showQuick(state, id) {
  if (state.quick.includes(id) || !state.quickAll.includes(id)) return state;
  return { ...state, quick: [...state.quick, id] };
}

export function dashIsDirty(state, initial) {
  return JSON.stringify(dashToLayout(state)) !== JSON.stringify(dashToLayout(initial));
}

// Shown or hidden widgets and quick buttons count one each; a size change one; the common widgets or the common quick
// buttons changing order one each. Zero exactly when dashIsDirty is false.
export function dashChangeCount(state, initial) {
  let count = 0;
  const wa = new Map(state.widgets.map((w) => [w.id, w.size]));
  const wb = new Map(initial.widgets.map((w) => [w.id, w.size]));
  for (const id of new Set([...wa.keys(), ...wb.keys()])) {
    if (!wa.has(id) || !wb.has(id)) count += 1;
    else if (wa.get(id) !== wb.get(id)) count += 1;
  }
  const common = (list, other) => list.filter((x) => other.includes(x)).join('|');
  const widgetIds = (s) => s.widgets.map((w) => w.id);
  if (common(widgetIds(state), widgetIds(initial)) !== common(widgetIds(initial), widgetIds(state))) count += 1;
  for (const id of new Set([...state.quick, ...initial.quick])) {
    if (!state.quick.includes(id) || !initial.quick.includes(id)) count += 1;
  }
  if (common(state.quick, initial.quick) !== common(initial.quick, state.quick)) count += 1;
  return count;
}
