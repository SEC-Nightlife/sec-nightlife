import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInquiryTransition } from './vendorInquiries.js';
import { confidenceAdjustedRating } from './leaderboard.js';

test('vendor can accept or decline a new request, venue cannot', () => {
  assert.deepEqual(resolveInquiryTransition('accept', 'REQUESTED', 'vendor'), { ok: true, to: 'ACCEPTED' });
  assert.deepEqual(resolveInquiryTransition('decline', 'REQUESTED', 'vendor'), { ok: true, to: 'DECLINED' });
  assert.equal(resolveInquiryTransition('accept', 'REQUESTED', 'venue').status, 403);
});

test('only accepted requests can be completed, by either side', () => {
  assert.deepEqual(resolveInquiryTransition('complete', 'ACCEPTED', 'venue'), { ok: true, to: 'COMPLETED' });
  assert.deepEqual(resolveInquiryTransition('complete', 'ACCEPTED', 'vendor'), { ok: true, to: 'COMPLETED' });
  assert.equal(resolveInquiryTransition('complete', 'REQUESTED', 'venue').status, 409);
  assert.equal(resolveInquiryTransition('complete', 'DECLINED', 'vendor').status, 409);
});

test('venue can cancel open requests but not finished ones', () => {
  assert.deepEqual(resolveInquiryTransition('cancel', 'ACCEPTED', 'venue'), { ok: true, to: 'CANCELLED' });
  assert.equal(resolveInquiryTransition('cancel', 'COMPLETED', 'venue').status, 409);
  assert.equal(resolveInquiryTransition('cancel', 'REQUESTED', 'vendor').status, 403);
  assert.equal(resolveInquiryTransition('bogus', 'REQUESTED', 'vendor').status, 400);
});

test('top-rated ranking prefers many good reviews over one perfect review', () => {
  assert.equal(confidenceAdjustedRating(0, 0), 0);
  assert.ok(confidenceAdjustedRating(4.8, 40) > confidenceAdjustedRating(5, 1));
});
