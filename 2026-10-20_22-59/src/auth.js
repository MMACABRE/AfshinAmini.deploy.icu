import crypto from 'node:crypto';
import { promisify } from 'node:util';

// ---- Policy -------------------------------------------------------------
export const MIN_PASSWORD_LENGTH = 10;
export const SESSION_MAX_MS = 8 * 60 * 60 * 1000;   // absolute session lifetime
export const SESSION_IDLE_MS = 30 * 60 * 1000;      // sign out after this much inactivity
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_USER_IP = 5;                    // per username+IP inside the window
const MAX_FAILS_PER_IP = 20;                        // stops one IP spraying many usernames
const MAX_CHECKS_IN_FLIGHT = 16;                    // password checks running at once (see attemptLoginAsync)
let checksInFlight = 0;
const COOKIE = 'sid';

// ---- Passwords (scrypt, stored as scrypt$N$r$p$salt$hash) -----------------
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

// Base64 that decodes and encodes back to the same text. Buffer.from() alone silently drops bad characters.
const strictBase64 = (text) => {
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
};
const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// Reads a stored value. Anything that is not a complete scrypt hash with sane settings gives null and so never
// matches: an empty hash field would otherwise make scrypt return zero bytes, which "equal" the zero bytes expected.
function parseStored(stored) {
  const [kind, N, r, p, salt, hash, extra] = String(stored).split('$');
  if (kind !== 'scrypt' || extra !== undefined || !salt || !hash) return null;
  const [n, rr, pp] = [Number(N), Number(r), Number(p)];
  const saltBytes = strictBase64(salt);
  const expected = strictBase64(hash);
  // N must be a power of two; the bounds keep a damaged row from asking for gigabytes of memory.
  if (!inRange(n, 2 ** 10, 2 ** 17) || (n & (n - 1)) !== 0 || !inRange(rr, 1, 16) || !inRange(pp, 1, 4)) return null;
  if (!saltBytes || saltBytes.length < 8 || !expected || expected.length < 16) return null;
  return { salt: saltBytes, expected, options: { N: n, r: rr, p: pp, maxmem: SCRYPT.maxmem } };
}

// A refused value still pays for one full scrypt (against the dummy hash), so a damaged row answers as slowly as a
// wrong password and does not show that the account exists.
let dummyParsed;
const dummy = () => (dummyParsed ??= parseStored(DUMMY_HASH));

export function verifyPassword(password, stored) {
  const s = parseStored(stored);
  try {
    const use = s ?? dummy();
    const same = crypto.timingSafeEqual(crypto.scryptSync(password, use.salt, use.expected.length, use.options), use.expected);
    return Boolean(s) && same;
  } catch {
    return false; // settings scrypt refuses (too much memory, for example): no match, never an error page
  }
}

const scryptAsync = promisify(crypto.scrypt);

// Same check as verifyPassword, on the libuv thread pool instead of the main thread.
export async function verifyPasswordAsync(password, stored) {
  const s = parseStored(stored);
  try {
    const use = s ?? dummy();
    const same = crypto.timingSafeEqual(await scryptAsync(password, use.salt, use.expected.length, use.options), use.expected);
    return Boolean(s) && same;
  } catch {
    return false;
  }
}

// Used when the username does not exist, so a miss costs the same time as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export function checkPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `رمز عبور باید دست‌کم ${MIN_PASSWORD_LENGTH} نویسه باشد.`;
  }
  return null;
}

// ---- Users --------------------------------------------------------------
export function createUser(db, { username, displayName, role, password }) {
  const problem = checkPasswordPolicy(password);
  if (problem) throw new Error(problem);
  if (!['admin', 'staff'].includes(role)) throw new Error('role must be admin or staff');
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw new Error('username: 3-32 latin letters, digits, . _ -');
  const info = db.prepare('INSERT INTO users (username, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
    .run(username, displayName || username, role, hashPassword(password));
  return Number(info.lastInsertRowid);
}

// ---- Sign-in with lockout -------------------------------------------------
// Returns { user } on success or { error: 'locked' | 'invalid' }.
// The attempt is written down BEFORE the password is checked and erased only when it was right. Checking takes
// time (see verifyPasswordAsync), and requests that arrive while one is being checked must already count, or a
// burst of parallel guesses would all pass the lock test before any of them was recorded.
function startAttempt(db, username, ip, now) {
  const key = `${String(username).toLowerCase()}|${ip}`;
  const since = now - LOCK_WINDOW_MS;
  db.prepare('DELETE FROM login_attempts WHERE ts < ?').run(since);
  const userFails = db.prepare('SELECT count(*) FROM login_attempts WHERE key = ? AND ts >= ?').pluck().get(key, since);
  const ipFails = db.prepare('SELECT count(*) FROM login_attempts WHERE ip = ? AND ts >= ?').pluck().get(ip, since);
  if (userFails >= MAX_FAILS_PER_USER_IP || ipFails >= MAX_FAILS_PER_IP) return { locked: true };
  db.prepare('INSERT INTO login_attempts (key, ip, ts) VALUES (?, ?, ?)').run(key, ip, now);
  return { key, user: db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username)) };
}

