// Stock (D26, D37). Counted in pieces, up to two decimal places (src/lib/qty.js). Each stock-in is a lot with its own expiry and remaining count; every change
// is a row in stock_moves and updates the lot's remaining count in the same transaction. better-sqlite3 runs a
// transaction to the end before any other request is handled, so "check, then take" cannot interleave with another
// request, and lots.remaining has CHECK (remaining >= 0) as a last line of defence.
import { localDay, faDigits } from './jalali.js';
import { roundQty } from './qty.js';

export class StockShortError extends Error {
  constructor(available) {
    super('not enough stock');
    this.available = available;
  }
}

// Persian message for a shortage, with the real count.
export const shortMessage = (name, available) =>
  `موجودی «${name}» کافی نیست؛ موجود قابل مصرف: ${faDigits(available)} عدد.`;

// Usable: something left and not expired (a lot expiring today is still usable today).
const USABLE = '(l.remaining > 0 AND (l.expires_on IS NULL OR l.expires_on >= ?))';

export function usableLots(db, itemId, today = localDay()) {
  return db.prepare(`SELECT l.* FROM lots l WHERE l.item_id = ? AND ${USABLE}
                     ORDER BY l.expires_on IS NULL, l.expires_on, l.id`).all(itemId, today);
}

export function available(db, itemId, today = localDay()) {
  return db.prepare(`SELECT ROUND(COALESCE(SUM(l.remaining), 0), 2) FROM lots l WHERE l.item_id = ? AND ${USABLE}`).pluck().get(itemId, today);
}

const insertMove = (db, m) => db.prepare('INSERT INTO stock_moves (lot_id, qty, reason, line_id, note, user_id) VALUES (?, ?, ?, ?, ?, ?)')
  .run(m.lotId, m.qty, m.reason, m.lineId ?? null, m.note ?? null, m.userId ?? null);
const bump = (db, lotId, delta) => db.prepare('UPDATE lots SET remaining = ROUND(remaining + ?, 2) WHERE id = ?').run(delta, lotId);

// A stock-in: a new lot plus its 'in' move. Returns the lot id.
export function stockIn(db, { itemId, qty, receivedOn = localDay(), expiresOn = null, unitCost = null, userId = null }) {
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO lots (item_id, received_on, qty_in, remaining, expires_on, unit_cost, created_by)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(itemId, receivedOn, qty, qty, expiresOn, unitCost, userId).lastInsertRowid);
    insertMove(db, { lotId: id, qty, reason: 'in', userId });
    return id;
  })();
}

// Takes qty pieces for a bill line from the earliest-expiring usable lots (lots without expiry last), splitting
// across lots as needed. Throws StockShortError (nothing written) when the usable total is too small.
// Returns [[lotId, pieces], ...]. Call inside the caller's transaction or on its own.
export function takeStock(db, { itemId, qty, lineId = null, userId = null, today = localDay() }) {
  return db.transaction(() => {
    const lots = usableLots(db, itemId, today);
    const total = roundQty(lots.reduce((s, l) => s + l.remaining, 0));
    if (total < qty) throw new StockShortError(total);
    const taken = [];
    let left = qty;
    for (const lot of lots) {
      if (left <= 0) break;
      const n = roundQty(Math.min(lot.remaining, left));
      bump(db, lot.id, -n);
      insertMove(db, { lotId: lot.id, qty: -n, reason: 'use', lineId, userId });
      taken.push([lot.id, n]);
      left = roundQty(left - n);
    }
    return taken;
  })();
}

// Puts back everything a bill line still holds, to the same lots (even an expired one: it then stays alerted until
// written off). Returns the number of pieces returned.
export function returnStock(db, { lineId, userId = null }) {
  return db.transaction(() => {
    const held = db.prepare(`SELECT lot_id, -ROUND(SUM(qty), 2) AS n FROM stock_moves WHERE line_id = ? AND reason IN ('use', 'return')
                             GROUP BY lot_id HAVING ROUND(SUM(qty), 2) < 0`).all(lineId);
    let pieces = 0;
    for (const h of held) {
      bump(db, h.lot_id, h.n);
      insertMove(db, { lotId: h.lot_id, qty: h.n, reason: 'return', lineId, userId });
      pieces += h.n;
    }
    return roundQty(pieces);
  })();
}

// Count correction: sets one lot's remaining count to what was really counted.
export function countLot(db, { lotId, counted, note = null, userId = null }) {
  return db.transaction(() => {
    const lot = db.prepare('SELECT * FROM lots WHERE id = ?').get(lotId);
    if (!lot) return null;
    const delta = roundQty(counted - lot.remaining);
    if (delta !== 0) {
      bump(db, lotId, delta);
      insertMove(db, { lotId, qty: delta, reason: 'count', note, userId });
    }
    return delta;
  })();
}

// Waste: writes pieces of one lot off (expired, broken). Refused when the lot holds fewer.
export function wasteLot(db, { lotId, qty, note, userId = null }) {
  return db.transaction(() => {
    const lot = db.prepare('SELECT * FROM lots WHERE id = ?').get(lotId);
    if (!lot) return null;
    if (qty > lot.remaining) throw new StockShortError(lot.remaining);
    bump(db, lotId, -qty);
    insertMove(db, { lotId, qty: -qty, reason: 'waste', note, userId });
    return qty;
  })();
}

// ---- Removing a wrong history entry (owner request 2026-10-25) ------------------
// code: 'bill' (use and return belong to a visit bill: remove the bill line instead), 'later' (a stock-in whose lot
// already has other entries), 'short' (reversing it would leave the lot below zero; `available` holds what is left).
export class StockUndoError extends Error {
  constructor(code, available = null) {
    super(`stock entry cannot be removed: ${code}`);
    this.code = code;
    this.available = available;
  }
}

