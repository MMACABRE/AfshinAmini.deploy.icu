// Storage «انبار» (D26): stock items with their lots, stock-in, count corrections and waste.
// Access is decided in src/lib/route-perms.js; stock logic lives in src/lib/stock.js.
import { Router } from 'express';
import { audit } from '../audit.js';
import { normalizeText } from '../lib/normalize.js';
import { parseJalali, localDay, faDigits } from '../lib/jalali.js';
import { parseMoney } from '../lib/money.js';
import { getSettings } from '../lib/settings.js';
import { parseQty } from '../lib/qty.js';
import { itemsWithStock, stockIn, countLot, wasteLot, deleteMove, StockShortError, StockUndoError, expiryLevel, available } from '../lib/stock.js';

const router = Router();

const idOf = (s) => (/^[1-9]\d{0,15}$/.test(String(s)) ? Number(s) : 0);

const findItem = (db, id) => db.prepare("SELECT * FROM catalog WHERE id = ? AND kind = 'item'").get(idOf(id));
const notFound = (res) => res.status(404).render('error', { status: 404, message: 'کالای مورد نظر پیدا نشد.' });

router.get('/storage', (req, res) => {
  const { db } = req.app.locals;
  const settings = getSettings(db);
  const filter = req.query.f === 'alert' ? 'alert' : 'all';
  const items = itemsWithStock(db, settings);
  res.render('storage/index', {
    active: 'storage', settings, filter,
    items: filter === 'alert' ? items.filter((i) => i.low || i.expiry) : items,
    alertCount: items.filter((i) => i.low || i.expiry).length,
  });
});

// ---- New stock item (a catalog entry) ------------------------------------------
export function readItemForm(body, cur) {
  const values = {
    name: normalizeText(body.name).slice(0, 120),
    sale_price: String(body.sale_price ?? '').slice(0, 30),
    purchase_cost: String(body.purchase_cost ?? '').slice(0, 30),
    low_warn: String(body.low_warn ?? '').slice(0, 10),
    low_crit: String(body.low_crit ?? '').slice(0, 10),
  };
  const errors = {};
  const row = { name: values.name };
  if (!values.name) errors.name = 'نام کالا را وارد کنید.';
  row.sale_price = parseMoney(values.sale_price, cur);
  if (row.sale_price === null) errors.sale_price = 'قیمت فروش را به عدد وارد کنید.';
  row.purchase_cost = values.purchase_cost.trim() ? parseMoney(values.purchase_cost, cur) : null;
  if (values.purchase_cost.trim() && row.purchase_cost === null) errors.purchase_cost = 'قیمت خرید درست نیست.';
  for (const k of ['low_warn', 'low_crit']) {
    row[k] = parseQty(values[k], { allowZero: true });
    if (Number.isNaN(row[k])) errors[k] = 'یک عدد وارد کنید (تا دو رقم اعشار) یا خالی بگذارید.';
  }
  if (!errors.low_warn && !errors.low_crit && row.low_warn !== null && row.low_crit !== null && row.low_crit > row.low_warn) {
    errors.low_crit = 'حد بحرانی نباید از حد هشدار بیشتر باشد.';
  }
  return { values, errors, row };
}

router.get('/storage/items/new', (req, res) => {
  res.render('storage/new', { active: 'storage', values: {}, errors: {} });
});

router.post('/storage/items', (req, res) => {
  const { db } = req.app.locals;
  const { values, errors, row } = readItemForm(req.body, res.locals.cur);
  if (Object.keys(errors).length) return res.status(422).render('storage/new', { active: 'storage', values, errors });
  const id = db.transaction(() => {
    const newId = Number(db.prepare(`INSERT INTO catalog (kind, name, sale_price, purchase_cost, low_warn, low_crit)
                                     VALUES ('item', ?, ?, ?, ?, ?)`).run(row.name, row.sale_price, row.purchase_cost, row.low_warn, row.low_crit).lastInsertRowid);
    audit(db, { userId: req.user.id, action: 'catalog_add', detail: `item=${newId} price=${row.sale_price}` });
    return newId;
  })();
  res.redirect(303, `/storage/items/${id}`);
});

// ---- One item ---------------------------------------------------------------
function renderItem(req, res, item, { status = 200, inValues = {}, inErrors = {}, lotError = null, moveError = null, notice = null } = {}) {
  const { db } = req.app.locals;
  const today = localDay();
  const lots = db.prepare('SELECT * FROM lots WHERE item_id = ? ORDER BY remaining = 0, expires_on IS NULL, expires_on, id').all(item.id)
    .map((l) => ({ ...l, level: expiryLevel(l, today) }));
  const moves = db.prepare(`SELECT m.*, l.expires_on, u.display_name AS who FROM stock_moves m JOIN lots l ON l.id = m.lot_id
                            LEFT JOIN users u ON u.id = m.user_id WHERE l.item_id = ? ORDER BY m.id DESC LIMIT 50`).all(item.id);
  const settings = getSettings(db);
  res.status(status).render('storage/item', {
    active: 'storage', item, lots, moves, usable: available(db, item.id, today), settings,
    inValues, inErrors, lotError, moveError, notice,
  });
}

router.get('/storage/items/:id', (req, res) => {
  const item = findItem(req.app.locals.db, req.params.id);
  if (!item) return notFound(res);
  renderItem(req, res, item, { notice: req.query.done === '1' ? 'ثبت شد.' : null });
});

