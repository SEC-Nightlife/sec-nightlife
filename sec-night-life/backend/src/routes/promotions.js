import { Router } from 'express';
import { resolveFeedScope, eventScopeWhere } from '../lib/feedScope.js';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { isStaff, staffHasVenuePermission, resolveBusinessVenueScope, staffCtxFromQuery } from '../lib/access.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { logFriendActivity } from '../lib/friendActivity.js';
import { sendEmail } from '../lib/email.js';
import {
  activatePromotionAfterPublishPayment,
  isPromotionPublishPayment,
  resolvePromotionIdFromMetadata,
} from '../lib/promotionPublishAfterPayment.js';
import { buildPaystackInitializeBody } from '../lib/paystackInitialize.js';

const router = Router();
const PROMOTION_TYPES = ['VENUE_PROMOTION', 'EVENT_PROMOTION', 'SPECIAL_OFFER', 'ANNOUNCEMENT'];
const PROMOTION_ROTATION_WINDOW_MINUTES = 2;
const BOOSTED_WEIGHT = 3;
const ORGANIC_WEIGHT = 1;
const PROMOTION_PUBLISH_ZAR_PER_DAY = 50;
const PROMOTION_BOOST_ZAR_PER_DAY = 150;

function formatOwnerPromotion(p) {
  return {
    id: p.id,
    venueId: p.venueId,
    eventId: p.eventId,
    promotionType: p.type,
    title: p.title,
    body: p.description,
    imageUrl: p.imageUrl,
    imagePublicId: p.imagePublicId,
    targetCity: p.targetCity,
    status: p.status,
    startsAt: p.startAt,
    endsAt: p.endAt,
    boosted: p.boosted,
    boostedAt: p.boostedAt,
    boostExpiresAt: p.boostExpiresAt,
    boostImpressions: p.boostImpressions,
    organicImpressions: p.organicImpressions,
    totalClicks: p.totalClicks,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    eventName: p.event?.title || null,
  };
}

function computeUniquePromotionStats(impressions = []) {
  const viewKeys = new Set();
  const clickKeys = new Set();
  for (const impression of impressions) {
    const identity = impression.userId ? `u:${impression.userId}` : `s:${impression.sessionId}`;
    if (impression.type === 'VIEW') viewKeys.add(identity);
    if (impression.type === 'CLICK') clickKeys.add(identity);
  }
  return {
    uniqueViews: viewKeys.size,
    uniqueClicks: clickKeys.size,
  };
}

/**
 * Business UI can show "Business" mode when the user owns venues even if `User.role` is still USER.
 * Align promotions with that: VENUE role, staff, or at least one owned venue.
 */
