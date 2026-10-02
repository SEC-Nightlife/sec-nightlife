import test from 'node:test';
import assert from 'node:assert/strict';
import { PAYOUT_MIN_ZAR, nextPayoutDate, groupPayoutRowsByRecipient } from './payoutSchedule.js';

test('nextPayoutDate returns the coming Monday 07:00 UTC', () => {
  // Friday 2 Oct 2026
  const d = nextPayoutDate(new Date('2026-10-02T12:00:00Z'));
  assert.equal(d.toISOString(), '2026-10-05T07:00:00.000Z');
});

test('nextPayoutDate on Monday before the run is the same day', () => {
  const d = nextPayoutDate(new Date('2026-10-05T05:00:00Z'));
  assert.equal(d.toISOString(), '2026-10-05T07:00:00.000Z');
});

test('nextPayoutDate on Monday after the run is next week', () => {
  const d = nextPayoutDate(new Date('2026-10-05T07:30:00Z'));
  assert.equal(d.toISOString(), '2026-10-12T07:00:00.000Z');
});

test('groupPayoutRowsByRecipient applies the R50 minimum per recipient', () => {
  assert.equal(PAYOUT_MIN_ZAR, 50);
  const rows = [
    { id: 'a', recipientVenueId: 'v1', recipientUserId: null, recipientAmount: 8.5 },
    { id: 'b', recipientVenueId: 'v1', recipientUserId: null, recipientAmount: 42 },
    { id: 'c', recipientVenueId: null, recipientUserId: 'u1', recipientAmount: 20 },
    { id: 'd', recipientVenueId: null, recipientUserId: 'u1', recipientAmount: 0 },
  ];
  const { eligible, carriedOver } = groupPayoutRowsByRecipient(rows);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].recipientType, 'VENUE');
  assert.equal(eligible[0].total, 50.5);
  assert.deepEqual(eligible[0].rowIds, ['a', 'b']);
  assert.equal(carriedOver.length, 1);
  assert.equal(carriedOver[0].recipientUserId, 'u1');
  assert.deepEqual(carriedOver[0].rowIds, ['c']);
});
