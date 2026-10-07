/**
 * Admin Moderation Dashboard Routes
 * SECURITY: All routes require ADMIN role. Never expose to USER or VENUE.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken, invalidateAuthUserCache } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { auditFromReq } from '../lib/audit.js';
import { privateDownloadUrl, signCloudinaryUrl } from '../lib/cloudinarySignedUrl.js';
import { createInAppNotification, notifyAllUsersPlatformAnnouncement } from '../lib/inAppNotifications.js';
import {
  notifyUserSuspended,
  notifyUserUnsuspended,
  notifyReporterSafetyUpdate,
} from '../lib/safetyModerationNotify.js';
import { sendEmail, sendIdVerificationApprovedEmail } from '../lib/email.js';
import { requireSuperAdmin } from '../middleware/complianceReviewer.js';
import { getPromotersLeaderboard } from '../lib/leaderboard.js';
import { logger } from '../lib/logger.js';
import { isIdentityVerifiedStatus } from '../middleware/requireIdentityVerified.js';

const router = Router();

const PENDING_TRANSFER_STATUSES = ['PENDING', 'PROCESSING', 'FAILED', 'SKIPPED_NO_RECIPIENT'];
/** In-memory rate limit for wallet-setup reminders: key → last sent ms */
const walletRemindLastSent = new Map();
const WALLET_REMIND_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function parseCreatedAtRange(from, to) {
  if (!from && !to) return undefined;
  const createdAt = {};
  if (from) createdAt.gte = new Date(String(from));
  if (to) createdAt.lte = new Date(String(to));
  return createdAt;
}

/** Align with transfer resolution: usable Paystack recipient code is what matters. */
function userHasPayoutSetup(user) {
  return Boolean(user?.paystackRecipientCode && String(user.paystackRecipientCode).trim());
}

/** Venue Sec Wallet only — owner personal recipient does not count for venue payouts. */
function venueHasPayoutSetup(venue) {
  return Boolean(venue?.paystackRecipientCode && String(venue.paystackRecipientCode).trim());
}

/**
 * Fresh setup flags from DB (not only join payload on ledger rows).
 * Ensures Money tab drops reminder rows as soon as a wallet is saved.
 */
async function loadPayoutSetupMaps(userIds, venueIds) {
  const uniqueUserIds = [...new Set((userIds || []).filter(Boolean))];
  const uniqueVenueIds = [...new Set((venueIds || []).filter(Boolean))];
  const [users, venues] = await Promise.all([
    uniqueUserIds.length
      ? prisma.user.findMany({
          where: { id: { in: uniqueUserIds } },
          select: {
            id: true,
            email: true,
            fullName: true,
            paystackRecipientCode: true,
          },
        })
      : [],
    uniqueVenueIds.length
      ? prisma.venue.findMany({
          where: { id: { in: uniqueVenueIds }, deletedAt: null },
          select: {
            id: true,
            name: true,
            paystackRecipientCode: true,
            ownerUserId: true,
            owner: {
              select: {
                id: true,
                email: true,
                fullName: true,
                paystackRecipientCode: true,
              },
            },
          },
        })
      : [],
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const venueById = new Map(venues.map((v) => [v.id, v]));
  return { userById, venueById };
}

/**
 * Money-tab revenue: gross from successful payments; SEC from ledger (excl. refunded);
 * pending = recipient share still owed to USER/VENUE.
 */
async function computeMoneyRevenue(dateRange) {
  const paymentWhere = { status: 'success' };
  if (dateRange) paymentWhere.createdAt = dateRange;

  const secWhere = {
    status: { not: 'REFUNDED_MANUAL' },
  };
  if (dateRange) secWhere.createdAt = dateRange;

  const pendingWhere = {
    status: { in: PENDING_TRANSFER_STATUSES },
    recipientType: { in: ['USER', 'VENUE'] },
    recipientAmount: { gt: 0 },
  };
  if (dateRange) pendingWhere.createdAt = dateRange;

  const [grossAgg, ledgerAgg, pendingAgg, pendingRows] = await Promise.all([
    prisma.payment.aggregate({ where: paymentWhere, _sum: { amount: true }, _count: true }),
    prisma.payoutLedger.aggregate({
      where: secWhere,
      _sum: { grossAmount: true, secAmount: true, recipientAmount: true },
    }),
    prisma.payoutLedger.aggregate({
      where: pendingWhere,
      _sum: { recipientAmount: true },
      _count: true,
    }),
    prisma.payoutLedger.findMany({
      where: pendingWhere,
      select: {
        recipientAmount: true,
        recipientType: true,
        recipientUserId: true,
        recipientVenueId: true,
        recipientUser: {
          select: {
            id: true,
            email: true,
            fullName: true,
            paystackRecipientCode: true,
          },
        },
        recipientVenue: {
          select: {
            id: true,
            name: true,
            paystackRecipientCode: true,
            ownerUserId: true,
            owner: {
              select: {
                id: true,
                email: true,
                fullName: true,
                paystackRecipientCode: true,
              },
            },
          },
        },
      },
    }),
  ]);

  const byKey = new Map();
  for (const row of pendingRows) {
    const amount = Number(row.recipientAmount) || 0;
    if (row.recipientType === 'USER' && row.recipientUserId) {
      const key = `USER:${row.recipientUserId}`;
      const existing = byKey.get(key) || {
        recipientType: 'USER',
        userId: row.recipientUserId,
        venueId: null,
        name: row.recipientUser?.fullName || 'User',
        email: row.recipientUser?.email || null,
        notifyUserId: row.recipientUserId,
        pendingZar: 0,
      };
      existing.pendingZar += amount;
      if (row.recipientUser?.fullName) existing.name = row.recipientUser.fullName;
      if (row.recipientUser?.email) existing.email = row.recipientUser.email;
      byKey.set(key, existing);
    } else if (row.recipientType === 'VENUE' && row.recipientVenueId) {
      const key = `VENUE:${row.recipientVenueId}`;
      const venue = row.recipientVenue;
      const existing = byKey.get(key) || {
        recipientType: 'VENUE',
        userId: venue?.ownerUserId || null,
        venueId: row.recipientVenueId,
        name: venue?.name || 'Venue',
        email: venue?.owner?.email || null,
        notifyUserId: venue?.ownerUserId || venue?.owner?.id || null,
        pendingZar: 0,
      };
      existing.pendingZar += amount;
      if (venue?.name) existing.name = venue.name;
      if (venue?.owner?.email) existing.email = venue.owner.email;
      if (venue?.ownerUserId) {
        existing.userId = venue.ownerUserId;
        existing.notifyUserId = venue.ownerUserId;
      }
      byKey.set(key, existing);
    }
  }

  const grouped = [...byKey.values()];
  const { userById, venueById } = await loadPayoutSetupMaps(
    grouped.map((r) => (r.recipientType === 'USER' ? r.userId : r.notifyUserId)),
    grouped.filter((r) => r.recipientType === 'VENUE').map((r) => r.venueId),
  );

  const pendingRecipients = grouped
    .map((r) => {
      let hasPayoutSetup = false;
      if (r.recipientType === 'USER' && r.userId) {
        const user = userById.get(r.userId);
        hasPayoutSetup = userHasPayoutSetup(user);
        if (user?.fullName) r.name = user.fullName;
        if (user?.email) r.email = user.email;
      } else if (r.recipientType === 'VENUE' && r.venueId) {
        const venue = venueById.get(r.venueId);
        hasPayoutSetup = venueHasPayoutSetup(venue);
        if (venue?.name) r.name = venue.name;
        if (venue?.owner?.email) r.email = venue.owner.email;
        if (venue?.ownerUserId) {
          r.userId = venue.ownerUserId;
          r.notifyUserId = venue.ownerUserId;
        }
      }
      return {
        ...r,
        pendingZar: Math.round(r.pendingZar * 100) / 100,
        hasPayoutSetup,
      };
    })
    .sort((a, b) => b.pendingZar - a.pendingZar);

  // Reminder list: only recipients who still have no usable Sec Wallet payout destination.
  const missingWalletRecipients = pendingRecipients.filter(
    (r) => !r.hasPayoutSetup && Number(r.pendingZar) > 0,
  );
  const pendingBlockedByMissingWalletZar = missingWalletRecipients.reduce(
    (sum, r) => sum + Number(r.pendingZar || 0),
    0,
  );

  const pendingTransfersZar = pendingAgg._sum?.recipientAmount ?? 0;
  const pendingTransfersCount = pendingAgg._count ?? 0;

  return {
    totalGrossZar: grossAgg._sum?.amount ?? 0,
    totalSecRevenueZar: ledgerAgg._sum?.secAmount ?? 0,
    totalRecipientShareZar: ledgerAgg._sum?.recipientAmount ?? 0,
    pendingTransfersZar,
    pendingTransfersCount,
    pendingBlockedByMissingWalletZar: Math.round(pendingBlockedByMissingWalletZar * 100) / 100,
    /** @deprecated use pendingTransfersZar — kept for older clients */
    pendingTransfers: pendingTransfersZar,
    /** All pending recipients (includes those with wallet already set). */
    pendingRecipients,
    /** Only recipients who still need a Sec Wallet reminder. */
    missingWalletRecipients,
    paymentCount: grossAgg._count ?? 0,
  };
}

// All admin routes require authentication + admin role
router.use(authenticateToken, requireAdmin); // SECURITY: admin-only zone

// ── Reports ───────────────────────────────────────────────────────────────

router.get('/reports', async (req, res, next) => {
  try {
    const { status = 'pending', category, priority, targetType, assignedTo, from, to, limit = 50, offset = 0 } = req.query;
    const where = { status: String(status) };
    if (category) where.category = String(category);
    if (priority) where.priority = String(priority);
    if (targetType) where.targetType = String(targetType);
    if (assignedTo) where.assignedTo = String(assignedTo);
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(String(from));
      if (to) where.createdAt.lte = new Date(String(to));
    }

    const reports = await prisma.report.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
      include: {
        reporter: { select: { id: true, email: true, fullName: true } },
      },
    });
    const total = await prisma.report.count({ where });
    res.json({ reports, total });
  } catch (err) {
    next(err);
  }
});