async function assertPromotionsAccess(req, res) {
  if (!req.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  if (isStaff(req.userRole)) return true;
  if (req.userRole === 'VENUE') return true;
  const ownedCount = await prisma.venue.count({
    where: { ownerUserId: req.userId, deletedAt: null },
  });
  if (ownedCount > 0) return true;
  const staffCount = await prisma.venueStaffAssignment.count({
    where: { userId: req.userId, revokedAt: null },
  });
  if (staffCount > 0) return true;
  res.status(403).json({ error: 'Only business owners can perform this action' });
  return false;
}

function calculateScore(promotion) {
  const hours = (Date.now() - new Date(promotion.createdAt).getTime()) / (1000 * 60 * 60);
  const recency = hours <= 24 ? 10 : hours <= 48 ? 5 : 0;
  return (promotion.boosted ? 1500 : 0) + (promotion.boostImpressions < 500 ? 50 : 0) + (promotion.organicImpressions < 100 ? 20 : 0) + recency;
}

function interleavePromotions(boosted, organic) {
  const result = [];
  let b = 0;
  let o = 0;
  /** More B slots than before so paid boosts surface more often in the feed. */
  const slots = ['B', 'B', 'B', 'O', 'B', 'O'];

  while (b < boosted.length || o < organic.length) {
    for (const slot of slots) {
      if (slot === 'B') {
        if (b < boosted.length) result.push(boosted[b++]);
        else if (o < organic.length) result.push(organic[o++]);
      } else if (o < organic.length) result.push(organic[o++]);
      else if (b < boosted.length) result.push(boosted[b++]);
      if (b >= boosted.length && o >= organic.length) break;
    }
  }
  return result;
}

function hashString(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Weighted, deterministic order without duplicates:
 * boosted promotions get higher exposure frequency across rotating windows.
 */
function weightedWindowOrder(promotions, sessionSeed) {
  const rand = seededRandom(hashString(sessionSeed));
  const prepared = promotions.map((item) => {
    const weight = item.boosted ? BOOSTED_WEIGHT : ORGANIC_WEIGHT;
    // Efraimidis-Spirakis style weighted sampling key.
    const u = Math.max(rand(), Number.EPSILON);
    const key = Math.pow(u, 1 / weight);
    return { item, key };
  });
  prepared.sort((a, b) => {
    if (a.key !== b.key) return b.key - a.key;
    return new Date(b.item.createdAt).getTime() - new Date(a.item.createdAt).getTime();
  });
  return prepared.map((x) => x.item);
}

const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

/** For PATCH: omit field means undefined (do not overwrite); '' or null clears. */
const emptyToNullKeepUndefined = (v) => {
  if (v === undefined) return undefined;
  if (v === '' || v === null) return null;
  return v;
};

/** Accepts ISO strings from Date#toISOString(); avoids Zod .datetime() strict RFC edge cases in some environments. */
const isoDateTimeString = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Invalid date' });

/** Zod .url() rejects some valid Cloudinary / CDN URLs; accept any absolute http(s) URL. */
function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const httpUrlOrNull = z.preprocess(
  emptyToNull,
  z.union([z.string().min(1).max(2048).refine(isHttpUrl, { message: 'Invalid image URL' }), z.null()]).optional()
);

const patchHttpUrlOrNull = z.preprocess(
  emptyToNullKeepUndefined,
  z.union([z.string().min(1).max(2048).refine(isHttpUrl, { message: 'Invalid image URL' }), z.null()]).optional()
);

function normalizePromotionCreateBody(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof raw !== 'object') return {};
  const b = { ...raw };
  if (b.venue_id && !b.venueId) b.venueId = b.venue_id;
  if (b.event_id != null && b.eventId == null) b.eventId = b.event_id;
  if (b.promotion_type && !b.promotionType) b.promotionType = b.promotion_type;
  if (b.type && !b.promotionType) b.promotionType = b.type;
  if (b.starts_at && !b.startsAt) b.startsAt = b.starts_at;
  if (b.ends_at && !b.endsAt) b.endsAt = b.ends_at;
  if (b.start_at && !b.startsAt) b.startsAt = b.start_at;
  if (b.end_at && !b.endsAt) b.endsAt = b.end_at;
  if (b.startAt && !b.startsAt) b.startsAt = b.startAt;
  if (b.endAt && !b.endsAt) b.endsAt = b.endAt;
  if (b.startDate && !b.startsAt) b.startsAt = b.startDate;
  if (b.endDate && !b.endsAt) b.endsAt = b.endDate;
  if (b.image_url && !b.imageUrl) b.imageUrl = b.image_url;
  if (b.image_public_id && !b.imagePublicId) b.imagePublicId = b.image_public_id;
  if (b.target_city != null && b.targetCity == null) b.targetCity = b.target_city;
  if (b.description && !b.body) b.body = b.description;
  return b;
}

const createSchema = z.object({
  venueId: z.string().trim().min(1),
  eventId: z.preprocess(emptyToNull, z.union([z.string().trim().min(1), z.null()]).optional()),
  promotionType: z.enum(PROMOTION_TYPES),
  title: z.string().trim().min(1).max(100),
  body: z.string().trim().min(1).max(500),
  imageUrl: httpUrlOrNull,
  imagePublicId: z.preprocess(emptyToNull, z.union([z.string().trim().min(1), z.null()]).optional()),
  targetCity: z.preprocess(emptyToNull, z.union([z.string().trim().max(100), z.null()]).optional()),
  startsAt: isoDateTimeString,
  endsAt: isoDateTimeString,
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  body: z.string().trim().min(1).max(500).optional(),
  imageUrl: patchHttpUrlOrNull,
  imagePublicId: z.preprocess(emptyToNullKeepUndefined, z.union([z.string().trim().min(1), z.null()]).optional()),
  targetCity: z.preprocess(emptyToNullKeepUndefined, z.union([z.string().trim().max(100), z.null()]).optional()),
  startsAt: isoDateTimeString.optional(),
  endsAt: isoDateTimeString.optional(),
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
  promotionType: z.enum(PROMOTION_TYPES).optional(),
  eventId: z.preprocess(emptyToNullKeepUndefined, z.union([z.string().trim().min(1), z.null()]).optional()),
});

const trackSchema = z.object({
  type: z.enum(['VIEW', 'CLICK']),
  sessionId: z.string().min(8).max(128),
});

async function fetchVenuePromotionsList(venueId) {
  const now = new Date();
  await prisma.promotion.updateMany({
    where: { venueId, deletedAt: null, status: 'ACTIVE', endAt: { lt: now } },
    data: { status: 'ENDED' },
  });

  const promotions = await prisma.promotion.findMany({
    where: { venueId, deletedAt: null },
    include: {
      event: { select: { title: true } },
      impressions: { select: { userId: true, sessionId: true, type: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return promotions.map((promotion) => {
    const base = formatOwnerPromotion(promotion);
    const unique = computeUniquePromotionStats(promotion.impressions);
    return {
      ...base,
      boostImpressions: unique.uniqueViews,
      organicImpressions: 0,
      totalClicks: unique.uniqueClicks,
    };
  });
}

router.post('/', authenticateToken, async (req, res, next) => {
  try {
    if (!(await assertPromotionsAccess(req, res))) return;
    const rawBody = normalizePromotionCreateBody(req.body);
    const staffCtx = staffCtxFromQuery(req.query);
    let venueId = rawBody.venueId;
    if (staffCtx) {
      const scope = await resolveBusinessVenueScope(req.userId, {
        staffCtx,
        permission: 'promotions',
      });
      if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
      venueId = scope.venueIds[0];
    }
    const parsed = createSchema.safeParse({ ...rawBody, venueId });
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid promotion payload',
        details: parsed.error.flatten(),
        issues: parsed.error.issues,
      });
    }

    const data = parsed.data;
    const startsAt = new Date(data.startsAt);
    const endsAt = new Date(data.endsAt);
    const now = new Date();
    if (endsAt <= startsAt) return res.status(400).json({ error: 'endsAt must be after startsAt' });
    if (endsAt > new Date(startsAt.getTime() + 30 * 24 * 60 * 60 * 1000)) return res.status(400).json({ error: 'Promotion duration cannot exceed 30 days' });

    const venue = await prisma.venue.findFirst({
      where: { id: data.venueId, deletedAt: null },
      include: { owner: { select: { email: true } } },
    });
    if (!venue || !(await staffHasVenuePermission(req.userId, venue.id, 'promotions'))) {
      return res.status(403).json({ error: 'You can only create promotions for venues you manage' });
    }

    if (data.eventId) {
      const event = await prisma.event.findFirst({ where: { id: data.eventId, venueId: data.venueId, deletedAt: null } });
      if (!event) return res.status(400).json({ error: 'Selected event does not belong to this venue' });
    }

    const eventIdForDb = data.eventId || null;

    const created = await prisma.promotion.create({
      data: {
        venueId: data.venueId,
        eventId: eventIdForDb,
        type: data.promotionType,
        title: data.title,
        description: data.body,
        imageUrl: data.imageUrl || null,
        imagePublicId: data.imagePublicId || null,
        targetCity: data.targetCity || null,
        targetCountryCode: venue.countryCode || null,
        status: 'DRAFT',
        startAt: startsAt,
        endAt: endsAt,
      },
      include: { event: { select: { title: true } } },
    });

    if (venue.owner?.email) {
      sendEmail({
        to: venue.owner.email,
        subject: `Promotion draft saved — ${created.title}`,
        text: `Your promotion "${created.title}" is saved as a draft. Open Business Promotions to pay for publish days (R${PROMOTION_PUBLISH_ZAR_PER_DAY}/day) and go live.`,
      }).catch(() => {});
    }

    res.status(201).json(formatOwnerPromotion(created));
  } catch (err) {
    next(err);
  }
});

router.get('/venue/:venueId', authenticateToken, async (req, res, next) => {
  try {
    if (!(await assertPromotionsAccess(req, res))) return;
    const canView = await staffHasVenuePermission(req.userId, req.params.venueId, 'promotions');
    if (!canView) return res.status(403).json({ error: 'Forbidden' });

    res.json(await fetchVenuePromotionsList(req.params.venueId));
  } catch (err) {
    next(err);
  }
});

router.patch('/:promotionId', authenticateToken, async (req, res, next) => {
  try {
    if (!(await assertPromotionsAccess(req, res))) return;
    const parsed = patchSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });

    const existing = await prisma.promotion.findFirst({ where: { id: req.params.promotionId, deletedAt: null }, include: { venue: true } });
    if (!existing) return res.status(404).json({ error: 'Promotion not found' });
    if (existing.venue.ownerUserId !== req.userId && !(await staffHasVenuePermission(req.userId, existing.venueId, 'promotions'))) return res.status(403).json({ error: 'Forbidden' });
    if (existing.status === 'ENDED') {
      return res.status(400).json({ error: 'Ended promotions cannot be edited. Delete or create a new promotion.' });
    }
    if (parsed.data.status === 'ACTIVE' && existing.status === 'DRAFT') {
      return res.status(400).json({ error: 'Complete payment to publish your promotion.' });
    }

    const venueId = existing.venueId;
    let nextEventId = existing.eventId;
    if (parsed.data.eventId !== undefined) {
      if (parsed.data.eventId) {
        const event = await prisma.event.findFirst({ where: { id: parsed.data.eventId, venueId, deletedAt: null } });
        if (!event) return res.status(400).json({ error: 'Selected event does not belong to this venue' });
        nextEventId = parsed.data.eventId;
      } else {
        nextEventId = null;
      }
    }

    const startsAt = parsed.data.startsAt ? new Date(parsed.data.startsAt) : existing.startAt;
    const endsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt) : existing.endAt;
    if (endsAt <= startsAt) return res.status(400).json({ error: 'endsAt must be after startsAt' });
    if (endsAt > new Date(startsAt.getTime() + 30 * 24 * 60 * 60 * 1000)) return res.status(400).json({ error: 'Promotion duration cannot exceed 30 days' });

    const updateData = {
      title: parsed.data.title,
      description: parsed.data.body,
      imageUrl: parsed.data.imageUrl,
      imagePublicId: parsed.data.imagePublicId,
      targetCity: parsed.data.targetCity,
      startAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : undefined,
      endAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : undefined,
      status: parsed.data.status,
      type: parsed.data.promotionType,
      eventId: parsed.data.eventId !== undefined ? nextEventId : undefined,
    };

    const updated = await prisma.promotion.update({
      where: { id: existing.id },
      data: updateData,
      include: { event: { select: { title: true } } },
    });

    res.json(formatOwnerPromotion(updated));
  } catch (err) {
    next(err);
  }
});

