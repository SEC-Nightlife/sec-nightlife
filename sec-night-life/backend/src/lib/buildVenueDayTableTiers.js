import { prisma } from './prisma.js';
import { isVenueTableBookableToday } from './serviceSchedule.js';
import {
  buildHostedTablePayload,
  buildOccupancyForSlot,
  buildAvailableGaps,
  canHostInWindow,
  normalizeBookingDateSast,
  venueWindowForDate,
  venueWindowFromTables,
  windowsOverlap,
} from './dayBookingWindows.js';
import { expireDayTableSessions } from './releaseDayTableSession.js';
import { zoneFrom } from './timezone.js';

/**
 * Build grouped table tier payloads for day bookings (VenueBook).
 * @param {string} venueId
 * @param {{ windowStart?: string, windowEnd?: string, bookingDate?: Date }} [options]
 */
export async function buildVenueDayTableTiers(venueId, options = {}) {
  const userWindowStart = options.windowStart || null;
  const userWindowEnd = options.windowEnd || null;

  await expireDayTableSessions({ now: new Date() }).catch((err) => {
    console.error('[buildVenueDayTableTiers] expireDayTableSessions failed:', err?.message || err);
  });

  const venue = await prisma.venue.findFirst({
    where: { id: venueId, deletedAt: null },
    select: { id: true, name: true, acceptsDayBookings: true, maxBookingDurationHours: true, timezone: true },
  });
  if (!venue) return null;
  const tz = zoneFrom(venue);
  const bookingDate = normalizeBookingDateSast(options.bookingDate || new Date(), tz);

  const { repairLegacyDayVenueTables } = await import('./syncDayVenueTables.js');
  await repairLegacyDayVenueTables(venueId);

  const venueTables = await prisma.venueTable.findMany({
    where: {
      venueId,
      eventId: null,
      isActive: true,
      isCustomListing: false,
      hostingTierKey: { startsWith: 'day:' },
    },
    orderBy: { hostingTierKey: 'asc' },
  });
  // VenueTable has no zone column; tag rows so schedule helpers use the venue's zone.
  for (const vt of venueTables) vt.timezone = tz;

  const bookableToday = venueTables.filter((vt) => isVenueTableBookableToday(vt, bookingDate));
  const venueWindow = venueWindowFromTables(bookableToday, bookingDate);

  const tierMap = new Map();

  for (const vt of bookableToday) {
    const parts = String(vt.hostingTierKey || '').split(':');
    const tierIdx = Number(parts[1]);
    const tierKey = Number.isFinite(tierIdx) ? `day:${tierIdx}` : `day:${vt.tierLabel || vt.id}`;

    if (!tierMap.has(tierKey)) {
      tierMap.set(tierKey, {
        tierKey,
        tierName: vt.tierLabel || vt.tableName,
        category: vt.tableCategory === 'vip' ? 'vip' : 'general',
        tierIndex: Number.isFinite(tierIdx) ? tierIdx : 0,
        minSpendJoin: Number(vt.minimumSpend) || 0,
        minSpendHost: Number(vt.hostMinimumSpend ?? vt.minimumSpend) || 0,
        hostBookingFeeZar: Number(vt.hostTableFeeZar) || 0,
        joinBookingFeeZar: Number(vt.bookingFeeZar) || 0,
        maxGuestsPerTable: Number(vt.guestCapacity) || 6,
        slots: [],
      });
    }

    const tier = tierMap.get(tierKey);
    const occupancy = await buildOccupancyForSlot(vt, bookingDate);
    const slotWindow = venueWindowForDate(vt, bookingDate) || venueWindow;
    const availableGaps = slotWindow ? buildAvailableGaps(slotWindow, occupancy, { now: new Date(), tz }) : [];

    let canHost = availableGaps.length > 0;
    let joinableSessions = occupancy.filter((o) => o.spotsRemaining > 0);

    if (userWindowStart && userWindowEnd) {
      const hostCheck = await canHostInWindow(vt.id, bookingDate, userWindowStart, userWindowEnd);
      canHost = hostCheck.ok;
      joinableSessions = occupancy.filter(
        (o) =>
          o.spotsRemaining > 0 &&
          windowsOverlap(userWindowStart, userWindowEnd, o.startTime, o.endTime, slotWindow),
      );
    }

    const primaryJoin = joinableSessions[0]?.hostedTable || null;
    const isHosted = occupancy.length > 0;

    tier.slots.push({
      venueTableId: vt.id,
      tableName: vt.tableName,
      spotsRemaining: primaryJoin?.spotsRemaining ?? (Number(vt.guestCapacity) || 6),
      isHosted,
      canHost,
      hostedTable: primaryJoin,
      occupancy,
      joinableSessions: joinableSessions.map((o) => ({
        hostedTableId: o.hostedTableId,
        startTime: o.startTime,
        endTime: o.endTime,
        hostedTable: o.hostedTable,
      })),
    });
  }

  const tiers = [...tierMap.values()]
    .map((tier) => {
      const bookableSlots = tier.slots.filter((s) => {
        if (s.canHost) return true;
        if ((s.joinableSessions || []).some((j) => (j.hostedTable?.spotsRemaining ?? 0) > 0)) return true;
        if (!s.isHosted && s.spotsRemaining > 0) return true;
        return false;
      });
      return { ...tier, slots: bookableSlots };
    })
    .filter((tier) => tier.slots.length > 0)
    .map((tier) => {
    let tablesOpenForHost = 0;
    let tablesOpenForJoin = 0;
    let totalSpotsRemaining = 0;

    if (userWindowStart && userWindowEnd) {
      for (const s of tier.slots) {
        if (s.canHost) tablesOpenForHost += 1;
        tablesOpenForJoin += s.joinableSessions?.length || 0;
        totalSpotsRemaining += s.joinableSessions?.reduce(
          (sum, j) => sum + (j.hostedTable?.spotsRemaining || 0),
          0,
        ) || 0;
        if (s.canHost) totalSpotsRemaining += tier.maxGuestsPerTable;
      }
    } else {
      tablesOpenForHost = tier.slots.filter((s) => s.canHost).length;
      const hostedJoinable = tier.slots.reduce(
        (sum, s) => sum + (s.joinableSessions?.length || 0),
        0,
      );
      tablesOpenForJoin = tablesOpenForHost + hostedJoinable;
      totalSpotsRemaining = tier.slots.reduce((sum, s) => {
        const joinSpots = (s.joinableSessions || []).reduce(
          (n, j) => n + (j.hostedTable?.spotsRemaining || 0),
          0,
        );
        return sum + joinSpots + (s.canHost ? tier.maxGuestsPerTable : 0);
      }, 0);
    }

    return {
      ...tier,
      minSpend: tier.minSpendJoin,
      tablesOpenForHost,
      tablesOpenForJoin,
      totalSpotsRemaining,
      allowsCustomRequests: false,
    };
  });

  const customRow = await prisma.venueTable.findFirst({
    where: {
      venueId,
      eventId: null,
      isCustomListing: true,
      isActive: true,
    },
    select: { id: true, serviceSchedule: true, startTime: true, endTime: true },
  });

  return {
    venue: {
      id: venue.id,
      name: venue.name,
      max_booking_duration_hours: venue.maxBookingDurationHours,
    },
    venueWindow,
    tiers,
    customListingId: customRow?.id ?? null,
    allowsCustomRequests: Boolean(customRow?.id),
  };
}
