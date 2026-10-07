import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeedScope, scopeWhere, inLocalScope, widerScope, feedScopeCacheKey } from './feedScope.js';

test('normalizeFeedScope maps aliases and rejects unknown values', () => {
  assert.equal(normalizeFeedScope('LOCAL'), 'local');
  assert.equal(normalizeFeedScope('nationwide'), 'national');
  assert.equal(normalizeFeedScope('all'), 'worldwide');
  assert.equal(normalizeFeedScope('galaxy'), null);
  assert.equal(normalizeFeedScope(undefined), null);
});

test('scopeWhere builds country, city and geo filters', () => {
  assert.deepEqual(scopeWhere(null), {});
  assert.deepEqual(scopeWhere({ scope: 'worldwide', countryCode: 'ZA' }), {});
  assert.deepEqual(scopeWhere({ scope: 'national', countryCode: 'GB' }), { countryCode: 'GB' });
  assert.deepEqual(scopeWhere({ scope: 'local', countryCode: 'ZA', city: 'Durban' }), {
    countryCode: 'ZA',
    city: { equals: 'Durban', mode: 'insensitive' },
  });
  const geo = scopeWhere(
    { scope: 'local', countryCode: 'ZA', geo: { lat: -26, lng: 28, radiusKm: 25 } },
    { geoRelation: 'venue' },
  );
  assert.ok(geo.venue.latitude.gte < -26 && geo.venue.latitude.lte > -26);
  assert.deepEqual(
    scopeWhere({ scope: 'national', countryCode: 'ZA' }, { countryField: 'targetCountryCode' }),
    { targetCountryCode: 'ZA' },
  );
});

test('inLocalScope uses distance first and city as fallback', () => {
  const feed = { scope: 'local', city: 'Cape Town', geo: { lat: -33.92, lng: 18.42, radiusKm: 25 } };
  assert.equal(inLocalScope(feed, { latitude: -33.9, longitude: 18.4 }), true);
  assert.equal(inLocalScope(feed, { latitude: -26.2, longitude: 28.0 }), false);
  assert.equal(inLocalScope(feed, { city: 'cape town' }), true);
  assert.equal(inLocalScope({ scope: 'national' }, {}), true);
});

test('widerScope steps local → national → worldwide and cache keys differ', () => {
  const local = { scope: 'local', countryCode: 'ZA', city: 'Durban', geo: null };
  const national = widerScope(local);
  assert.equal(national.scope, 'national');
  assert.equal(widerScope(national).scope, 'worldwide');
  assert.equal(widerScope({ scope: 'worldwide' }), null);
  assert.notEqual(feedScopeCacheKey(local), feedScopeCacheKey(national));
});
