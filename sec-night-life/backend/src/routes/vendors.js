import { Router } from 'express';
import { resolveFeedScope, scopeWhere } from '../lib/feedScope.js';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { createInAppNotification } from '../lib/inAppNotifications.js';
import {
  activeVendorOwnerWhere,
  emptyVendorStats,
  findPublicVendor,
  vendorReviewStatsBatch,
} from '../lib/vendorReviews.js';
import {
  MAX_INQUIRIES_PER_DAY,
  OPEN_INQUIRY_STATUSES,
  formatInquiry,
  inquiryInclude,
  resolveInquiryTransition,
} from '../lib/vendorInquiries.js';

const router = Router();

export const VENDOR_CATEGORIES = [
  'food_snacks',
  'equipment_rental',
  'dj_av',
  'decor',
  'photography',
  'other',
];

export const VENDOR_PRICE_UNITS = ['per_event', 'per_hour', 'per_day', 'per_person', 'per_item'];
export const MAX_VENDOR_LISTINGS_PER_USER = 10;
const MAX_SCAN_FOR_RATING_SORT = 2000;

/** Empty strings from forms become null so optional fields can be cleared. */
const optionalText = (max) =>
  z.preprocess(
    (v) => (typeof v === 'string' && !v.trim() ? null : v),
    z.string().trim().max(max).nullable().optional()
  );

const imageSchema = z.object({
  url: z.string().url().max(2000),
  sort_order: z.number().int().min(0).max(20).optional(),
});

const vendorBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(VENDOR_CATEGORIES),
  description: z.string().trim().max(2000).optional().nullable(),
  website: optionalText(500),
  phone: optionalText(40),
  email: z.preprocess(
    (v) => (typeof v === 'string' && !v.trim() ? null : v),
    z.string().trim().email().max(200).nullable().optional()
  ),
  instagram: optionalText(100),
  whatsapp: optionalText(40),
  price_from_zar: z.number().min(0).max(10_000_000).optional().nullable(),
  price_unit: z.enum(VENDOR_PRICE_UNITS).optional().nullable(),
  quote_on_request: z.boolean().optional(),
  service_area: optionalText(200),
  city: optionalText(100),
  country: z.preprocess(
    (v) => (typeof v === 'string' && !v.trim() ? null : v),
    z.string().trim().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()).nullable().optional()
  ),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  is_published: z.boolean().optional(),
  images: z.array(imageSchema).max(4).optional(),
});

/** Normalize optional website: empty → null; bare domain → https://… */
function normalizeWebsite(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.slice(0, 500);
  return `https://${trimmed}`.slice(0, 500);
}

function normalizeInstagram(raw) {
  if (raw == null) return null;
  const handle = String(raw)
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '');
  return handle ? handle.slice(0, 100) : null;
}

/** Map validated body fields → Prisma columns (only keys present in `data`). */
function vendorDataFromBody(data) {
  const out = {};
  if (data.name !== undefined) out.name = data.name;
  if (data.category !== undefined) out.category = data.category;
  if (data.description !== undefined) out.description = data.description || null;
  if (data.website !== undefined) out.website = normalizeWebsite(data.website);
  if (data.phone !== undefined) out.phone = data.phone ?? null;
  if (data.email !== undefined) out.email = data.email ? data.email.toLowerCase() : null;
  if (data.instagram !== undefined) out.instagram = normalizeInstagram(data.instagram);
  if (data.whatsapp !== undefined) out.whatsapp = data.whatsapp ?? null;
  if (data.price_from_zar !== undefined) out.priceFromZar = data.price_from_zar ?? null;
  if (data.price_unit !== undefined) out.priceUnit = data.price_unit ?? null;
  if (data.quote_on_request !== undefined) out.quoteOnRequest = data.quote_on_request;
  if (data.service_area !== undefined) out.serviceArea = data.service_area ?? null;
  if (data.city !== undefined) out.city = data.city ?? null;
  if (data.country !== undefined) out.country = data.country ?? null;
  if (data.latitude !== undefined) out.latitude = data.latitude ?? null;
  if (data.longitude !== undefined) out.longitude = data.longitude ?? null;
  return out;
}

