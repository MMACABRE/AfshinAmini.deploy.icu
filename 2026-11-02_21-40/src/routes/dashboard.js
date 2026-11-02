import { Router } from 'express';
import { dayParts, localDay } from '../lib/jalali.js';
import { can, has } from '../lib/perms.js';
import { readLayout } from '../lib/layouts.js';
import { WIDGETS, WIDGET_BY_ID, QUICK_BUTTONS, quickEditTiles } from '../lib/dashboard.js';
import { layoutRoutes } from '../lib/layout-routes.js';

const router = Router();

// A widget that fails to load shows as empty; the rest of the page still renders.
function loadWidget(def, ctx) {
  try {
    return def.load(ctx);
  } catch (err) {
    console.error(`dashboard widget ${def.id} failed: ${err.message}`);
    return null;
  }
}

// The view gets plain data only: no permission or loader functions reach a template.
const plainWidget = ({ id, label, sizes }) => ({ id, label, sizes });
const plainButton = ({ id, title, icon, href }) => ({ id, title, icon, href });

// First paint of the live clock card (app.js enhanceClock keeps it ticking from the browser clock).
export function clockNow(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    h: p(now.getHours()), m: p(now.getMinutes()), s: p(now.getSeconds()),
    jalali: ((d) => `${d.weekday} ${d.day} ${d.month} ${d.year}`)(dayParts(localDay(now))),
    greg: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now).replace(',', ''),
  };
}

// The dashboard page. Normal mode shows the widgets the user may see and whose data is not empty. Edit mode (the
// layout flag and ?edit=1) lists every widget of the layout; a widget the user may not see is locked (no data read).
function renderDashboard(req, res, { status = 200, error = null, forceEdit = false } = {}) {
  const { db, dataDir } = req.app.locals;
  const user = req.user;
  const layout = readLayout(db, 'dashboard');
  const editing = (forceEdit || req.query.edit === '1') && has(user, 'layout');
  const counts = can(user, 'patients')
    ? Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM patients GROUP BY status').all().map((r) => [r.status, r.n]))
    : {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const ctx = { db, dataDir, user, counts, total, quick: layout.quick };

  const widgets = layout.widgets.map((w) => {
    const def = WIDGET_BY_ID.get(w.id);
    const allowed = def.needs(user);
    let data = allowed ? loadWidget(def, ctx) : null;
    if (editing && w.id === 'quick') data = { tiles: quickEditTiles(user, layout.quick, ctx) };
    if (editing) return { id: w.id, size: w.size, visible: true, locked: !allowed, data: allowed ? data : null };
    return { id: w.id, size: w.size, visible: allowed && data !== null, locked: false, data: allowed ? data : null };
  }).filter((w) => editing || w.visible);

  const inLayout = new Set(layout.widgets.map((w) => w.id));
  res.status(status).render('home', {
    active: 'dashboard', editing, error, widgets, layout,
    removed: WIDGETS.filter((w) => !inLayout.has(w.id)).map(plainWidget),
    quickRemoved: QUICK_BUTTONS.filter((b) => !layout.quick.includes(b.id)).map(plainButton),
    catalogue: { widgets: WIDGETS.map(plainWidget), quick: QUICK_BUTTONS.map(plainButton) },
    hasPrevious: Boolean(db.prepare("SELECT previous FROM layouts WHERE name = 'dashboard'").get()?.previous),
    flash: req.query, clock: clockNow(), total, counts,
  });
}

router.get('/', (req, res) => renderDashboard(req, res));

layoutRoutes(router, 'dashboard', {
  path: '/dashboard/layout',
  back: (query) => `/?edit=1&${query}`,
  fail: (req, res, error) => renderDashboard(req, res, { status: 422, error, forceEdit: true }),
});

export default router;
