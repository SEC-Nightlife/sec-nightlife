/**
 * Host dashboard API — house parties, hosted tables, house-party jobs.
 * All authenticated users with role USER (and staff where noted) may host.
 */
import { Router } from 'express';
import { DEFAULT_COUNTRY_CODE, normalizeCountryCode, zoneOfHostedTable } from '../lib/timezone.js';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { createInAppNotification } from '../lib/inAppNotifications.js';
import { notifyUserAlert } from '../lib/paymentNotifications.js';
import { logFriendActivity } from '../lib/friendActivity.js';
import { recordTableHistory } from '../lib/tableHistory.js';
import { logger } from '../lib/logger.js';
import { signCloudinaryUrl, privateDownloadUrl } from '../lib/cloudinarySignedUrl.js';
import { normalizeGuestGenderPreference } from '../lib/genderPreference.js';
import {
  isInAppEventInFuture,
  shouldShowHostedTableOnHostDashboard,
  reopenPrematurelyClosedExternalListings,
} from '../lib/eventWallClock.js';
import { buildExternalListingSchedule } from '../lib/externalListingSchedule.js';
import {
  normalizeBookingDateSast,
  resolveHostMemberForHostedTable,
  isHostedTableSessionRefunded,
  windowEndInstant,
} from '../lib/dayBookingWindows.js';
import { normalizeHostingConfig } from '../lib/hostingConfig.js';
import { getEventEntranceZar, getHostTableFeeZar, resolveHostingTierCaps } from '../lib/hostedTableSecFees.js';
import { userHasPaidEventEntrance, resolveTableEntranceZar, resolveHostedJoinEntranceZar } from '../lib/entranceCheckout.js';
import { addUserToHostedTableGroupChat, removeUserFromHostedTableGroupChat } from '../lib/hostedTableGroupChat.js';
import {
  reconcileTableInvitesOnJoin,
  reconcileTableInvitesOnLeave,
  countPendingTableInvites,
  countPendingTableInvitesForTable,
  remainingInviteSlotsForTable,
} from '../lib/hostedTableInvites.js';
import {
  resolveVenueMenuSelections,
  resolveTierIncludedItems,
  includedItemsTotalZar,
  mergeMemberMenuItems,
  fetchGuestVenueMenuItems,
} from '../lib/menuHelpers.js';
import { refreshHostedTableTickets } from '../lib/ticketHelpers.js';
import { buildPaystackInitializeBody } from '../lib/paystackInitialize.js';
import { SERVICE_FEE_ZAR, serviceFeeForSubtotal } from '../lib/serviceFee.js';
import { canJoinTablesAsGuest, staffHasVenuePermission } from '../lib/access.js';
import {
  parseGuestCountFromSpecs,
  resolveLinkedVenueTableForHostedTable,
  resolveVenueContextForHostedTable,
  resolveVenueIdForHostedTable,
} from '../lib/venueTableHostAfterPayment.js';
import { recordEventVenueTableBooking } from '../lib/eventVenueBooking.js';
import { issueTicketAndNotify } from '../lib/issueTicket.js';
import {
  buildAddonPaymentMetadata,
  cancelStalePendingAddons,
  computeAddonCheckout,
  createPendingAddonOrder,
} from '../lib/addonOrders.js';
import { initializeServerPaystackPayment, newPaystackReference } from '../lib/paystackServerCheckout.js';
import { buildHostedTableJoinTicketSummary } from '../lib/ticketMemberSummary.js';
import {
  eventStartsAtFromEvent,
  eventEndsAtFromEvent,
  visibleUntilAfterHostedTable,
  visibleUntilForDayVenueTable,
  eventStartsAtFromHostedTable,
  dayStartsAtFromVenueTable,
  dayEndsAtFromVenueTable,
  holderDisplayNameFromUser,
  eventHasEnded,
} from '../lib/ticketHelpers.js';

import {
  FEED_BOOST_ZAR_PER_DAY,
  clampBoostDays,
  maxBoostDaysUntil,
} from '../lib/feedBoost.js';

const router = Router();
const EXTERNAL_HOSTED_LISTING_ZAR = 200;
/** @deprecated Prefer FEED_BOOST_ZAR_PER_DAY × days — kept for older clients. */
export const TABLE_BOOST_ZAR = FEED_BOOST_ZAR_PER_DAY * 7;

function isBoostActive(table) {
  if (!table?.boosted) return false;
  if (!table.boostExpiresAt) return true;
  return table.boostExpiresAt instanceof Date
    ? table.boostExpiresAt > new Date()
    : new Date(table.boostExpiresAt) > new Date();
}

const inviteUserSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
});

const postingSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  requirements: z.string().trim().min(1),
  jobType: z.enum(['FULL_TIME', 'PART_TIME', 'ONCE_OFF', 'CONTRACT']),
  compensationType: z.enum(['FIXED', 'NEGOTIABLE', 'UNPAID_TRIAL']),
  compensationAmount: z.number().nonnegative().optional().nullable(),
  compensationPer: z.enum(['HOUR', 'MONTH', 'COMMISSION', 'ONCE_OFF']).optional().nullable(),
  currency: z.string().trim().min(1).default('ZAR'),
  totalSpots: z.number().int().min(1).default(1),
  closingDate: z.coerce.date().optional().nullable(),
});

const applicationSchema = z.object({
  coverMessage: z.string().trim().min(50).max(1000),
  cvUrl: z.string().url().optional().nullable(),
  cvFileName: z.string().max(255).optional().nullable(),
  portfolioUrl: z.string().url().optional().nullable(),
});

const messageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

function assertHostEligibleRole(req, res) {
  if (canJoinTablesAsGuest(req.userRole)) {
    return true;
  }
  res.status(403).json({ error: 'Only party goer, business owner, and super admin accounts can host parties or tables.' });
  return false;
}

function requirePaystackKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    const err = new Error('Paystack is not configured');
    err.status = 500;
    throw err;
  }
  return key;
}

function promoterMetaFromBody(body) {
  const id = body?.promoter_user_id || body?.promoterUserId;
  return typeof id === 'string' && id.trim() ? { promoter_user_id: id.trim() } : {};
}

async function initializePaystackPayment({ userId, amountZar, metadata }) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  const email = user?.email || 'user@secnightlife.app';
  const reference = crypto.randomBytes(16).toString('hex');
  const amountInCents = Math.round(amountZar * 100);
  await prisma.payment.create({
    data: {
      userId,
      email,
      amount: amountZar,
      reference,
      status: 'pending',
      type: 'other',
      metadata: { user_id: userId, ...metadata },
    },
  });
  await prisma.transaction.create({
    data: {
      userId,
      amount: amountZar,
      currency: 'ZAR',
      type: 'paystack',
      status: 'pending',
      stripeId: reference,
      metadata: { provider: 'paystack', reference, ...metadata },
    },
  });
  const key = requirePaystackKey();
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(
      buildPaystackInitializeBody({
        email,
        amountInCents,
        reference,
        userId,
        metadata,
      }),
    ),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.status) {
    const err = new Error(data?.message || 'Paystack request failed');
    err.status = res.status;
    throw err;
  }
  return {
    reference,
    authorization_url: data.data.authorization_url,
    access_code: data.data.access_code,
    amount_zar: amountZar,
  };
}

const publicHostSelect = {
  id: true,
  username: true,
  fullName: true,
  userProfile: { select: { username: true, avatarUrl: true, serviceRatingAvg: true, serviceRatingCount: true } },
};

async function formatPublicHost(user) {
  if (!user || typeof user !== 'object') {
    return { id: null, username: null, fullName: null, full_name: null, avatarUrl: null, avatar_url: null, averageRating: null };
  }
  const profile = user.userProfile;
  const username = profile?.username || user.username;
  const avatarUrl = profile?.avatarUrl || null;
  return {
    id: user.id,
    username,
    fullName: user.fullName ?? null,
    full_name: user.fullName ?? null,
    avatarUrl,
    avatar_url: avatarUrl,
    averageRating: profile?.serviceRatingAvg != null ? Number(profile.serviceRatingAvg) : null,
  };
}

async function getFriendIds(userId) {
  const rows = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ requesterId: userId }, { receiverId: userId }],
    },
    select: { requesterId: true, receiverId: true },
  });
  const ids = new Set();
  for (const r of rows) {
    ids.add(r.requesterId === userId ? r.receiverId : r.requesterId);
  }
  return ids;
}

async function areFriends(a, b) {
  const f = await prisma.friendship.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: a, receiverId: b },
        { requesterId: b, receiverId: a },
      ],
    },
  });
  return !!f;
}

function parseTimeToMinutes(value) {
  if (value == null || typeof value !== 'string') return null;
  const t = value.trim();
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (Number.isNaN(h) || Number.isNaN(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

function formatVenueAddressFromVenue(venue) {
  if (!venue) return null;
  const parts = [venue.address, venue.suburb, venue.city].filter(Boolean);
  return parts.length ? parts.join(', ') : venue.city || null;
}

function assertTableTimeNotBeforeEventStart(eventTimeStr, eventStartTimeStr) {
  if (!eventStartTimeStr) return { ok: true };
  const tableM = parseTimeToMinutes(eventTimeStr);
  const eventM = parseTimeToMinutes(eventStartTimeStr);
  if (tableM == null || eventM == null) {
    return { ok: false, error: 'Invalid time format. Use HH:mm (e.g. 18:00).' };
  }
  if (tableM < eventM) {
    return { ok: false, error: 'Table time cannot be before the event start time.' };
  }
  return { ok: true };
}

function buildEventLocationPayload(event) {
  if (!event?.venue) return null;
  const v = event.venue;
  const displayLabel = formatVenueAddressFromVenue(v) || event.city || v.name;
  return {
    venueName: v.name,
    address: v.address,
    suburb: v.suburb,
    city: v.city,
    latitude: v.latitude,
    longitude: v.longitude,
    displayLabel,
    eventStartTime: event.startTime,
  };
}

// ——— House parties: public (optional auth) ——————————————————————
router.get('/parties/public', optionalAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const city = req.query.city ? String(req.query.city).trim() : '';
    const now = new Date();
    const where = {
      status: 'PUBLISHED',
      startTime: { gt: now },
      spotsRemaining: { gt: 0 },
    };
    if (city) {
      where.location = { contains: city, mode: 'insensitive' };
    }
    const rows = await prisma.houseParty.findMany({
      where,
      include: { host: { select: publicHostSelect } },
    });
    let friendIds = new Set();
    if (req.userId) friendIds = await getFriendIds(req.userId);
    const scored = rows.map((p) => ({
      p,
      friend: friendIds.has(p.hostUserId),
    }));
    scored.sort((a, b) => {
      if (a.p.boosted !== b.p.boosted) return a.p.boosted ? -1 : 1;
      if (a.friend !== b.friend) return a.friend ? -1 : 1;
      return a.p.startTime.getTime() - b.p.startTime.getTime();
    });
    const slice = scored.slice((page - 1) * limit, page * limit);
    const out = await Promise.all(
      slice.map(async ({ p }) => {
        const host = await formatPublicHost(p.host);
        return {
          id: p.id,
          title: p.title,
          description: p.description,
          location: p.location,
          startTime: p.startTime,
          endTime: p.endTime,
          hasEntranceFee: p.hasEntranceFee,
          entranceFeeAmount: p.entranceFeeAmount,
          entranceFeeNote: p.entranceFeeNote,
          freeEntryGroup: p.freeEntryGroup,
          guestQuantity: p.guestQuantity,
          spotsRemaining: p.spotsRemaining,
          boosted: p.boosted,
          coverImageUrl: p.coverImageUrl,
          host,
        };
      }),
    );
    res.json({ items: out, page, limit, total: scored.length });
  } catch (e) {
    next(e);
  }
});

async function resolveMemberMenuLines(members, venueId) {
  if (!venueId || !Array.isArray(members)) return members;
  return Promise.all(
    members.map(async (m) => {
      const raw = m.selectedMenuItems;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { ...m, menuLines: [], menuLineTotalZar: 0 };
      }
      const hasPrices = raw.every((line) => line.unitPrice != null || line.lineTotalZar != null);
      if (hasPrices) {
        const menuLines = raw.map((line) => ({
          name: line.name || 'Item',
          quantity: Number(line.quantity) || 1,
          unitPrice: Number(line.unitPrice) || 0,
          lineTotalZar: Number(line.lineTotalZar) || (Number(line.unitPrice) || 0) * (Number(line.quantity) || 1),
        }));
        return {
          ...m,
          menuLines,
          menuLineTotalZar: menuLines.reduce((s, l) => s + l.lineTotalZar, 0),
        };
      }
      try {
        const resolved = await resolveVenueMenuSelections(
          raw.map((line) => ({
            menuItemId: line.menuItemId || line.menu_item_id || line.id,
            quantity: line.quantity,
          })),
          venueId,
        );
        const menuLines = resolved.items.map((line) => ({
          name: line.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotalZar: line.lineTotalZar,
        }));
        return { ...m, menuLines, menuLineTotalZar: resolved.totalZar };
      } catch {
        return { ...m, menuLines: [], menuLineTotalZar: 0 };
      }
    }),
  );
}

