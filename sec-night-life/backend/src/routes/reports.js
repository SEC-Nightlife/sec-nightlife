import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { notifyAdmins } from '../lib/adminNotify.js';

const router = Router();
const REPORT_WINDOW_MS = 12 * 60 * 60 * 1000;

const createReportSchema = z.object({
  target_type: z.enum(['user', 'venue', 'event', 'vendor']),
  target_id: z.string().uuid(),
  category: z.enum([
    'fraud',
    'fake_event',
    'gbv_or_harassment',
    'scam_or_payment_issue',
    'impersonation',
    'hate_or_abuse',
    'other',
  ]),
  reason: z.string().min(3).max(180),
  details: z.string().max(2000).optional(),
  evidenceUrls: z.array(z.string().url()).max(5).optional(),
});

function derivePriority(category) {
  if (category === 'gbv_or_harassment') return 'critical';
  if (category === 'fake_event' || category === 'fraud' || category === 'impersonation') return 'high';
  if (category === 'scam_or_payment_issue' || category === 'hate_or_abuse') return 'medium';
  return 'low';
}

router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const parsed = createReportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const d = parsed.data;

    if (d.target_type === 'user' && d.target_id === req.userId) {
      return res.status(400).json({ error: 'You cannot report your own account' });
    }
    if (d.target_type === 'vendor') {
      const vendor = await prisma.vendorBusiness.findFirst({
        where: { id: d.target_id, deletedAt: null },
        select: { userId: true },
      });
      if (!vendor) return res.status(404).json({ error: 'Vendor listing not found' });
      if (vendor.userId === req.userId) {
        return res.status(400).json({ error: 'You cannot report your own listing' });
      }
    }

    const duplicate = await prisma.report.findFirst({
      where: {
        reporterId: req.userId,
        targetType: d.target_type,
        targetId: d.target_id,
        category: d.category,
        createdAt: { gte: new Date(Date.now() - REPORT_WINDOW_MS) },
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    if (duplicate) {
      return res.status(409).json({
        error: 'A similar report was recently submitted. Please wait for admin review.',
        recentReportId: duplicate.id,
      });
    }

    await prisma.report.create({
      data: {
        reporterId: req.userId,
        targetType: d.target_type,
        targetId: d.target_id,
        category: d.category,
        priority: derivePriority(d.category),
        reason: d.reason,
        details: d.details,
        evidenceUrls: d.evidenceUrls ?? undefined,
      },
    });

    notifyAdmins({
      subject: 'New safety report submitted',
      body: `A new ${d.category.replace(/_/g, ' ')} report was submitted (${d.target_type}).\n\nReason: ${d.reason}`,
      dashboardTab: 'reports',
      ctaLabel: 'Review reports',
    }).catch(() => {});

    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.get('/mine', authenticateToken, async (req, res, next) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    const where = { reporterId: req.userId };
    if (status) where.status = String(status);

    const reports = await prisma.report.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit) || 20, 100),
      skip: parseInt(offset) || 0,
    });
    const total = await prisma.report.count({ where });
    res.json({ reports, total });
  } catch (err) {
    next(err);
  }
});

router.get('/', authenticateToken, requireRole('ADMIN', 'MODERATOR', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { status = 'pending', category, priority, targetType, limit = 50, offset = 0 } = req.query;
    const where = { status: String(status) };
    if (category) where.category = String(category);
    if (priority) where.priority = String(priority);
    if (targetType) where.targetType = String(targetType);

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

export default router;
