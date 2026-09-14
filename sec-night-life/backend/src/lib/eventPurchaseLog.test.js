import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyPurchaseType,
  describePurchase,
  escapeCsvCell,
  formatMenuSummary,
  purchaseLogFilename,
  rowsToCsv,
  rowsToExcelXml,
} from './eventPurchaseLog.js';

describe('event purchase log CSV', () => {
  it('quotes commas quotes and newlines', () => {
    assert.equal(escapeCsvCell('ok'), 'ok');
    assert.equal(escapeCsvCell('a,b'), '"a,b"');
    assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsvCell('line\nbreak'), '"line\nbreak"');
  });

  it('tells Excel to split on commas and uses CRLF rows', () => {
    const csv = rowsToCsv([
      {
        'Guest name': 'Ada',
        Email: 'ada@example.com',
        Type: 'Ticket',
        'What they paid for': 'VIP ×1 · Hennessy VSOP ×2 (R2400)',
        'Amount (ZAR)': '2600',
        'Paid at': '2026-09-14 22:31',
        Table: '',
        'Payment reference': 'ref_1',
        Status: 'Paid',
      },
    ]);
    assert.equal(csv.startsWith('\uFEFF'), true);
    assert.match(csv, /^[\uFEFF]?sep=,/m);
    assert.match(csv, /Guest name,Email,Type/);
    assert.match(csv, /Ada,ada@example.com,Ticket/);
    assert.match(csv, /\r\n/);
  });

  it('builds a stable spreadsheet filename', () => {
    assert.equal(
      purchaseLogFilename({ title: 'Friends of Friends #DenimOnWhite', date: '2026-04-12' }),
      'purchase-log-friends-of-friends-denimonwhite-2026-04-12.xls',
    );
  });
});

describe('event purchase log Excel workbook', () => {
  it('puts each field in its own cell with a title and total', () => {
    const xml = rowsToExcelXml({
      eventTitle: 'Azure After Dark',
      eventDate: '2026-09-11',
      rows: [
        {
          'Guest name': 'Ada',
          Email: 'ada@example.com',
          Type: 'Table guest',
          'What they paid for': 'Joined table',
          'Amount (ZAR)': 2400,
          'Paid at': '2026-06-18 13:03',
          Table: 'The Elevated Reserve (Tier 2) #1',
          'Payment reference': 'ref_1',
          Status: 'Paid',
        },
      ],
    });
    assert.match(xml, /Purchase log — Azure After Dark/);
    assert.match(xml, /<Data ss:Type="String">Guest name<\/Data>/);
    assert.match(xml, /<Data ss:Type="String">Email<\/Data>/);
    assert.match(xml, /<Data ss:Type="String">Ada<\/Data>/);
    assert.match(xml, /<Data ss:Type="String">ada@example.com<\/Data>/);
    assert.match(xml, /<Data ss:Type="Number">2400<\/Data>/);
    assert.match(xml, /ss:Name="Purchase log"/);
    assert.match(xml, /FreezePanes/);
    assert.match(xml, /Total/);
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
