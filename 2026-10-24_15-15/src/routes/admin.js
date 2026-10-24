// User management, permissions (D25) and the audit log. Access is decided in src/lib/route-perms.js; the owner
// rules (nobody else may reset, restrict, deactivate or delete the owner) are enforced here.
import { Router } from 'express';
import { hashPassword, checkPasswordPolicy, destroyUserSessions, createSession, setSessionCookie } from '../auth.js';
import { audit } from '../audit.js';
import { normalizeText } from '../lib/normalize.js';
import { isPatientCode } from '../lib/files.js';
import { AUDIT_ACTIONS } from '../lib/labels.js';
import { PRESETS, AREAS, AREA_MAX, AREA_LABELS, LEVEL_LABELS, FLAGS, FLAG_LABELS, parsePerms, permsFromForm, describePerms, presetOf, roleLabel } from '../lib/perms.js';

const router = Router();

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const AUDIT_PAGE_SIZE = 50;
const idOf = (s) => (/^\d{1,9}$/.test(String(s)) ? Number(s) : 0);

const listUsers = (db) => db.prepare(`SELECT id, username, display_name, perms, is_owner, active, created_at FROM users
                                      WHERE deleted_at IS NULL ORDER BY is_owner DESC, active DESC, id`).all()
  .map((u) => ({ ...u, label: roleLabel(u.is_owner === 1, parsePerms(u.perms)) }));

function renderUsers(req, res, { status = 200, error = null, values = {}, notice = null } = {}) {
  res.status(status).render('admin/users', { active: 'users', users: listUsers(req.app.locals.db), PRESETS, error, values, notice });
}

router.get('/admin/users', (req, res) => renderUsers(req, res));

router.post('/admin/users', (req, res) => {
  const { db } = req.app.locals;
  const username = String(req.body.username ?? '').trim();
  const displayName = normalizeText(req.body.display_name).slice(0, 80);
  const preset = Object.hasOwn(PRESETS, req.body.preset) ? req.body.preset : 'staff';
  const password = String(req.body.password ?? '').slice(0, 256);
  const values = { username, display_name: displayName, preset };
  const fail = (error) => renderUsers(req, res, { status: 422, error, values });

  if (!USERNAME_RE.test(username)) return fail('نام کاربری باید ۳ تا ۳۲ نویسه‌ی لاتین، عدد یا نقطه، خط تیره و زیرخط باشد.');
  if (!displayName) return fail('نام نمایشی را وارد کنید.');
  const problem = checkPasswordPolicy(password);
  if (problem) return fail(problem);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return fail('این نام کاربری قبلاً ثبت شده است.');

  db.transaction(() => {
    db.prepare('INSERT INTO users (username, display_name, role, password_hash, perms) VALUES (?, ?, ?, ?, ?)')
      .run(username, displayName, preset, hashPassword(password), JSON.stringify(parsePerms(PRESETS[preset].perms)));
    audit(db, { userId: req.user.id, action: 'user_create', detail: `${username} (${preset})` });
  })();
  renderUsers(req, res, { notice: `کاربر «${username}» ساخته شد.` });
});

function findUser(req) {
  const id = idOf(req.params.id);
  return id ? req.app.locals.db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id) : undefined;
}
const userNotFound = (res) => res.status(404).render('error', { status: 404, message: 'کاربر پیدا نشد.' });
// Only the owner may act on the owner's account (the owner changes their own password on /account).
const ownerLocked = (req, res, target) => {
  if (target.is_owner !== 1 || req.user.owner) return false;
  res.status(403).render('error', { status: 403, message: 'حساب مالک سامانه را فقط خود او می‌تواند تغییر دهد.' });
  return true;
};

router.post('/admin/users/:id/password', (req, res) => {
  const { db } = req.app.locals;
  const user = findUser(req);
  if (!user) return userNotFound(res);
  if (ownerLocked(req, res, user)) return;
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
    if (user.is_owner === 1) return renderUsers(req, res, { status: 422, error: 'حساب مالک سامانه غیرفعال نمی‌شود.' });
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
  if (user.is_owner === 1) return renderUsers(req, res, { status: 422, error: 'حساب مالک سامانه حذف نمی‌شود.' });
  if (user.id === req.user.id) return renderUsers(req, res, { status: 422, error: 'نمی‌توانید حساب خودتان را حذف کنید.' });
  db.transaction(() => {
    db.prepare(`UPDATE users SET active = 0, deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), username = ? WHERE id = ?`)
      .run(`${user.username}~${user.id}`, user.id);
    destroyUserSessions(db, user.id);
    audit(db, { userId: req.user.id, action: 'user_delete', detail: user.username });
  })();
  renderUsers(req, res, { notice: `کاربر «${user.username}» حذف شد.` });
});

