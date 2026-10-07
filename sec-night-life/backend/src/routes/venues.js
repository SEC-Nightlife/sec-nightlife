import { Router } from 'express';
import { ensureUserRole } from '../lib/userRoles.js';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { createInAppNotification } from '../lib/inAppNotifications.js';
import { normalizeUsername } from '../lib/username.js';
import { normalizeCountryCode, resolveTimeZone, zoneOf } from '../lib/timezone.js';
import { syncVenueLocaleToEvents } from '../lib/venueLocale.js';
import { resolveFeedScope, scopeWhere } from '../lib/feedScope.js';

/** Keep legacy user_profiles.followed_venues in sync for older clients. */
async function syncProfileFollowedVenues(userId, venueId, following) {
  const profile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!profile) return;
  const arr = [...(profile.followedVenues || [])];
  const set = new Set(arr);
  if (following) set.add(venueId);
  else set.delete(venueId);
  await prisma.userProfile.update({
    where: { userId },
    data: { followedVenues: [...set] },
  });
}
import { isStaff, getStaffAssignmentsForUser, staffHasVenuePermission } from '../lib/access.js';
import { ensureDayCustomVenueTable } from '../lib/ensureDayCustomVenueTable.js';
import { sendEmail } from '../lib/email.js';
import { buildVenueDayTableTiers } from '../lib/buildVenueDayTableTiers.js';
import { resolveDayBookingSeatingPlans, attachGuestSeatingPlans } from '../lib/seatingPlanHelpers.js';

const router = Router();

function reviewAverageOneDecimal(avg) {
  if (avg == null || Number.isNaN(Number(avg))) return 0;
  return Math.round(Number(avg) * 10) / 10;
}

/** Aggregated venue review stats (non-flagged only). */
async function venueReviewStatsByVenueIds(venueIds) {
  const ids = [...new Set(venueIds)].filter(Boolean);
  if (ids.length === 0) return new Map();
  const rows = await prisma.venueReview.groupBy({
    by: ['venueId'],
    where: { venueId: { in: ids }, flagged: false },
    _avg: { rating: true },
    _count: { _all: true },
  });
  const m = new Map();
  for (const r of rows) {
    m.set(r.venueId, {
      review_average: reviewAverageOneDecimal(r._avg.rating),
      review_count: r._count._all,
    });
  }
  return m;
}

/** Do not fail the whole venue list if review/follow tables are out of sync with Prisma (migration drift). */
async function safeVenueReviewStatsByVenueIds(venueIds) {
  try {
    return await venueReviewStatsByVenueIds(venueIds);
  } catch (err) {
    logger.warn('venueReviewStatsByVenueIds failed; using empty stats', { err: String(err?.message || err), code: err?.code });
    return new Map();
  }
}

async function safeVenueFollowerCountMap(venueIds) {
  const ids = [...new Set(venueIds)].filter(Boolean);
  if (ids.length === 0) return new Map();
  try {
    const followRows = await prisma.venueFollow.groupBy({
      by: ['venueId'],
      where: { venueId: { in: ids } },
      _count: { _all: true },
    });
    return new Map(followRows.map((r) => [r.venueId, r._count._all]));
  } catch (err) {
    logger.warn('venueFollow groupBy failed; using zero follower counts', { err: String(err?.message || err), code: err?.code });
    return new Map();
  }
}

function formatVenueListRow(v, stats, followerCount) {
  const s = stats.get(v.id);
  return {
    id: v.id,
    name: v.name,
    venue_type: v.venueType,
    city: v.city,
    address: v.address,
    suburb: v.suburb,
    province: v.province,
    country_code: v.countryCode ?? null,
    timezone: zoneOf(v),
    latitude: v.latitude,
    longitude: v.longitude,
    is_verified: v.isVerified,
    compliance_status: v.complianceStatus,
    logo_url: v.logoUrl,
    cover_image_url: v.coverImageUrl,
    rating: v.rating,
    owner_user_id: v.ownerUserId,
    review_average: s?.review_average ?? 0,
    review_count: s?.review_count ?? 0,
    follower_count: followerCount ?? 0,
  };
}

const venueCreateSchema = z.object({
  name: z.string().min(1).max(200),
  venue_type: z.string().min(1),
  city: z.string().min(1),
  address: z.string().optional().nullable(),
  suburb: z.string().optional().nullable(),
  province: z.string().optional().nullable(),
  country_code: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  bio: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  website: z.string().url().optional().nullable().or(z.literal('')),
  instagram: z.string().optional().nullable(),
  capacity: z.number().int().min(0).optional().nullable(),
  age_limit: z.number().int().min(0).optional().nullable(),
  logo_url: z.string().url().optional().nullable().or(z.literal('')),
  cover_image_url: z.string().url().optional().nullable().or(z.literal(''))
});