/** Public-ish detail for TableDetails when id is a HostedTable (not legacy `tables`). */
router.get('/hosted-tables/:tableId', optionalAuth, async (req, res, next) => {
  try {
    const t = await prisma.hostedTable.findFirst({
      where: { id: req.params.tableId },
      include: {
        host: { select: publicHostSelect },
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                fullName: true,
                userProfile: { select: { avatarUrl: true, username: true } },
              },
            },
          },
        },
        event: {
          select: {
            id: true,
            title: true,
            date: true,
            startTime: true,
            city: true,
            hasEntranceFee: true,
            entranceFeeAmount: true,
            venueId: true,
            hostingConfig: true,
            venue: {
              select: {
                id: true,
                name: true,
                address: true,
                suburb: true,
                city: true,
                province: true,
                latitude: true,
                longitude: true,
                ownerUserId: true,
              },
            },
          },
        },
      },
    });
    if (!t) return res.status(404).json({ error: 'Not found' });
    const uid = req.userId;
    const { venueId, venueOwnerUserId, linkedVenueTable } = await resolveVenueContextForHostedTable(prisma, t);
    const isVenueOwner = Boolean(uid && venueOwnerUserId && uid === venueOwnerUserId);
    const hasBookingsStaff =
      venueId && uid ? await staffHasVenuePermission(uid, venueId, 'bookings') : false;
    if (t.status === 'DRAFT') {
      if (uid !== t.hostUserId && !isVenueOwner && !hasBookingsStaff) {
        return res.status(404).json({ error: 'Not found' });
      }
    } else if (t.status === 'CLOSED') {
      const allowed =
        uid &&
        (t.hostUserId === uid ||
          isVenueOwner ||
          hasBookingsStaff ||
          (await prisma.hostedTableMember.findFirst({
            where: { hostedTableId: t.id, userId: uid },
          })));
      if (!allowed) return res.status(404).json({ error: 'Not found' });
    }
    // ACTIVE / FULL: listable (public or private) so guests can open details and request to join
    const eventLocation =
      t.tableType === 'IN_APP_EVENT' && t.event ? buildEventLocationPayload(t.event) : null;
    const resolvedAddress =
      eventLocation?.displayLabel ||
      [t.venueAddress, t.venueName].filter(Boolean).join(', ') ||
      t.venueName;
    const entranceZar = await resolveHostedJoinEntranceZar({
      event: t.event,
      userId: uid,
      hostedTableId: t.id,
    });
    const joinZar = t.hasJoiningFee && Number(t.joiningFee) > 0 ? Number(t.joiningFee) : 0;
    const tierMin =
      t.tierMinSpend != null && Number.isFinite(Number(t.tierMinSpend)) ? Number(t.tierMinSpend) : null;
    const gq = Math.max(1, Number(t.guestQuantity) || 1);
    const minSpendPerPerson =
      tierMin != null && tierMin > 0 ? Math.ceil(tierMin / gq) : null;
    const totalPayOnlineZar = entranceZar + joinZar;
    let venueMenu = [];
    if (venueId) {
      venueMenu = await fetchGuestVenueMenuItems(venueId);
    }
    const tierIncludedRaw = t.tierIncludedItems;
    const tierIncludedItems = Array.isArray(tierIncludedRaw?.items) ? tierIncludedRaw.items : [];
    const tierName = tierIncludedRaw?.tier_name || null;
    const myMembership = uid
      ? t.members.find((m) => m.userId === uid)
      : null;
    const goingMembers = t.members.filter((m) => m.status === 'GOING');
    let effectiveGuestQty = gq;
    let effectiveSpots = t.spotsRemaining;
    if (t.tableName === 'Custom table request' && t.eventId) {
      const customListing = await prisma.venueTable.findFirst({
        where: { eventId: t.eventId, isCustomListing: true },
        select: { id: true },
      });
      if (customListing) {
        const hostVenueMember = await prisma.venueTableMember.findFirst({
          where: { venueTableId: customListing.id, userId: t.hostUserId, memberRole: 'HOST' },
          select: { userSpecs: true },
        });
        const requested = parseGuestCountFromSpecs(hostVenueMember?.userSpecs);
        if (requested) {
          effectiveGuestQty = requested;
          effectiveSpots = Math.max(0, requested - goingMembers.length);
        }
      }
    }
    const pendingInviteCount = await countPendingTableInvitesForTable(prisma, t.id);
    const inviteSlotsRemaining = await remainingInviteSlotsForTable(prisma, {
      ...t,
      guestQuantity: effectiveGuestQty,
      members: t.members,
    });
    const membersWithMenu = await resolveMemberMenuLines(t.members, venueId);
    const hostMember = membersWithMenu.find((m) => m.userId === t.hostUserId) || null;
    const menuProgress =
      tierMin != null && tierMin > 0
        ? Math.min(100, (Number(t.menuSpendTotal || 0) / tierMin) * 100)
        : null;
    res.json({
      kind: 'hosted',
      id: t.id,
      tableName: t.tableName,
      venueSlotName: linkedVenueTable?.tableName || null,
      venueSlotLabel: linkedVenueTable?.tierLabel || null,
      tableDescription: t.tableDescription,
      photo: t.photo,
      photoPublicId: t.photoPublicId,
      status: t.status,
      isPublic: t.isPublic,
      venueName: t.venueName,
      venueAddress: t.venueAddress,
      resolvedAddress,
      tableType: t.tableType,
      listingSurface: t.listingSurface,
      eventDate: t.eventDate,
      eventTime: t.eventTime,
      eventEndDate: t.eventEndDate,
      eventEndTime: t.eventEndTime,
      windowEndsAt: t.windowEndsAt,
      eventId: t.eventId,
      eventLocation,
      event: t.event
        ? {
            id: t.event.id,
            title: t.event.title,
            date: t.event.date,
            start_time: t.event.startTime,
            city: t.event.city,
            has_entrance_fee: t.event.hasEntranceFee,
            entrance_fee_amount: t.event.entranceFeeAmount,
          }
        : null,
      host: await formatPublicHost(t.host),
      stats: {
        spots_remaining: effectiveSpots,
        member_count: goingMembers.length,
        pending_invite_count: pendingInviteCount,
        guest_capacity: effectiveGuestQty,
        invite_slots_remaining: inviteSlotsRemaining,
      },
      invite_slots_remaining: inviteSlotsRemaining,
      spotsRemaining: effectiveSpots,
      guestQuantity: effectiveGuestQty,
      hasJoiningFee: t.hasJoiningFee,
      joiningFee: t.joiningFee,
      is_own_place_listing: t.tableType === 'EXTERNAL_VENUE' && !t.venueTableId && !t.eventId,
      is_community_event:
        t.tableType === 'EXTERNAL_VENUE' && t.listingSurface === 'EVENT' && !t.venueTableId,
      tier_min_spend_zar: tierMin,
      hosting_category: t.hostingCategory,
      hosting_tier_name: tierName,
      tier_included_items: tierIncludedItems,
      menu_spend_total: Number(t.menuSpendTotal || 0),
      menu_progress_percent: menuProgress,
      venue_id: venueId,
      venue_menu: venueMenu.map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        sub_category: m.sub_category,
        price: m.price,
        image_url: m.image_url,
      })),
      members:
        t.tableType === 'EXTERNAL_VENUE' && t.listingSurface === 'EVENT' && !t.venueTableId && uid !== t.hostUserId
          ? []
          : membersWithMenu.map((m) => ({
              userId: m.userId,
              status: m.status,
              role: m.userId === t.hostUserId ? 'HOST' : 'GUEST',
              selectedMenuItems: m.selectedMenuItems,
              menuLines: m.menuLines || [],
              menuLineTotalZar: m.menuLineTotalZar || 0,
              menuSpendPaid: m.menuSpendPaid,
              user: m.user
                ? {
                    id: m.user.id,
                    username: m.user.userProfile?.username || m.user.username,
                    full_name: m.user.fullName,
                    avatar_url: m.user.userProfile?.avatarUrl,
                  }
                : null,
            })),
      host_orders:
        t.tableType === 'EXTERNAL_VENUE' && t.listingSurface === 'EVENT' && !t.venueTableId
          ? null
          : hostMember
            ? {
                menuLines: hostMember.menuLines || [],
                menuLineTotalZar: hostMember.menuLineTotalZar || 0,
                minSpendZar: tierMin,
              }
            : null,
      my_membership: myMembership
        ? {
            status: myMembership.status,
            hostReviewedAt: myMembership.hostReviewedAt,
            reviewStatus:
              myMembership.status === 'GOING'
                ? 'going'
                : myMembership.status === 'PENDING' && myMembership.hostReviewedAt
                  ? 'awaiting_payment'
                  : myMembership.status === 'PENDING'
                    ? 'pending'
                    : null,
            selectedMenuItems: myMembership.selectedMenuItems,
            menuSpendPaid: myMembership.menuSpendPaid,
            joinFeePaid: myMembership.joinFeePaid,
          }
        : null,
      is_public: t.isPublic,
      is_host: Boolean(uid && uid === t.hostUserId),
      is_venue_owner: isVenueOwner,
      checkout: {
        entrance_zar: entranceZar,
        joining_fee_zar: joinZar,
        tier_min_spend_zar: tierMin,
        min_spend_per_person_zar: minSpendPerPerson,
        total_pay_online_zar: totalPayOnlineZar,
        service_fee_zar: SERVICE_FEE_ZAR,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.post('/tables/:tableId/menu-order', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const parsed = menuOrderSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    // Each table menu order is a separate add-on order with its own order-only QR.
    const computed = await computeAddonCheckout(prisma, {
      userId: req.userId,
      hostedTableId: req.params.tableId,
      selectedMenuItems: parsed.data.selectedMenuItems,
    });
    if (!computed.ok) return res.status(computed.status || 400).json({ error: computed.error });
    await cancelStalePendingAddons(prisma, req.userId);
    const reference = newPaystackReference();
    await createPendingAddonOrder(prisma, { reference, userId: req.userId, computed });
    let pay;
    try {
      pay = await initializeServerPaystackPayment({
        userId: req.userId,
        amountZar: computed.total,
        metadata: buildAddonPaymentMetadata({ userId: req.userId, computed }),
        reference,
      });
    } catch (e) {
      await prisma.menuAddonOrder
        .updateMany({ where: { paystackReference: reference, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } })
        .catch(() => {});
      throw e;
    }
    res.json({
      pendingPayment: true,
      amount_zar: computed.total,
      service_fee_zar: computed.serviceFee,
      reference: pay.reference,
      access_code: pay.access_code,
      items: computed.items,
    });
  } catch (e) {
    next(e);
  }
});

