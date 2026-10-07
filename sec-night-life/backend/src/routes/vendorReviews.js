/**
 * Vendor reviews — people and venues rate vendor listings (mounted at /api/reviews/vendors).
 * Mirrors user reviews: one review per reviewer (or per venue), 10–300 char comment,
 * listing owner can flag, admins dismiss/remove, shared 5/hour limit.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { createInAppNotification, createInAppNotificationsForUsers } from '../lib/inAppNotifications.js';
import { notifyAdmins } from '../lib/adminNotify.js';
import { isReviewRateLimited } from '../lib/reviewRateLimit.js';
import { completedHireIndex, findPublicVendor, vendorReviewStats } from '../lib/vendorReviews.js';

const router = Router();

const ratingComment = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(10).max(300),
});

const RATE_LIMIT_ERROR = 'You are posting reviews too quickly. Please wait before submitting another.';

function mapUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    avatarUrl: u.userProfile?.avatarUrl ?? null,
  };
}

const userSelect = {
  select: { id: true, username: true, fullName: true, userProfile: { select: { avatarUrl: true } } },
};

function vendorRoute(vendorId) {
  return `/VendorDetail?id=${vendorId}`;
}

async function getAdminRecipientIds() {
  const rows = await prisma.user.findMany({
    where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] }, deletedAt: null, suspendedAt: null },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

async function notifyVendorOwner(vendor, body) {
  await createInAppNotification({
    userId: vendor.userId,
    type: 'VENDOR_REVIEW_RECEIVED',
    title: 'New review on your vendor listing',
    body,
    referenceId: vendorRoute(vendor.id),
    referenceType: 'ROUTE',
  });
}

async function alertAdminsOfFlag({ reviewId, vendorName, actorUserId }) {
  const admins = await getAdminRecipientIds();
  await createInAppNotificationsForUsers(admins, {
    type: 'ADMIN_FLAGGED_USER_REVIEW',
    title: 'Vendor review flagged',
    body: `${vendorName} flagged a review on their listing`,
    referenceId: reviewId,
    referenceType: 'FLAGGED_VENDOR_REVIEW',
  });
  const actor = await prisma.user.findUnique({ where: { id: actorUserId }, select: { email: true } });
  notifyAdmins({
    subject: 'Vendor review flagged for admin review',
    body: `${vendorName} flagged a review on their vendor listing.`,
    dashboardTab: 'flagged-reviews',
    ctaLabel: 'Review flagged reviews',
    excludeEmail: actor?.email,
  }).catch(() => {});
}

// --- Public list (person + venue reviews merged) ---
router.get('/:vendorId', optionalAuth, async (req, res, next) => {
  try {
    const { vendorId } = req.params;
    const vendor = await prisma.vendorBusiness.findFirst({
      where: { id: vendorId, deletedAt: null },
      select: { id: true, userId: true, isPublished: true },
    });
    if (!vendor || (!vendor.isPublished && vendor.userId !== req.userId)) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = 10;
    const skip = (page - 1) * limit;
    const where = { vendorBusinessId: vendorId, flagged: false };

    const [stats, personRows, venueRows, hires] = await Promise.all([
      vendorReviewStats(vendorId),
      prisma.vendorReview.findMany({ where, include: { reviewer: userSelect } }),
      prisma.venueVendorReview.findMany({ where, include: { venue: { select: { id: true, name: true, logoUrl: true } } } }),
      completedHireIndex(vendorId),
    ]);

    const merged = [
      ...personRows.map((r) => ({
        id: r.id,
        reviewSource: 'user',
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
        reviewer: mapUser(r.reviewer),
        venue: null,
        verifiedHire: Boolean(r.inquiryId || hires.byUser.has(r.reviewerId)),
      })),
      ...venueRows.map((r) => ({
        id: r.id,
        reviewSource: 'venue',
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
        reviewer: null,
        venue: r.venue ? { id: r.venue.id, name: r.venue.name, logoUrl: r.venue.logoUrl ?? null } : null,
        verifiedHire: Boolean(r.inquiryId || hires.byVenue.has(r.venueId)),
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      averageRating: stats.averageRating,
      totalReviews: stats.totalReviews,
      reviews: merged.slice(skip, skip + limit),
      page,
      totalPages: Math.ceil(merged.length / limit) || 1,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/:vendorId/eligibility', authenticateToken, async (req, res, next) => {
  try {
    const { vendorId } = req.params;
    const vendor = await findPublicVendor(vendorId);
    if (!vendor) return res.json({ eligible: false, reason: 'not_found', existingReview: null });
    if (vendor.userId === req.userId) {
      return res.json({ eligible: false, reason: 'own_listing', existingReview: null });
    }
    const existing = await prisma.vendorReview.findUnique({
      where: { reviewerId_vendorBusinessId: { reviewerId: req.userId, vendorBusinessId: vendorId } },
    });
    res.json({
      eligible: true,
      reason: null,
      existingReview: existing
        ? { id: existing.id, rating: existing.rating, comment: existing.comment }
        : null,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/:vendorId/venue-eligibility', authenticateToken, async (req, res, next) => {
  try {
    const { vendorId } = req.params;
    const vendor = await findPublicVendor(vendorId);
    if (!vendor || vendor.userId === req.userId) return res.json({ venues: [] });

    const ownedVenues = await prisma.venue.findMany({
      where: { ownerUserId: req.userId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (!ownedVenues.length) return res.json({ venues: [] });

    const [existing, hires] = await Promise.all([
      prisma.venueVendorReview.findMany({
        where: { vendorBusinessId: vendorId, venueId: { in: ownedVenues.map((v) => v.id) } },
        select: { id: true, venueId: true, rating: true, comment: true },
      }),
      completedHireIndex(vendorId),
    ]);
    const byVenue = new Map(existing.map((r) => [r.venueId, r]));

    res.json({
      venues: ownedVenues.map((v) => {
        const r = byVenue.get(v.id);
        return {
          id: v.id,
          name: v.name,
          verifiedHire: hires.byVenue.has(v.id),
          existingReview: r ? { id: r.id, rating: r.rating, comment: r.comment } : null,
        };
      }),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:vendorId', authenticateToken, async (req, res, next) => {
  try {
    const { vendorId } = req.params;
    const parsed = ratingComment.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const vendor = await findPublicVendor(vendorId);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    if (vendor.userId === req.userId) {
      return res.status(403).json({ error: 'You cannot review your own vendor listing.' });
    }
    if (await isReviewRateLimited(req.userId)) {
      return res.status(429).json({ error: RATE_LIMIT_ERROR });
    }

    const hires = await completedHireIndex(vendorId);
    try {
      const review = await prisma.vendorReview.create({
        data: {
          vendorBusinessId: vendorId,
          reviewerId: req.userId,
          inquiryId: hires.byUser.get(req.userId) ?? null,
          rating: parsed.data.rating,
          comment: parsed.data.comment,
        },
        include: { reviewer: { select: { username: true } } },
      });
      await notifyVendorOwner(
        vendor,
        `@${review.reviewer?.username || 'someone'} left ${vendor.name} a ${review.rating}-star review`
      );
      res.status(201).json({
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt.toISOString(),
      });
    } catch (err) {
      if (err?.code === 'P2002') {
        return res.status(409).json({
          error: 'You have already reviewed this vendor. Edit your existing review instead.',
        });
      }
      throw err;
    }
  } catch (e) {
    next(e);
  }
});

router.post('/:vendorId/as-venue', authenticateToken, async (req, res, next) => {
  try {
    const { vendorId } = req.params;
    const parsed = ratingComment.extend({ venueId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const { rating, comment, venueId } = parsed.data;

    const vendor = await findPublicVendor(vendorId);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    if (vendor.userId === req.userId) {
      return res.status(403).json({ error: 'You cannot review your own vendor listing.' });
    }
    const venue = await prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { id: true, name: true, ownerUserId: true },
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });
    if (venue.ownerUserId !== req.userId) {
      return res.status(403).json({ error: 'Only the venue owner can review on behalf of this venue.' });
    }
    if (await isReviewRateLimited(req.userId)) {
      return res.status(429).json({ error: RATE_LIMIT_ERROR });
    }

    const hires = await completedHireIndex(vendorId);
    try {
      const review = await prisma.venueVendorReview.create({
        data: {
          vendorBusinessId: vendorId,
          venueId,
          authorUserId: req.userId,
          inquiryId: hires.byVenue.get(venueId) ?? null,
          rating,
          comment,
        },
      });
      await notifyVendorOwner(vendor, `${venue.name} left ${vendor.name} a ${rating}-star review`);
      res.status(201).json({
        id: review.id,
        venueId: review.venueId,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt.toISOString(),
      });
    } catch (err) {
      if (err?.code === 'P2002') {
        return res.status(409).json({
          error: 'This venue has already reviewed this vendor. Edit the existing review instead.',
        });
      }
      throw err;
    }
  } catch (e) {
    next(e);
  }
});

// --- Person review: edit / delete / flag ---
router.patch('/review/:reviewId', authenticateToken, async (req, res, next) => {
  try {
    const parsed = ratingComment.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const existing = await prisma.vendorReview.findUnique({ where: { id: req.params.reviewId } });
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (existing.reviewerId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const updated = await prisma.vendorReview.update({
      where: { id: existing.id },
      data: { rating: parsed.data.rating, comment: parsed.data.comment },
    });
    res.json({
      id: updated.id,
      rating: updated.rating,
      comment: updated.comment,
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/review/:reviewId', authenticateToken, async (req, res, next) => {
  try {
    const existing = await prisma.vendorReview.findUnique({ where: { id: req.params.reviewId } });
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (existing.reviewerId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    await prisma.vendorReview.delete({ where: { id: existing.id } });
    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

const flagSchema = z.object({ reason: z.string().trim().min(1).max(200) });

router.post('/review/:reviewId/flag', authenticateToken, async (req, res, next) => {
  try {
    const parsed = flagSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid reason' });
    const review = await prisma.vendorReview.findUnique({
      where: { id: req.params.reviewId },
      include: { vendorBusiness: { select: { name: true, userId: true } } },
    });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.vendorBusiness.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (review.flagged) return res.status(409).json({ error: 'Already flagged' });
    await prisma.vendorReview.update({
      where: { id: review.id },
      data: { flagged: true, flagReason: parsed.data.reason, flaggedAt: new Date() },
    });
    await alertAdminsOfFlag({
      reviewId: review.id,
      vendorName: review.vendorBusiness.name,
      actorUserId: req.userId,
    });
    res.json({ flagged: true });
  } catch (e) {
    next(e);
  }
});

// --- Venue review: edit / delete / flag ---
router.patch('/venue-review/:reviewId', authenticateToken, async (req, res, next) => {
  try {
    const parsed = ratingComment.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const existing = await prisma.venueVendorReview.findUnique({
      where: { id: req.params.reviewId },
      include: { venue: { select: { ownerUserId: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (existing.venue.ownerUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const updated = await prisma.venueVendorReview.update({
      where: { id: existing.id },
      data: { rating: parsed.data.rating, comment: parsed.data.comment },
    });
    res.json({
      id: updated.id,
      rating: updated.rating,
      comment: updated.comment,
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/venue-review/:reviewId', authenticateToken, async (req, res, next) => {
  try {
    const existing = await prisma.venueVendorReview.findUnique({
      where: { id: req.params.reviewId },
      include: { venue: { select: { ownerUserId: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (existing.venue.ownerUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    await prisma.venueVendorReview.delete({ where: { id: existing.id } });
    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

router.post('/venue-review/:reviewId/flag', authenticateToken, async (req, res, next) => {
  try {
    const parsed = flagSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid reason' });
    const review = await prisma.venueVendorReview.findUnique({
      where: { id: req.params.reviewId },
      include: { vendorBusiness: { select: { name: true, userId: true } } },
    });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.vendorBusiness.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (review.flagged) return res.status(409).json({ error: 'Already flagged' });
    await prisma.venueVendorReview.update({
      where: { id: review.id },
      data: { flagged: true, flagReason: parsed.data.reason, flaggedAt: new Date() },
    });
    await alertAdminsOfFlag({
      reviewId: review.id,
      vendorName: review.vendorBusiness.name,
      actorUserId: req.userId,
    });
    res.json({ flagged: true });
  } catch (e) {
    next(e);
  }
});

export default router;
