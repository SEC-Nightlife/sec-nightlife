import { prisma } from './prisma.js';
import {
  scheduleEntryForWeekday,
  serviceScheduleFromTable,
  weekdayKeyFromDate,
} from './serviceSchedule.js';
import {
  DEFAULT_TIMEZONE,
  zoneFrom,
  zonedParts,
  zonedWallTimeToUtc,
  zonedYmd,
  zonedDateTimeToUtc,
  calendarParts,
} from './timezone.js';

/**
 * Day-booking times are venue wall-clock times. Every helper takes the venue time zone
 * (default Africa/Johannesburg, so legacy "...Sast" names keep their behaviour).
 */
const MIN_WINDOW_MINUTES = 30;
const END_BUFFER_MINUTES = 0;
const SLOT_STEP_MINUTES = 30;

function parseClock(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return { h, m, minutes: h * 60 + m };
}

function minutesToHHmm(totalMinutes) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isOvernightWindow(startTime, endTime) {
  const s = parseClock(startTime);
  const e = parseClock(endTime);
  if (!s || !e) return false;
  return e.minutes <= s.minutes;
}

/** Map HH:mm onto the venue service-day timeline (minutes from midnight, +1440 after midnight when overnight). */
export function toServiceMinutes(time, venueWindow) {
  const t = parseClock(time);
  const vs = parseClock(venueWindow?.startTime);
  if (!t || !vs) return null;
  let m = t.minutes;
  if (isOvernightWindow(venueWindow.startTime, venueWindow.endTime) && m < vs.minutes) {
    m += 1440;
  }
  return m;
}

export function serviceInterval(startTime, endTime, venueWindow) {
  const s = toServiceMinutes(startTime, venueWindow);
  let e = toServiceMinutes(endTime, venueWindow);
  if (s == null || e == null) return null;
  if (e <= s) e += 1440;
  return [s, e];
}

