import assert from 'node:assert/strict';
import test from 'node:test';
import { ticketPayoutAmounts } from './issueEventTickets.js';

test('a declared split that matches the charge is kept', () => {
  const out = ticketPayoutAmounts(100, { platform_fee_zar: 4, venue_share_zar: 96 });
  assert.equal(out.eSec, 4);
  assert.equal(out.eRec, 96);
  assert.equal(out.grossZar, 100);
});

test('a declared venue share larger than the charge is recomputed', () => {
  const out = ticketPayoutAmounts(100, { platform_fee_zar: 0, venue_share_zar: 100000 });
  assert.ok(out.eRec <= 100);
  assert.equal(out.grossZar, 100);
  assert.equal(round(out.eSec + out.eRec), 100);
});

function round(n) {
  return Math.round(n * 100) / 100;
}
