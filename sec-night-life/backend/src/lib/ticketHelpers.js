import crypto from 'crypto';
import {
  dayEndsAtFromVenueTableSchedule,
  dayStartsAtFromVenueTableSchedule,
  serviceScheduleFromTable,
} from './serviceSchedule.js';
import { windowEndInstant, parseWindowInstant } from './dayBookingWindows.js';
import { externalListingEndsAt } from './externalListingSchedule.js';
import {
  DEFAULT_TIMEZONE,
  calendarParts,
  zoneAbbreviation,
  zoneFrom,
  zoneOfHostedTable,
  zonedDateTimeToUtc,
  zonedWallTimeToUtc,
} from './timezone.js';

const MS_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve ticket visible_until for storage.
 * Prefer an explicit end (caller visibleUntil / eventEndsAt) over start+24h.
 * Day venue tables (no event) must keep the caller's buffered visibleUntil.
 */
export function resolveTicketVisibleUntil({
  venueTableId = null,
  eventId = null,
  visibleUntil = null,
  eventStartsAt = null,
  eventEndsAt = null,
}) {
  const vis =
    visibleUntil != null
      ? visibleUntil instanceof Date
        ? visibleUntil
        : new Date(visibleUntil)
      : null;
  const validVis = vis && !Number.isNaN(vis.getTime()) ? vis : null;
  const ends =
    eventEndsAt != null
      ? eventEndsAt instanceof Date
        ? eventEndsAt
        : new Date(eventEndsAt)
      : null;
  const validEnds = ends && !Number.isNaN(ends.getTime()) ? ends : null;

  if (venueTableId && !eventId) {
    if (validVis) return validVis;
    if (validEnds) return validEnds;
    if (eventStartsAt && !Number.isNaN(new Date(eventStartsAt).getTime())) {
      return visibleUntilFromEventStartsAt(eventStartsAt);
    }
    return new Date(Date.now() + MS_DAY);
  }

  // Explicit listing/event end wins (own-place tables, venue events with endsAt).
  if (validEnds) return validEnds;
  // Caller-computed visibleUntil (e.g. windowEndsAt / externalListingEndsAt) before start+24h.
  if (validVis) return validVis;
  if (eventStartsAt && !Number.isNaN(new Date(eventStartsAt).getTime())) {
    return visibleUntilFromEventStartsAt(eventStartsAt);
  }
  return validVis;
}

/** Title for venue-table checkout tickets (host vs guest). */
export function venueTableTicketTitle(tableName, eventTitle, isHost) {
  if (isHost) return `${tableName} — Host pass`;
  if (eventTitle) return `${tableName} — ${eventTitle}`;
  return tableName;
}

export function generateQrToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** Assume event ends at 04:00 venue time after `date` if no better signal. */
export function visibleUntilAfterEventDate(eventDate, tz = DEFAULT_TIMEZONE) {
  const d = eventDate instanceof Date ? eventDate : new Date(eventDate);
  const cal = calendarParts(d, tz);
  if (!cal) return new Date(Date.now() + MS_DAY);
  let end = zonedWallTimeToUtc(cal.year, cal.month, cal.day, 4, 0, tz);
  if (end < d) {
    const next = new Date(Date.UTC(cal.year, cal.month - 1, cal.day + 1));
    end = zonedWallTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 4, 0, tz);
  }
  return new Date(end.getTime() + MS_DAY);
}

export function visibleUntilAfterParty(party) {
  const end = party?.endTime instanceof Date ? party.endTime : new Date(party?.endTime);
  return new Date(end.getTime() + MS_DAY);
}

export function visibleUntilAfterHostedTable(t) {
  if (t?.tableType === 'EXTERNAL_VENUE' && !t?.venueTableId) {
    const externalEnd = externalListingEndsAt(t);
    if (externalEnd) return externalEnd;
  }
  if (t?.windowEndsAt) {
    const w = t.windowEndsAt instanceof Date ? t.windowEndsAt : new Date(t.windowEndsAt);
    if (!Number.isNaN(w.getTime())) return w;
  }
  const start = eventStartsAtFromHostedTable(t) || new Date();
  return new Date(start.getTime() + 8 * 60 * 60 * 1000 + MS_DAY);
}

