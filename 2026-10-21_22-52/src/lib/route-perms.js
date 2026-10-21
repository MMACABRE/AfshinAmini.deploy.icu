// Which permission each signed-in route needs (D25). One table, checked in order, first match wins, so the whole
// access policy can be read in one place. test/permissions.test.js walks every registered route and fails when a
// route matches no rule, so a new route cannot go live without a decision here.
import { VIEW, EDIT, can, has } from './perms.js';
import { forbidden } from '../auth.js';

const P = (area, level = VIEW) => (u) => can(u, area, level);
const F = (flag) => (u) => has(u, flag);
const OPEN = () => true; // any signed-in user; the page itself hides what the user may not see
const both = (...checks) => (u) => checks.every((c) => c(u));

const seg = '[^/]+';
const re = (s) => new RegExp(`^${s}$`);

// [method ('GET', 'POST' or '*'), path pattern, check]
export const RULES = [
  ['GET', re('/'), OPEN],
  ['*', re('/account(?:/password)?'), OPEN],

  // Patients. Every /patients/* page also needs patients view (added in gate below).
  ['*', re(`/patients/${seg}/delete`), F('patient_delete')],
  ['GET', re('/patients/new'), P('patients', EDIT)],
  ['GET', re(`/patients/${seg}/history`), P('finance')],
  ['POST', re(`/patients/${seg}/discount`), P('finance', EDIT)],
  ['GET', re(`/patients/${seg}/(?:documents|photo|files/${seg})`), P('documents')],
  ['POST', re(`/patients/${seg}/files/${seg}/delete`), F('document_delete')],
  ['POST', re(`/patients/${seg}/(?:documents|documents/classify|photo|photo/remove)`), P('documents', EDIT)],
  ['POST', re(`/patients/${seg}/visits`), P('visits', EDIT)],
  ['GET', re(`/patients/${seg}/edit`), P('patients', EDIT)],
  ['GET', re(`/patients(?:/${seg})?`), OPEN],
  ['POST', re(`/patients(?:/${seg}(?:/archive|/unarchive|/medications|/medications/${seg}/delete)?)?`), P('patients', EDIT)],

  // Visits, their bills and payments. Visit pages also need patients view (added in gate below).
  ['POST', re(`/visits/${seg}/lines/${seg}/price`), F('price_override')],
  ['POST', re(`/visits/${seg}/(?:lines(?:/${seg}(?:/delete|/discount))?|discount|payments(?:/${seg}(?:/delete|/edit))?|refund|move)`), P('finance', EDIT)],
  ['GET', re(`/visits/${seg}/payments/${seg}/edit`), P('finance', EDIT)],
  ['GET', re(`/visits/(?:new|${seg}/edit)`), P('visits', EDIT)],
  ['GET', re(`/visits(?:/${seg})?`), P('visits')],
  ['POST', re(`/visits/${seg}(?:/status|/delete|/note)?`), P('visits', EDIT)],

  // Search lists patients.
  ['GET', re(`/search(?:/export\\.(?:csv|xlsx)|/saved/${seg})?`), P('patients')],
  ['POST', re(`/search/saved(?:/${seg}/delete)?`), P('patients')],

  // Data.
  ['POST', re('/data/import(?:/confirm|/cancel)?'), F('csv_import')],
  ['POST', re('/data/export/full\\.zip'), F('full_zip')],
  ['GET', re('/data(?:/template\\.csv)?'), P('data')],
  ['POST', re('/data/export/patients\\.(?:csv|xlsx)'), P('data')],

  // Users and the audit log.
  ['GET', re('/admin/audit'), F('audit_log')],
  ['GET', re('/admin/users'), P('users')],
  ['*', re(`/admin/users(?:/${seg}(?:/password|/activate|/deactivate|/delete|/permissions))?`), F('manage_users')],

  // Storage.
  ['POST', re(`/storage/lots/${seg}/(?:count|waste)`), F('stock_adjust')],
  ['*', re('/storage/items(?:/new)?'), F('finance_settings')], // a new item is a catalog entry with a sale price
  ['GET', re('/storage(?:/items/new)?'), P('storage')],
  ['GET', re(`/storage/items/${seg}`), P('storage')],
  ['POST', re(`/storage/items/${seg}/in`), P('storage', EDIT)],

  // Finance.
  ['*', re(`/finance/settings(?:/${seg}){0,3}`), F('finance_settings')],
  // These two list patients by name, so they also need patients view.
  ['GET', re('/finance/pay'), both(P('finance', EDIT), P('patients'))],
  ['GET', re('/finance/payments'), both(P('finance'), P('patients'))],
  ['GET', re('/finance'), P('finance')],

  // PDF documents: each document also checks the areas it shows (src/routes/print.js).
  ['GET', re(`/print(?:/${seg}){0,3}`), P('pdf')],
];

const needsPatients = /^\/(?:patients|visits)(?:\/|$)/;

export function findRule(method, path) {
  return RULES.find(([m, pattern]) => (m === '*' || m === method) && pattern.test(path));
}

// Express matches routes case-insensitively and ignores a trailing slash, so /ADMIN/users/ reaches the
// /admin/users handler. The gate must see the path the same way or such spellings would skip it: lower case,
// percent-decoded, repeated slashes collapsed, trailing slashes dropped. Normalizing more than Express does is safe
// (a spelling Express would not route only gets checked, never let through). Each segment is decoded on its own:
// Express keeps an encoded slash (%2F) inside one parameter, so it must not split a segment here either, or
// /patients/P-000001/files/a%2Fb would match no rule and skip the gate.
export function normalizePath(p) {
  let s = String(p).split('/').map((seg) => {
    try { return decodeURIComponent(seg).replace(/\//g, '%2f'); } catch { return seg; } // bad encoding: check the raw text
  }).join('/');
  s = s.toLowerCase().replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  return s || '/';
}

// Runs after requireUser. Unknown paths pass through to the 404 page.
export function permissionGate(req, res, next) {
  const path = normalizePath(req.path);
  const rule = findRule(req.method === 'HEAD' ? 'GET' : req.method, path);
  if (!rule) return next();
  const ok = rule[2](req.user) && (!needsPatients.test(path) || can(req.user, 'patients'));
  return ok ? next() : forbidden(res);
}
