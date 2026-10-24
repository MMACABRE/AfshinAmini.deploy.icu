// Patient folders on disk: <dataDir>/patients/P-000123/<files>.
// The folder is the source of truth for which files exist (the user may add or delete files by hand
// on the server). Every path built from user input MUST go through this module.
import fs from 'node:fs';
import path from 'node:path';
import { toAsciiDigits } from './normalize.js';

const CODE_RE = /^P-\d{6}$/;
const MAX_NAME = 120;

export function isPatientCode(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}

export function patientCode(n) {
  return `P-${String(n).padStart(6, '0')}`;
}

// A code typed into a CSV cell: "P-000301", "p-301" and "301" (Persian digits too) all mean P-000301.
// -> the code, null for an empty cell (the code is then given automatically), undefined if malformed.
export function parseCodeCell(raw) {
  const s = toAsciiDigits(String(raw ?? '')).trim();
  if (!s) return null;
  const m = /^(?:P-?)?(\d{1,6})$/i.exec(s);
  return m ? patientCode(m[1]) : undefined;
}

// True when data/patients/<code>/ exists. Such a code is never given to a new patient: the folder may hold
// files of a deleted patient whose folder could not be moved to the trash, or files copied in by hand.
export function patientDirExists(dataDir, code) {
  return fs.existsSync(patientDir(dataDir, code));
}

export function patientDir(dataDir, code) {
  if (!isPatientCode(code)) throw new Error('invalid patient code');
  return path.join(dataDir, 'patients', code);
}

export function ensurePatientDir(dataDir, code) {
  const dir = patientDir(dataDir, code);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Turns any uploaded filename into a safe one: no directories, no leading dots,
// only letters (any script), digits, space, dot, dash, underscore.
export function safeName(original) {
  let name = String(original ?? '').normalize('NFC');
  name = name.split(/[\\/]/).pop();                       // drop any directory part
  name = name.replace(/[^\p{L}\p{M}\p{N}\u200c ._-]/gu, '_');  // \p{M}: Persian diacritics; \u200c (ZWNJ) keeps Persian words readable
  name = name.replace(/\s+/g, ' ').replace(/_+/g, '_').replace(/^[ .\u200c]+/, '').replace(/\u200c+(?=\.|$)/, '').trim();
  if (name.length > MAX_NAME) {
    const ext = path.extname(name).slice(0, 10);
    name = name.slice(0, MAX_NAME - ext.length) + ext;
  }
  return name || 'file';
}

// Adds -2, -3 ... before the extension until the name is free in `dir`.
export function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${base}-${i}${ext}`;
  return candidate;
}

// Resolves a filename requested by a client to a real path inside the patient folder, or returns null.
// The name must be exactly one existing entry of the folder (as listPatientFiles() shows it): no separators,
// not hidden, a regular file. Files copied in by hand keep any name the server allows, such as "scan (1).pdf".
export function resolvePatientFile(dataDir, code, requested) {
  if (!isPatientCode(code) || typeof requested !== 'string') return null;
  if (!requested || requested.length > 255 || requested.startsWith('.') || /[/\\\0]/.test(requested)) return null;
  const dir = path.resolve(patientDir(dataDir, code));
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const entry = entries.find((e) => e.name === requested);
  if (!entry || !entry.isFile()) return null;   // also refuses symlinks, which could point outside the folder
  const full = path.join(dir, entry.name);
  return path.dirname(full) === dir ? full : null;
}

// data/tmp holds uploads and export snapshots only while a request runs. A crash or power loss can leave one
// behind, and it holds patient data, so files older than `maxAgeMs` are removed. Returns how many were removed.
export function sweepTmp(dataDir, maxAgeMs = 24 * 3600 * 1000, now = Date.now()) {
  const dir = path.join(dataDir, 'tmp');
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = fs.lstatSync(full);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) { fs.rmSync(full, { force: true }); removed += 1; }
    } catch { /* gone already, or in use */ }
  }
  return removed;
}

// Lists regular files in the patient folder (hidden files skipped), newest first.
export function listPatientFiles(dataDir, code) {
  const dir = patientDir(dataDir, code);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => {
      const st = fs.statSync(path.join(dir, e.name));
      return { filename: e.name, size: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}
