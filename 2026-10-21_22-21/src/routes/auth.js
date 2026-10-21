import { Router } from 'express';
import {
  attemptLoginAsync, createSession, destroySession, readSessionCookie,
  setSessionCookie, clearSessionCookie, safeNext,
} from '../auth.js';
import { audit } from '../audit.js';

const router = Router();

const MESSAGES = {
  invalid: 'نام کاربری یا رمز عبور نادرست است.',
  locked: 'به دلیل تلاش‌های ناموفق زیاد، ورود به مدت ۱۵ دقیقه مسدود شد.',
  busy: 'سامانه در حال حاضر شلوغ است. چند ثانیه بعد دوباره تلاش کنید.',
};

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { error: null, username: '', next: safeNext(req.query.next) });
});

router.post('/login', async (req, res) => {
  const db = req.app.locals.db;
  const username = String(req.body.username ?? '').trim().slice(0, 64);
  const password = String(req.body.password ?? '').slice(0, 256);
  const next = safeNext(req.body.next);
  const result = await attemptLoginAsync(db, { username, password, ip: req.ip });

  if (result.error === 'busy') { // turned away before any check: not a guess, not audited
    res.set('Retry-After', '5');
    return res.status(503).render('login', { error: MESSAGES.busy, username, next });
  }
  if (result.error) {
    // Only a name that exists is recorded: people often type their password into the username box.
    const known = db.prepare('SELECT username FROM users WHERE username = ?').pluck().get(username);
    const action = result.error === 'locked' ? 'login_locked' : 'login_failed';
    const detail = known ?? '(unknown user)';
    // A locked address can keep knocking without limit, so a lock is written once per name per window.
    const repeat = action === 'login_locked' && db.prepare(
      "SELECT 1 FROM audit_log WHERE action = 'login_locked' AND detail = ? AND ts >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-15 minutes')",
    ).get(detail);
    if (!repeat) audit(db, { action, detail });
    return res.status(result.error === 'locked' ? 429 : 401)
      .render('login', { error: MESSAGES[result.error], username, next });
  }
  destroySession(db, readSessionCookie(req)); // a fresh token on every sign-in; the old one stops working
  setSessionCookie(res, createSession(db, result.user.id));
  audit(db, { userId: result.user.id, action: 'login' });
  res.redirect(303, next);
});

router.post('/logout', (req, res) => {
  const db = req.app.locals.db;
  destroySession(db, readSessionCookie(req));
  if (req.user) audit(db, { userId: req.user.id, action: 'logout' });
  clearSessionCookie(res);
  res.redirect(303, '/login');
});

export default router;
