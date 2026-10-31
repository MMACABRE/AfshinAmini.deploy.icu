import { Router } from 'express';
import { todaysVisits } from './visits.js';
import { dayParts, localDay } from '../lib/jalali.js';
import { can } from '../lib/perms.js';
import { alerts } from '../lib/stock.js';
import { getSettings } from '../lib/settings.js';
import { incomeBetween } from '../lib/finance.js';
import { keyInfo } from '../lib/sms-credentials.js';

const router = Router();

// First paint of the live clock card (app.js enhanceClock keeps it ticking from the browser clock).
export function clockNow(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    h: p(now.getHours()), m: p(now.getMinutes()), s: p(now.getSeconds()),
    jalali: ((d) => `${d.weekday} ${d.day} ${d.month} ${d.year}`)(dayParts(localDay(now))),
    greg: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now).replace(',', ''),
  };
}

// What needs a person's eye in SMS: no readable key, credit at or under the threshold, failures in the last day. Null when all is well.
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

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM patients GROUP BY status').all().map((r) => [r.status, r.n]),
  );
  const recent = db.prepare(`SELECT code, first_name, last_name, status, updated_at
                             FROM patients ORDER BY updated_at DESC, id DESC LIMIT 8`).all();
  res.render('home', {
    active: 'dashboard', counts, recent, visitsToday: todaysVisits(db), clock: clockNow(),
    stockAlerts: can(req.user, 'storage') ? alerts(db, getSettings(db)) : [],
    sms: can(req.user, 'sms') && can(req.user, 'patients') ? smsAttention(db, req.app.locals.dataDir) : null,
    incomeToday: can(req.user, 'finance') ? incomeBetween(db, localDay(), localDay()) : null,
  });
});

export default router;
