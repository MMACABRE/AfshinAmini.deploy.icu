// Minimal Excel (.xlsx) writer for patient exports. A CSV cannot say "right to left", so Excel always opens
// it left to right; an .xlsx sheet can (sheetView rightToLeft="1"). Every cell is written as an inline
// string, so nothing is ever evaluated as a formula and leading zeros (phone, national ID) are kept.
// The file is a zip of a few fixed XML parts; archiver (already used for the full export) builds it.
import { ZipArchive } from 'archiver';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Characters XML 1.0 forbids are dropped; the rest is escaped.
function xml(value) {
  return String(value ?? '')
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function column(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function rowXml(cells, r, style) {
  const cs = cells.map((v, i) => {
    const text = xml(v);
    if (text === '') return '';
    return `<c r="${column(i)}${r}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${text}</t></is></c>`;
  }).join('');
  return `<row r="${r}">${cs}</row>`;
}

function sheetXml(headers, rows) {
  const body = [rowXml(headers, 1, 1), ...rows.map((row, i) => rowXml(row, i + 2, 0))].join('');
  return `${HEAD}<worksheet xmlns="${NS}"><sheetViews><sheetView rightToLeft="1" workbookViewId="0">`
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols><col min="1" max="${Math.max(headers.length, 1)}" width="20" customWidth="1"/></cols>`
    + `<sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = `${HEAD}<styleSheet xmlns="${NS}">`
  + '<fonts count="2"><font><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="11"/><name val="Tahoma"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

// headers: string[]; rows: (string|number|null)[][]. Resolves to the .xlsx file as a Buffer.
export function toXlsx(headers, rows, sheetName = 'Sheet1') {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
  });
  const sheet = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  archive.append(`${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + `<Override PartName="/xl/workbook.xml" ContentType="${sheet}.sheet.main+xml"/>`
    + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${sheet}.worksheet+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="${sheet}.styles+xml"/></Types>`, { name: '[Content_Types].xml' });
  archive.append(`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`, { name: '_rels/.rels' });
  archive.append(`${HEAD}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>`
    + `<sheet name="${xml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`, { name: 'xl/workbook.xml' });
  archive.append(`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`
    + `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`, { name: 'xl/_rels/workbook.xml.rels' });
  archive.append(sheetXml(headers, rows), { name: 'xl/worksheets/sheet1.xml' });
  archive.append(STYLES, { name: 'xl/styles.xml' });
  archive.finalize();
  return done;
}