/** Tables for one host at an event (EventHostTables hub). */
router.get('/tables/host-at-event', optionalAuth, async (req, res, next) => {
  try {
    const eventId = typeof req.query.eventId === 'string' ? req.query.eventId : '';
    const hostUserId = typeof req.query.hostUserId === 'string' ? req.query.hostUserId : '';
    if (!hostUserId) return res.status(400).json({ error: 'hostUserId required' });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const where = {
      hostUserId,
      status: 'ACTIVE',
      spotsRemaining: { gt: 0 },
      eventDate: { gte: today },
      ...(eventId ? { eventId } : {}),
    };
    const rows = await prisma.hostedTable.findMany({
      where,
      include: {
        host: { select: publicHostSelect },
        event: {
          select: {
            id: true,
            title: true,
            date: true,
            startTime: true,
            city: true,
            coverImageUrl: true,
            hasEntranceFee: true,
            entranceFeeAmount: true,
            venueId: true,
          },
        },
        members: {
          where: { status: 'GOING' },
          select: { userId: true },
        },
      },
      orderBy: [{ createdAt: 'asc' }],
    });
    rows.sort((a, b) => {
      const aB = isBoostActive(a);
      const bB = isBoostActive(b);
      if (aB !== bB) return aB ? -1 : 1;
      return 0;
    });
    const host = rows[0] ? await formatPublicHost(rows[0].host) : null;
    const venueId = rows[0]?.event?.venueId || null;
    let venueMenu = [];
    if (venueId) {
      venueMenu = await fetchGuestVenueMenuItems(venueId);
    }
    const entranceZar = getEventEntranceZar(rows[0]?.event);
    res.json({
      host,
      event: rows[0]?.event
        ? {
            id: rows[0].event.id,
            title: rows[0].event.title,
            date: rows[0].event.date,
            start_time: rows[0].event.startTime,
            city: rows[0].event.city,
            cover_image_url: rows[0].event.coverImageUrl,
            has_entrance_fee: rows[0].event.hasEntranceFee,
            entrance_fee_amount: rows[0].event.entranceFeeAmount,
            venue_id: venueId,
          }
        : null,
      venue_menu: venueMenu.map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        sub_category: m.sub_category,
        price: m.price,
        image_url: m.image_url,
      })),
      entrance_zar: entranceZar,
      tables: rows.map((t) => ({
        id: t.id,
        tableName: t.tableName,
        tableDescription: t.tableDescription,
        tableType: t.tableType,
        hasJoiningFee: t.hasJoiningFee,
        joiningFee: t.joiningFee,
        photo: t.photo,
        venueName: t.venueName,
        guestQuantity: t.guestQuantity,
        spotsRemaining: t.spotsRemaining,
        isPublic: t.isPublic,
        boosted: isBoostActive(t),
        hostingCategory: t.hostingCategory,
        memberCount: t.members.length,
        eventId: t.eventId,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// ——— Hosted tables: public available ————————————————————————————
router.get('/tables/available', optionalAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 10);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const where = {
      status: 'ACTIVE',
      spotsRemaining: { gt: 0 },
      eventDate: { gte: today },
    };
    const rows = await prisma.hostedTable.findMany({
      where,
      include: {
        host: { select: publicHostSelect },
        event: {
          select: {
            id: true,
            title: true,
            date: true,
            startTime: true,
            city: true,
            venue: {
              select: {
                name: true,
                address: true,
                suburb: true,
                city: true,
                latitude: true,
                longitude: true,
              },
            },
          },
        },
      },
    });
    let friendIds = new Set();
    if (req.userId) {
      try {
        friendIds = await getFriendIds(req.userId);
      } catch (e) {
        logger.warn('getFriendIds failed in /tables/available', { err: e?.message });
      }
    }
    const scored = rows.map((t) => ({ t, friend: friendIds.has(t.hostUserId) }));
    scored.sort((a, b) => {
      const aBoost = isBoostActive(a.t);
      const bBoost = isBoostActive(b.t);
      if (aBoost !== bBoost) return aBoost ? -1 : 1;
      if (a.friend !== b.friend) return a.friend ? -1 : 1;
      const ad = a.t.eventDate instanceof Date ? a.t.eventDate.getTime() : 0;
      const bd = b.t.eventDate instanceof Date ? b.t.eventDate.getTime() : 0;
      return ad - bd;
    });
    const slice = scored.slice((page - 1) * limit, page * limit);
    const out = await Promise.all(
      slice.map(async ({ t }) => ({
        id: t.id,
        tableName: t.tableName,
        tableDescription: t.tableDescription,
        tableType: t.tableType,
        eventType: t.eventType,
        hasJoiningFee: t.hasJoiningFee,
        joiningFee: t.joiningFee,
        photo: t.photo,
        venueName: t.venueName,
        venueAddress: t.venueAddress,
        displayLocation:
          t.tableType === 'IN_APP_EVENT'
            ? buildEventLocationPayload(t.event)?.displayLabel || t.venueAddress || t.venueName
            : t.venueAddress || t.venueName,
        eventLocation: t.tableType === 'IN_APP_EVENT' ? buildEventLocationPayload(t.event) : null,
        eventDate: t.eventDate,
        eventTime: t.eventTime,
        drinkPreferences: t.drinkPreferences,
        desiredCompany: t.desiredCompany,
        guestQuantity: t.guestQuantity,
        spotsRemaining: t.spotsRemaining,
        isPublic: t.isPublic,
        boosted: isBoostActive(t),
        eventId: t.eventId,
        hostingCategory: t.hostingCategory ?? null,
        hostingTierIndex: t.hostingTierIndex ?? null,
        tierMaxGuests: t.tierMaxGuests ?? null,
        tierMinSpend: t.tierMinSpend ?? null,
        event: t.event
          ? {
              id: t.event.id,
              title: t.event.title,
              date: t.event.date,
              start_time: t.event.startTime,
              city: t.event.city || null,
            }
          : null,
        host: await formatPublicHost(t.host ?? null).catch(() => ({
          username: null,
          fullName: null,
          avatarUrl: null,
          averageRating: null,
        })),
      })),
    );
    res.json({ items: out, page, limit, total: scored.length });
  } catch (e) {
    next(e);
  }
});

// ——— Unread house-party job messages —————————————————————————————
router.get('/notifications/unread-count', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const uid = req.userId;
    const count = await prisma.housePartyJobMessage.count({
      where: {
        readAt: null,
        NOT: { senderUserId: uid },
        application: {
          OR: [{ applicantUserId: uid }, { housePartyJob: { hostUserId: uid } }],
        },
      },
    });
    res.json({ count });
  } catch (e) {
    next(e);
  }
});

// ——— CRUD parties —————————————————————————————————————————————————
const createPartySchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  location: z.string().trim().min(1),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  coverImageUrl: z.string().url().optional().nullable(),
  coverImagePublicId: z.string().optional().nullable(),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  hasEntranceFee: z.boolean(),
  entranceFeeAmount: z.number().optional().nullable(),
  entranceFeeNote: z.string().optional().nullable(),
  freeEntryGroup: z.string().optional().nullable(),
  guestGenderPreference: z.enum(['ANY', 'MALE_ONLY', 'FEMALE_ONLY', 'OTHER_ONLY']).optional(),
  guestQuantity: z.number().int().min(2).max(500),
});

router.post('/parties', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const parsed = createPartySchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const d = parsed.data;
    if (d.startTime <= new Date()) return res.status(400).json({ error: 'startTime must be in the future' });
    if (d.endTime <= d.startTime) return res.status(400).json({ error: 'endTime must be after startTime' });
    if (d.hasEntranceFee && (d.entranceFeeAmount == null || d.entranceFeeAmount <= 0)) {
      return res.status(400).json({ error: 'entranceFeeAmount required when hasEntranceFee is true' });
    }
    const party = await prisma.houseParty.create({
      data: {
        hostUserId: req.userId,
        title: d.title,
        description: d.description,
        location: d.location,
        latitude: d.latitude ?? null,
        longitude: d.longitude ?? null,
        coverImageUrl: d.coverImageUrl ?? null,
        coverImagePublicId: d.coverImagePublicId ?? null,
        startTime: d.startTime,
        endTime: d.endTime,
        hasEntranceFee: d.hasEntranceFee,
        entranceFeeAmount: d.hasEntranceFee ? d.entranceFeeAmount : null,
        entranceFeeNote: d.entranceFeeNote ?? null,
        freeEntryGroup: d.freeEntryGroup ?? null,
        guestGenderPreference: 'ANY',
        guestQuantity: d.guestQuantity,
        spotsRemaining: d.guestQuantity,
        status: 'DRAFT',
      },
    });
    res.status(201).json(party);
  } catch (e) {
    next(e);
  }
});

router.post('/parties/:partyId/publish', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const party = await prisma.houseParty.findFirst({ where: { id: req.params.partyId } });
    if (!party) return res.status(404).json({ error: 'Not found' });
    if (party.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (!['DRAFT', 'PENDING_PAYMENT'].includes(party.status)) {
      return res.status(400).json({ error: 'Party cannot be published in current status' });
    }
    await prisma.houseParty.update({
      where: { id: party.id },
      data: { status: 'PENDING_PAYMENT' },
    });
    const pay = await initializePaystackPayment({
      userId: req.userId,
      amountZar: 100,
      metadata: { type: 'HOUSE_PARTY_PUBLISH', housePartyId: party.id, user_id: req.userId },
    });
    res.json(pay);
  } catch (e) {
    next(e);
  }
});

router.post('/parties/:partyId/boost', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const party = await prisma.houseParty.findFirst({ where: { id: req.params.partyId } });
    if (!party) return res.status(404).json({ error: 'Not found' });
    if (party.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (party.status !== 'PUBLISHED') return res.status(400).json({ error: 'Only published parties can be boosted' });
    const pay = await initializePaystackPayment({
      userId: req.userId,
      amountZar: 150,
      metadata: { type: 'HOUSE_PARTY_BOOST', housePartyId: party.id, user_id: req.userId },
    });
    res.json(pay);
  } catch (e) {
    next(e);
  }
});

router.get('/parties', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const parties = await prisma.houseParty.findMany({
      where: { hostUserId: req.userId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { attendees: true, jobs: true } },
      },
    });
    res.json(
      parties.map((p) => ({
        ...p,
        attendeeCount: p._count.attendees,
        jobCount: p._count.jobs,
        _count: undefined,
      })),
    );
  } catch (e) {
    next(e);
  }
});

router.get('/parties/:partyId', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const party = await prisma.houseParty.findFirst({
      where: { id: req.params.partyId, hostUserId: req.userId },
      include: {
        attendees: {
          include: {
            user: { select: { id: true, fullName: true, userProfile: { select: { username: true, avatarUrl: true } } } },
          },
        },
        jobs: { include: { _count: { select: { applications: true } } } },
      },
    });
    if (!party) return res.status(404).json({ error: 'Not found' });
    res.json(party);
  } catch (e) {
    next(e);
  }
});

const patchPartySchema = createPartySchema.partial().extend({
  title: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(500).optional(),
});

router.patch('/parties/:partyId', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const party = await prisma.houseParty.findFirst({ where: { id: req.params.partyId } });
    if (!party) return res.status(404).json({ error: 'Not found' });
    if (party.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (['COMPLETED', 'CANCELLED'].includes(party.status)) {
      return res.status(400).json({ error: 'Cannot edit completed or cancelled party' });
    }
    if (!['DRAFT', 'PUBLISHED'].includes(party.status)) {
      return res.status(400).json({ error: 'Cannot edit in current status' });
    }
    const parsed = patchPartySchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const d = parsed.data;
    if (d.guestQuantity != null && d.guestQuantity !== party.guestQuantity) {
      const going = await prisma.housePartyAttendee.count({ where: { housePartyId: party.id, status: 'GOING' } });
      if (d.guestQuantity < going) {
        return res.status(400).json({ error: 'guestQuantity cannot be less than current attendees' });
      }
      const newSpots = d.guestQuantity - going;
      const updated = await prisma.houseParty.update({
        where: { id: party.id },
        data: { ...d, spotsRemaining: newSpots },
      });
      return res.json(updated);
    }
    const updated = await prisma.houseParty.update({ where: { id: party.id }, data: d });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.delete('/parties/:partyId', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const party = await prisma.houseParty.findFirst({ where: { id: req.params.partyId } });
    if (!party) return res.status(404).json({ error: 'Not found' });
    if (party.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (party.status === 'DRAFT') {
      await prisma.houseParty.delete({ where: { id: party.id } });
      return res.json({ deleted: true });
    }
    if (party.status === 'PUBLISHED') {
      await prisma.houseParty.update({ where: { id: party.id }, data: { status: 'CANCELLED' } });
      return res.json({ cancelled: true });
    }
    return res.status(400).json({ error: 'Cannot delete in current status' });
  } catch (e) {
    next(e);
  }
});

router.post('/parties/:partyId/join', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    const partyId = req.params.partyId;
    const party = await prisma.houseParty.findFirst({ where: { id: partyId } });
    if (!party) return res.status(404).json({ error: 'Not found' });
    if (party.hostUserId === req.userId) return res.status(403).json({ error: 'You cannot join your own party' });
    if (party.status !== 'PUBLISHED') return res.status(400).json({ error: 'Party is not published' });
    if (party.startTime <= new Date()) return res.status(400).json({ error: 'Party has already started' });
    const existing = await prisma.housePartyAttendee.findUnique({
      where: { housePartyId_userId: { housePartyId: partyId, userId: req.userId } },
    });
    if (existing && existing.status !== 'CANCELLED') {
      return res.status(400).json({ error: 'Already registered' });
    }

    if (party.hasEntranceFee && Number(party.entranceFeeAmount || 0) > 0) {
      const pending = await prisma.housePartyAttendee.upsert({
        where: { housePartyId_userId: { housePartyId: partyId, userId: req.userId } },
        create: { housePartyId: partyId, userId: req.userId, status: 'PENDING' },
        update: { status: 'PENDING' },
      });
      const partyEntranceZar = Number(party.entranceFeeAmount);
      const partyServiceFee = serviceFeeForSubtotal(partyEntranceZar);
      const partyChargeZar = Math.round((partyEntranceZar + partyServiceFee) * 100) / 100;
      const pay = await initializePaystackPayment({
        userId: req.userId,
        amountZar: partyChargeZar,
        metadata: {
          type: 'HOUSE_PARTY_ENTRANCE',
          house_party_id: partyId,
          attendee_id: pending.id,
          user_id: req.userId,
          entrance_zar: partyEntranceZar,
          subtotal_zar: partyEntranceZar,
          service_fee_zar: partyServiceFee,
          amount_total_zar: partyChargeZar,
        },
      });
      return res.json({ status: 'PENDING_PAYMENT', ...pay });
    }

    const result = await prisma.$transaction(async (tx) => {
      const fresh = await tx.houseParty.findUnique({ where: { id: partyId } });
      if (fresh.spotsRemaining > 0) {
        await tx.houseParty.update({
          where: { id: partyId },
          data: { spotsRemaining: { decrement: 1 } },
        });
        const att = await tx.housePartyAttendee.upsert({
          where: { housePartyId_userId: { housePartyId: partyId, userId: req.userId } },
          create: { housePartyId: partyId, userId: req.userId, status: 'GOING' },
          update: { status: 'GOING' },
        });
        return { status: 'GOING', att };
      }
      const att = await tx.housePartyAttendee.upsert({
        where: { housePartyId_userId: { housePartyId: partyId, userId: req.userId } },
        create: { housePartyId: partyId, userId: req.userId, status: 'WAITLISTED' },
        update: { status: 'WAITLISTED' },
      });
      return { status: 'WAITLISTED', att };
    });

    const joiner = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { userProfile: { select: { username: true } } },
    });
    const uname = joiner?.userProfile?.username || joiner?.username || 'someone';
    await createInAppNotification({
      userId: party.hostUserId,
      type: 'EVENT_JOINED',
      title: 'New guest',
      body: `@${uname} is coming to your party!`,
      referenceId: partyId,
      referenceType: 'HOUSE_PARTY',
    });
    await logFriendActivity({
      userId: req.userId,
      activityType: 'JOINED_EVENT',
      referenceId: partyId,
      referenceType: 'HOUSE_PARTY',
      description: 'joined a house party',
    });
    res.json({ status: result.status });
  } catch (e) {
    next(e);
  }
});

