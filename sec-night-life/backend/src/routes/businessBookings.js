import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { cacheGetJson, cacheSetJson } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { authenticateToken } from '../middleware/auth.js';
import { normalizeHostingConfig } from '../lib/hostingConfig.js';
import { splitPlatformGross } from '../lib/platformSplit.js';
import {
  flattenPaymentMetadata,
  basePaymentReference,
  classifyVenuePaymentRevenueScoped,
  createEmptyRevenueCounters,
  isTicketPaymentMeta,
  isDayBookingPayment,
  isVenueDirectDayBookingJoinPayment,
  venueDirectJoinFeeZar,
  paymentMatchesRevenueScope,
  isExcludedFromVenueAnalytics,
  isHostedTableVenuePayment,
  isTicketedEventPayment,
} from '../lib/paymentMetadata.js';
import { normalizeTicketTiers } from '../lib/issueEventTickets.js';
import {
  resolveAccessibleVenueIds,
  resolveBusinessVenueScope,
  staffCtxFromQuery,
  staffHasVenuePermission,
  venueIdFromQuery,
} from '../lib/access.js';
import { eventEndsAtFromEvent } from '../lib/ticketHelpers.js';
import { repairGuestEventVenueTableBookingsForEvents } from '../lib/eventVenueBooking.js';
import { resolveVenueMenuSelections } from '../lib/menuHelpers.js';
import { buildPaystackInitializeBody } from '../lib/paystackInitialize.js';
import {
  FEED_BOOST_ZAR_PER_DAY,
  clampBoostDays,
  isBoostActiveRow,
  maxBoostDaysUntil,
} from '../lib/feedBoost.js';
import { z } from 'zod';
import crypto from 'crypto';
import {
  isRefundedPaymentRef,
  loadRefundedPaymentRefs,
  loadRefundedMetricsForPeriod,
} from '../lib/refunds.js';
import { releaseVenueTableSlot, computeCanReleaseTable } from '../lib/venueTableSlotRelease.js';
import { resolveDailySessionNumber } from '../lib/dailyTableSession.js';
import {
  buildTableSessionReceipt,
  memberBelongsToTodaySast,
  isDayBookingSessionEnded,
  inferMemberSessionNumber as inferMemberSessionFromReceipt,
} from '../lib/tableSessionReceipt.js';
import {
  assertOrderFulfillPermission,
  canonicalOrderReference,
  fulfillOrderByReference,
  fulfillmentMapForReferences,
  guestRecordMatchesSearch,
  listVenueServeableOrders,
  normalizeGuestSearch,
  parseMenuItemLines,
  serializeOrderForClient,
  textMatchesGuestSearch,
  unfulfillOrderByReference,
} from '../lib/orderFulfillment.js';
import { buildEventPurchaseLog } from '../lib/eventPurchaseLog.js';

const router = Router();

async function requireVenueScope(req, res, permission) {
  const scope = await resolveBusinessVenueScope(req.userId, {
    staffCtx: staffCtxFromQuery(req.query),
    venueIdFilter: venueIdFromQuery(req.query),
    permission,
  });
  if (!scope.ok) {
    res.status(scope.status).json({ error: scope.error });
    return null;
  }
  if (venueIdFromQuery(req.query) && !scope.venueIds.length) {
    res.status(404).json({ error: 'Venue not found' });
    return null;
  }
  return scope;
}

function bookingsVenueScope(req) {
  return {
    venueIdFilter: venueIdFromQuery(req.query),
    staffCtx: staffCtxFromQuery(req.query),
    permission: 'bookings',
  };
}

function venueTablesVenueScope(req) {
  return {
    venueIdFilter: venueIdFromQuery(req.query),
    staffCtx: staffCtxFromQuery(req.query),
    permission: 'venue_tables',
  };
}

/** Prefer entrance + component when present so UI matches stored line items. */
function bookingDisplayTotalZar(r) {
  const ent = Number(r.entranceZar ?? 0) || 0;
  const comp = Number(r.componentZar ?? 0) || 0;
  const tot = Number(r.amountTotal ?? 0) || 0;
  if (ent > 0 || comp > 0) return ent + comp;
  return tot;
}

function rollBookingStats(rows) {
  return {
    bookingRowCount: rows.length,
    totalPaidZar: rows.reduce((s, r) => s + bookingDisplayTotalZar(r), 0),
  };
}

function bookingGroupKey(row) {
  if (row.role === 'ENTRANCE' && row.event?.id) {
    return `entrance-only-${row.event.id}`;
  }
  if (row.role === 'ENTRANCE' && row.eventId) {
    return `entrance-only-${row.eventId}`;
  }
  if (row.hostedTable?.id) return String(row.hostedTable.id);
  if (row.venueTableId) {
    return `direct-vt-${row.venueTableId}-s${row.tableSessionNumber || 1}`;
  }
  return null;
}

function syntheticHostedTableFromVenueRow(vt, sessionNumber = 1) {
  if (!vt) return null;
  return {
    id: `direct-vt-${vt.id}-s${sessionNumber}`,
    tableName: vt.tableName,
    status: 'ACTIVE',
    hostUserId: null,
    hostingCategory: null,
    hostingTierIndex: null,
    tierMinSpend: vt.minimumSpend,
    menuSpendTotal: null,
    tierIncludedItems: null,
    guestQuantity: vt.guestCapacity,
    spotsRemaining: Math.max(0, Number(vt.guestCapacity) - Number(vt.currentOccupancy)),
  };
}

function annotateEventBookingRow(row, refundedRefs) {
  const isRefunded =
    row.refundStatus === 'APPROVED' ||
    (row.paystackReference && isRefundedPaymentRef(row.paystackReference, refundedRefs));
  const lineTotal = isRefunded ? 0 : Number(row.lineTotalZar ?? bookingDisplayTotalZar(row));
  return {
    ...row,
    refundStatus: isRefunded ? 'APPROVED' : row.refundStatus ?? null,
    lineTotalZar: lineTotal,
    amountTotal: isRefunded ? 0 : row.amountTotal,
    entranceZar: isRefunded ? 0 : row.entranceZar,
    componentZar: isRefunded ? 0 : row.componentZar,
  };
}

function groupEventTableBookingsByTable(mapped, refundedRefs = null) {
  const groups = new Map();
  for (const raw of mapped) {
    const row = refundedRefs ? annotateEventBookingRow(raw, refundedRefs) : raw;
    const tableId = bookingGroupKey(row);
    if (!tableId) continue;
    if (!groups.has(tableId)) {
      groups.set(tableId, {
        id: tableId,
        hostedTable: row.role === 'ENTRANCE'
          ? {
              id: tableId,
              tableName: 'Entrance only',
              status: 'ACTIVE',
              hostUserId: null,
              hostingCategory: null,
            }
          : row.hostedTable,
        event: row.event,
        venue: row.venue,
        totalPaidZar: 0,
        transactionCount: 0,
        lastActivityAt: row.createdAt,
        transactions: [],
        rolesSummary: { hosts: 0, guests: 0, entrance: 0 },
        isDirectVenueSlot: Boolean(row.isDirectVenueSlot),
        isEntranceOnly: row.role === 'ENTRANCE',
      });
    }
    const g = groups.get(tableId);
    const lineTotal = Number(row.lineTotalZar || 0);
    g.totalPaidZar = Math.round((g.totalPaidZar + lineTotal) * 100) / 100;
    g.transactionCount += 1;
    if (new Date(row.createdAt) > new Date(g.lastActivityAt)) g.lastActivityAt = row.createdAt;
    g.transactions.push(row);
    if (row.role === 'HOST') g.rolesSummary.hosts += 1;
    else if (row.role === 'GUEST') g.rolesSummary.guests += 1;
    else if (row.role === 'ENTRANCE') g.rolesSummary.entrance += 1;
  }
  for (const g of groups.values()) {
    g.transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const hostRefunded = g.transactions.some(
      (t) => t.role === 'HOST' && t.refundStatus === 'APPROVED',
    );
    if (hostRefunded) g.hostRefundStatus = 'REFUNDED';
  }
  return [...groups.values()].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}

