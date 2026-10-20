// Admin-only pages: user management and the audit log.
import { Router } from 'express';
import { requireAdmin, hashPassword, checkPasswordPolicy, destroyUserSessions, createSession, setSessionCookie } from '../auth.js';
import { audit } from '../audit.js';
import { normalizeText } from '../lib/normalize.js';
import { isPatientCode } from '../lib/files.js';
import { AUDIT_ACTIONS } from '../lib/labels.js';

const router = Router();
router.use('/admin', requireAdmin);

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const AUDIT_PAGE_SIZE = 50;
const idOf = (s) => (/^\d{1,9}$/.test(String(s)) ? Number(s) : 0);

const listUsers = (db) => db.prepare(`SELECT id, username, display_name, role, active, created_at FROM users
                                      WHERE deleted_at IS NULL ORDER BY active DESC, id`).all();

function renderUsers(req, res, { status = 200, error = null, values = {}, notice = null } = {}) {
  res.status(status).render('admin/users', { active: 'users', users: listUsers(req.app.locals.db), error, values, notice });
}

router.get('/admin/users', (req, res) => renderUsers(req, res));

router.post('/admin/users', (req, res) => {
  const { db } = req.app.locals;
  const username = String(req.body.username ?? '').trim();
  const displayName = normalizeText(req.body.display_name).slice(0, 80);
  const role = req.body.role === 'admin' ? 'admin' : 'staff';
  const password = String(req.body.password ?? '').slice(0, 256);
  const values = { username, display_name: displayName, role };
  const fail = (error) => renderUsers(req, res, { status: 422, error, values });

  if (!USERNAME_RE.test(username)) return fail('نام کاربری باید ۳ تا ۳۲ نویسه‌ی لاتین، عدد یا نقطه، خط تیره و زیرخط باشد.');
  if (!displayName) return fail('نام نمایشی را وارد کنید.');
  const problem = checkPasswordPolicy(password);
  if (problem) return fail(problem);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return fail('این نام کاربری قبلاً ثبت شده است.');

  db.transaction(() => {
    db.prepare('INSERT INTO users (username, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run(username, displayName, role, hashPassword(password));
    audit(db, { userId: req.user.id, action: 'user_create', detail: `${username} (${role})` });
  })();
  renderUsers(req, res, { notice: `کاربر «${username}» ساخته شد.` });
});

function findUser(req) {
  const id = idOf(req.params.id);
  return id ? req.app.locals.db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id) : undefined;
}
const userNotFound = (res) => res.status(404).render('error', { status: 404, message: 'کاربر پیدا نشد.' });

router.post('/admin/users/:id/password', (req, res) => {
  const { db } = req.app.locals;
  const user = findUser(req);
  if (!user) return userNotFound(res);
  const password = String(req.body.password ?? '').slice(0, 256);
  const problem = checkPasswordPolicy(password);
  if (problem) return renderUsers(req, res, { status: 422, error: problem });
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    destroyUserSessions(db, user.id); // whoever knew the old password is signed out
    audit(db, { userId: req.user.id, action: 'user_password_reset', detail: user.username });
  })();
  if (user.id === req.user.id) {
    // Resetting one's own password here: like /account, every other device is signed out but this browser stays in.
    setSessionCookie(res, createSession(db, user.id));
    return renderUsers(req, res, { notice: 'رمز شما عوض شد و از دستگاه‌های دیگر خارج شدید.' });
  }
  renderUsers(req, res, { notice: `رمز «${user.username}» عوض شد و او از همه‌ی دستگاه‌ها خارج شد.` });
});

function setActive(active, action) {
  return (req, res) => {
    const { db } = req.app.locals;
    const user = findUser(req);
    if (!user) return userNotFound(res);
    if (!active && user.id === req.user.id) return renderUsers(req, res, { status: 422, error: 'نمی‌توانید حساب خودتان را غیرفعال کنید.' });
    db.transaction(() => {
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, user.id);
      if (!active) destroyUserSessions(db, user.id);
      audit(db, { userId: req.user.id, action, detail: user.username });
    })();
    res.redirect(303, '/admin/users');
  };
}
router.post('/admin/users/:id/deactivate', setActive(false, 'user_deactivate'));
router.post('/admin/users/:id/activate', setActive(true, 'user_activate'));

// Deleting keeps the row so the audit log and record history still name the person (see migration 005).
// The account can never sign in again, its sessions end now, and the username is freed by renaming it
// to "<name>~<id>", a form the create form can never produce.
router.post('/admin/users/:id/delete', (req, res) => {
  const { db } = req.app.locals;
  const user = findUser(req);
  if (!user) return userNotFound(res);
  if (user.id === req.user.id) return renderUsers(req, res, { status: 422, error: 'نمی‌توانید حساب خودتان را حذف کنید.' });
  db.transaction(() => {
    db.prepare(`UPDATE users SET active = 0, deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), username = ? WHERE id = ?`)
      .run(`${user.username}~${user.id}`, user.id);
    destroyUserSessions(db, user.id);
    audit(db, { userId: req.user.id, action: 'user_delete', detail: user.username });
  })();
  renderUsers(req, res, { notice: `کاربر «${user.username}» حذف شد.` });
});

router.get('/admin/audit', (req, res) => {
  const { db } = req.app.locals;
  const userId = idOf(req.query.user);
  const action = Object.hasOwn(AUDIT_ACTIONS, req.query.action) ? req.query.action : '';
  const code = normalizeText(String(req.query.patient ?? '').slice(0, 20)).toUpperCase();
  const where = [];
  const params = [];
  if (userId) { where.push('a.user_id = ?'); params.push(userId); }
  if (action) { where.push('a.action = ?'); params.push(action); }
  let patientNote = null;
  if (code) {
    const p = isPatientCode(code) ? db.prepare('SELECT id FROM patients WHERE code = ?').get(code) : null;
    // A deleted patient has no row any more, so fall back to the id in the code (ids are never reused).
    const id = p ? p.id : (isPatientCode(code) ? Number(code.slice(2)) : 0);
    if (!id) patientNote = 'کد بیمار را به شکل P-000123 وارد کنید.';
    where.push('a.patient_id = ?'); params.push(id);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${clause}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const page = Math.min(Math.max(1, Number.parseInt(req.query.page, 10) || 1), pages);
  const rows = db.prepare(`SELECT a.id, a.ts, a.action, a.patient_id, a.detail, u.username, u.display_name
                           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${clause}
                           ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, AUDIT_PAGE_SIZE, (page - 1) * AUDIT_PAGE_SIZE);
  const codes = new Map(db.prepare('SELECT id, code FROM patients').all().map((p) => [p.id, p.code]));
  res.render('admin/audit', {
    active: 'audit', rows: rows.map((r) => ({ ...r, code: r.patient_id ? codes.get(r.patient_id) ?? `P-${String(r.patient_id).padStart(6, '0')}` : null })),
    // Deleted users stay selectable here: their history is exactly what the audit log keeps.
    users: db.prepare('SELECT id, username, display_name FROM users ORDER BY deleted_at IS NOT NULL, id').all(),
    total, page, pages, pageSize: AUDIT_PAGE_SIZE, actions: AUDIT_ACTIONS,
    filters: { user: userId || '', action, patient: code }, patientNote,
  });
});

export default router;