function formatVendor(row, { includeOwner = true, stats = null, viewerId = null } = {}) {
  if (!row) return null;
  const images = (row.images || [])
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((img) => ({
      id: img.id,
      url: img.url,
      sort_order: img.sortOrder,
    }));
  const profile = row.user?.userProfile;
  const isOwner = Boolean(viewerId && viewerId === row.userId);
  // Direct contact details are only shown to signed-in members (limits scraping).
  const showContact = Boolean(viewerId);
  const s = stats || emptyVendorStats();
  const out = {
    id: row.id,
    user_id: row.userId,
    name: row.name,
    category: row.category,
    description: row.description,
    website: row.website || null,
    phone: showContact ? row.phone || null : null,
    email: showContact ? row.email || null : null,
    instagram: row.instagram || null,
    whatsapp: showContact ? row.whatsapp || null : null,
    has_private_contact: Boolean(row.phone || row.email || row.whatsapp),
    price_from_zar: row.priceFromZar ?? null,
    price_unit: row.priceUnit || null,
    quote_on_request: Boolean(row.quoteOnRequest),
    service_area: row.serviceArea || null,
    city: row.city,
    country: row.country || null,
    latitude: row.latitude,
    longitude: row.longitude,
    is_published: row.isPublished,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    images,
    cover_url: images[0]?.url || null,
    rating: { average: s.averageRating, count: s.totalReviews },
  };
  if (isOwner) {
    out.unpublished_by_admin = Boolean(row.unpublishedByAdminAt);
    out.unpublished_reason = row.unpublishedByAdminAt ? row.unpublishedReason || null : null;
  }
  if (includeOwner) {
    out.owner = {
      user_id: row.userId,
      username: profile?.username || row.user?.username || null,
      avatar_url: profile?.avatarUrl || null,
    };
  }
  return out;
}

const vendorInclude = {
  images: true,
  user: {
    select: {
      id: true,
      username: true,
      userProfile: { select: { username: true, avatarUrl: true } },
    },
  },
};

function parseListQuery(q) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const category = str(q.category);
  const sort = ['top_rated', 'newest'].includes(str(q.sort)) ? str(q.sort) : 'newest';
  const minRating = Math.min(5, Math.max(0, Number(q.min_rating) || 0));
  return {
    search: str(q.search).slice(0, 100),
    category: VENDOR_CATEGORIES.includes(category) ? category : '',
    city: str(q.city).slice(0, 100),
    country: /^[A-Za-z]{2}$/.test(str(q.country)) ? str(q.country).toUpperCase() : '',
    sort,
    minRating,
    page: Math.max(1, parseInt(String(q.page || '1'), 10) || 1),
    limit: Math.min(60, Math.max(1, parseInt(String(q.limit || '24'), 10) || 24)),
  };
}

