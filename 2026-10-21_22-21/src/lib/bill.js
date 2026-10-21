// Visit bill and payments (D27-D28). The visit is the bill: its lines, discounts and payments. Every total is
// computed from the rows, never stored. Money is whole Rial. Stock for item lines moves in the same transaction
// as the line (src/lib/stock.js), so a bill and the store can never disagree.
import { discountOf } from './money.js';
import { takeStock, returnStock } from './stock.js';
import { localDay } from './jalali.js';

export class BillError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

export const lineGross = (l) => (l.override_price ?? l.unit_price) * l.qty;

// Lines with their amounts, the payments, and every total of one visit.
export function billFor(db, visit) {
  const lines = db.prepare('SELECT * FROM bill_lines WHERE visit_id = ? ORDER BY id').all(visit.id).map((l) => {
    const gross = lineGross(l);
    const disc = discountOf(gross, l.disc_kind, l.disc_value);
    return { ...l, gross, disc, net: gross - disc };
  });
  const payments = db.prepare(`SELECT p.*, m.name AS method, a.name AS account, u.display_name AS who,
                                      (SELECT v2.visit_date FROM payments p2 JOIN visits v2 ON v2.id = p2.visit_id
                                       WHERE p2.move_id = p.move_id AND p2.id <> p.id) AS other_date
                               FROM payments p LEFT JOIN pay_methods m ON m.id = p.method_id
                               LEFT JOIN accounts a ON a.id = p.account_id LEFT JOIN users u ON u.id = p.created_by
                               WHERE p.visit_id = ? ORDER BY p.paid_on, p.id`).all(visit.id);
  const subtotal = lines.reduce((s, l) => s + l.net, 0);
  const billDisc = discountOf(subtotal, visit.disc_kind, visit.disc_value);
  const cancelled = visit.status === 'cancelled';
  const owed = cancelled ? 0 : subtotal - billDisc;
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const lineDisc = lines.reduce((s, l) => s + l.disc, 0);
  return {
    lines, payments, cancelled,
    gross: lines.reduce((s, l) => s + l.gross, 0), lineDisc, subtotal, billDisc,
    discount: lineDisc + billDisc, owed, paid,
    remaining: Math.max(owed - paid, 0), credit: Math.max(paid - owed, 0),
  };
}

// One patient's remaining and credit across all their visits (profile strip).
export function patientBalance(db, patientId) {
  let remaining = 0;
  let credit = 0;
  for (const v of db.prepare('SELECT * FROM visits WHERE patient_id = ?').all(patientId)) {
    const b = billFor(db, v);
    remaining += b.remaining;
    credit += b.credit;
  }
  return { remaining, credit };
}

// Totals only, for lists (history, day list, search).
export const totalsFor = (db, visit) => {
  const b = billFor(db, visit);
  return { owed: b.owed, paid: b.paid, remaining: b.remaining, credit: b.credit };
};

// Position of a visit among the patient's non-cancelled visits by date and time ("ویزیت ۳"). Null when cancelled.
export function visitNumber(db, visit) {
  if (visit.status === 'cancelled') return null;
  return db.prepare(`SELECT COUNT(*) FROM visits WHERE patient_id = ? AND status <> 'cancelled'
                     AND (visit_date < ? OR (visit_date = ? AND (visit_time < ? OR (visit_time = ? AND id <= ?))))`)
    .pluck().get(visit.patient_id, visit.visit_date, visit.visit_date, visit.visit_time, visit.visit_time, visit.id);
}

// ---- Lines --------------------------------------------------------------
// Adds a catalog entry to the bill at today's catalog price. An item takes its stock now (StockShortError when
// short; nothing is written). The patient's standing discount is copied into the bill with its first line.
export function addLine(db, { visit, entry, qty, userId }) {
  if (visit.status === 'cancelled') throw new BillError('ویزیت لغو شده است؛ به صورتحساب آن چیزی اضافه نمی‌شود.', 409);
  if (!entry || !entry.active) throw new BillError('این مورد در فهرست قیمت‌ها نیست یا غیرفعال است.');
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO bill_lines (visit_id, catalog_id, kind, name, qty, unit_price, created_by)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(visit.id, entry.id, entry.kind, entry.name, qty, entry.sale_price, userId).lastInsertRowid);
    if (entry.kind === 'item') takeStock(db, { itemId: entry.id, qty, lineId: id, userId });
    const first = db.prepare('SELECT COUNT(*) FROM bill_lines WHERE visit_id = ?').pluck().get(visit.id) === 1;
    if (first && !visit.disc_kind) {
      const p = db.prepare('SELECT disc_kind, disc_value FROM patients WHERE id = ?').get(visit.patient_id);
      if (p?.disc_kind && p.disc_value) db.prepare('UPDATE visits SET disc_kind = ?, disc_value = ? WHERE id = ?').run(p.disc_kind, p.disc_value, visit.id);
    }
    return id;
  })();
}

