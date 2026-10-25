// Figures for the Finance tab and the PDF documents (D29-D30). Income is counted on the day money moved (D28):
// payments and refunds by paid_on; moves between visits are not income.
import { billFor } from './bill.js';
import { addDays } from './jalali.js';

const INCOME = "kind IN ('payment', 'refund')";

export function incomeBetween(db, from, to) {
  return db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM payments WHERE ${INCOME} AND paid_on BETWEEN ? AND ?`).get(from, to);
}

// One entry per day from `from` to `to`, zero where nothing was paid.
export function incomeByDay(db, from, to) {
  const rows = new Map(db.prepare(`SELECT paid_on, SUM(amount) AS total FROM payments WHERE ${INCOME} AND paid_on BETWEEN ? AND ? GROUP BY paid_on`)
    .all(from, to).map((r) => [r.paid_on, r.total]));
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ day: d, total: rows.get(d) ?? 0 });
  return out;
}

// What patients still owe and what the clinic holds as credit, over every visit that has a line or a payment.
// ponytail: computes each bill in JS; fine for one clinic's few thousand visits, move to SQL if it gets slow.
export function outstanding(db) {
  const visits = db.prepare(`SELECT * FROM visits WHERE id IN (SELECT visit_id FROM bill_lines UNION SELECT visit_id FROM payments)`).all();
  let remaining = 0;
  let credit = 0;
  for (const v of visits) {
    const b = billFor(db, v);
    remaining += b.remaining;
    credit += b.credit;
  }
  return { remaining, credit };
}

// Billed amounts by source for non-cancelled visits dated in the range: services against items, and per entry.
// Line amounts are after line discounts; bill-wide discounts are shown as their own row.
export function revenueBySource(db, from, to) {
  const visits = db.prepare("SELECT * FROM visits WHERE status <> 'cancelled' AND visit_date BETWEEN ? AND ?").all(from, to);
  const byKind = { service: 0, item: 0 };
  const byName = new Map();
  let billDisc = 0;
  for (const v of visits) {
    const b = billFor(db, v);
    billDisc += b.billDisc;
    for (const l of b.lines) {
      byKind[l.kind] += l.net;
      byName.set(l.name, (byName.get(l.name) ?? 0) + l.net);
    }
  }
  const top = [...byName.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  return { byKind, billDisc, top };
}

// Pieces used per day (use minus returns), by the server's local day.
export function usageByDay(db, from, to) {
  const rows = new Map(db.prepare(`SELECT date(ts, 'localtime') AS day, -ROUND(SUM(qty), 2) AS n FROM stock_moves
                                   WHERE reason IN ('use', 'return') AND date(ts, 'localtime') BETWEEN ? AND ? GROUP BY day`)
    .all(from, to).map((r) => [r.day, r.n]));
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ day: d, total: Math.max(rows.get(d) ?? 0, 0) });
  return out;
}