router.delete('/:promotionId', authenticateToken, async (req, res, next) => {
  try {
    if (!(await assertPromotionsAccess(req, res))) return;
    const existing = await prisma.promotion.findFirst({ where: { id: req.params.promotionId, deletedAt: null }, include: { venue: true } });
    if (!existing) return res.status(404).json({ error: 'Promotion not found' });
    if (existing.venue.ownerUserId !== req.userId && !(await staffHasVenuePermission(req.userId, existing.venueId, 'promotions'))) return res.status(403).json({ error: 'Forbidden' });

    await prisma.promotion.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), status: 'ENDED' },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const boostBodySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
});

const promotionCheckoutSchema = z.object({
  publishDays: z.coerce.number().int().min(1).max(30),
  boostDays: z.coerce.number().int().min(0).max(30).default(0),
});

const confirmPublishSchema = z.object({
  reference: z.string().min(8).max(120),
});

function flattenPaymentMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const nested = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) ? value.metadata : {};
  return { ...nested, ...value };
}

async function paystackVerifyReference(reference) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) return null;
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.status) return null;
  return data.data;
}

/** After Paystack success, ensure a paid publish payment activates the promotion (idempotent). */
router.post('/:promotionId/confirm-publish', authenticateToken, async (req, res, next) => {
  try {
    if (!(await assertPromotionsAccess(req, res))) return;
    const parsed = confirmPublishSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });

    const promotion = await prisma.promotion.findFirst({
      where: { id: req.params.promotionId, deletedAt: null },
      include: { venue: true },
    });
    if (!promotion) return res.status(404).json({ error: 'Promotion not found' });
    if (promotion.venue.ownerUserId !== req.userId && !(await staffHasVenuePermission(req.userId, promotion.venueId, 'promotions'))) return res.status(403).json({ error: 'Forbidden' });

    const payment = await prisma.payment.findUnique({
      where: { reference: parsed.data.reference },
      select: { reference: true, userId: true, email: true, status: true, type: true, metadata: true },
    });
    if (!payment) return res.status(404).json({ error: 'Payment reference not found' });
    if (String(payment.userId) !== String(req.userId)) {
      return res.status(403).json({ error: 'Not authorized for this payment' });
    }

    const metadata = flattenPaymentMetadata(payment.metadata);
    const paidPromoId = resolvePromotionIdFromMetadata(metadata);
    if (!paidPromoId || String(paidPromoId) !== String(promotion.id)) {
      return res.status(400).json({ error: 'Payment does not match this promotion' });
    }
    if (!isPromotionPublishPayment(metadata, payment.type)) {
      return res.status(400).json({ error: 'Payment is not a promotion publish charge' });
    }
    let paymentStatus = payment.status;
    if (paymentStatus !== 'success' && paymentStatus !== 'paid') {
      const verified = await paystackVerifyReference(parsed.data.reference);
      const paystackOk = verified?.status === 'success';
      if (paystackOk) {
        await prisma.payment.update({
          where: { reference: parsed.data.reference },
          data: {
            status: 'success',
            amount: verified.amount ? verified.amount / 100 : undefined,
          },
        });
        paymentStatus = 'success';
      } else {
        return res.status(402).json({ error: 'Payment is not confirmed yet', payment_status: payment.status });
      }
    }

    const activation = await activatePromotionAfterPublishPayment({
      promoId: promotion.id,
      metadata,
      reference: payment.reference,
      payerUserId: payment.userId,
      payerEmail: payment.email,
      sendNotification: false,
    });

    const refreshed = await prisma.promotion.findFirst({
      where: { id: promotion.id, deletedAt: null },
      include: { event: { select: { title: true } } },
    });

    res.json({
      ok: true,
      activated: activation.activated,
      reason: activation.reason || null,
      promotion: refreshed ? formatOwnerPromotion(refreshed) : null,
    });
  } catch (err) {
    next(err);
  }
});