router.delete('/parties/:partyId/join', authenticateToken, async (req, res, next) => {
  try {
    const partyId = req.params.partyId;
    const att = await prisma.housePartyAttendee.findUnique({
      where: { housePartyId_userId: { housePartyId: partyId, userId: req.userId } },
    });
    if (!att) return res.status(404).json({ error: 'Not attending' });
    await prisma.$transaction(async (tx) => {
      await tx.housePartyAttendee.delete({ where: { id: att.id } });
      if (att.status === 'GOING') {
        await tx.houseParty.update({
          where: { id: partyId },
          data: { spotsRemaining: { increment: 1 } },
        });
        const first = await tx.housePartyAttendee.findFirst({
          where: { housePartyId: partyId, status: 'WAITLISTED' },
          orderBy: { joinedAt: 'asc' },
        });
        if (first) {
          await tx.housePartyAttendee.update({
            where: { id: first.id },
            data: { status: 'GOING' },
          });
          await tx.houseParty.update({
            where: { id: partyId },
            data: { spotsRemaining: { decrement: 1 } },
          });
          await createInAppNotification({
            userId: first.userId,
            type: 'EVENT_JOINED',
            title: 'Spot opened',
            body: `A spot opened up — you're going to the party!`,
            referenceId: partyId,
            referenceType: 'HOUSE_PARTY',
          });
        }
      }
    });
    res.json({ cancelled: true });
  } catch (e) {
    next(e);
  }
});

// ——— Hosted tables CRUD ————————————————————————————————————————————
const createTableSchema = z.object({
  tableType: z.enum(['IN_APP_EVENT', 'EXTERNAL_VENUE']),
  tableName: z.string().trim().min(1, 'tableName is required').max(60, 'tableName max 60 characters'),
  tableDescription: z.string().trim().max(300, 'tableDescription max 300 characters').optional().nullable(),
  eventType: z.enum(['CLUB_TABLE', 'HOUSE_PARTY', 'BOAT_PARTY', 'RESTAURANT', 'OTHER']),
  eventId: z.string().optional().nullable(),
  venueName: z.string().trim().min(1).optional(),
  venueAddress: z.string().optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  eventDate: z.coerce.date(),
  eventTime: z.string().min(1),
  eventEndDate: z.coerce.date().optional().nullable(),
  eventEndTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  hasJoiningFee: z.boolean().default(false),
  joiningFee: z.number().min(10, 'joiningFee must be at least R10').optional().nullable(),
  photo: z.string().url().optional().nullable(),
  photoPublicId: z.string().optional().nullable(),
  drinkPreferences: z.string().optional().nullable(),
  desiredCompany: z.string().optional().nullable(),
  guestGenderPreference: z.enum(['ANY', 'MALE_ONLY', 'FEMALE_ONLY', 'OTHER_ONLY']).optional(),
  /** Guest capacity — no hard product cap for own-place listings. */
  guestQuantity: z.number().int().min(1).max(100000),
  hostingCategory: z.enum(['GENERAL', 'VIP']).optional(),
  hostingTierIndex: z.number().int().min(0).optional().nullable(),
  isPublic: z.boolean().default(true),
  listingSurface: z.enum(['TABLE', 'EVENT']).default('TABLE'),
  selectedMenuItems: z
    .array(z.object({ menuItemId: z.string().min(1), quantity: z.number().int().min(1) }))
    .optional(),
  settlementMode: z.enum(['PREPAY_MENU', 'PREPAY_LUMP']).optional(),
});

const menuOrderSchema = z.object({
  selectedMenuItems: z
    .array(z.object({ menuItemId: z.string().min(1), quantity: z.number().int().min(1) }))
    .min(1),
});

router.post('/tables', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const parsed = createTableSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const d = parsed.data;
    if (d.tableType === 'IN_APP_EVENT') {
      return res.status(403).json({
        error: 'SEC event tables are listed by the venue. Book from the event page instead.',
        code: 'USER_HOSTING_DISABLED',
      });
    }
    if (d.hasJoiningFee && (d.joiningFee == null || d.joiningFee < 10)) {
      return res.status(400).json({ error: 'joiningFee is required and must be at least R10 when hasJoiningFee is true' });
    }
    if (d.tableType === 'EXTERNAL_VENUE' && (!d.venueAddress || !d.venueAddress.trim())) {
      return res.status(400).json({ error: 'venueAddress is required for external venue tables' });
    }
    if (!d.venueName) return res.status(400).json({ error: 'venueName required for external venue' });
    if (!d.eventEndDate || !d.eventEndTime) {
      return res.status(400).json({ error: 'End date and end time are required for your listing.' });
    }
    const schedule = buildExternalListingSchedule({
      eventDate: d.eventDate,
      eventTime: d.eventTime,
      eventEndDate: d.eventEndDate,
      eventEndTime: d.eventEndTime,
      tz: zoneOfHostedTable({
        latitude: d.latitude ?? null,
        longitude: d.longitude ?? null,
        countryCode: d.countryCode ?? null,
      }),
    });
    if (!schedule.ok) {
      return res.status(400).json({ error: schedule.error });
    }
    const hostProfile = await prisma.userProfile.findUnique({
      where: { userId: req.userId },
      select: { city: true, countryCode: true },
    });
    const listingCountryCode =
      normalizeCountryCode(d.countryCode) || normalizeCountryCode(hostProfile?.countryCode) || DEFAULT_COUNTRY_CODE;
    const listingCity = d.city?.trim() || hostProfile?.city || null;
    const t = await prisma.$transaction(async (tx) =>
      tx.hostedTable.create({
        data: {
          hostUserId: req.userId,
          tableType: 'EXTERNAL_VENUE',
          tableName: d.tableName,
          tableDescription: d.tableDescription ?? null,
          eventType: d.eventType,
          eventId: null,
          venueName: d.venueName,
          venueAddress: d.venueAddress.trim(),
          city: listingCity,
          countryCode: listingCountryCode,
          latitude: d.latitude ?? null,
          longitude: d.longitude ?? null,
          eventDate: schedule.eventDate,
          eventTime: schedule.eventTime,
          eventEndDate: schedule.eventEndDate,
          eventEndTime: schedule.eventEndTime,
          windowEndsAt: schedule.windowEndsAt,
          hasJoiningFee: d.hasJoiningFee,
          joiningFee: d.hasJoiningFee ? d.joiningFee : null,
          guestGenderPreference: normalizeGuestGenderPreference(d.guestGenderPreference),
          photo: d.photo ?? null,
          photoPublicId: d.photoPublicId ?? null,
          drinkPreferences: d.drinkPreferences ?? null,
          desiredCompany: d.desiredCompany ?? null,
          guestQuantity: d.guestQuantity,
          spotsRemaining: d.guestQuantity,
          isPublic: d.isPublic,
          listingSurface: d.listingSurface === 'EVENT' ? 'EVENT' : 'TABLE',
          status: 'DRAFT',
        },
        include: { members: true, groupChat: true },
      }),
    );
    const pay = await initializePaystackPayment({
      userId: req.userId,
      amountZar: EXTERNAL_HOSTED_LISTING_ZAR,
      metadata: { type: 'HOSTED_TABLE_EXTERNAL_LISTING', hosted_table_id: t.id, user_id: req.userId },
    });
    res.status(201).json({ ...t, status: 'PENDING_PAYMENT', payment: pay });
  } catch (e) {
    next(e);
  }
});

router.post('/tables/:tableId/boost', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const t = await prisma.hostedTable.findFirst({ where: { id: req.params.tableId } });
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (t.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Only live listings can be boosted' });
    }

    const endAt =
      t.windowEndsAt ||
      (() => {
        const d = t.eventDate instanceof Date ? new Date(t.eventDate) : new Date(t.eventDate);
        d.setHours(23, 59, 59, 999);
        return d;
      })();
    const maxDays = maxBoostDaysUntil(endAt);
    if (maxDays < 1) {
      return res.status(400).json({ error: 'This listing has ended and cannot be boosted' });
    }

    const parsedDays = z.coerce.number().int().min(1).max(30).safeParse(req.body?.days ?? 7);
    const boostDays = clampBoostDays(parsedDays.success ? parsedDays.data : 7, maxDays);
    if (boostDays < 1) {
      return res.status(400).json({ error: `Choose between 1 and ${maxDays} boost days` });
    }

    const amountZar = FEED_BOOST_ZAR_PER_DAY * boostDays;
    const pay = await initializePaystackPayment({
      userId: req.userId,
      amountZar,
      metadata: {
        type: 'TABLE_BOOST',
        hostedTableId: t.id,
        hosted_table_id: t.id,
        user_id: req.userId,
        boostDays,
        boost_days: boostDays,
      },
    });
    res.json({
      ...pay,
      amount_zar: amountZar,
      boost_days: boostDays,
      max_boost_days: maxDays,
      zar_per_day: FEED_BOOST_ZAR_PER_DAY,
    });
  } catch (e) {
    next(e);
  }
});

/** Search registered users to invite to a hosted table (username / display name). */
router.get('/invite-user-search', authenticateToken, inviteUserSearchLimiter, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const q = String(req.query.q || '')
      .trim()
      .slice(0, 40);
    if (q.length < 2) return res.json([]);
    const rows = await prisma.user.findMany({
      where: {
        deletedAt: null,
        id: { not: req.userId },
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { fullName: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 15,
      select: {
        id: true,
        username: true,
        fullName: true,
        userProfile: { select: { username: true, avatarUrl: true } },
      },
    });
    res.json(
      rows.map((u) => ({
        id: u.id,
        username: u.userProfile?.username || u.username,
        fullName: u.fullName,
        avatarUrl: u.userProfile?.avatarUrl || null,
      })),
    );
  } catch (e) {
    next(e);
  }
});

/** New Paystack session for an unpaid listing (DRAFT in-app or external). */
router.post('/tables/:tableId/retry-listing-payment', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const t = await prisma.hostedTable.findFirst({ where: { id: req.params.tableId } });
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (t.status !== 'DRAFT') {
      return res.status(400).json({ error: 'This table is not waiting for a listing payment.' });
    }
    if (t.tableType === 'IN_APP_EVENT') {
      return res.status(410).json({
        error:
          'This listing checkout is no longer available. Host venue tables from the event or day booking page instead.',
        code: 'TABLE_HOST_FEE_RETIRED',
      });
    }
    if (t.tableType === 'EXTERNAL_VENUE') {
      if (t.externalListingPaystackRef) {
        return res.status(400).json({ error: 'Listing payment already recorded for this table.' });
      }
      const pay = await initializePaystackPayment({
        userId: req.userId,
        amountZar: EXTERNAL_HOSTED_LISTING_ZAR,
        metadata: { type: 'HOSTED_TABLE_EXTERNAL_LISTING', hosted_table_id: t.id, user_id: req.userId },
      });
      return res.json({ ...pay, listingStatus: 'PENDING_PAYMENT' });
    }
    return res.status(400).json({ error: 'Unsupported table type' });
  } catch (e) {
    next(e);
  }
});

