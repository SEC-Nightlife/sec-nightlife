import ExcelJS from 'exceljs';
import { formatEventDateLabel, formatZarLabel, groupPurchaseLogRows, moneyZar, totalsByGuest } from './eventPurchaseLog.js';

const FILL_DARK = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C1C1C' } };
const FILL_GOLD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC9A227' } };
const FONT_WHITE = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
const FONT_DARK = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF111111' } };
const MONEY_FORMAT = '"R"#,##0.00';
const LAST_COL = 'J';

const TABLE_COLUMNS = [
  { name: 'Guest name', width: 22 },
  { name: 'Email', width: 30 },
  { name: 'Type', width: 14 },
  { name: 'What they paid for', width: 44 },
  { name: 'Amount (ZAR)', width: 16, money: true },
  { name: 'Guest total (ZAR)', width: 18, money: true },
  { name: 'Paid at', width: 18 },
  { name: 'Table', width: 28 },
  { name: 'Status', width: 12 },
  { name: 'Payment reference', width: 26 },
];

function purchaseValues(row) {
  return [
    row['Guest name'] || '',
    row.Email || '',
    row.Type || '',
    row['What they paid for'] || '',
    moneyZar(row['Amount (ZAR)']),
    moneyZar(row['Guest total (ZAR)'] ?? row['Amount (ZAR)']),
    row['Paid at'] || '',
    row.Table || '',
    row.Status || '',
    row['Payment reference'] || '',
  ];
}

function styleTitle(cell, text, size = 18) {
  cell.value = text;
  cell.font = { name: 'Calibri', size, bold: true, color: { argb: 'FF111111' } };
  cell.alignment = { vertical: 'middle' };
}

function applyColumnWidths(ws) {
  TABLE_COLUMNS.forEach((col, idx) => {
    ws.getColumn(idx + 1).width = col.width;
  });
}

function addPurchasesTable(ws, tableName, rows, startRow = 4) {
  applyColumnWidths(ws);
  if (!rows.length) {
    ws.getCell(`A${startRow}`).value = 'No purchases recorded for this event.';
    ws.getCell(`A${startRow}`).font = { name: 'Calibri', size: 11, italic: true, color: { argb: 'FF777777' } };
    return startRow;
  }
  ws.addTable({
    name: tableName,
    ref: `A${startRow}`,
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: TABLE_COLUMNS.map((col) => ({
      name: col.name,
      filterButton: true,
    })),
    rows: rows.map(purchaseValues),
  });
  const firstData = startRow + 1;
  const lastData = startRow + rows.length;
  for (let r = firstData; r <= lastData; r += 1) {
    ws.getCell(r, 5).numFmt = MONEY_FORMAT;
    ws.getCell(r, 6).numFmt = MONEY_FORMAT;
  }
  const totalRow = lastData + 1;
  const lineTotal = rows.reduce((sum, row) => sum + moneyZar(row['Amount (ZAR)']), 0);
  ws.getCell(totalRow, 1).value = 'Grand total';
  ws.getCell(totalRow, 1).font = FONT_DARK;
  ws.getCell(totalRow, 5).value = lineTotal;
  ws.getCell(totalRow, 5).numFmt = MONEY_FORMAT;
  ws.getCell(totalRow, 5).font = FONT_DARK;
  for (let c = 1; c <= TABLE_COLUMNS.length; c += 1) {
    ws.getCell(totalRow, c).fill = FILL_GOLD;
  }
  return totalRow;
}

