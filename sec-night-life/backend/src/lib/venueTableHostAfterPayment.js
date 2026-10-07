import { prisma } from './prisma.js';
import { normalizeHostingConfig } from './hostingConfig.js';
import { splitPlatformGross } from './platformSplit.js';
import { logger } from './logger.js';
import {
  canHostInWindow,
  normalizeBookingDateSast,
  resolveBookingWindowFromMember,
  windowEndInstant,
} from './dayBookingWindows.js';
import { stampDailySessionOnHost } from './dailyTableSession.js';

function parseHostingTierKey(key) {
  if (!key || typeof key !== 'string') return { category: 'GENERAL', tierIndex: 0 };
  const parts = key.split(':');
  if (parts[0] === 'day') {
    const tierIndex = Number(parts[1]);
    return {
      category: 'GENERAL',
      tierIndex: Number.isFinite(tierIndex) ? tierIndex : 0,
    };
  }
  const cat = parts[0] === 'vip' ? 'VIP' : 'GENERAL';
  const tierIndex = Number(parts[1]);
  return {
    category: cat,
    tierIndex: Number.isFinite(tierIndex) ? tierIndex : 0,
  };
}

export function parseGuestCountFromSpecs(specs) {
  if (!specs || typeof specs !== 'object' || Array.isArray(specs)) return null;
  const n = Number(specs.guestCount);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(500, Math.round(n));
}

/** Custom listings use a placeholder capacity — use the host's requested guest count instead. */
export function resolveCustomHostGuestQuantity(venueTable, memberOrSpecs) {
  const fallback = Math.max(1, Number(venueTable?.guestCapacity) || 1);
  if (!venueTable?.isCustomListing) return fallback;
  const specs =
    memberOrSpecs?.userSpecs && typeof memberOrSpecs.userSpecs === 'object'
      ? memberOrSpecs.userSpecs
      : memberOrSpecs;
  return parseGuestCountFromSpecs(specs) ?? fallback;
}