/** Recover a draft that already has a successful publish payment (no new charge). */
router.post('/:promotionId/sync-publish', authenticateToken, async (req, res, next) => {
  try {
    if (!(await assertPromotionsAccess(req, res))) return;

    const promotion = await prisma.promotion.findFirst({
      where: { id: req.params.promotionId, deletedAt: null },
      include: { venue: true },
    });
    if (!promotion) return res.status(404).json({ error: 'Promotion not found' });
    if (promotion.venue.ownerUserId !== req.userId && !(await staffHasVenuePermission(req.userId, promotion.venueId, 'promotions'))) return res.status(403).json({ error: 'Forbidden' });
    if (!['DRAFT', 'ENDED'].includes(promotion.status)) {
      return res.json({
        ok: true,
        activated: false,
        reason: 'already_live',
        promotion: formatOwnerPromotion(promotion),
      });
    }

    const payments = await prisma.payment.findMany({
      where: { userId: req.userId, type: 'promotion', status: { in: ['success', 'pending'] } },
      orderBy: { createdAt: 'desc' },
      take: 80,
      select: { reference: true, metadata: true, type: true, email: true, userId: true, status: true },
    });

    let match = payments.find((row) => {
      if (row.status !== 'success') return false;
      const meta = flattenPaymentMetadata(row.metadata);
      return (
        String(resolvePromotionIdFromMetadata(meta)) === String(promotion.id) &&
        isPromotionPublishPayment(meta, row.type)
      );
    });

    if (!match) {
      const pending = payments.find((row) => {
        if (row.status !== 'pending') return false;
        const meta = flattenPaymentMetadata(row.metadata);
        return (
          String(resolvePromotionIdFromMetadata(meta)) === String(promotion.id) &&
          isPromotionPublishPayment(meta, row.type)
        );
      });
      if (pending) {
        const verified = await paystackVerifyReference(pending.reference);
        if (verified?.status === 'success') {
          await prisma.payment.updateMany({
            where: { reference: pending.reference },
            data: { status: 'success', amount: verified.amount ? verified.amount / 100 : undefined },
          });
          match = pending;
        }
      }
    }

    if (!match) {
      return res.status(404).json({ error: 'No successful publish payment found for this promotion yet' });
    }

    const metadata = flattenPaymentMetadata(match.metadata);
    const activation = await activatePromotionAfterPublishPayment({
      promoId: promotion.id,
      metadata,
      reference: match.reference,
      payerUserId: match.userId,
      payerEmail: match.email,
      sendNotification: false,
    });

    const refreshed = await prisma.promotion.findFirst({
      where: { id: promotion.id, deletedAt: null },
      include: { event: { select: { title: true } } },
    });

    res.json({
      ok: true,
      activated: activation.activated,
      reason: activation.reason || null,
      promotion: refreshed ? formatOwnerPromotion(refreshed) : null,
    });
  } catch (err) {
    next(err);
  }
});