router.post('/storage/items/:id/in', (req, res) => {
  const { db } = req.app.locals;
  const item = findItem(db, req.params.id);
  if (!item) return notFound(res);
  const inValues = {
    qty: String(req.body.qty ?? '').slice(0, 20),
    expires_on: String(req.body.expires_on ?? '').slice(0, 20),
    unit_cost: String(req.body.unit_cost ?? '').slice(0, 30),
  };
  const inErrors = {};
  const qty = parseQty(inValues.qty);
  if (!qty) inErrors.qty = 'تعداد را به عدد وارد کنید (تا دو رقم اعشار، مثل ۰٫۵).';
  let expiresOn = null;
  if (inValues.expires_on.trim()) {
    expiresOn = parseJalali(inValues.expires_on);
    if (!expiresOn) inErrors.expires_on = 'تاریخ انقضا را به شکل ۱۴۰۵/۰۸/۱۵ وارد کنید.';
  }
  const unitCost = inValues.unit_cost.trim() ? parseMoney(inValues.unit_cost, res.locals.cur) : null;
  if (inValues.unit_cost.trim() && unitCost === null) inErrors.unit_cost = 'قیمت خرید درست نیست.';
  if (Object.keys(inErrors).length) return renderItem(req, res, item, { status: 422, inValues, inErrors });
  db.transaction(() => {
    const lot = stockIn(db, { itemId: item.id, qty, expiresOn, unitCost, userId: req.user.id });
    audit(db, { userId: req.user.id, action: 'stock_in', detail: `item=${item.id} lot=${lot} qty=${qty}` });
  })();
  res.redirect(303, `/storage/items/${item.id}?done=1`);
});

function lotOf(db, id) {
  return db.prepare("SELECT l.*, c.name FROM lots l JOIN catalog c ON c.id = l.item_id WHERE l.id = ? AND c.kind = 'item'").get(idOf(id));
}

router.post('/storage/lots/:id/count', (req, res) => {
  const { db } = req.app.locals;
  const lot = lotOf(db, req.params.id);
  if (!lot) return notFound(res);
  const item = findItem(db, lot.item_id);
  const counted = parseQty(req.body.counted, { allowZero: true });
  const note = normalizeText(req.body.note).slice(0, 200);
  if (counted === null || Number.isNaN(counted)) return renderItem(req, res, item, { status: 422, lotError: { id: lot.id, text: 'تعداد شمارش‌شده را به عدد وارد کنید (تا دو رقم اعشار، مثل ۰٫۵).' } });
  if (!note) return renderItem(req, res, item, { status: 422, lotError: { id: lot.id, text: 'دلیل اصلاح را بنویسید.' } });
  db.transaction(() => {
    const delta = countLot(db, { lotId: lot.id, counted, note, userId: req.user.id });
    audit(db, { userId: req.user.id, action: 'stock_count', detail: `item=${lot.item_id} lot=${lot.id} delta=${delta}` });
  })();
  res.redirect(303, `/storage/items/${lot.item_id}?done=1`);
});

router.post('/storage/lots/:id/waste', (req, res) => {
  const { db } = req.app.locals;
  const lot = lotOf(db, req.params.id);
  if (!lot) return notFound(res);
  const item = findItem(db, lot.item_id);
  const qty = parseQty(req.body.qty);
  const note = normalizeText(req.body.note).slice(0, 200);
  if (!qty) return renderItem(req, res, item, { status: 422, lotError: { id: lot.id, text: 'تعداد ضایعات را به عدد وارد کنید (تا دو رقم اعشار، مثل ۰٫۵).' } });
  if (!note) return renderItem(req, res, item, { status: 422, lotError: { id: lot.id, text: 'دلیل ضایعات را بنویسید.' } });
  try {
    db.transaction(() => {
      wasteLot(db, { lotId: lot.id, qty, note, userId: req.user.id });
      audit(db, { userId: req.user.id, action: 'stock_waste', detail: `item=${lot.item_id} lot=${lot.id} qty=${qty}` });
    })();
  } catch (err) {
    if (!(err instanceof StockShortError)) throw err;
    return renderItem(req, res, item, { status: 409, lotError: { id: lot.id, text: `این بسته فقط ${faDigits(err.available)} عدد دارد.` } });
  }
  res.redirect(303, `/storage/items/${lot.item_id}?done=1`);
});

// Removes one wrong entry from an item's history and undoes its effect (src/lib/stock.js deleteMove).
const UNDO_MESSAGES = {
  bill: 'این ردیف مال صورتحساب یک ویزیت است؛ برای برگرداندنش، ردیف کالا را از همان صورتحساب حذف کنید.',
  later: 'بعد از این ورود، ردیف‌های دیگری برای همین بسته ثبت شده است؛ اول آن‌ها را حذف کنید.',
};
router.post('/storage/moves/:id/delete', (req, res) => {
  const { db } = req.app.locals;
  const move = db.prepare("SELECT m.id, l.item_id FROM stock_moves m JOIN lots l ON l.id = m.lot_id JOIN catalog c ON c.id = l.item_id WHERE m.id = ? AND c.kind = 'item'").get(idOf(req.params.id));
  if (!move) return res.status(404).render('error', { status: 404, message: 'این ردیف پیدا نشد.' });
  const item = findItem(db, move.item_id);
  try {
    db.transaction(() => {
      const gone = deleteMove(db, { moveId: move.id });
      audit(db, { userId: req.user.id, action: 'stock_move_delete', detail: `item=${gone.item_id} lot=${gone.lot_id} move=${gone.id} reason=${gone.reason} qty=${gone.qty}` });
    })();
  } catch (err) {
    if (!(err instanceof StockUndoError)) throw err;
    const text = err.code === 'short'
      ? `با حذف این ردیف موجودی بسته منفی می‌شود؛ این بسته الان ${faDigits(err.available)} عدد دارد.`
      : UNDO_MESSAGES[err.code];
    return renderItem(req, res, item, { status: 409, moveError: { id: move.id, text } });
  }
  res.redirect(303, `/storage/items/${move.item_id}?done=1`);
});

export default router;