router.get('/tables', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    // Restore listings closed before their user-set end (Home + Upcoming visibility).
    await reopenPrematurelyClosedExternalListings({ hostUserId: req.userId, limit: 50 }).catch(() => {});
    const tables = await prisma.hostedTable.findMany({
      where: { hostUserId: req.userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        hostUserId: true,
        tableType: true,
        listingSurface: true,
        tableName: true,
        tableDescription: true,
        eventType: true,
        eventId: true,
        venueTableId: true,
        venueName: true,
        venueAddress: true,
        eventDate: true,
        eventTime: true,
        eventEndDate: true,
        eventEndTime: true,
        hostFeePaystackRef: true,
        windowEndsAt: true,
        guestQuantity: true,
        spotsRemaining: true,
        hostingCategory: true,
        hostingTierIndex: true,
        tierMaxGuests: true,
        tierMinSpend: true,
        menuSpendTotal: true,
        tierIncludedItems: true,
        isPublic: true,
        hasJoiningFee: true,
        joiningFee: true,
        photo: true,
        photoPublicId: true,
        status: true,
        boosted: true,
        boostExpiresAt: true,
        externalListingPaystackRef: true,
        createdAt: true,
        updatedAt: true,
        event: {
          select: {
            id: true,
            title: true,
            date: true,
            startTime: true,
            endsAt: true,
            city: true,
            venue: {
              select: {
                name: true,
                address: true,
                suburb: true,
                city: true,
                latitude: true,
                longitude: true,
              },
            },
          },
        },
        groupChat: { select: { id: true, name: true } },
        _count: { select: { members: { where: { status: 'GOING' } } } },
      },
    });
    const ids = tables.map((t) => t.id);
    const pendingRows =
      ids.length === 0
        ? []
        : await prisma.hostedTableMember.groupBy({
            by: ['hostedTableId'],
            where: { hostedTableId: { in: ids }, status: 'PENDING' },
            _count: true,
          });
    const pendingByTable = Object.fromEntries(pendingRows.map((r) => [r.hostedTableId, r._count]));
    const pendingInvitesByTable = await countPendingTableInvites(prisma, {
      hostedTableIds: ids,
      inviterUserId: req.userId,
    });
    const dayVenueTableIds = tables.filter((t) => t.venueTableId && !t.eventId).map((t) => t.venueTableId);
    const allVenueTableIds = [...new Set(tables.map((t) => t.venueTableId).filter(Boolean))];
    const hostMembers =
      dayVenueTableIds.length > 0
        ? await prisma.venueTableMember.findMany({
            where: {
              venueTableId: { in: dayVenueTableIds },
              userId: req.userId,
              memberRole: 'HOST',
            },
            select: {
              id: true,
              venueTableId: true,
              paystackReference: true,
              bookingDate: true,
              windowStartTime: true,
              windowEndTime: true,
            },
          })
        : [];
    let refundedMembers = [];
    let refundedRequests = [];
    if (allVenueTableIds.length) {
      [refundedMembers, refundedRequests] = await Promise.all([
        prisma.venueTableMember.findMany({
          where: {
            venueTableId: { in: allVenueTableIds },
            userId: req.userId,
            memberRole: 'HOST',
            status: 'REFUNDED',
          },
          select: {
            id: true,
            venueTableId: true,
            paystackReference: true,
            bookingDate: true,
            windowStartTime: true,
            windowEndTime: true,
          },
        }),
        prisma.refundRequest.findMany({
          where: {
            userId: req.userId,
            refundType: 'TABLE_HOST',
            status: { in: ['APPROVED', 'PAID_BY_VENUE'] },
            venueTableId: { in: allVenueTableIds },
          },
          select: {
            venueTableId: true,
            paymentReference: true,
            venueTableMemberId: true,
          },
        }),
      ]);
    }
    const out = tables.map((t) => {
      let row = t;
      if (t.venueTableId && !t.eventId) {
        const member = resolveHostMemberForHostedTable(t, hostMembers);
        if (member?.windowStartTime && member?.windowEndTime) {
          const effectiveEnd = windowEndInstant(
            normalizeBookingDateSast(member.bookingDate || t.eventDate),
            member.windowStartTime,
            member.windowEndTime,
          );
          if (effectiveEnd) row = { ...t, windowEndsAt: effectiveEnd };
        }
      }
      const hostRefundStatus = isHostedTableSessionRefunded(t, {
        refundedMembers,
        refundedRequests,
        hostMembers,
      })
        ? 'REFUNDED'
        : null;
      const rowWithRefund = hostRefundStatus ? { ...row, hostRefundStatus } : row;
      const isPast =
        hostRefundStatus === 'REFUNDED' ||
        !shouldShowHostedTableOnHostDashboard(rowWithRefund, rowWithRefund.event);
      return {
      ...rowWithRefund,
      memberCount: rowWithRefund._count?.members ?? 0,
      isPast,
      eventLocation: rowWithRefund.tableType === 'IN_APP_EVENT' && rowWithRefund.event ? buildEventLocationPayload(rowWithRefund.event) : null,
      pendingJoinCount: pendingByTable[rowWithRefund.id] ?? 0,
      pendingInviteCount: pendingInvitesByTable[rowWithRefund.id] ?? 0,
    };
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.get('/tables/memberships/active', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const hosted = await prisma.hostedTable.findMany({
      where: { hostUserId: req.userId, status: 'ACTIVE' },
      select: { id: true },
    });
    const memberOf = await prisma.hostedTableMember.findMany({
      where: { userId: req.userId, hostedTable: { status: 'ACTIVE' } },
      select: { hostedTableId: true },
    });
    res.json({
      hasActive: hosted.length > 0 || memberOf.length > 0,
      hostedIds: hosted.map((h) => h.id),
      memberTableIds: [...new Set(memberOf.map((m) => m.hostedTableId))],
    });
  } catch (e) {
    next(e);
  }
});

router.get('/tables/:tableId/pending-requests', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const t = await prisma.hostedTable.findFirst({
      where: { id: req.params.tableId },
      select: { id: true, hostUserId: true },
    });
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await prisma.hostedTableMember.findMany({
      where: {
        hostedTableId: t.id,
        OR: [
          { status: 'PENDING' },
          {
            hostReviewedAt: { gte: sevenDaysAgo },
            status: { in: ['CANCELLED', 'GOING'] },
          },
        ],
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            userProfile: {
              select: {
                username: true,
                avatarUrl: true,
                bio: true,
                gender: true,
                dateOfBirth: true,
                city: true,
                ageVerified: true,
                verificationStatus: true,
              },
            },
          },
        },
      },
    });
    const mapRow = (m) => {
      let reviewStatus = 'history';
      let decisionLabel = null;
      if (m.status === 'PENDING' && !m.hostReviewedAt) {
        reviewStatus = 'pending';
        decisionLabel = null;
      } else if (m.status === 'PENDING' && m.hostReviewedAt) {
        reviewStatus = 'awaiting_payment';
        decisionLabel = 'Awaiting guest payment';
      } else if (m.status === 'CANCELLED' && m.hostReviewedAt) {
        reviewStatus = 'declined';
        decisionLabel = 'Declined';
      } else if (m.status === 'GOING' && m.hostReviewedAt) {
        reviewStatus = 'approved';
        decisionLabel = 'Approved';
      }
      return {
        id: m.id,
        userId: m.userId,
        joinedAt: m.joinedAt,
        hostReviewedAt: m.hostReviewedAt,
        memberStatus: m.status,
        reviewStatus,
        decisionLabel,
        user: {
          id: m.user.id,
          username: m.user.userProfile?.username || m.user.username,
          fullName: m.user.fullName,
          avatarUrl: m.user.userProfile?.avatarUrl || null,
          bio: m.user.userProfile?.bio ?? null,
          gender: m.user.userProfile?.gender ?? null,
          date_of_birth: m.user.userProfile?.dateOfBirth ?? null,
          city: m.user.userProfile?.city ?? null,
          age_verified: m.user.userProfile?.ageVerified ?? null,
          verification_status: m.user.userProfile?.verificationStatus ?? null,
        },
      };
    };
    const mapped = rows.map(mapRow);
    const sortKey = (x) => {
      if (x.reviewStatus === 'pending') return 0;
      if (x.reviewStatus === 'awaiting_payment') return 1;
      return 2;
    };
    mapped.sort((a, b) => {
      const d = sortKey(a) - sortKey(b);
      if (d !== 0) return d;
      const ta = a.hostReviewedAt || a.joinedAt;
      const tb = b.hostReviewedAt || b.joinedAt;
      return new Date(tb).getTime() - new Date(ta).getTime();
    });
    res.json(mapped);
  } catch (e) {
    next(e);
  }
});

router.patch('/tables/:tableId/join-requests/:userId', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const { action, declineReason } = z
      .object({
        action: z.enum(['approve', 'reject']),
        declineReason: z.string().trim().min(1).max(500).optional(),
      })
      .parse(req.body || {});
    const table = await prisma.hostedTable.findFirst({
      where: { id: req.params.tableId },
      select: {
        id: true,
        hostUserId: true,
        tableName: true,
        eventId: true,
        spotsRemaining: true,
        status: true,
        hasJoiningFee: true,
        joiningFee: true,
      },
    });
    if (!table) return res.status(404).json({ error: 'Not found' });
    if (table.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const targetUserId = req.params.userId;
    const member = await prisma.hostedTableMember.findUnique({
      where: { hostedTableId_userId: { hostedTableId: table.id, userId: targetUserId } },
    });
    if (!member || member.status !== 'PENDING') {
      return res.status(400).json({ error: 'No pending request for this user' });
    }
    const approveEvent = table.eventId
      ? await prisma.event.findFirst({
          where: { id: table.eventId, deletedAt: null },
          select: { id: true, venueId: true, hasEntranceFee: true, entranceFeeAmount: true },
        })
      : null;
    const approveLinkedVt = !approveEvent
      ? await resolveLinkedVenueTableForHostedTable(prisma, table.id)
      : null;
    const approveVenueId = approveEvent?.venueId || approveLinkedVt?.venueId || null;
    const entranceZarApprove = await resolveHostedJoinEntranceZar({
      event: approveEvent,
      userId: targetUserId,
      hostedTableId: table.id,
    });
    const joinZarApprove =
      table.hasJoiningFee && Number(table.joiningFee || 0) > 0 ? Number(table.joiningFee) : 0;
    if (action === 'reject') {
      const reason = declineReason?.trim() || 'Your request to join was declined.';
      await prisma.hostedTableMember.update({
        where: { id: member.id },
        data: { status: 'CANCELLED', hostReviewedAt: new Date(), declineReason: reason },
      });
      const guestUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { email: true },
      });
      await notifyUserAlert({
        userId: targetUserId,
        email: guestUser?.email,
        type: 'table_update',
        inAppType: 'TABLE_JOINED',
        title: 'Table request declined',
        body: reason,
        actionUrl: `/TableDetails?id=${table.id}&source=hosted`,
        referenceId: table.id,
        referenceType: 'HOSTED_TABLE',
        emailSubject: `Join request declined — ${table.tableName}`,
      });
      return res.json({ rejected: true });
    }
    if (action === 'approve' && member.hostReviewedAt && entranceZarApprove + joinZarApprove > 0) {
      return res.status(400).json({ error: 'Guest already has a payment link for this request' });
    }
    if (table.spotsRemaining <= 0) return res.status(400).json({ error: 'Table is full' });
    if (entranceZarApprove + joinZarApprove > 0) {
      await prisma.hostedTableMember.update({
        where: { id: member.id },
        data: { hostReviewedAt: new Date() },
      });
      const guestUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { email: true },
      });
      await notifyUserAlert({
        userId: targetUserId,
        email: guestUser?.email,
        type: 'table_update',
        inAppType: 'JOIN_REQUEST_ACCEPTED',
        title: 'Request approved — complete payment',
        body: `Your join request for "${table.tableName}" was approved. Complete payment to join the table.`,
        actionUrl: `/TableDetails?id=${table.id}&source=hosted&checkout=1`,
        referenceId: table.id,
        referenceType: 'HOSTED_TABLE',
        emailSubject: `Join request approved — ${table.tableName}`,
      });
      return res.json({ approved: true, awaitingGuestPayment: true });
    }

    await prisma.$transaction(async (tx) => {
      await tx.hostedTableMember.update({
        where: { id: member.id },
        data: { status: 'GOING', hostReviewedAt: new Date() },
      });
      await reconcileTableInvitesOnJoin(tx, table.id, targetUserId);
      const nextSpots = table.spotsRemaining - 1;
      await tx.hostedTable.update({
        where: { id: table.id },
        data: {
          spotsRemaining: { decrement: 1 },
          ...(nextSpots <= 0 ? { status: 'FULL' } : {}),
        },
      });
    });
    await addUserToHostedTableGroupChat(table.id, targetUserId);
    const guestUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { email: true },
    });
    await notifyUserAlert({
      userId: targetUserId,
      email: guestUser?.email,
      type: 'table_update',
      inAppType: 'JOIN_REQUEST_ACCEPTED',
      title: 'Request approved',
      body: `Your join request for "${table.tableName}" was approved — open the table to view details and chat.`,
      actionUrl: `/TableDetails?id=${table.id}&source=hosted`,
      referenceId: table.id,
      referenceType: 'HOSTED_TABLE',
      emailSubject: `Join request approved — ${table.tableName}`,
    });
    res.json({ approved: true });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    next(e);
  }
});

const patchTableSchema = z.object({
  tableName: z.string().trim().min(1).max(60).optional(),
  tableDescription: z.string().trim().max(300).optional().nullable(),
  eventType: z.enum(['CLUB_TABLE', 'HOUSE_PARTY', 'BOAT_PARTY', 'RESTAURANT', 'OTHER']).optional(),
  drinkPreferences: z.string().optional().nullable(),
  desiredCompany: z.string().optional().nullable(),
  hasJoiningFee: z.boolean().optional(),
  joiningFee: z.number().min(10).optional().nullable(),
  photo: z.string().url().optional().nullable(),
  photoPublicId: z.string().optional().nullable(),
  guestQuantity: z.number().int().min(1).max(100000).optional(),
  eventDate: z.coerce.date().optional(),
  eventTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  eventEndDate: z.coerce.date().optional(),
  eventEndTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  isPublic: z.boolean().optional(),
  venueAddress: z.string().trim().min(1).optional().nullable(),
  guestGenderPreference: z.enum(['ANY', 'MALE_ONLY', 'FEMALE_ONLY', 'OTHER_ONLY']).optional(),
});