export function currentClockSast(refDate = new Date(), tz = DEFAULT_TIMEZONE) {
  const d = refDate instanceof Date ? refDate : new Date(refDate);
  if (Number.isNaN(d.getTime())) return null;
  const p = zonedParts(d, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function nowMinutesSast(venueWindow, now = new Date(), tz = DEFAULT_TIMEZONE) {
  const nowClock = currentClockSast(now, tz);
  if (!nowClock || !venueWindow) return null;
  return toServiceMinutes(nowClock, venueWindow);
}

export function isStartTimeInPast(startTime, venueWindow, now = new Date(), tz = DEFAULT_TIMEZONE) {
  const nowM = nowMinutesSast(venueWindow, now, tz);
  const startM = toServiceMinutes(startTime, venueWindow);
  if (nowM == null || startM == null) return false;
  return startM < nowM;
}

export function ceilToSlotStep(minutes, step = SLOT_STEP_MINUTES) {
  if (!Number.isFinite(minutes)) return null;
  return Math.ceil(minutes / step) * step;
}

export function earliestBookableStartMinutes(venueWindow, now = new Date(), step = SLOT_STEP_MINUTES, tz = DEFAULT_TIMEZONE) {
  if (!venueWindow?.startTime) return null;
  const bookableStart = toServiceMinutes(venueWindow.startTime, venueWindow);
  if (bookableStart == null) return null;

  const nowM = nowMinutesSast(venueWindow, now, tz);
  if (nowM == null) return bookableStart;

  const roundedNow = ceilToSlotStep(nowM, step);
  return Math.max(bookableStart, roundedNow);
}

export function latestBookableEndTime(venueWindow, bufferMinutes = END_BUFFER_MINUTES) {
  if (!venueWindow?.endTime) return null;
  const e = parseClock(venueWindow.endTime);
  if (!e) return null;
  let mins = e.minutes - bufferMinutes;
  if (mins < 0) mins += 1440;
  return minutesToHHmm(mins);
}

export function windowsOverlapOvernight(startA, endA, startB, endB, venueWindow = null) {
  if (venueWindow?.startTime && venueWindow?.endTime) {
    const a = serviceInterval(startA, endA, venueWindow);
    const b = serviceInterval(startB, endB, venueWindow);
    if (!a || !b) return false;
    return a[0] < b[1] && b[0] < a[1];
  }
  const a0 = parseClock(startA);
  const a1 = parseClock(endA);
  const b0 = parseClock(startB);
  const b1 = parseClock(endB);
  if (!a0 || !a1 || !b0 || !b1) return false;
  let t0a = a0.minutes;
  let t1a = a1.minutes;
  let t0b = b0.minutes;
  let t1b = b1.minutes;
  if (t1a <= t0a) t1a += 1440;
  if (t1b <= t0b) t1b += 1440;
  return t0a < t1b && t0b < t1a;
}

export function bookingDurationMinutes(startTime, endTime, venueWindow) {
  const interval = venueWindow
    ? serviceInterval(startTime, endTime, venueWindow)
    : (() => {
        const s = parseClock(startTime);
        const e = parseClock(endTime);
        if (!s || !e) return null;
        let t0 = s.minutes;
        let t1 = e.minutes;
        if (t1 <= t0) t1 += 1440;
        return [t0, t1];
      })();
  if (!interval) return null;
  return interval[1] - interval[0];
}

/**
 * Available gaps within the venue service window, excluding booked occupancy and the end buffer.
 * @param {{ startTime: string, endTime: string }} venueWindow
 * @param {Array<{ startTime: string, endTime: string }>} occupancy
 */
export function buildAvailableGaps(
  venueWindow,
  occupancy = [],
  { minMinutes = MIN_WINDOW_MINUTES, endBufferMinutes = END_BUFFER_MINUTES, now = new Date(), tz = DEFAULT_TIMEZONE } = {},
) {
  if (!venueWindow?.startTime || !venueWindow?.endTime) return [];

  let bookableStart = toServiceMinutes(venueWindow.startTime, venueWindow);
  const venueEnd = toServiceMinutes(venueWindow.endTime, venueWindow);
  if (bookableStart == null || venueEnd == null) return [];

  const earliest = earliestBookableStartMinutes(venueWindow, now, SLOT_STEP_MINUTES, tz);
  if (earliest != null) {
    bookableStart = Math.max(bookableStart, earliest);
  }

  let bookableEnd = venueEnd - endBufferMinutes;
  if (bookableEnd <= bookableStart) return [];

  const blocks = occupancy
    .map((o) => serviceInterval(o.startTime, o.endTime, venueWindow))
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [s, e] of blocks) {
    const clampedStart = Math.max(s, bookableStart);
    const clampedEnd = Math.min(e, bookableEnd);
    if (clampedEnd <= clampedStart) continue;
    const last = merged[merged.length - 1];
    if (last && clampedStart <= last[1]) {
      last[1] = Math.max(last[1], clampedEnd);
    } else {
      merged.push([clampedStart, clampedEnd]);
    }
  }

  const gaps = [];
  let cursor = bookableStart;
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < bookableEnd) gaps.push([cursor, bookableEnd]);

  return gaps
    .filter(([s, e]) => e - s >= minMinutes)
    .map(([s, e]) => ({
      startTime: minutesToHHmm(s),
      endTime: minutesToHHmm(e),
    }));
}

export function formatYmdSast(date, tz = DEFAULT_TIMEZONE) {
  return zonedYmd(date instanceof Date ? date : new Date(date), tz);
}

/** Local midnight of `date`'s calendar day in `tz`, as a UTC instant (for hostedTable.eventDate). */
export function bookingDateStartSast(date = new Date(), tz = DEFAULT_TIMEZONE) {
  const p = zonedParts(date instanceof Date ? date : new Date(date), tz);
  return zonedWallTimeToUtc(p.year, p.month, p.day, 0, 0, tz);
}

export function normalizeBookingDateSast(raw, tz = DEFAULT_TIMEZONE) {
  if (!raw) return bookingDateStartSast(new Date(), tz);
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) return bookingDateStartSast(new Date(), tz);
  return bookingDateStartSast(d, tz);
}

/** Start of the local calendar day as a UTC instant. */
export function startOfTodaySast(now = new Date(), tz = DEFAULT_TIMEZONE) {
  return bookingDateStartSast(now, tz);
}

export function startOfTomorrowSast(now = new Date(), tz = DEFAULT_TIMEZONE) {
  const p = zonedParts(now instanceof Date ? now : new Date(now), tz);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedWallTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz);
}

export function isHostedTableForToday(ht, refDate = new Date(), tz = DEFAULT_TIMEZONE) {
  if (!ht?.eventDate) return false;
  const eventYmd = formatYmdSast(ht.eventDate, tz);
  const todayYmd = formatYmdSast(refDate, tz);
  return eventYmd === todayYmd;
}