/** Include paid venue-table guests missing from EventVenueTableBooking (e.g. direct event slot joins). */
async function supplementEventTableBookingsFromVenueMembers({ eventIds, venueIds, existingMapped, refundedRefs = null }) {
  if (!eventIds.length || !venueIds.length) return existingMapped;

  const existingKeys = new Set(
    existingMapped.map((r) => {
      const gk = bookingGroupKey(r);
      return gk ? `${gk}:${r.user?.id}:${r.role}` : null;
    }).filter(Boolean),
  );
  const existingRefs = new Set(
    existingMapped.map((r) => r.paystackReference).filter(Boolean),
  );

  const members = await prisma.venueTableMember.findMany({
    where: {
      memberRole: 'GUEST',
      paystackReference: { not: null },
      status: { in: ['CONFIRMED', 'LEFT', 'REFUNDED'] },
      venueTable: {
        eventId: { in: eventIds },
        venueId: { in: venueIds },
      },
    },
    include: {
      venueTable: {
        include: {
          event: { select: { id: true, title: true, date: true, city: true } },
          venue: { select: { id: true, name: true } },
        },
      },
      user: {
        select: {
          id: true,
          fullName: true,
          username: true,
          userProfile: { select: { username: true } },
        },
      },
    },
    orderBy: { paidAt: 'desc' },
    take: 500,
  });

  const hostedIds = [
    ...new Set(members.map((m) => m.venueTable?.hostedTableId).filter(Boolean)),
  ];
  const hostedById = new Map();
  if (hostedIds.length) {
    const hostedRows = await prisma.hostedTable.findMany({
      where: { id: { in: hostedIds } },
      select: {
        id: true,
        tableName: true,
        status: true,
        hostUserId: true,
        hostingCategory: true,
        hostingTierIndex: true,
        tierMinSpend: true,
        menuSpendTotal: true,
        tierIncludedItems: true,
        guestQuantity: true,
        spotsRemaining: true,
      },
    });
    for (const ht of hostedRows) hostedById.set(ht.id, ht);
  }

  const supplemental = [];
  for (const m of members) {
    const vt = m.venueTable;
    if (!vt?.event) continue;

    let hostedTable = vt.hostedTableId ? hostedById.get(vt.hostedTableId) || null : null;
    let isDirectVenueSlot = false;
    let sessionNumber = resolveDailySessionNumber(vt);
    if (!hostedTable) {
      isDirectVenueSlot = true;
      if (m.tableSessionNumber != null) {
        sessionNumber = Number(m.tableSessionNumber) || 1;
      } else if (m.status === 'LEFT') {
        sessionNumber = Math.max(1, sessionNumber - 1);
      }
      hostedTable = syntheticHostedTableFromVenueRow(vt, sessionNumber);
    }

    const role = 'GUEST';
    if (m.paystackReference && existingRefs.has(m.paystackReference)) continue;
    const key = `${bookingGroupKey({ hostedTable, venueTableId: vt.id, tableSessionNumber: sessionNumber })}:${m.userId}:${role}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    if (m.paystackReference) existingRefs.add(m.paystackReference);

    const isRefunded =
      m.status === 'REFUNDED' ||
      (refundedRefs && isRefundedPaymentRef(m.paystackReference, refundedRefs));
    const paidAmount = isRefunded ? 0 : Number(m.amountPaid || 0);

    supplemental.push({
      id: `vtm-${m.id}`,
      role,
      paystackReference: m.paystackReference,
      refundStatus: isRefunded ? 'APPROVED' : null,
      amountTotal: paidAmount,
      entranceZar: null,
      componentZar: paidAmount,
      lineTotalZar: paidAmount,
      createdAt: m.paidAt || m.createdAt,
      venue: vt.venue,
      event: vt.event,
      hostedTable,
      venueTableId: isDirectVenueSlot ? vt.id : null,
      tableSessionNumber: isDirectVenueSlot ? sessionNumber : null,
      isDirectVenueSlot,
      user: {
        id: m.user.id,
        username: m.user.userProfile?.username || m.user.username || m.user.fullName || 'User',
      },
      selectedMenuItems: m.selectedMenuItems,
      hostingTierName: vt.tierLabel,
      hostingCategory: null,
      menuTotalZar: m.amountPaid,
    });
  }

  return [...existingMapped, ...supplemental];
}

function emptyEventTableBookingsSummary() {
  return {
    configuredTableSlots: 0,
    hostedTablesOpen: 0,
    hostedTablesFull: 0,
    totalGoingHeadcount: 0,
    pendingJoinRequests: 0,
    statsByRole: {
      all: { bookingRowCount: 0, totalPaidZar: 0 },
      HOST: { bookingRowCount: 0, totalPaidZar: 0 },
      GUEST: { bookingRowCount: 0, totalPaidZar: 0 },
    },
  };
}

/** Calendar day start UTC — event.date is compared the same way as listing “today’s” events. */
function startOfUtcToday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function eventDateIsPast(eventDate, startToday) {
  const t = new Date(eventDate);
  t.setUTCHours(0, 0, 0, 0);
  return t < startToday;
}

function eventSelectForBookings() {
  return {
    id: true,
    title: true,
    date: true,
    startTime: true,
    endsAt: true,
    hostingConfig: true,
    eventFormat: true,
    ticketTiers: true,
  };
}

/** Active/past scope uses event end instant when available (matches Events Manager lifecycle). */
function eventIsPastByEndsAt(ev, now = new Date()) {
  const end = eventEndsAtFromEvent(ev);
  if (end && !Number.isNaN(end.getTime())) return end.getTime() <= now.getTime();
  return eventDateIsPast(ev.date, startOfUtcToday());
}

function eventIsActiveByEndsAt(ev, now = new Date()) {
  return !eventIsPastByEndsAt(ev, now);
}

/** Table-hosting events for the Event Table bookings tab (excludes ticketed events). */
function eventSupportsTableBookings(ev) {
  if (!ev) return false;
  if (ev.eventFormat === 'TABLE_HOSTING') return true;
  if (ev.eventFormat === 'TICKETING_ONLY') return false;

  const hosting = normalizeHostingConfig(ev.hostingConfig);
  const tableTierCount =
    (Array.isArray(hosting.general?.tiers) ? hosting.general.tiers.length : 0) +
    (Array.isArray(hosting.vip?.tiers) ? hosting.vip.tiers.length : 0);
  const maxG = Number(hosting.general?.max_tables);
  const maxV = Number(hosting.vip?.max_tables);
  const hasTableHosting =
    tableTierCount > 0 ||
    (Number.isFinite(maxG) && maxG > 0) ||
    (Number.isFinite(maxV) && maxV > 0) ||
    Boolean(hosting.general?.allows_custom_requests) ||
    Boolean(hosting.vip?.allows_custom_requests);
  const hasTicketTiers = normalizeTicketTiers(ev.ticketTiers).length > 0;

  if (hasTicketTiers && !hasTableHosting) return false;
  return hasTableHosting;
}

function ticketedEventHasTables(ev) {
  if (!ev || ev.eventFormat !== 'TICKETING_ONLY') return false;
  const hosting = normalizeHostingConfig(ev.hostingConfig);
  const tableTierCount =
    (Array.isArray(hosting.general?.tiers) ? hosting.general.tiers.length : 0) +
    (Array.isArray(hosting.vip?.tiers) ? hosting.vip.tiers.length : 0);
  const maxG = Number(hosting.general?.max_tables);
  const maxV = Number(hosting.vip?.max_tables);
  return (
    tableTierCount > 0 ||
    (Number.isFinite(maxG) && maxG > 0) ||
    (Number.isFinite(maxV) && maxV > 0) ||
    Boolean(hosting.general?.allows_custom_requests) ||
    Boolean(hosting.vip?.allows_custom_requests)
  );
}

function eventQualifiesForTableBookings(ev, eventIdsWithVenueTables) {
  if (eventSupportsTableBookings(ev)) return true;
  return eventIdsWithVenueTables?.has(ev.id) ?? false;
}

function tableInUse(table, hostedTable = null) {
  if (!table) return false;
  if (hostedTable && hostedTable.status !== 'CLOSED') return true;
  if (table.currentOccupancy > 0) return true;
  if (table.hostUserId) return true;
  if (table.hostedTableId) return true;
  return false;
}

/** Guest count for event table manager — hosted tables use live member totals, not venue slot occupancy alone. */
function resolveEventTableGuestStats(table, hostedTable = null, goingMemberCount = null) {
  const capacity = Math.max(
    1,
    Number(hostedTable?.guestQuantity) || Number(table?.guestCapacity) || 1,
  );
  if (hostedTable && hostedTable.status !== 'CLOSED') {
    const fromMembers =
      goingMemberCount != null ? Number(goingMemberCount) : null;
    const fromSpots = Math.max(
      0,
      capacity - Math.max(0, Number(hostedTable.spotsRemaining) || 0),
    );
    const memberCount = Math.max(0, fromMembers != null ? fromMembers : fromSpots);
    return { memberCount, capacity, isHosted: true };
  }
  return {
    memberCount: Math.max(0, Number(table?.currentOccupancy) || 0),
    capacity,
    isHosted: false,
  };
}

function canDeleteDayTier(table, hostedTable = null) {
  if (!table || table.isCustomListing) return false;
  if (!String(table.hostingTierKey || '').startsWith('day:')) return false;
  if (tableInUse(table, hostedTable)) return false;
  return tierIndexFromHostingKey(table.hostingTierKey) != null;
}

function tierIndexFromHostingKey(key) {
  const parts = String(key || '').split(':');
  if (parts[0] !== 'day') return null;
  const idx = Number(parts[1]);
  return Number.isFinite(idx) ? idx : null;
}

function canHideTableFromListings(table, hostedTable = null) {
  if (!table?.isActive) return false;
  if (table.isCustomListing) return false;
  return !tableInUse(table, hostedTable);
}

function isSyntheticHostedId(id) {
  return String(id || '').startsWith('direct-vt-');
}

function inferMemberSessionNumber(member, venueTable) {
  return inferMemberSessionFromReceipt(member, venueTable);
}

function mapUserBrief(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.userProfile?.username || u.username || u.fullName || 'User',
    fullName: u.fullName,
  };
}

async function resolveMenuLinesForVenue(selectedMenuItems, venueId) {
  if (!Array.isArray(selectedMenuItems) || !selectedMenuItems.length || !venueId) return [];
  const resolved = await resolveVenueMenuSelections(selectedMenuItems, venueId);
  return (resolved.items || []).map((item) => ({
    name: item.name || 'Item',
    quantity: Number(item.quantity) || 1,
    lineTotal: (Number(item.price) || 0) * (Number(item.quantity) || 1),
  }));
}

function computeCanRelease(table, hostedTable) {
  return computeCanReleaseTable(table, hostedTable);
}

function mapVenueTableManagementItem(t, hosted, goingCount = null) {
  const { memberCount, capacity, isHosted } = resolveEventTableGuestStats(t, hosted, goingCount);
  const inUse = tableInUse(t, hosted);
  const spotsLeft = Math.max(0, capacity - memberCount);
  const fillPercent = capacity > 0 ? Math.min(100, Math.round((memberCount / capacity) * 100)) : 0;
  const hostLabel = hosted?.host
    ? hosted.host.userProfile?.username || hosted.host.username || hosted.host.fullName || 'Host'
    : null;
  let usageLabel;
  if (inUse) {
    usageLabel =
      memberCount > 0
        ? `${memberCount}/${capacity} guest${memberCount === 1 ? '' : 's'}`
        : isHosted
          ? 'Hosted — awaiting guests'
          : 'In use';
  } else if (t.isActive) {
    usageLabel = 'Available';
  } else {
    usageLabel = 'Hidden from listings';
  }
  return {
    id: t.id,
    tableName: t.tableName,
    tierLabel: t.tierLabel,
    tableCategory: t.tableCategory || null,
    includeEntranceFee: t.includeEntranceFee !== false,
    hostingTierKey: t.hostingTierKey,
    isActive: t.isActive,
    isCustomListing: Boolean(t.isCustomListing),
    currentOccupancy: memberCount,
    guestCapacity: capacity,
    spotsRemaining: spotsLeft,
    fillPercent,
    status: t.status,
    inUse,
    isHosted,
    hostLabel,
    hostingCategory: hosted?.hostingCategory || null,
    hasJoiningFee: Boolean(hosted?.hasJoiningFee),
    joiningFee: hosted?.hasJoiningFee ? Number(hosted.joiningFee || 0) : 0,
    usageLabel,
    canHideFromListings: canHideTableFromListings(t, hosted),
    canDeleteTier: canDeleteDayTier(t, hosted),
    canRestoreToListings: !t.isActive && !inUse,
    canResetTable: inUse,
    tableSessionNumber: resolveDailySessionNumber(t),
    minimumSpend: t.minimumSpend,
    hostMinimumSpend: t.hostMinimumSpend,
    bookingFeeZar: t.bookingFeeZar,
    hostTableFeeZar: t.hostTableFeeZar,
    serviceDate: t.serviceDate,
    serviceEndDate: t.serviceEndDate,
    serviceSchedule: t.serviceSchedule,
    startTime: t.startTime,
    endTime: t.endTime,
    description: t.description,
    boosted: isBoostActiveRow(t),
    boosted_at: t.boostedAt || null,
    boost_expires_at: t.boostExpiresAt || null,
  };
}

async function loadHostedContextForVenueTables(tables) {
  const hostedIds = tables.map((t) => t.hostedTableId).filter(Boolean);
  const hostedRows =
    hostedIds.length > 0
      ? await prisma.hostedTable.findMany({
          where: { id: { in: hostedIds } },
          select: {
            id: true,
            status: true,
            tableName: true,
            hostUserId: true,
            spotsRemaining: true,
            guestQuantity: true,
            hostingCategory: true,
            hasJoiningFee: true,
            joiningFee: true,
            host: {
              select: {
                fullName: true,
                username: true,
                userProfile: { select: { username: true } },
              },
            },
          },
        })
      : [];
  const hostedById = new Map(hostedRows.map((h) => [h.id, h]));

  const goingByHostedId = new Map();
  if (hostedIds.length > 0) {
    const goingRows = await prisma.hostedTableMember.groupBy({
      by: ['hostedTableId'],
      where: { hostedTableId: { in: hostedIds }, status: 'GOING' },
      _count: { _all: true },
    });
    for (const row of goingRows) {
      goingByHostedId.set(row.hostedTableId, row._count._all);
    }
  }

  return { hostedById, goingByHostedId };
}

router.get('/event-table-bookings', authenticateToken, async (req, res, next) => {
  try {
    const venueIdFilter = venueIdFromQuery(req.query);
    let venueIds = await resolveAccessibleVenueIds(req.userId, bookingsVenueScope(req));
    if (!venueIds.length) {
      if (venueIdFilter) return res.status(404).json({ error: 'Venue not found' });
      return res.json({
        items: [],
        eventSummaries: [],
        summary: emptyEventTableBookingsSummary(),
      });
    }
    const eventIdFilter = typeof req.query.event_id === 'string' && req.query.event_id.trim()
      ? req.query.event_id.trim()
      : null;

    const scopeRaw = String(req.query.event_scope || 'active').toLowerCase();
    const eventScope = ['active', 'past', 'all'].includes(scopeRaw) ? scopeRaw : 'active';
    const now = new Date();

    const venueTableEventRows = await prisma.venueTable.findMany({
      where: { venueId: { in: venueIds }, eventId: { not: null } },
      select: { eventId: true },
      distinct: ['eventId'],
    });
    const eventIdsWithVenueTables = new Set(
      venueTableEventRows.map((r) => r.eventId).filter(Boolean),
    );

    let eventsInScope = [];
    let eventSummaries = [];

    if (eventIdFilter) {
      const ev = await prisma.event.findFirst({
        where: { id: eventIdFilter, venueId: { in: venueIds }, deletedAt: null },
        select: eventSelectForBookings(),
      });
      if (!ev) {
        return res.status(404).json({ error: 'Event not found' });
      }
      if (!eventQualifiesForTableBookings(ev, eventIdsWithVenueTables)) {
        return res.json({
          items: [],
          eventSummaries: [],
          summary: emptyEventTableBookingsSummary(),
          eventScope,
        });
      }
      const isPast = eventIsPastByEndsAt(ev, now);
      if (eventScope === 'active' && isPast) {
        return res.json({
          items: [],
          eventSummaries: [],
          summary: emptyEventTableBookingsSummary(),
          eventScope,
          notice: 'past_event_use_past_scope',
        });
      }
      if (eventScope === 'past' && !isPast) {
        return res.json({
          items: [],
          eventSummaries: [],
          summary: emptyEventTableBookingsSummary(),
          eventScope,
          notice: 'upcoming_event_use_active_scope',
        });
      }
      eventsInScope = [ev];
      eventSummaries = [{ id: ev.id, title: ev.title, date: ev.date }];
    } else {
      const allVenueEvents = await prisma.event.findMany({
        where: {
          venueId: { in: venueIds },
          deletedAt: null,
        },
        select: eventSelectForBookings(),
      });
      let tableHostingEvents = allVenueEvents.filter((e) =>
        eventQualifiesForTableBookings(e, eventIdsWithVenueTables),
      );
      if (eventScope === 'active') {
        tableHostingEvents = tableHostingEvents.filter((e) => eventIsActiveByEndsAt(e, now));
      } else if (eventScope === 'past') {
        tableHostingEvents = tableHostingEvents.filter((e) => eventIsPastByEndsAt(e, now));
      }
      eventsInScope = tableHostingEvents;
      eventSummaries = tableHostingEvents
        .map((e) => ({
          id: e.id,
          title: e.title,
          date: e.date,
        }))
        .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }

    const eventIds = eventsInScope.map((e) => e.id);

    if (eventIds.length === 0) {
      return res.json({
        items: [],
        eventSummaries,
        summary: emptyEventTableBookingsSummary(),
        eventScope,
      });
    }

    await repairGuestEventVenueTableBookingsForEvents(eventIds);

    const refundedRefs = await loadRefundedPaymentRefs(venueIds);

    let configuredTableSlots = 0;
    for (const ev of eventsInScope) {
      const c = normalizeHostingConfig(ev.hostingConfig);
      const g = Number(c.general?.max_tables);
      const v = Number(c.vip?.max_tables);
      configuredTableSlots += (Number.isFinite(g) && g > 0 ? g : 0) + (Number.isFinite(v) && v > 0 ? v : 0);
    }

    const hostedInScope = await prisma.hostedTable.findMany({
      where: { eventId: { in: eventIds }, tableType: 'IN_APP_EVENT' },
      select: { id: true, status: true },
    });

    const rows = await prisma.eventVenueTableBooking.findMany({
      where: {
        venueId: { in: venueIds },
        ...(eventIdFilter ? { eventId: eventIdFilter } : { eventId: { in: eventIds } }),
      },
      include: {
        venue: { select: { id: true, name: true } },
        event: { select: { id: true, title: true, date: true, city: true } },
        hostedTable: {
          select: {
            id: true,
            tableName: true,
            status: true,
            hostUserId: true,
            hostingCategory: true,
            hostingTierIndex: true,
            tierMinSpend: true,
            menuSpendTotal: true,
            tierIncludedItems: true,
            guestQuantity: true,
            spotsRemaining: true,
          },
        },
        user: { select: { id: true, fullName: true, username: true, userProfile: { select: { username: true } } } },
        venueTable: {
          select: {
            id: true,
            tableName: true,
            guestCapacity: true,
            currentOccupancy: true,
            minimumSpend: true,
            tierLabel: true,
            tableSessionNumber: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    const refundedHostedTableIds = new Set(
      rows
        .filter(
          (r) =>
            r.role === 'HOST' &&
            r.hostedTableId &&
            r.paystackReference &&
            isRefundedPaymentRef(r.paystackReference, refundedRefs),
        )
        .map((r) => r.hostedTableId),
    );

    const activeHostedIds = hostedInScope
      .filter((h) => h.status === 'ACTIVE' || h.status === 'FULL')
      .map((h) => h.id);
    const hostedTablesOpen = hostedInScope.filter(
      (h) => h.status === 'ACTIVE' && !refundedHostedTableIds.has(h.id),
    ).length;
    const hostedTablesFull = hostedInScope.filter(
      (h) => h.status === 'FULL' && !refundedHostedTableIds.has(h.id),
    ).length;

    let totalGoingHeadcount = 0;
    let pendingJoinRequests = 0;
    const activeHostedIdsExRefunded = activeHostedIds.filter((id) => !refundedHostedTableIds.has(id));
    if (activeHostedIdsExRefunded.length) {
      const goingRows = await prisma.hostedTableMember.groupBy({
        by: ['hostedTableId'],
        where: { hostedTableId: { in: activeHostedIdsExRefunded }, status: 'GOING' },
        _count: true,
      });
      totalGoingHeadcount = goingRows.reduce((s, r) => s + r._count, 0);
      const pendRows = await prisma.hostedTableMember.groupBy({
        by: ['hostedTableId'],
        where: { hostedTableId: { in: activeHostedIdsExRefunded }, status: 'PENDING' },
        _count: true,
      });
      pendingJoinRequests = pendRows.reduce((s, r) => s + r._count, 0);
    }

    const mapped = rows.map((r) => {
      const sessionNumber = r.tableSessionNumber || resolveDailySessionNumber(r.venueTable);
      const hostedTable =
        r.hostedTable ||
        (r.venueTableId && r.venueTable
          ? syntheticHostedTableFromVenueRow(r.venueTable, sessionNumber)
          : null);
      return annotateEventBookingRow(
        {
          id: r.id,
          role: r.role,
          paystackReference: r.paystackReference,
          amountTotal: r.amountTotal,
          entranceZar: r.entranceZar,
          componentZar: r.componentZar,
          lineTotalZar: bookingDisplayTotalZar(r),
          createdAt: r.createdAt,
          venue: r.venue,
          event: r.event,
          hostedTable,
          venueTableId: r.venueTableId,
          tableSessionNumber: r.venueTableId ? sessionNumber : null,
          isDirectVenueSlot: Boolean(r.venueTableId && !r.hostedTableId),
          user: {
            id: r.user.id,
            username: r.user.userProfile?.username || r.user.username || r.user.fullName || 'User',
          },
          selectedMenuItems: r.selectedMenuItems,
          hostingTierName: r.hostingTierName,
          hostingCategory: r.hostingCategory,
          menuTotalZar: r.menuTotalZar,
        },
        refundedRefs,
      );
    });

    const mappedWithVenueGuests = await supplementEventTableBookingsFromVenueMembers({
      eventIds,
      venueIds,
      existingMapped: mapped,
      refundedRefs,
    });

    const rawForStats = mappedWithVenueGuests.map((r) => ({
      role: r.role,
      amountTotal: r.amountTotal,
      entranceZar: r.entranceZar,
      componentZar: r.componentZar,
    }));

    const groupedItems = groupEventTableBookingsByTable(mappedWithVenueGuests, refundedRefs);
    const q = normalizeGuestSearch(req.query.q);
    const filteredItems = q
      ? groupedItems.filter((group) => {
          const tableHay = `${group?.event?.title || ''} ${group?.hostedTable?.tableName || ''}`;
          if (textMatchesGuestSearch(tableHay, q)) return true;
          return (group.transactions || []).some((t) =>
            guestRecordMatchesSearch(
              {
                username: t?.user?.username,
                fullName: t?.user?.fullName,
                eventTitle: group?.event?.title,
                tableName: group?.hostedTable?.tableName,
              },
              q,
            ),
          );
        })
      : groupedItems;

    const summary = {
      configuredTableSlots,
      hostedTablesOpen,
      hostedTablesFull,
      totalGoingHeadcount,
      pendingJoinRequests,
      tableCount: filteredItems.length,
      totalPaidZar: filteredItems.reduce((s, g) => s + Number(g.totalPaidZar || 0), 0),
      statsByRole: {
        all: rollBookingStats(rawForStats),
        HOST: rollBookingStats(rawForStats.filter((x) => x.role === 'HOST')),
        GUEST: rollBookingStats(rawForStats.filter((x) => x.role === 'GUEST')),
      },
    };

    res.json({ items: filteredItems, eventSummaries, summary, eventScope });
  } catch (e) {
    next(e);
  }
});

function paymentMatchesVenueScope(meta, venueId, eventIdSet) {
  if (!meta || typeof meta !== 'object') return false;
  const vid = meta.venue_id ?? meta.venueId;
  if (vid != null && String(vid) === venueId) return true;
  const eid = meta.event_id ?? meta.eventId;
  return eid != null && eventIdSet.has(String(eid));
}

function netAmountFromPayment(meta, gross) {
  if (meta?.venue_share_zar != null) return Number(meta.venue_share_zar) || 0;
  if (meta?.recipient_amount != null) return Number(meta.recipient_amount) || 0;
  return splitPlatformGross(gross).recipientAmount;
}

function ticketQuantityFromMeta(meta) {
  return Math.max(1, parseInt(String(meta?.quantity || '1'), 10) || 1);
}

function parseRevenueScope(raw) {
  const s = String(raw || 'all').toLowerCase();
  if (s === 'events' || s === 'day_bookings' || s === 'ticketed_events') return s;
  return 'all';
}

function matchesAnalyticsFilter(
  meta,
  { revenueScope, eventId, ticketedEventIdSet = null },
  { fromVenueLedger = false } = {},
) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const eid = m.event_id ?? m.eventId;

  // Venue payout-ledger rows are already scoped to this venue.
  if (fromVenueLedger) {
    if (revenueScope === 'all') {
      if (eventId && (eid == null || String(eid) !== eventId)) return false;
      return true;
    }
    if (revenueScope === 'day_bookings') {
      // Explicit day-booking flag wins; otherwise require no event (or day-booking heuristics).
      if (isDayBookingPayment(m)) return !isExcludedFromVenueAnalytics(m.type, null);
      if (eid) return false;
      if (isExcludedFromVenueAnalytics(m.type, null)) return false;
      return true;
    }
    if (revenueScope === 'ticketed_events') {
      if (isDayBookingPayment(m)) return false;
      if (eventId && (eid == null || String(eid) !== eventId)) return false;
      if (isTicketedEventPayment(m)) return true;
      if (eid != null && ticketedEventIdSet instanceof Set) {
        return ticketedEventIdSet.has(String(eid));
      }
      return false;
    }
    if (revenueScope === 'events') {
      if (isDayBookingPayment(m)) return false;
      if (eventId && (eid == null || String(eid) !== eventId)) return false;
      // Event-linked or ticket-like rows; sparse rows with no event stay out of events scope.
      return Boolean(eid) || isTicketPaymentMeta(m, m.type) || isHostedTableVenuePayment(m);
    }
  }

  if (!paymentMatchesRevenueScope(m, revenueScope)) return false;
  if (revenueScope === 'ticketed_events' && eid != null && ticketedEventIdSet instanceof Set) {
    if (!ticketedEventIdSet.has(String(eid)) && !isTicketedEventPayment(m)) return false;
  }
  if (eventId && revenueScope !== 'day_bookings') {
    if (eid == null || String(eid) !== eventId) return false;
  }
  return true;
}

function bumpRevenueDay(revenueByDay, dayKey, gross, net) {
  if (!revenueByDay[dayKey]) revenueByDay[dayKey] = { gross: 0, net: 0 };
  revenueByDay[dayKey].gross += gross;
  revenueByDay[dayKey].net += net;
}

function roundZar(n) {
  return Number((Number(n) || 0).toFixed(2));
}

router.get('/venue-analytics', authenticateToken, async (req, res, next) => {
  try {
    const scope = await requireVenueScope(req, res, 'analytics');
    if (!scope) return;
    const venueId = scope.venueIds[0];
    if (!venueId) return res.status(400).json({ error: 'venue_id or staff_ctx is required' });
    const days = Math.min(366, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));
    const eventId = typeof req.query.event_id === 'string' && req.query.event_id.trim() ? req.query.event_id.trim() : null;
    const revenueScope = parseRevenueScope(req.query.revenue_scope);
    const revenueMode = String(req.query.revenue_mode || 'gross').toLowerCase() === 'net' ? 'net' : 'gross';
    const analyticsCacheKey = `biz:venue-analytics:v1:${venueId}:${days}:${eventId || 'all'}:${revenueScope}:${revenueMode}`;
    if (String(req.query.debug || '') !== '1') {
      const cached = await cacheGetJson(analyticsCacheKey);
      if (cached) return res.json(cached);
    }

    // Skip background repair on analytics — it competes for DB connections and slows the page.
    const cutoff = new Date(Date.now() - days * 86400000);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const isDayBookingsScope = revenueScope === 'day_bookings';
    const isTicketedEventsScope = revenueScope === 'ticketed_events';

    // Day-bookings: align with /venue-table-bookings (paid refs on eventId-null tables),
    // then fill gaps from hosted guests, day splits, venue ledger, and venue day payments.
    const debugAnalytics = String(req.query.debug || '') === '1';
    const dayMembersPromise = isDayBookingsScope
      ? prisma.venueTableMember.findMany({
          where: {
            // Match list endpoint: paid refs, include LEFT (session ended). Skip REFUNDED in loop.
            paystackReference: { not: null },
            status: { in: ['CONFIRMED', 'LEFT', 'APPROVED', 'PENDING_PAYMENT'] },
            venueTable: {
              venueId,
              eventId: null,
            },
            OR: [
              { paidAt: { gte: cutoff } },
              { AND: [{ paidAt: null }, { joinedAt: { gte: cutoff } }] },
              { bookingDate: { gte: cutoff } },
            ],
          },
          select: {
            amountPaid: true,
            windowStartTime: true,
            joinedAt: true,
            paidAt: true,
            bookingDate: true,
            memberRole: true,
            venueTableId: true,
            paystackReference: true,
            selectedMenuItems: true,
            venueTable: {
              select: {
                id: true,
                tierLabel: true,
                // Prefer tierLabel/tableName for insights — avoid hostingTiersKey select
                // (stale Prisma clients have crashed day_bookings on that field).
                tableName: true,
                bookingFeeZar: true,
                hostTableFeeZar: true,
              },
            },
          },
          take: 2000,
        })
      : Promise.resolve([]);

    const dayHostedGuestsPromise = isDayBookingsScope
      ? prisma.hostedTableMember.findMany({
          where: {
            status: 'GOING',
            paystackReference: { not: null },
            hostedTable: {
              eventId: null,
              venueTable: { venueId },
            },
            OR: [
              { hostReviewedAt: { gte: cutoff } },
              { AND: [{ hostReviewedAt: null }, { joinedAt: { gte: cutoff } }] },
            ],
          },
          select: {
            joinFeePaid: true,
            menuSpendPaid: true,
            paystackReference: true,
            hostReviewedAt: true,
            joinedAt: true,
            selectedMenuItems: true,
            hostedTable: {
              select: {
                venueTableId: true,
                venueTable: {
                  select: {
                    id: true,
                    tierLabel: true,
                    tableName: true,
                  },
                },
              },
            },
          },
          take: 2000,
        })
      : Promise.resolve([]);

    const [refundedRefs, refundedMetrics, events, ledgerRows, splitLogs, paidTx, dayMembersEarly, dayHostedGuests] =
      await Promise.all([
        loadRefundedPaymentRefs([venueId]),
        loadRefundedMetricsForPeriod([venueId], cutoff),
        isDayBookingsScope
          ? Promise.resolve([])
          : prisma.event.findMany({
              where: {
                venueId,
                deletedAt: null,
                ...(eventId ? { id: eventId } : {}),
                ...(isTicketedEventsScope ? { eventFormat: 'TICKETING_ONLY' } : {}),
              },
              select: { id: true, date: true, startTime: true, eventFormat: true, hostingConfig: true },
            }),
        prisma.payoutLedger.findMany({
          where: {
            recipientVenueId: venueId,
            recipientType: 'VENUE',
            createdAt: { gte: cutoff },
            status: { not: 'REFUNDED_MANUAL' },
          },
          select: {
            paymentReference: true,
            grossAmount: true,
            recipientAmount: true,
            createdAt: true,
          },
          take: 3000,
        }),
        prisma.splitPaymentLog.findMany({
          where: {
            createdAt: { gte: cutoff },
            venueTable: isDayBookingsScope ? { venueId, eventId: null } : { venueId },
          },
          select: {
            reference: true,
            totalAmount: true,
            venueAmount: true,
            createdAt: true,
          },
          take: 3000,
        }),
        isDayBookingsScope
          ? Promise.resolve([])
          : eventId
            ? prisma.transaction.findMany({
                where: {
                  venueId,
                  status: 'paid',
                  createdAt: { gte: cutoff },
                  eventId,
                },
                select: { amount: true, createdAt: true, stripeId: true, metadata: true },
                take: 3000,
              })
            : prisma.transaction.findMany({
                where: {
                  venueId,
                  status: 'paid',
                  createdAt: { gte: cutoff },
                },
                select: { amount: true, createdAt: true, stripeId: true, metadata: true },
                take: 3000,
              }),
        dayMembersPromise,
        dayHostedGuestsPromise,
      ]);

    const eventIds = events.map((e) => e.id);
    if (eventId && eventIds.length === 0) return res.status(400).json({ error: 'Event not found for this venue' });
    const eventById = new Map(events.map((e) => [String(e.id), e]));
    const eventIdSet = new Set(eventIds.map(String));
    const ticketedEventIdSet = new Set(
      events.filter((e) => e.eventFormat === 'TICKETING_ONLY').map((e) => String(e.id)),
    );

    const eventsInPeriod = events.filter((e) => e.date && new Date(e.date) >= cutoff).length;
    const upcomingEventsCount = events.filter((e) => e.date && new Date(e.date) >= todayStart).length;

    const ledgerRefs = [...new Set(ledgerRows.map((r) => r.paymentReference).filter(Boolean))];
    const ledgerBaseRefs = [...new Set(ledgerRefs.map((r) => basePaymentReference(r)).filter(Boolean))];
    const splitRefs = [...new Set(splitLogs.map((s) => s.reference).filter(Boolean))];
    const memberRefs = isDayBookingsScope
      ? [
          ...dayMembersEarly.map((m) => m.paystackReference).filter(Boolean),
          ...dayHostedGuests.map((g) => g.paystackReference).filter(Boolean),
        ]
      : [];
    const ledgerLookupRefs = [...new Set([...ledgerRefs, ...ledgerBaseRefs, ...splitRefs, ...memberRefs])];
    const ledgerPayments =
      ledgerLookupRefs.length > 0
        ? await prisma.payment.findMany({
            where: { reference: { in: ledgerLookupRefs } },
            select: { reference: true, metadata: true, type: true, amount: true },
          })
        : [];
    const paymentMetaByRef = new Map();
    const paymentTypeByRef = new Map();
    const paymentAmountByRef = new Map();
    for (const p of ledgerPayments) {
      paymentMetaByRef.set(p.reference, flattenPaymentMetadata(p.metadata));
      paymentTypeByRef.set(p.reference, p.type);
      paymentAmountByRef.set(p.reference, Number(p.amount) || 0);
    }

    /** Day-booking base refs proven via split logs on eventId-null venue tables. */
    const daySplitBaseRefs = new Set();
    if (isDayBookingsScope) {
      for (const log of splitLogs) {
        if (log.reference) daySplitBaseRefs.add(basePaymentReference(log.reference));
      }
      for (const m of dayMembersEarly) {
        if (m.paystackReference) daySplitBaseRefs.add(basePaymentReference(m.paystackReference));
      }
      for (const g of dayHostedGuests) {
        if (g.paystackReference) daySplitBaseRefs.add(basePaymentReference(g.paystackReference));
      }
    }

    const resolveLedgerPaymentMeta = (ref) => {
      const base = basePaymentReference(ref);
      return paymentMetaByRef.get(ref) || paymentMetaByRef.get(base) || {};
    };
    const resolveLedgerPaymentType = (ref) => {
      const base = basePaymentReference(ref);
      return paymentTypeByRef.get(ref) ?? paymentTypeByRef.get(base) ?? null;
    };
    const resolvePaymentAmount = (ref) => {
      if (!ref) return 0;
      const base = basePaymentReference(ref);
      return paymentAmountByRef.get(ref) || paymentAmountByRef.get(base) || 0;
    };

    const scopeFilter = {
      revenueScope,
      eventId: revenueScope === 'day_bookings' ? null : eventId,
      ticketedEventIdSet: isTicketedEventsScope ? ticketedEventIdSet : null,
    };

    let grossTotal = 0;
    let netTotal = 0;
    const revenueCounters = createEmptyRevenueCounters();
    const revenueByDay = {};
    const matchedPaymentRefs = new Set();
    /** Base refs where a non-component (full) payment was counted — used to skip member fallback. */
    const fullyMatchedBaseRefs = new Set();
    const eventIdsWithRevenue = new Set();
    let countedRows = 0;

    const addRevenueRow = (meta, mtype, pType, gross, net, dayKey, ref, opts = {}) => {
      if (!matchesAnalyticsFilter(meta, scopeFilter, opts)) return false;
      if (isExcludedFromVenueAnalytics(mtype, pType)) return false;
      const counted = classifyVenuePaymentRevenueScoped(
        mtype,
        pType,
        gross,
        net,
        revenueCounters,
        meta,
        revenueScope,
        ref,
      );
      if (!counted) return false;
      grossTotal += gross;
      netTotal += net;
      countedRows += 1;
      if (ref) {
        matchedPaymentRefs.add(ref);
        matchedPaymentRefs.add(basePaymentReference(ref));
        const component = String(ref).includes(':') ? String(ref).slice(String(ref).indexOf(':') + 1) : null;
        if (!component || (component !== 'menu' && component !== 'join' && component !== 'entrance')) {
          fullyMatchedBaseRefs.add(basePaymentReference(ref));
        }
      }
      bumpRevenueDay(revenueByDay, dayKey, gross, net);
      const eid = meta?.event_id ?? meta?.eventId;
      if (eid != null) eventIdsWithRevenue.add(String(eid));
      return true;
    };

    let ticketSalesFromPayments = 0;
    let dayBookingVenueJoinFeeVolumeZar = 0;
    let paymentsConsidered = 0;

    // Day-bookings: count paid members first (authoritative for host/guest/menu splits).
    if (isDayBookingsScope) {
      for (const m of dayMembersEarly) {
        const ref = m.paystackReference || null;
        if (ref && isRefundedPaymentRef(ref, refundedRefs)) continue;
        let amt = Number(m.amountPaid) || 0;
        if (amt <= 0 && ref) amt = resolvePaymentAmount(ref);
        if (amt <= 0) continue;
        const when = m.paidAt || m.joinedAt || m.bookingDate || new Date();
        const dayKey = when instanceof Date ? when.toISOString().slice(0, 10) : String(when).slice(0, 10);
        const isHost = m.memberRole === 'HOST';
        const menuItems = Array.isArray(m.selectedMenuItems) ? m.selectedMenuItems : [];
        const menuZar = menuItems.reduce(
          (s, item) => s + (Number(item?.price || item?.price_zar || 0) * Number(item?.quantity || 1) || 0),
          0,
        );
        const joinFeeZar = !isHost ? Number(m.venueTable?.bookingFeeZar || 0) : 0;
        const hostFeeZar = isHost ? Number(m.venueTable?.hostTableFeeZar || 0) : 0;

        let remaining = amt;
        if (menuZar > 0 && menuZar <= remaining + 0.01) {
          const menuGross = Math.min(menuZar, remaining);
          const menuNet = splitPlatformGross(menuGross).recipientAmount;
          addRevenueRow(
            {
              is_day_booking: true,
              type: 'HOSTED_TABLE_MENU',
              venue_table_id: m.venueTableId,
              venue_id: venueId,
            },
            'HOSTED_TABLE_MENU',
            null,
            menuGross,
            menuNet,
            dayKey,
            ref ? `${ref}:menu` : null,
          );
          remaining = Math.max(0, remaining - menuGross);
        }
        if (joinFeeZar > 0 && !isHost) {
          dayBookingVenueJoinFeeVolumeZar += Math.min(joinFeeZar, remaining || joinFeeZar);
        }
        if (remaining > 0) {
          const net = splitPlatformGross(remaining).recipientAmount;
          const meta = {
            is_day_booking: true,
            member_role: m.memberRole,
            booking_mode: isHost ? 'host' : 'join',
            type: isHost ? 'TABLE_CHECKOUT' : 'HOSTED_TABLE_JOIN',
            venue_table_id: m.venueTableId,
            venue_id: venueId,
            booking_fee_zar: joinFeeZar,
            host_table_fee_zar: hostFeeZar,
          };
          addRevenueRow(meta, meta.type, null, remaining, net, dayKey, ref);
        }
      }

      // Hosted day-table guests: venue only receives menu (join fee goes to host).
      for (const g of dayHostedGuests) {
        const ref = g.paystackReference || null;
        if (ref && isRefundedPaymentRef(ref, refundedRefs)) continue;
        const menuZar = Number(g.menuSpendPaid) || 0;
        if (menuZar <= 0) continue;
        const when = g.hostReviewedAt || g.joinedAt || new Date();
        const dayKey = when instanceof Date ? when.toISOString().slice(0, 10) : String(when).slice(0, 10);
        const tableId = g.hostedTable?.venueTableId || g.hostedTable?.venueTable?.id || null;
        const menuNet = splitPlatformGross(menuZar).recipientAmount;
        addRevenueRow(
          {
            is_day_booking: true,
            type: 'HOSTED_TABLE_MENU',
            venue_table_id: tableId,
            venue_id: venueId,
            member_role: 'GUEST',
            booking_mode: 'join',
          },
          'HOSTED_TABLE_MENU',
          null,
          menuZar,
          menuNet,
          dayKey,
          ref ? `${ref}:menu` : null,
        );
      }
    }

    for (const row of ledgerRows) {
      let meta = resolveLedgerPaymentMeta(row.paymentReference);
      const baseRef = row.paymentReference ? basePaymentReference(row.paymentReference) : null;
      if (isDayBookingsScope) {
        // Prefer table/split proof over sparse metadata (stray event_id).
        if (daySplitBaseRefs.has(baseRef) || isDayBookingPayment(meta) || !(meta.event_id ?? meta.eventId)) {
          meta = { ...meta, is_day_booking: true };
          if (meta.event_id || meta.eventId) {
            const { event_id: _e1, eventId: _e2, ...rest } = meta;
            meta = { ...rest, is_day_booking: true };
          }
        }
      }
      if (isRefundedPaymentRef(row.paymentReference, refundedRefs)) continue;
      if (row.paymentReference && matchedPaymentRefs.has(row.paymentReference)) continue;
      // Skip ledger components when the full member payment was already counted.
      if (baseRef && fullyMatchedBaseRefs.has(baseRef)) continue;
      const gross = Number(row.grossAmount) || 0;
      const net = Number(row.recipientAmount) || 0;
      const dayKey = row.createdAt.toISOString().slice(0, 10);
      addRevenueRow(
        meta,
        meta?.type,
        resolveLedgerPaymentType(row.paymentReference),
        gross,
        net,
        dayKey,
        row.paymentReference,
        { fromVenueLedger: true },
      );
    }

    for (const log of splitLogs) {
      if (!log.reference || matchedPaymentRefs.has(log.reference)) continue;
      const baseRef = basePaymentReference(log.reference);
      if (baseRef && fullyMatchedBaseRefs.has(baseRef)) continue;
      let meta = resolveLedgerPaymentMeta(log.reference);
      if (isDayBookingsScope) {
        meta = { ...meta, is_day_booking: true };
        if (meta.event_id || meta.eventId) {
          const { event_id: _e1, eventId: _e2, ...rest } = meta;
          meta = { ...rest, is_day_booking: true };
        }
      }
      if (isRefundedPaymentRef(log.reference, refundedRefs)) continue;
      const gross = Number(log.totalAmount) || 0;
      const net = Number(log.venueAmount) || 0;
      const dayKey = log.createdAt.toISOString().slice(0, 10);
      addRevenueRow(meta, meta?.type, resolveLedgerPaymentType(log.reference), gross, net, dayKey, log.reference);
    }

    // Venue-scoped payment fallback. Day bookings require venue match + day-booking classification.
    {
      let payments = [];
      if (isDayBookingsScope) {
        payments = await prisma.payment.findMany({
          where: {
            status: 'success',
            createdAt: { gte: cutoff },
            AND: [
              {
                OR: [
                  { metadata: { path: ['venue_id'], equals: venueId } },
                  { metadata: { path: ['venueId'], equals: venueId } },
                ],
              },
              {
                OR: [
                  { metadata: { path: ['is_day_booking'], equals: true } },
                  { metadata: { path: ['isDayBooking'], equals: true } },
                ],
              },
            ],
          },
          select: { amount: true, type: true, metadata: true, createdAt: true, reference: true },
          orderBy: { createdAt: 'desc' },
          take: 3000,
        });
        // Also include venue-scoped payments without the flag when they look like day bookings in JS.
        const venueScoped = await prisma.payment.findMany({
          where: {
            status: 'success',
            createdAt: { gte: cutoff },
            OR: [
              { metadata: { path: ['venue_id'], equals: venueId } },
              { metadata: { path: ['venueId'], equals: venueId } },
            ],
          },
          select: { amount: true, type: true, metadata: true, createdAt: true, reference: true },
          orderBy: { createdAt: 'desc' },
          take: 3000,
        });
        const seen = new Set(payments.map((p) => p.reference).filter(Boolean));
        for (const p of venueScoped) {
          if (p.reference && seen.has(p.reference)) continue;
          const meta = flattenPaymentMetadata(p.metadata);
          if (isDayBookingPayment(meta) || (!(meta.event_id ?? meta.eventId) && (meta.venue_table_id || meta.venueTableId))) {
            payments.push(p);
            if (p.reference) seen.add(p.reference);
          }
        }
      } else {
        const venuePaymentOr = [
          { metadata: { path: ['venue_id'], equals: venueId } },
          { metadata: { path: ['venueId'], equals: venueId } },
        ];
        if (eventId) {
          venuePaymentOr.push(
            { metadata: { path: ['event_id'], equals: eventId } },
            { metadata: { path: ['eventId'], equals: eventId } },
          );
        }
        payments = await prisma.payment.findMany({
          where: {
            status: 'success',
            createdAt: { gte: cutoff },
            OR: venuePaymentOr,
          },
          select: { amount: true, type: true, metadata: true, createdAt: true, reference: true },
          orderBy: { createdAt: 'desc' },
          take: 3000,
        });
      }

      paymentsConsidered = payments.length;

      for (const p of payments) {
        let meta = flattenPaymentMetadata(p.metadata);
        if (isDayBookingsScope) {
          if (!isDayBookingPayment(meta) && (meta.event_id ?? meta.eventId) && !daySplitBaseRefs.has(basePaymentReference(p.reference))) {
            continue;
          }
          meta = { ...meta, is_day_booking: true };
          if (meta.event_id || meta.eventId) {
            const { event_id: _e1, eventId: _e2, ...rest } = meta;
            meta = { ...rest, is_day_booking: true };
          }
        } else if (!paymentMatchesVenueScope(meta, venueId, eventIdSet)) {
          continue;
        }
        if (p.reference && matchedPaymentRefs.has(p.reference)) continue;
        const baseRef = p.reference ? basePaymentReference(p.reference) : null;
        if (baseRef && fullyMatchedBaseRefs.has(baseRef)) continue;
        if (isRefundedPaymentRef(p.reference, refundedRefs)) continue;
        const amt = Number(p.amount) || 0;
        const net = netAmountFromPayment(meta, amt);
        const dayKey = p.createdAt.toISOString().slice(0, 10);
        const counted = addRevenueRow(meta, meta.type, p.type, amt, net, dayKey, p.reference);

        if (counted && isTicketPaymentMeta(meta, p.type) && !isRefundedPaymentRef(p.reference, refundedRefs)) {
          ticketSalesFromPayments += ticketQuantityFromMeta(meta);
        }
        if (counted && isDayBookingsScope && isVenueDirectDayBookingJoinPayment(meta)) {
          const fee = venueDirectJoinFeeZar(meta);
          if (fee > 0) dayBookingVenueJoinFeeVolumeZar += fee;
        }
      }

      if (!isDayBookingsScope) {
        for (const t of paidTx) {
          const ref = t.stripeId || (t.metadata && typeof t.metadata === 'object' ? t.metadata.reference : null);
          const baseRef = ref ? basePaymentReference(String(ref)) : null;
          if (ref && (matchedPaymentRefs.has(String(ref)) || (baseRef && matchedPaymentRefs.has(baseRef)))) {
            continue;
          }
          if (isRefundedPaymentRef(ref, refundedRefs)) continue;
          const txMeta = flattenPaymentMetadata(t.metadata);
          if (!paymentMatchesVenueScope(txMeta, venueId, eventIdSet)) continue;
          const amt = Number(t.amount) || 0;
          const net = netAmountFromPayment(txMeta, amt);
          const dayKey = t.createdAt.toISOString().slice(0, 10);
          const mtype = txMeta && Object.keys(txMeta).length ? txMeta.type : null;
          const counted = addRevenueRow(txMeta, mtype, null, amt, net, dayKey, ref ? String(ref) : null);
          if (counted && txMeta && Object.keys(txMeta).length) {
            if (isTicketPaymentMeta(txMeta, null) && !isRefundedPaymentRef(ref, refundedRefs)) {
              ticketSalesFromPayments += ticketQuantityFromMeta(txMeta);
            }
          }
        }
      }
    }

    const revenueByDaySorted = Object.entries(revenueByDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, amounts]) => ({
        date,
        gross: roundZar(amounts.gross),
        net: roundZar(amounts.net),
      }));

    const ticketSalesCountFromRows =
      isDayBookingsScope || eventIds.length === 0
        ? 0
        : await prisma.ticket.count({
            where: {
              kind: 'EVENT_TICKET',
              eventId: { in: eventIds },
              createdAt: { gte: cutoff },
              hiddenFromHistoryAt: null,
              refundedAt: null,
            },
          });

    const ticketSalesCount = Math.max(ticketSalesCountFromRows, ticketSalesFromPayments);

    const successfulEventTypeCounts = isTicketedEventsScope
      ? { Ticketing: 0, 'Tables at ticketed events': 0 }
      : { Ticketing: 0, 'Table hosting': 0 };
    const successfulEventPeakHours = {};
    for (const eid of eventIdsWithRevenue) {
      const ev = eventById.get(eid);
      if (!ev) continue;
      if (eventId && String(ev.id) !== eventId) continue;
      if (isDayBookingsScope) continue;
      if (isTicketedEventsScope && ev.eventFormat !== 'TICKETING_ONLY') continue;
      if (isTicketedEventsScope) {
        successfulEventTypeCounts.Ticketing += 1;
        if (ticketedEventHasTables(ev)) {
          successfulEventTypeCounts['Tables at ticketed events'] += 1;
        }
      } else {
        const formatLabel = ev.eventFormat === 'TICKETING_ONLY' ? 'Ticketing' : 'Table hosting';
        successfulEventTypeCounts[formatLabel] = (successfulEventTypeCounts[formatLabel] || 0) + 1;
      }
      if (ev.startTime) {
        const hour = parseInt(String(ev.startTime).split(':')[0], 10);
        if (!Number.isNaN(hour)) {
          successfulEventPeakHours[hour] = (successfulEventPeakHours[hour] || 0) + 1;
        }
      }
    }

    // Ticketed scope: only count ticketed events toward peak/avg insights.
    if (isTicketedEventsScope) {
      for (const eid of [...eventIdsWithRevenue]) {
        const ev = eventById.get(eid);
        if (!ev || ev.eventFormat !== 'TICKETING_ONLY') {
          eventIdsWithRevenue.delete(eid);
        }
      }
    }

    let peakHour = null;
    let eventsWithRevenueCount = eventIdsWithRevenue.size;
    let tablesWithRevenueCount = 0;
    let dayBookingTierWithActivity = 0;
    let revenueByTier = [];
    let avgRevenuePerTableZar = 0;
    let avgRevenuePerTableNetZar = 0;

    if (isDayBookingsScope) {
      const bookingHourCounts = {};
      /** @type {Map<string, { tierKey: string, tables: Map<string, { gross: number, net: number }> }>} */
      const tierMap = new Map();

      const bumpTier = (tableId, tableMeta, amt, windowStart, paidAt, joinedAt) => {
        if (!tableId || amt <= 0) return;
        const tierKey = String(tableMeta?.tierLabel || tableMeta?.tableName || tableId);
        if (!tierMap.has(tierKey)) {
          tierMap.set(tierKey, { tierKey, tables: new Map() });
        }
        const tier = tierMap.get(tierKey);
        const netAmt = splitPlatformGross(amt).recipientAmount;
        const prev = tier.tables.get(tableId) || { gross: 0, net: 0 };
        tier.tables.set(tableId, { gross: prev.gross + amt, net: prev.net + netAmt });

        const clock = windowStart || null;
        let hour = null;
        if (clock) {
          const parsed = parseInt(String(clock).split(':')[0], 10);
          if (!Number.isNaN(parsed)) hour = parsed;
        }
        if (hour == null) {
          const when = paidAt || joinedAt;
          if (when) hour = when.getHours();
        }
        if (hour != null) {
          bookingHourCounts[hour] = (bookingHourCounts[hour] || 0) + 1;
        }
      };

      for (const m of dayMembersEarly) {
        const ref = m.paystackReference || null;
        if (ref && isRefundedPaymentRef(ref, refundedRefs)) continue;
        let amt = Number(m.amountPaid) || 0;
        if (amt <= 0 && ref) amt = resolvePaymentAmount(ref);
        if (amt <= 0) continue;
        bumpTier(m.venueTableId, m.venueTable, amt, m.windowStartTime, m.paidAt, m.joinedAt);
      }

      for (const g of dayHostedGuests) {
        const ref = g.paystackReference || null;
        if (ref && isRefundedPaymentRef(ref, refundedRefs)) continue;
        const menuZar = Number(g.menuSpendPaid) || 0;
        if (menuZar <= 0) continue;
        const tableId = g.hostedTable?.venueTableId || g.hostedTable?.venueTable?.id;
        bumpTier(tableId, g.hostedTable?.venueTable, menuZar, null, g.hostReviewedAt, g.joinedAt);
      }

      const tierAvgsGross = [];
      const tierAvgsNet = [];
      let tableCount = 0;
      for (const tier of tierMap.values()) {
        let tierGross = 0;
        let tierNet = 0;
        for (const t of tier.tables.values()) {
          tierGross += t.gross;
          tierNet += t.net;
        }
        const nTables = tier.tables.size;
        if (nTables <= 0) continue;
        tableCount += nTables;
        const avgGross = tierGross / nTables;
        const avgNet = tierNet / nTables;
        tierAvgsGross.push(avgGross);
        tierAvgsNet.push(avgNet);
        revenueByTier.push({
          tierKey: tier.tierKey,
          tableCount: nTables,
          grossZar: roundZar(tierGross),
          netZar: roundZar(tierNet),
          avgPerTable: roundZar(avgGross),
          avgPerTableNet: roundZar(avgNet),
        });
      }

      tablesWithRevenueCount = tableCount;
      dayBookingTierWithActivity = revenueByTier.length;
      avgRevenuePerTableZar =
        tierAvgsGross.length > 0
          ? tierAvgsGross.reduce((s, v) => s + v, 0) / tierAvgsGross.length
          : 0;
      avgRevenuePerTableNetZar =
        tierAvgsNet.length > 0 ? tierAvgsNet.reduce((s, v) => s + v, 0) / tierAvgsNet.length : 0;

      const peakBookingEntry = Object.entries(bookingHourCounts).sort((a, b) => b[1] - a[1])[0];
      peakHour = peakBookingEntry ? `${peakBookingEntry[0]}:00` : null;
      eventsWithRevenueCount = 0;
    } else {
      const peakHourEntry = Object.entries(successfulEventPeakHours).sort((a, b) => b[1] - a[1])[0];
      peakHour = peakHourEntry ? `${peakHourEntry[0]}:00` : null;
    }

    const analyticsPayload = {
      venueId,
      days,
      cutoff: cutoff.toISOString(),
      revenueScope,
      revenueMode,
      grossRevenueZar: roundZar(grossTotal),
      netRevenueZar: roundZar(netTotal),
      ticketSalesCount,
      ticketPaymentZar: roundZar(revenueCounters.ticketPaymentZar),
      ticketPaymentNetZar: roundZar(revenueCounters.ticketPaymentNetZar),
      entrancePaymentZar: roundZar(revenueCounters.entrancePaymentZar),
      entrancePaymentNetZar: roundZar(revenueCounters.entrancePaymentNetZar),
      ticketedTableHostPaymentZar: roundZar(revenueCounters.ticketedTableHostPaymentZar),
      ticketedTableHostPaymentNetZar: roundZar(revenueCounters.ticketedTableHostPaymentNetZar),
      ticketedTableJoinPaymentZar: roundZar(revenueCounters.ticketedTableJoinPaymentZar),
      ticketedTableJoinPaymentNetZar: roundZar(revenueCounters.ticketedTableJoinPaymentNetZar),
      ticketedTableMenuPaymentZar: roundZar(revenueCounters.ticketedTableMenuPaymentZar),
      ticketedTableMenuPaymentNetZar: roundZar(revenueCounters.ticketedTableMenuPaymentNetZar),
      hostedTablePaymentZar: roundZar(revenueCounters.hostedTablePaymentZar),
      hostedTablePaymentNetZar: roundZar(revenueCounters.hostedTablePaymentNetZar),
      dayBookingHostPaymentZar: roundZar(revenueCounters.dayBookingHostPaymentZar),
      dayBookingHostPaymentNetZar: roundZar(revenueCounters.dayBookingHostPaymentNetZar),
      dayBookingGuestPaymentZar: roundZar(revenueCounters.dayBookingGuestPaymentZar),
      dayBookingGuestPaymentNetZar: roundZar(revenueCounters.dayBookingGuestPaymentNetZar),
      dayBookingOtherPaymentZar: 0,
      dayBookingOtherPaymentNetZar: 0,
      dayBookingMenuPaymentZar: roundZar(revenueCounters.dayBookingMenuPaymentZar),
      dayBookingMenuPaymentNetZar: roundZar(revenueCounters.dayBookingMenuPaymentNetZar),
      menuPaymentZar: roundZar(revenueCounters.menuPaymentZar),
      menuPaymentNetZar: roundZar(revenueCounters.menuPaymentNetZar),
      dayBookingVenueJoinFeeVolumeZar: roundZar(dayBookingVenueJoinFeeVolumeZar),
      venueTablePaymentZar: roundZar(revenueCounters.venueTablePaymentZar),
      venueTablePaymentNetZar: roundZar(revenueCounters.venueTablePaymentNetZar),
      otherPaymentZar: 0,
      otherPaymentNetZar: 0,
      refundedGrossZar: roundZar(refundedMetrics.refundedGrossZar),
      refundedVenueShareZar: roundZar(refundedMetrics.refundedVenueShareZar),
      eventsInPeriod,
      upcomingEventsCount,
      eventsWithRevenueCount,
      tablesWithRevenueCount,
      dayBookingTierWithActivity,
      avgRevenuePerTableZar: roundZar(avgRevenuePerTableZar),
      avgRevenuePerTableNetZar: roundZar(avgRevenuePerTableNetZar),
      revenueByTier,
      successfulEventTypeCounts,
      peakHour,
      eventIdsWithRevenue: [...eventIdsWithRevenue],
      revenueByDay: revenueByDaySorted,
      ...(debugAnalytics
        ? {
            debug: {
              memberCount: dayMembersEarly.length,
              hostedGuestCount: dayHostedGuests.length,
              ledgerRows: ledgerRows.length,
              splitLogs: splitLogs.length,
              paymentsConsidered,
              countedRows,
              daySplitBaseRefs: daySplitBaseRefs.size,
            },
          }
        : {}),
    };
    if (String(req.query.debug || '') !== '1') {
      await cacheSetJson(analyticsCacheKey, analyticsPayload, 90);
    }
    res.json(analyticsPayload);
  } catch (e) {
    next(e);
  }
});

router.get('/venue-table-reservations', authenticateToken, async (req, res, next) => {
  try {
    let venueIds = await resolveAccessibleVenueIds(req.userId, venueTablesVenueScope(req));
    if (!venueIds.length) {
      venueIds = await resolveAccessibleVenueIds(req.userId, bookingsVenueScope(req));
    }
    if (!venueIds.length) return res.json({ items: [] });
    const statusFilter = String(req.query.status || 'pending').toLowerCase();
    const statuses =
      statusFilter === 'all'
        ? ['PENDING_VENUE_REVIEW', 'APPROVED', 'DECLINED', 'PENDING_PAYMENT', 'CONFIRMED']
        : statusFilter === 'pending'
          ? ['PENDING_VENUE_REVIEW']
          : ['APPROVED', 'CONFIRMED', 'PENDING_PAYMENT'];
    const members = await prisma.venueTableMember.findMany({
      where: {
        status: { in: statuses },
        venueTable: { venueId: { in: venueIds } },
      },
      include: {
        user: { select: { id: true, fullName: true, userProfile: { select: { username: true, avatarUrl: true } } } },
        venueTable: {
          include: {
            event: { select: { id: true, title: true, date: true } },
            venue: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
      take: 100,
    });
    res.json({
      items: members.map((m) => ({
        id: m.id,
        status: m.status,
        userSpecs: m.userSpecs,
        selectedMenuItems: m.selectedMenuItems,
        declineReason: m.declineReason,
        amountPaid: m.amountPaid,
        joinedAt: m.joinedAt,
        user: {
          id: m.user.id,
          username: m.user.userProfile?.username,
          fullName: m.user.fullName,
          avatarUrl: m.user.userProfile?.avatarUrl,
        },
        table: {
          id: m.venueTable.id,
          tableName: m.venueTable.tableName,
          minimumSpend: m.venueTable.minimumSpend,
          bookingFeeZar: m.venueTable.bookingFeeZar,
          event: m.venueTable.event,
          venue: m.venueTable.venue,
        },
      })),
    });
  } catch (e) {
    next(e);
  }
});

/** Dashboard table booking totals (event + venue/day tables). */
router.get('/dashboard-booking-stats', authenticateToken, async (req, res, next) => {
  try {
    const scope = await requireVenueScope(req, res, 'bookings');
    if (!scope) return;
    const venueIds = scope.venueIds;
    const venueIdFilter = venueIdFromQuery(req.query);
    const bookingStatsCacheKey = `biz:dash-booking:v1:${venueIds.slice().sort().join(',') || 'none'}`;
    if (venueIds.length) {
      const cached = await cacheGetJson(bookingStatsCacheKey);
      if (cached) return res.json(cached);
    }
    if (!venueIds.length) {
      if (venueIdFilter || staffCtxFromQuery(req.query)) {
        return res.status(404).json({ error: 'Venue not found' });
      }
      return res.json({
        totalBookings: 0,
        activeBookings: 0,
        totalGuests: 0,
        ticketsSold: 0,
        ticketRevenueZar: 0,
        entranceFees: 0,
        ticketedTables: 0,
        recentBookings: [],
      });
    }

    const eventsInScope = await prisma.event.findMany({
      where: { venueId: { in: venueIds }, deletedAt: null },
      select: { id: true },
    });
    const eventIds = eventsInScope.map((e) => e.id);

    let eventTableCount = 0;
    let eventGoingHeadcount = 0;
    let eventActiveBookings = 0;
    let recentEventBookings = [];

    if (eventIds.length) {
      let refundedRefs = new Set();
      try {
        refundedRefs = await loadRefundedPaymentRefs(venueIds);
      } catch (e) {
        logger.warn('dashboard-booking-stats refunded refs failed', { err: e?.message });
      }

      const hostedInScope = await prisma.hostedTable.findMany({
        where: { eventId: { in: eventIds }, tableType: 'IN_APP_EVENT' },
        select: { id: true, status: true, tableName: true, guestQuantity: true, spotsRemaining: true },
      });
      const hostedIds = hostedInScope.map((h) => h.id);
      const hostedById = new Map(hostedInScope.map((h) => [h.id, h]));

      const hostBookingRows = await prisma.eventVenueTableBooking.findMany({
        where: {
          venueId: { in: venueIds },
          eventId: { in: eventIds },
          role: 'HOST',
        },
        select: { hostedTableId: true, paystackReference: true },
      });
      const refundedHostedTableIds = new Set(
        hostBookingRows
          .filter(
            (r) =>
              r.hostedTableId &&
              r.paystackReference &&
              isRefundedPaymentRef(r.paystackReference, refundedRefs),
          )
          .map((r) => r.hostedTableId),
      );

      eventActiveBookings = hostedInScope.filter(
        (h) =>
          (h.status === 'ACTIVE' || h.status === 'FULL') &&
          !refundedHostedTableIds.has(h.id),
      ).length;

      const activeHostedIdsExRefunded = hostedIds.filter((id) => !refundedHostedTableIds.has(id));
      if (activeHostedIdsExRefunded.length) {
        eventGoingHeadcount = await prisma.hostedTableMember.count({
          where: { hostedTableId: { in: activeHostedIdsExRefunded }, status: 'GOING' },
        });
        const pendingJoin = await prisma.hostedTableMember.count({
          where: { hostedTableId: { in: activeHostedIdsExRefunded }, status: 'PENDING' },
        });
        eventActiveBookings += pendingJoin;
      }

      const bookingRows = await prisma.eventVenueTableBooking.findMany({
        where: { venueId: { in: venueIds }, eventId: { in: eventIds } },
        select: {
          id: true,
          role: true,
          createdAt: true,
          hostedTableId: true,
          event: { select: { title: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      eventTableCount = new Set(bookingRows.map((r) => r.hostedTableId).filter(Boolean)).size;

      const eventGroups = groupEventTableBookingsByTable(
        bookingRows
          .filter((r) => r.hostedTableId)
          .map((r) => {
            const ht = hostedById.get(r.hostedTableId);
            return {
              id: r.id,
              role: r.role,
              createdAt: r.createdAt,
              lineTotalZar: 0,
              hostedTable: ht
                ? {
                    id: ht.id,
                    tableName: ht.tableName,
                    status: ht.status,
                    guestQuantity: ht.guestQuantity,
                    spotsRemaining: ht.spotsRemaining,
                  }
                : { id: r.hostedTableId },
              event: r.event,
            };
          }),
      );
      recentEventBookings = eventGroups.slice(0, 5).map((g) => ({
        id: g.id,
        type: 'event',
        tableName: g.hostedTable?.tableName || 'Event table',
        guestCount: (g.rolesSummary?.hosts || 0) + (g.rolesSummary?.guests || 0),
        capacity: g.hostedTable?.guestQuantity || null,
        status: g.hostRefundStatus === 'REFUNDED' ? 'REFUNDED' : g.hostedTable?.status || 'ACTIVE',
        subLabel: g.event?.title || 'Event',
        sortAt: g.lastActivityAt,
      }));
    }

    const venueConfirmedMembers = await prisma.venueTableMember.findMany({
      where: {
        status: 'CONFIRMED',
        venueTable: { venueId: { in: venueIds } },
      },
      select: {
        id: true,
        paidAt: true,
        joinedAt: true,
        venueTable: {
          select: {
            id: true,
            tableName: true,
            minimumSpend: true,
            status: true,
            currentOccupancy: true,
            guestCapacity: true,
          },
        },
      },
      orderBy: { paidAt: 'desc' },
      take: 120,
    });

    const venueTableIds = new Set(venueConfirmedMembers.map((m) => m.venueTable.id));
    const venueGuestCount = venueConfirmedMembers.length;

    const venuePendingCount = await prisma.venueTableMember.count({
      where: {
        status: { in: ['PENDING_VENUE_REVIEW', 'PENDING_PAYMENT', 'APPROVED'] },
        venueTable: { venueId: { in: venueIds } },
      },
    });

    const venueActiveTables = await prisma.venueTable.count({
      where: {
        venueId: { in: venueIds },
        status: { in: ['PARTIALLY_FILLED', 'FULL'] },
      },
    });

    const tableOccupancy = new Map();
    for (const m of venueConfirmedMembers) {
      const tid = m.venueTable.id;
      tableOccupancy.set(tid, (tableOccupancy.get(tid) || 0) + 1);
    }

    const recentVenueBookings = [...tableOccupancy.entries()]
      .map(([tableId, count]) => {
        const member = venueConfirmedMembers.find((m) => m.venueTable.id === tableId);
        const table = member?.venueTable;
        if (!table) return null;
        return {
          id: tableId,
          type: 'venue',
          tableName: table.tableName || 'Table',
          guestCount: count,
          capacity: table.guestCapacity || null,
          status: table.status,
          subLabel: table.minimumSpend ? `Min spend: R${table.minimumSpend}` : 'Venue table',
          sortAt: member.paidAt || member.joinedAt,
        };
      })
      .filter(Boolean);

    // Unified cap: merge event + venue/day bookings, sort by latest activity, return top 5 only.
    let recentTicketActivity = [];
    if (eventIds.length) {
      const recentTickets = await prisma.ticket.findMany({
        where: {
          kind: 'EVENT_TICKET',
          eventId: { in: eventIds },
          hiddenFromHistoryAt: null,
          refundedAt: null,
        },
        select: {
          id: true,
          createdAt: true,
          event: { select: { title: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      recentTicketActivity = recentTickets.map((t) => ({
        id: `ticket-${t.id}`,
        type: 'ticket',
        tableName: 'Ticket order',
        guestCount: 1,
        capacity: null,
        status: 'PAID',
        subLabel: t.event?.title || 'Ticketed event',
        sortAt: t.createdAt,
      }));
    }

    const recentBookings = [...recentEventBookings, ...recentVenueBookings, ...recentTicketActivity]
      .sort((a, b) => new Date(b.sortAt).getTime() - new Date(a.sortAt).getTime())
      .slice(0, 5)
      .map(({ sortAt, ...rest }) => rest);

    let ticketsSold = 0;
    let ticketRevenueZar = 0;
    let entranceFees = 0;
    let ticketedTables = 0;
    if (eventIds.length) {
      try {
        const soldTickets = await prisma.ticket.findMany({
          where: {
            kind: 'EVENT_TICKET',
            eventId: { in: eventIds },
            hiddenFromHistoryAt: null,
            refundedAt: null,
          },
          select: { paystackReference: true },
          take: 20000,
        });
        ticketsSold = soldTickets.length;
        const ticketRefs = [
          ...new Set(soldTickets.map((t) => basePaystackRef(t.paystackReference)).filter(Boolean)),
        ];
        if (ticketRefs.length) {
          const ticketPayments = await prisma.payment.findMany({
            where: {
              reference: { in: ticketRefs },
              status: 'success',
              type: { in: ['ticket', 'event'] },
            },
            select: { amount: true },
          });
          ticketRevenueZar = roundZar(
            ticketPayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
          );
        }
        entranceFees = await prisma.ticket.count({
          where: {
            kind: 'EVENT_ENTRANCE',
            eventId: { in: eventIds },
            hiddenFromHistoryAt: null,
            refundedAt: null,
          },
        });
        const ticketingEvents = await prisma.event.findMany({
          where: { id: { in: eventIds }, eventFormat: 'TICKETING_ONLY', deletedAt: null },
          select: { id: true, eventFormat: true, hostingConfig: true },
        });
        const ticketedTableEventIds = ticketingEvents.filter((e) => ticketedEventHasTables(e)).map((e) => e.id);
        if (ticketedTableEventIds.length) {
          const rows = await prisma.eventVenueTableBooking.findMany({
            where: {
              venueId: { in: venueIds },
              eventId: { in: ticketedTableEventIds },
              role: { in: ['HOST', 'GUEST'] },
              hostedTableId: { not: null },
            },
            select: { hostedTableId: true },
          });
          ticketedTables = new Set(rows.map((r) => r.hostedTableId).filter(Boolean)).size;
        }
      } catch (e) {
        logger.warn('dashboard-booking-stats ticket stats failed', { err: e?.message });
      }
    }

    const bookingStatsPayload = {
      totalBookings: eventTableCount + venueTableIds.size,
      activeBookings: eventActiveBookings + venueActiveTables + venuePendingCount,
      totalGuests: eventGoingHeadcount + venueGuestCount,
      ticketsSold,
      ticketRevenueZar,
      entranceFees,
      ticketedTables,
      recentBookings,
    };
    await cacheSetJson(bookingStatsCacheKey, bookingStatsPayload, 60);
    res.json(bookingStatsPayload);
  } catch (e) {
    next(e);
  }
});

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function emptyMonthlyBuckets() {
  return MONTH_LABELS.map((label, i) => ({
    month: i + 1,
    label,
    events: 0,
    bookings: 0,
    guests: 0,
    ticketsSold: 0,
    ticketRevenueZar: 0,
    entranceFees: 0,
    ticketedTables: 0,
  }));
}

/** Bucket a date into 1–12; when year is set, returns null if the date is outside that year. */
function bucketMonth(dateValue, year = null) {
  if (!dateValue) return null;
  let y;
  let m;
  if (dateValue instanceof Date) {
    y = dateValue.getUTCFullYear();
    m = dateValue.getUTCMonth() + 1;
  } else {
    const s = String(dateValue);
    const match = s.match(/^(\d{4})-(\d{2})/);
    if (match) {
      y = parseInt(match[1], 10);
      m = parseInt(match[2], 10);
    } else {
      const d = new Date(dateValue);
      if (Number.isNaN(d.getTime())) return null;
      y = d.getUTCFullYear();
      m = d.getUTCMonth() + 1;
    }
  }
  if (year != null && y !== year) return null;
  return m;
}

/** Venue dashboard stats — aligned with dashboard-booking-stats, with monthly buckets. */
async function computeVenueDashboardStats(venueIds, year) {
  const months = emptyMonthlyBuckets();
  const allTime = {
    events: 0,
    bookings: 0,
    guests: 0,
    ticketsSold: 0,
    ticketRevenueZar: 0,
    entranceFees: 0,
    ticketedTables: 0,
  };

  const bump = (month, field, amount = 1) => {
    if (month && month >= 1 && month <= 12) months[month - 1][field] += amount;
  };

  const eventsInScope = await prisma.event.findMany({
    where: { venueId: { in: venueIds }, deletedAt: null },
    select: { id: true, date: true, eventFormat: true, hostingConfig: true },
  });
  const eventIds = eventsInScope.map((e) => e.id);
  const ticketedTableEventIds = eventsInScope.filter((e) => ticketedEventHasTables(e)).map((e) => e.id);

  allTime.events = eventsInScope.length;
  for (const ev of eventsInScope) {
    bump(bucketMonth(ev.date, year), 'events');
  }

  const allEventTableIds = new Set();
  const eventTablesByMonth = Array.from({ length: 12 }, () => new Set());

  if (eventIds.length) {
    const hostedInScope = await prisma.hostedTable.findMany({
      where: { eventId: { in: eventIds }, tableType: 'IN_APP_EVENT' },
      select: { id: true },
    });
    const hostedIds = hostedInScope.map((h) => h.id);

    const bookingRows = await prisma.eventVenueTableBooking.findMany({
      where: { venueId: { in: venueIds }, eventId: { in: eventIds } },
      select: { hostedTableId: true, createdAt: true },
    });

    for (const row of bookingRows) {
      if (!row.hostedTableId) continue;
      allEventTableIds.add(row.hostedTableId);
      const m = bucketMonth(row.createdAt, year);
      if (m) eventTablesByMonth[m - 1].add(row.hostedTableId);
    }

    if (hostedIds.length) {
      const goingMembers = await prisma.hostedTableMember.findMany({
        where: { hostedTableId: { in: hostedIds }, status: 'GOING' },
        select: { joinedAt: true },
      });
      for (const g of goingMembers) {
        allTime.guests += 1;
        bump(bucketMonth(g.joinedAt, year), 'guests');
      }
    }
  }

  const allVenueTableIds = new Set();
  const venueTablesByMonth = Array.from({ length: 12 }, () => new Set());

  const venueMembers = await prisma.venueTableMember.findMany({
    where: {
      status: 'CONFIRMED',
      venueTable: { venueId: { in: venueIds } },
    },
    select: { venueTableId: true, paidAt: true, joinedAt: true },
  });

  for (const member of venueMembers) {
    allVenueTableIds.add(member.venueTableId);
    allTime.guests += 1;
    const at = member.paidAt || member.joinedAt;
    const m = bucketMonth(at, year);
    if (m) venueTablesByMonth[m - 1].add(member.venueTableId);
    bump(bucketMonth(at, year), 'guests');
  }

  allTime.bookings = allEventTableIds.size + allVenueTableIds.size;

  for (let i = 0; i < 12; i++) {
    months[i].bookings = eventTablesByMonth[i].size + venueTablesByMonth[i].size;
  }

  // Tickets sold + ticket revenue (gross) for venue events.
  if (eventIds.length) {
    const tickets = await prisma.ticket.findMany({
      where: {
        kind: 'EVENT_TICKET',
        eventId: { in: eventIds },
        hiddenFromHistoryAt: null,
        refundedAt: null,
      },
      select: { createdAt: true, paystackReference: true },
      take: 20000,
    });
    allTime.ticketsSold = tickets.length;
    for (const t of tickets) {
      bump(bucketMonth(t.createdAt, year), 'ticketsSold');
    }

    const ticketRefs = [
      ...new Set(tickets.map((t) => basePaystackRef(t.paystackReference)).filter(Boolean)),
    ];
    if (ticketRefs.length) {
      const ticketPayments = await prisma.payment.findMany({
        where: {
          reference: { in: ticketRefs },
          status: 'success',
          type: { in: ['ticket', 'event'] },
        },
        select: { amount: true, createdAt: true, reference: true },
      });
      for (const p of ticketPayments) {
        const amt = Number(p.amount) || 0;
        allTime.ticketRevenueZar += amt;
        bump(bucketMonth(p.createdAt, year), 'ticketRevenueZar', amt);
      }
    }
  }

  // Entrance fees (EVENT_ENTRANCE tickets / bookings).
  if (eventIds.length) {
    const entranceTickets = await prisma.ticket.findMany({
      where: {
        kind: 'EVENT_ENTRANCE',
        eventId: { in: eventIds },
        hiddenFromHistoryAt: null,
        refundedAt: null,
      },
      select: { createdAt: true },
      take: 10000,
    });
    allTime.entranceFees = entranceTickets.length;
    for (const t of entranceTickets) {
      bump(bucketMonth(t.createdAt, year), 'entranceFees');
    }
  }

  // Ticketed tables — unique hosted tables on TICKETING_ONLY events with HOST/GUEST activity.
  if (ticketedTableEventIds.length) {
    const ticketedTableBookings = await prisma.eventVenueTableBooking.findMany({
      where: {
        venueId: { in: venueIds },
        eventId: { in: ticketedTableEventIds },
        role: { in: ['HOST', 'GUEST'] },
        hostedTableId: { not: null },
      },
      select: { hostedTableId: true, createdAt: true },
    });
    const allTicketedTables = new Set();
    const ticketedTablesByMonth = Array.from({ length: 12 }, () => new Set());
    for (const row of ticketedTableBookings) {
      if (!row.hostedTableId) continue;
      allTicketedTables.add(row.hostedTableId);
      const m = bucketMonth(row.createdAt, year);
      if (m) ticketedTablesByMonth[m - 1].add(row.hostedTableId);
    }
    allTime.ticketedTables = allTicketedTables.size;
    for (let i = 0; i < 12; i++) {
      months[i].ticketedTables = ticketedTablesByMonth[i].size;
    }
  }

  const yearTotal = {
    events: months.reduce((sum, m) => sum + m.events, 0),
    bookings: months.reduce((sum, m) => sum + m.bookings, 0),
    guests: months.reduce((sum, m) => sum + m.guests, 0),
    ticketsSold: months.reduce((sum, m) => sum + m.ticketsSold, 0),
    ticketRevenueZar: roundZar(months.reduce((sum, m) => sum + m.ticketRevenueZar, 0)),
    entranceFees: months.reduce((sum, m) => sum + m.entranceFees, 0),
    ticketedTables: months.reduce((sum, m) => sum + m.ticketedTables, 0),
  };

  allTime.ticketRevenueZar = roundZar(allTime.ticketRevenueZar);
  for (const m of months) {
    m.ticketRevenueZar = roundZar(m.ticketRevenueZar);
  }

  const reviewAgg = await prisma.venueReview.aggregate({
    where: { venueId: { in: venueIds } },
    _avg: { rating: true },
    _count: { id: true },
  });

  return {
    months,
    yearTotal,
    allTime,
    averageRating: reviewAgg._avg.rating != null ? Number(reviewAgg._avg.rating) : null,
    reviewCount: reviewAgg._count.id ?? 0,
  };
}

/** Monthly venue stats (Jan–Dec) for dashboard month picker; average rating is all-time. */
router.get('/dashboard-monthly-stats', authenticateToken, async (req, res, next) => {
  try {
    const scopeOpts = {
      staffCtx: staffCtxFromQuery(req.query),
      venueIdFilter: venueIdFromQuery(req.query),
    };
    let scope = await resolveBusinessVenueScope(req.userId, { ...scopeOpts, permission: 'bookings' });
    if (!scope.ok) {
      scope = await resolveBusinessVenueScope(req.userId, { ...scopeOpts, permission: 'events' });
    }
    if (!scope.ok) {
      scope = await resolveBusinessVenueScope(req.userId, { ...scopeOpts, permission: 'analytics' });
    }
    if (!scope.ok) {
      return res.status(scope.status).json({ error: scope.error });
    }
    const venueIds = scope.venueIds;
    const venueIdFilter = venueIdFromQuery(req.query);
    const year = Math.min(2100, Math.max(2000, parseInt(req.query.year, 10) || new Date().getFullYear()));
    const monthlyCacheKey = `biz:dash-monthly:v1:${venueIds.slice().sort().join(',') || 'none'}:${year}`;
    if (venueIds.length) {
      const cached = await cacheGetJson(monthlyCacheKey);
      if (cached) return res.json(cached);
    }

    if (!venueIds.length) {
      if (venueIdFilter || staffCtxFromQuery(req.query)) {
        return res.status(404).json({ error: 'Venue not found' });
      }
      return res.json({
        year,
        months: emptyMonthlyBuckets(),
        yearTotal: {
          events: 0,
          bookings: 0,
          guests: 0,
          ticketsSold: 0,
          ticketRevenueZar: 0,
          entranceFees: 0,
          ticketedTables: 0,
        },
        allTime: {
          events: 0,
          bookings: 0,
          guests: 0,
          ticketsSold: 0,
          ticketRevenueZar: 0,
          entranceFees: 0,
          ticketedTables: 0,
        },
        averageRating: null,
        reviewCount: 0,
      });
    }

    let stats;
    try {
      stats = await computeVenueDashboardStats(venueIds, year);
    } catch (e) {
      logger.warn('dashboard-monthly-stats compute failed', { err: e?.message, year });
      stats = {
        months: emptyMonthlyBuckets(),
        yearTotal: {
          events: 0,
          bookings: 0,
          guests: 0,
          ticketsSold: 0,
          ticketRevenueZar: 0,
          entranceFees: 0,
          ticketedTables: 0,
        },
        allTime: {
          events: 0,
          bookings: 0,
          guests: 0,
          ticketsSold: 0,
          ticketRevenueZar: 0,
          entranceFees: 0,
          ticketedTables: 0,
        },
        averageRating: null,
        reviewCount: 0,
      };
    }

    const monthlyPayload = {
      year,
      ...stats,
    };
    await cacheSetJson(monthlyCacheKey, monthlyPayload, 90);
    res.json(monthlyPayload);
  } catch (e) {
    next(e);
  }
});

/** Paid day table bookings (incl. custom tables after guest checkout). */
router.get('/venue-table-bookings', authenticateToken, async (req, res, next) => {
  try {
    const venueIdFilter = venueIdFromQuery(req.query);
    const venueIds = await resolveAccessibleVenueIds(req.userId, bookingsVenueScope(req));
    if (!venueIds.length) {
      if (venueIdFilter) return res.status(404).json({ error: 'Venue not found' });
      return res.json({ items: [] });
    }
    const members = await prisma.venueTableMember.findMany({
      where: {
        paystackReference: { not: null },
        status: { in: ['CONFIRMED', 'LEFT', 'REFUNDED'] },
        venueTable: { venueId: { in: venueIds }, eventId: null },
      },
      include: {
        user: { select: { id: true, fullName: true, username: true, userProfile: { select: { username: true } } } },
        venueTable: {
          include: {
            venue: { select: { id: true, name: true, city: true } },
          },
        },
      },
      orderBy: { paidAt: 'desc' },
      take: 200,
    });

    const hostedTableIds = [
      ...new Set(members.map((m) => m.venueTable.hostedTableId).filter(Boolean)),
    ];
    const hostedById = new Map();
    if (hostedTableIds.length) {
      const hostedRows = await prisma.hostedTable.findMany({
        where: { id: { in: hostedTableIds } },
        select: {
          id: true,
          status: true,
          windowEndsAt: true,
          eventDate: true,
          eventTime: true,
          venueTableId: true,
        },
      });
      for (const ht of hostedRows) hostedById.set(ht.id, ht);
    }

    const refundedRefs = await loadRefundedPaymentRefs(venueIds);
    const sessionScope = String(req.query.session_scope || 'active').toLowerCase();
    const includePast = String(req.query.include_past || '') === '1';
    const effectiveScope = includePast ? 'past' : sessionScope;

    const mapped = members
      .filter((m) => {
        if (!memberBelongsToTodaySast(m, m.venueTable)) return false;
        const hostedTable = m.venueTable.hostedTableId
          ? hostedById.get(m.venueTable.hostedTableId) || null
          : null;
        const ended = isDayBookingSessionEnded(m, m.venueTable, hostedTable);
        if (effectiveScope === 'past') return ended;
        return !ended;
      })
      .map((m) => {
        const sessionNumber = inferMemberSessionNumber(m, m.venueTable);
        const hostedTable = m.venueTable.hostedTableId
          ? hostedById.get(m.venueTable.hostedTableId) || null
          : null;
        const isRefunded =
          m.status === 'REFUNDED' ||
          (m.paystackReference && isRefundedPaymentRef(m.paystackReference, refundedRefs));
        return {
          id: m.id,
          status: m.status,
          refundStatus: isRefunded ? 'APPROVED' : null,
          amountPaid: isRefunded ? 0 : m.amountPaid,
          settlementMode: m.settlementMode,
          selectedMenuItems: m.selectedMenuItems,
          userSpecs: m.userSpecs,
          joinedAt: m.joinedAt,
          paidAt: m.paidAt,
          memberRole: m.memberRole,
          paystackReference: m.paystackReference,
          sessionNumber,
          user: mapUserBrief(m.user),
          table: {
            id: m.venueTable.id,
            tableName: m.venueTable.tableName,
            minimumSpend: m.venueTable.minimumSpend,
            isCustomListing: m.venueTable.isCustomListing,
            status: m.venueTable.status,
            currentOccupancy: m.venueTable.currentOccupancy,
            serviceDate: m.venueTable.serviceDate,
            serviceEndDate: m.venueTable.serviceEndDate,
            startTime: m.venueTable.startTime,
            endTime: m.venueTable.endTime,
            hostUserId: m.venueTable.hostUserId,
            hostedTableId: m.venueTable.hostedTableId,
            tableSessionNumber: resolveDailySessionNumber(m.venueTable),
            venue: m.venueTable.venue,
            canRelease: m.status === 'CONFIRMED' && computeCanRelease(m.venueTable, hostedTable),
          },
          sessionEnded: isDayBookingSessionEnded(m, m.venueTable, hostedTable),
        };
      });

    const sessionGroups = new Map();
    for (const row of mapped) {
      const key = `${row.table?.id}:${row.sessionNumber ?? 1}`;
      const existing = sessionGroups.get(key);
      if (!existing) {
        sessionGroups.set(key, row);
        continue;
      }
      const preferRow =
        row.memberRole === 'HOST' && existing.memberRole !== 'HOST'
          ? row
          : Number(row.amountPaid || 0) > Number(existing.amountPaid || 0)
            ? row
            : existing;
      sessionGroups.set(key, preferRow);
    }

    const q = normalizeGuestSearch(req.query.q);
    let items = [...sessionGroups.values()];
    if (q) {
      items = items.filter((row) =>
        guestRecordMatchesSearch(
          {
            username: row.user?.username,
            fullName: row.user?.fullName,
            tableName: row.table?.tableName,
            eventTitle: row.table?.venue?.name,
          },
          q,
        ),
      );
    }

    const fulfillMap = await fulfillmentMapForReferences(
      prisma,
      items.map((row) => row.paystackReference),
    );
    items = items.map((row) => {
      const menuItems = parseMenuItemLines(row.selectedMenuItems);
      const f = fulfillMap.get(canonicalOrderReference(row.paystackReference));
      const hasServeableOrder =
        menuItems.length > 0 ||
        ['PREPAY_MENU', 'PREPAY_LUMP'].includes(String(row.settlementMode || ''));
      return {
        ...row,
        menuItems,
        hasServeableOrder,
        orderFulfilled: Boolean(f),
        orderFulfilledAt: f?.fulfilledAt || null,
      };
    });

    res.json({ items });
  } catch (e) {
    next(e);
  }
});

/** Business read-only session detail for event/day table bookings (past, reset, or live). */
router.get('/table-booking-detail', authenticateToken, async (req, res, next) => {
  try {
    const hostedTableId =
      typeof req.query.hosted_table_id === 'string' ? req.query.hosted_table_id.trim() : '';
    const venueTableId =
      typeof req.query.venue_table_id === 'string' ? req.query.venue_table_id.trim() : '';
    const sessionNumber = Math.max(1, Number(req.query.session) || 1);

    if (hostedTableId && isSyntheticHostedId(hostedTableId)) {
      return res.status(400).json({ error: 'Invalid hosted table id' });
    }
    if (!hostedTableId && !venueTableId) {
      return res.status(400).json({ error: 'hosted_table_id or venue_table_id is required' });
    }

    const receipt = await buildTableSessionReceipt({
      hostedTableId: hostedTableId || null,
      venueTableId: venueTableId || null,
      sessionNumber,
    });
    if (!receipt) return res.status(404).json({ error: 'Table not found' });

    const canManage = await staffHasVenuePermission(req.userId, receipt.venueId, 'bookings');
    if (!canManage) return res.status(403).json({ error: 'Forbidden' });

    res.json(receipt);
  } catch (e) {
    next(e);
  }
});

function basePaystackRef(ref) {
  return basePaymentReference(ref).replace(/-\d+$/, '');
}

function emptyTicketBookingsSummary() {
  return {
    orderCount: 0,
    ticketCount: 0,
    admittedCount: 0,
    totalRevenueZar: 0,
    totalVenueShareZar: 0,
    totalGrossZar: 0,
    tableGroupCount: 0,
    tablePaidZar: 0,
  };
}

function venueShareFromPayment(pay) {
  const meta = pay?.metadata && typeof pay.metadata === 'object' ? pay.metadata : {};
  if (meta.venue_share_zar != null) return Number(meta.venue_share_zar) || 0;
  if (meta.recipient_amount != null) return Number(meta.recipient_amount) || 0;
  const gross = Number(pay?.amount) || 0;
  return splitPlatformGross(gross).recipientAmount;
}

function platformFeeFromPayment(pay) {
  const meta = pay?.metadata && typeof pay.metadata === 'object' ? pay.metadata : {};
  if (meta.platform_fee_zar != null) return Number(meta.platform_fee_zar) || 0;
  if (meta.sec_amount != null) return Number(meta.sec_amount) || 0;
  const gross = Number(pay?.amount) || 0;
  return splitPlatformGross(gross).secAmount;
}

function paymentEventId(meta) {
  const m = flattenPaymentMetadata(meta);
  return m.event_id || m.eventId || null;
}

async function repairTicketPaymentsForVenues(venueIds) {
  if (!venueIds.length) return;
  const { ensureEventTicketsForPayment } = await import('../lib/issueEventTickets.js');
  const events = await prisma.event.findMany({
    where: { venueId: { in: venueIds }, deletedAt: null },
    select: { id: true },
  });
  const eventIds = new Set(events.map((e) => e.id));
  if (!eventIds.size) return;

  const payments = await prisma.payment.findMany({
    where: {
      status: { in: ['success', 'pending'] },
      type: { in: ['ticket', 'event'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 80,
    select: { reference: true, metadata: true },
  });

  const toRepair = payments.filter((p) => {
    const eid = paymentEventId(p.metadata);
    return eid && eventIds.has(String(eid));
  });

  await Promise.all(
    toRepair.map((p) =>
      ensureEventTicketsForPayment(p.reference, { status: 'success' }).catch(() => null),
    ),
  );
}

/** Ticket purchases for events at venues the user owns or staffs. */
router.get('/ticket-bookings', authenticateToken, async (req, res, next) => {
  try {
    const venueIdFilter = venueIdFromQuery(req.query);
    const scopedVenueIds = await resolveAccessibleVenueIds(req.userId, bookingsVenueScope(req));
    if (!scopedVenueIds.length) {
      if (venueIdFilter) return res.status(404).json({ error: 'Venue not found' });
      return res.json({ items: [], eventSummaries: [], summary: emptyTicketBookingsSummary() });
    }

    await repairTicketPaymentsForVenues(scopedVenueIds);

    const refundedRefs = await loadRefundedPaymentRefs(scopedVenueIds);

    const eventIdFilter =
      typeof req.query.event_id === 'string' && req.query.event_id.trim()
        ? req.query.event_id.trim()
        : null;
    const scopeRaw = String(req.query.event_scope || 'active').toLowerCase();
    const eventScope = ['active', 'past', 'all'].includes(scopeRaw) ? scopeRaw : 'active';
    const now = new Date();

    const eventWhereBase = {
      venueId: { in: scopedVenueIds },
      deletedAt: null,
      ...(eventIdFilter ? { id: eventIdFilter } : {}),
    };

    if (eventIdFilter) {
      const ev = await prisma.event.findFirst({
        where: eventWhereBase,
        select: {
          id: true,
          title: true,
          date: true,
          startTime: true,
          endsAt: true,
          city: true,
          ticketTiers: true,
          eventFormat: true,
          hostingConfig: true,
        },
      });
      if (!ev) return res.status(404).json({ error: 'Event not found' });
      const isPast = eventIsPastByEndsAt(ev, now);
      if (eventScope === 'active' && isPast) {
        return res.json({
          items: [],
          tableGroups: [],
          eventSummaries: [],
          summary: emptyTicketBookingsSummary(),
          eventScope,
          notice: 'past_event_use_past_scope',
        });
      }
      if (eventScope === 'past' && !isPast) {
        return res.json({
          items: [],
          tableGroups: [],
          eventSummaries: [],
          summary: emptyTicketBookingsSummary(),
          eventScope,
          notice: 'upcoming_event_use_active_scope',
        });
      }
    }

    let eventsAtVenue = await prisma.event.findMany({
      where: eventWhereBase,
      select: {
        id: true,
        title: true,
        date: true,
        startTime: true,
        endsAt: true,
        city: true,
        ticketTiers: true,
        eventFormat: true,
        hostingConfig: true,
      },
    });
    if (eventScope === 'active') {
      eventsAtVenue = eventsAtVenue.filter((e) => eventIsActiveByEndsAt(e, now));
    } else if (eventScope === 'past') {
      eventsAtVenue = eventsAtVenue.filter((e) => eventIsPastByEndsAt(e, now));
    }
    const eventIds = eventsAtVenue.map((e) => e.id);

    const ticketWhere =
      eventIds.length > 0
        ? {
            kind: 'EVENT_TICKET',
            hiddenFromHistoryAt: null,
            refundedAt: null,
            eventId: { in: eventIds },
          }
        : null;

    const [ticketCount, admittedCount, tickets] = ticketWhere
      ? await Promise.all([
          prisma.ticket.count({ where: ticketWhere }),
          prisma.ticket.count({ where: { ...ticketWhere, admittedAt: { not: null } } }),
          prisma.ticket.findMany({
            where: ticketWhere,
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  username: true,
                  userProfile: { select: { username: true, avatarUrl: true } },
                },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 2000,
          }),
        ])
      : [0, 0, []];

    const eventById = new Map(eventsAtVenue.map((e) => [e.id, e]));
    const ticketEventIds = new Set(tickets.map((t) => t.eventId).filter(Boolean));

    const refs = [...new Set(tickets.map((t) => basePaystackRef(t.paystackReference)).filter(Boolean))];
    const paymentsByRef =
      refs.length > 0
        ? await prisma.payment.findMany({
            where: { reference: { in: refs }, status: 'success' },
            select: {
              reference: true,
              amount: true,
              metadata: true,
              createdAt: true,
              userId: true,
              email: true,
            },
          })
        : [];
    const paymentByRef = new Map(paymentsByRef.map((p) => [p.reference, p]));

    const groups = new Map();
    for (const t of tickets) {
      const baseRef = basePaystackRef(t.paystackReference);
      const ev = t.eventId ? eventById.get(t.eventId) : null;
      if (!groups.has(baseRef)) {
        const pay = paymentByRef.get(baseRef);
        const meta = flattenPaymentMetadata(pay?.metadata);
        groups.set(baseRef, {
          id: baseRef,
          paystackReference: baseRef,
          event: ev
            ? { id: ev.id, title: ev.title, date: ev.date, startTime: ev.startTime, city: ev.city }
            : { id: t.eventId, title: t.title, date: null, startTime: null, city: null },
          tierName: t.subtitle || meta.ticket_tier_name || 'Ticket',
          purchaser: {
            id: t.user.id,
            username: t.user.userProfile?.username || t.user.username,
            fullName: t.user.fullName,
            avatarUrl: t.user.userProfile?.avatarUrl || null,
          },
          tickets: [],
          quantity: 0,
          admittedCount: 0,
          grossPaidZar: pay ? Number(pay.amount) || 0 : 0,
          venueShareZar: pay ? venueShareFromPayment(pay) : 0,
          platformFeeZar: pay ? platformFeeFromPayment(pay) : 0,
          amountPaidZar: pay ? Number(pay.amount) || 0 : 0,
          purchasedAt: pay?.createdAt || t.createdAt,
          menuAddons: parseMenuItemLines(meta.selected_menu_items ?? meta.selectedMenuItems),
          menuZar: Number(meta.menu_zar || meta.menu_total_zar || 0),
          fulfillmentPending: false,
        });
      }
      const g = groups.get(baseRef);
      g.tickets.push({
        id: t.id,
        holderDisplayName: t.holderDisplayName,
        admittedAt: t.admittedAt,
        qrToken: t.qrToken,
      });
      g.quantity += 1;
      if (t.admittedAt) g.admittedCount += 1;
    }

    const scopedEventIds = new Set(eventsAtVenue.map((e) => e.id));
    const recentPayments = await prisma.payment.findMany({
      where: { status: 'success', type: { in: ['ticket', 'event'] } },
      orderBy: { createdAt: 'desc' },
      take: 400,
      select: {
        reference: true,
        amount: true,
        metadata: true,
        createdAt: true,
        userId: true,
        email: true,
      },
    });

    const paymentOnlyRefs = recentPayments.filter((pay) => {
      if (groups.has(pay.reference)) return false;
      const eid = paymentEventId(pay.metadata);
      return eid && scopedEventIds.has(String(eid));
    });

    const payerIds = [...new Set(paymentOnlyRefs.map((p) => p.userId).filter(Boolean))];
    const payers =
      payerIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: payerIds } },
            select: {
              id: true,
              fullName: true,
              username: true,
              email: true,
              userProfile: { select: { username: true, avatarUrl: true } },
            },
          })
        : [];
    const payerById = new Map(payers.map((u) => [u.id, u]));

    for (const pay of paymentOnlyRefs) {
      const eid = paymentEventId(pay.metadata);
      const ev = eid ? eventById.get(String(eid)) : null;
      if (!ev) continue;
      const meta = flattenPaymentMetadata(pay.metadata);
      const payer = payerById.get(pay.userId);
      const qty = Math.max(1, parseInt(String(meta.quantity || '1'), 10) || 1);
      groups.set(pay.reference, {
        id: pay.reference,
        paystackReference: pay.reference,
        event: {
          id: ev.id,
          title: ev.title,
          date: ev.date,
          startTime: ev.startTime,
          city: ev.city,
        },
        tierName: meta.ticket_tier_name || meta.ticketTierName || 'Ticket',
        purchaser: {
          id: pay.userId,
          username: payer?.userProfile?.username || payer?.username || pay.email,
          fullName: payer?.fullName || null,
          avatarUrl: payer?.userProfile?.avatarUrl || null,
        },
        tickets: [],
        quantity: qty,
        admittedCount: 0,
        grossPaidZar: Number(pay.amount) || 0,
        venueShareZar: venueShareFromPayment(pay),
        platformFeeZar: platformFeeFromPayment(pay),
        amountPaidZar: Number(pay.amount) || 0,
        purchasedAt: pay.createdAt,
        menuAddons: parseMenuItemLines(meta.selected_menu_items ?? meta.selectedMenuItems),
        menuZar: Number(meta.menu_zar || meta.menu_total_zar || 0),
        fulfillmentPending: true,
      });
      ticketEventIds.add(ev.id);
    }

    const eventSummaries = eventsAtVenue
      .filter(
        (ev) =>
          ticketEventIds.has(ev.id) ||
          ev.eventFormat === 'TICKETING_ONLY' ||
          normalizeTicketTiers(ev.ticketTiers).length > 0,
      )
      .map((e) => ({ id: e.id, title: e.title, date: e.date, startTime: e.startTime, city: e.city }))
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''));

    const items = [...groups.values()].sort(
      (a, b) => new Date(b.purchasedAt).getTime() - new Date(a.purchasedAt).getTime(),
    );

    for (const item of items) {
      if (isRefundedPaymentRef(item.paystackReference, refundedRefs)) {
        item.refundStatus = 'APPROVED';
        item.grossPaidZar = 0;
        item.venueShareZar = 0;
        item.platformFeeZar = 0;
        item.amountPaidZar = 0;
      }
    }

    const refundedOrders = await prisma.refundRequest.findMany({
      where: {
        venueId: { in: scopedVenueIds },
        refundType: 'TICKET',
        status: { in: ['APPROVED', 'PAID_BY_VENUE', 'PENDING', 'REJECTED'] },
      },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            username: true,
            userProfile: { select: { username: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const itemRefs = new Set(items.map((i) => i.paystackReference));
    for (const rr of refundedOrders) {
      if (itemRefs.has(rr.paymentReference)) continue;
      if (eventIdFilter && rr.eventId && rr.eventId !== eventIdFilter) continue;
      const ev = rr.eventId ? eventById.get(rr.eventId) : null;
      items.push({
        id: rr.paymentReference,
        paystackReference: rr.paymentReference,
        refundStatus: rr.status === 'PENDING' ? 'PENDING' : rr.status === 'REJECTED' ? 'REJECTED' : 'APPROVED',
        event: ev
          ? { id: ev.id, title: ev.title, date: ev.date, startTime: ev.startTime, city: ev.city }
          : { id: rr.eventId, title: 'Event', date: null, startTime: null, city: null },
        tierName: 'Ticket',
        purchaser: {
          id: rr.user.id,
          username: rr.user.userProfile?.username || rr.user.username,
          fullName: rr.user.fullName,
          avatarUrl: rr.user.userProfile?.avatarUrl || null,
        },
        tickets: [],
        quantity: Array.isArray(rr.ticketIds) ? rr.ticketIds.length : 1,
        admittedCount: 0,
        grossPaidZar: rr.status === 'APPROVED' || rr.status === 'PAID_BY_VENUE' ? 0 : rr.grossAmountZar,
        venueShareZar: rr.status === 'APPROVED' || rr.status === 'PAID_BY_VENUE' ? 0 : rr.venueRefundDueZar,
        platformFeeZar: rr.platformFeeKeptZar,
        amountPaidZar: rr.status === 'APPROVED' || rr.status === 'PAID_BY_VENUE' ? 0 : rr.grossAmountZar,
        purchasedAt: rr.createdAt,
        menuAddons: [],
        fulfillmentPending: false,
      });
    }

    items.sort((a, b) => new Date(b.purchasedAt).getTime() - new Date(a.purchasedAt).getTime());

    const q = normalizeGuestSearch(req.query.q);
    if (q) {
      items = items.filter((order) =>
        guestRecordMatchesSearch(
          {
            username: order.purchaser?.username,
            fullName: order.purchaser?.fullName,
            eventTitle: order.event?.title,
            tableName: order.tierName,
            paystackReference: order.paystackReference,
          },
          q,
        ),
      );
    }

    const ticketFulfillMap = await fulfillmentMapForReferences(
      prisma,
      items.map((i) => i.paystackReference),
    );
    for (const item of items) {
      const f = ticketFulfillMap.get(canonicalOrderReference(item.paystackReference));
      const menuAddons = Array.isArray(item.menuAddons) ? item.menuAddons : [];
      item.hasServeableOrder = menuAddons.length > 0 || Number(item.menuZar || 0) > 0;
      item.orderFulfilled = Boolean(f);
      item.orderFulfilledAt = f?.fulfilledAt || null;
    }

    const activeItems = items.filter((i) => i.refundStatus !== 'APPROVED' && i.refundStatus !== 'REJECTED');

    const summary = {
      orderCount: activeItems.length,
      ticketCount: ticketCount || activeItems.reduce((s, i) => s + Number(i.quantity || 0), 0),
      admittedCount,
      totalRevenueZar: activeItems.reduce((s, i) => s + Number(i.grossPaidZar || 0), 0),
      totalGrossZar: activeItems.reduce((s, i) => s + Number(i.grossPaidZar || 0), 0),
      totalVenueShareZar: activeItems.reduce((s, i) => s + Number(i.venueShareZar || 0), 0),
    };

    // Tables at ticketed events (host/join) — shown under Ticket Bookings.
    const ticketingEventIds = eventsAtVenue
      .filter((ev) => ticketedEventHasTables(ev))
      .map((e) => e.id);
    let tableGroups = [];
    if (ticketingEventIds.length) {
      const tableBookings = await prisma.eventVenueTableBooking.findMany({
        where: {
          venueId: { in: scopedVenueIds },
          eventId: { in: ticketingEventIds },
          role: { in: ['HOST', 'GUEST'] },
        },
        include: {
          event: {
            select: { id: true, title: true, date: true, startTime: true, city: true, eventFormat: true },
          },
          venue: { select: { id: true, name: true } },
          hostedTable: {
            select: {
              id: true,
              tableName: true,
              status: true,
              hostUserId: true,
              hostingCategory: true,
              guestQuantity: true,
              spotsRemaining: true,
            },
          },
          user: {
            select: {
              id: true,
              fullName: true,
              username: true,
              userProfile: { select: { username: true, avatarUrl: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      });
      const mapped = tableBookings.map((row) => ({
        ...row,
        lineTotalZar: Number(row.amountTotal || 0),
        eventId: row.eventId,
        venueTableId: row.venueTableId,
        tableSessionNumber: row.tableSessionNumber,
        isDirectVenueSlot: !row.hostedTableId && Boolean(row.venueTableId),
      }));
      tableGroups = groupEventTableBookingsByTable(mapped, refundedRefs);
      summary.tableGroupCount = tableGroups.length;
      summary.tablePaidZar = tableGroups.reduce((s, g) => s + Number(g.totalPaidZar || 0), 0);
    }

    res.json({ items, tableGroups, eventSummaries, summary, eventScope });
  } catch (e) {
    next(e);
  }
});

router.post('/venue-tables/:tableId/release', authenticateToken, async (req, res, next) => {
  try {
    const table = await prisma.venueTable.findUnique({
      where: { id: req.params.tableId },
      include: {
        venue: { select: { id: true, ownerUserId: true } },
        event: { select: { id: true, date: true, endsAt: true, startTime: true, deletedAt: true } },
      },
    });
    if (!table) return res.status(404).json({ error: 'Table not found' });
    const canManage = await staffHasVenuePermission(req.userId, table.venue.id, 'venue_tables');
    if (!canManage) return res.status(403).json({ error: 'Forbidden' });

    if (table.eventId && table.event && !table.event.deletedAt) {
      const endAt = eventEndsAtFromEvent(table.event);
      if (endAt && endAt.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'This event has ended — tables cannot be reset.' });
      }
    }

    let hostedTable = null;
    if (table.hostedTableId) {
      hostedTable = await prisma.hostedTable.findUnique({
        where: { id: table.hostedTableId },
        select: { id: true, status: true },
      });
    }
    if (!computeCanRelease(table, hostedTable)) {
      return res.status(400).json({ error: 'Table is already available' });
    }

    const releaseResult = await prisma.$transaction(async (tx) =>
      releaseVenueTableSlot(tx, table.id, { bumpSession: true }),
    );

    res.json({
      released: true,
      tableId: table.id,
      sessionNumber: releaseResult.sessionNumber ?? resolveDailySessionNumber(table),
    });
  } catch (e) {
    next(e);
  }
});

/** Live event table slots — which are in use vs available to hide from listings. */
router.get('/event-venue-tables', authenticateToken, async (req, res, next) => {
  try {
    const eventId = typeof req.query.event_id === 'string' ? req.query.event_id.trim() : '';
    if (!eventId) return res.status(400).json({ error: 'event_id is required' });

    const event = await prisma.event.findFirst({
      where: { id: eventId, deletedAt: null },
      select: { id: true, title: true, status: true, date: true, venueId: true },
    });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const canView = await staffHasVenuePermission(req.userId, event.venueId, 'venue_tables');
    if (!canView) return res.status(403).json({ error: 'Forbidden' });

    const tables = await prisma.venueTable.findMany({
      where: { eventId, isCustomListing: false },
      orderBy: [{ tierLabel: 'asc' }, { tableName: 'asc' }],
    });

    const { hostedById, goingByHostedId } = await loadHostedContextForVenueTables(tables);

    const items = tables.map((t) => {
      const hosted = t.hostedTableId ? hostedById.get(t.hostedTableId) : null;
      const goingCount = hosted ? goingByHostedId.get(hosted.id) ?? null : null;
      return mapVenueTableManagementItem(t, hosted, goingCount);
    });

    const summary = {
      total: items.length,
      inUse: items.filter((i) => i.inUse).length,
      available: items.filter((i) => i.isActive && !i.inUse).length,
      hidden: items.filter((i) => !i.isActive).length,
    };

    res.json({
      event: { id: event.id, title: event.title, status: event.status, date: event.date },
      summary,
      items,
    });
  } catch (e) {
    next(e);
  }
});

/** Day & venue table slots (non-event) — hide empty listings or reset in-use tables. */
router.get('/day-venue-tables', authenticateToken, async (req, res, next) => {
  try {
    const scope = await resolveBusinessVenueScope(req.userId, {
      staffCtx: staffCtxFromQuery(req.query),
      venueIdFilter: venueIdFromQuery(req.query),
      permission: 'venue_tables',
    });
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const venueId = scope.venueIds[0];
    if (!venueId) return res.status(400).json({ error: 'venue_id or staff_ctx is required' });

    const venue = await prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: {
        id: true,
        name: true,
        acceptsDayBookings: true,
        showSeatingPlanForDayBookings: true,
        hostTableFeeZar: true,
        customTableBookingFeeZar: true,
        maxBookingDurationHours: true,
      },
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });

    const { repairLegacyDayVenueTables } = await import('../lib/syncDayVenueTables.js');
    await repairLegacyDayVenueTables(venueId);

    const tables = await prisma.venueTable.findMany({
      where: { venueId, eventId: null },
      orderBy: [{ isCustomListing: 'asc' }, { serviceDate: 'desc' }, { tableName: 'asc' }],
    });

    const { hostedById, goingByHostedId } = await loadHostedContextForVenueTables(tables);

    const items = tables.map((t) => {
      const hosted = t.hostedTableId ? hostedById.get(t.hostedTableId) : null;
      const goingCount = hosted ? goingByHostedId.get(hosted.id) ?? null : null;
      return mapVenueTableManagementItem(t, hosted, goingCount);
    });

    const summary = {
      total: items.length,
      inUse: items.filter((i) => i.inUse).length,
      available: items.filter((i) => i.isActive && !i.inUse).length,
      hidden: items.filter((i) => !i.isActive).length,
    };

    res.json({
      venue: {
        id: venue.id,
        name: venue.name,
        acceptsDayBookings: venue.acceptsDayBookings,
        accepts_day_bookings: venue.acceptsDayBookings,
        show_seating_plan_for_day_bookings: venue.showSeatingPlanForDayBookings,
        host_table_fee_zar: venue.hostTableFeeZar,
        custom_table_booking_fee_zar: venue.customTableBookingFeeZar,
        max_booking_duration_hours: venue.maxBookingDurationHours,
      },
      summary,
      items,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/venue-tables/:tableId/hide-from-listings', authenticateToken, async (req, res, next) => {
  try {
    const table = await prisma.venueTable.findUnique({
      where: { id: req.params.tableId },
      include: { venue: { select: { ownerUserId: true } } },
    });
    if (!table) return res.status(404).json({ error: 'Table not found' });
    const canManageHide = await staffHasVenuePermission(req.userId, table.venueId, 'venue_tables');
    if (!canManageHide) return res.status(403).json({ error: 'Forbidden' });
    if (table.isCustomListing) return res.status(400).json({ error: 'Cannot hide the custom request listing' });

    let hostedTable = null;
    if (table.hostedTableId) {
      hostedTable = await prisma.hostedTable.findUnique({
        where: { id: table.hostedTableId },
        select: { id: true, status: true },
      });
    }
    if (!canHideTableFromListings(table, hostedTable)) {
      return res.status(400).json({
        error: tableInUse(table, hostedTable)
          ? 'This table is in use — only empty tables can be removed from listings'
          : 'Table is already hidden',
      });
    }

    await prisma.venueTable.update({
      where: { id: table.id },
      data: { isActive: false },
    });
    res.json({ hidden: true, tableId: table.id });
  } catch (e) {
    next(e);
  }
});

router.post('/venue-tables/:tableId/restore-to-listings', authenticateToken, async (req, res, next) => {
  try {
    const table = await prisma.venueTable.findUnique({
      where: { id: req.params.tableId },
      include: { venue: { select: { ownerUserId: true } } },
    });
    if (!table) return res.status(404).json({ error: 'Table not found' });
    const canManageRestore = await staffHasVenuePermission(req.userId, table.venueId, 'venue_tables');
    if (!canManageRestore) return res.status(403).json({ error: 'Forbidden' });

    let hostedTable = null;
    if (table.hostedTableId) {
      hostedTable = await prisma.hostedTable.findUnique({
        where: { id: table.hostedTableId },
        select: { id: true, status: true },
      });
    }
    if (table.isActive) return res.status(400).json({ error: 'Table is already listed' });
    if (tableInUse(table, hostedTable)) {
      return res.status(400).json({ error: 'Cannot restore a table that is currently in use' });
    }

    await prisma.venueTable.update({
      where: { id: table.id },
      data: { isActive: true },
    });
    res.json({ restored: true, tableId: table.id });
  } catch (e) {
    next(e);
  }
});

const venueTableBoostBodySchema = z.object({
  days: z.coerce.number().int().min(1).max(30),
});

/** Pay to boost a day-booking / venue table in Home Available Tables (R150/day). */
router.post('/venue-tables/:tableId/boost', authenticateToken, async (req, res, next) => {
  try {
    const parsed = venueTableBoostBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
    }

    const table = await prisma.venueTable.findUnique({
      where: { id: req.params.tableId },
      include: { venue: { select: { id: true, ownerUserId: true, name: true } } },
    });
    if (!table) return res.status(404).json({ error: 'Table not found' });
    const canManage = await staffHasVenuePermission(req.userId, table.venueId, 'venue_tables');
    if (!canManage) return res.status(403).json({ error: 'Forbidden' });
    if (!table.isActive) {
      return res.status(400).json({ error: 'Only active listings can be boosted' });
    }
    if (table.isCustomListing) {
      return res.status(400).json({ error: 'Custom request listings cannot be boosted' });
    }

    const endAt =
      table.serviceEndDate ||
      table.serviceDate ||
      (() => {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        d.setHours(23, 59, 59, 999);
        return d;
      })();
    const maxDays = maxBoostDaysUntil(endAt);
    if (maxDays < 1) {
      return res.status(400).json({ error: 'This listing window has ended and cannot be boosted' });
    }
    const boostDays = clampBoostDays(parsed.data.days, maxDays);
    if (boostDays < 1) {
      return res.status(400).json({ error: `Choose between 1 and ${maxDays} boost days` });
    }

    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) return res.status(500).json({ error: 'Paystack is not configured' });

    const owner = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true },
    });
    const reference = `vtboost_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const amountZar = FEED_BOOST_ZAR_PER_DAY * boostDays;
    const amountInCents = Math.round(amountZar * 100);
    const metadata = {
      type: 'VENUE_TABLE_BOOST',
      venueTableId: table.id,
      venue_table_id: table.id,
      venueId: table.venueId,
      boostDays,
      boost_days: boostDays,
      user_id: req.userId,
    };

    await prisma.payment.create({
      data: {
        userId: req.userId,
        email: owner?.email || 'user@secnightlife.app',
        amount: amountZar,
        reference,
        status: 'pending',
        type: 'other',
        metadata,
      },
    });

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        buildPaystackInitializeBody({
          email: owner?.email || 'user@secnightlife.app',
          amountInCents,
          reference,
          metadata,
          userId: req.userId,
        }),
      ),
    });
    const json = await response.json();
    if (!response.ok || !json?.status) {
      return res.status(400).json({ error: json?.message || 'Failed to initialize boost payment' });
    }

    res.json({
      reference,
      authorization_url: json.data.authorization_url,
      access_code: json.data.access_code,
      amount_zar: amountZar,
      boost_days: boostDays,
      max_boost_days: maxDays,
      zar_per_day: FEED_BOOST_ZAR_PER_DAY,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/events/:eventId/purchase-log', authenticateToken, async (req, res, next) => {
  try {
    const eventId = typeof req.params.eventId === 'string' ? req.params.eventId.trim() : '';
    if (!eventId) return res.status(400).json({ error: 'Event id required' });

    const event = await prisma.event.findFirst({
      where: { id: eventId, deletedAt: null },
      select: { id: true, title: true, date: true, venueId: true },
    });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const staffCtx = staffCtxFromQuery(req.query);
    const scopeOpts = { staffCtx, venueIdFilter: event.venueId };
    const eventsScope = await resolveBusinessVenueScope(req.userId, { ...scopeOpts, permission: 'events' });
    const bookingsScope = eventsScope.ok
      ? eventsScope
      : await resolveBusinessVenueScope(req.userId, { ...scopeOpts, permission: 'bookings' });
    if (!bookingsScope.ok) {
      const status = eventsScope.status === 403 || bookingsScope.status === 403 ? 403 : 404;
      return res.status(status).json({
        error: status === 403 ? 'Forbidden' : eventsScope.error || bookingsScope.error || 'Event not found',
      });
    }
    if (!bookingsScope.venueIds.includes(event.venueId)) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const log = await buildEventPurchaseLog(event);
    res.json({
      filename: log.filename,
      csv: log.csv,
      xls: log.xls,
      rowCount: log.rows.length,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/event-options', authenticateToken, async (req, res, next) => {
  try {
    const venueIds = await resolveAccessibleVenueIds(req.userId, bookingsVenueScope(req));
    if (!venueIds.length) {
      if (venueIdFromQuery(req.query)) return res.status(404).json({ error: 'Venue not found' });
      return res.json({ items: [], total: 0, hasMore: false, skip: 0, limit: 30 });
    }
    const q = String(req.query.q || req.query.search || '').trim();
    const idFilter = String(req.query.id || '').trim();
    const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 50);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const where = {
      venueId: { in: venueIds },
      deletedAt: null,
      ...(idFilter ? { id: idFilter } : {}),
      ...(q && !idFilter ? { title: { contains: q, mode: 'insensitive' } } : {}),
    };
    const [total, events] = await Promise.all([
      prisma.event.count({ where }),
      prisma.event.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: idFilter ? 0 : skip,
        take: idFilter ? 1 : take,
        select: { id: true, title: true, date: true, startTime: true, status: true },
      }),
    ]);
    res.json({
      items: events.map((e) => ({
        id: e.id,
        title: e.title,
        date: e.date,
        startTime: e.startTime,
        status: e.status,
      })),
      total,
      hasMore: Boolean(!idFilter && skip + events.length < total),
      skip: idFilter ? 0 : skip,
      limit: idFilter ? 1 : take,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/orders', authenticateToken, async (req, res, next) => {
  try {
    const venueIds = await resolveAccessibleVenueIds(req.userId, bookingsVenueScope(req));
    if (!venueIds.length) {
      if (venueIdFromQuery(req.query)) return res.status(404).json({ error: 'Venue not found' });
      return res.json({ items: [], summary: { pending: 0, fulfilled: 0, total: 0 }, filters: { events: [] } });
    }
    const status = String(req.query.status || 'pending').toLowerCase();
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const dateYmd = typeof req.query.date === 'string' ? req.query.date : '';
    const eventId = typeof req.query.event_id === 'string' ? req.query.event_id : '';
    const source = typeof req.query.source === 'string' ? req.query.source : 'all';
    const result = await listVenueServeableOrders(prisma, {
      venueIds,
      q,
      status,
      dateYmd,
      eventId,
      source,
    });
    res.json({
      items: result.items.map(serializeOrderForClient),
      summary: result.summary,
      filters: result.filters || { events: [] },
    });
  } catch (e) {
    next(e);
  }
});

router.post('/orders/:reference/fulfill', authenticateToken, async (req, res, next) => {
  try {
    const out = await fulfillOrderByReference(prisma, {
      rawReference: req.params.reference,
      staffUserId: req.userId,
      staffRole: req.userRole,
    });
    if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
    const venueIds = await resolveAccessibleVenueIds(req.userId, bookingsVenueScope(req));
    if (!venueIds.includes(out.order.venueId) && !venueIds.length) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (venueIds.length && !venueIds.includes(out.order.venueId)) {
      const perm = await assertOrderFulfillPermission(prisma, {
        userId: req.userId,
        userRole: req.userRole,
        venueId: out.order.venueId,
      });
      if (!perm.ok) return res.status(403).json({ error: perm.reason });
    }
    res.json({ success: true, order: serializeOrderForClient(out.order) });
  } catch (e) {
    next(e);
  }
});

router.post('/orders/:reference/unfulfill', authenticateToken, async (req, res, next) => {
  try {
    const out = await unfulfillOrderByReference(prisma, {
      rawReference: req.params.reference,
      staffUserId: req.userId,
      staffRole: req.userRole,
    });
    if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
    res.json({ success: true, order: serializeOrderForClient(out.order) });
  } catch (e) {
    next(e);
  }
});

export default router;