router.patch('/tables/:tableId', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const t = await prisma.hostedTable.findFirst({ where: { id: req.params.tableId } });
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const parsed = patchTableSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const d = parsed.data;
    if (t.tableType === 'EXTERNAL_VENUE' && d.venueAddress != null && !d.venueAddress.trim()) {
      return res.status(400).json({ error: 'venueAddress cannot be empty' });
    }

    const scheduleTouched =
      d.eventDate != null || d.eventTime != null || d.eventEndDate != null || d.eventEndTime != null;
    if (scheduleTouched) {
      const isOwnPlaceExternal = t.tableType === 'EXTERNAL_VENUE' && !t.venueTableId && !t.eventId;
      if (!isOwnPlaceExternal) {
        return res.status(400).json({
          error: 'Start/end schedule can only be edited for your own place tables and events.',
        });
      }
      const schedule = buildExternalListingSchedule({
        eventDate: d.eventDate ?? t.eventDate,
        eventTime: d.eventTime ?? t.eventTime,
        eventEndDate: d.eventEndDate ?? t.eventEndDate ?? d.eventDate ?? t.eventDate,
        eventEndTime: d.eventEndTime ?? t.eventEndTime ?? '23:59',
        tz: zoneOfHostedTable(t),
      });
      if (!schedule.ok) return res.status(400).json({ error: schedule.error });
      d.eventDate = schedule.eventDate;
      d.eventTime = schedule.eventTime;
      d.eventEndDate = schedule.eventEndDate;
      d.eventEndTime = schedule.eventEndTime;
      d.windowEndsAt = schedule.windowEndsAt;
    }

    if (d.eventTime != null && t.eventId) {
      const ev = await prisma.event.findFirst({ where: { id: t.eventId, deletedAt: null } });
      if (ev) {
        if (t.tableType === 'IN_APP_EVENT') {
          const startStr = ev.startTime != null ? String(ev.startTime).trim() : '';
          if (!startStr) {
            return res.status(400).json({
              error:
                'This event has no start time. The venue must set an event start time before meet times can be validated.',
            });
          }
        }
        const timeCheck = assertTableTimeNotBeforeEventStart(d.eventTime, ev.startTime);
        if (!timeCheck.ok) return res.status(400).json({ error: timeCheck.error });
      }
    }
    const hasJoiningFee = d.hasJoiningFee != null ? d.hasJoiningFee : t.hasJoiningFee;
    const joiningFee = d.joiningFee != null ? d.joiningFee : t.joiningFee;
    if (hasJoiningFee && (joiningFee == null || joiningFee < 10)) {
      return res.status(400).json({ error: 'joiningFee must be at least R10 when hasJoiningFee is true' });
    }
    if (d.guestQuantity != null) {
      const going = await prisma.hostedTableMember.count({
        where: { hostedTableId: t.id, status: 'GOING' },
      });
      if (d.guestQuantity < going) return res.status(400).json({ error: 'guestQuantity too low' });
      if (t.tableType === 'IN_APP_EVENT' && d.guestQuantity > 500) {
        return res.status(400).json({ error: 'Guest quantity too high for this listing type.' });
      }
      if (t.tableType === 'IN_APP_EVENT' && t.eventId) {
        const evPatch = await prisma.event.findFirst({ where: { id: t.eventId, deletedAt: null } });
        if (evPatch) {
          const hostingCategoryPatch = t.hostingCategory === 'VIP' ? 'VIP' : 'GENERAL';
          let tierMetaPatch;
          try {
            tierMetaPatch = resolveHostingTierCaps(evPatch.hostingConfig, hostingCategoryPatch, t.hostingTierIndex);
          } catch (err) {
            return res.status(400).json({ error: err?.message || 'Invalid hosting tier for this event' });
          }
          if (d.guestQuantity > tierMetaPatch.maxGuests) {
            return res.status(400).json({ error: `Guest quantity exceeds tier cap (${tierMetaPatch.maxGuests}).` });
          }
        }
      }
      const updatePayload = { ...d };
      if (updatePayload.guestGenderPreference != null) {
        updatePayload.guestGenderPreference = normalizeGuestGenderPreference(updatePayload.guestGenderPreference);
      }
      const updated = await prisma.hostedTable.update({
        where: { id: t.id },
        data: {
          ...updatePayload,
          venueAddress:
            d.venueAddress != null && t.tableType === 'EXTERNAL_VENUE' ? d.venueAddress.trim() : d.venueAddress,
          spotsRemaining: d.guestQuantity - going,
        },
      });
      if (scheduleTouched) {
        await prisma.ticket.updateMany({
          where: { hostedTableId: t.id },
          data: {
            visibleUntil: visibleUntilAfterHostedTable(updated),
            eventStartsAt: eventStartsAtFromHostedTable(updated),
          },
        });
      }
      if (d.tableName != null && d.tableName !== t.tableName) {
        await prisma.hostedTableGroupChat.updateMany({
          where: { hostedTableId: t.id },
          data: { name: d.tableName },
        });
      }
      return res.json(updated);
    }
    const data = { ...d };
    if (data.guestGenderPreference != null) {
      data.guestGenderPreference = normalizeGuestGenderPreference(data.guestGenderPreference);
    }
    if (data.venueAddress != null && t.tableType === 'EXTERNAL_VENUE') {
      data.venueAddress = data.venueAddress.trim();
    }
    const updated = await prisma.hostedTable.update({ where: { id: t.id }, data });
    if (scheduleTouched) {
      await prisma.ticket.updateMany({
        where: { hostedTableId: t.id },
        data: {
          visibleUntil: visibleUntilAfterHostedTable(updated),
          eventStartsAt: eventStartsAtFromHostedTable(updated),
        },
      });
    }
    if (d.tableName != null && d.tableName !== t.tableName) {
      await prisma.hostedTableGroupChat.updateMany({
        where: { hostedTableId: t.id },
        data: { name: d.tableName },
      });
    }
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.delete('/tables/:tableId', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const t = await prisma.hostedTable.findFirst({
      where: { id: req.params.tableId },
      include: { members: true },
    });
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    await prisma.hostedTable.update({ where: { id: t.id }, data: { status: 'CLOSED' } });
    const memberIds = t.members.filter((m) => m.userId !== t.hostUserId).map((m) => m.userId);
    await Promise.all(
      memberIds.map((uid) =>
        createInAppNotification({
          userId: uid,
          type: 'TABLE_JOINED',
          title: 'Table closed',
          body: 'A table you joined has been closed by the host',
          referenceId: t.id,
          referenceType: 'HOSTED_TABLE',
        }),
      ),
    );
    res.json({ closed: true });
  } catch (e) {
    next(e);
  }
});

router.post('/tables/:tableId/join/checkout', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const checkoutBodySchema = z.object({
      selectedMenuItems: z
        .array(z.object({ menuItemId: z.string().min(1), quantity: z.number().int().min(1) }))
        .optional(),
    });
    const checkoutBody = checkoutBodySchema.safeParse(req.body || {});
    const selectedMenuInput = checkoutBody.success ? checkoutBody.data.selectedMenuItems : undefined;

    const tableId = req.params.tableId;
    const t = await prisma.hostedTable.findFirst({ where: { id: tableId } });
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.hostUserId === req.userId) return res.status(403).json({ error: 'Cannot pay to join your own table' });
    if (t.status !== 'ACTIVE') return res.status(400).json({ error: 'Table not available' });

    const member = await prisma.hostedTableMember.findUnique({
      where: { hostedTableId_userId: { hostedTableId: tableId, userId: req.userId } },
    });
    if (!member || member.status !== 'PENDING' || !member.hostReviewedAt) {
      return res.status(400).json({ error: 'No approved join request awaiting payment' });
    }

    const joinEvent = t.eventId
      ? await prisma.event.findFirst({
          where: { id: t.eventId, deletedAt: null },
          select: {
            id: true,
            venueId: true,
            hasEntranceFee: true,
            entranceFeeAmount: true,
            date: true,
            startTime: true,
            endsAt: true,
          },
        })
      : null;
    if (joinEvent && eventHasEnded(joinEvent)) {
      return res.status(400).json({ error: 'This event has ended. Tables are no longer available.' });
    }
    const joinLinkedVt = !joinEvent ? await resolveLinkedVenueTableForHostedTable(prisma, t.id) : null;
    const joinVenueId = joinEvent?.venueId || joinLinkedVt?.venueId || null;
    const entranceZar = await resolveHostedJoinEntranceZar({
      event: joinEvent,
      userId: req.userId,
      hostedTableId: t.id,
    });
    const joinZar = t.hasJoiningFee && Number(t.joiningFee || 0) > 0 ? Number(t.joiningFee) : 0;

    let menuResolved = { items: [], totalZar: 0 };
    if (selectedMenuInput?.length && joinVenueId) {
      menuResolved = await resolveVenueMenuSelections(selectedMenuInput, joinVenueId);
    }

    const menuZar = Number(menuResolved.totalZar || 0);
    const payZar = entranceZar + joinZar + menuZar;
    if (payZar <= 0) {
      return res.status(400).json({ error: 'No payment required for this join' });
    }

    if (menuResolved.items.length) {
      await prisma.hostedTableMember.update({
        where: { id: member.id },
        data: { selectedMenuItems: menuResolved.items },
      });
    }

    const joinServiceFee = serviceFeeForSubtotal(payZar);
    const chargeZar = Math.round((payZar + joinServiceFee) * 100) / 100;
    const pay = await initializePaystackPayment({
      userId: req.userId,
      amountZar: chargeZar,
      metadata: {
        type: 'HOSTED_TABLE_JOIN',
        hosted_table_id: t.id,
        hosted_table_member_id: member.id,
        event_id: joinEvent?.id || null,
        venue_id: joinVenueId,
        is_day_booking: !joinEvent?.id,
        booking_mode: 'join',
        member_role: 'GUEST',
        entrance_zar: entranceZar,
        join_zar: joinZar,
        menu_zar: menuZar,
        subtotal_zar: payZar,
        service_fee_zar: joinServiceFee,
        amount_total_zar: chargeZar,
        user_id: req.userId,
        selected_menu_items: menuResolved.items.length ? menuResolved.items : undefined,
        ...promoterMetaFromBody(req.body),
      },
    });
    await prisma.hostedTableMember.update({
      where: { id: member.id },
      data: { paystackReference: pay.reference },
    });
    res.json({ pendingPayment: true, amount_zar: chargeZar, service_fee_zar: joinServiceFee, ...pay });
  } catch (e) {
    next(e);
  }
});

