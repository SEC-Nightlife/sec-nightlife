import assert from 'node:assert/strict';
import test from 'node:test';
import { transferRetryDecision } from './paystackPayout.js';

test('a successful transfer is not sent again', () => {
  assert.equal(transferRetryDecision('success'), 'confirm');
});

test('an in-flight transfer is not sent again', () => {
  for (const status of ['pending', 'otp', 'receiving', 'processing', 'queued']) {
    assert.equal(transferRetryDecision(status), 'wait');
  }
});

test('only a confirmed dead transfer may use a new reference', () => {
  for (const status of ['failed', 'reversed', 'abandoned', 'not_found']) {
    assert.equal(transferRetryDecision(status), 'resend');
  }
});

test('an unknown or empty status waits instead of paying twice', () => {
  assert.equal(transferRetryDecision(''), 'wait');
  assert.equal(transferRetryDecision('otp'), 'wait');
  assert.equal(transferRetryDecision('something-new'), 'wait');
});
