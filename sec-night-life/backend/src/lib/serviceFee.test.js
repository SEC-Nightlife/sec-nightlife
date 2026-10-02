import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE_FEE_ZAR,
  serviceFeeForSubtotal,
  serviceFeeFromMeta,
  netOfServiceFee,
  withServiceFee,
  isServiceFeeLine,
} from './serviceFee.js';

test('flat R5 fee applies only to paid subtotals', () => {
  assert.equal(SERVICE_FEE_ZAR, 5);
  assert.equal(serviceFeeForSubtotal(10), 5);
  assert.equal(serviceFeeForSubtotal(1500), 5);
  assert.equal(serviceFeeForSubtotal(0), 0);
  assert.equal(serviceFeeForSubtotal(-3), 0);
});

test('withServiceFee appends a fee line and totals', () => {
  const r = withServiceFee([{ code: 'entrance', label: 'Entrance', amount_zar: 10 }], 10);
  assert.equal(r.subtotal, 10);
  assert.equal(r.serviceFee, 5);
  assert.equal(r.total, 15);
  assert.equal(r.lines.length, 2);
  assert.ok(isServiceFeeLine(r.lines[1]));
});

test('withServiceFee adds nothing to free checkouts', () => {
  const r = withServiceFee([], 0);
  assert.equal(r.serviceFee, 0);
  assert.equal(r.total, 0);
  assert.equal(r.lines.length, 0);
});

test('serviceFeeFromMeta reads metadata or the fee line', () => {
  assert.equal(serviceFeeFromMeta({ service_fee_zar: 5 }), 5);
  assert.equal(serviceFeeFromMeta({ lines: [{ code: 'service_fee', amount_zar: 5 }] }), 5);
  assert.equal(serviceFeeFromMeta({}), 0);
  assert.equal(serviceFeeFromMeta(null), 0);
});

test('netOfServiceFee strips the fee before splits', () => {
  assert.equal(netOfServiceFee({ service_fee_zar: 5 }, 15), 10);
  assert.equal(netOfServiceFee({}, 15), 15);
  assert.equal(netOfServiceFee({ service_fee_zar: 5 }, 3), 0);
});