function finishAttempt(db, { key, user }, ok) {
  if (!ok) return { error: 'invalid' };
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
  return { user };
}

export function attemptLogin(db, { username, password, ip, now = Date.now() }) {
  const a = startAttempt(db, username, ip, now);
  if (a.locked) return { error: 'locked' };
  const ok = verifyPassword(String(password), a.user ? a.user.password_hash : DUMMY_HASH) && Boolean(a.user);
  return finishAttempt(db, a, ok);
}

// Same as attemptLogin, but the hashing runs on worker threads, so a flood of sign-in attempts cannot freeze
// the whole site (the sync version blocks every other request for the ~80 ms each check takes).
export async function attemptLoginAsync(db, { username, password, ip, now = Date.now() }) {
  // Only a few checks run at once. A flood from many addresses is turned away ('busy', not counted as a guess)
  // instead of filling the thread pool that uploads, exports and downloads also use.
  if (checksInFlight >= MAX_CHECKS_IN_FLIGHT) return { error: 'busy' };
  checksInFlight += 1;
  try {
    const a = startAttempt(db, username, ip, now);
    if (a.locked) return { error: 'locked' };
    const ok = (await verifyPasswordAsync(String(password), a.user ? a.user.password_hash : DUMMY_HASH)) && Boolean(a.user);
    return finishAttempt(db, a, ok);
  } finally {
    checksInFlight -= 1;
  }
}

// ---- Guessing the current password on the account page --------------------------
// A stolen session must not be able to try passwords without limit. Same window and limit as sign-in, counted per
// user (any address) in the same table; `ip` holds the key too, so these rows never count against an address.
const guessKey = (userId) => `pw|${userId}`;

export function passwordGuessLocked(db, userId, now = Date.now()) {
  return db.prepare('SELECT count(*) FROM login_attempts WHERE key = ? AND ts >= ?').pluck()
    .get(guessKey(userId), now - LOCK_WINDOW_MS) >= MAX_FAILS_PER_USER_IP;
}

export function recordPasswordGuess(db, userId, now = Date.now()) {
  db.prepare('INSERT INTO login_attempts (key, ip, ts) VALUES (?, ?, ?)').run(guessKey(userId), guessKey(userId), now);
}

export function clearPasswordGuesses(db, userId) {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(guessKey(userId));
}

// ---- Sessions -----------------------------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(db, userId, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  // Housekeeping: sessions abandoned without signing out would otherwise stay in the table forever.
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?').run(now, now - SESSION_IDLE_MS);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, last_seen) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now + SESSION_MAX_MS, now);
  return token;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Returns the signed-in user or null. Expired and idle sessions are deleted.
export function loadSession(db, token, now = Date.now()) {
  if (!token) return null;
  const h = sha256(token);
  const row = db.prepare(`SELECT s.expires_at, s.last_seen, u.id, u.username, u.display_name, u.role
                          FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ? AND u.active = 1`).get(h);
  if (!row) return null;
  if (now > row.expires_at || now - row.last_seen > SESSION_IDLE_MS) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
    return null;
  }
  if (now - row.last_seen > 60_000) {
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, h);
  }
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

// ---- Cookies ------------------------------------------------------------
export function readSessionCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

export function setSessionCookie(res, token) {
  res.append('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}`);
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

// ---- Middleware ---------------------------------------------------------
export function sessionMiddleware(db) {
  return (req, res, next) => {
    req.user = loadSession(db, readSessionCookie(req));
    res.locals.user = req.user;
    next();
  };
}

export function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  // A form posted after the session ended (for example after 30 minutes idle): explain, offer sign-in.
  return res.status(401).render('error', { status: 401, message: 'نشست شما به پایان رسیده است. لطفاً دوباره وارد شوید.', login: true });
}

export function requireAdmin(req, res, next) {
  if (!req.user) return requireUser(req, res, next);
  if (req.user.role === 'admin') return next();
  return res.status(403).render('error', { status: 403, message: 'دسترسی به این بخش فقط برای مدیر سیستم مجاز است.' });
}

// CSRF defence: state-changing requests must come from this site.
// Browsers always send Origin on POST; a missing or foreign Origin is rejected.
export function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  let host = null;
  try { host = origin ? new URL(origin).host : null; } catch { host = null; }
  if (host && host === req.get('host')) return next();
  return res.status(403).send('Forbidden: cross-origin request');
}

// Only allow redirects to local paths after sign-in.
export function safeNext(next) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/';
}