function safeSheetName(name) {
  return String(name || 'Sheet')
    .replace(/[:\\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet';
}

export async function rowsToXlsxBuffer({
  eventTitle,
  eventDate,
  rows = [],
  groups: groupsIn = null,
  guestTotals: guestTotalsIn = null,
  totalZar = null,
} = {}) {
  const title = eventTitle || 'Event';
  const dateLabel = formatEventDateLabel(eventDate);
  const groups = groupsIn || groupPurchaseLogRows(rows);
  const guestTotals = guestTotalsIn || totalsByGuest(rows);
  const total = totalZar == null ? rows.reduce((sum, row) => sum + moneyZar(row['Amount (ZAR)']), 0) : moneyZar(totalZar);
  const count = rows.length;
  const summary = [dateLabel, `${count} ${count === 1 ? 'purchase' : 'purchases'}`, `Grand total R${formatZarLabel(total)}`]
    .filter(Boolean)
    .join('   ·   ');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'SEC Nightlife';
  wb.created = new Date();

  const summaryWs = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  summaryWs.getColumn(1).width = 28;
  summaryWs.getColumn(2).width = 32;
  summaryWs.getColumn(3).width = 14;
  summaryWs.getColumn(4).width = 18;
  summaryWs.mergeCells('A1:D1');
  styleTitle(summaryWs.getCell('A1'), 'Event purchase log', 20);
  summaryWs.getRow(1).height = 28;
  summaryWs.mergeCells('A2:D2');
  styleTitle(summaryWs.getCell('A2'), title, 14);
  summaryWs.mergeCells('A3:D3');
  summaryWs.getCell('A3').value = summary || 'SEC Nightlife';
  summaryWs.getCell('A3').font = { name: 'Calibri', size: 11, color: { argb: 'FF555555' } };

  summaryWs.getCell('A5').value = 'Category';
  summaryWs.getCell('B5').value = 'Purchases';
  summaryWs.getCell('C5').value = 'Amount';
  ['A5', 'B5', 'C5'].forEach((addr) => {
    summaryWs.getCell(addr).fill = FILL_DARK;
    summaryWs.getCell(addr).font = FONT_WHITE;
  });

  let r = 6;
  for (const group of groups) {
    summaryWs.getCell(`A${r}`).value = group.title;
    summaryWs.getCell(`B${r}`).value = group.count;
    summaryWs.getCell(`C${r}`).value = moneyZar(group.subtotal);
    summaryWs.getCell(`C${r}`).numFmt = MONEY_FORMAT;
    r += 1;
  }
  summaryWs.getCell(`A${r}`).value = 'Grand total';
  summaryWs.getCell(`B${r}`).value = count;
  summaryWs.getCell(`C${r}`).value = total;
  summaryWs.getCell(`C${r}`).numFmt = MONEY_FORMAT;
  ['A', 'B', 'C'].forEach((col) => {
    summaryWs.getCell(`${col}${r}`).fill = FILL_GOLD;
    summaryWs.getCell(`${col}${r}`).font = FONT_DARK;
  });

  r += 3;
  summaryWs.getCell(`A${r}`).value = 'Amount paid by each guest';
  summaryWs.getCell(`A${r}`).font = FONT_DARK;
  r += 1;
  ['Guest name', 'Email', 'Purchases', 'Total paid (ZAR)'].forEach((label, idx) => {
    const cell = summaryWs.getCell(r, idx + 1);
    cell.value = label;
    cell.fill = FILL_DARK;
    cell.font = FONT_WHITE;
  });
  r += 1;
  for (const guest of guestTotals) {
    summaryWs.getCell(`A${r}`).value = guest.guestName || '';
    summaryWs.getCell(`B${r}`).value = guest.email || '';
    summaryWs.getCell(`C${r}`).value = guest.count;
    summaryWs.getCell(`D${r}`).value = moneyZar(guest.totalZar);
    summaryWs.getCell(`D${r}`).numFmt = MONEY_FORMAT;
    r += 1;
  }
  summaryWs.getCell(`A${r}`).value = 'Grand total';
  summaryWs.getCell(`C${r}`).value = count;
  summaryWs.getCell(`D${r}`).value = total;
  summaryWs.getCell(`D${r}`).numFmt = MONEY_FORMAT;
  ['A', 'B', 'C', 'D'].forEach((col) => {
    summaryWs.getCell(`${col}${r}`).fill = FILL_GOLD;
    summaryWs.getCell(`${col}${r}`).font = FONT_DARK;
  });

  const allWs = wb.addWorksheet('All purchases', {
    views: [{ state: 'frozen', ySplit: 3 }],
  });
  allWs.mergeCells(`A1:${LAST_COL}1`);
  styleTitle(allWs.getCell('A1'), `Purchase log — ${title}`);
  allWs.getRow(1).height = 26;
  allWs.mergeCells(`A2:${LAST_COL}2`);
  allWs.getCell('A2').value = summary;
  allWs.getCell('A2').font = { name: 'Calibri', size: 11, color: { argb: 'FF555555' } };
  addPurchasesTable(allWs, 'AllPurchases', rows, 4);

  const usedNames = new Set(['summary', 'all purchases', 'allpurchases']);
  for (const group of groups) {
    let sheetName = safeSheetName(group.title);
    let n = 2;
    while (usedNames.has(sheetName.toLowerCase())) {
      sheetName = safeSheetName(`${group.title} ${n}`);
      n += 1;
    }
    usedNames.add(sheetName.toLowerCase());
    const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.mergeCells(`A1:${LAST_COL}1`);
    styleTitle(ws.getCell('A1'), group.title);
    ws.mergeCells(`A2:${LAST_COL}2`);
    ws.getCell('A2').value =
      `${group.count} ${group.count === 1 ? 'purchase' : 'purchases'}   ·   Subtotal R${formatZarLabel(group.subtotal)}`;
    ws.getCell('A2').font = { name: 'Calibri', size: 11, color: { argb: 'FF555555' } };
    addPurchasesTable(ws, `G${group.type.replace(/\s+/g, '')}${n}`, group.rows, 4);
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