// Deletes one stock_moves row and undoes its effect, in one transaction. A stock-in takes its lot with it.
// Returns the removed move (with item_id), or null when there is no such move.
export function deleteMove(db, { moveId }) {
  return db.transaction(() => {
    const move = db.prepare('SELECT m.*, l.item_id, l.remaining FROM stock_moves m JOIN lots l ON l.id = m.lot_id WHERE m.id = ?').get(moveId);
    if (!move) return null;
    if (move.reason === 'use' || move.reason === 'return') throw new StockUndoError('bill');
    if (move.reason === 'in') {
      const others = db.prepare('SELECT COUNT(*) FROM stock_moves WHERE lot_id = ? AND id <> ?').pluck().get(move.lot_id, move.id);
      if (others) throw new StockUndoError('later');
      db.prepare('DELETE FROM stock_moves WHERE id = ?').run(move.id);
      db.prepare('DELETE FROM lots WHERE id = ?').run(move.lot_id);
      return move;
    }
    // count or waste: take its quantity back off (or put it back on) the lot.
    if (roundQty(move.remaining - move.qty) < 0) throw new StockUndoError('short', move.remaining);
    bump(db, move.lot_id, -move.qty);
    db.prepare('DELETE FROM stock_moves WHERE id = ?').run(move.id);
    return move;
  })();
}

// Deletes a stock item with every lot and stock history row, in one transaction (owner request 2026-10-27). Bill
// lines keep their frozen name, quantity and price, so patient bills and balances stay as they were; an item that a
// bill line names keeps a hidden catalog row (deleted_at) because bill_lines.catalog_id points at it.
// Returns { lots, moves, kept } or null when there is no such item.
export function deleteItem(db, { itemId }) {
  return db.transaction(() => {
    const item = db.prepare("SELECT id FROM catalog WHERE id = ? AND kind = 'item' AND deleted_at IS NULL").get(itemId);
    if (!item) return null;
    const moves = db.prepare('DELETE FROM stock_moves WHERE lot_id IN (SELECT id FROM lots WHERE item_id = ?)').run(item.id).changes;
    const lots = db.prepare('DELETE FROM lots WHERE item_id = ?').run(item.id).changes;
    const kept = Boolean(db.prepare('SELECT 1 FROM bill_lines WHERE catalog_id = ? LIMIT 1').get(item.id));
    if (kept) db.prepare("UPDATE catalog SET active = 0, deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(item.id);
    else db.prepare('DELETE FROM catalog WHERE id = ?').run(item.id);
    return { lots, moves, kept };
  })();
}

// ---- Alerts -------------------------------------------------------------
const DAY_MS = 86_400_000;
export const daysUntil = (iso, today = localDay()) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);

// 'expired' | 'crit' (10 days or less) | 'warn' (30 days or less) | null, for a lot that still holds stock.
export function expiryLevel(lot, today = localDay()) {
  if (!lot.expires_on || lot.remaining <= 0) return null;
  const d = daysUntil(lot.expires_on, today);
  return d < 0 ? 'expired' : d <= 10 ? 'crit' : d <= 30 ? 'warn' : null;
}

// 'crit' | 'warn' | null for an item's usable count against its own or the default levels.
export function lowLevel(item, count, settings) {
  const crit = item.low_crit ?? settings.low_crit;
  const warn = item.low_warn ?? settings.low_warn;
  return count <= crit ? 'crit' : count <= warn ? 'warn' : null;
}

// Every active stock item with its usable count, nearest usable expiry and alert levels.
export function itemsWithStock(db, settings, today = localDay()) {
  const items = db.prepare(`SELECT c.*,
      (SELECT ROUND(COALESCE(SUM(l.remaining), 0), 2) FROM lots l WHERE l.item_id = c.id AND ${USABLE}) AS usable,
      (SELECT MIN(l.expires_on) FROM lots l WHERE l.item_id = c.id AND ${USABLE}) AS next_expiry
    FROM catalog c WHERE c.kind = 'item' AND c.active = 1 ORDER BY c.name`).all(today, today);
  const lots = db.prepare('SELECT * FROM lots WHERE remaining > 0 AND expires_on IS NOT NULL').all();
  return items.map((it) => {
    const levels = lots.filter((l) => l.item_id === it.id).map((l) => expiryLevel(l, today)).filter(Boolean);
    const expiry = ['expired', 'crit', 'warn'].find((x) => levels.includes(x)) ?? null;
    return { ...it, low: lowLevel(it, it.usable, settings), expiry };
  });
}

// The dashboard «هشدارها» list: red first (critical low stock, expired or expiring within 10 days), then yellow.
export function alerts(db, settings, today = localDay()) {
  const out = [];
  for (const it of itemsWithStock(db, settings, today)) {
    if (it.low) out.push({ item: it, level: it.low, text: `موجودی کم: ${faDigits(it.usable)} عدد` });
    if (it.expiry === 'expired') out.push({ item: it, level: 'crit', text: 'منقضی شده؛ باید به ضایعات برود' });
    else if (it.expiry) out.push({ item: it, level: it.expiry, text: it.expiry === 'crit' ? 'انقضا در ۱۰ روز آینده' : 'انقضا در ۳۰ روز آینده' });
  }
  return out.sort((a, b) => (a.level === b.level ? a.item.name.localeCompare(b.item.name, 'fa') : a.level === 'crit' ? -1 : 1));
}
