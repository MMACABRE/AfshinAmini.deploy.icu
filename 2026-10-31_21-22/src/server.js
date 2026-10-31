import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { sessionMiddleware, sameOriginOnly, requireUser } from './auth.js';
import { permissionGate } from './lib/route-perms.js';
import { can, has, roleLabel } from './lib/perms.js';
import { formatJalali, formatJalaliDateTime, faDigits, localDay, dayParts, toJalaliInput } from './lib/jalali.js';
import { endTime, DURATIONS } from './lib/visits.js';
import * as labels from './lib/labels.js';
import authRoutes from './routes/auth.js';
import contactRoutes from './routes/contact.js';
import dashboardRoutes from './routes/dashboard.js';
import patientRoutes from './routes/patients.js';
import visitRoutes from './routes/visits.js';
import documentRoutes from './routes/documents.js';
import searchRoutes from './routes/search.js';
import dataRoutes from './routes/data.js';
import adminRoutes from './routes/admin.js';
import accountRoutes from './routes/account.js';
import storageRoutes from './routes/storage.js';
import billRoutes from './routes/bill.js';
import financeRoutes from './routes/finance.js';
import printRoutes from './routes/print.js';
import { formatMoney, moneyInput, describeDiscount } from './lib/money.js';
import { getSettings, clinicName } from './lib/settings.js';
import { scheduleNightlyBackup } from './lib/backup.js';
import { createEngine, scheduleSms } from './lib/sms-engine.js';
import { createProvider } from './lib/sms-provider.js';
import smsRoutes from './routes/sms.js';
import { sweepTmp } from './lib/files.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Builds the app. Tests call this with an in-memory db and a temp dataDir.
// `smsFetch` replaces the network call to the SMS provider (tests pass a fake).
export function createApp({ db, dataDir, smsFetch, trustProxy = process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal' }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);          // Caddy sits in front; req.ip comes from X-Forwarded-For
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.locals.db = db;
  app.locals.dataDir = dataDir;
  app.locals.smsProvider = createProvider(smsFetch);
  app.locals.smsEngine = createEngine({ db, dataDir, provider: app.locals.smsProvider });
  const latestReminder = db.prepare("SELECT status, reason, due_at FROM sms_messages WHERE kind = 'reminder' AND visit_id = ? ORDER BY id DESC LIMIT 1");
  app.locals.smsReminder = (visitId) => latestReminder.get(visitId);
  app.locals.formatJalali = formatJalali;
  app.locals.faDigits = faDigits;
  app.locals.localDay = localDay;
  app.locals.dayParts = dayParts;
  app.locals.endTime = endTime;
  app.locals.DURATIONS = DURATIONS;
  app.locals.formatJalaliDateTime = formatJalaliDateTime;
  app.locals.toJalaliInput = toJalaliInput;
  app.locals.formatMoney = formatMoney;
  app.locals.moneyInput = moneyInput;
  app.locals.describeDiscount = describeDiscount;
  app.locals.labels = labels;
  app.locals.assetVersion = Date.now().toString(36); // cache-buster for /css and /js links (views/partials/head.ejs)

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    });
    next();
  });

  app.get('/health', (req, res) => res.type('text').send('ok'));
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h', index: false }));
  // Before the body parser: its errors (413) render error.ejs, which needs these.
  app.use((req, res, next) => {
    res.locals.active = '';
    // Light/dark choice from the theme button; empty means "follow the system".
    res.locals.theme = /(?:^|;\s*)theme=(light|dark)(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    res.locals.here = req.originalUrl;
    res.locals.siteName = clinicName(db); // «نام کلینیک» setting, shown as the website's name on every page
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: '200kb', parameterLimit: 200 }));
  // Express 5 leaves req.body undefined when a POST has no form body; routes may always read req.body.x.
  // (multer replaces it with its own object on multipart requests.)
  app.use((req, res, next) => { req.body ??= {}; next(); });
  app.use(sessionMiddleware(db));
  app.use((req, res, next) => {
    // Permission helpers for every view (D25); also on /contact, which signed-in users see inside the app shell.
    res.locals.can = (area, level) => can(req.user, area, level);
    res.locals.has = (flag) => has(req.user, flag);
    res.locals.roleLabel = req.user ? roleLabel(req.user.owner, req.user.perms) : '';
    next();
  });
  app.use(sameOriginOnly);

  // Theme button (works signed out too). Only a same-site path is accepted as the return address.
  app.post('/theme', (req, res) => {
    const body = req.body ?? {};
    const theme = ['light', 'dark'].includes(body.theme) ? body.theme : null;
    if (theme) res.cookie('theme', theme, { maxAge: 365 * 24 * 3600 * 1000, httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    const back = String(body.back ?? '');
    res.redirect(303, /^\/(?![/\\])[^\r\n]*$/.test(back) ? back : '/');
  });

  app.use(authRoutes);
  app.use(contactRoutes); // open to visitors and signed-in users

  // Everything below requires a signed-in user.
  app.use(requireUser);
  app.use((req, res, next) => {
    // Pages behind sign-in hold patient data: the browser must not keep them, or pressing Back after
    // signing out on a shared clinic computer would show the last patient again. Routes may set their own.
    res.set('Cache-Control', 'private, no-store');
    const settings = getSettings(db);
    res.locals.cur = settings.currency; // display currency for money(), see src/lib/money.js
    res.locals.smsOn = settings.sms_enabled === '1';
    res.locals.smsDefaultLead = settings.sms_lead;
    res.locals.patientCount = db.prepare("SELECT COUNT(*) AS n FROM patients WHERE status <> 'archived'").get().n;
    next();
  });
  app.use(permissionGate);
  app.use(dashboardRoutes);
  app.use(patientRoutes);
  app.use(visitRoutes);
  app.use(billRoutes);
  app.use(documentRoutes);
  app.use(searchRoutes);
  app.use(dataRoutes);
  app.use(adminRoutes);
  app.use(accountRoutes);
  app.use(storageRoutes);
  app.use(financeRoutes);
  app.use(printRoutes);
  app.use(smsRoutes);

  app.use((req, res) => res.status(404).render('error', { status: 404, message: 'صفحه‌ی مورد نظر پیدا نشد.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Client errors raised by Express itself (bad percent-encoding in the URL, oversized or malformed body).
    const status = Number(err.status ?? err.statusCode);
    if (status >= 400 && status < 500) {
      const message = status === 413 ? 'حجم اطلاعات ارسالی بیش از حد مجاز است.' : 'درخواست نامعتبر است.';
      return res.status(status).render('error', { status, message });
    }
    console.error(err);
    res.status(500).render('error', { status: 500, message: 'خطایی در سرور رخ داد. لطفاً دوباره تلاش کنید.' });
  });
  return app;
}

// Started directly: node src/server.js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
  const db = openDb(path.join(dataDir, 'clinic.db'));
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  // Express 5 passes a bind error (port in use, or reserved as on some Windows machines) to this callback.
  const app = createApp({ db, dataDir });
  const server = app.listen(port, host, (err) => {
    if (err) {
      console.error(`could not listen on ${host}:${port}: ${err.code}. Set another port, for example PORT=8080.`);
      process.exit(1);
    }
    console.log(`clinic app listening on http://${host}:${port} (data: ${dataDir})`);
  });
  const stopBackups = scheduleNightlyBackup(db, dataDir);
  const stopSms = scheduleSms(app.locals.smsEngine);
  sweepTmp(dataDir);
  setInterval(() => sweepTmp(dataDir), 6 * 3600 * 1000).unref();
  const stop = () => { stopBackups(); stopSms(); server.close(() => { db.close(); process.exit(0); }); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