router.patch('/reports/:id/assign', async (req, res, next) => {
  try {
    const { assignedTo } = z.object({
      assignedTo: z.string().uuid().nullable().optional(),
    }).parse(req.body);

    const report = await prisma.report.update({
      where: { id: req.params.id },
      data: {
        assignedTo: assignedTo || null,
        status: 'in_review',
        reviewedAt: new Date(),
      },
    });
    res.json({ success: true, report });
  } catch (err) {
    next(err);
  }
});

router.patch('/reports/:id/resolve', async (req, res, next) => {
  try {
    const { action, resolutionNote } = z.object({
      action: z.enum(['action_taken', 'dismissed', 'resolved']),
      resolutionNote: z.string().min(3).max(2000),
    }).parse(req.body);

    const report = await prisma.report.update({
      where: { id: req.params.id },
      data: {
        status: action,
        resolutionNote,
        resolvedBy: req.userId,
        resolvedAt: new Date(),
        reviewedAt: new Date(),
      },
    });

    await auditFromReq(req, {
      userId: req.userId,
      action: `REPORT_${action.toUpperCase()}`,
      entityType: 'report',
      entityId: report.id,
      metadata: { reportId: report.id, targetType: report.targetType, targetId: report.targetId, resolutionNote },
    });

    const actionLabel =
      action === 'dismissed'
        ? 'dismissed without further action'
        : action === 'action_taken'
          ? 'marked as action taken'
          : 'marked as resolved';
    await notifyReporterSafetyUpdate(report.reporterId, {
      title: 'Update on your safety report',
      body: `SEC safety reviewed your report and ${actionLabel}.\n\nFeedback from the team:\n${resolutionNote}`,
      reportId: report.id,
    });

    res.json({ success: true, report });
  } catch (err) {
    next(err);
  }
});

