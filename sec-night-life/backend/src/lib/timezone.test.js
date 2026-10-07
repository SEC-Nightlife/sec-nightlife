import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCountryCode,
  resolveTimeZone,
  zonedParts,
  zonedWallTimeToUtc,
  zonedYmd,
} from './timezone.js';

test('normalizeCountryCode accepts ISO alpha-2 only', () => {
  assert.equal(normalizeCountryCode('za'), 'ZA');
  assert.equal(normalizeCountryCode(' gb '), 'GB');
  assert.equal(normalizeCountryCode('ZAF'), null);
  assert.equal(normalizeCountryCode(''), null);
  assert.equal(normalizeCountryCode(null), null);
});

test('resolveTimeZone uses coordinates, then country, then SAST', () => {
  assert.equal(resolveTimeZone({ latitude: -33.92, longitude: 18.42 }), 'Africa/Johannesburg');
  assert.equal(resolveTimeZone({ latitude: 51.5, longitude: -0.12 }), 'Europe/London');
  assert.equal(resolveTimeZone({ countryCode: 'US' }), 'America/New_York');
  assert.equal(resolveTimeZone({}), 'Africa/Johannesburg');
});

test('zonedWallTimeToUtc round-trips wall-clock times across zones and DST', () => {
  const sast = zonedWallTimeToUtc(2026, 10, 7, 22, 0, 'Africa/Johannesburg');
  assert.equal(sast.toISOString(), '2026-10-07T20:00:00.000Z');
  const londonSummer = zonedWallTimeToUtc(2026, 7, 1, 22, 0, 'Europe/London');
  assert.equal(londonSummer.toISOString(), '2026-07-01T21:00:00.000Z');
  const londonWinter = zonedWallTimeToUtc(2026, 12, 1, 22, 0, 'Europe/London');
  assert.equal(londonWinter.toISOString(), '2026-12-01T22:00:00.000Z');
  const p = zonedParts(londonSummer, 'Europe/London');
  assert.equal(p.hour, 22);
  assert.equal(zonedYmd(new Date('2026-10-07T23:30:00Z'), 'Africa/Johannesburg'), '2026-10-08');
});