/** Pay for publish days (R50/day) plus optional boost (R150/day). Eligible: DRAFT only. */
router.post('/:promotionId/checkout', authenticateToken, async (req, res, next) => {
  try {
    if (!(await assertPromotionsAccess(req, res))) return;
    const parsed = promotionCheckoutSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
    const { publishDays, boostDays } = parsed.data;

    const promotion = await prisma.promotion.findFirst({
      where: { id: req.params.promotionId, deletedAt: null },
      include: { venue: true },
    });
    if (!promotion) return res.status(404).json({ error: 'Promotion not found' });
    if (promotion.venue.ownerUserId !== req.userId && !(await staffHasVenuePermission(req.userId, promotion.venueId, 'promotions'))) return res.status(403).json({ error: 'Forbidden' });
    if (promotion.status !== 'DRAFT') {
      return res.status(400).json({ error: 'Only draft promotions can be published from checkout. Create a new promotion to run again.' });
    }

    const scheduleStart = promotion.startAt ? new Date(promotion.startAt) : null;
    const scheduleEnd = promotion.endAt ? new Date(promotion.endAt) : null;
    if (scheduleStart && scheduleEnd && scheduleEnd > scheduleStart) {
      const billedDays = Math.max(
        1,
        Math.ceil((scheduleEnd.getTime() - scheduleStart.getTime()) / (24 * 60 * 60 * 1000)),
      );
      if (publishDays < billedDays) {
        return res.status(400).json({
          error: `Run length must be at least ${billedDays} day${billedDays === 1 ? '' : 's'} to cover the promotion schedule`,
        });
      }
      if (boostDays > billedDays) {
        return res.status(400).json({
          error: `Boost length cannot exceed the ${billedDays}-day promotion schedule`,
        });
      }
      if (boostDays > publishDays) {
        return res.status(400).json({
          error: `Boost length cannot exceed the ${publishDays}-day run length`,
        });
      }
    }

    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) return res.status(500).json({ error: 'Paystack is not configured' });

    const owner = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true },
    });
    const reference = `promo_pub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const amountZar = publishDays * PROMOTION_PUBLISH_ZAR_PER_DAY + boostDays * PROMOTION_BOOST_ZAR_PER_DAY;
    const amountInCents = Math.round(amountZar * 100);
    const metadata = {
      sec_kind: 'PROMOTION_PUBLISH',
      promotedPostId: promotion.id,
      promotion_id: promotion.id,
      type: 'PROMOTION_PUBLISH',
      venueId: promotion.venueId,
      publishDays,
      boostDays,
    };

    await prisma.payment.create({
      data: {
        userId: req.userId,
        email: owner?.email || 'user@secnightlife.app',
        amount: amountZar,
        reference,
        status: 'pending',
        type: 'promotion',
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
      return res.status(400).json({ error: json?.message || 'Failed to initialize payment' });
    }

    res.json({
      reference,
      authorization_url: json.data.authorization_url,
      access_code: json.data.access_code,
      amount_zar: amountZar,
      publish_days: publishDays,
      boost_days: boostDays,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:promotionId/boost', authenticateToken, async (req, res, next) => {
  try {
    if (!(await assertPromotionsAccess(req, res))) return;
    const parsed = boostBodySchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
    const boostDays = parsed.data.days;

    const promotion = await prisma.promotion.findFirst({
      where: { id: req.params.promotionId, deletedAt: null },
      include: { venue: true },
    });
    if (!promotion) return res.status(404).json({ error: 'Promotion not found' });
    if (promotion.venue.ownerUserId !== req.userId && !(await staffHasVenuePermission(req.userId, promotion.venueId, 'promotions'))) return res.status(403).json({ error: 'Forbidden' });
    if (!['ACTIVE', 'PAUSED'].includes(promotion.status)) {
      return res.status(400).json({ error: 'Only live or paused promotions can be boosted' });
    }

    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) return res.status(500).json({ error: 'Paystack is not configured' });

    const owner = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true },
    });
    const reference = `boost_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const amountZar = PROMOTION_BOOST_ZAR_PER_DAY * boostDays;
    const amountInCents = Math.round(amountZar * 100);
    const metadata = { sec_kind: 'BOOST', promotedPostId: promotion.id, promotion_id: promotion.id, type: 'BOOST', venueId: promotion.venueId, boostDays };

    await prisma.payment.create({
      data: {
        userId: req.userId,
        email: owner?.email || 'user@secnightlife.app',
        amount: amountZar,
        reference,
        status: 'pending',
        type: 'promotion',
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
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:promotionId/track', optionalAuth, async (req, res, next) => {
  try {
    const parsed = trackSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });

    const promotion = await prisma.promotion.findFirst({ where: { id: req.params.promotionId, deletedAt: null }, select: { id: true } });
    if (!promotion) return res.status(404).json({ error: 'Promotion not found' });

    const isAuthenticated = Boolean(req.userId);
    const identityWhere = isAuthenticated
      ? { userId: req.userId }
      : { sessionId: parsed.data.sessionId };

    const existingInteraction = await prisma.promotionImpression.findFirst({
      where: {
        promotedPostId: promotion.id,
        type: parsed.data.type,
        ...identityWhere,
      },
      select: { id: true },
    });

    if (existingInteraction) return res.status(200).json({ ok: true, deduped: true });

    await prisma.promotionImpression.create({
      data: {
        promotedPostId: promotion.id,
        userId: req.userId || null,
        sessionId: parsed.data.sessionId,
        type: parsed.data.type,
      },
    });

    if (parsed.data.type === 'VIEW') {
      const current = await prisma.promotion.findUnique({
        where: { id: promotion.id },
        select: { boosted: true },
      });
      await prisma.promotion.update({
        where: { id: promotion.id },
        data: current?.boosted ? { boostImpressions: { increment: 1 } } : { organicImpressions: { increment: 1 } },
      });
    } else if (parsed.data.type === 'CLICK') {
      await prisma.promotion.update({ where: { id: promotion.id }, data: { totalClicks: { increment: 1 } } });
      if (req.userId) {
        logFriendActivity({
          userId: req.userId,
          activityType: 'INTERACTED_PROMOTION',
          referenceId: promotion.id,
          referenceType: 'PROMOTION',
          description: 'checked out a promotion',
        });
      }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/feed', optionalAuth, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 20);
    const overrideCity = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    /** When set (e.g. Home "All Cities"), do not filter by city or use profile fallback — show all in-window ACTIVE promos. */
    const scopeAll = req.query.scope === 'all' || req.query.all === '1' || req.query.all === 'true';
    const sessionIdHeader = typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'].trim() : '';
    const sessionIdQuery = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
    const sessionId = sessionIdHeader || sessionIdQuery || 'anon-session';
    const now = new Date();
    const rotationWindowMinutes = PROMOTION_ROTATION_WINDOW_MINUTES;
    const rotationWindowMs = rotationWindowMinutes * 60 * 1000;
    const rotationBucket = Math.floor(now.getTime() / rotationWindowMs);

    const feed = await resolveFeedScope(req);
    let city = '';
    if (scopeAll || feed) {
      city = '';
    } else {
      city = overrideCity;
      if (!city && req.userId) {
        const profile = await prisma.userProfile.findUnique({ where: { userId: req.userId }, select: { city: true } });
        city = profile?.city || '';
      }
    }

    await prisma.promotion.updateMany({
      where: { boosted: true, boostExpiresAt: { lt: now } },
      data: { boosted: false },
    });

    const promotions = await prisma.promotion.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        startAt: { lte: now },
        endAt: { gt: now },
        ...(feed ? eventScopeWhere(feed) : {}),
        ...(city
          ? {
              OR: [
                { targetCity: null },
                { targetCity: { equals: city, mode: 'insensitive' } },
                { venue: { city: { equals: city, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: {
        venue: { select: { id: true, name: true, city: true, venueType: true } },
        event: { select: { id: true, title: true, date: true } },
      },
    });

    const followedVenueIds = req.userId
      ? new Set(
          (
            await prisma.venueFollow.findMany({
              where: { userId: req.userId },
              select: { venueId: true },
            })
          ).map((x) => x.venueId),
        )
      : new Set();

    const scored = promotions
      .map((p) => ({
        ...p,
        score: calculateScore(p) + (followedVenueIds.has(p.venueId) ? 500 : 0),
        cityMatch:
          city &&
          ((p.targetCity && p.targetCity.toLowerCase() === city.toLowerCase()) ||
            (p.venue?.city && p.venue.city.toLowerCase() === city.toLowerCase()))
            ? 1
            : 0,
      }))
      .sort((a, b) => {
        if (a.cityMatch !== b.cityMatch) return b.cityMatch - a.cityMatch;
        if (a.score !== b.score) return b.score - a.score;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

    const mixedBase = interleavePromotions(scored.filter((p) => p.boosted), scored.filter((p) => !p.boosted));
    const mixed = weightedWindowOrder(mixedBase, `${sessionId}|${city || 'all'}|${rotationBucket}`);
    const offset = (page - 1) * limit;
    const results = mixed.slice(offset, offset + limit);

    res.json({
      page,
      limit,
      rotationWindowMinutes,
      total: mixed.length,
      results: results.map((p) => ({
        id: p.id,
        promotionType: p.type,
        title: p.title,
        body: p.description,
        imageUrl: p.imageUrl,
        targetCity: p.targetCity,
        boosted: p.boosted,
        startsAt: p.startAt,
        endsAt: p.endAt,
        venueId: p.venue.id,
        venueName: p.venue.name,
        venueCity: p.venue.city,
        venueType: p.venue.venueType,
        eventId: p.event?.id || null,
        eventName: p.event?.title || null,
        eventDate: p.event?.date || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export { fetchVenuePromotionsList };
export default router;

