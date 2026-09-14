import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import {
  classifyPurchaseType,
  describePurchase,
  formatMenuSummary,
  groupPurchaseLogRows,
  purchaseLogFilename,
  totalsByGuest,
  withGuestTotals,
} from './eventPurchaseLog.js';
import { rowsToXlsxBuffer } from './eventPurchaseLogWorkbook.js';

describe('event purchase log filename', () => {
  it('uses an xlsx workbook name', () => {
    assert.equal(
      purchaseLogFilename({ title: 'Friends of Friends #DenimOnWhite', date: '2026-04-12' }),
      'purchase-log-friends-of-friends-denimonwhite-2026-04-12.xlsx',
    );
  });
});

describe('event purchase log grouping', () => {
  it('groups tickets guests and menu orders with subtotals', () => {
    const groups = groupPurchaseLogRows([
      { Type: 'Table guest', 'Amount (ZAR)': 2400 },
      { Type: 'Ticket', 'Amount (ZAR)': 150 },
      { Type: 'Table guest', 'Amount (ZAR)': 100 },
      { Type: 'Table menu', 'Amount (ZAR)': 70 },
    ]);
    assert.equal(groups[0].title, 'Tickets');
    assert.equal(groups[1].title, 'Table guests');
    assert.equal(groups[1].count, 2);
    assert.equal(groups[1].subtotal, 2500);
    assert.equal(groups[2].title, 'Menu orders');
  });
});

describe('event purchase log guest totals', () => {
  const galaRows = [
    {
      'Guest name': 'Uhle Simelane',
      Email: 'onyxwebsystems@gmail.com',
      Type: 'Entrance',
      'Amount (ZAR)': 10,
    },
    {
      'Guest name': 'Nathi',
      Email: 'sihle.soa@gmail.com',
      Type: 'Entrance',
      'Amount (ZAR)': 10,
    },
    {
      'Guest name': 'Nathi',
      Email: 'sihle.soa@gmail.com',
      Type: 'Entrance',
      'Amount (ZAR)': 10,
    },
  ];

  it('combines every purchase a guest made', () => {
    const guests = totalsByGuest(galaRows);
    assert.equal(guests.length, 2);
    const nathi = guests.find((g) => g.guestName === 'Nathi');
    const uhle = guests.find((g) => g.guestName === 'Uhle Simelane');
    assert.equal(nathi.count, 2);
    assert.equal(nathi.totalZar, 20);
    assert.equal(uhle.count, 1);
    assert.equal(uhle.totalZar, 10);
  });

  it('puts the combined guest amount on each purchase row', () => {
    const rows = withGuestTotals(galaRows);
    assert.equal(rows[0]['Guest total (ZAR)'], 10);
    assert.equal(rows[1]['Guest total (ZAR)'], 20);
    assert.equal(rows[2]['Guest total (ZAR)'], 20);
  });
});

describe('event purchase log Excel workbook', () => {
  it('fills the grand total and each guest’s combined spend', async () => {
    const rows = withGuestTotals([
      {
        'Guest name': 'Uhle Simelane',
        Email: 'onyxwebsystems@gmail.com',
        Type: 'Entrance',
        'What they paid for': 'Entrance fee (R10)',
        'Amount (ZAR)': 10,
        'Paid at': '2026-08-15 01:07',
        Status: 'Paid',
      },
      {
        'Guest name': 'Nathi',
        Email: 'sihle.soa@gmail.com',
        Type: 'Entrance',
        'What they paid for': 'Entrance fee (R10)',
        'Amount (ZAR)': 10,
        'Paid at': '2026-07-24 17:28',
        Status: 'Paid',
      },
      {
        'Guest name': 'Nathi',
        Email: 'sihle.soa@gmail.com',
        Type: 'Entrance',
        'What they paid for': 'Entrance fee (R10)',
        'Amount (ZAR)': 10,
        'Paid at': '2026-07-24 17:27',
        Status: 'Paid',
      },
    ]);
    const buf = await rowsToXlsxBuffer({
      eventTitle: 'Moonlit Harvest Gala',
      eventDate: '2026-08-18',
      rows,
      totalZar: 30,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const purchases = wb.getWorksheet('All purchases');
    assert.equal(purchases.getCell('A8').value, 'Grand total');
    assert.equal(purchases.getCell('E8').value, 30);
    assert.equal(purchases.getCell('F5').value, 10);
    assert.equal(purchases.getCell('F6').value, 20);
    const summary = wb.getWorksheet('Summary');
    assert.equal(summary.getCell('A10').value, 'Amount paid by each guest');
    const guestNames = [summary.getCell('A12').value, summary.getCell('A13').value];
    assert.ok(guestNames.includes('Nathi'));
    const nathiRow = guestNames[0] === 'Nathi' ? 12 : 13;
    assert.equal(summary.getCell(`D${nathiRow}`).value, 20);
    assert.equal(summary.getCell('A14').value, 'Grand total');
    assert.equal(summary.getCell('D14').value, 30);
  });

  it('writes a real xlsx zip', async () => {
    const buf = await rowsToXlsxBuffer({
      eventTitle: 'The Private School',
      eventDate: '2026-06-12',
      rows: [
        {
          'Guest name': 'Ada',
          Email: 'ada@example.com',
          Type: 'Table guest',
          'What they paid for': 'Joined table',
          'Amount (ZAR)': 2400,
          'Paid at': '2026-06-12 22:47',
          Table: 'Garden Terrace (Tier 2) #1',
          'Payment reference': 'ref_1',
          Status: 'Paid',
        },
      ],
    });
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
    assert.ok(buf.length > 500);
  });
});

describe('event purchase log descriptions', () => {
  it('classifies ticket entrance host guest and menu types', () => {
    assert.equal(classifyPurchaseType({ metaType: 'ticket' }), 'Ticket');
    assert.equal(classifyPurchaseType({ ticketKind: 'EVENT_ENTRANCE' }), 'Entrance');
    assert.equal(classifyPurchaseType({ bookingRole: 'HOST' }), 'Table host');
    assert.equal(classifyPurchaseType({ metaType: 'HOSTED_TABLE_JOIN' }), 'Table guest');
    assert.equal(classifyPurchaseType({ metaType: 'HOSTED_TABLE_MENU' }), 'Table menu');
  });

  it('lists ticket quantity and menu lines like a purchase log', () => {
    const text = describePurchase({
      type: 'Ticket',
      tierName: 'VIP',
      quantity: 2,
      menuLines: [{ name: 'Hennessy VSOP', quantity: 2, lineTotal: 2400 }],
    });
    assert.equal(text, 'VIP ×2 · Hennessy VSOP ×2 (R2400)');
  });

  it('does not repeat the type when a guest only joined a table', () => {
    assert.equal(describePurchase({ type: 'Table guest' }), 'Joined table');
  });

  it('summarises menu lines for the spreadsheet', () => {
    assert.equal(
      formatMenuSummary([{ name: 'Corona Extra', quantity: 3, lineTotal: 210 }]),
      'Corona Extra ×3 (R210)',
    );
  });
});
