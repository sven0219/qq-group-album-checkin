const xmlEscape = (value) => String(value ?? "").replace(/[<>&'\"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" }[c]));
const encoder = new TextEncoder();
const crcTable = (() => Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }))();
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function u16(n) { return [n & 255, (n >>> 8) & 255]; }
function u32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
function columnName(n) { let value = ""; for (n += 1; n; n = Math.floor((n - 1) / 26)) value = String.fromCharCode(65 + ((n - 1) % 26)) + value; return value; }
function sheetXml({ rows, weekly, kind }) {
  const cellStyle = (r, c) => {
    if (!weekly && kind) {
      if (r === 0) return styleIds.A5;
      const blue = r % 2 === 0;
      if (kind === 'history' && c === 2) return blue ? styleIds.dateOdd : styleIds.dateEven;
      if (kind === 'history' && c === 5) return blue ? styleIds.timeOdd : styleIds.timeEven;
      if (kind === 'audit' && c === 1) return blue ? styleIds.auditOdd : styleIds.auditEven;
      return kind === 'history' && (c === 0 || c === 4) ? (blue ? styleIds.C8 : styleIds.C7) : (blue ? styleIds.B8 : styleIds.B7);
    }
    if (!weekly) return 0;
    if (r === 1) return styleIds.A2;
    if (r === 2) return styleIds.A3;
    if (r === 4 || r === 5) return r === 5 && c >= 2 && c <= 8 ? styleIds.C6 : styleIds.A5;
    if (r < 6) return 0;
    if (c === 9) return styleIds.J7;
    return c === 1 ? (r % 2 ? styleIds.B8 : styleIds.B7) : (r % 2 ? styleIds.C8 : styleIds.C7);
  };
  const height = (row,r) => weekly ? (r === 0 ? 10 : r === 1 ? 30 : r === 3 ? 9 : r === 4 || r === 5 ? 24 : 25) : kind === 'audit' ? Math.max(27,Math.ceil(String(row[1] || '').length/40)*18+8) : 27;
  const body = rows.map((row, r) => `<row r="${r + 1}"${weekly || kind ? ` ht="${height(row,r)}" customHeight="1"` : ""}>${row.map((cell, c) => {
    const ref = `${columnName(c)}${r + 1}`;
    const style = ` s="${cellStyle(r,c)}"`;
    if (cell && typeof cell === "object" && cell.formula) return `<c r="${ref}"${style}${typeof cell.value === "number" ? "" : ' t="str"'}><f>${xmlEscape(cell.formula)}</f><v>${xmlEscape(cell.value)}</v></c>`;
    if (typeof cell === "number") return `<c r="${ref}"${style}><v>${cell}</v></c>`;
    if (cell === "" || cell == null) return `<c r="${ref}"${style}/>`;
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const widths = kind === 'history' ? [8,13,14,17,12,28,17] : [26,90];
const layout = weekly ? '<sheetPr><tabColor rgb="FF2E6EC4"/><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="6" topLeftCell="A7" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="25"/><cols><col min="1" max="1" width="7" customWidth="1"/><col min="2" max="2" width="13" customWidth="1"/><col min="3" max="9" width="10" customWidth="1"/><col min="10" max="10" width="12" customWidth="1"/></cols>' : kind ? `<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((width,i)=>`<col min="${i+1}" max="${i+1}" width="${width}" customWidth="1"/>`).join('')}</cols>` : '';
  const cf = weekly && rows.length > 6 ? conditionals.map(xml => xml.replace('C7:J31', `C7:J${rows.length}`)).join('') : '';
  const print = weekly ? '<printOptions horizontalCentered="1"/><pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' : '';
  const filter = kind === 'history' ? `<autoFilter ref="A1:G${rows.length}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${layout}<sheetData>${body}</sheetData>${filter}${cf}${print}</worksheet>`;
}
function zip(files) {
  const locals = []; const central = []; let offset = 0;
  const entries = Object.entries(files);
  for (const [name, text] of entries) {
    const nameBytes = encoder.encode(name); const bytes = encoder.encode(text); const crc = crc32(bytes);
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(bytes.length), ...u32(bytes.length), ...u16(nameBytes.length), ...u16(0), ...nameBytes, ...bytes]);
    locals.push(local);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(bytes.length), ...u32(bytes.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes]));
    offset += local.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
  const all = [...locals, ...central, end]; const length = all.reduce((sum, part) => sum + part.length, 0); const out = new Uint8Array(length); let index = 0;
  for (const part of all) { out.set(part, index); index += part.length; }
  return out;
}
export function makeWorkbook(sheets) {
  const sheetTags = sheets.map((sheet, i) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  const rels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") + `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  const content = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${content}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets><definedNames>${sheets.map((sheet,i) => sheet.weekly ? `<definedName name="_xlnm.Print_Area" localSheetId="${i}">${xmlEscape("'"+sheet.name.replace(/'/g,"''")+"'!$A$1:$J$"+sheet.rows.length)}</definedName><definedName name="_xlnm.Print_Titles" localSheetId="${i}">${xmlEscape("'"+sheet.name.replace(/'/g,"''")+"'!$5:$6")}</definedName>` : '').join('')}</definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    "xl/styles.xml": stylesXml,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`
  };
  sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sheet); });
  return zip(files);
}
import { stylesXml, styleIds, conditionals } from "./workbook-style.js";
