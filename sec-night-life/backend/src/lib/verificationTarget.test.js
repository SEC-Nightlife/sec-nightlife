import assert from 'node:assert/strict';
import test from 'node:test';
import { selectVerificationAccount } from './verificationTarget.js';

const party = { id: 'u1', role: 'USER', emailVerified: false };
const business = { id: 'u2', role: 'VENUE', emailVerified: true };

test('resend targets the selected unverified role', () => {
  const picked = selectVerificationAccount(
    [party, business],
    'USER',
  );
  assert.equal(picked.code, 'SEND');
  assert.equal(picked.user.id, 'u1');
});

test('resend does not treat a verified sibling role as the target', () => {
  const picked = selectVerificationAccount([party, business], 'VENUE');
  assert.equal(picked.code, 'ALREADY_VERIFIED');
});

test('resend reports a missing sign-in type', () => {
  const picked = selectVerificationAccount([party], 'VENUE');
  assert.equal(picked.code, 'NOT_FOUND');
});

test('resend without a role asks the user to choose when both are unverified', () => {
  const picked = selectVerificationAccount(
    [party, { ...business, emailVerified: false }],
    undefined,
  );
  assert.equal(picked.code, 'ROLE_REQUIRED');
});