router.post('/reports/:id/moderate', async (req, res, next) => {
  try {
    const { action, reason } = z.object({
      action: z.enum([
        'suspend_user',
        'unsuspend_user',
        'reject_venue',
        'pending_venue',
        'cancel_event',
        'unpublish_vendor',
        'republish_vendor',
      ]),
      reason: z.string().min(3).max(500),
    }).parse(req.body);

    const report = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!report) return res.status(404).json({ error: 'Report not found' });

    if (action === 'suspend_user' || action === 'unsuspend_user') {
      if (report.targetType !== 'user') return res.status(400).json({ error: 'Report target must be user' });
      if (action === 'suspend_user') {
        await notifyUserSuspended(report.targetId, reason);
        await prisma.user.update({
          where: { id: report.targetId },
          data: { suspendedAt: new Date(), suspendedReason: reason },
        });
        await prisma.refreshToken.deleteMany({ where: { userId: report.targetId } });
        await invalidateAuthUserCache(report.targetId);
      } else {
        await prisma.user.update({
          where: { id: report.targetId },
          data: { suspendedAt: null, suspendedReason: null },
        });
        await invalidateAuthUserCache(report.targetId);
        await notifyUserUnsuspended(report.targetId, reason);
      }
    }

    if (action === 'reject_venue' || action === 'pending_venue') {
      if (report.targetType !== 'venue') return res.status(400).json({ error: 'Report target must be venue' });
      await prisma.venue.update({
        where: { id: report.targetId },
        data: {
          complianceStatus: action === 'reject_venue' ? 'rejected' : 'pending',
          complianceRejectionNote: reason,
        },
      });
    }

    if (action === 'unpublish_vendor' || action === 'republish_vendor') {
      if (report.targetType !== 'vendor') return res.status(400).json({ error: 'Report target must be vendor' });
      const vendor = await prisma.vendorBusiness.findFirst({
        where: { id: report.targetId, deletedAt: null },
        select: { id: true, userId: true, name: true },
      });
      if (!vendor) return res.status(404).json({ error: 'Vendor listing not found' });
      const unpublish = action === 'unpublish_vendor';
      await prisma.vendorBusiness.update({
        where: { id: vendor.id },
        data: unpublish
          ? { isPublished: false, unpublishedByAdminAt: new Date(), unpublishedReason: reason }
          : { isPublished: true, unpublishedByAdminAt: null, unpublishedReason: null },
      });
      await createInAppNotification({
        userId: vendor.userId,
        type: 'SAFETY_REPORT_UPDATE',
        title: unpublish ? 'Your vendor listing was unpublished' : 'Your vendor listing is live again',
        body: unpublish
          ? `SEC moderation unpublished "${vendor.name}" after a report.\n\nReason: ${reason}`
          : `SEC moderation restored "${vendor.name}".\n\nNote: ${reason}`,
        referenceId: '/VendorBusinessSettings',
        referenceType: 'ROUTE',
      });
    }

    if (action === 'cancel_event') {
      if (report.targetType !== 'event') return res.status(400).json({ error: 'Report target must be event' });
      await prisma.event.update({
        where: { id: report.targetId },
        data: { status: 'cancelled' },
      });
    }

    const updatedReport = await prisma.report.update({
      where: { id: report.id },
      data: {
        status: 'action_taken',
        resolutionNote: reason,
        resolvedBy: req.userId,
        resolvedAt: new Date(),
        reviewedAt: new Date(),
      },
    });

    await auditFromReq(req, {
      userId: req.userId,
      action: `REPORT_MODERATION_${action.toUpperCase()}`,
      entityType: 'report',
      entityId: report.id,
      metadata: {
        reportId: report.id,
        targetType: report.targetType,
        targetId: report.targetId,
        reason,
      },
    });

    const moderationFeedback =
      action === 'suspend_user'
        ? `We suspended the reported account.\n\nFeedback from the team:\n${reason}`
        : action === 'unsuspend_user'
          ? `We restored access for the reported account.\n\nFeedback from the team:\n${reason}`
          : action === 'cancel_event'
            ? `We cancelled the reported event.\n\nFeedback from the team:\n${reason}`
            : action === 'unpublish_vendor'
              ? `We unpublished the reported vendor listing.\n\nFeedback from the team:\n${reason}`
              : action === 'republish_vendor'
                ? `We restored the vendor listing.\n\nFeedback from the team:\n${reason}`
            : action === 'reject_venue'
              ? `We rejected the venue compliance submission.\n\nFeedback from the team:\n${reason}`
              : `We updated the venue compliance status.\n\nFeedback from the team:\n${reason}`;

    await notifyReporterSafetyUpdate(report.reporterId, {
      title: 'Update on your safety report',
      body: moderationFeedback,
      reportId: report.id,
    });

    res.json({ success: true, report: updatedReport });
  } catch (err) {
    next(err);
  }
});

// ── User Moderation ───────────────────────────────────────────────────────

router.get('/users', async (req, res, next) => {
  try {
    const { search, role, suspended, limit = 50, offset = 0 } = req.query;
    const where = { deletedAt: null };
    if (role) where.role = String(role);
    if (suspended === 'true') where.suspendedAt = { not: null };
    if (suspended === 'false') where.suspendedAt = null;
    if (search) {
      where.OR = [
        { email: { contains: String(search), mode: 'insensitive' } },
        { fullName: { contains: String(search), mode: 'insensitive' } }
      ];
    }

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true, email: true, fullName: true, role: true,
        isPremium: true, suspendedAt: true, suspendedReason: true,
        emailVerified: true, createdAt: true
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0
    });

    const total = await prisma.user.count({ where });
    res.json({ users, total });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/suspend', async (req, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body);

    // SECURITY: prevent admin from suspending themselves
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: 'Cannot suspend yourself' });
    }

    await notifyUserSuspended(req.params.id, reason);

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { suspendedAt: new Date(), suspendedReason: reason }
    });

    // Revoke all refresh tokens on suspension
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await invalidateAuthUserCache(user.id);

    await auditFromReq(req, {
      userId: req.userId,
      action: 'USER_SUSPENDED',
      entityType: 'user',
      entityId: user.id,
      metadata: { targetEmail: user.email, reason }
    });

    res.json({ success: true, userId: user.id });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/unsuspend', async (req, res, next) => {
  try {
    const parsed = z
      .object({ note: z.string().trim().max(500).optional() })
      .safeParse(req.body || {});
    const note = parsed.success && parsed.data.note ? parsed.data.note : '';

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { suspendedAt: null, suspendedReason: null }
    });
    await invalidateAuthUserCache(user.id);
    await notifyUserUnsuspended(user.id, note);

    await auditFromReq(req, {
      userId: req.userId,
      action: 'USER_UNSUSPENDED',
      entityType: 'user',
      entityId: user.id,
      metadata: { targetEmail: user.email, note: note || null }
    });

    res.json({ success: true, userId: user.id });
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id/role', async (req, res, next) => {
  try {
    const { role } = z.object({
      role: z.enum(['USER', 'VENUE', 'FREELANCER', 'ADMIN', 'SUPER_ADMIN', 'MODERATOR'])
    }).parse(req.body);

    // SECURITY: prevent demoting yourself
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { role }
    });

    await auditFromReq(req, {
      userId: req.userId,
      action: 'ROLE_CHANGED',
      entityType: 'user',
      entityId: user.id,
      metadata: { targetEmail: user.email, newRole: role }
    });

    res.json({ success: true, userId: user.id, role });
  } catch (err) {
    next(err);
  }
});

// ── Audit Log Viewer ──────────────────────────────────────────────────────

