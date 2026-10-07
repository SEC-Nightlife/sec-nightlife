/**
 * Analytics Routes
 * All aggregations are computed server-side from DB — never frontend-calculated.
 * SECURITY: Venue analytics are scoped to owned venues only.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { canAccessVenue, staffHasVenuePermission } from '../lib/access.js';
import { computeReputation } from '../lib/reputation.js';

const router = Router();

// ── Event Tracking ────────────────────────────────────────────────────────

// SECURITY: email must be verified to track analytics events
router.post('/track', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    const parsed = z.object({
      event_id: z.string().uuid().optional(),
      venue_id: z.string().uuid().optional(),
      metric: z.string().min(1).max(100),
      value: z.number().optional(),
      metadata: z.record(z.unknown()).optional()
    }).safeParse(req.body);

    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
    const d = parsed.data;

    if (d.venue_id) {
      const ok = await canAccessVenue(d.venue_id, req.userId, req.userRole);
      if (!ok) return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.analyticsEvent.create({
      data: {
        eventId: d.event_id || null,
        venueId: d.venue_id || null,
        userId: req.userId,
        metric: d.metric,
        value: d.value || null,
        metadata: d.metadata || {}
      }
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Venue Performance Metrics ─────────────────────────────────────────────

// SECURITY: email must be verified to access venue analytics
router.get('/venue/:venueId', authenticateToken, requireVerified, requireRole('ADMIN', 'VENUE'), async (req, res, next) => {
  try {
    const { venueId } = req.params;

    // SECURITY: VENUE role can only see their own venue analytics
    if (req.userRole === 'VENUE') {
      const ok = await staffHasVenuePermission(req.userId, venueId, 'analytics');
      if (!ok) return res.status(403).json({ error: 'Not authorized to view this venue analytics' });
    }

    const [events, tables, reviews, attendanceAgg] = await Promise.all([
      prisma.event.findMany({
        where: { venueId, deletedAt: null },
        select: { id: true, title: true, date: true, status: true },
        take: 200,
      }),
      prisma.table.findMany({
        where: { venueId, deletedAt: null },
        select: { id: true, name: true, status: true },
        take: 200,
      }),
      prisma.venueReview.findMany({
        where: { venueId, flagged: false },
        select: { rating: true },
        take: 500,
      }),
      prisma.eventAttendance.groupBy({
        by: ['eventId'],
        where: { event: { venueId, deletedAt: null } },
        _count: { _all: true },
      }),
    ]);

    const totalEvents = events.length;
    const totalAttendees = attendanceAgg.reduce((sum, row) => sum + (row._count._all || 0), 0);
    const confirmedAgg = await prisma.eventAttendance.groupBy({
      by: ['eventId'],
      where: { confirmed: true, event: { venueId, deletedAt: null } },
      _count: { _all: true },
    });
    const confirmedAttendees = confirmedAgg.reduce((sum, row) => sum + (row._count._all || 0), 0);
    const attendanceRate = totalAttendees > 0
      ? Math.round((confirmedAttendees / totalAttendees) * 100)
      : 0;

    const multiAttend = await prisma.eventAttendance.groupBy({
      by: ['userId'],
      where: { event: { venueId, deletedAt: null } },
      _count: { _all: true },
    });
    const repeatAttendees = multiAttend.filter((r) => (r._count._all || 0) > 1).length;

    const totalTables = tables.length;
    const fullTables = tables.filter((t) => t.status === 'full' || t.status === 'closed').length;
    const tableConversionRate = totalTables > 0
      ? Math.round((fullTables / totalTables) * 100)
      : 0;

    const avgRating = reviews.length > 0
      ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(2)
      : null;

    res.json({
      venueId,
      totalEvents,
      totalAttendees,
      confirmedAttendees,
      attendanceRate,
      repeatAttendees,
      totalTables,
      fullTables,
      tableConversionRate,
      totalReviews: reviews.length,
      avgRating: avgRating ? parseFloat(avgRating) : null
    });
  } catch (err) {
    next(err);
  }
});

// ── Report Frequency Metrics (Admin only) ─────────────────────────────────

router.get('/report-frequency', authenticateToken, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);

    const reports = await prisma.report.findMany({
      where: { createdAt: { gte: since } },
      select: { targetType: true, reason: true, status: true, createdAt: true }
    });

    const byType = {};
    const byReason = {};
    reports.forEach(r => {
      byType[r.targetType] = (byType[r.targetType] || 0) + 1;
      byReason[r.reason] = (byReason[r.reason] || 0) + 1;
    });

    res.json({
      total: reports.length,
      period_days: parseInt(days),
      by_target_type: byType,
      by_reason: byReason,
      pending: reports.filter(r => r.status === 'pending').length,
      resolved: reports.filter(r => r.status === 'resolved').length
    });
  } catch (err) {
    next(err);
  }
});

// ── Reputation Score ──────────────────────────────────────────────────────

router.get('/reputation/:userId', authenticateToken, async (req, res, next) => {
  try {
    const { userId } = req.params;

    // SECURITY: users can only see their own score; staff can see any
    if (req.userId !== userId && !['ADMIN', 'MODERATOR'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const score = await computeReputation(userId);
    res.json({ userId, score });
  } catch (err) {
    next(err);
  }
});

// ── Legacy report endpoint ────────────────────────────────────────────────

router.get('/report', authenticateToken, requireRole('ADMIN', 'VENUE'), async (req, res, next) => {
  try {
    const { venue_id, months = 1 } = req.query;
    const since = new Date();
    since.setMonth(since.getMonth() - (parseInt(months) || 1));

    const where = { createdAt: { gte: since } };
    if (venue_id && req.userRole === 'VENUE') {
      const ok = await staffHasVenuePermission(req.userId, venue_id, 'analytics');
      if (!ok) return res.status(403).json({ error: 'Not authorized' });
      where.venueId = venue_id;
    } else if (venue_id) {
      where.venueId = venue_id;
    }

    const events = await prisma.analyticsEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });

    const summary = { total_events: events.length, metrics: {}, by_venue: {} };
    events.forEach(e => {
      summary.metrics[e.metric] = (summary.metrics[e.metric] || 0) + (e.value || 1);
      if (e.venueId) {
        summary.by_venue[e.venueId] = (summary.by_venue[e.venueId] || 0) + 1;
      }
    });

    res.json({ summary, events: events.slice(0, 100) });
  } catch (err) {
    next(err);
  }
});

export default router;