/** Venue day-booking host session (not tied to an in-app event). */
export function isDayVenueHostedTable(ht) {
  if (!ht || ht.eventId) return false;
  return Boolean(ht.venueTableId);
}

/** Whether a day-booking host session should still block inventory / show as occupied. */
export function isDaySessionStillActive(ht, venueTable, now = new Date(), tz = zoneFrom(venueTable)) {
  if (!ht || !['ACTIVE', 'FULL'].includes(ht.status)) return false;
  if (ht.eventId) return false;
  if (!isHostedTableForToday(ht, now, tz)) return false;
  if (ht.windowEndsAt) {
    const end = ht.windowEndsAt instanceof Date ? ht.windowEndsAt : new Date(ht.windowEndsAt);
    return !Number.isNaN(end.getTime()) && end.getTime() > now.getTime();
  }
  const endsAt = computeLegacyWindowEndsAt(ht, venueTable);
  if (endsAt) return endsAt.getTime() > now.getTime();
  return false;
}

/** Calendar date + HH:mm as venue wall time, matching cron.js eventStartDateTime. */
export function parseWindowInstant(date, hhmm, tz = DEFAULT_TIMEZONE) {
  if (!date || !hhmm) return null;
  if (!/^\d{2}:\d{2}$/.test(String(hhmm))) return null;
  return zonedDateTimeToUtc(date, String(hhmm), tz);
}

/** When a day-booking host session moves from Upcoming to Past on the host dashboard. */
export function dayBookingHideAfterUtc(hostedRow, tz = DEFAULT_TIMEZONE) {
  // Prefer booked window end — never start + 24h.
  if (hostedRow?.windowEndsAt) {
    const stored =
      hostedRow.windowEndsAt instanceof Date ? hostedRow.windowEndsAt : new Date(hostedRow.windowEndsAt);
    if (!Number.isNaN(stored.getTime())) return stored;
  }

  if (hostedRow?.eventDate && hostedRow?.eventTime && hostedRow?.eventEndTime) {
    const end = windowEndInstant(hostedRow.eventDate, hostedRow.eventTime, hostedRow.eventEndTime, tz);
    if (end && !Number.isNaN(end.getTime())) return end;
  }

  if (hostedRow?.eventDate) {
    // End of the booking's local calendar day (midnight next day).
    const cal = calendarParts(hostedRow.eventDate, tz);
    if (!cal) return null;
    const next = new Date(Date.UTC(cal.year, cal.month - 1, cal.day + 1));
    return zonedWallTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz);
  }

  return null;
}

export function windowEndInstant(date, startTime, endTime, tz = DEFAULT_TIMEZONE) {
  const start = parseWindowInstant(date, startTime, tz);
  const end = parseWindowInstant(date, endTime, tz);
  if (!start || !end) return null;
  const startClock = parseClock(startTime);
  const endClock = parseClock(endTime);
  if (startClock && endClock && endClock.minutes <= startClock.minutes) {
    const cal = calendarParts(date, tz);
    const next = new Date(Date.UTC(cal.year, cal.month - 1, cal.day + 1));
    return zonedWallTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), endClock.h, endClock.m, tz);
  }
  return end;
}

export function venueWindowForDate(table, refDate = new Date(), tz = zoneFrom(table)) {
  const entry = scheduleEntryForWeekday(table, weekdayKeyFromDate(refDate, tz));
  // timeZone travels with the window so clients evaluate "now" in venue time.
  if (entry) {
    return { startTime: entry.startTime, endTime: entry.endTime, timeZone: tz };
  }
  const startTime = table?.startTime ?? table?.start_time;
  const endTime = table?.endTime ?? table?.end_time;
  if (startTime && endTime) return { startTime: String(startTime), endTime: String(endTime), timeZone: tz };
  return null;
}

export function windowsOverlap(startA, endA, startB, endB, venueWindow = null) {
  return windowsOverlapOvernight(startA, endA, startB, endB, venueWindow);
}

export function isTimeWithinWindow(time, windowStart, windowEnd) {
  const t = parseClock(time);
  const s = parseClock(windowStart);
  const e = parseClock(windowEnd);
  if (!t || !s || !e) return false;
  if (e.minutes > s.minutes) return t.minutes >= s.minutes && t.minutes <= e.minutes;
  return t.minutes >= s.minutes || t.minutes <= e.minutes;
}