router.get('/audit-logs', async (req, res, next) => {
  try {
    const { userId, action, resource, from, to, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (userId) where.userId = String(userId);
    if (action) where.action = { contains: String(action), mode: 'insensitive' };
    if (resource) where.resource = String(resource);
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(String(from));
      if (to) where.createdAt.lte = new Date(String(to));
    }

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
      include: {
        user: { select: { id: true, email: true, fullName: true } }
      }
    });

    const total = await prisma.auditLog.count({ where });
    res.json({ logs, total });
  } catch (err) {
    next(err);
  }
});

// ── Payments ───────────────────────────────────────────────────────────────

function basePaymentReference(ref) {
  const s = String(ref || '');
  const idx = s.indexOf(':');
  return idx >= 0 ? s.slice(0, idx) : s;
}

function aggregateLedgersForPayments(payments, ledgers) {
  const byBase = new Map();
  for (const row of ledgers) {
    const base = basePaymentReference(row.paymentReference);
    if (!byBase.has(base)) {
      byBase.set(base, { grossZar: 0, secAmountZar: 0, recipientAmountZar: 0, statuses: [] });
    }
    const agg = byBase.get(base);
    agg.grossZar += Number(row.grossAmount) || 0;
    agg.secAmountZar += Number(row.secAmount) || 0;
    agg.recipientAmountZar += Number(row.recipientAmount) || 0;
    if (row.status) agg.statuses.push(row.status);
  }

  return payments.map((p) => {
    const agg = byBase.get(p.reference);
    const statuses = agg?.statuses || [];
    const pendingStatuses = new Set(['PENDING', 'FAILED', 'SKIPPED_NO_RECIPIENT', 'PROCESSING']);
    let transferStatus = null;
    if (statuses.length) {
      if (statuses.every((s) => s === 'COMPLETED' || s === 'TRANSFERRED' || s === 'SKIPPED_NO_RECIPIENT')) {
        transferStatus = statuses.some((s) => s === 'COMPLETED' || s === 'TRANSFERRED') ? 'COMPLETED' : 'SKIPPED';
      } else if (statuses.every((s) => s === 'PROCESSING')) {
        transferStatus = 'PROCESSING';
      } else if (statuses.some((s) => pendingStatuses.has(s))) {
        transferStatus = statuses.some((s) => s === 'PROCESSING') ? 'PROCESSING' : 'PENDING';
      } else {
        transferStatus = 'MIXED';
      }
    }
    const grossZar = Number(p.amount) || 0;
    return {
      ...p,
      grossZar,
      secAmountZar: agg?.secAmountZar ?? null,
      recipientAmountZar: agg?.recipientAmountZar ?? null,
      ledgerGrossZar: agg?.grossZar ?? null,
      transferStatus,
      no_ledger: p.status === 'success' && !agg,
    };
  });
}

