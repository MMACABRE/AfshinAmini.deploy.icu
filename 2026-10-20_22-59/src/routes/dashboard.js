import { Router } from 'express';
import { todaysVisits } from './visits.js';
import { dayParts, localDay } from '../lib/jalali.js';

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

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM patients GROUP BY status').all().map((r) => [r.status, r.n]),
  );
  const recent = db.prepare(`SELECT code, first_name, last_name, status, updated_at
                             FROM patients ORDER BY updated_at DESC, id DESC LIMIT 8`).all();
  res.render('home', { active: 'dashboard', counts, recent, visitsToday: todaysVisits(db), clock: clockNow() });
});

export default router;
