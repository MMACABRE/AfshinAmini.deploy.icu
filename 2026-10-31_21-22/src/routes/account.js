// Any signed-in user can change their own password.
import { Router } from 'express';
import {
  verifyPasswordAsync, hashPassword, checkPasswordPolicy, destroyUserSessions, createSession, setSessionCookie,
  passwordGuessLocked, recordPasswordGuess, clearPasswordGuesses,
} from '../auth.js';
import { audit } from '../audit.js';

const router = Router();

const render = (res, { status = 200, error = null, done = false } = {}) =>
  res.status(status).render('account', { active: 'account', error, done });

router.get('/account', (req, res) => render(res));

router.post('/account/password', async (req, res) => {
  const { db } = req.app.locals;
  const current = String(req.body.current ?? '').slice(0, 256);
  const next = String(req.body.password ?? '').slice(0, 256);
  const repeat = String(req.body.repeat ?? '').slice(0, 256);
  if (passwordGuessLocked(db, req.user.id)) {
    return render(res, { status: 429, error: 'به دلیل تلاش‌های ناموفق زیاد، تغییر رمز به مدت ۱۵ دقیقه مسدود شد.' });
  }
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  // Counted before the (slow, asynchronous) check and erased only when right, so parallel guesses all count.
  recordPasswordGuess(db, req.user.id);
  if (!(await verifyPasswordAsync(current, row.password_hash))) {
    return render(res, { status: 422, error: 'رمز فعلی نادرست است.' });
  }
  clearPasswordGuesses(db, req.user.id);
  const problem = checkPasswordPolicy(next);
  if (problem) return render(res, { status: 422, error: problem });
  if (next !== repeat) return render(res, { status: 422, error: 'تکرار رمز جدید با آن یکسان نیست.' });
  if (next === current) return render(res, { status: 422, error: 'رمز جدید باید با رمز فعلی فرق داشته باشد.' });

  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    destroyUserSessions(db, req.user.id); // every other device is signed out
    audit(db, { userId: req.user.id, action: 'password_change' });
  })();
  setSessionCookie(res, createSession(db, req.user.id)); // keep this browser signed in
  render(res, { done: true });
});

export default router;