export function deleteLine(db, { line, userId }) {
  db.transaction(() => {
    if (line.kind === 'item') returnStock(db, { lineId: line.id, userId });
    db.prepare('DELETE FROM bill_lines WHERE id = ?').run(line.id);
  })();
}

// ---- Status changes and deletion ------------------------------------------
// Keeps stock in step with a visit's status: cancelling returns every item line's pieces; bringing a cancelled visit
// back takes them again (BillError 409 when they are no longer there). Call inside the status update's transaction.
export function syncStockForStatus(db, { visit, status, userId }) {
  if (visit.status === status) return;
  const items = db.prepare("SELECT * FROM bill_lines WHERE visit_id = ? AND kind = 'item'").all(visit.id);
  if (status === 'cancelled') {
    for (const l of items) returnStock(db, { lineId: l.id, userId });
  } else if (visit.status === 'cancelled') {
    for (const l of items) {
      try {
        takeStock(db, { itemId: l.catalog_id, qty: l.qty, lineId: l.id, userId });
      } catch (err) {
        if (err.available === undefined) throw err;
        throw new BillError(`برای برگرداندن این ویزیت، «${l.name}» به اندازه‌ی کافی در انبار نیست.`, 409);
      }
    }
  }
}

export const PAYMENTS_BLOCK = 'این ویزیت پرداخت ثبت‌شده دارد. ابتدا پرداخت‌ها را بازپرداخت یا به ویزیت دیگری منتقل کنید.';
export const PATIENT_PAYMENTS_BLOCK = 'این بیمار پرداخت ثبت‌شده دارد و سوابق مالی نباید پاک شود. به‌جای حذف، پرونده را بایگانی کنید.';

export const visitHasPayments = (db, visitId) => Boolean(db.prepare('SELECT 1 FROM payments WHERE visit_id = ? LIMIT 1').get(visitId));
export const patientHasPayments = (db, patientId) =>
  Boolean(db.prepare('SELECT 1 FROM payments p JOIN visits v ON v.id = p.visit_id WHERE v.patient_id = ? LIMIT 1').get(patientId));

// Before a visit or a patient is deleted: every item line still holding stock gives it back.
export function releaseStock(db, { visitIds, userId }) {
  const lines = db.prepare(`SELECT id FROM bill_lines WHERE kind = 'item' AND visit_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(visitIds));
  for (const l of lines) returnStock(db, { lineId: l.id, userId });
}

// ---- Payments -------------------------------------------------------------
export function addPayment(db, { visit, amount, paidOn, methodId, accountId, note, userId, kind = 'payment' }) {
  if (kind === 'payment' && visit.status === 'cancelled') throw new BillError('ویزیت لغو شده است؛ فقط بازپرداخت یا انتقال ممکن است.', 409);
  if (paidOn > localDay()) throw new BillError('تاریخ پرداخت نمی‌تواند بعد از امروز باشد.');
  const signed = kind === 'refund' ? -amount : amount;
  return Number(db.prepare(`INSERT INTO payments (visit_id, amount, kind, paid_on, method_id, account_id, note, created_by)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(visit.id, signed, kind, paidOn, methodId, accountId, note || null, userId).lastInsertRowid);
}

// Moves credit from one visit to another visit of the same patient: a move_out and a move_in sharing move_id.
export function moveCredit(db, { from, to, amount, paidOn, userId }) {
  return db.transaction(() => {
    const out = Number(db.prepare(`INSERT INTO payments (visit_id, amount, kind, paid_on, created_by) VALUES (?, ?, 'move_out', ?, ?)`)
      .run(from.id, -amount, paidOn, userId).lastInsertRowid);
    db.prepare('UPDATE payments SET move_id = ? WHERE id = ?').run(out, out);
    db.prepare(`INSERT INTO payments (visit_id, amount, kind, paid_on, move_id, created_by) VALUES (?, ?, 'move_in', ?, ?, ?)`)
      .run(to.id, amount, paidOn, out, userId);
    return out;
  })();
}

// Deletes a payment; a move's two halves go together.
export function deletePayment(db, payment) {
  if (payment.move_id) db.prepare('DELETE FROM payments WHERE move_id = ?').run(payment.move_id);
  else db.prepare('DELETE FROM payments WHERE id = ?').run(payment.id);
}

export const activeMethods = (db) => db.prepare('SELECT * FROM pay_methods WHERE active = 1 ORDER BY id').all();
export const activeAccounts = (db) => db.prepare('SELECT * FROM accounts WHERE active = 1 ORDER BY id').all();