router.get('/payments', async (req, res, next) => {
  try {
    // Side-effect repairs (ticket ensure / ledger backfill) used to run on every Money-tab
    // load and routinely exceeded Vercel serverless timeouts (~10–12s+). Keep this GET
    // read-only and fast; repairs belong to cron (/api/cron/retry-payouts) or ?repair=1.
    const { status, type, limit = 50, offset = 0, from, to, repair } = req.query;
    const wantRepair = String(repair || '') === '1' || String(repair || '').toLowerCase() === 'true';
    if (wantRepair) {
      try {
        const { ensureEventTicketsForPayment } = await import('../lib/issueEventTickets.js');
        const stuckPending = await prisma.payment.findMany({
          where: { status: 'pending' },
          take: 15,
          orderBy: { createdAt: 'desc' },
          select: { reference: true },
        });
        await Promise.all(
          stuckPending.map((p) =>
            ensureEventTicketsForPayment(p.reference, { status: 'success' }).catch(() => null),
          ),
        );
        const { repairMissingVenueTablePayouts } = await import('../lib/paystackPayout.js');
        await repairMissingVenueTablePayouts({ sinceDays: 30, limit: 20 }).catch(() => null);
      } catch (repairErr) {
        logger.warn('admin payments optional repair failed', { err: String(repairErr?.message || repairErr) });
      }
    }

    const where = {};
    const rawStatus = status != null && String(status) !== '' ? String(status) : '';
    if (rawStatus === 'all') {
      // no status filter
    } else if (rawStatus) {
      where.status = rawStatus;
    } else {
      where.status = { in: ['success', 'failed', 'pending'] };
    }
    if (type) where.type = String(type);
    const dateRange = parseCreatedAtRange(from, to);
    if (dateRange) {
      // Reject invalid dates so Prisma does not throw and blank the Money tab.
      if (
        (dateRange.gte && Number.isNaN(dateRange.gte.getTime())) ||
        (dateRange.lte && Number.isNaN(dateRange.lte.getTime()))
      ) {
        return res.status(400).json({ error: 'Invalid from/to date' });
      }
      where.createdAt = dateRange;
    }

    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = parseInt(offset) || 0;

    const [payments, total, revenue, totalsByStatus] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      prisma.payment.count({ where }),
      computeMoneyRevenue(dateRange),
      prisma.payment.groupBy({
        by: ['status'],
        where,
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    const refs = payments.map((p) => p.reference).filter(Boolean);
    let ledgers = [];
    if (refs.length > 0) {
      const refSet = new Set(refs);
      // Avoid hundreds of startsWith OR clauses (slow / timeout-prone on serverless).
      const candidates = await prisma.payoutLedger.findMany({
        where: {
          OR: [{ paymentReference: { in: refs } }, { paymentReference: { contains: ':' } }],
        },
      });
      ledgers = candidates.filter((row) => {
        const base = basePaymentReference(row.paymentReference);
        return refSet.has(row.paymentReference) || refSet.has(base);
      });
    }

    const enriched = aggregateLedgersForPayments(payments, ledgers);

    res.json({
      payments: enriched,
      total,
      summary: totalsByStatus,
      revenue,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/payouts', async (req, res, next) => {
  try {
    const { from, to, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(String(from));
      if (to) where.createdAt.lte = new Date(String(to));
    }
    const [rows, total, agg] = await Promise.all([
      prisma.payoutLedger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(limit) || 50, 200),
        skip: parseInt(offset) || 0,
        include: {
          recipientUser: { select: { id: true, email: true, fullName: true } },
          recipientVenue: { select: { id: true, name: true } },
        },
      }),
      prisma.payoutLedger.count({ where }),
      prisma.payoutLedger.aggregate({
        where,
        _sum: { grossAmount: true, secAmount: true, recipientAmount: true },
      }),
    ]);
    res.json({
      rows,
      total,
      summary: {
        totalGrossZar: agg._sum?.grossAmount ?? 0,
        totalSecRevenueZar: agg._sum?.secAmount ?? 0,
        totalRecipientShareZar: agg._sum?.recipientAmount ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

const remindWalletSchema = z.object({
  recipientType: z.enum(['USER', 'VENUE']),
  userId: z.string().min(1).optional().nullable(),
  venueId: z.string().min(1).optional().nullable(),
});

router.post('/payouts/remind-wallet-setup', async (req, res, next) => {
  try {
    const parsed = remindWalletSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const { recipientType, userId, venueId } = parsed.data;

    let notifyUserId = null;
    let email = null;
    let displayName = 'there';
    let helpAudience = 'partygoer';
    let setupPath = '/Profile?tab=wallet';
    let rateKey = null;

    if (recipientType === 'USER') {
      if (!userId) return res.status(400).json({ error: 'userId is required for USER reminders' });
      const user = await prisma.user.findFirst({
        where: { id: String(userId), deletedAt: null },
        select: {
          id: true,
          email: true,
          fullName: true,
          paystackRecipientCode: true,
        },
      });
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (userHasPayoutSetup(user)) {
        return res.status(400).json({ error: 'User already has Sec Wallet payout setup' });
      }
      const owed = await prisma.payoutLedger.aggregate({
        where: {
          recipientUserId: user.id,
          recipientType: 'USER',
          recipientAmount: { gt: 0 },
          status: { in: PENDING_TRANSFER_STATUSES },
        },
        _sum: { recipientAmount: true },
      });
      if (!(Number(owed._sum?.recipientAmount) > 0)) {
        return res.status(400).json({ error: 'User has no pending payouts to remind about' });
      }
      notifyUserId = user.id;
      email = user.email;
      displayName = user.fullName || 'there';
      helpAudience = 'partygoer';
      setupPath = '/Profile?tab=wallet';
      rateKey = `USER:${user.id}`;
    } else {
      if (!venueId) return res.status(400).json({ error: 'venueId is required for VENUE reminders' });
      const venue = await prisma.venue.findFirst({
        where: { id: String(venueId), deletedAt: null },
        select: {
          id: true,
          name: true,
          paystackRecipientCode: true,
          ownerUserId: true,
          owner: {
            select: {
              id: true,
              email: true,
              fullName: true,
              paystackRecipientCode: true,
            },
          },
        },
      });
      if (!venue) return res.status(404).json({ error: 'Venue not found' });
      if (venueHasPayoutSetup(venue)) {
        return res.status(400).json({
          error: 'This venue already has Sec Wallet payout setup — no reminder needed',
        });
      }
      if (!venue.ownerUserId) return res.status(400).json({ error: 'Venue has no owner to notify' });
      const owed = await prisma.payoutLedger.aggregate({
        where: {
          recipientVenueId: venue.id,
          recipientType: 'VENUE',
          recipientAmount: { gt: 0 },
          status: { in: PENDING_TRANSFER_STATUSES },
        },
        _sum: { recipientAmount: true },
      });
      if (!(Number(owed._sum?.recipientAmount) > 0)) {
        return res.status(400).json({ error: 'Venue has no pending payouts to remind about' });
      }
      notifyUserId = venue.ownerUserId;
      email = venue.owner?.email || null;
      displayName = venue.owner?.fullName || venue.name || 'there';
      helpAudience = 'venue';
      setupPath = '/BusinessDashboard';
      rateKey = `VENUE:${venue.id}`;
    }

    const lastSent = walletRemindLastSent.get(rateKey) || 0;
    if (Date.now() - lastSent < WALLET_REMIND_COOLDOWN_MS) {
      return res.status(429).json({
        error: 'A reminder was already sent in the last 24 hours for this recipient',
        code: 'REMIND_COOLDOWN',
      });
    }

    const appBase = (process.env.APP_URL || 'https://secnightlife.com').replace(/\/+$/, '');
    const helpPath = `/HelpArticle?id=payouts&audience=${helpAudience}`;
    const helpUrl = `${appBase}${helpPath}`;
    const setupUrl = `${appBase}${setupPath}`;
    const title = 'Set up your Sec Wallet to receive payouts';
    const body =
      recipientType === 'VENUE'
        ? `Hi ${displayName}, you have pending SEC payouts waiting. Set up your venue Sec Wallet so funds can transfer automatically to your bank account. Guide: ${helpUrl}`
        : `Hi ${displayName}, you have pending SEC payouts waiting. Set up your Sec Wallet so funds can transfer automatically to your bank account. Guide: ${helpUrl}`;

    const notif = await createInAppNotification({
      userId: notifyUserId,
      venueId: recipientType === 'VENUE' ? venueId : undefined,
      type: 'WALLET_SETUP_REMINDER',
      title,
      body: 'You have pending payouts. Set up your Sec Wallet so we can transfer funds to your bank account automatically.',
      referenceId: helpPath,
      referenceType: 'ROUTE',
    });

    let emailed = false;
    if (email) {
      try {
        await sendEmail({
          to: email,
          subject: title,
          text: `${body}\n\nSet up now: ${setupUrl}\nHow it works: ${helpUrl}`,
          html: `<p>Hi ${displayName},</p>
<p>You have pending SEC payouts waiting because your Sec Wallet bank details are not set up yet.</p>
<p>Once you add your payout details, eligible earnings transfer automatically to your bank account.</p>
<p><a href="${setupUrl}" style="color:#D4AF37;font-weight:600;">Set up Sec Wallet</a></p>
<p><a href="${helpUrl}" style="color:#D4AF37;font-weight:600;">How to set up your Sec Wallet &amp; automatic transfers</a></p>`,
        });
        emailed = true;
      } catch (err) {
        logger.warn('wallet setup remind email failed', { email, err: err?.message });
      }
    }

    if (!notif && !emailed) {
      return res.status(502).json({ error: 'Could not deliver reminder via email or in-app notification' });
    }

    walletRemindLastSent.set(rateKey, Date.now());
    await auditFromReq(req, {
      userId: req.userId,
      action: 'WALLET_SETUP_REMINDER',
      entityType: recipientType === 'VENUE' ? 'venue' : 'user',
      entityId: recipientType === 'VENUE' ? venueId : userId,
      metadata: { notifyUserId, email: email || null, emailed, inApp: Boolean(notif) },
    }).catch(() => {});

    res.json({ success: true, notifiedUserId: notifyUserId, emailed, inApp: Boolean(notif) });
  } catch (err) {
    next(err);
  }
});

// ── Verification Queue (User ID) ───────────────────────────────────────────

router.get('/verification/users', async (req, res, next) => {
  try {
    const { status = 'pending', limit = 50, offset = 0 } = req.query;
    const where = { user: { deletedAt: null } };
    // Queue: awaiting admin review — submitted, or legacy pending + ID on file
    if (status === 'pending' || status === 'queue') {
      where.AND = [
        { NOT: { verificationStatus: { in: ['verified', 'approved', 'rejected'] } } },
        {
          OR: [
            { verificationStatus: 'submitted' },
            { AND: [{ verificationStatus: 'pending' }, { idDocumentUrl: { not: null } }] },
          ],
        },
      ];
    } else if (status) {
      where.verificationStatus = String(status);
    }

    const profiles = await prisma.userProfile.findMany({
      where,
      include: { user: { select: { id: true, email: true, fullName: true } } },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
    });
    const total = await prisma.userProfile.count({ where });
    res.json({ profiles, total });
  } catch (err) {
    next(err);
  }
});

router.get('/verification/users/:userId/id-document', async (req, res, next) => {
  try {
    const profile = await prisma.userProfile.findUnique({
      where: { userId: req.params.userId },
      select: { id: true, idDocumentUrl: true, userId: true },
    });
    const fileUrl = profile?.idDocumentUrl;
    if (!fileUrl) return res.status(404).json({ error: 'No ID document on file' });

    const viewUrl = fileUrl
      ? privateDownloadUrl(fileUrl) || signCloudinaryUrl(fileUrl) || fileUrl
      : null;

    await auditFromReq(req, {
      userId: req.userId,
      action: 'USER_ID_DOCUMENT_VIEWED',
      entityType: 'user_profile',
      entityId: profile.id,
      metadata: { targetUserId: req.params.userId },
    });

    res.json({ viewUrl });
  } catch (err) {
    next(err);
  }
});

router.patch('/verification/users/:userId', async (req, res, next) => {
  try {
    const { status, note } = z.object({
      status: z.enum(['verified', 'rejected']),
      note: z.string().max(500).optional().nullable(),
    }).parse(req.body);

    const userId = req.params.userId;
    const existing = await prisma.userProfile.findUnique({
      where: { userId },
      select: { id: true, userId: true, verificationStatus: true },
    });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });

    if (status === 'verified' && isIdentityVerifiedStatus(existing.verificationStatus)) {
      return res.json({
        success: true,
        alreadyVerified: true,
        profile: { userId: existing.userId, verificationStatus: existing.verificationStatus },
      });
    }

    const profile = await prisma.userProfile.update({
      where: { userId },
      data: {
        verificationStatus: status,
        verificationRejectionNote: status === 'rejected' ? (note || null) : null,
        ageVerified: status === 'verified',
      },
    });

    await auditFromReq(req, {
      userId: req.userId,
      action: 'USER_VERIFICATION_UPDATED',
      entityType: 'user_profile',
      entityId: profile.id,
      metadata: { userId: profile.userId, status, note },
    });

    if (status === 'verified') {
      const targetUser = await prisma.user.findUnique({
        where: { id: profile.userId },
        select: { id: true, email: true, fullName: true },
      });
      if (targetUser) {
        await prisma.inAppNotification.updateMany({
          where: {
            userId: targetUser.id,
            type: 'IDENTITY_VERIFICATION_REMINDER',
            read: false,
          },
          data: { read: true },
        });
        await createInAppNotification({
          userId: targetUser.id,
          type: 'IDENTITY_VERIFICATION_REMINDER',
          title: 'ID verification approved',
          body: 'Your ID has been approved. You can now access verified-only features.',
          referenceId: '/EditProfile',
          referenceType: 'ROUTE',
        });
        sendIdVerificationApprovedEmail(targetUser.email, targetUser.fullName).catch(() => {});
      }
    }

    res.json({ success: true, profile: { userId: profile.userId, verificationStatus: profile.verificationStatus } });
  } catch (err) {
    next(err);
  }
});

// ── Promoter Verification & Moderation ─────────────────────────────────────

router.get('/promoters/candidates', async (req, res, next) => {
  try {
    const result = await getPromotersLeaderboard({ page: 1, limit: 500, includeUnverified: true });
    res.json({
      policy: result.policy,
      total: result.total,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/promoters/:userId/verify', async (req, res, next) => {
  try {
    const { note } = z.object({
      note: z.string().max(1000).optional().nullable(),
    }).parse(req.body || {});
    const userId = req.params.userId;
    const profile = await prisma.userProfile.upsert({
      where: { userId },
      create: {
        userId,
        isVerifiedPromoter: true,
        promoterVerifiedAt: new Date(),
        promoterVerifiedBy: req.userId,
        promoterRevokedAt: null,
        promoterRevokedBy: null,
        promoterVerificationNote: note || null,
      },
      update: {
        isVerifiedPromoter: true,
        promoterVerifiedAt: new Date(),
        promoterVerifiedBy: req.userId,
        promoterRevokedAt: null,
        promoterRevokedBy: null,
        promoterVerificationNote: note || null,
      },
    });
    await auditFromReq(req, {
      userId: req.userId,
      action: 'PROMOTER_VERIFIED',
      entityType: 'user_profile',
      entityId: profile.id,
      metadata: { targetUserId: userId, note: note || null },
    });
    await createInAppNotification({
      userId,
      type: 'IDENTITY_VERIFICATION_REMINDER',
      title: 'Verified promoter status granted',
      body: 'You are now a verified promoter and eligible for promoter features.',
      referenceId: '/Leaderboard',
      referenceType: 'ROUTE',
    });
    res.json({ success: true, profile: { userId: profile.userId, isVerifiedPromoter: profile.isVerifiedPromoter } });
  } catch (err) {
    next(err);
  }
});

router.patch('/promoters/:userId/revoke', async (req, res, next) => {
  try {
    const { reason } = z.object({
      reason: z.string().min(3).max(1000),
    }).parse(req.body || {});
    const userId = req.params.userId;
    const profile = await prisma.userProfile.upsert({
      where: { userId },
      create: {
        userId,
        isVerifiedPromoter: false,
        promoterRevokedAt: new Date(),
        promoterRevokedBy: req.userId,
        promoterVerificationNote: reason,
      },
      update: {
        isVerifiedPromoter: false,
        promoterRevokedAt: new Date(),
        promoterRevokedBy: req.userId,
        promoterVerificationNote: reason,
      },
    });
    await auditFromReq(req, {
      userId: req.userId,
      action: 'PROMOTER_VERIFICATION_REVOKED',
      entityType: 'user_profile',
      entityId: profile.id,
      metadata: { targetUserId: userId, reason },
    });
    await createInAppNotification({
      userId,
      type: 'IDENTITY_VERIFICATION_REMINDER',
      title: 'Verified promoter status removed',
      body: reason,
      referenceId: '/Settings',
      referenceType: 'ROUTE',
    });
    res.json({ success: true, profile: { userId: profile.userId, isVerifiedPromoter: profile.isVerifiedPromoter } });
  } catch (err) {
    next(err);
  }
});

router.patch('/promoters/:userId/leaderboard-visibility', async (req, res, next) => {
  try {
    const { hidden, reason, until } = z.object({
      hidden: z.boolean(),
      reason: z.string().max(1000).optional().nullable(),
      until: z.string().datetime().optional().nullable(),
    }).parse(req.body || {});
    const userId = req.params.userId;
    const profile = await prisma.userProfile.upsert({
      where: { userId },
      create: {
        userId,
        leaderboardHidden: hidden,
        leaderboardHiddenReason: hidden ? (reason || null) : null,
        leaderboardHiddenUntil: hidden && until ? new Date(until) : null,
      },
      update: {
        leaderboardHidden: hidden,
        leaderboardHiddenReason: hidden ? (reason || null) : null,
        leaderboardHiddenUntil: hidden && until ? new Date(until) : null,
      },
    });
    await auditFromReq(req, {
      userId: req.userId,
      action: hidden ? 'PROMOTER_LEADERBOARD_HIDDEN' : 'PROMOTER_LEADERBOARD_UNHIDDEN',
      entityType: 'user_profile',
      entityId: profile.id,
      metadata: { targetUserId: userId, reason: reason || null, until: until || null },
    });
    res.json({
      success: true,
      profile: {
        userId: profile.userId,
        leaderboardHidden: profile.leaderboardHidden,
        leaderboardHiddenReason: profile.leaderboardHiddenReason,
        leaderboardHiddenUntil: profile.leaderboardHiddenUntil,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Verification Queue (Business/Venue Compliance) ─────────────────────────

router.get('/verification/venues', async (req, res, next) => {
  try {
    const { status = 'pending', limit = 50, offset = 0 } = req.query;
    const where = { deletedAt: null };
    if (status) where.complianceStatus = String(status);

    const venues = await prisma.venue.findMany({
      where,
      include: { owner: { select: { id: true, email: true, fullName: true } } },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
    });
    const total = await prisma.venue.count({ where });
    res.json({ venues, total });
  } catch (err) {
    next(err);
  }
});

// ── Venue Moderation ──────────────────────────────────────────────────────

router.patch('/venues/:id/compliance', async (req, res, next) => {
  try {
    const { status, note } = z.object({
      status: z.enum(['approved', 'rejected', 'pending']),
      note: z.string().max(500).optional().nullable(),
    }).parse(req.body);

    const venue = await prisma.venue.update({
      where: { id: req.params.id },
      data: {
        complianceStatus: status,
        complianceRejectionNote: status === 'rejected' ? (note || null) : null,
        ...(status === 'approved' ? { isVerified: true } : {}),
      },
    });

    await auditFromReq(req, {
      userId: req.userId,
      action: 'VENUE_COMPLIANCE_UPDATED',
      entityType: 'venue',
      entityId: venue.id,
      metadata: { venueName: venue.name, status, note },
    });

    res.json({ success: true, venue: { id: venue.id, complianceStatus: venue.complianceStatus } });
  } catch (err) {
    next(err);
  }
});

// ── Admin Dashboard Delegates (Super Admin managed) ────────────────────────

router.get('/delegates', requireSuperAdmin, async (req, res, next) => {
  try {
    const delegates = await prisma.adminDashboardDelegate.findMany({
      orderBy: { addedAt: 'desc' },
    });
    res.json({ delegates });
  } catch (err) {
    next(err);
  }
});

router.post('/delegates', requireSuperAdmin, async (req, res, next) => {
  try {
    const { email, name } = z.object({
      email: z.string().email(),
      name: z.string().min(1).max(200),
    }).parse(req.body);

    const created = await prisma.adminDashboardDelegate.create({
      data: {
        email: normalizeEmail(email),
        name: name.trim(),
        isActive: true,
        addedByUserId: req.userId,
      },
    });

    await auditFromReq(req, {
      userId: req.userId,
      action: 'ADMIN_DASHBOARD_DELEGATE_CREATED',
      entityType: 'admin_dashboard_delegate',
      entityId: created.id,
      metadata: { delegateEmail: created.email, delegateName: created.name },
    });

    res.status(201).json({ delegate: created });
  } catch (err) {
    next(err);
  }
});

router.patch('/delegates/:delegateId', requireSuperAdmin, async (req, res, next) => {
  try {
    const { delegateId } = z.object({ delegateId: z.string().min(1) }).parse(req.params);
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);

    const updated = await prisma.adminDashboardDelegate.update({
      where: { id: delegateId },
      data: { isActive },
    });

    await auditFromReq(req, {
      userId: req.userId,
      action: isActive ? 'ADMIN_DASHBOARD_DELEGATE_REACTIVATED' : 'ADMIN_DASHBOARD_DELEGATE_DEACTIVATED',
      entityType: 'admin_dashboard_delegate',
      entityId: updated.id,
      metadata: { delegateEmail: updated.email, delegateName: updated.name, isActive },
    });

    res.json({ delegate: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/delegates/:delegateId', requireSuperAdmin, async (req, res, next) => {
  try {
    const { delegateId } = z.object({ delegateId: z.string().min(1) }).parse(req.params);

    const existing = await prisma.adminDashboardDelegate.findUnique({ where: { id: delegateId } });
    if (!existing) return res.status(404).json({ error: 'Delegate not found' });

    await prisma.adminDashboardDelegate.delete({ where: { id: delegateId } });

    await auditFromReq(req, {
      userId: req.userId,
      action: 'ADMIN_DASHBOARD_DELEGATE_DELETED',
      entityType: 'admin_dashboard_delegate',
      entityId: delegateId,
      metadata: { delegateEmail: existing.email, delegateName: existing.name },
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ── Dashboard Summary ─────────────────────────────────────────────────────

router.get('/dashboard', async (req, res, next) => {
  try {
    const dashboardQueries = [
      { name: 'totalUsers', run: () => prisma.user.count({ where: { deletedAt: null } }), fallback: 0 },
      { name: 'suspendedUsers', run: () => prisma.user.count({ where: { suspendedAt: { not: null }, deletedAt: null } }), fallback: 0 },
      { name: 'pendingReports', run: () => prisma.report.count({ where: { status: 'pending' } }), fallback: 0 },
      { name: 'criticalReports', run: () => prisma.report.count({ where: { status: 'pending', priority: 'critical' } }), fallback: 0 },
      { name: 'highReports', run: () => prisma.report.count({ where: { status: 'pending', priority: 'high' } }), fallback: 0 },
      { name: 'totalVenues', run: () => prisma.venue.count({ where: { deletedAt: null } }), fallback: 0 },
      { name: 'pendingVenues', run: () => prisma.venue.count({ where: { complianceStatus: 'pending', deletedAt: null } }), fallback: 0 },
      {
        name: 'pendingUserVerifications',
        run: () =>
          prisma.userProfile.count({
            where: {
              AND: [
                { NOT: { verificationStatus: { in: ['verified', 'approved', 'rejected'] } } },
                {
                  OR: [
                    { verificationStatus: 'submitted' },
                    { AND: [{ verificationStatus: 'pending' }, { idDocumentUrl: { not: null } }] },
                  ],
                },
              ],
            },
          }),
        fallback: 0,
      },
      {
        name: 'moneyRevenue',
        run: () => computeMoneyRevenue(undefined),
        fallback: {
          totalGrossZar: 0,
          totalSecRevenueZar: 0,
          totalRecipientShareZar: 0,
          pendingTransfersZar: 0,
          pendingTransfersCount: 0,
          pendingTransfers: 0,
          paymentCount: 0,
        },
      },
      {
        name: 'recentAuditLogs',
        run: () =>
          prisma.auditLog.findMany({
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: { user: { select: { email: true } } },
          }),
        fallback: [],
      },
    ];

    const settled = await Promise.allSettled(dashboardQueries.map((q) => q.run()));
    const values = settled.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      logger.warn('admin dashboard query failed', {
        query: dashboardQueries[i].name,
        err: String(result.reason?.message || result.reason),
      });
      return dashboardQueries[i].fallback;
    });

    const [
      totalUsers,
      suspendedUsers,
      pendingReports,
      criticalReports,
      highReports,
      totalVenues,
      pendingVenues,
      pendingUserVerifications,
      moneyRevenue,
      recentAuditLogs,
    ] = values;

    res.json({
      stats: {
        totalUsers,
        suspendedUsers,
        pendingReports,
        totalVenues,
        pendingVenues,
        criticalReports,
        highReports,
        pendingUserVerifications,
        totalPaymentAmount: moneyRevenue.totalGrossZar ?? 0,
        totalPaymentCount: moneyRevenue.paymentCount ?? 0,
        totalGrossZar: moneyRevenue.totalGrossZar ?? 0,
        totalSecRevenueZar: moneyRevenue.totalSecRevenueZar ?? 0,
        totalRecipientShareZar: moneyRevenue.totalRecipientShareZar ?? 0,
        pendingTransfersZar: moneyRevenue.pendingTransfersZar ?? 0,
        pendingTransfersCount: moneyRevenue.pendingTransfersCount ?? 0,
        pendingTransfers: moneyRevenue.pendingTransfersZar ?? 0,
      },
      recentActivity: recentAuditLogs,
    });
  } catch (err) {
    next(err);
  }
});

// ── Platform announcements (home feed) ───────────────────────────────────

const announcementSchema = z.object({
  title: z.string().min(1).max(100),
  message: z.string().min(10).max(600),
  ctaUrl: z
    .string()
    .max(2000)
    .optional()
    .nullable()
    .refine((v) => v == null || v === '' || /^https?:\/\//i.test(v) || v.startsWith('/'), {
      message: 'Invalid URL',
    }),
  ctaLabel: z.string().max(40).optional().nullable(),
});

router.get('/announcements', async (req, res, next) => {
  try {
    const rows = await prisma.platformAnnouncement.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        createdBy: { select: { id: true, username: true, fullName: true } },
        removedBy: { select: { id: true, username: true, fullName: true } },
      },
    });
    res.json({
      announcements: rows.map((r) => ({
        id: r.id,
        title: r.title,
        message: r.message,
        ctaUrl: r.ctaUrl,
        ctaLabel: r.ctaLabel,
        isActive: r.isActive,
        createdAt: r.createdAt.toISOString(),
        removedAt: r.removedAt?.toISOString() ?? null,
        createdBy: r.createdBy
          ? { id: r.createdBy.id, username: r.createdBy.username, fullName: r.createdBy.fullName }
          : null,
        removedBy: r.removedBy
          ? { id: r.removedBy.id, username: r.removedBy.username, fullName: r.removedBy.fullName }
          : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/announcements', async (req, res, next) => {
  try {
    const parsed = announcementSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;
    const row = await prisma.platformAnnouncement.create({
      data: {
        title: d.title.trim(),
        message: d.message.trim(),
        ctaUrl: d.ctaUrl?.trim() || null,
        ctaLabel: d.ctaLabel?.trim() || null,
        createdById: req.userId,
        isActive: true,
      },
    });
    await auditFromReq(req, {
      userId: req.userId,
      action: 'PLATFORM_ANNOUNCEMENT_CREATED',
      entityType: 'platform_announcement',
      entityId: row.id,
      metadata: { title: row.title },
    });
    void notifyAllUsersPlatformAnnouncement(row, req.userId);
    res.status(201).json({
      id: row.id,
      title: row.title,
      message: row.message,
      ctaUrl: row.ctaUrl,
      ctaLabel: row.ctaLabel,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/announcements/:id/permanent', async (req, res, next) => {
  try {
    const existing = await prisma.platformAnnouncement.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Announcement not found' });
    if (existing.isActive) {
      return res.status(400).json({ error: 'Remove the announcement from the home feed before deleting permanently.' });
    }
    await prisma.platformAnnouncement.delete({ where: { id: req.params.id } });
    await auditFromReq(req, {
      userId: req.userId,
      action: 'PLATFORM_ANNOUNCEMENT_PURGED',
      entityType: 'platform_announcement',
      entityId: req.params.id,
      metadata: { title: existing.title },
    });
    res.json({ ok: true, purged: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/announcements/:id', async (req, res, next) => {
  try {
    const existing = await prisma.platformAnnouncement.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Announcement not found' });
    if (!existing.isActive) {
      return res.json({ ok: true, alreadyRemoved: true });
    }
    await prisma.platformAnnouncement.update({
      where: { id: req.params.id },
      data: {
        isActive: false,
        removedAt: new Date(),
        removedById: req.userId,
      },
    });
    await auditFromReq(req, {
      userId: req.userId,
      action: 'PLATFORM_ANNOUNCEMENT_REMOVED',
      entityType: 'platform_announcement',
      entityId: req.params.id,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