export function validateUserWindow(userStart, userEnd, venueWindow, now = new Date(), options = {}) {
  const tz = options.tz || DEFAULT_TIMEZONE;
  if (!venueWindow?.startTime || !venueWindow?.endTime) {
    return { ok: false, error: 'No service window configured for this day' };
  }
  const s = parseClock(userStart);
  const e = parseClock(userEnd);
  if (!s || !e) return { ok: false, error: 'Invalid time format' };

  if (isStartTimeInPast(userStart, venueWindow, now, tz)) {
    return { ok: false, error: 'This time has already passed' };
  }

  const duration = bookingDurationMinutes(userStart, userEnd, venueWindow);
  if (duration == null || duration < MIN_WINDOW_MINUTES) {
    return { ok: false, error: `Minimum booking duration is ${MIN_WINDOW_MINUTES} minutes` };
  }

  const maxDurationMinutes = options.maxDurationMinutes ?? null;
  if (maxDurationMinutes != null && duration > maxDurationMinutes) {
    const hours = maxDurationMinutes / 60;
    const label = Number.isInteger(hours) ? `${hours} hour${hours === 1 ? '' : 's'}` : `${maxDurationMinutes} minutes`;
    return { ok: false, error: `Maximum booking duration is ${label}` };
  }

  if (!isTimeWithinWindow(userStart, venueWindow.startTime, venueWindow.endTime)) {
    return { ok: false, error: 'Start time must be within the venue service window' };
  }
  if (!isTimeWithinWindow(userEnd, venueWindow.startTime, venueWindow.endTime)) {
    return { ok: false, error: 'End time must be within the venue service window' };
  }

  const latestEnd = latestBookableEndTime(venueWindow);
  const userEndM = toServiceMinutes(userEnd, venueWindow);
  const latestEndM = toServiceMinutes(latestEnd, venueWindow);
  if (userEndM != null && latestEndM != null && userEndM > latestEndM) {
    return {
      ok: false,
      error: `Bookings must end by ${latestEnd}`,
    };
  }

  return { ok: true };
}

export function formatHHmmSast(instant, tz = DEFAULT_TIMEZONE) {
  if (!instant) return null;
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  return currentClockSast(d, tz);
}

export function resolveBookingWindowFromPayload(payload, existing, venueTable, bookingDate = new Date()) {
  const specs = existing?.userSpecs && typeof existing.userSpecs === 'object' ? existing.userSpecs : {};
  const windowStart =
    payload?.windowStart ||
    payload?.window_start ||
    existing?.windowStartTime ||
    specs.preferredTime ||
    specs.windowStartTime ||
    null;
  const windowEnd =
    payload?.windowEnd ||
    payload?.window_end ||
    existing?.windowEndTime ||
    specs.preferredEndTime ||
    specs.windowEndTime ||
    null;
  const dateRaw = payload?.bookingDate || existing?.bookingDate || specs.preferredDate || bookingDate;
  const bookingDateResolved = dateRaw instanceof Date ? dateRaw : new Date(dateRaw);
  return { bookingDate: bookingDateResolved, windowStart, windowEnd };
}

export function validateDayBookingWindow(table, payload, existing, bookingDate = new Date()) {
  if (!isDayVenueTable(table)) return { ok: true };
  const { windowStart, windowEnd, bookingDate: date } = resolveBookingWindowFromPayload(
    payload,
    existing,
    table,
    bookingDate,
  );
  if (!windowStart || !windowEnd) {
    return { ok: false, error: 'Select a start and end time for your booking' };
  }
  const tz = zoneFrom(table);
  const venueWindow = venueWindowForDate(table, date, tz);
  const maxHours =
    table?.venue?.maxBookingDurationHours ??
    table?.venue?.max_booking_duration_hours ??
    null;
  const maxDurationMinutes =
    maxHours != null && Number(maxHours) > 0 ? Number(maxHours) * 60 : null;
  const check = validateUserWindow(windowStart, windowEnd, venueWindow, new Date(), {
    maxDurationMinutes,
    tz,
  });
  if (!check.ok) return check;
  return { ok: true, bookingDate: date, windowStart, windowEnd, windowEndsAt: windowEndInstant(date, windowStart, windowEnd, tz) };
}

