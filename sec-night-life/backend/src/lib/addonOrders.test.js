import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAddonSelections,
  formatAddonOrder,
  MAX_ADDON_LINES,
  MAX_ADDON_QTY_PER_LINE,
} from './addonOrders.js';
import { isFulfillmentActive } from './orderFulfillment.js';

test('normalizeAddonSelections merges duplicates and drops empty lines', () => {
  const out = normalizeAddonSelections([
    { menuItemId: 'a', quantity: 1 },
    { menuItemId: 'a', quantity: 2 },
    { menuItemId: 'b', quantity: 0 },
    { menuItemId: '', quantity: 3 },
    { menu_item_id: 'c', quantity: '2' },
  ]);
  assert.deepEqual(out, [
    { menuItemId: 'a', quantity: 3 },
    { menuItemId: 'c', quantity: 2 },
  ]);
});

test('normalizeAddonSelections caps quantity and line count', () => {
  const big = normalizeAddonSelections([{ menuItemId: 'x', quantity: 999 }]);
  assert.equal(big[0].quantity, MAX_ADDON_QTY_PER_LINE);
  const many = normalizeAddonSelections(
    Array.from({ length: MAX_ADDON_LINES + 10 }, (_, i) => ({ menuItemId: `m${i}`, quantity: 1 })),
  );
  assert.equal(many.length, MAX_ADDON_LINES);
});

test('normalizeAddonSelections ignores non-arrays', () => {
  assert.deepEqual(normalizeAddonSelections(null), []);
  assert.deepEqual(normalizeAddonSelections('x'), []);
});

test('undone fulfilments do not count as served', () => {
  assert.equal(isFulfillmentActive(null), false);
  assert.equal(isFulfillmentActive({ fulfilledAt: new Date(), undoneAt: null }), true);
  assert.equal(isFulfillmentActive({ fulfilledAt: new Date(), undoneAt: new Date() }), false);
});

test('formatAddonOrder reports served state only for active fulfilment', () => {
  const addon = {
    id: 'a1',
    paystackReference: 'ref1',
    status: 'PAID',
    parentKind: 'TICKET',
    parentReference: 'p1',
    items: [{ name: 'Fries', quantity: 2 }],
    subtotalZar: 100,
    serviceFeeZar: 5,
    totalZar: 105,
  };
  assert.equal(formatAddonOrder(addon).fulfilled, false);
  assert.equal(formatAddonOrder(addon, { fulfillment: { fulfilledAt: new Date(), undoneAt: null } }).fulfilled, true);
  assert.equal(
    formatAddonOrder(addon, { fulfillment: { fulfilledAt: new Date(), undoneAt: new Date() } }).fulfilled,
    false,
  );
  assert.equal(formatAddonOrder(addon).items_summary, '2× Fries');
});