router.post('/tables/:tableId/join', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const joinBodySchema = z.object({
      selectedMenuItems: z
        .array(z.object({ menuItemId: z.string().min(1), quantity: z.number().int().min(1) }))
        .optional(),
    });
    const joinBody = joinBodySchema.safeParse(req.body || {});
    const selectedMenuInput = joinBody.success ? joinBody.data.selectedMenuItems : undefined;

    const t = await prisma.hostedTable.findFirst({ where: { id: req.params.tableId } });
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.hostUserId === req.userId) return res.status(403).json({ error: 'Cannot join your own table' });
    if (t.status !== 'ACTIVE') return res.status(400).json({ error: 'Table not available' });

    const joinEvent = t.eventId
      ? await prisma.event.findFirst({
          where: { id: t.eventId, deletedAt: null },
          select: { id: true, title: true, venueId: true, hasEntranceFee: true, entranceFeeAmount: true, date: true, startTime: true, endsAt: true },
        })
      : null;
    if (joinEvent && eventHasEnded(joinEvent)) {
      return res.status(400).json({ error: 'This event has ended. Tables are no longer available.' });
    }
    const joinLinkedVt = !joinEvent ? await resolveLinkedVenueTableForHostedTable(prisma, t.id) : null;
    const joinVenueId = joinEvent?.venueId || joinLinkedVt?.venueId || null;

    let menuResolved = { items: [], totalZar: 0 };
    if (selectedMenuInput?.length && joinVenueId) {
      menuResolved = await resolveVenueMenuSelections(selectedMenuInput, joinVenueId);
    }

    let existing = await prisma.hostedTableMember.findUnique({
      where: { hostedTableId_userId: { hostedTableId: t.id, userId: req.userId } },
    });
    let resurrectedFromCancelled = false;
    if (existing?.status === 'CANCELLED') {
      await prisma.hostedTableMember.update({
        where: { id: existing.id },
        data: {
          status: 'PENDING',
          hostReviewedAt: null,
          paystackReference: null,
          joinFeePaid: null,
          selectedMenuItems:
            t.isPublic && menuResolved.items.length ? menuResolved.items : undefined,
        },
      });
      resurrectedFromCancelled = true;
      existing = await prisma.hostedTableMember.findUnique({
        where: { hostedTableId_userId: { hostedTableId: t.id, userId: req.userId } },
      });
    }
    if (existing) {
      if (existing.status === 'PENDING' && !resurrectedFromCancelled) {
        return res.status(400).json({ error: 'Your join request is already pending' });
      }
      if (existing.status === 'GOING' || existing.status === 'WAITLISTED') {
        return res.status(400).json({ error: 'Already a member' });
      }
    }
    const pendingInvite = await prisma.tableInvite.findFirst({
      where: { hostedTableId: t.id, inviteeUserId: req.userId, status: 'PENDING' },
    });
    if (!t.isPublic && !pendingInvite) {
      if (t.spotsRemaining <= 0) return res.status(400).json({ error: 'Table not available' });
      if (!existing) {
        await prisma.hostedTableMember.create({
          data: {
            hostedTableId: t.id,
            userId: req.userId,
            status: 'PENDING',
          },
        });
      }
      const joiner = await prisma.user.findUnique({
        where: { id: req.userId },
        include: { userProfile: { select: { username: true } } },
      });
      const uname = joiner?.userProfile?.username || joiner?.username || 'someone';
      const hostUser = await prisma.user.findUnique({
        where: { id: t.hostUserId },
        select: { email: true },
      });
      await notifyUserAlert({
        userId: t.hostUserId,
        email: hostUser?.email,
        type: 'table_request',
        inAppType: 'TABLE_JOIN_REQUEST',
        title: 'Join request',
        body: `@${uname} requested to join your table "${t.tableName}".`,
        actionUrl: `/HostDashboard?tab=tables&requests=${t.id}`,
        referenceId: t.id,
        referenceType: 'HOSTED_TABLE',
        emailSubject: `New join request — ${t.tableName}`,
      });
      return res.json({ joined: false, pending: true });
    }
    const entranceZarJoin = await resolveHostedJoinEntranceZar({
      event: joinEvent,
      userId: req.userId,
      hostedTableId: t.id,
    });
    const joinZarJoin = t.hasJoiningFee && Number(t.joiningFee || 0) > 0 ? Number(t.joiningFee) : 0;
    const menuZarJoin = Number(menuResolved.totalZar || 0);
    const payZarJoin = entranceZarJoin + joinZarJoin + menuZarJoin;
    if (payZarJoin > 0) {
      let memberId;
      if (!existing) {
        const member = await prisma.hostedTableMember.create({
          data: {
            hostedTableId: t.id,
            userId: req.userId,
            status: 'PENDING',
            selectedMenuItems: menuResolved.items.length ? menuResolved.items : undefined,
          },
        });
        memberId = member.id;
      } else if (resurrectedFromCancelled && existing.status === 'PENDING') {
        memberId = existing.id;
        if (menuResolved.items.length) {
          await prisma.hostedTableMember.update({
            where: { id: existing.id },
            data: { selectedMenuItems: menuResolved.items },
          });
        }
      } else {
        return res.status(400).json({ error: 'Already a member' });
      }
      const joinServiceFee = serviceFeeForSubtotal(payZarJoin);
      const chargeZarJoin = Math.round((payZarJoin + joinServiceFee) * 100) / 100;
      const pay = await initializePaystackPayment({
        userId: req.userId,
        amountZar: chargeZarJoin,
        metadata: {
          type: 'HOSTED_TABLE_JOIN',
          hosted_table_id: t.id,
          hosted_table_member_id: memberId,
          event_id: joinEvent?.id || null,
          venue_id: joinVenueId,
          is_day_booking: !joinEvent?.id,
          booking_mode: 'join',
          member_role: 'GUEST',
          entrance_zar: entranceZarJoin,
          join_zar: joinZarJoin,
          menu_zar: menuZarJoin,
          subtotal_zar: payZarJoin,
          service_fee_zar: joinServiceFee,
          amount_total_zar: chargeZarJoin,
          user_id: req.userId,
          selected_menu_items: menuResolved.items.length ? menuResolved.items : undefined,
          ...promoterMetaFromBody(req.body),
        },
      });
      return res.json({
        joined: false,
        pendingPayment: true,
        amount_zar: chargeZarJoin,
        service_fee_zar: joinServiceFee,
        ...pay,
      });
    }
    if (t.spotsRemaining <= 0) return res.status(400).json({ error: 'Table not available' });
    if (existing && !(resurrectedFromCancelled && existing.status === 'PENDING')) {
      return res.status(400).json({ error: 'Invalid membership state' });
    }
    let memberId;
    await prisma.$transaction(async (tx) => {
      if (!existing) {
        const member = await tx.hostedTableMember.create({
          data: {
            hostedTableId: t.id,
            userId: req.userId,
            status: 'GOING',
            selectedMenuItems: menuResolved.items.length ? menuResolved.items : undefined,
          },
        });
        memberId = member.id;
      } else {
        await tx.hostedTableMember.update({
          where: { id: existing.id },
          data: {
            status: 'GOING',
            selectedMenuItems: menuResolved.items.length ? menuResolved.items : existing.selectedMenuItems,
          },
        });
        memberId = existing.id;
      }
      const nextSpots = t.spotsRemaining - 1;
      await tx.hostedTable.update({
        where: { id: t.id },
        data: {
          spotsRemaining: { decrement: 1 },
          ...(nextSpots <= 0 ? { status: 'FULL' } : {}),
        },
      });
      await reconcileTableInvitesOnJoin(tx, t.id, req.userId);
    });
    await addUserToHostedTableGroupChat(t.id, req.userId);
    const joiner = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { userProfile: { select: { username: true } } },
    });
    const hostUser = await prisma.user.findUnique({
      where: { id: t.hostUserId },
      select: { fullName: true, username: true, userProfile: { select: { username: true } } },
    });
    const payer = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
    });
    const freeRef = `hosted-join-free-${memberId}`;
    const joinSummary = buildHostedTableJoinTicketSummary({
      hostedTable: t,
      hostUser,
      entranceZar: 0,
      joinZar: 0,
      menuItems: menuResolved.items,
    });
    await issueTicketAndNotify(prisma, {
      userId: req.userId,
      email: payer?.email,
      paystackReference: freeRef,
      kind: 'HOSTED_TABLE_JOIN',
      title: `${t.tableName} — Join ticket`,
      subtitle: t.venueName,
      visibleUntil: joinLinkedVt && !joinEvent
        ? visibleUntilForDayVenueTable(joinLinkedVt)
        : visibleUntilAfterHostedTable(t),
      hostedTableId: t.id,
      eventId: joinEvent?.id || null,
      quantity: 1,
      holderDisplayName: holderDisplayNameFromUser(payer),
      tableSpecsSummary: joinSummary,
      eventStartsAt: joinEvent
        ? eventStartsAtFromEvent(joinEvent)
        : (joinLinkedVt && dayStartsAtFromVenueTable(joinLinkedVt)) || eventStartsAtFromHostedTable(t),
      eventEndsAt: joinEvent
        ? eventEndsAtFromEvent(joinEvent)
        : joinLinkedVt
          ? dayEndsAtFromVenueTable(joinLinkedVt)
          : null,
    });
    const uname = joiner?.userProfile?.username || joiner?.username || 'someone';
    await createInAppNotification({
      userId: t.hostUserId,
      type: 'TABLE_JOINED',
      title: 'New member',
      body: `@${uname} joined your table`,
      referenceId: t.id,
      referenceType: 'HOSTED_TABLE',
    });
    await logFriendActivity({
      userId: req.userId,
      activityType: 'JOINED_TABLE',
      referenceId: t.id,
      referenceType: 'HOSTED_TABLE',
      description: 'joined a table',
    });
    recordTableHistory({
      userId: req.userId,
      role: 'JOINED',
      hostedTableId: t.id,
      eventId: t.eventId || joinEvent?.id || null,
      tableName: t.tableName,
      eventTitle: joinEvent?.title || null,
    });
    res.json({ joined: true });
  } catch (e) {
    next(e);
  }
});

router.post('/tables/:tableId/leave', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const tableId = req.params.tableId;
    const t = await prisma.hostedTable.findFirst({ where: { id: tableId } });
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.hostUserId === req.userId) {
      return res.status(400).json({ error: 'Hosts cannot leave their own table. Close the table instead.' });
    }
    const mem = await prisma.hostedTableMember.findUnique({
      where: { hostedTableId_userId: { hostedTableId: tableId, userId: req.userId } },
    });
    if (!mem || mem.status !== 'GOING') {
      return res.status(400).json({ error: 'You are not an active member of this table' });
    }
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.hostedTableMember.update({
        where: { id: mem.id },
        data: { status: 'CANCELLED' },
      });
      await tx.hostedTable.update({
        where: { id: tableId },
        data: {
          spotsRemaining: { increment: 1 },
          status: 'ACTIVE',
        },
      });
      await tx.ticket.updateMany({
        where: {
          userId: req.userId,
          hostedTableId: tableId,
          hiddenFromHistoryAt: null,
        },
        data: { hiddenFromHistoryAt: now },
      });
      await tx.userTableHistory.updateMany({
        where: {
          userId: req.userId,
          hostedTableId: tableId,
          role: 'JOINED',
          hiddenAt: null,
        },
        data: { hiddenAt: now },
      });
      await reconcileTableInvitesOnLeave(tx, tableId, req.userId);
    });
    await removeUserFromHostedTableGroupChat(tableId, req.userId);
    res.json({ left: true });
  } catch (e) {
    next(e);
  }
});

router.post('/tables/:tableId/invite', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const { inviteeUserId } = z.object({ inviteeUserId: z.string().min(1) }).parse(req.body || {});
    const table = await prisma.hostedTable.findFirst({
      where: { id: req.params.tableId },
      include: { members: true },
    });
    if (!table) return res.status(404).json({ error: 'Not found' });
    const isHost = table.hostUserId === req.userId;
    const isMember = table.members.some((m) => m.userId === req.userId);
    if (!isHost && !isMember) return res.status(403).json({ error: 'Forbidden' });
    if (!table.isPublic && !isHost) {
      return res.status(403).json({ error: 'Only the host can invite people to a private table' });
    }
    if (inviteeUserId === req.userId) return res.status(400).json({ error: 'Invalid invitee' });
    if (table.status !== 'ACTIVE') {
      return res.status(400).json({
        error: 'Complete your listing payment before inviting guests. Your table is not live yet.',
      });
    }
    const already = await prisma.hostedTableMember.findUnique({
      where: { hostedTableId_userId: { hostedTableId: table.id, userId: inviteeUserId } },
    });
    if (already?.status === 'GOING') return res.status(400).json({ error: 'User already a member' });
    if (already?.status === 'PENDING') return res.status(400).json({ error: 'User already has a pending request' });
    const inviter = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { userProfile: { select: { username: true } } },
    });
    const inviterUsername = inviter?.userProfile?.username || inviter?.username || 'Someone';
    const pendingInv = await prisma.tableInvite.findUnique({
      where: { hostedTableId_inviteeUserId: { hostedTableId: table.id, inviteeUserId } },
    });
    if (pendingInv?.status === 'PENDING') return res.status(400).json({ error: 'Invite already pending' });
    const inviteSlotsLeft = await remainingInviteSlotsForTable(prisma, table);
    if (inviteSlotsLeft <= 0) {
      return res.status(400).json({ error: 'No invite slots remaining for this table' });
    }
    if (pendingInv && (pendingInv.status === 'ACCEPTED' || pendingInv.status === 'DECLINED')) {
      const inv = await prisma.tableInvite.update({
        where: { id: pendingInv.id },
        data: {
          status: 'PENDING',
          inviterUserId: req.userId,
          respondedAt: null,
        },
      });
      await createInAppNotification({
        userId: inviteeUserId,
        type: 'TABLE_INVITE',
        title: `Table invite from @${inviterUsername}`,
        body: `@${inviterUsername} invited you to join their table at ${table.venueName}`,
        referenceId: table.id,
        referenceType: 'TABLE_INVITE',
      });
      return res.status(201).json(inv);
    }
    const inviteeMustBeFriend = table.isPublic || !isHost;
    if (inviteeMustBeFriend && !(await areFriends(req.userId, inviteeUserId))) {
      return res.status(400).json({ error: 'You must be friends with this user' });
    }
    const inv = await prisma.tableInvite.create({
      data: {
        hostedTableId: table.id,
        inviterUserId: req.userId,
        inviteeUserId,
        status: 'PENDING',
      },
    });
    await createInAppNotification({
      userId: inviteeUserId,
      type: 'TABLE_INVITE',
      title: `Table invite from @${inviterUsername}`,
      body: `@${inviterUsername} invited you to join their table at ${table.venueName}`,
      referenceId: table.id,
      referenceType: 'TABLE_INVITE',
    });
    res.status(201).json(inv);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    next(e);
  }
});