export function isDayVenueTable(table) {
  if (!table) return false;
  if (table.eventId) return false;
  const key = String(table.hostingTierKey || '');
  return key.startsWith('day:') || table.isCustomListing;
}

export async function getActiveDaySessions(venueTableId, bookingDate = new Date()) {
  const now = new Date();
  const venueTable = await prisma.venueTable.findUnique({ where: { id: venueTableId } });
  const rows = await prisma.hostedTable.findMany({
    where: {
      eventId: null,
      status: { in: ['ACTIVE', 'FULL'] },
      OR: [{ venueTableId }, ...(venueTable?.hostedTableId ? [{ id: venueTable.hostedTableId }] : [])],
    },
    include: {
      host: {
        select: {
          id: true,
          username: true,
          fullName: true,
          userProfile: { select: { username: true, avatarUrl: true } },
        },
      },
      members: {
        where: { status: 'GOING' },
        select: { id: true },
      },
    },
    orderBy: { eventTime: 'asc' },
  });
  const seen = new Set();
  return rows.filter((ht) => {
    if (seen.has(ht.id)) return false;
    seen.add(ht.id);
    return isDaySessionStillActive(ht, venueTable, now);
  });
}

function sessionWindowFromHosted(ht, venueTable, bookingDate) {
  const startTime = ht.eventTime ? String(ht.eventTime) : null;
  let endTime = null;
  if (ht.windowEndsAt) {
    endTime = formatHHmmSast(ht.windowEndsAt, zoneFrom(venueTable));
  } else if (venueTable) {
    const vw = venueWindowForDate(venueTable, bookingDate);
    endTime = vw?.endTime || null;
  }
  return { startTime, endTime };
}

export async function canHostInWindow(
  venueTableId,
  bookingDate,
  userStart,
  userEnd,
  { excludeHostedTableId = null, excludePaystackReference = null } = {},
) {
  const sessions = await getActiveDaySessions(venueTableId, bookingDate);
  const venueTable = await prisma.venueTable.findUnique({ where: { id: venueTableId } });
  for (const ht of sessions) {
    if (excludeHostedTableId && ht.id === excludeHostedTableId) continue;
    if (excludePaystackReference && ht.hostFeePaystackRef === excludePaystackReference) continue;
    const { startTime, endTime } = sessionWindowFromHosted(ht, venueTable, bookingDate);
    const vw = venueTable ? venueWindowForDate(venueTable, bookingDate) : null;
    if (startTime && endTime && windowsOverlap(userStart, userEnd, startTime, endTime, vw)) {
      return { ok: false, error: 'This table is already hosted during the selected time' };
    }
  }
  return { ok: true };
}

export function buildHostedTablePayload(ht, { goingCount = null, requestedGuestCount = null, tz = DEFAULT_TIMEZONE } = {}) {
  const going =
    goingCount != null
      ? Math.max(0, Number(goingCount) || 0)
      : Math.max(0, Number(ht.guestQuantity) - Number(ht.spotsRemaining));
  const capacity =
    requestedGuestCount != null && requestedGuestCount >= 1
      ? Math.round(requestedGuestCount)
      : Math.max(1, Number(ht.guestQuantity) || 1);
  const spotsRemaining = Math.max(0, capacity - going);

  return {
    id: ht.id,
    tableName: ht.tableName,
    isPublic: ht.isPublic,
    hasJoiningFee: ht.hasJoiningFee,
    joiningFee: ht.joiningFee,
    guestCapacity: capacity,
    spotsRemaining,
    windowStartTime: ht.eventTime ? String(ht.eventTime) : null,
    windowEndTime: ht.windowEndsAt
      ? formatHHmmSast(ht.windowEndsAt, tz)
      : null,
    isCustomTable: Boolean(requestedGuestCount),
    host: {
      id: ht.host?.id,
      username: ht.host?.userProfile?.username || ht.host?.username,
      fullName: ht.host?.fullName,
      avatarUrl: ht.host?.userProfile?.avatarUrl || null,
    },
  };
}

