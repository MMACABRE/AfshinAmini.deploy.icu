// Full export for an admin: one streamed zip with a database snapshot, patients.csv and one folder per patient.
// Only folder names taken from the database (P-000123) and files found through files.js are added,
// so nothing outside data/patients/<code>/ can end up in the archive.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ZipArchive } from 'archiver';
import { BOM, patientsCsv, toCsv } from './csv.js';
import { toJalaliInput } from './jalali.js';
import { STATUS_LABEL_FA } from './visits.js';
import { listPatientFiles, resolvePatientFile, isPatientCode } from './files.js';

const README = `${BOM}این فایل یک نسخه‌ی کامل از اطلاعات سامانه‌ی پرونده‌ی بیماران است.
این فایل اطلاعات محرمانه‌ی بیماران را دارد. آن را در جای امن نگه دارید و پس از استفاده حذف کنید.

محتویات:
  clinic.db        نسخه‌ی کامل پایگاه داده (SQLite). با برنامه‌ی DB Browser for SQLite باز می‌شود.
  patients.csv     فهرست همه‌ی بیماران. با Excel باز می‌شود.
  patients/        یک پوشه برای هر بیمار، به نام کد او (مثلاً P-000123):
                     info.csv   مشخصات بیمار و داروهای او
                     visits.csv ویزیت‌های ثبت‌شده‌ی بیمار (فقط اگر ویزیتی باشد)
                     بقیه‌ی فایل‌ها: اسناد و پیوست‌های بیمار، همان‌طور که روی سرور هستند.

برای بازگردانی روی یک سرور تازه، راهنمای docs/SETUP.md را ببینید.
`;

function medicationsText(db, patientId) {
  return db.prepare('SELECT name, dosage, frequency, since FROM medications WHERE patient_id = ? ORDER BY id').all(patientId)
    .map((m) => [m.name, m.dosage, m.frequency, m.since].filter(Boolean).join(' / ')).join(' ؛ ');
}

// Streams the zip into `res`. Resolves when the response is finished.
export async function streamFullExport(db, dataDir, res, stamp) {
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const snapshot = path.join(tmpDir, `backup-${crypto.randomUUID()}.db`);
  const cleanup = () => fs.rmSync(snapshot, { force: true });
  try {
    await db.backup(snapshot);
  } catch (err) {
    cleanup();
    throw err;
  }

  const archive = new ZipArchive({ zlib: { level: 6 } });
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="clinic-export-${stamp}.zip"`,
    'Cache-Control': 'private, no-store',
  });
  await new Promise((resolve, reject) => {
    res.on('close', () => { cleanup(); resolve(); });
    archive.on('error', (err) => { cleanup(); res.destroy(err); reject(err); });
    archive.pipe(res);

    archive.append(README, { name: 'README.txt' });
    archive.file(snapshot, { name: 'clinic.db' });
    const patients = db.prepare('SELECT * FROM patients ORDER BY id').all();
    archive.append(patientsCsv(patients), { name: 'patients.csv' });
    for (const p of patients) {
      if (!isPatientCode(p.code)) continue;
      const base = `patients/${p.code}`;
      archive.append(patientsCsvWithMeds(db, p), { name: `${base}/info.csv` });
      const visits = visitsCsv(db, p.id);
      if (visits) archive.append(visits, { name: `${base}/visits.csv` });
      // A file copied into the folder by hand may carry the name of a generated one (info.csv, or VISITS.CSV,
      // which is the same name once unzipped on Windows). Two entries with one name lose a file on extraction,
      // so such a file gets a "_" in front until its name is free.
      const used = new Set(visits ? ['info.csv', 'visits.csv'] : ['info.csv']);
      for (const f of listPatientFiles(dataDir, p.code)) {
        const full = resolvePatientFile(dataDir, p.code, f.filename);
        if (!full) continue;
        let name = f.filename;
        while (used.has(name.toLowerCase())) name = `_${name}`;
        used.add(name.toLowerCase());
        archive.file(full, { name: `${base}/${name}` });
      }
    }
    archive.finalize().catch(reject);
  });
}

function patientsCsvWithMeds(db, p) {
  return patientsCsv([{ ...p, medications: medicationsText(db, p.id) }], [['medications', 'داروها']]);
}

// One row per visit, newest first; null when the patient has none (no empty file in the zip).
function visitsCsv(db, patientId) {
  const rows = db.prepare('SELECT visit_date, visit_time, duration_min, status, reason, notes FROM visits WHERE patient_id = ? ORDER BY visit_date DESC, visit_time DESC').all(patientId);
  if (!rows.length) return null;
  return toCsv(['تاریخ', 'ساعت', 'مدت (دقیقه)', 'وضعیت', 'شرح', 'یادداشت'],
    rows.map((v) => [toJalaliInput(v.visit_date), v.visit_time, v.duration_min, STATUS_LABEL_FA[v.status] ?? v.status, v.reason ?? '', v.notes ?? '']));
}