function resolveCustomHostMinSpend(venueTable, memberOrSpecs) {
  const fallback = Number(venueTable?.minimumSpend) || 0;
  if (!venueTable?.isCustomListing) return fallback;
  const specs =
    memberOrSpecs?.userSpecs && typeof memberOrSpecs.userSpecs === 'object'
      ? memberOrSpecs.userSpecs
      : memberOrSpecs;
  if (specs?.proposedMinimumSpend == null) return fallback;
  const n = Number(specs.proposedMinimumSpend);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function createHostedTableFromVenueSlot({
  tx,
  venueTable,
  userId,
  paystackReference,
  amountTotal,
  selectedMenuItems,
  settlementMode,
  hostMember,
  eventContext,
  venueContext,
}) {
  const { category, tierIndex } = parseHostingTierKey(venueTable.hostingTierKey);
  const guestQty = resolveCustomHostGuestQuantity(venueTable, hostMember);
  const minSpend = resolveCustomHostMinSpend(venueTable, hostMember);
  const menuSpend = Number(amountTotal) - Number(venueTable.hostTableFeeZar || 0);

  let tierName = venueTable.tierLabel || venueTable.tableName;
  let eventDate = venueTable.serviceDate || normalizeBookingDateSast(new Date());
  let eventTime = venueTable.startTime ? String(venueTable.startTime) : '20:00';
  let venueName = 'Venue';
  let venueAddress = null;
  let eventId = null;
  let locationCity = null;
  let locationCountry = null;
  let locationLat = null;
  let locationLng = null;

  const windowFromMember = hostMember ? resolveBookingWindowFromMember(hostMember, venueTable) : null;

  if (eventContext) {
    const hosting = normalizeHostingConfig(eventContext.hostingConfig);
    const catKey = category === 'VIP' ? 'vip' : 'general';
    const tierDef = hosting[catKey]?.tiers?.[tierIndex] || {};
    tierName = tierDef.tier_name || tierName;
    eventDate = eventContext.date;
    eventTime = eventContext.startTime ? String(eventContext.startTime) : eventTime;
    venueName = eventContext.venue?.name || venueName;
    venueAddress = eventContext.venue?.address || eventContext.city || null;
    eventId = eventContext.id;
    locationCity = eventContext.city || eventContext.venue?.city || null;
    locationCountry = eventContext.countryCode || eventContext.venue?.countryCode || null;
    locationLat = eventContext.venue?.latitude ?? null;
    locationLng = eventContext.venue?.longitude ?? null;
  } else if (venueContext) {
    venueName = venueContext.name || venueName;
    venueAddress = venueContext.address || venueContext.city || null;
    locationCity = venueContext.city || null;
    locationCountry = venueContext.countryCode || null;
    locationLat = venueContext.latitude ?? null;
    locationLng = venueContext.longitude ?? null;
    eventDate = normalizeBookingDateSast(windowFromMember?.bookingDate || new Date());
    if (windowFromMember?.windowStartTime) eventTime = String(windowFromMember.windowStartTime);
  }

  const windowEndsAt =
    windowFromMember?.windowStartTime && windowFromMember?.windowEndTime
      ? windowEndInstant(
          normalizeBookingDateSast(windowFromMember.bookingDate || eventDate),
          windowFromMember.windowStartTime,
          windowFromMember.windowEndTime,
        )
      : null;

  const hosted = await tx.hostedTable.create({
    data: {
      hostUserId: userId,
      tableType: 'IN_APP_EVENT',
      tableName: venueTable.tableName,
      tableDescription: venueTable.description,
      eventType: 'CLUB_TABLE',
      eventId,
      venueName,
      venueAddress,
      city: locationCity,
      countryCode: locationCountry,
      latitude: locationLat,
      longitude: locationLng,
      eventDate,
      eventTime,
      venueTableId: eventId ? null : venueTable.id,
      windowEndsAt,
      guestQuantity: guestQty,
      spotsRemaining: Math.max(0, guestQty - 1),
      hostingCategory: category,
      hostingTierIndex: tierIndex,
      tierMaxGuests: guestQty,
      tierMinSpend: minSpend,
      menuSpendTotal: Math.max(0, menuSpend),
      tierIncludedItems: {
        tier_name: tierName,
        items: Array.isArray(venueTable.includedItems) ? venueTable.includedItems : [],
      },
      isPublic: true,
      hasJoiningFee: false,
      status: 'ACTIVE',
      hostFeePaystackRef: paystackReference,
      members: {
        create: [
          {
            userId,
            status: 'GOING',
            selectedMenuItems: selectedMenuItems || undefined,
          },
        ],
      },
      groupChat: {
        create: {
          name: venueTable.tableName,
          members: { create: [{ userId }] },
        },
      },
    },
    include: { groupChat: true },
  });

  await tx.venueTable.update({
    where: { id: venueTable.id },
    data: {
      hostedTableId: hosted.id,
      hostUserId: userId,
      ...(eventId ? {} : stampDailySessionOnHost(venueTable, new Date())),
    },
  });

  if (eventId) {
    await tx.eventVenueTableBooking.create({
      data: {
        venueId: venueTable.venueId,
        eventId,
        hostedTableId: hosted.id,
        userId,
        role: 'HOST',
        paystackReference,
        amountTotal,
        bookingFeeZar: Number(venueTable.hostTableFeeZar || 0),
        minimumSpendZar: minSpend,
        platformFeeZar: splitPlatformGross(amountTotal).secAmount,
        settlementMode: settlementMode || 'PREPAY_MENU',
        selectedMenuItems: selectedMenuItems || undefined,
        hostingTierName: tierName,
        hostingCategory: category,
      },
    });
  }

  return hosted;
}

/**
 * After a venue-table host checkout payment, create HostedTable and link the slot.
 * @returns {{ ok: boolean, hostedTable?: object, error?: string }}
 */
export async function ensureHostedTableFromVenueHostPayment({
  tx,
  venueTable,
  userId,
  paystackReference,
  amountTotal,
  selectedMenuItems,
  settlementMode,
  hostMember = null,
}) {
  if (!venueTable?.id || !userId || !paystackReference) {
    return { ok: false, error: 'missing_host_context' };
  }

  const existingByRef = await tx.hostedTable.findFirst({
    where: { hostFeePaystackRef: paystackReference },
  });
  if (existingByRef) {
    if (!venueTable.hostedTableId || venueTable.hostedTableId !== existingByRef.id) {
      await tx.venueTable.update({
        where: { id: venueTable.id },
        data: { hostedTableId: existingByRef.id, hostUserId: userId },
      });
    }
    return { ok: true, hostedTable: existingByRef };
  }

  if (venueTable.hostedTableId) {
    const linked = await tx.hostedTable.findUnique({ where: { id: venueTable.hostedTableId } });
    if (linked) {
      return { ok: true, hostedTable: linked };
    }
  }

  const isDay =
    !venueTable?.eventId &&
    (String(venueTable?.hostingTierKey || '').startsWith('day:') || venueTable?.isCustomListing);

  let member = hostMember;
  if (!member && userId && venueTable.id) {
    member = await tx.venueTableMember.findUnique({
      where: { venueTableId_userId: { venueTableId: venueTable.id, userId: String(userId) } },
    });
  }

  if (isDay && member && !paystackReference) {
    const windowFromMember = resolveBookingWindowFromMember(member, venueTable);
    if (windowFromMember.windowStartTime && windowFromMember.windowEndTime) {
      const hostCheck = await canHostInWindow(
        venueTable.id,
        windowFromMember.bookingDate,
        windowFromMember.windowStartTime,
        windowFromMember.windowEndTime,
        { excludePaystackReference: paystackReference },
      );
      if (!hostCheck.ok) {
        logger.warn('ensureHostedTableFromVenueHostPayment: window blocked', {
          venueTableId: venueTable.id,
          paystackReference,
          error: hostCheck.error,
        });
        return { ok: false, error: hostCheck.error || 'window_blocked' };
      }
    }
  } else if (isDay && member && paystackReference) {
    // Paid fulfillment: window was validated at checkout — do not re-block after Paystack success.
    logger.info('ensureHostedTableFromVenueHostPayment: skipping window re-check for paid reference', {
      venueTableId: venueTable.id,
      paystackReference,
    });
  } else if (venueTable?.hostedTableId) {
    return { ok: false, error: 'slot_already_hosted' };
  }

  try {
    if (venueTable.eventId) {
      const event = await tx.event.findFirst({
        where: { id: venueTable.eventId, deletedAt: null },
        include: { venue: true },
      });
      if (!event) {
        logger.warn('ensureHostedTableFromVenueHostPayment: event missing', { venueTableId: venueTable.id });
        return { ok: false, error: 'event_not_found' };
      }
      const hostedTable = await createHostedTableFromVenueSlot({
        tx,
        venueTable,
        userId,
        paystackReference,
        amountTotal,
        selectedMenuItems,
        settlementMode,
        hostMember: member,
        eventContext: event,
      });
      return { ok: true, hostedTable };
    }

    const venue = await tx.venue.findFirst({
      where: { id: venueTable.venueId, deletedAt: null },
    });
    if (!venue) {
      logger.warn('ensureHostedTableFromVenueHostPayment: venue missing', { venueTableId: venueTable.id });
      return { ok: false, error: 'venue_not_found' };
    }

    const hostedTable = await createHostedTableFromVenueSlot({
      tx,
      venueTable,
      userId,
      paystackReference,
      amountTotal,
      selectedMenuItems,
      settlementMode,
      hostMember: member,
      venueContext: venue,
    });
    return { ok: true, hostedTable };
  } catch (err) {
    logger.error('ensureHostedTableFromVenueHostPayment failed', {
      venueTableId: venueTable.id,
      paystackReference,
      err: err?.message,
    });
    return { ok: false, error: err?.message || 'host_create_failed' };
  }
}

/** Day-hosted tables link back to a venue table row — used for venue_id + QR expiry. */
export async function resolveLinkedVenueTableForHostedTable(db, hostedTableId) {
  if (!hostedTableId) return null;
  const hosted = await db.hostedTable.findUnique({
    where: { id: String(hostedTableId) },
    select: { venueTableId: true },
  });
  if (hosted?.venueTableId) {
    return db.venueTable.findFirst({
      where: { id: hosted.venueTableId },
      select: {
        id: true,
        venueId: true,
        serviceDate: true,
        serviceEndDate: true,
        serviceSchedule: true,
        startTime: true,
        endTime: true,
      },
    });
  }
  return db.venueTable.findFirst({
    where: { hostedTableId: String(hostedTableId) },
    select: {
      id: true,
      venueId: true,
      serviceDate: true,
      serviceEndDate: true,
      serviceSchedule: true,
      startTime: true,
      endTime: true,
    },
  });
}

/**
 * Resolve venue for a hosted table: event venue first, else linked day-booking venue slot.
 */
export async function resolveVenueContextForHostedTable(db, hostedTable) {
  let venueId = hostedTable?.event?.venueId || hostedTable?.event?.venue?.id || null;
  let venueOwnerUserId = hostedTable?.event?.venue?.ownerUserId || null;
  let linkedVenueTable = null;
  if (!venueId && hostedTable?.id) {
    linkedVenueTable = await resolveLinkedVenueTableForHostedTable(db, hostedTable.id);
    venueId = linkedVenueTable?.venueId || null;
  }
  if (venueId && !venueOwnerUserId) {
    const venue = await db.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { ownerUserId: true },
    });
    venueOwnerUserId = venue?.ownerUserId || null;
  }
  return { venueId, venueOwnerUserId, linkedVenueTable };
}

export async function resolveVenueIdForHostedTable(db, hostedTable) {
  const { venueId } = await resolveVenueContextForHostedTable(db, hostedTable);
  return venueId;
}
