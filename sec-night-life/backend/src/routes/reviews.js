/**
 * Reviews & ratings — user-to-user and venue reviews (in-app only).
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { requireRole, requireAdmin } from '../middleware/rbac.js';
import { checkUserReviewEligibility } from '../lib/reviewEligibility.js';
import { createInAppNotification, createInAppNotificationsForUsers } from '../lib/inAppNotifications.js';
import { notifyAdmins } from '../lib/adminNotify.js';
import { countReviewsCreatedLastHour } from '../lib/reviewRateLimit.js';
import vendorReviewRoutes from './vendorReviews.js';

const router = Router();

router.use('/vendors', vendorReviewRoutes);

const ratingComment = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(10).max(300),
});

function round1(avg) {
  if (avg == null || Number.isNaN(Number(avg))) return 0;
  return Math.round(Number(avg) * 10) / 10;
}

function mapReviewerUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    avatarUrl: u.userProfile?.avatarUrl ?? null,
  };
}

function mapUserReviewRow(r) {
  return {
    id: r.id,
    reviewSource: 'user',
    rating: r.rating,
    comment: r.comment,
    createdAt: r.createdAt.toISOString(),
    eventId: r.eventId,
    reviewer: mapReviewerUser(r.reviewer),
    event: r.event
      ? { id: r.event.id, name: r.event.title, date: r.event.date.toISOString() }
      : null,
    venue: null,
  };
}

function mapVenueUserReviewRow(r) {
  return {
    id: r.id,
    reviewSource: 'venue',
    rating: r.rating,
    comment: r.comment,
    createdAt: r.createdAt.toISOString(),
    eventId: null,
    reviewer: null,
    event: null,
    venue: r.venue ? { id: r.venue.id, name: r.venue.name } : null,
  };
}

async function profileReviewStats(subjectUserId) {
  const [userRows, venueRows] = await Promise.all([
    prisma.userReview.findMany({ where: { subjectUserId, flagged: false }, select: { rating: true } }),
    prisma.venueUserReview.findMany({ where: { subjectUserId, flagged: false }, select: { rating: true } }),
  ]);
  const all = [...userRows, ...venueRows];
  const total = all.length;
  if (total === 0) return { averageRating: 0, totalReviews: 0 };
  const sum = all.reduce((s, r) => s + r.rating, 0);
  return { averageRating: round1(sum / total), totalReviews: total };
}

async function fetchMergedProfileReviews(subjectUserId, skip, limit) {
  const [userReviews, venueReviews] = await Promise.all([
    prisma.userReview.findMany({
      where: { subjectUserId, flagged: false },
      include: {
        reviewer: {
          select: { id: true, username: true, fullName: true, userProfile: { select: { avatarUrl: true } } },
        },
        event: { select: { id: true, title: true, date: true } },
      },
    }),
    prisma.venueUserReview.findMany({
      where: { subjectUserId, flagged: false },
      include: { venue: { select: { id: true, name: true } } },
    }),
  ]);
  const merged = [
    ...userReviews.map(mapUserReviewRow),
    ...venueReviews.map(mapVenueUserReviewRow),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { reviews: merged.slice(skip, skip + limit), total: merged.length };
}

async function getSuperAdminUserIds() {
  const rows = await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN', deletedAt: null, suspendedAt: null },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// --- Authenticated: reviews I've written (user + venue-as-user) ---
router.get('/me/given', authenticateToken, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = 10;
    const skip = (page - 1) * limit;

    const vendorSelect = { select: { id: true, name: true, category: true } };
    const [userRows, venueUserRows, vendorRows, venueVendorRows] = await Promise.all([
      prisma.userReview.findMany({
        where: { reviewerId: req.userId, flagged: false },
        include: {
          subject: {
            select: {
              id: true,
              username: true,
              fullName: true,
              userProfile: { select: { avatarUrl: true } },
            },
          },
          event: { select: { id: true, title: true, date: true } },
        },
      }),
      prisma.venueUserReview.findMany({
        where: { authorUserId: req.userId, flagged: false },
        include: {
          subject: {
            select: {
              id: true,
              username: true,
              fullName: true,
              userProfile: { select: { avatarUrl: true } },
            },
          },
          venue: { select: { id: true, name: true } },
        },
      }),
      prisma.vendorReview.findMany({
        where: { reviewerId: req.userId, flagged: false },
        include: { vendorBusiness: vendorSelect },
      }),
      prisma.venueVendorReview.findMany({
        where: { authorUserId: req.userId, flagged: false },
        include: { vendorBusiness: vendorSelect, venue: { select: { id: true, name: true } } },
      }),
    ]);

    const mapVendor = (v) => (v ? { id: v.id, name: v.name, category: v.category } : null);

    const merged = [
      ...userRows.map((r) => ({
        id: r.id,
        reviewSource: 'user',
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
        eventId: r.eventId,
        event: r.event
          ? { id: r.event.id, name: r.event.title, date: r.event.date.toISOString() }
          : null,
        subject: mapReviewerUser(r.subject),
        venue: null,
      })),
      ...venueUserRows.map((r) => ({
        id: r.id,
        reviewSource: 'venue',
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
        eventId: null,
        event: null,
        subject: mapReviewerUser(r.subject),
        venue: r.venue ? { id: r.venue.id, name: r.venue.name } : null,
      })),
      ...vendorRows.map((r) => ({
        id: r.id,
        reviewSource: 'vendor',
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
        eventId: null,
        event: null,
        subject: null,
        vendor: mapVendor(r.vendorBusiness),
        venue: null,
      })),
      ...venueVendorRows.map((r) => ({
        id: r.id,
        reviewSource: 'venue_vendor',
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
        eventId: null,
        event: null,
        subject: null,
        vendor: mapVendor(r.vendorBusiness),
        venue: r.venue ? { id: r.venue.id, name: r.venue.name } : null,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = merged.length;
    const reviews = merged.slice(skip, skip + limit);

    res.json({
      reviews,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      total,
    });
  } catch (e) {
    next(e);
  }
});

// --- Admin (must be before /users/:userId) ---
router.get('/admin/flagged', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const [userReviews, venueReviews, venueUserReviews, vendorReviews, venueVendorReviews] = await Promise.all([
      prisma.userReview.findMany({
        where: { flagged: true },
        orderBy: { flaggedAt: 'desc' },
        include: {
          reviewer: {
            select: { id: true, username: true, fullName: true, userProfile: { select: { avatarUrl: true } } },
          },
          subject: {
            select: { id: true, username: true, fullName: true, userProfile: { select: { avatarUrl: true } } },
          },
          event: { select: { id: true, title: true, date: true } },
        },
      }),
      prisma.venueReview.findMany({
        where: { flagged: true },
        orderBy: { flaggedAt: 'desc' },
        include: {
          reviewer: {
            select: { id: true, username: true, fullName: true, userProfile: { select: { avatarUrl: true } } },
          },
          venue: { select: { id: true, name: true, ownerUserId: true } },
        },
      }),
      prisma.venueUserReview.findMany({
        where: { flagged: true },
        orderBy: { flaggedAt: 'desc' },
        include: {
          subject: {
            select: { id: true, username: true, fullName: true, userProfile: { select: { avatarUrl: true } } },
          },
          venue: { select: { id: true, name: true, ownerUserId: true } },
          author: {
            select: { id: true, username: true, fullName: true, userProfile: { select: { avatarUrl: true } } },
          },
        },
      }),
      prisma.vendorReview.findMany({
        where: { flagged: true },
        orderBy: { flaggedAt: 'desc' },
        include: {
          reviewer: {
            select: { id: true, username: true, fullName: true, userProfile: { select: { avatarUrl: true } } },
          },
          vendorBusiness: { select: { id: true, name: true, userId: true } },
        },
      }),
      prisma.venueVendorReview.findMany({
        where: { flagged: true },
        orderBy: { flaggedAt: 'desc' },
        include: {
          venue: { select: { id: true, name: true, ownerUserId: true } },
          vendorBusiness: { select: { id: true, name: true, userId: true } },
        },
      }),
    ]);

    const mapFlaggedVendor = (v) => (v ? { id: v.id, name: v.name, ownerUserId: v.userId } : null);

    res.json({
      userReviews: userReviews.map((r) => ({
        id: r.id,
        type: 'user',
        rating: r.rating,
        comment: r.comment,
        flagReason: r.flagReason,
        flaggedAt: r.flaggedAt?.toISOString() ?? null,
        reviewer: mapReviewerUser(r.reviewer),
        subject: mapReviewerUser(r.subject),
        event: r.event
          ? { id: r.event.id, name: r.event.title, date: r.event.date.toISOString() }
          : null,
      })),
      venueReviews: venueReviews.map((r) => ({
        id: r.id,
        type: 'venue',
        rating: r.rating,
        comment: r.comment,
        flagReason: r.flagReason,
        flaggedAt: r.flaggedAt?.toISOString() ?? null,
        reviewer: mapReviewerUser(r.reviewer),
        venue: r.venue ? { id: r.venue.id, name: r.venue.name, ownerUserId: r.venue.ownerUserId } : null,
      })),
      venueUserReviews: venueUserReviews.map((r) => ({
        id: r.id,
        type: 'venue_user',
        rating: r.rating,
        comment: r.comment,
        flagReason: r.flagReason,
        flaggedAt: r.flaggedAt?.toISOString() ?? null,
        reviewer: mapReviewerUser(r.author),
        subject: mapReviewerUser(r.subject),
        venue: r.venue ? { id: r.venue.id, name: r.venue.name, ownerUserId: r.venue.ownerUserId } : null,
      })),
      vendorReviews: vendorReviews.map((r) => ({
        id: r.id,
        type: 'vendor',
        rating: r.rating,
        comment: r.comment,
        flagReason: r.flagReason,
        flaggedAt: r.flaggedAt?.toISOString() ?? null,
        reviewer: mapReviewerUser(r.reviewer),
        vendor: mapFlaggedVendor(r.vendorBusiness),
      })),
      venueVendorReviews: venueVendorReviews.map((r) => ({
        id: r.id,
        type: 'venue_vendor',
        rating: r.rating,
        comment: r.comment,
        flagReason: r.flagReason,
        flaggedAt: r.flaggedAt?.toISOString() ?? null,
        venue: r.venue ? { id: r.venue.id, name: r.venue.name, ownerUserId: r.venue.ownerUserId } : null,
        vendor: mapFlaggedVendor(r.vendorBusiness),
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.patch(
  '/admin/:reviewType/:reviewId/dismiss',
  authenticateToken,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req, res, next) => {
    try {
      const { reviewType, reviewId } = req.params;
      if (reviewType === 'user') {
        const u = await prisma.userReview.updateMany({
          where: { id: reviewId },
          data: { flagged: false, flagReason: null, flaggedAt: null },
        });
        if (u.count === 0) return res.status(404).json({ error: 'Review not found' });
        return res.json({ ok: true });
      }
      if (reviewType === 'venue') {
        const u = await prisma.venueReview.updateMany({
          where: { id: reviewId },
          data: { flagged: false, flagReason: null, flaggedAt: null },
        });
        if (u.count === 0) return res.status(404).json({ error: 'Review not found' });
        return res.json({ ok: true });
      }
      if (reviewType === 'venue_user') {
        const u = await prisma.venueUserReview.updateMany({
          where: { id: reviewId },
          data: { flagged: false, flagReason: null, flaggedAt: null },
        });
        if (u.count === 0) return res.status(404).json({ error: 'Review not found' });
        return res.json({ ok: true });
      }
      if (reviewType === 'vendor') {
        const u = await prisma.vendorReview.updateMany({
          where: { id: reviewId },
          data: { flagged: false, flagReason: null, flaggedAt: null },
        });
        if (u.count === 0) return res.status(404).json({ error: 'Review not found' });
        return res.json({ ok: true });
      }
      if (reviewType === 'venue_vendor') {
        const u = await prisma.venueVendorReview.updateMany({
          where: { id: reviewId },
          data: { flagged: false, flagReason: null, flaggedAt: null },
        });
        if (u.count === 0) return res.status(404).json({ error: 'Review not found' });
        return res.json({ ok: true });
      }
      return res.status(400).json({ error: 'Invalid review type' });
    } catch (e) {
      next(e);
    }
  }
);

router.delete(
  '/admin/:reviewType/:reviewId/remove',
  authenticateToken,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req, res, next) => {
    try {
      const { reviewType, reviewId } = req.params;

      if (reviewType === 'user') {
        const row = await prisma.userReview.findUnique({
          where: { id: reviewId },
          include: { subject: { select: { id: true } } },
        });
        if (!row) return res.status(404).json({ error: 'Review not found' });
        await prisma.userReview.delete({ where: { id: reviewId } });
        await createInAppNotification({
          userId: row.subjectUserId,
          type: 'REVIEW_REMOVED_BY_ADMIN',
          title: 'A flagged review has been removed',
          body: 'After review, we removed a flagged review from your profile.',
          referenceId: reviewId,
          referenceType: 'USER_REVIEW_REMOVED',
        });
        return res.json({ ok: true });
      }

      if (reviewType === 'venue') {
        const row = await prisma.venueReview.findUnique({
          where: { id: reviewId },
          include: { venue: { select: { ownerUserId: true } } },
        });
        if (!row) return res.status(404).json({ error: 'Review not found' });
        await prisma.venueReview.delete({ where: { id: reviewId } });
        await createInAppNotification({
          userId: row.venue.ownerUserId,
          type: 'REVIEW_REMOVED_BY_ADMIN',
          title: 'A flagged review has been removed',
          body: 'After review, we removed a flagged review from your profile.',
          referenceId: reviewId,
          referenceType: 'VENUE_REVIEW_REMOVED',
        });
        return res.json({ ok: true });
      }

      if (reviewType === 'venue_user') {
        const row = await prisma.venueUserReview.findUnique({
          where: { id: reviewId },
          include: { subject: { select: { id: true } } },
        });
        if (!row) return res.status(404).json({ error: 'Review not found' });
        await prisma.venueUserReview.delete({ where: { id: reviewId } });
        await createInAppNotification({
          userId: row.subjectUserId,
          type: 'REVIEW_REMOVED_BY_ADMIN',
          title: 'A flagged review has been removed',
          body: 'After review, we removed a flagged review from your profile.',
          referenceId: reviewId,
          referenceType: 'VENUE_USER_REVIEW_REMOVED',
        });
        return res.json({ ok: true });
      }

      if (reviewType === 'vendor' || reviewType === 'venue_vendor') {
        const model = reviewType === 'vendor' ? prisma.vendorReview : prisma.venueVendorReview;
        const row = await model.findUnique({
          where: { id: reviewId },
          include: { vendorBusiness: { select: { id: true, userId: true } } },
        });
        if (!row) return res.status(404).json({ error: 'Review not found' });
        await model.delete({ where: { id: reviewId } });
        await createInAppNotification({
          userId: row.vendorBusiness.userId,
          type: 'REVIEW_REMOVED_BY_ADMIN',
          title: 'A flagged review has been removed',
          body: 'After review, we removed a flagged review from your vendor listing.',
          referenceId: `/VendorDetail?id=${row.vendorBusiness.id}`,
          referenceType: 'ROUTE',
        });
        return res.json({ ok: true });
      }

      return res.status(400).json({ error: 'Invalid review type' });
    } catch (e) {
      next(e);
    }
  }
);

// --- User reviews: venue eligibility (before /users/:userId) ---
router.get('/users/:userId/venue-eligibility', authenticateToken, async (req, res, next) => {
  try {
    const { userId: subjectUserId } = req.params;
    if (subjectUserId === req.userId) {
      return res.json({ venues: [] });
    }

    const ownedVenues = await prisma.venue.findMany({
      where: { ownerUserId: req.userId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    if (ownedVenues.length === 0) {
      return res.json({ venues: [] });
    }

    const existing = await prisma.venueUserReview.findMany({
      where: {
        authorUserId: req.userId,
        subjectUserId,
        venueId: { in: ownedVenues.map((v) => v.id) },
      },
      select: { id: true, venueId: true, rating: true, comment: true },
    });
    const byVenue = new Map(existing.map((r) => [r.venueId, r]));

    res.json({
      venues: ownedVenues.map((v) => ({
        id: v.id,
        name: v.name,
        existingReview: byVenue.has(v.id)
          ? {
              id: byVenue.get(v.id).id,
              rating: byVenue.get(v.id).rating,
              comment: byVenue.get(v.id).comment,
            }
          : null,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// --- User reviews: public list (user + venue-attributed) ---
router.get('/users/:userId', optionalAuth, async (req, res, next) => {
  try {
    const { userId } = req.params;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = 10;
    const skip = (page - 1) * limit;

    const [stats, { reviews, total }] = await Promise.all([
      profileReviewStats(userId),
      fetchMergedProfileReviews(userId, skip, limit),
    ]);

    res.json({
      averageRating: stats.averageRating,
      totalReviews: stats.totalReviews,
      reviews,
      page,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/users/:userId/eligibility', authenticateToken, async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (userId === req.userId) {
      return res.json({ eligible: false, existingReview: null });
    }

    const { eligible } = await checkUserReviewEligibility(req.userId, userId);

    const existing = await prisma.userReview.findUnique({
      where: {
        reviewerId_subjectUserId: { reviewerId: req.userId, subjectUserId: userId },
      },
      include: { event: { select: { id: true, title: true, date: true } } },
    });

    res.json({
      eligible,
      existingReview: existing
        ? {
            id: existing.id,
            rating: existing.rating,
            comment: existing.comment,
            eventId: existing.eventId,
            event: existing.event
              ? {
                  id: existing.event.id,
                  name: existing.event.title,
                  date: existing.event.date.toISOString(),
                }
              : null,
          }
        : null,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/users/:userId/as-venue', authenticateToken, async (req, res, next) => {
  try {
    const { userId: subjectUserId } = req.params;
    if (subjectUserId === req.userId) {
      return res.status(400).json({ error: 'You cannot review yourself.' });
    }

    const schema = ratingComment.extend({ venueId: z.string().uuid() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const { rating, comment, venueId } = parsed.data;

    const venue = await prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { id: true, name: true, ownerUserId: true },
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });
    if (venue.ownerUserId !== req.userId) {
      return res.status(403).json({ error: 'Only the venue owner can review on behalf of this venue.' });
    }

    const createdLastHour = await countReviewsCreatedLastHour(req.userId);
    if (createdLastHour >= 5) {
      return res.status(429).json({
        error: 'You are posting reviews too quickly. Please wait before submitting another.',
      });
    }

    try {
      const review = await prisma.venueUserReview.create({
        data: {
          venueId,
          subjectUserId,
          authorUserId: req.userId,
          rating,
          comment,
        },
        include: { venue: { select: { name: true } } },
      });

      await createInAppNotification({
        userId: subjectUserId,
        type: 'USER_REVIEW_RECEIVED',
        title: 'New review on your profile',
        body: `${review.venue?.name || 'A venue'} left you a ${rating}-star review`,
        referenceId: review.id,
        referenceType: 'VENUE_USER_REVIEW',
      });

      res.status(201).json({
        id: review.id,
        venueId: review.venueId,
        subjectUserId: review.subjectUserId,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt.toISOString(),
      });
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'P2002') {
        return res.status(409).json({
          error: 'This venue has already reviewed this person. Edit the existing review instead.',
        });
      }
      throw err;
    }
  } catch (e) {
    next(e);
  }
});

router.post('/users/:userId', authenticateToken, async (req, res, next) => {
  try {
    const { userId: subjectUserId } = req.params;
    if (subjectUserId === req.userId) {
      return res.status(400).json({ error: 'You cannot review yourself.' });
    }

    const parsed = ratingComment.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const { rating, comment } = parsed.data;

    const { eligible } = await checkUserReviewEligibility(req.userId, subjectUserId);
    if (!eligible) {
      return res.status(403).json({ error: 'You cannot review yourself.' });
    }

    const createdLastHour = await countReviewsCreatedLastHour(req.userId);
    if (createdLastHour >= 5) {
      return res.status(429).json({
        error: 'You are posting reviews too quickly. Please wait before submitting another.',
      });
    }

    try {
      const review = await prisma.userReview.create({
        data: {
          reviewerId: req.userId,
          subjectUserId,
          rating,
          comment,
        },
        include: {
          reviewer: { select: { username: true } },
        },
      });

      const reviewerUsername = review.reviewer?.username || 'Someone';
      await createInAppNotification({
        userId: subjectUserId,
        type: 'USER_REVIEW_RECEIVED',
        title: 'New review on your profile',
        body: `@${reviewerUsername} left you a ${rating}-star review`,
        referenceId: review.id,
        referenceType: 'USER_REVIEW',
      });

      res.status(201).json({
        id: review.id,
        reviewerId: review.reviewerId,
        subjectUserId: review.subjectUserId,
        eventId: review.eventId,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt.toISOString(),
      });
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'P2002') {
        return res.status(409).json({
          error: 'You have already reviewed this person. Edit your existing review instead.',
        });
      }
      throw err;
    }
  } catch (e) {
    next(e);
  }
});

router.patch('/users/review/:reviewId', authenticateToken, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const parsed = ratingComment.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }

    const existing = await prisma.userReview.findUnique({ where: { id: reviewId } });
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (existing.reviewerId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.userReview.update({
      where: { id: reviewId },
      data: { rating: parsed.data.rating, comment: parsed.data.comment },
    });

    res.json({
      id: updated.id,
      rating: updated.rating,
      comment: updated.comment,
      eventId: updated.eventId,
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/users/review/:reviewId', authenticateToken, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const existing = await prisma.userReview.findUnique({ where: { id: reviewId } });
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (existing.reviewerId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await prisma.userReview.delete({ where: { id: reviewId } });
    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

router.post('/users/review/:reviewId/flag', authenticateToken, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const parsed = z.object({ reason: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid reason' });

    const review = await prisma.userReview.findUnique({
      where: { id: reviewId },
      include: {
        reviewer: { select: { username: true } },
        subject: { select: { username: true } },
      },
    });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.subjectUserId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (review.flagged) {
      return res.status(409).json({ error: 'Already flagged' });
    }

    await prisma.userReview.update({
      where: { id: reviewId },
      data: {
        flagged: true,
        flagReason: parsed.data.reason,
        flaggedAt: new Date(),
      },
    });

    const admins = await getSuperAdminUserIds();
    const subj = review.subject?.username || 'user';
    const rev = review.reviewer?.username || 'user';
    await createInAppNotificationsForUsers(admins, {
      type: 'ADMIN_FLAGGED_USER_REVIEW',
      title: 'Review flagged for admin review',
      body: `@${subj} flagged a review by @${rev}`,
      referenceId: reviewId,
      referenceType: 'FLAGGED_REVIEW',
    });

    const actor = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true },
    });
    notifyAdmins({
      subject: 'Review flagged for admin review',
      body: `@${subj} flagged a review by @${rev}.`,
      dashboardTab: 'flagged-reviews',
      ctaLabel: 'Review flagged reviews',
      excludeEmail: actor?.email,
    }).catch(() => {});

    res.json({ flagged: true });
  } catch (e) {
    next(e);
  }
});

// --- Venue-attributed user reviews (CRUD + flag) ---
router.patch('/venues/users/review/:reviewId', authenticateToken, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const parsed = ratingComment.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }

    const existing = await prisma.venueUserReview.findUnique({
      where: { id: reviewId },
      include: { venue: { select: { ownerUserId: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (existing.authorUserId !== req.userId && existing.venue.ownerUserId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.venueUserReview.update({
      where: { id: reviewId },
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

router.delete('/venues/users/review/:reviewId', authenticateToken, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const existing = await prisma.venueUserReview.findUnique({
      where: { id: reviewId },
      include: { venue: { select: { ownerUserId: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (existing.authorUserId !== req.userId && existing.venue.ownerUserId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await prisma.venueUserReview.delete({ where: { id: reviewId } });
    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

router.post('/venues/users/review/:reviewId/flag', authenticateToken, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const parsed = z.object({ reason: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid reason' });

    const review = await prisma.venueUserReview.findUnique({
      where: { id: reviewId },
      include: {
        subject: { select: { username: true } },
        venue: { select: { name: true } },
      },
    });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.subjectUserId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (review.flagged) {
      return res.status(409).json({ error: 'Already flagged' });
    }

    await prisma.venueUserReview.update({
      where: { id: reviewId },
      data: {
        flagged: true,
        flagReason: parsed.data.reason,
        flaggedAt: new Date(),
      },
    });

    const admins = await getSuperAdminUserIds();
    const subj = review.subject?.username || 'user';
    const vname = review.venue?.name || 'Venue';
    await createInAppNotificationsForUsers(admins, {
      type: 'ADMIN_FLAGGED_USER_REVIEW',
      title: 'Review flagged for admin review',
      body: `@${subj} flagged a review from ${vname}`,
      referenceId: reviewId,
      referenceType: 'FLAGGED_VENUE_USER_REVIEW',
    });

    const actor = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true },
    });
    notifyAdmins({
      subject: 'Review flagged for admin review',
      body: `@${subj} flagged a review from ${vname}.`,
      dashboardTab: 'flagged-reviews',
      ctaLabel: 'Review flagged reviews',
      excludeEmail: actor?.email,
    }).catch(() => {});

    res.json({ flagged: true });
  } catch (e) {
    next(e);
  }
});

// --- Venue: my review (before /venues/:venueId) ---
router.get('/venues/:venueId/my-review', authenticateToken, async (req, res, next) => {
  try {
    const { venueId } = req.params;
    const row = await prisma.venueReview.findFirst({
      where: { venueId, reviewerId: req.userId, flagged: false },
    });
    res.json(
      row
        ? {
            id: row.id,
            rating: row.rating,
            comment: row.comment,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          }
        : null
    );
  } catch (e) {
    next(e);
  }
});

router.get('/venues/:venueId', optionalAuth, async (req, res, next) => {
  try {
    const { venueId } = req.params;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = 10;
    const skip = (page - 1) * limit;

    const where = { venueId, flagged: false };

    const [agg, rows, total] = await Promise.all([
      prisma.venueReview.aggregate({
        where,
        _avg: { rating: true },
        _count: { id: true },
      }),
      prisma.venueReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          reviewer: {
            select: { id: true, username: true, fullName: true, userProfile: { select: { avatarUrl: true } } },
          },
        },
      }),
      prisma.venueReview.count({ where }),
    ]);

    res.json({
      averageRating: round1(agg._avg.rating),
      totalReviews: agg._count.id,
      reviews: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
        reviewer: mapReviewerUser(r.reviewer),
      })),
      page,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/venues/:venueId', authenticateToken, async (req, res, next) => {
  try {
    const { venueId } = req.params;
    const parsed = ratingComment.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }

    const venue = await prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { id: true, ownerUserId: true },
    });
    if (!venue) return res.status(404).json({ error: 'Venue not found' });
    if (venue.ownerUserId === req.userId) {
      return res.status(403).json({ error: 'You cannot review your own venue.' });
    }

    const createdLastHour = await countReviewsCreatedLastHour(req.userId);
    if (createdLastHour >= 5) {
      return res.status(429).json({
        error: 'You are posting reviews too quickly. Please wait before submitting another.',
      });
    }

    try {
      const r = await prisma.venueReview.create({
        data: {
          reviewerId: req.userId,
          venueId,
          rating: parsed.data.rating,
          comment: parsed.data.comment,
        },
      });
      res.status(201).json({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
      });
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'P2002') {
        return res.status(409).json({
          error: 'You have already reviewed this venue. Edit your existing review instead.',
        });
      }
      throw err;
    }
  } catch (e) {
    next(e);
  }
});

router.patch('/venues/:venueId', authenticateToken, async (req, res, next) => {
  try {
    const { venueId } = req.params;
    const parsed = ratingComment.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }

    const existing = await prisma.venueReview.findFirst({
      where: { venueId, reviewerId: req.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Review not found' });

    const updated = await prisma.venueReview.update({
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

router.delete('/venues/review/:reviewId', authenticateToken, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const existing = await prisma.venueReview.findUnique({ where: { id: reviewId } });
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (existing.reviewerId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await prisma.venueReview.delete({ where: { id: reviewId } });
    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

router.post('/venues/review/:reviewId/flag', authenticateToken, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const parsed = z.object({ reason: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid reason' });

    const review = await prisma.venueReview.findUnique({
      where: { id: reviewId },
      include: {
        venue: { select: { name: true, ownerUserId: true } },
        reviewer: { select: { username: true } },
      },
    });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.venue.ownerUserId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (review.flagged) {
      return res.status(409).json({ error: 'Already flagged' });
    }

    await prisma.venueReview.update({
      where: { id: reviewId },
      data: {
        flagged: true,
        flagReason: parsed.data.reason,
        flaggedAt: new Date(),
      },
    });

    const admins = await getSuperAdminUserIds();
    const vname = review.venue?.name || 'Venue';
    const run = review.reviewer?.username || 'user';
    await createInAppNotificationsForUsers(admins, {
      type: 'ADMIN_FLAGGED_VENUE_REVIEW',
      title: 'Venue review flagged',
      body: `${vname} flagged a review by @${run}`,
      referenceId: reviewId,
      referenceType: 'FLAGGED_VENUE_REVIEW',
    });

    const actor = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true },
    });
    notifyAdmins({
      subject: 'Review flagged for admin review',
      body: `${vname} flagged a review by @${run}.`,
      dashboardTab: 'flagged-reviews',
      ctaLabel: 'Review flagged reviews',
      excludeEmail: actor?.email,
    }).catch(() => {});

    res.json({ flagged: true });
  } catch (e) {
    next(e);
  }
});

export default router;
