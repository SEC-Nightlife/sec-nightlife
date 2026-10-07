import { parseWindowInstant, formatYmdSast, formatHHmmSast } from './dayBookingWindows.js';
import { DEFAULT_TIMEZONE, zoneOfHostedTable } from './timezone.js';

/**
 * Own-place (EXTERNAL_VENUE, no venue slot) end instant.
 * Prefer windowEndsAt, then eventEndDate+eventEndTime, else end of start day 23:59 (listing local time).
 * Does NOT use start + 24h.
 */
export function externalListingEndsAt(hostedRow) {
  if (!hostedRow) return null;

  if (hostedRow.windowEndsAt) {
    const end =
      hostedRow.windowEndsAt instanceof Date
        ? hostedRow.windowEndsAt
        : new Date(hostedRow.windowEndsAt);
    if (!Number.isNaN(end.getTime())) return end;
  }

  const tz = zoneOfHostedTable(hostedRow);
  const endDate = hostedRow.eventEndDate || hostedRow.eventDate;
  const endTime = hostedRow.eventEndTime || '23:59';
  if (endDate && endTime) {
    const fromParts = parseWindowInstant(endDate, endTime, tz);
    if (fromParts) return fromParts;
  }

  if (hostedRow.eventDate) {
    return parseWindowInstant(hostedRow.eventDate, '23:59', tz);
  }
  return null;
}

/** Validate and build schedule fields for create/patch of EXTERNAL_VENUE listings. */
export function buildExternalListingSchedule({
  eventDate,
  eventTime,
  eventEndDate,
  eventEndTime,
  now = new Date(),
  tz = DEFAULT_TIMEZONE,
}) {
  const start = parseWindowInstant(eventDate, eventTime, tz);
  if (!start || Number.isNaN(start.getTime())) {
    return { ok: false, error: 'Start date and time are invalid.' };
  }
  if (start.getTime() <= now.getTime()) {
    return { ok: false, error: 'Start date and time must be in the future.' };
  }

  const endDate = eventEndDate || eventDate;
  const endTime = eventEndTime || '23:59';
  if (!/^\d{2}:\d{2}$/.test(String(endTime))) {
    return { ok: false, error: 'End time must be HH:mm.' };
  }
  const end = parseWindowInstant(endDate, endTime, tz);
  if (!end || Number.isNaN(end.getTime())) {
    return { ok: false, error: 'End date and time are invalid.' };
  }
  if (end.getTime() <= start.getTime()) {
    return { ok: false, error: 'End must be after the start date and time.' };
  }

  return {
    ok: true,
    eventDate: eventDate instanceof Date ? eventDate : new Date(eventDate),
    eventTime: String(eventTime),
    eventEndDate: endDate instanceof Date ? endDate : new Date(endDate),
    eventEndTime: String(endTime),
    windowEndsAt: end,
    startAt: start,
  };
}

export function formatExternalEndForForm(hostedRow) {
  const tz = zoneOfHostedTable(hostedRow);
  const end = externalListingEndsAt(hostedRow);
  if (!end) {
    return {
      eventEndDate: hostedRow?.eventDate ? formatYmdSast(hostedRow.eventDate, tz) : '',
      eventEndTime: hostedRow?.eventEndTime || '23:59',
    };
  }
  return {
    eventEndDate: formatYmdSast(end, tz),
    eventEndTime: formatHHmmSast(end, tz),
  };
}