router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { search, category, city, country, sort, minRating, page, limit } = parseListQuery(req.query);
    const feed = await resolveFeedScope(req);
    const scoped = scopeWhere(feed, { countryField: 'country', supportsGeo: false });
    const scopeCountry = country || scoped.country || null;
    const scopeCity = city || (scoped.city ? feed.city : '');

    const baseWhere = {
      deletedAt: null,
      isPublished: true,
      unpublishedByAdminAt: null,
      ...activeVendorOwnerWhere,
      ...(scopeCountry ? { country: scopeCountry } : {}),
      ...(category ? { category } : {}),
    };
    const where = {
      ...baseWhere,
      ...(scopeCity ? { city: { equals: scopeCity, mode: 'insensitive' } } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              { serviceArea: { contains: search, mode: 'insensitive' } },
              { city: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    // City chips ignore the selected city so the list doesn't collapse to one option.
    const cityGroupsP = prisma.vendorBusiness.groupBy({
      by: ['city'],
      where: { ...baseWhere, city: { not: null } },
      _count: { _all: true },
      orderBy: { city: 'asc' },
      take: 100,
    });

    let pageRows;
    let total;
    let statsMap;
    if (sort === 'top_rated' || minRating > 0) {
      const candidates = await prisma.vendorBusiness.findMany({
        where,
        select: { id: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: MAX_SCAN_FOR_RATING_SORT,
      });
      statsMap = await vendorReviewStatsBatch(candidates.map((c) => c.id));
      let ranked = candidates.map((c) => ({ ...c, stats: statsMap.get(c.id) || emptyVendorStats() }));
      if (minRating > 0) ranked = ranked.filter((c) => c.stats.totalReviews > 0 && c.stats.averageRating >= minRating);
      if (sort === 'top_rated') {
        ranked.sort(
          (a, b) =>
            b.stats.adjustedRating - a.stats.adjustedRating ||
            b.stats.totalReviews - a.stats.totalReviews ||
            b.updatedAt - a.updatedAt
        );
      }
      total = ranked.length;
      const ids = ranked.slice((page - 1) * limit, page * limit).map((c) => c.id);
      const rows = ids.length
        ? await prisma.vendorBusiness.findMany({ where: { id: { in: ids } }, include: vendorInclude })
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      pageRows = ids.map((id) => byId.get(id)).filter(Boolean);
    } else {
      [pageRows, total] = await Promise.all([
        prisma.vendorBusiness.findMany({
          where,
          include: vendorInclude,
          orderBy: { updatedAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.vendorBusiness.count({ where }),
      ]);
      statsMap = await vendorReviewStatsBatch(pageRows.map((r) => r.id));
    }

    const cityGroups = await cityGroupsP;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    res.json({
      vendors: pageRows.map((r) => formatVendor(r, { stats: statsMap.get(r.id), viewerId: req.userId })),
      categories: VENDOR_CATEGORIES,
      cities: cityGroups.map((g) => g.city).filter(Boolean),
      page,
      total,
      totalPages,
      hasMore: page < totalPages,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/mine', authenticateToken, async (req, res, next) => {
  try {
    const rows = await prisma.vendorBusiness.findMany({
      where: { userId: req.userId, deletedAt: null },
      include: vendorInclude,
      orderBy: { updatedAt: 'desc' },
    });
    const statsMap = await vendorReviewStatsBatch(rows.map((r) => r.id));
    const vendors = rows.map((r) => formatVendor(r, { stats: statsMap.get(r.id), viewerId: req.userId }));
    res.json({
      vendors,
      max_listings: MAX_VENDOR_LISTINGS_PER_USER,
      // Back-compat for older clients that expect a single listing
      vendor: vendors[0] || null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Hire requests (VendorInquiry) — before /:id ─────────────────────────

const inquiryCreateSchema = z.object({
  venue_id: z.string().uuid(),
  event_date: z.string().datetime({ offset: true }).optional().nullable(),
  message: z.string().trim().min(10).max(1000),
});

const inquiryActionSchema = z.object({
  action: z.enum(['accept', 'decline', 'complete', 'cancel']),
  response: z.string().trim().max(1000).optional().nullable(),
});

router.get('/inquiries/received', authenticateToken, async (req, res, next) => {
  try {
    const rows = await prisma.vendorInquiry.findMany({
      where: { vendorBusiness: { userId: req.userId, deletedAt: null } },
      include: inquiryInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ inquiries: rows.map(formatInquiry) });
  } catch (err) {
    next(err);
  }
});

router.get('/inquiries/sent', authenticateToken, async (req, res, next) => {
  try {
    const rows = await prisma.vendorInquiry.findMany({
      where: {
        OR: [{ requesterUserId: req.userId }, { venue: { ownerUserId: req.userId, deletedAt: null } }],
      },
      include: inquiryInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ inquiries: rows.map(formatInquiry) });
  } catch (err) {
    next(err);
  }
});

router.patch('/inquiries/:inquiryId', authenticateToken, async (req, res, next) => {
  try {
    const parsed = inquiryActionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const { action, response } = parsed.data;

    const inquiry = await prisma.vendorInquiry.findUnique({
      where: { id: req.params.inquiryId },
      include: inquiryInclude,
    });
    if (!inquiry) return res.status(404).json({ error: 'Request not found' });

    const isVendor = inquiry.vendorBusiness.userId === req.userId;
    const isVenue = inquiry.requesterUserId === req.userId || inquiry.venue.ownerUserId === req.userId;
    if (!isVendor && !isVenue) return res.status(403).json({ error: 'Forbidden' });
    const actor = isVendor && (action !== 'cancel' || !isVenue) ? 'vendor' : 'venue';

    const t = resolveInquiryTransition(action, inquiry.status, actor);
    if (!t.ok) return res.status(t.status).json({ error: t.error });

    const now = new Date();
    const data = { status: t.to };
    if (t.to === 'ACCEPTED' || t.to === 'DECLINED') data.respondedAt = now;
    if (t.to === 'COMPLETED') data.completedAt = now;
    if (t.to === 'CANCELLED') data.cancelledAt = now;
    if (actor === 'vendor' && response) data.vendorResponse = response;

    // Guarded update so two people acting at once can't both win.
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.vendorInquiry.updateMany({
        where: { id: inquiry.id, status: inquiry.status },
        data,
      });
      if (u.count === 0) return null;
      if (t.to === 'COMPLETED') {
        await tx.venueVendorReview.updateMany({
          where: { vendorBusinessId: inquiry.vendorBusinessId, venueId: inquiry.venueId, inquiryId: null },
          data: { inquiryId: inquiry.id },
        });
        await tx.vendorReview.updateMany({
          where: {
            vendorBusinessId: inquiry.vendorBusinessId,
            reviewerId: inquiry.requesterUserId,
            inquiryId: null,
          },
          data: { inquiryId: inquiry.id },
        });
      }
      return tx.vendorInquiry.findUnique({ where: { id: inquiry.id }, include: inquiryInclude });
    });
    if (!updated) return res.status(409).json({ error: 'This request was just updated. Refresh and try again.' });

    const statusLabel = {
      ACCEPTED: 'accepted',
      DECLINED: 'declined',
      COMPLETED: 'marked as completed',
      CANCELLED: 'cancelled',
    }[t.to];
    const notifyUserId = actor === 'vendor' ? inquiry.requesterUserId : inquiry.vendorBusiness.userId;
    if (notifyUserId && notifyUserId !== req.userId) {
      await createInAppNotification({
        userId: notifyUserId,
        type: 'VENDOR_INQUIRY_UPDATED',
        title: `Hire request ${statusLabel}`,
        body:
          actor === 'vendor'
            ? `${inquiry.vendorBusiness.name} ${statusLabel} your hire request for ${inquiry.venue.name}.`
            : `${inquiry.venue.name} ${statusLabel} their hire request.`,
        referenceId:
          actor === 'vendor'
            ? `/VendorDetail?id=${inquiry.vendorBusinessId}`
            : '/VendorBusinessSettings?tab=requests',
        referenceType: 'ROUTE',
      });
    }

    res.json({ inquiry: formatInquiry(updated) });
  } catch (err) {
    next(err);
  }
});

/** The viewer's venues + their latest request to this vendor (drives the vendor page buttons). */
router.get('/:id/hire-status', authenticateToken, async (req, res, next) => {
  try {
    const vendor = await findPublicVendor(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    const venues = await prisma.venue.findMany({
      where: { ownerUserId: req.userId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const latest = await prisma.vendorInquiry.findMany({
      where: {
        vendorBusinessId: vendor.id,
        OR: [{ requesterUserId: req.userId }, { venueId: { in: venues.map((v) => v.id) } }],
      },
      include: inquiryInclude,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    res.json({
      is_owner: vendor.userId === req.userId,
      venues,
      open_inquiry: formatInquiry(latest.find((r) => OPEN_INQUIRY_STATUSES.includes(r.status)) || null),
      completed_hire: latest.some((r) => r.status === 'COMPLETED'),
      inquiries: latest.map(formatInquiry),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/inquiries', authenticateToken, async (req, res, next) => {
  try {
    const parsed = inquiryCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const { venue_id: venueId, event_date: eventDateRaw, message } = parsed.data;

    const vendor = await findPublicVendor(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    if (vendor.userId === req.userId) {
      return res.status(400).json({ error: 'You cannot send a hire request to your own listing.' });
    }

    const venue = await prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { id: true, name: true, ownerUserId: true },
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });
    if (venue.ownerUserId !== req.userId) {
      return res.status(403).json({ error: 'Only the venue owner can send hire requests for this venue.' });
    }

    const eventDate = eventDateRaw ? new Date(eventDateRaw) : null;
    if (eventDate && eventDate.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Event date is in the past.' });
    }

    const [open, sentToday] = await Promise.all([
      prisma.vendorInquiry.findFirst({
        where: { vendorBusinessId: vendor.id, venueId, status: { in: OPEN_INQUIRY_STATUSES } },
        select: { id: true },
      }),
      prisma.vendorInquiry.count({
        where: { requesterUserId: req.userId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
    ]);
    if (open) {
      return res.status(409).json({
        error: 'This venue already has an open request with this vendor.',
        inquiry_id: open.id,
      });
    }
    if (sentToday >= MAX_INQUIRIES_PER_DAY) {
      return res.status(429).json({ error: 'You have sent a lot of hire requests today. Please try again tomorrow.' });
    }

    const created = await prisma.vendorInquiry.create({
      data: {
        vendorBusinessId: vendor.id,
        venueId,
        requesterUserId: req.userId,
        eventDate,
        message,
      },
      include: inquiryInclude,
    });

    await createInAppNotification({
      userId: vendor.userId,
      type: 'VENDOR_INQUIRY_RECEIVED',
      title: 'New hire request',
      body: `${venue.name} wants to hire ${vendor.name}.`,
      referenceId: '/VendorBusinessSettings?tab=requests',
      referenceType: 'ROUTE',
    });

    res.status(201).json({ inquiry: formatInquiry(created) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const row = await prisma.vendorBusiness.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { ...vendorInclude, user: { select: { ...vendorInclude.user.select, deletedAt: true, suspendedAt: true } } },
    });
    if (!row) return res.status(404).json({ error: 'Vendor not found' });
    const isOwner = row.userId === req.userId;
    const isModerator = ['ADMIN', 'SUPER_ADMIN', 'MODERATOR'].includes(req.userRole);
    const ownerInactive = Boolean(row.user?.deletedAt || row.user?.suspendedAt);
    if (!isOwner && !isModerator && (!row.isPublished || ownerInactive)) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    const statsMap = await vendorReviewStatsBatch([row.id]);
    res.json(formatVendor(row, { stats: statsMap.get(row.id), viewerId: req.userId }));
  } catch (err) {
    next(err);
  }
});

async function replaceImages(tx, vendorBusinessId, images) {
  await tx.vendorBusinessImage.deleteMany({ where: { vendorBusinessId } });
  if (!images?.length) return;
  await tx.vendorBusinessImage.createMany({
    data: images.map((img, i) => ({
      vendorBusinessId,
      url: img.url,
      sortOrder: img.sort_order ?? i,
    })),
  });
}

router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const parsed = vendorBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid vendor data', details: parsed.error.flatten() });
    }
    const data = parsed.data;

    const existingCount = await prisma.vendorBusiness.count({
      where: { userId: req.userId, deletedAt: null },
    });
    if (existingCount >= MAX_VENDOR_LISTINGS_PER_USER) {
      return res.status(400).json({
        error: `You can have up to ${MAX_VENDOR_LISTINGS_PER_USER} vendor listings. Remove one to add another.`,
      });
    }

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.vendorBusiness.create({
        data: {
          userId: req.userId,
          ...vendorDataFromBody(data),
          isPublished: data.is_published ?? true,
        },
      });
      if (data.images?.length) {
        await replaceImages(tx, created.id, data.images);
      }
      await tx.userProfile.upsert({
        where: { userId: req.userId },
        create: {
          userId: req.userId,
          hasVendorInterest: true,
          vendorListingDeferred: false,
        },
        update: {
          hasVendorInterest: true,
          vendorListingDeferred: false,
        },
      });
      return tx.vendorBusiness.findUnique({
        where: { id: created.id },
        include: vendorInclude,
      });
    });

    res.status(201).json(formatVendor(row, { viewerId: req.userId }));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', authenticateToken, async (req, res, next) => {
  try {
    const parsed = vendorBodySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid vendor data', details: parsed.error.flatten() });
    }
    const data = parsed.data;

    const existing = await prisma.vendorBusiness.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ error: 'Vendor not found' });
    if (existing.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (data.is_published === true && existing.unpublishedByAdminAt) {
      return res.status(403).json({
        error: 'This listing was unpublished by SEC moderation. Contact support to have it reviewed.',
      });
    }

    const row = await prisma.$transaction(async (tx) => {
      await tx.vendorBusiness.update({
        where: { id: existing.id },
        data: {
          ...vendorDataFromBody(data),
          ...(data.is_published !== undefined && { isPublished: data.is_published }),
        },
      });
      if (data.images !== undefined) {
        await replaceImages(tx, existing.id, data.images || []);
      }
      if (data.is_published === true || data.name || data.images) {
        await tx.userProfile.updateMany({
          where: { userId: req.userId },
          data: { vendorListingDeferred: false, hasVendorInterest: true },
        });
      }
      return tx.vendorBusiness.findUnique({
        where: { id: existing.id },
        include: vendorInclude,
      });
    });

    const statsMap = await vendorReviewStatsBatch([row.id]);
    res.json(formatVendor(row, { stats: statsMap.get(row.id), viewerId: req.userId }));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticateToken, async (req, res, next) => {
  try {
    const existing = await prisma.vendorBusiness.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ error: 'Vendor not found' });
    if (existing.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });

    await prisma.$transaction([
      prisma.vendorBusiness.update({
        where: { id: existing.id },
        data: { deletedAt: new Date(), isPublished: false },
      }),
      prisma.vendorInquiry.updateMany({
        where: { vendorBusinessId: existing.id, status: { in: OPEN_INQUIRY_STATUSES } },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Create reminder notification when user said yes but deferred listing. */
export async function maybeSendVendorListingReminder(userId) {
  const published = await prisma.vendorBusiness.findFirst({
    where: { userId, deletedAt: null, isPublished: true },
    select: { id: true },
  });
  if (published) return;

  const recent = await prisma.inAppNotification.findFirst({
    where: {
      userId,
      type: 'VENDOR_LISTING_REMINDER',
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    select: { id: true },
  });
  if (recent) return;

  await createInAppNotification({
    userId,
    type: 'VENDOR_LISTING_REMINDER',
    title: 'List your vendor business',
    body: 'Finish listing your services in Settings so venues can find and contact you.',
    referenceId: '/VendorBusinessSettings',
    referenceType: 'ROUTE',
  });
}

export default router;