export async function buildOccupancyForSlot(venueTable, bookingDate = new Date()) {
  const sessions = await getActiveDaySessions(venueTable.id, bookingDate);
  const occupancy = [];
  for (const ht of sessions) {
    const { startTime, endTime } = sessionWindowFromHosted(ht, venueTable, bookingDate);
    if (!startTime || !endTime) continue;
    const goingCount = ht.members?.length ?? Math.max(0, ht.guestQuantity - ht.spotsRemaining);
    occupancy.push({
      startTime,
      endTime,
      hostedTableId: ht.id,
      hostName:
        ht.host?.userProfile?.username || ht.host?.username || ht.host?.fullName || null,
      hostedTable: buildHostedTablePayload(ht, { goingCount, tz: zoneFrom(venueTable) }),
      spotsRemaining: ht.spotsRemaining,
    });
  }
  return occupancy;
}

export function computeLegacyWindowEndsAt(hostedTable, venueTable) {
  if (hostedTable?.windowEndsAt) {
    const d = hostedTable.windowEndsAt instanceof Date ? hostedTable.windowEndsAt : new Date(hostedTable.windowEndsAt);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (!venueTable) return null;
  const bookingDate = hostedTable?.eventDate || new Date();
  const tz = zoneFrom(venueTable);
  const vw = venueWindowForDate(venueTable, bookingDate, tz);
  if (!vw) return null;
  return windowEndInstant(bookingDate, vw.startTime, vw.endTime, tz);
}

export function resolveBookingWindowFromMember(member, venueTable, bookingDate = new Date()) {
  const specs = member?.userSpecs && typeof member.userSpecs === 'object' ? member.userSpecs : {};
  const startTime =
    member?.windowStartTime ||
    specs.preferredTime ||
    specs.windowStartTime ||
    venueWindowForDate(venueTable, bookingDate)?.startTime;
  const endTime =
    member?.windowEndTime ||
    specs.preferredEndTime ||
    specs.windowEndTime ||
    venueWindowForDate(venueTable, bookingDate)?.endTime;
  const date = member?.bookingDate || specs.preferredDate || bookingDate;
  return { bookingDate: date, windowStartTime: startTime, windowEndTime: endTime };
}

export function venueWindowFromTables(venueTables, refDate = new Date()) {
  for (const t of venueTables) {
    const w = venueWindowForDate(t, refDate);
    if (w) return w;
  }
  return null;
}

/** Match the host venueTableMember row for a specific day-booking hostedTable session. */
export function resolveHostMemberForHostedTable(hostedTable, hostMembers = []) {
  if (!hostedTable?.venueTableId) return null;
  const candidates = hostMembers.filter((m) => m.venueTableId === hostedTable.venueTableId);
  if (hostedTable.hostFeePaystackRef) {
    const byRef = candidates.find((m) => m.paystackReference === hostedTable.hostFeePaystackRef);
    if (byRef) return byRef;
  }
  const ymd = hostedTable.eventDate ? formatYmdSast(hostedTable.eventDate) : null;
  const start = hostedTable.eventTime ? String(hostedTable.eventTime) : null;
  if (ymd) {
    const byWindow = candidates.find((m) => {
      const bd = m.bookingDate ? formatYmdSast(m.bookingDate) : null;
      return bd === ymd && (!start || m.windowStartTime === start);
    });
    if (byWindow) return byWindow;
  }
  return null;
}

/** True when this specific hosted-table session (not just venueTableId) was refunded. */
export function isHostedTableSessionRefunded(hostedTable, {
  refundedMembers = [],
  refundedRequests = [],
  hostMembers = [],
} = {}) {
  if (!hostedTable?.venueTableId) return false;

  const members = refundedMembers.filter((m) => m.venueTableId === hostedTable.venueTableId);
  const requests = refundedRequests.filter((r) => r.venueTableId === hostedTable.venueTableId);

  const ref = hostedTable.hostFeePaystackRef ? String(hostedTable.hostFeePaystackRef) : null;
  if (ref) {
    if (members.some((m) => m.paystackReference === ref)) return true;
    if (requests.some((r) => r.paymentReference === ref)) return true;
  }

  if (resolveHostMemberForHostedTable(hostedTable, members)) return true;

  const matchedHost = resolveHostMemberForHostedTable(hostedTable, hostMembers);
  if (matchedHost?.id) {
    if (members.some((m) => m.id === matchedHost.id)) return true;
    if (requests.some((r) => r.venueTableMemberId === matchedHost.id)) return true;
  }

  return false;
}

export { serviceScheduleFromTable, MIN_WINDOW_MINUTES, END_BUFFER_MINUTES };