export function visibleUntilForVenueTableMember(table, event) {
  const evDate = event?.date ? (event.date instanceof Date ? event.date : new Date(event.date)) : new Date();
  return visibleUntilAfterEventDate(evDate, zoneFrom(event, table));
}

/** Combine day listing service end date + end time; fallback weekly schedule or start date + 24h. */
/** Combine day listing service end date + end time (venue wall time); fallback weekly schedule. */
export function dayEndsAtFromVenueTable(table, refDate = new Date()) {
  const fromSchedule = dayEndsAtFromVenueTableSchedule(table, refDate);
  if (fromSchedule) return fromSchedule;
  if (!table) return null;
  const endDateRaw = table.serviceEndDate ?? table.service_end_date ?? table.serviceDate ?? table.service_date;
  if (!endDateRaw) return null;
  const d = endDateRaw instanceof Date ? new Date(endDateRaw) : new Date(endDateRaw);
  if (Number.isNaN(d.getTime())) return null;
  const tz = zoneFrom(table);
  const endTime = table.endTime ?? table.end_time;
  const end = typeof endTime === 'string' ? zonedDateTimeToUtc(d, endTime, tz) : null;
  if (end) return end;
  const lastMinute = zonedDateTimeToUtc(d, '23:59', tz);
  return lastMinute ? new Date(lastMinute.getTime() + 59_999) : null;
}

export function dayStartsAtFromVenueTable(table, refDate = new Date()) {
  const fromSchedule = dayStartsAtFromVenueTableSchedule(table, refDate);
  if (fromSchedule) return fromSchedule;
  if (!table) return null;
  const startDateRaw = table.serviceDate ?? table.service_date;
  if (!startDateRaw) return null;
  const d = startDateRaw instanceof Date ? new Date(startDateRaw) : new Date(startDateRaw);
  if (Number.isNaN(d.getTime())) return null;
  const startTime = table.startTime ?? table.start_time;
  const start = typeof startTime === 'string' ? zonedDateTimeToUtc(d, startTime, zoneFrom(table)) : null;
  return start || d;
}

/** Day-booking host/join tickets: event start is the booked window start, not venue default open. */
export function dayEventStartsAtFromMember(member, table, refDate = new Date()) {
  const tz = zoneFrom(table);
  if (member?.windowStartTime && member?.bookingDate) {
    const instant = parseWindowInstant(member.bookingDate, member.windowStartTime, tz);
    if (instant) return instant;
  }
  if (member?.windowStartTime) {
    const instant = parseWindowInstant(refDate, member.windowStartTime, tz);
    if (instant) return instant;
  }
  return dayStartsAtFromVenueTable(table, refDate);
}