// Permission editor. The owner's permissions are fixed, and nobody edits their own (no accidental self-lockout,
// no quiet self-promotion); another manager or the owner does it.
function permsTarget(req, res) {
  const user = findUser(req);
  if (!user) { userNotFound(res); return null; }
  if (user.is_owner === 1) { res.status(403).render('error', { status: 403, message: 'مالک سامانه همه‌ی دسترسی‌ها را دارد و دسترسی‌اش تغییر نمی‌کند.' }); return null; }
  if (user.id === req.user.id) { res.status(403).render('error', { status: 403, message: 'دسترسی‌های خودتان را نمی‌توانید تغییر دهید.' }); return null; }
  return user;
}

const renderPerms = (res, target, perms, { status = 200, notice = null } = {}) => res.status(status).render('admin/permissions', {
  active: 'users', target, perms, preset: presetOf(perms), PRESETS, AREAS, AREA_MAX, AREA_LABELS, LEVEL_LABELS, FLAGS, FLAG_LABELS, notice,
});

router.get('/admin/users/:id/permissions', (req, res) => {
  const target = permsTarget(req, res);
  if (target) renderPerms(res, target, parsePerms(target.perms));
});

router.post('/admin/users/:id/permissions', (req, res) => {
  const { db } = req.app.locals;
  const target = permsTarget(req, res);
  if (!target) return;
  // «اعمال» fills the form from a preset without saving, so the owner can fine-tune it first.
  if (req.body.apply !== undefined) {
    const preset = Object.hasOwn(PRESETS, req.body.preset) ? req.body.preset : null;
    return renderPerms(res, target, preset ? parsePerms(PRESETS[preset].perms) : permsFromForm(req.body),
      { notice: preset ? `قالب «${PRESETS[preset].label}» در فرم گذاشته شد؛ برای ثبت، «ذخیره» را بزنید.` : null });
  }
  const perms = permsFromForm(req.body);
  db.transaction(() => {
    db.prepare('UPDATE users SET perms = ? WHERE id = ?').run(JSON.stringify(perms), target.id);
    audit(db, { userId: req.user.id, action: 'user_perms', detail: `${target.username}: ${describePerms(perms)}` });
  })();
  renderPerms(res, { ...target, perms: JSON.stringify(perms) }, perms, { notice: 'دسترسی‌ها ذخیره شد. از درخواست بعدی کاربر اعمال می‌شود.' });
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
    // A code may have belonged to deleted patients too (D31: the newest code is given out again), and their
    // rows are gone, so their ids come from the delete entries, whose detail is the code. A code changed by hand
    // (D36) finds the patient through its change entry, "P-000005 → P-000123", by either side.
    const ids = isPatientCode(code) ? db.prepare(`SELECT id FROM patients WHERE code = ?
                                                  UNION SELECT patient_id FROM audit_log WHERE action = 'patient_delete' AND detail = ?
                                                  UNION SELECT patient_id FROM audit_log WHERE action = 'patient_code'
                                                    AND (substr(detail, 1, 8) = ? OR substr(detail, -8) = ?)`).pluck().all(code, code, code, code) : [];
    if (!isPatientCode(code)) patientNote = 'کد بیمار را به شکل P-000123 وارد کنید.';
    where.push(`a.patient_id IN (${ids.map(() => '?').join(', ') || 'NULL'})`); params.push(...ids);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${clause}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const page = Math.min(Math.max(1, Number.parseInt(req.query.page, 10) || 1), pages);
  const rows = db.prepare(`SELECT a.id, a.ts, a.action, a.patient_id, a.detail, u.username, u.display_name
                           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${clause}
                           ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, AUDIT_PAGE_SIZE, (page - 1) * AUDIT_PAGE_SIZE);
  const codes = new Map([
    ...db.prepare("SELECT patient_id, detail FROM audit_log WHERE action = 'patient_delete'").raw().all(),
    ...db.prepare('SELECT id, code FROM patients').raw().all(),
  ]);
  res.render('admin/audit', {
    active: 'audit', rows: rows.map((r) => ({ ...r, code: r.patient_id ? codes.get(r.patient_id) ?? null : null })),
    // Deleted users stay selectable here: their history is exactly what the audit log keeps.
    users: db.prepare('SELECT id, username, display_name FROM users ORDER BY deleted_at IS NOT NULL, id').all(),
    total, page, pages, pageSize: AUDIT_PAGE_SIZE, actions: AUDIT_ACTIONS,
    filters: { user: userId || '', action, patient: code }, patientNote,
  });
});

export default router;
