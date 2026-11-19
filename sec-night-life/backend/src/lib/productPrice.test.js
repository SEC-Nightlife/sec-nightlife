import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expectedPlatformProductAmountZar,
  HOUSE_PARTY_BOOST_ZAR,
  HOUSE_PARTY_PUBLISH_ZAR,
} from './paystackPayout.js';

test('house party publish and boost have a fixed price', () => {
  assert.equal(expectedPlatformProductAmountZar({ type: 'HOUSE_PARTY_PUBLISH' }), HOUSE_PARTY_PUBLISH_ZAR);
  assert.equal(expectedPlatformProductAmountZar({ type: 'HOUSE_PARTY_BOOST', boost_days: 0 }), HOUSE_PARTY_BOOST_ZAR);
});

test('a promotion checkout cannot be priced at zero days', () => {
  assert.equal(expectedPlatformProductAmountZar({ type: 'promotion' }), 50);
  assert.equal(expectedPlatformProductAmountZar({ type: 'PROMOTION_PUBLISH', publish_days: 3 }), 150);
  assert.equal(expectedPlatformProductAmountZar({ type: 'BOOST', boost_days: 0 }), 150);
  assert.equal(expectedPlatformProductAmountZar({ type: 'EVENT_BOOST', days: 2 }), 300);
});