/** "Sat 11 Oct, 02:00 (SAST)" in the venue's time zone (name kept for existing callers). */
export function formatVisibleUntilSast(date, tz = DEFAULT_TIMEZONE) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const formatted = new Intl.DateTimeFormat('en-ZA', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${formatted} (${zoneAbbreviation(d, tz)})`;
}

/** Ticket QR expiry for day venue table bookings — ends at booked window end (not +24h). */
export function visibleUntilForDayVenueTable(table, refDate = new Date(), { windowEndsAt, windowEndTime, bookingDate, windowStartTime } = {}) {
  if (windowEndsAt) {
    const d = windowEndsAt instanceof Date ? windowEndsAt : new Date(windowEndsAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (windowStartTime && windowEndTime && bookingDate) {
    const end = windowEndInstant(bookingDate, windowStartTime, windowEndTime, zoneFrom(table));
    if (end) return end;
  }
  const schedule = serviceScheduleFromTable(table);
  if (schedule.length) {
    const endsAt = dayEndsAtFromVenueTableSchedule(table, refDate);
    if (endsAt) return endsAt;
  }
  const endsAt = dayEndsAtFromVenueTable(table, refDate);
  if (endsAt) return endsAt;
  const startsAt = dayStartsAtFromVenueTable(table, refDate);
  if (startsAt) return new Date(startsAt.getTime() + MS_DAY);
  return visibleUntilAfterEventDate(new Date(), zoneFrom(table));
}

/**
 * When the ticketed experience starts, for expiry = start + 24h.
 * `startTime` is venue wall time in the event's zone (default SAST), not UTC.
 */
export function eventStartsAtFromEvent(event) {
  if (!event?.date) return null;
  const d = event.date instanceof Date ? new Date(event.date) : new Date(event.date);
  if (Number.isNaN(d.getTime())) return null;
  const st = event.startTime ?? event.start_time;
  if (st && typeof st === 'string') {
    const instant = zonedDateTimeToUtc(d, st, zoneFrom(event));
    if (instant) return instant;
  }
  return d;
}

/** Hosted table calendar + clock (venue / listing wall time). */
export function eventStartsAtFromHostedTable(t) {
  if (!t?.eventDate) return null;
  const d = t.eventDate instanceof Date ? new Date(t.eventDate) : new Date(t.eventDate);
  if (Number.isNaN(d.getTime())) return null;
  if (t.eventTime) {
    const instant = zonedDateTimeToUtc(d, String(t.eventTime), zoneOfHostedTable(t));
    if (instant) return instant;
  }
  return d;
}

/** Ticket scan + Profile “active” until this instant (legacy: start + 24h). */
export function visibleUntilFromEventStartsAt(eventStartsAt) {
  if (!eventStartsAt) return null;
  const s = eventStartsAt instanceof Date ? eventStartsAt : new Date(eventStartsAt);
  return new Date(s.getTime() + MS_DAY);
}

/**
 * Canonical end instant for an SEC Event row (Prisma `endsAt` or legacy start + 24h).
 * Accepts camelCase or snake_case from JSON/API.
 */
export function eventEndsAtFromEvent(event) {
  if (!event) return null;
  const raw = event.endsAt ?? event.ends_at;
  if (raw) {
    const e = raw instanceof Date ? raw : new Date(raw);
    return Number.isNaN(e.getTime()) ? null : e;
  }
  const start = eventStartsAtFromEvent(event);
  if (start) return new Date(start.getTime() + MS_DAY);
  if (event?.date) return visibleUntilAfterEventDate(event.date, zoneFrom(event));
  return null;
}

/** True when the event's canonical end is in the past. */
export function eventHasEnded(event, now = new Date()) {
  const endAt = eventEndsAtFromEvent(event);
  return Boolean(endAt && endAt.getTime() < (now instanceof Date ? now : new Date(now)).getTime());
}

/** Expiry for API + UI (legacy rows use visible_until only). */
export function ticketExpiresAtFromRow(row) {
  const visRaw = row.visibleUntil ?? row.visible_until;
  if (visRaw) {
    const v = visRaw instanceof Date ? visRaw : new Date(visRaw);
    if (!Number.isNaN(v.getTime())) return v;
  }
  if (row.eventStartsAt || row.event_starts_at) {
    const s = row.eventStartsAt ?? row.event_starts_at;
    const st = s instanceof Date ? s : new Date(s);
    return new Date(st.getTime() + MS_DAY);
  }
  return visRaw ? new Date(visRaw) : new Date();
}

export function holderDisplayNameFromUser(user) {
  if (!user) return 'Guest';
  return (
    user.fullName ||
    user.full_name ||
    user.userProfile?.username ||
    user.username ||
    'Guest'
  );
}

export function formatSpecsFromTable(table) {
  if (!table) return null;
  const parts = [];
  const cat = table.tableCategory ?? table.table_category;
  if (cat) parts.push(String(cat).replace(/^./, (c) => c.toUpperCase()));
  if (table.maxGuests != null) parts.push(`max ${table.maxGuests} guests`);
  if (table.minSpend != null && Number(table.minSpend) > 0) parts.push(`min spend R${Number(table.minSpend)}`);
  if (table.joiningFee != null && Number(table.joiningFee) > 0) parts.push(`join fee R${Number(table.joiningFee)}`);
  return parts.length ? parts.join(' · ') : null;
}

export function formatSpecsFromVenueTable(vt) {
  if (!vt) return null;
  const parts = [];
  if (vt.tableName) parts.push(vt.tableName);
  if (vt.guestCapacity != null) parts.push(`capacity ${vt.guestCapacity}`);
  if (vt.minimumSpend != null) parts.push(`min spend R${Number(vt.minimumSpend)}`);
  return parts.join(' · ');
}

export function formatSpecsFromHostedTable(ht, members) {
  if (!ht) return null;
  const parts = [];
  if (ht.hostingCategory) {
    const tierName =
      ht.tierIncludedItems && typeof ht.tierIncludedItems === 'object' && ht.tierIncludedItems.tier_name
        ? ht.tierIncludedItems.tier_name
        : null;
    parts.push(tierName || ht.hostingCategory);
  }
  if (ht.guestQuantity != null) parts.push(`up to ${ht.guestQuantity} guests`);
  if (ht.tierMinSpend != null && Number(ht.tierMinSpend) > 0) {
    parts.push(`min spend R${Number(ht.tierMinSpend)}`);
  }
  if (ht.menuSpendTotal != null && Number(ht.menuSpendTotal) > 0) {
    parts.push(`table menu R${Number(ht.menuSpendTotal)}`);
  }
  if (ht.hasJoiningFee && ht.joiningFee) parts.push(`join R${Number(ht.joiningFee)}`);
  const hostMem = Array.isArray(members)
    ? members.find((m) => m.userId === ht.hostUserId)
    : null;
  const hostLines = hostMem?.selectedMenuItems;
  if (Array.isArray(hostLines) && hostLines.length) {
    const brief = hostLines
      .slice(0, 3)
      .map((l) => `${l.quantity}× ${l.name}`)
      .join(', ');
    parts.push(brief);
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Hide older guest passes for the same hosted table so Profile → Tickets shows one current QR.
 */
export async function hideSupersededHostedTableGuestTickets(db, { userId, hostedTableId, excludeTicketId = null }) {
  if (!userId || !hostedTableId) return { hidden: 0 };
  const now = new Date();
  const result = await db.ticket.updateMany({
    where: {
      userId: String(userId),
      hostedTableId: String(hostedTableId),
      kind: 'HOSTED_TABLE_JOIN',
      hiddenFromHistoryAt: null,
      ...(excludeTicketId ? { id: { not: String(excludeTicketId) } } : {}),
    },
    data: { hiddenFromHistoryAt: now },
  });
  return { hidden: result.count };
}

/**
 * Hide older guest passes for the same venue table (menu top-ups, re-joins).
 */
export async function hideSupersededVenueTableGuestTickets(db, { userId, venueTableId, excludeTicketId = null }) {
  if (!userId || !venueTableId) return { hidden: 0 };
  const now = new Date();
  const result = await db.ticket.updateMany({
    where: {
      userId: String(userId),
      venueTableId: String(venueTableId),
      kind: 'VENUE_TABLE_JOIN',
      hiddenFromHistoryAt: null,
      ...(excludeTicketId ? { id: { not: String(excludeTicketId) } } : {}),
    },
    data: { hiddenFromHistoryAt: now },
  });
  return { hidden: result.count };
}

/**
 * @deprecated Do not overwrite all guest join tickets with table-wide menu text.
 * Menu orders get their own ticket per payment (see payments HOSTED_TABLE_MENU).
 */
export async function refreshHostedTableTickets(prisma, hostedTableId) {
  const ht = await prisma.hostedTable.findUnique({
    where: { id: String(hostedTableId) },
    include: { members: true },
  });
  if (!ht) return;
  const hostMem = ht.members?.find((m) => m.userId === ht.hostUserId);
  if (!hostMem) return;
  const summary = formatSpecsFromHostedTable(ht, [hostMem]);
  if (!summary) return;
  await prisma.ticket.updateMany({
    where: {
      hostedTableId: ht.id,
      userId: ht.hostUserId,
      kind: 'TABLE_HOST_FEE',
    },
    data: { tableSpecsSummary: summary },
  });
}
