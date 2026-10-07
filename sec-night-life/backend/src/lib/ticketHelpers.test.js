import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventStartsAtFromEvent,
  eventStartsAtFromHostedTable,
  formatVisibleUntilSast,
} from './ticketHelpers.js';
import { windowEndInstant, parseWindowInstant } from './dayBookingWindows.js';
import { dayStartsAtForScheduleEntry, weekdayKeyFromDate } from './serviceSchedule.js';

test('eventStartsAtFromEvent reads startTime as venue wall time (SAST by default)', () => {
  const start = eventStartsAtFromEvent({ date: new Date('2026-10-10T00:00:00.000Z'), startTime: '22:00' });
  assert.equal(start.toISOString(), '2026-10-10T20:00:00.000Z');
});

test('eventStartsAtFromEvent uses the event time zone, including DST', () => {
  const ny = eventStartsAtFromEvent({
    date: new Date('2026-07-04T00:00:00.000Z'),
    startTime: '21:00',
    timezone: 'America/New_York',
  });
  assert.equal(ny.toISOString(), '2026-07-05T01:00:00.000Z');
  const london = eventStartsAtFromEvent({
    date: '2026-12-31T00:00:00.000Z',
    start_time: '23:30',
    venue: { timezone: 'Europe/London' },
  });
  assert.equal(london.toISOString(), '2026-12-31T23:30:00.000Z');
});

test('eventStartsAtFromHostedTable derives the zone from an own-place listing location', () => {
  const start = eventStartsAtFromHostedTable({
    eventDate: new Date('2026-11-14T00:00:00.000Z'),
    eventTime: '20:00',
    latitude: 51.5074,
    longitude: -0.1278,
    countryCode: 'GB',
  });
  assert.equal(start.toISOString(), '2026-11-14T20:00:00.000Z');
});

test('overnight day-booking windows end on the next local day west of UTC', () => {
  const tz = 'America/New_York';
  const date = new Date('2026-10-09T00:00:00.000Z');
  const end = windowEndInstant(date, '20:00', '02:00', tz);
  assert.equal(end.toISOString(), '2026-10-10T06:00:00.000Z');
  assert.equal(parseWindowInstant(date, '20:00', tz).toISOString(), '2026-10-10T00:00:00.000Z');
});

test('schedule helpers use the venue zone for weekday and start time', () => {
  const ref = new Date('2026-10-09T23:30:00.000Z');
  assert.equal(weekdayKeyFromDate(ref), 'saturday');
  assert.equal(weekdayKeyFromDate(ref, 'America/New_York'), 'friday');
  const start = dayStartsAtForScheduleEntry({ day: 'saturday', startTime: '12:00' }, ref);
  assert.equal(start.toISOString(), '2026-10-10T10:00:00.000Z');
});

test('formatVisibleUntilSast labels the venue zone', () => {
  const at = new Date('2026-10-10T20:00:00.000Z');
  assert.match(formatVisibleUntilSast(at), /\(SAST\)$/);
  assert.match(formatVisibleUntilSast(at, 'Europe/London'), /21:00 \((GMT\+1|BST)\)$/);
});
