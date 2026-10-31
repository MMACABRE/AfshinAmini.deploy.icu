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
import { billFor } from './bill.js';

const README = `${BOM}این فایل یک نسخه‌ی کامل از اطلاعات سامانه‌ی پرونده‌ی بیماران است.
این فایل اطلاعات محرمانه‌ی بیماران را دارد. آن را در جای امن نگه دارید و پس از استفاده حذف کنید.

محتویات:
  clinic.db        نسخه‌ی کامل پایگاه داده (SQLite). با برنامه‌ی DB Browser for SQLite باز می‌شود.
  patients.csv     فهرست همه‌ی بیماران. با Excel باز می‌شود.
  patients/        یک پوشه برای هر بیمار، به نام کد او (مثلاً P-000123):
                     info.csv   مشخصات بیمار و داروهای او
                     visits.csv ویزیت‌های ثبت‌شده‌ی بیمار (فقط اگر ویزیتی باشد)
                     bills.csv  ردیف‌ها و پرداخت‌های صورتحساب ویزیت‌ها (با دسترسی امور مالی)
  finance/         payments.csv همه‌ی پرداخت‌ها (با دسترسی امور مالی)
  storage/         lots.csv و moves.csv بسته‌ها و گردش انبار (با دسترسی انبار)
                     بقیه‌ی فایل‌ها: اسناد و پیوست‌های بیمار، همان‌طور که روی سرور هستند.

برای بازگردانی روی یک سرور تازه، راهنمای docs/SETUP.md را ببینید.
`;

function medicationsText(db, patientId) {
  return db.prepare('SELECT name, dosage, frequency, since FROM medications WHERE patient_id = ? ORDER BY id').all(patientId)
    .map((m) => [m.name, m.dosage, m.frequency, m.since].filter(Boolean).join(' / ')).join(' ؛ ');
}

// Streams the zip into `res`. Resolves when the response is finished. `finance` and `storage` (the downloading user's
// view rights) add the readable finance and storage files (D30); clinic.db always holds everything, which is why the
// full zip itself is a separate flag.
export async function streamFullExport(db, dataDir, res, stamp, { finance = false, storage = false } = {}) {
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
    if (finance) archive.append(paymentsCsv(db), { name: 'finance/payments.csv' });
    if (storage) {
      archive.append(lotsCsv(db), { name: 'storage/lots.csv' });
      archive.append(movesCsv(db), { name: 'storage/moves.csv' });
    }
    for (const p of patients) {
      if (!isPatientCode(p.code)) continue;
      const base = `patients/${p.code}`;
      archive.append(patientsCsvWithMeds(db, p), { name: `${base}/info.csv` });
      const visits = visitsCsv(db, p.id);
      if (visits) archive.append(visits, { name: `${base}/visits.csv` });
      const bills = finance ? billsCsv(db, p.id) : null;
      if (bills) archive.append(bills, { name: `${base}/bills.csv` });
      // A file copied into the folder by hand may carry the name of a generated one (info.csv, or VISITS.CSV,
      // which is the same name once unzipped on Windows). Two entries with one name lose a file on extraction,
      // so such a file gets a "_" in front until its name is free.
      const used = new Set(['info.csv', ...(visits ? ['visits.csv'] : []), ...(bills ? ['bills.csv'] : [])]);
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

// ---- Finance and storage files (D30). Amounts are plain Rial integers so the data never depends on the display switch.
const PAY_KIND_FA = { payment: 'پرداخت', refund: 'بازپرداخت', move_out: 'انتقال (خروج)', move_in: 'انتقال (ورود)' };

// One row per bill line and per payment of every visit of one patient; null when there is nothing.
function billsCsv(db, patientId) {
  const out = [];
  for (const v of db.prepare('SELECT * FROM visits WHERE patient_id = ? ORDER BY visit_date, visit_time').all(patientId)) {
    const b = billFor(db, v);
    const day = toJalaliInput(v.visit_date);
    for (const l of b.lines) out.push([day, 'ردیف', l.name, l.qty, l.override_price ?? l.unit_price, l.disc, l.net, '', '']);
    if (b.billDisc) out.push([day, 'تخفیف کل', '', '', '', b.billDisc, -b.billDisc, '', '']);
    for (const p of b.payments) out.push([day, PAY_KIND_FA[p.kind], '', '', '', '', p.amount, toJalaliInput(p.paid_on), [p.method, p.account].filter(Boolean).join(' / ')]);
  }
  if (!out.length) return null;
  return toCsv(['تاریخ ویزیت', 'نوع', 'شرح', 'تعداد', 'قیمت واحد (ریال)', 'تخفیف (ریال)', 'مبلغ (ریال)', 'تاریخ پرداخت', 'روش / حساب'], out);
}

function paymentsCsv(db) {
  const rows = db.prepare(`SELECT p.*, m.name AS method, a.name AS account, v.visit_date, pt.code FROM payments p
                           JOIN visits v ON v.id = p.visit_id JOIN patients pt ON pt.id = v.patient_id
                           LEFT JOIN pay_methods m ON m.id = p.method_id LEFT JOIN accounts a ON a.id = p.account_id ORDER BY p.paid_on, p.id`).all();
  return toCsv(['تاریخ پرداخت', 'کد بیمار', 'تاریخ ویزیت', 'نوع', 'مبلغ (ریال)', 'روش', 'حساب', 'یادداشت'],
    rows.map((p) => [toJalaliInput(p.paid_on), p.code, toJalaliInput(p.visit_date), PAY_KIND_FA[p.kind], p.amount, p.method ?? '', p.account ?? '', p.note ?? '']));
}

function lotsCsv(db) {
  const rows = db.prepare('SELECT l.*, c.name FROM lots l JOIN catalog c ON c.id = l.item_id ORDER BY c.name, l.id').all();
  return toCsv(['کالا', 'تاریخ ورود', 'انقضا', 'ورودی', 'مانده', 'قیمت خرید هر عدد (ریال)'],
    rows.map((l) => [l.name, toJalaliInput(l.received_on), toJalaliInput(l.expires_on), l.qty_in, l.remaining, l.unit_cost ?? '']));
}

const MOVE_FA = { in: 'ورود', use: 'مصرف', return: 'برگشت', count: 'اصلاح شمارش', waste: 'ضایعات' };
function movesCsv(db) {
  const rows = db.prepare('SELECT m.*, c.name FROM stock_moves m JOIN lots l ON l.id = m.lot_id JOIN catalog c ON c.id = l.item_id ORDER BY m.id').all();
  return toCsv(['زمان', 'کالا', 'نوع', 'تعداد', 'یادداشت'], rows.map((m) => [m.ts, m.name, MOVE_FA[m.reason], m.qty, m.note ?? '']));
}
