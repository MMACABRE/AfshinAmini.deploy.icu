import { faDigits, localDay } from './jalali.js';
import { can, has, EDIT } from './perms.js';
import { alerts } from './stock.js';
import { getSettings } from './settings.js';
import { incomeBetween } from './finance.js';
import { keyInfo } from './sms-credentials.js';
import { todaysVisits } from './visits.js';
import { Reject, isObj, BAD_SHAPE } from './layout-catalogue.js';

// Dashboard catalogue (D54): the widgets, the quick buttons, the default layout, the no-JS fields and the reader.
// `needs(user)` is the permission a widget needs; `load(ctx)` reads its data and returns null when there is nothing
// to show. The route calls `load` only for widgets whose `needs` passes.
// ctx: { db, dataDir, user, counts, total, quick } (counts is set only for users who may see patients).

const fa = (n) => faDigits(Number(n).toLocaleString('en-US').replace(/,/g, '٬'));

// What needs a person's eye in SMS: no readable key, credit at or under the threshold, failures in the last day.
// Null when all is well.
function smsAttention(db, dataDir) {
  const s = getSettings(db);
  if (s.sms_enabled !== '1') return null;
  const out = { noKey: !keyInfo(db, dataDir)?.usable, low: null, failed: 0 };
  const left = s.sms_balance === '' ? null : Math.floor(Number(s.sms_balance));
  if (left !== null && left <= (Number.parseInt(s.sms_low_threshold, 10) || 10)) out.low = left;
  out.failed = db.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE status = 'failed' AND created_at >= ?")
    .get(new Date(Date.now() - 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')).n;
  return out.noKey || out.low !== null || out.failed ? out : null;
}

const stat = (status) => (ctx) => ({ n: ctx.counts[status] || 0, total: ctx.total });
const seesPatients = (u) => can(u, 'patients');

// The widgets, in today's page order (the default layout).
export const WIDGETS = [
  { id: 'quick', label: 'دسترسی سریع', sizes: ['4x2', '4x1', '2x2'], needs: () => true, load: (ctx) => ({ tiles: quickFor(ctx.user, ctx.quick, ctx) }) },
  { id: 'active', label: 'بیماران فعال', sizes: ['1x1', '2x1'], defaultSize: '2x1', needs: seesPatients, load: stat('active') },
  { id: 'pending', label: 'در انتظار', sizes: ['1x1', '2x1'], needs: seesPatients, load: stat('pending') },
  { id: 'critical', label: 'بحرانی', sizes: ['1x1', '2x1'], needs: seesPatients, load: stat('critical') },
  { id: 'income_today', label: 'درآمد امروز', sizes: ['2x1', '1x1'], needs: (u) => can(u, 'finance'), load: (ctx) => incomeBetween(ctx.db, localDay(), localDay()) },
  { id: 'sms', label: 'پیامک', sizes: ['2x1', '2x2'], needs: (u) => can(u, 'sms') && can(u, 'patients'), load: (ctx) => smsAttention(ctx.db, ctx.dataDir) },
  { id: 'alerts', label: 'هشدارها', sizes: ['2x2', '2x1'], needs: (u) => can(u, 'storage'), load: (ctx) => { const a = alerts(ctx.db, getSettings(ctx.db)); return a.length ? a : null; } },
  { id: 'today_visits', label: 'ویزیت‌های امروز', sizes: ['2x2', '4x2', '2x3'], needs: (u) => can(u, 'patients') && can(u, 'visits'), load: (ctx) => todaysVisits(ctx.db) },
  { id: 'recent', label: 'آخرین پرونده‌های به‌روزشده', sizes: ['4x2', '2x2'], needs: seesPatients, load: (ctx) => ctx.db.prepare(`SELECT code, first_name, last_name, status, updated_at
    FROM patients ORDER BY updated_at DESC, id DESC LIMIT 8`).all() },
];

// The quick buttons, in today's order (views/home.ejs). `text(ctx)` may read the patient counts.
export const QUICK_BUTTONS = [
  { id: 'new_patient', href: '/patients/new', icon: 'plus', title: 'ثبت بیمار جدید', text: () => 'پرونده‌ی تازه با کد خودکار بسازید', needs: (u) => can(u, 'patients', EDIT) },
  { id: 'pay', href: '/finance/pay', icon: 'wallet', title: 'ثبت پرداخت', text: () => 'بیمار و ویزیت را انتخاب کنید', needs: (u) => can(u, 'finance', EDIT) && can(u, 'patients') },
  { id: 'patients', href: '/patients', icon: 'users', title: 'فهرست بیماران', text: (ctx) => fa(ctx.total - (ctx.counts.archived || 0)) + ' پرونده', needs: seesPatients },
  { id: 'search', href: '/search', icon: 'search', title: 'جستجوی پیشرفته', text: () => 'جستجو با چند شرط و خروجی اکسل', needs: seesPatients },
  { id: 'upload', href: '/patients', icon: 'upload', title: 'بارگذاری مدرک', text: () => 'بیمار را انتخاب کنید و فایل را رها کنید', needs: (u) => can(u, 'documents', EDIT) && can(u, 'patients') },
  { id: 'storage', href: '/storage', icon: 'box', title: 'انبار', text: () => 'موجودی، ورود کالا و تاریخ انقضا', needs: (u) => can(u, 'storage') },
  { id: 'finance', href: '/finance', icon: 'wallet', title: 'امور مالی', text: () => 'درآمد، پرداخت‌ها و نمودارها', needs: (u) => can(u, 'finance') },
  { id: 'data', href: '/data', icon: 'swap', title: 'ورود و خروج داده', text: () => 'ورود از CSV و دریافت فایل کامل', needs: (u) => can(u, 'data') },
  { id: 'users', href: '/admin/users', icon: 'users', title: 'مدیریت کاربران', text: () => 'حساب‌ها و دسترسی‌های کارکنان', needs: (u) => can(u, 'users') },
  { id: 'audit', href: '/admin/audit', icon: 'shield', title: 'گزارش فعالیت', text: () => 'چه کسی، چه زمانی، چه کاری کرد', needs: (u) => has(u, 'audit_log') },
  { id: 'account', href: '/account', icon: 'shield', title: 'حساب کاربری', text: () => 'تغییر رمز عبور', needs: () => true },
];

export const QUICK = QUICK_BUTTONS.map((b) => b.id);
export const WIDGET_BY_ID = new Map(WIDGETS.map((w) => [w.id, w]));
const BUTTON_BY_ID = new Map(QUICK_BUTTONS.map((b) => [b.id, b]));

const tileOf = (b, ctx) => ({ id: b.id, href: b.href, icon: b.icon, title: b.title, text: b.text(ctx) });

// The quick tiles the user may open, in the layout's order; the first one is the large primary tile.
export function quickFor(user, quickIds, ctx) {
  const tiles = quickIds.map((id) => BUTTON_BY_ID.get(id)).filter((b) => b.needs(user)).map((b) => tileOf(b, ctx));
  return tiles.map((t, i) => ({ ...t, primary: i === 0 }));
}

// Every quick button of the layout, for the edit mode: the ones the user may not open are marked locked.
export function quickEditTiles(user, quickIds, ctx) {
  return quickIds.map((id) => BUTTON_BY_ID.get(id)).map((b) => ({ ...tileOf(b, ctx), locked: !b.needs(user) }));
}

export function defaultDashboardLayout() {
  return {
    v: 1,
    widgets: WIDGETS.map((w) => ({ id: w.id, size: w.defaultSize ?? w.sizes[0] })),
    quick: [...QUICK],
  };
}

// Builds the dashboard layout from the no-JS editor's fields and returns it as JSON text for checkLayout. A widget is
// kept with `show_<id>` = '1'; its size is `size_<id>` when allowed. Widgets and quick buttons sort by `order_<id>` /
// `qorder_<id>` (ties: list order). Nothing is filtered by the user's permissions: the form shows every widget.
export function dashboardFromFields(body) {
  const num = (v, fallback) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));
  const sorted = (list) => list.sort((a, b) => a.order - b.order || a.index - b.index);
  const widgets = sorted(WIDGETS.map((w, index) => ({ w, index, order: num(body[`order_${w.id}`], 1e9 + index) }))
    .filter(({ w }) => body[`show_${w.id}`] === '1'))
    .map(({ w }) => ({ id: w.id, size: w.sizes.includes(body[`size_${w.id}`]) ? body[`size_${w.id}`] : w.sizes[0] }));
  const quick = sorted(QUICK.map((id, index) => ({ id, index, order: num(body[`qorder_${id}`], 1e9 + index) }))
    .filter((q) => body[`qshow_${q.id}`] === '1')).map((q) => q.id);
  return JSON.stringify({ v: 1, widgets, quick });
}