router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { city, compliance_status, limit = 50 } = req.query;
    const where = { deletedAt: null };
    if (city) where.city = { equals: String(city), mode: 'insensitive' };
    const countryCode = normalizeCountryCode(req.query.country_code || req.query.country);
    if (countryCode) where.countryCode = countryCode;
    if (!req.query.id && !req.query.owner_user_id) {
      const scoped = scopeWhere(await resolveFeedScope(req));
      if (scoped.city && where.city) delete scoped.city;
      Object.assign(where, scoped);
    }
    if (compliance_status) where.complianceStatus = compliance_status;

    const venues = await prisma.venue.findMany({
      where,
      orderBy: { rating: 'desc' },
      take: Math.min(parseInt(limit) || 50, 100)
    });

    const stats = await safeVenueReviewStatsByVenueIds(venues.map((v) => v.id));
    const vidListRoot = venues.map((v) => v.id);
    const fcMapRoot = await safeVenueFollowerCountMap(vidListRoot);

    const list = venues.map((v) => formatVenueListRow(v, stats, fcMapRoot.get(v.id) ?? 0));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.get('/filter', optionalAuth, async (req, res, next) => {
  try {
    const { city, id, owner_user_id, compliance_status, venue_type, sort, limit = 50 } = req.query;
    const where = { deletedAt: null };
    if (city) where.city = { equals: String(city), mode: 'insensitive' };
    const countryCode = normalizeCountryCode(req.query.country_code || req.query.country);
    if (countryCode) where.countryCode = countryCode;
    if (!req.query.id && !req.query.owner_user_id) {
      const scoped = scopeWhere(await resolveFeedScope(req));
      if (scoped.city && where.city) delete scoped.city;
      Object.assign(where, scoped);
    }
    if (id) where.id = String(id);
    if (owner_user_id) where.ownerUserId = String(owner_user_id);
    if (compliance_status) where.complianceStatus = compliance_status;
    if (venue_type) where.venueType = String(venue_type);

    const orderBy = sort === '-rating' ? { rating: 'desc' } : { name: 'asc' };
    const venues = await prisma.venue.findMany({
      where,
      orderBy,
      take: Math.min(parseInt(limit) || 50, 100)
    });

    const stats = await safeVenueReviewStatsByVenueIds(venues.map((v) => v.id));
    const vidList = venues.map((v) => v.id);
    const fcMap = await safeVenueFollowerCountMap(vidList);

    const list = venues.map((v) => formatVenueListRow(v, stats, fcMap.get(v.id) ?? 0));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

/**
 * Authenticated: venues owned by the current user (stable for business dashboard).
 *
 * If the UI shows "No Venue Registered" but rows exist in Neon, verify linkage (not Prisma connectivity):
 *   SELECT id, email, role FROM users WHERE email ILIKE '%you@example.com%';
 *   SELECT id, name, owner_user_id, deleted_at FROM venues WHERE name ILIKE '%your venue%';
 *   Expect venues.owner_user_id = users.id for your login.
 */
router.get('/mine', authenticateToken, async (req, res, next) => {
  try {
    const [ownedVenues, staffAssignments] = await Promise.all([
      prisma.venue.findMany({
        where: { deletedAt: null, ownerUserId: req.userId },
        orderBy: { name: 'asc' },
        take: 100,
      }),
      getStaffAssignmentsForUser(req.userId),
    ]);

    const ownedIds = new Set(ownedVenues.map((v) => v.id));
    const staffVenues = staffAssignments
      .filter((row) => row.venue && !ownedIds.has(row.venue.id))
      .map((row) => ({ venue: row.venue, permissions: row.permissions }));

    const allVenueRows = [
      ...ownedVenues.map((v) => ({ venue: v, isOwner: true, staffPermissions: null })),
      ...staffVenues.map(({ venue, permissions }) => ({
        venue,
        isOwner: false,
        staffPermissions: permissions,
      })),
    ];

    const stats = await safeVenueReviewStatsByVenueIds(allVenueRows.map((r) => r.venue.id));
    const fcMap = await safeVenueFollowerCountMap(allVenueRows.map((r) => r.venue.id));
    const list = allVenueRows.map(({ venue, isOwner, staffPermissions }) => ({
      ...formatVenueListRow(venue, stats, fcMap.get(venue.id) ?? 0),
      // Owner/staff only — not included in public formatVenueListRow
      payout_setup_complete: Boolean(venue.paystackRecipientCode),
      paystack_recipient_code: venue.paystackRecipientCode || null,
      is_owner: isOwner,
      is_staff_access: !isOwner,
      staff_permissions: staffPermissions,
    }));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/follow-status', authenticateToken, async (req, res, next) => {
  try {
    const venueId = req.params.id;
    const venue = await prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { id: true },
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });
    const row = await prisma.venueFollow.findUnique({
      where: { userId_venueId: { userId: req.userId, venueId } },
    });
    res.json({ following: !!row });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/follow', authenticateToken, async (req, res, next) => {
  try {
    const venueId = req.params.id;
    const venue = await prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { id: true, name: true, ownerUserId: true },
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });

    const existing = await prisma.venueFollow.findUnique({
      where: { userId_venueId: { userId: req.userId, venueId } },
    });

    if (existing) {
      await prisma.venueFollow.delete({ where: { id: existing.id } });
      await syncProfileFollowedVenues(req.userId, venueId, false);
      return res.json({ following: false });
    }

    await prisma.venueFollow.create({
      data: { userId: req.userId, venueId },
    });
    await syncProfileFollowedVenues(req.userId, venueId, true);

    if (venue.ownerUserId && venue.ownerUserId !== req.userId) {
      const follower = await prisma.user.findUnique({
        where: { id: req.userId },
        select: {
          username: true,
          fullName: true,
          userProfile: { select: { username: true } },
        },
      });
      const uname =
        normalizeUsername(follower?.userProfile?.username || follower?.username || '') ||
        follower?.fullName ||
        'someone';
      const handle = String(uname).startsWith('@') ? String(uname) : `@${uname}`;
      await createInAppNotification({
        userId: venue.ownerUserId,
        venueId: venue.id,
        type: 'VENUE_FOLLOW',
        title: 'New follower',
        body: `${handle} started following ${venue.name}`,
        referenceId: req.userId,
        referenceType: 'USER',
      });
    }

    return res.json({ following: true });
  } catch (err) {
    next(err);
  }
});

/** Grouped day table tiers for VenueBook (host/join flows). */
router.get('/:id/day-table-tiers', optionalAuth, async (req, res, next) => {
  try {
    const windowStart = req.query.windowStart || req.query.window_start || null;
    const windowEnd = req.query.windowEnd || req.query.window_end || null;
    const result = await buildVenueDayTableTiers(req.params.id, { windowStart, windowEnd });
    if (!result) return res.status(404).json({ error: 'Venue not found' });
    const seatingPlans = await resolveDayBookingSeatingPlans(req.params.id);
    res.json(attachGuestSeatingPlans(result, seatingPlans));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const venue = await prisma.venue.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { _count: { select: { follows: true } } },
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });

    const stats = await safeVenueReviewStatsByVenueIds([venue.id]);
    const s = stats.get(venue.id);

    res.json({
      id: venue.id,
      name: venue.name,
      venue_type: venue.venueType,
      city: venue.city,
      address: venue.address,
      suburb: venue.suburb,
      province: venue.province,
      country_code: venue.countryCode ?? null,
      timezone: zoneOf(venue),
      latitude: venue.latitude,
      longitude: venue.longitude,
      bio: venue.bio,
      is_verified: venue.isVerified,
      compliance_status: venue.complianceStatus,
      logo_url: venue.logoUrl,
      cover_image_url: venue.coverImageUrl,
      phone: venue.phone,
      email: venue.email,
      website: venue.website,
      instagram: venue.instagram,
      capacity: venue.capacity,
      age_limit: venue.ageLimit,
      rating: venue.rating,
      owner_user_id: venue.ownerUserId,
      review_average: s?.review_average ?? 0,
      review_count: s?.review_count ?? 0,
      follower_count: venue._count.follows,
      accepts_day_bookings: venue.acceptsDayBookings,
      show_seating_plan_for_day_bookings: venue.showSeatingPlanForDayBookings,
      max_booking_duration_hours: venue.maxBookingDurationHours,
      host_table_fee_zar: venue.hostTableFeeZar,
      custom_table_booking_fee_zar: venue.customTableBookingFeeZar,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const parsed = venueCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const data = parsed.data;

    await ensureUserRole(req.userId, 'business');
    const createCountry = normalizeCountryCode(data.country_code) || 'ZA';
    const venue = await prisma.venue.create({
      data: {
        ownerUserId: req.userId,
        name: data.name,
        venueType: data.venue_type,
        city: data.city,
        address: data.address,
        suburb: data.suburb,
        province: data.province,
        countryCode: createCountry,
        timezone: resolveTimeZone({
          latitude: data.latitude,
          longitude: data.longitude,
          countryCode: createCountry,
        }),
        latitude: data.latitude,
        longitude: data.longitude,
        bio: data.bio,
        phone: data.phone,
        email: data.email,
        website: data.website,
        instagram: data.instagram,
        capacity: data.capacity,
        ageLimit: data.age_limit,
        logoUrl: data.logo_url,
        coverImageUrl: data.cover_image_url,
        complianceStatus: 'pending',
      }
    });

    res.status(201).json({
      id: venue.id,
      name: venue.name,
      venue_type: venue.venueType,
      city: venue.city,
      address: venue.address,
      suburb: venue.suburb,
      province: venue.province,
      country_code: venue.countryCode ?? null,
      timezone: zoneOf(venue),
      latitude: venue.latitude,
      longitude: venue.longitude,
      compliance_status: venue.complianceStatus,
      owner_user_id: venue.ownerUserId
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', authenticateToken, async (req, res, next) => {
  try {
    const venue = await prisma.venue.findFirst({
      where: { id: req.params.id, deletedAt: null }
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });
    const isOwner = venue.ownerUserId === req.userId;
    const canManageTables =
      !isOwner && (await staffHasVenuePermission(req.userId, venue.id, 'venue_tables'));
    if (!isOwner && !isStaff(req.userRole) && !canManageTables) {
      return res.status(403).json({ error: 'Not authorized to update this venue' });
    }

    const parsed = venueCreateSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input' });
    }
    const data = parsed.data;
    const extra = z
      .object({
        accepts_day_bookings: z.boolean().optional(),
        show_seating_plan_for_day_bookings: z.boolean().optional(),
        max_booking_duration_hours: z.number().int().min(1).nullable().optional(),
        host_table_fee_zar: z.number().min(0).optional(),
        custom_table_booking_fee_zar: z.number().min(0).optional(),
        external_booking_links: z.any().optional(),
        booking_policies: z.any().optional(),
      })
      .safeParse(req.body);
    const extraData = extra.success ? extra.data : {};

    const updates = {};
    if (data.name != null) updates.name = data.name;
    if (data.venue_type != null) updates.venueType = data.venue_type;
    if (data.city != null) updates.city = data.city;
    if (data.address != null) updates.address = data.address;
    if (data.suburb != null) updates.suburb = data.suburb;
    if (data.province != null) updates.province = data.province;
    if (data.latitude != null) updates.latitude = data.latitude;
    if (data.longitude != null) updates.longitude = data.longitude;
    if (data.country_code != null) {
      const cc = normalizeCountryCode(data.country_code);
      if (cc) updates.countryCode = cc;
    }
    if (data.latitude != null || data.longitude != null || updates.countryCode) {
      updates.timezone = resolveTimeZone({
        latitude: updates.latitude ?? venue.latitude,
        longitude: updates.longitude ?? venue.longitude,
        countryCode: updates.countryCode ?? venue.countryCode,
      });
    }
    if (data.bio != null) updates.bio = data.bio;
    if (data.phone != null) updates.phone = data.phone;
    if (data.email != null) updates.email = data.email;
    if (data.website !== undefined) updates.website = data.website;
    if (data.instagram != null) updates.instagram = data.instagram;
    if (data.capacity != null) updates.capacity = data.capacity;
    if (data.age_limit != null) updates.ageLimit = data.age_limit;
    if (data.logo_url !== undefined) updates.logoUrl = data.logo_url;
    if (data.cover_image_url !== undefined) updates.coverImageUrl = data.cover_image_url;
    if (extraData.accepts_day_bookings != null) updates.acceptsDayBookings = extraData.accepts_day_bookings;
    if (extra.success && 'max_booking_duration_hours' in extra.data) {
      updates.maxBookingDurationHours = extra.data.max_booking_duration_hours;
    }
    if (extraData.show_seating_plan_for_day_bookings != null) {
      if (extraData.show_seating_plan_for_day_bookings) {
        const planCount = await prisma.venueSeatingPlan.count({ where: { venueId: venue.id } });
        if (planCount === 0) {
          return res.status(400).json({ error: 'Upload at least one seating plan before enabling this option.' });
        }
      }
      updates.showSeatingPlanForDayBookings = extraData.show_seating_plan_for_day_bookings;
    }
    if (extra.success && 'host_table_fee_zar' in extra.data) {
      updates.hostTableFeeZar = extra.data.host_table_fee_zar;
    }
    if (extra.success && 'custom_table_booking_fee_zar' in extra.data) {
      updates.customTableBookingFeeZar = extra.data.custom_table_booking_fee_zar;
    }
    if (extraData.external_booking_links !== undefined) updates.externalBookingLinks = extraData.external_booking_links;
    if (extraData.booking_policies !== undefined) updates.bookingPolicies = extraData.booking_policies;

    const updated = await prisma.venue.update({
      where: { id: venue.id },
      data: updates
    });
    if (updates.timezone || updates.countryCode) {
      await syncVenueLocaleToEvents(updated);
    }

    if (extraData.accepts_day_bookings === true) {
      await ensureDayCustomVenueTable(venue.id);
    }

    res.json({
      id: updated.id,
      name: updated.name,
      venue_type: updated.venueType,
      city: updated.city,
      address: updated.address,
      suburb: updated.suburb,
      province: updated.province,
      country_code: updated.countryCode ?? null,
      timezone: zoneOf(updated),
      latitude: updated.latitude,
      longitude: updated.longitude,
      cover_image_url: updated.coverImageUrl,
      compliance_status: updated.complianceStatus,
      host_table_fee_zar: updated.hostTableFeeZar,
      custom_table_booking_fee_zar: updated.customTableBookingFeeZar,
      max_booking_duration_hours: updated.maxBookingDurationHours,
    });
  } catch (err) {
    next(err);
  }
});

/** Ensure day custom listing exists; optional guest request payload. */
router.post('/:id/custom-table-request', authenticateToken, async (req, res, next) => {
  try {
    const venue = await prisma.venue.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { owner: { select: { email: true } } },
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });
    if (!venue.acceptsDayBookings) {
      return res.status(400).json({ error: 'This venue has not enabled day table bookings' });
    }
    const listing = await ensureDayCustomVenueTable(venue.id);
    if (!listing?.id) {
      return res.status(500).json({ error: 'Could not create custom table listing' });
    }

    const body = req.body || {};
    const hasSpecs =
      body.guestCount != null ||
      body.notes ||
      body.preferredTime ||
      body.preferredDate ||
      body.proposedMinimumSpend != null ||
      (Array.isArray(body.selectedMenuItems) && body.selectedMenuItems.length > 0);

    if (!hasSpecs) {
      return res.json({
        customListingId: listing.id,
        tableId: listing.id,
        venueId: venue.id,
      });
    }

    const userSpecs = {
      guestCount: body.guestCount != null ? Number(body.guestCount) : undefined,
      proposedMinimumSpend:
        body.proposedMinimumSpend != null ? Number(body.proposedMinimumSpend) : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      preferredDate: typeof body.preferredDate === 'string' ? body.preferredDate : undefined,
      preferredTime: typeof body.preferredTime === 'string' ? body.preferredTime : undefined,
      minSpendMode: body.minSpendMode === 'menu' || body.minSpendMode === 'manual' ? body.minSpendMode : undefined,
      selectedMenuItems: body.selectedMenuItems,
    };

    const member = await prisma.venueTableMember.upsert({
      where: { venueTableId_userId: { venueTableId: listing.id, userId: req.userId } },
      create: {
        venueTableId: listing.id,
        userId: req.userId,
        userSpecs,
        status: 'PENDING_VENUE_REVIEW',
      },
      update: {
        userSpecs,
        status: 'PENDING_VENUE_REVIEW',
        declineReason: null,
      },
    });

    await prisma.notification.create({
      data: {
        userId: venue.ownerUserId,
        type: 'TABLE_REQUEST',
        title: 'New table request',
        body: `A guest submitted a custom table request. Review in Tables & day bookings.`,
        actionUrl: '/BusinessVenueTables?tab=requests',
      },
    });

    const reviewUrl = `${process.env.APP_URL || 'https://secnightlife.com'}/BusinessVenueTables?tab=requests`;
    if (venue.owner?.email) {
      try {
        await sendEmail({
          to: venue.owner.email,
          subject: `New custom table request — ${venue.name}`,
          text: `A guest submitted a custom table request at ${venue.name}.\n\nReview in SEC:\n${reviewUrl}`,
          html: `<p>A guest submitted a custom table request at <strong>${venue.name}</strong>.</p><p><a href="${reviewUrl}">Review request in SEC</a></p>`,
        });
      } catch (err) {
        logger?.warn?.('custom table request venue email failed', { err: String(err?.message || err) });
      }
    }

    res.status(201).json({
      customListingId: listing.id,
      tableId: listing.id,
      venueId: venue.id,
      memberId: member.id,
      status: member.status,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