router.patch('/tables/invites/:inviteId/respond', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const { response } = z.object({ response: z.enum(['ACCEPTED', 'DECLINED']) }).parse(req.body || {});
    const inv = await prisma.tableInvite.findFirst({
      where: { id: req.params.inviteId, inviteeUserId: req.userId },
      include: { hostedTable: true },
    });
    if (!inv) return res.status(404).json({ error: 'Not found' });
    if (inv.status !== 'PENDING') return res.status(400).json({ error: 'Already responded' });
    if (response === 'DECLINED') {
      const u = await prisma.tableInvite.update({
        where: { id: inv.id },
        data: { status: 'DECLINED', respondedAt: new Date() },
      });
      return res.json(u);
    }
    const table = inv.hostedTable;
    const existingMember = await prisma.hostedTableMember.findUnique({
      where: { hostedTableId_userId: { hostedTableId: table.id, userId: req.userId } },
    });
    if (existingMember?.status === 'GOING') return res.status(400).json({ error: 'Already a member' });
    if (table.spotsRemaining <= 0) return res.status(400).json({ error: 'Table is full' });
    const inviteEvent = table.eventId
      ? await prisma.event.findFirst({
          where: { id: table.eventId, deletedAt: null },
          select: { id: true, venueId: true, hasEntranceFee: true, entranceFeeAmount: true },
        })
      : null;
    const entranceZarInv = await resolveHostedJoinEntranceZar({
      event: inviteEvent,
      userId: req.userId,
      hostedTableId: table.id,
    });
    const joinZarInv = table.hasJoiningFee && Number(table.joiningFee || 0) > 0 ? Number(table.joiningFee) : 0;
    if (entranceZarInv + joinZarInv > 0) {
      const member =
        existingMember?.status === 'PENDING'
          ? existingMember
          : await prisma.hostedTableMember.create({
              data: { hostedTableId: table.id, userId: req.userId, status: 'PENDING' },
            });
      await prisma.tableInvite.update({
        where: { id: inv.id },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });
      const subtotalInv = entranceZarInv + joinZarInv;
      const inviteServiceFee = serviceFeeForSubtotal(subtotalInv);
      const chargeZarInv = Math.round((subtotalInv + inviteServiceFee) * 100) / 100;
      const pay = await initializePaystackPayment({
        userId: req.userId,
        amountZar: chargeZarInv,
        metadata: {
          type: 'HOSTED_TABLE_JOIN',
          hosted_table_id: table.id,
          hosted_table_member_id: member.id,
          event_id: inviteEvent?.id || null,
          venue_id: inviteEvent?.venueId || null,
          is_day_booking: !inviteEvent?.id,
          booking_mode: 'join',
          member_role: 'GUEST',
          entrance_zar: entranceZarInv,
          join_zar: joinZarInv,
          subtotal_zar: subtotalInv,
          service_fee_zar: inviteServiceFee,
          amount_total_zar: chargeZarInv,
          user_id: req.userId,
        },
      });
      return res.json({ pendingPayment: true, ...pay });
    }
    await prisma.$transaction(async (tx) => {
      await tx.tableInvite.update({
        where: { id: inv.id },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });
      if (existingMember?.status === 'PENDING') {
        await tx.hostedTableMember.update({
          where: { id: existingMember.id },
          data: { status: 'GOING' },
        });
      } else {
        await tx.hostedTableMember.create({
          data: { hostedTableId: table.id, userId: req.userId, status: 'GOING' },
        });
      }
      const nextSpots = table.spotsRemaining - 1;
      await tx.hostedTable.update({
        where: { id: table.id },
        data: {
          spotsRemaining: { decrement: 1 },
          ...(nextSpots <= 0 ? { status: 'FULL' } : {}),
        },
      });
    });
    await addUserToHostedTableGroupChat(table.id, req.userId);
    const invitee = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { userProfile: { select: { username: true } } },
    });
    const hostUser = await prisma.user.findUnique({
      where: { id: table.hostUserId },
      select: { fullName: true, username: true, userProfile: { select: { username: true } } },
    });
    const payer = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
    });
    const memberRow = await prisma.hostedTableMember.findUnique({
      where: { hostedTableId_userId: { hostedTableId: table.id, userId: req.userId } },
    });
    const freeRef = `hosted-invite-free-${memberRow?.id || inv.id}`;
    const joinSummary = buildHostedTableJoinTicketSummary({
      hostedTable: table,
      hostUser,
      entranceZar: 0,
      joinZar: 0,
      menuItems: [],
    });
    await issueTicketAndNotify(prisma, {
      userId: req.userId,
      email: payer?.email,
      paystackReference: freeRef,
      kind: 'HOSTED_TABLE_JOIN',
      title: `${table.tableName} — Join ticket`,
      subtitle: table.venueName,
      visibleUntil: visibleUntilAfterHostedTable(table),
      hostedTableId: table.id,
      eventId: table.eventId || null,
      quantity: 1,
      holderDisplayName: holderDisplayNameFromUser(payer),
      tableSpecsSummary: joinSummary,
      eventStartsAt: inviteEvent ? eventStartsAtFromEvent(inviteEvent) : eventStartsAtFromHostedTable(table),
      eventEndsAt: inviteEvent ? eventEndsAtFromEvent(inviteEvent) : null,
    });
    const un = invitee?.userProfile?.username || invitee?.username || 'someone';
    await createInAppNotification({
      userId: table.hostUserId,
      type: 'TABLE_JOINED',
      title: 'Invite accepted',
      body: `@${un} accepted your table invite`,
      referenceId: table.id,
      referenceType: 'HOSTED_TABLE',
    });
    recordTableHistory({
      userId: req.userId,
      role: 'JOINED',
      hostedTableId: table.id,
      eventId: table.eventId || inviteEvent?.id || null,
      tableName: table.tableName,
      eventTitle: inviteEvent?.title || null,
    });
    const updated = await prisma.tableInvite.findUnique({ where: { id: inv.id } });
    res.json(updated);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    next(e);
  }
});

router.get('/tables/invites/pending', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const invites = await prisma.tableInvite.findMany({
      where: { inviteeUserId: req.userId, status: 'PENDING' },
      include: {
        hostedTable: true,
        inviter: { select: publicHostSelect },
      },
      orderBy: { sentAt: 'desc' },
    });
    res.json(invites);
  } catch (e) {
    next(e);
  }
});

// ——— House party jobs —————————————————————————————————————————————
router.post('/parties/:partyId/jobs', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const party = await prisma.houseParty.findFirst({ where: { id: req.params.partyId } });
    if (!party || party.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const parsed = postingSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const payload = parsed.data;
    if (
      (payload.compensationType === 'FIXED' || payload.compensationType === 'NEGOTIABLE') &&
      !payload.compensationPer
    ) {
      return res.status(400).json({ error: 'compensationPer is required' });
    }
    const job = await prisma.housePartyJob.create({
      data: {
        housePartyId: party.id,
        hostUserId: req.userId,
        title: payload.title,
        description: payload.description,
        requirements: payload.requirements,
        jobType: payload.jobType,
        compensationType: payload.compensationType,
        compensationAmount: payload.compensationAmount ?? null,
        compensationPer: payload.compensationPer || 'MONTH',
        currency: payload.currency,
        totalSpots: payload.totalSpots,
        closingDate: payload.closingDate ?? null,
        status: 'OPEN',
      },
    });
    res.status(201).json(job);
  } catch (e) {
    next(e);
  }
});

router.get('/parties/:partyId/jobs', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const party = await prisma.houseParty.findFirst({ where: { id: req.params.partyId } });
    if (!party || party.hostUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const jobs = await prisma.housePartyJob.findMany({
      where: { housePartyId: party.id },
      include: { _count: { select: { applications: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(jobs);
  } catch (e) {
    next(e);
  }
});

router.get('/parties/:partyId/jobs/:jobId/applications', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const job = await prisma.housePartyJob.findFirst({
      where: { id: req.params.jobId, housePartyId: req.params.partyId, hostUserId: req.userId },
    });
    if (!job) return res.status(403).json({ error: 'Forbidden' });
    const applications = await prisma.housePartyJobApplication.findMany({
      where: { housePartyJobId: job.id },
      orderBy: { appliedAt: 'desc' },
      include: {
        applicant: { select: { id: true, fullName: true, userProfile: { select: { username: true, avatarUrl: true } } } },
      },
    });
    const safe = applications.map(({ cvUrl: _c, ...rest }) => rest);
    res.json(safe);
  } catch (e) {
    next(e);
  }
});

router.patch('/parties/jobs/applications/:applicationId/status', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const { status } = z.object({ status: z.enum(['SHORTLISTED', 'REJECTED', 'HIRED']) }).parse(req.body || {});
    const application = await prisma.housePartyJobApplication.findFirst({
      where: { id: req.params.applicationId },
      include: { housePartyJob: true, applicant: { select: { id: true, userProfile: { select: { username: true } } } } },
    });
    if (!application || application.housePartyJob.hostUserId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await prisma.$transaction(async (tx) => {
      await tx.housePartyJobApplication.update({ where: { id: application.id }, data: { status } });
      if (status === 'HIRED') {
        const posting = await tx.housePartyJob.update({
          where: { id: application.housePartyJobId },
          data: { filledSpots: { increment: 1 } },
        });
        if (posting.filledSpots >= posting.totalSpots) {
          await tx.housePartyJob.update({ where: { id: posting.id }, data: { status: 'FILLED' } });
        }
      }
    });
    const titles = { SHORTLISTED: 'Shortlisted', REJECTED: 'Not selected', HIRED: 'Hired' };
    await createInAppNotification({
      userId: application.applicantUserId,
      type: 'DIRECT_MESSAGE',
      title: titles[status] || 'Application update',
      body: `Your application for "${application.housePartyJob.title}" was updated.`,
      referenceId: application.id,
      referenceType: 'HOUSE_PARTY_JOB_APPLICATION',
    });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    next(e);
  }
});

router.get('/parties/jobs/applications/:applicationId/cv', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const application = await prisma.housePartyJobApplication.findFirst({
      where: { id: req.params.applicationId },
      include: { housePartyJob: true },
    });
    if (!application || application.housePartyJob.hostUserId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const raw = application.cvUrl;
    const viewUrl = raw ? privateDownloadUrl(raw) || signCloudinaryUrl(raw) || raw : null;
    logger.info('House party CV access', { applicationId: application.id, accessedBy: req.userId });
    res.set('Cache-Control', 'no-store');
    res.json({ cvUrl: raw, viewUrl, cvFileName: application.cvFileName });
  } catch (e) {
    next(e);
  }
});

async function getHousePartyApplicationAccess(applicationId, userId) {
  return prisma.housePartyJobApplication.findFirst({
    where: {
      id: applicationId,
      OR: [{ applicantUserId: userId }, { housePartyJob: { hostUserId: userId } }],
    },
    include: { housePartyJob: true },
  });
}

router.get('/parties/jobs/applications/:applicationId/messages', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const application = await getHousePartyApplicationAccess(req.params.applicationId, req.userId);
    if (!application) return res.status(403).json({ error: 'Forbidden' });
    await prisma.housePartyJobMessage.updateMany({
      where: { applicationId: application.id, readAt: null, senderUserId: { not: req.userId } },
      data: { readAt: new Date() },
    });
    const messages = await prisma.housePartyJobMessage.findMany({
      where: { applicationId: application.id },
      orderBy: { sentAt: 'asc' },
      include: { sender: { select: { id: true, fullName: true } } },
    });
    res.json(messages);
  } catch (e) {
    next(e);
  }
});

router.post('/parties/jobs/applications/:applicationId/messages', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const parsed = messageSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
    const application = await getHousePartyApplicationAccess(req.params.applicationId, req.userId);
    if (!application) return res.status(403).json({ error: 'Forbidden' });
    const senderIsHost = application.housePartyJob.hostUserId === req.userId;
    if (!senderIsHost && application.status === 'REJECTED') {
      return res.status(403).json({ error: 'Messaging not allowed' });
    }
    const msg = await prisma.housePartyJobMessage.create({
      data: {
        applicationId: application.id,
        senderUserId: req.userId,
        body: parsed.data.body,
      },
    });
    const otherId = senderIsHost ? application.applicantUserId : application.housePartyJob.hostUserId;
    await createInAppNotification({
      userId: otherId,
      type: 'DIRECT_MESSAGE',
      title: 'New message',
      body: `New message about "${application.housePartyJob.title}"`,
      referenceId: application.id,
      referenceType: 'HOUSE_PARTY_JOB_APPLICATION',
    });
    res.status(201).json(msg);
  } catch (e) {
    next(e);
  }
});

router.post('/parties/:partyId/jobs/:jobId/apply', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const parsed = applicationSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const job = await prisma.housePartyJob.findFirst({
      where: { id: req.params.jobId, housePartyId: req.params.partyId },
      include: { houseParty: true },
    });
    if (!job) return res.status(404).json({ error: 'Not found' });
    if (job.hostUserId === req.userId) return res.status(403).json({ error: 'Cannot apply to your own job' });
    if (job.status !== 'OPEN') return res.status(400).json({ error: 'Job not open' });
    const dup = await prisma.housePartyJobApplication.findUnique({
      where: { housePartyJobId_applicantUserId: { housePartyJobId: job.id, applicantUserId: req.userId } },
    });
    if (dup) return res.status(400).json({ error: 'Already applied' });
    const app = await prisma.housePartyJobApplication.create({
      data: {
        housePartyJobId: job.id,
        applicantUserId: req.userId,
        coverMessage: parsed.data.coverMessage,
        cvUrl: parsed.data.cvUrl,
        cvFileName: parsed.data.cvFileName,
        portfolioUrl: parsed.data.portfolioUrl,
      },
    });
    const applicant = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { userProfile: { select: { username: true } } },
    });
    const uname = applicant?.userProfile?.username || applicant?.username || 'someone';
    await createInAppNotification({
      userId: job.hostUserId,
      type: 'DIRECT_MESSAGE',
      title: 'New application',
      body: `@${uname} applied for ${job.title}`,
      referenceId: app.id,
      referenceType: 'HOUSE_PARTY_JOB_APPLICATION',
    });
    res.status(201).json(app);
  } catch (e) {
    next(e);
  }
});

router.get('/jobs', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const jobs = await prisma.housePartyJob.findMany({
      where: { hostUserId: req.userId },
      include: {
        houseParty: { select: { id: true, title: true } },
        _count: { select: { applications: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(jobs);
  } catch (e) {
    next(e);
  }
});

router.patch('/parties/:partyId/jobs/:jobId', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const job = await prisma.housePartyJob.findFirst({
      where: { id: req.params.jobId, housePartyId: req.params.partyId, hostUserId: req.userId },
    });
    if (!job) return res.status(403).json({ error: 'Forbidden' });
    const schema = postingSchema.partial().extend({ status: z.enum(['OPEN', 'CLOSED', 'FILLED']).optional() });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const updated = await prisma.housePartyJob.update({
      where: { id: job.id },
      data: parsed.data,
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.get('/activity/summary', authenticateToken, async (req, res, next) => {
  try {
    if (!assertHostEligibleRole(req, res)) return;
    const uid = req.userId;
    const [tablesCount, totalJoinedEvents, tableMembers, reviews] = await Promise.all([
      prisma.hostedTable.count({ where: { hostUserId: uid } }),
      prisma.eventAttendance.count({ where: { userId: uid, confirmed: true } }),
      prisma.hostedTableMember.count({
        where: { hostedTable: { hostUserId: uid }, status: 'GOING', userId: { not: uid } },
      }),
      prisma.userProfile.findUnique({ where: { userId: uid }, select: { serviceRatingAvg: true, serviceRatingCount: true } }),
    ]);
    res.json({
      totalTablesHosted: tablesCount,
      totalJoinedEvents,
      totalTableJoiners: tableMembers,
      averageRatingReceived: reviews?.serviceRatingAvg != null ? Number(reviews.serviceRatingAvg) : null,
      ratingCount: reviews?.serviceRatingCount ?? 0,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