// True when a dashboard form carries its order fields (the no-JS marker alone is not enough).
export const dashboardFieldsOk = (body) => Object.keys(body).some((k) => k.startsWith('order_'));

export function cleanDashboard(input, strict) {
  const reject = (msg) => { if (strict) throw new Reject(msg); };
  if (!isObj(input) || input.v !== 1 || !Array.isArray(input.widgets) || !Array.isArray(input.quick)) {
    reject(BAD_SHAPE);
    return null;
  }
  const widgets = [];
  const seen = new Set();
  for (const w of input.widgets) {
    const def = isObj(w) && typeof w.id === 'string' ? WIDGET_BY_ID.get(w.id) : undefined;
    if (!def) { reject('ویجت ناشناخته است.'); continue; }
    if (seen.has(def.id)) { reject('ویجت تکراری است.'); continue; }
    let size = w.size;
    if (!def.sizes.includes(size)) {
      reject('اندازه‌ی ویجت مجاز نیست.');
      size = def.sizes[0];
    }
    seen.add(def.id);
    widgets.push({ id: def.id, size });
  }
  const quick = [];
  for (const id of input.quick) {
    if (!QUICK.includes(id)) { reject('دکمه‌ی دسترسی سریع ناشناخته است.'); continue; }
    if (quick.includes(id)) { reject('دکمه‌ی دسترسی سریع تکراری است.'); continue; }
    quick.push(id);
  }
  return { v: 1, widgets, quick };
}
