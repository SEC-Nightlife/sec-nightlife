import { bookingDateStartSast, formatYmdSast } from './dayBookingWindows.js';
import { zoneFrom } from './timezone.js';

function sessionDateYmd(venueTable) {
  if (!venueTable?.tableSessionDate) return null;
  const d =
    venueTable.tableSessionDate instanceof Date
      ? venueTable.tableSessionDate
      : new Date(venueTable.tableSessionDate);
  if (Number.isNaN(d.getTime())) return null;
  return formatYmdSast(d, zoneFrom(venueTable));
}

/** Effective session number for today (venue local day). Resets to 1 when stored date is not today. */
export function resolveDailySessionNumber(venueTable, now = new Date()) {
  const todayYmd = formatYmdSast(now, zoneFrom(venueTable));
  const storedYmd = sessionDateYmd(venueTable);
  if (!storedYmd || storedYmd !== todayYmd) return 1;
  return Number(venueTable.tableSessionNumber) || 1;
}

/** Bump session after a release/reset; first bump of a new local day becomes session 2. */
export function bumpDailySessionNumber(venueTable, now = new Date()) {
  const tz = zoneFrom(venueTable);
  const todayStart = bookingDateStartSast(now, tz);
  const todayYmd = formatYmdSast(now, tz);
  const storedYmd = sessionDateYmd(venueTable);

  if (!storedYmd || storedYmd !== todayYmd) {
    return { tableSessionNumber: 2, tableSessionDate: todayStart };
  }

  return {
    tableSessionNumber: (Number(venueTable.tableSessionNumber) || 1) + 1,
    tableSessionDate: todayStart,
  };
}

/** Stamp today's date when a host starts without incrementing the session counter. */
export function stampDailySessionOnHost(venueTable, now = new Date()) {
  const todayStart = bookingDateStartSast(now, zoneFrom(venueTable));
  const sessionNumber = resolveDailySessionNumber(venueTable, now);
  return {
    tableSessionNumber: sessionNumber,
    tableSessionDate: todayStart,
  };
}
