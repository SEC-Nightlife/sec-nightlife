import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyPurchaseType,
  describePurchase,
  formatMenuSummary,
  groupPurchaseLogRows,
  purchaseLogFilename,
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

describe('event purchase log Excel workbook', () => {
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
