// «حذف داده‌ها» (owner request 2026-10-25): wipes whole kinds of data at once. Only users with «مدیریت کاربران»
// reach it (src/lib/route-perms.js); the route asks for the word «حذف» and the user's own password and takes a
// separate database backup first (backupBeforeWipe in src/lib/backup.js).
//
// What each kind removes. Users, permissions, settings, accounts, payment methods, the service price list, saved
// searches and the audit log are never touched.
//   patients  every patient with their visits, medications, documents, SMS log and so all financial history;
//             it includes documents and finance, because those hang off the patients' visits
//   documents every document row and profile photo; the patient folders move to data/trash/
//   finance   every payment, refund and credit move, every bill line and visit discount; visits stay
//   storage   every lot and stock history row, and the stock items that no bill line uses (bills need the rest)
// Stock counts change only when storage itself is wiped: items used in deleted bills are not put back on the shelf.
import fs from 'node:fs';
import path from 'node:path';
import { audit } from '../audit.js';

export const WIPE_KINDS = ['patients', 'documents', 'finance', 'storage'];

// How many rows each kind would remove now, for the confirmation page.
export function wipeCounts(db) {
  const n = (sql) => db.prepare(sql).pluck().get();
  return {
    patients: { patients: n('SELECT COUNT(*) FROM patients'), visits: n('SELECT COUNT(*) FROM visits') },
    documents: { documents: n('SELECT COUNT(*) FROM documents'), photos: n('SELECT COUNT(*) FROM patients WHERE photo IS NOT NULL') },
    finance: { payments: n('SELECT COUNT(*) FROM payments'), lines: n('SELECT COUNT(*) FROM bill_lines') },
    storage: { lots: n('SELECT COUNT(*) FROM lots'), moves: n('SELECT COUNT(*) FROM stock_moves'), items: n("SELECT COUNT(*) FROM catalog WHERE kind = 'item'") },
  };
}

// The kinds that really run: wiping patients also wipes what hangs off them.
export function effectiveKinds(kinds) {
  const k = new Set(kinds.filter((x) => WIPE_KINDS.includes(x)));
  if (k.has('patients')) { k.add('documents'); k.add('finance'); }
  return WIPE_KINDS.filter((x) => k.has(x));
}

// Moves the whole data/patients/ folder to data/trash/wipe-<time>/ and leaves an empty one behind (one rename on
// the same disk). Returns the trash folder name, or null when there was nothing to move.
function trashPatientFolders(dataDir, now) {
  const src = path.join(dataDir, 'patients');
  if (!fs.existsSync(src) || !fs.readdirSync(src).length) return null;
  const name = `wipe-${now.toISOString().replace(/[:.]/g, '-')}`;
  fs.mkdirSync(path.join(dataDir, 'trash'), { recursive: true });
  fs.renameSync(src, path.join(dataDir, 'trash', name));
  fs.mkdirSync(src, { recursive: true });
  return name;
}

// Runs the wipe. All rows go in one transaction; the files move after it commits, so a failed transaction leaves
// every file in place. Returns { kinds, removed (counts from just before), trashed, fileError }.
export function wipeData(db, dataDir, kinds, { userId = null, now = new Date() } = {}) {
  const k = effectiveKinds(kinds);
  const before = wipeCounts(db);
  db.transaction(() => {
    const run = (sql) => db.prepare(sql).run();
    if (k.includes('finance')) {
      run('DELETE FROM payments'); // payments have no ON DELETE, so they go before any visit
      run('DELETE FROM bill_lines');
      run('UPDATE visits SET disc_kind = NULL, disc_value = 0');
    }
    if (k.includes('patients')) {
      // One delete entry per patient, as a single delete writes: the audit page finds a removed patient's history
      // by code through these entries.
      for (const p of db.prepare('SELECT id, code FROM patients').all()) audit(db, { userId, action: 'patient_delete', patientId: p.id, detail: p.code });
      run('DELETE FROM patients'); // visits, medications, documents and SMS rows follow by ON DELETE CASCADE
    } else if (k.includes('documents')) {
      run('DELETE FROM documents');
      run('UPDATE patients SET photo = NULL');
    }
    if (k.includes('storage')) {
      run('DELETE FROM stock_moves');
      run('DELETE FROM lots');
      run("DELETE FROM catalog WHERE kind = 'item' AND id NOT IN (SELECT catalog_id FROM bill_lines)");
    }
  })();
  let trashed = null;
  let fileError = null;
  if (k.includes('documents')) {
    try {
      trashed = trashPatientFolders(dataDir, now);
    } catch (err) {
      fileError = err.code ?? err.message;
    }
  }
  const removed = Object.fromEntries(k.map((x) => [x, before[x]]));
  return { kinds: k, removed, trashed, fileError };
}
