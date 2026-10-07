import { DEFAULT_TIMEZONE, zoneFrom, zonedParts, zonedWallTimeToUtc } from './timezone.js';

export const WEEKDAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export const WEEKDAY_LABELS = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};

export const WEEKDAY_FULL = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

/** Weekday key of `date` in the venue's time zone (default SAST). */
export function weekdayKeyFromDate(date = new Date(), tz = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return 'monday';
  const js = zonedParts(d, tz).weekday;
  return WEEKDAY_KEYS[(js + 6) % 7];
}

function parseClock(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return { h, m };
}

/** Normalize API/form payload to sorted unique day entries. */
export function normalizeServiceSchedule(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : input?.days;
  if (!Array.isArray(raw)) return [];
  const byDay = new Map();
  for (const row of raw) {
    const day = String(row?.day || '').toLowerCase();
    if (!WEEKDAY_KEYS.includes(day)) continue;
    const startTime = row.startTime || row.start_time || '19:00';
    const endTime = row.endTime || row.end_time || '23:00';
    byDay.set(day, { day, startTime, endTime });
  }
  return WEEKDAY_KEYS.filter((d) => byDay.has(d)).map((d) => byDay.get(d));
}

export function serviceScheduleFromTable(table) {
  if (!table) return [];
  const sched = table.serviceSchedule ?? table.service_schedule;
  const normalized = normalizeServiceSchedule(sched);
  if (normalized.length) return normalized;
  if (table.startTime || table.endTime) {
    return [{ day: 'monday', startTime: table.startTime || '19:00', endTime: table.endTime || '23:00' }];
  }
  return [];
}

export function isVenueTableOpenOnWeekday(table, weekdayKey) {
  const schedule = serviceScheduleFromTable(table);
  if (!schedule.length) return true;
  return schedule.some((e) => e.day === weekdayKey);
}

export function isVenueTableBookableToday(table, refDate = new Date(), tz = zoneFrom(table)) {
  return isVenueTableOpenOnWeekday(table, weekdayKeyFromDate(refDate, tz));
}

export function scheduleEntryForWeekday(table, weekdayKey) {
  const schedule = serviceScheduleFromTable(table);
  return schedule.find((e) => e.day === weekdayKey) || null;
}

/** Wall-clock HH:mm on the venue-local calendar day (y, m, d) plus `addDays`. */
function zonedClockOnDay(year, month, day, addDays, clock, tz) {
  const cal = new Date(Date.UTC(year, month - 1, day + addDays));
  return zonedWallTimeToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), clock.h, clock.m, tz);
}

/** Start instant (venue wall time) for a weekday entry on the week containing refDate. */
export function dayStartsAtForScheduleEntry(entry, refDate = new Date(), tz = DEFAULT_TIMEZONE) {
  if (!entry) return null;
  const targetIdx = WEEKDAY_KEYS.indexOf(entry.day);
  if (targetIdx < 0) return null;
  const jsTarget = (targetIdx + 1) % 7;
  const p = zonedParts(refDate, tz);
  let diff = jsTarget - p.weekday;
  if (diff < 0) diff += 7;
  const clock = parseClock(entry.startTime) || { h: 0, m: 0 };
  return zonedClockOnDay(p.year, p.month, p.day, diff, clock, tz);
}

/** End instant for a weekday entry (handles end after midnight). */
export function dayEndsAtForScheduleEntry(entry, refDate = new Date(), tz = DEFAULT_TIMEZONE) {
  if (!entry) return null;
  const start = dayStartsAtForScheduleEntry(entry, refDate, tz);
  if (!start) return null;
  const sp = zonedParts(start, tz);
  const startClock = parseClock(entry.startTime);
  const endClock = parseClock(entry.endTime);
  if (!endClock) {
    return new Date(zonedClockOnDay(sp.year, sp.month, sp.day, 0, { h: 23, m: 59 }, tz).getTime() + 59_999);
  }
  const overnight =
    startClock && endClock.h * 60 + endClock.m <= startClock.h * 60 + startClock.m;
  return zonedClockOnDay(sp.year, sp.month, sp.day, overnight ? 1 : 0, endClock, tz);
}

export function dayStartsAtFromVenueTableSchedule(table, refDate = new Date(), tz = zoneFrom(table)) {
  const entry = scheduleEntryForWeekday(table, weekdayKeyFromDate(refDate, tz));
  if (entry) return dayStartsAtForScheduleEntry(entry, refDate, tz);
  return null;
}

export function dayEndsAtFromVenueTableSchedule(table, refDate = new Date(), tz = zoneFrom(table)) {
  const entry = scheduleEntryForWeekday(table, weekdayKeyFromDate(refDate, tz));
  if (entry) return dayEndsAtForScheduleEntry(entry, refDate, tz);
  return null;
}

export function formatServiceScheduleSummary(schedule) {
  const rows = normalizeServiceSchedule(schedule);
  if (!rows.length) return null;
  const dayPart = rows.map((r) => WEEKDAY_LABELS[r.day] || r.day).join(', ');
  const uniqueWindows = new Set(rows.map((r) => `${r.startTime}–${r.endTime}`));
  if (uniqueWindows.size === 1) {
    const [window] = [...uniqueWindows];
    return `${dayPart} · ${window}`;
  }
  return rows.map((r) => `${WEEKDAY_LABELS[r.day] || r.day} ${r.startTime}–${r.endTime}`).join(' · ');
}
