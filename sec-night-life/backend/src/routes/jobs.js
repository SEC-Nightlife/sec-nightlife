import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { sendEmail } from '../lib/email.js';
import { notifyAdmins } from '../lib/adminNotify.js';
import { logger } from '../lib/logger.js';
import { normalizeCountryCode } from '../lib/timezone.js';
import { resolveFeedScope, scopeWhere } from '../lib/feedScope.js';
import { signCloudinaryUrl, privateDownloadUrl } from '../lib/cloudinarySignedUrl.js';
import { welcomePromoterThread, promoterVenueThreadPath } from '../lib/promoterVenueThread.js';
import {
  resolveStaffVenueContext,
  staffHasVenuePermission,
  resolveBusinessVenueScope,
  staffCtxFromQuery,
  venueIdFromQuery,
} from '../lib/access.js';
import { formatReplyPreview, validateReplyInThread } from '../lib/messageReply.js';

const router = Router();
const USER_HOURLY_LIMIT = 5;
const HOUR_MS = 60 * 60 * 1000;

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
  venueId: z.string().min(1).optional(),
  positionRole: z.enum(['PROMOTER', 'VENUE_STAFF']).default('VENUE_STAFF'),
});

const optionalUrlField = z.preprocess(
  (v) => (v === '' || v == null || v === undefined ? null : String(v).trim()),
  z.union([z.string().url(), z.null()]).optional(),
);

const applicationSchema = z.object({
  coverMessage: z.string().trim().min(50).max(1000),
  cvUrl: optionalUrlField,
  cvFileName: z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim()),
    z.string().max(255).nullable().optional(),
  ),
  portfolioUrl: optionalUrlField,
});

const messageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  replyToMessageId: z.string().optional(),
});

/** Who may submit a new job application (not listing own apps — that is always self-scoped). */
async function canApplyToJobs(userId, role) {
  if (['USER', 'FREELANCER', 'VENUE'].includes(role)) return true;
  const accountRole = await prisma.accountRole.findFirst({
    where: { userId, roleType: 'partygoer' },
    select: { id: true },
  });
  return !!accountRole;
}

async function getVenueOwnedByUser(venueId, userId) {
  const ok = await staffHasVenuePermission(userId, venueId, 'jobs');
  if (!ok) return null;
  return prisma.venue.findFirst({
    where: { id: venueId, deletedAt: null },
    select: { id: true, name: true, owner: { select: { id: true, email: true, fullName: true } } },
  });
}

async function getOwnedJob(jobId, userId) {
  const job = await prisma.jobPosting.findFirst({
    where: { id: jobId, venue: { deletedAt: null } },
    include: {
      venue: { select: { id: true, name: true, city: true, venueType: true, ownerUserId: true, owner: { select: { email: true, fullName: true } } } },
    },
  });
  if (!job) return null;
  const ok = await staffHasVenuePermission(userId, job.venueId, 'jobs');
  return ok ? job : null;
}

async function getApplicationForBusinessUser(applicationId, userId, include = {}) {
  const application = await prisma.jobApplication.findFirst({
    where: { id: applicationId },
    include,
  });
  if (!application?.jobPosting) return null;
  const ok = await staffHasVenuePermission(userId, application.jobPosting.venueId, 'jobs');
  return ok ? application : null;
}

function publicJobWhere(query = {}, feed = null) {
  const where = {
    status: 'OPEN',
    deletedAt: null,
    OR: [{ closingDate: null }, { closingDate: { gt: new Date() } }],
  };
  const venueId = query.venueId || query.venue_id;
  if (venueId) where.venueId = String(venueId);
  const venueWhere = {};
  if (query.city) venueWhere.city = { equals: String(query.city), mode: 'insensitive' };
  const countryCode = normalizeCountryCode(query.country_code || query.country);
  if (countryCode) venueWhere.countryCode = countryCode;
  if (feed && !venueId) {
    const scoped = scopeWhere(feed);
    if (scoped.city && venueWhere.city) delete scoped.city;
    Object.assign(venueWhere, scoped);
  }
  if (Object.keys(venueWhere).length) where.venue = { ...venueWhere, deletedAt: null };
  if (query.jobType) where.jobType = query.jobType;
  if (query.compensationType) where.compensationType = query.compensationType;
  return where;
}

async function createJobNotification({ userId, type, title, body, actionUrl, venueId = null }) {
  if (!userId) return;
  try {
    await prisma.notification.create({
      data: {
        userId,
        venueId,
        type,
        title,
        body: body ?? null,
        actionUrl: actionUrl ?? null,
      },
    });
  } catch (e) {
    logger.warn('job notification create failed', { err: e?.message });
  }
}

function formatCompensation(job) {
  if (job.compensationType === 'UNPAID_TRIAL') return 'Unpaid trial';
  if (job.compensationType === 'NEGOTIABLE') return 'Negotiable';
  if (job.compensationPer === 'COMMISSION') return 'Commission based';
  const amount = job.compensationAmount ? Number(job.compensationAmount).toFixed(0) : '0';
  const per = job.compensationPer?.toLowerCase() || 'month';
  return `R${amount} per ${per}`;
}

function myApplicationThreadPath(applicationId, jobPostingId) {
  return `/MyJobApplications?applicationId=${applicationId}&jobId=${jobPostingId}`;
}

function ownerJobDetailsPath(jobPostingId) {
  return `/JobDetails?id=${jobPostingId}`;
}

function ownerBusinessMessagesPath(applicationId, hired = false, isPromoterRole = false, promoterVenueThreadId = null) {
  if (hired && isPromoterRole && promoterVenueThreadId) {
    return `/BusinessMessages?tab=promoters&promoterVenue=${promoterVenueThreadId}`;
  }
  const tab = hired && isPromoterRole ? 'promoters' : 'jobs';
  return `/BusinessMessages?tab=${tab}&application=${applicationId}`;
}

function isPromoterJobPosting(jobPosting) {
  return jobPosting?.positionRole === 'PROMOTER';
}

function applicantMayMessage(status) {
  return status === 'SHORTLISTED' || status === 'HIRED';
}

async function notifyApplicantRejected({ applicant, jobTitle, venueName, applicationId, jobPostingId }) {
  if (applicant?.email) {
    await sendEmail({
      to: applicant.email,
      subject: `Update on your ${jobTitle} application`,
      text: `Unfortunately, your application for ${jobTitle} at ${venueName} was not selected. Thank you for applying.`,
    }).catch(() => {});
  }
  await createJobNotification({
    userId: applicant?.id,
    type: 'job_application',
    title: 'Application update',
    body: `Unfortunately, your application for ${jobTitle} at ${venueName} was not selected.`,
    actionUrl: myApplicationThreadPath(applicationId, jobPostingId),
  });
}

async function notifyApplicantReleased({ applicant, jobTitle, venueName, applicationId, jobPostingId }) {
  if (applicant?.email) {
    await sendEmail({
      to: applicant.email,
      subject: `Staff update — ${jobTitle}`,
      text: `You have been removed from the ${jobTitle} staff team at ${venueName}.`,
    }).catch(() => {});
  }
  await createJobNotification({
    userId: applicant?.id,
    type: 'job_application',
    title: 'Removed from staff',
    body: `You have been removed from the ${jobTitle} staff team at ${venueName}.`,
    actionUrl: myApplicationThreadPath(applicationId, jobPostingId),
  });
}

router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const parsed = postingSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const payload = parsed.data;
    if ((payload.compensationType === 'FIXED' || payload.compensationType === 'NEGOTIABLE') && !payload.compensationPer) {
      return res.status(400).json({ error: 'compensationPer is required for fixed or negotiable compensation' });
    }

    const staffCtx = staffCtxFromQuery(req.query);
    let venueId = payload.venueId;
    if (staffCtx) {
      const scope = await resolveBusinessVenueScope(req.userId, {
        staffCtx,
        permission: 'jobs',
      });
      if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
      venueId = scope.venueIds[0];
    }
    if (!venueId) return res.status(400).json({ error: 'venueId or staff_ctx is required' });

    const venue = await getVenueOwnedByUser(venueId, req.userId);
    if (!venue) return res.status(403).json({ error: 'Forbidden' });

    const created = await prisma.jobPosting.create({
      data: {
        venueId,
        title: payload.title,
        description: payload.description,
        requirements: payload.requirements,
        jobType: payload.jobType,
        compensationType: payload.compensationType,
        compensationAmount: payload.compensationAmount ?? null,
        compensationPer: payload.compensationPer || 'MONTH',
        currency: payload.currency,
        totalSpots: payload.totalSpots,
        filledSpots: 0,
        positionRole: payload.positionRole,
        closingDate: payload.closingDate ?? null,
        status: 'OPEN',
      },
    });
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
});

router.get('/by-venue', authenticateToken, async (req, res, next) => {
  try {
    const scope = await resolveBusinessVenueScope(req.userId, {
      staffCtx: staffCtxFromQuery(req.query),
      venueIdFilter: venueIdFromQuery(req.query),
      permission: 'jobs',
    });
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const venueIds = scope.venueIds || [];
    if (!venueIds.length) return res.json([]);
    const jobs = await prisma.jobPosting.findMany({
      where: { venueId: { in: venueIds }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        venue: { select: { id: true, name: true, city: true } },
        _count: { select: { applications: true, messages: true } },
      },
    });
    return res.json(jobs);
  } catch (err) {
    return next(err);
  }
});

router.get('/hired-staff', authenticateToken, async (req, res, next) => {
  try {
    const scope = await resolveBusinessVenueScope(req.userId, {
      staffCtx: staffCtxFromQuery(req.query),
      venueIdFilter: venueIdFromQuery(req.query),
      permission: 'jobs',
    });
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const venueIds = scope.venueIds || [];
    if (!venueIds.length) return res.json([]);

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const hiredApps = await prisma.jobApplication.findMany({
      where: {
        status: 'HIRED',
        jobPosting: { venueId: { in: venueIds } },
        ...(q
          ? {
              OR: [
                { applicant: { fullName: { contains: q, mode: 'insensitive' } } },
                { applicant: { username: { contains: q, mode: 'insensitive' } } },
                { applicant: { userProfile: { username: { contains: q, mode: 'insensitive' } } } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        applicant: {
          select: {
            id: true,
            fullName: true,
            email: true,
            username: true,
            userProfile: { select: { username: true, avatarUrl: true } },
          },
        },
        jobPosting: {
          select: {
            id: true,
            title: true,
            jobType: true,
            positionRole: true,
            status: true,
            deletedAt: true,
            filledSpots: true,
            totalSpots: true,
            venueId: true,
            venue: { select: { id: true, name: true, city: true } },
          },
        },
      },
    });

    const byJob = new Map();
    for (const app of hiredApps) {
      const job = app.jobPosting;
      if (!byJob.has(job.id)) {
        byJob.set(job.id, {
          job: {
            id: job.id,
            title: job.title,
            jobType: job.jobType,
            positionRole: job.positionRole,
            status: job.status,
            deletedAt: job.deletedAt,
            filledSpots: job.filledSpots,
            totalSpots: job.totalSpots,
            venue: job.venue,
          },
          hired: [],
        });
      }
      byJob.get(job.id).hired.push({
        id: app.id,
        status: app.status,
        appliedAt: app.appliedAt,
        updatedAt: app.updatedAt,
        completedAt: app.completedAt,
        coverMessage: app.coverMessage,
        applicant: {
          id: app.applicant.id,
          fullName: app.applicant.fullName,
          email: app.applicant.email,
          username: app.applicant.userProfile?.username || app.applicant.username || null,
          avatarUrl: app.applicant.userProfile?.avatarUrl || null,
        },
      });
    }
    return res.json([...byJob.values()]);
  } catch (err) {
    return next(err);
  }
});

router.get('/venue/:venueId', authenticateToken, async (req, res, next) => {
  try {
    const venue = await getVenueOwnedByUser(req.params.venueId, req.userId);
    if (!venue) return res.status(403).json({ error: 'Forbidden' });
    const jobs = await prisma.jobPosting.findMany({
      where: { venueId: req.params.venueId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        venue: { select: { id: true, name: true, city: true } },
        _count: { select: { applications: true, messages: true } },
      },
    });
    return res.json(jobs);
  } catch (err) {
    return next(err);
  }
});

router.get('/filter', optionalAuth, async (req, res, next) => {
  try {
    const jobs = await prisma.jobPosting.findMany({
      where: publicJobWhere(req.query, await resolveFeedScope(req)),
      orderBy: { createdAt: 'desc' },
      include: { venue: { select: { id: true, name: true, city: true, venueType: true } } },
    });
    return res.json(
      jobs.map((job) => ({
        id: job.id,
        venue: job.venue,
        title: job.title,
        jobType: job.jobType,
        compensationType: job.compensationType,
        compensationAmount: job.compensationAmount,
        compensationPer: job.compensationPer,
        currency: job.currency,
        compensationLabel: formatCompensation(job),
        description: job.description,
        requirements: job.requirements,
        totalSpots: job.totalSpots,
        filledSpots: job.filledSpots,
        closingDate: job.closingDate,
        createdAt: job.createdAt,
        status: job.status,
      })),
    );
  } catch (err) {
    return next(err);
  }
});

router.get('/public', optionalAuth, async (req, res, next) => {
  try {
    const jobs = await prisma.jobPosting.findMany({
      where: publicJobWhere(req.query, await resolveFeedScope(req)),
      orderBy: { createdAt: 'desc' },
      include: { venue: { select: { id: true, name: true, city: true, venueType: true } } },
    });
    return res.json(jobs.map((job) => ({
      id: job.id,
      venue: job.venue,
      title: job.title,
      jobType: job.jobType,
      compensationType: job.compensationType,
      compensationAmount: job.compensationAmount,
      compensationPer: job.compensationPer,
      currency: job.currency,
      compensationLabel: formatCompensation(job),
      description: job.description,
      requirements: job.requirements,
      totalSpots: job.totalSpots,
      filledSpots: job.filledSpots,
      closingDate: job.closingDate,
      createdAt: job.createdAt,
      status: job.status,
    })));
  } catch (err) {
    return next(err);
  }
});

router.get('/public/:jobId', optionalAuth, async (req, res, next) => {
  try {
    const job = await prisma.jobPosting.findFirst({
      where: { id: req.params.jobId, ...publicJobWhere({}) },
      include: { venue: { select: { id: true, name: true, city: true, venueType: true } } },
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json({
      id: job.id,
      venue: job.venue,
      title: job.title,
      jobType: job.jobType,
      compensationType: job.compensationType,
      compensationAmount: job.compensationAmount,
      compensationPer: job.compensationPer,
      currency: job.currency,
      compensationLabel: formatCompensation(job),
      description: job.description,
      requirements: job.requirements,
      totalSpots: job.totalSpots,
      filledSpots: job.filledSpots,
      closingDate: job.closingDate,
      createdAt: job.createdAt,
      status: job.status,
    });
  } catch (err) {
    return next(err);
  }
});

// Must be registered before GET /:jobId or "my-applications" is captured as jobId (403).
router.get('/my-applications', authenticateToken, async (req, res, next) => {
  try {
    const apps = await prisma.jobApplication.findMany({
      where: { applicantUserId: req.userId },
      orderBy: { appliedAt: 'desc' },
      include: {
        jobPosting: { include: { venue: { select: { name: true } } } },
      },
    });
    const data = await Promise.all(apps.map(async (app) => {
      const unread = await prisma.jobMessage.count({
        where: { applicationId: app.id, readAt: null, senderUserId: { not: req.userId } },
      });
      return {
        id: app.id,
        jobPostingId: app.jobPostingId,
        jobTitle: app.jobPosting.title,
        venueName: app.jobPosting.venue.name,
        status: app.status,
        appliedAt: app.appliedAt,
        unreadCount: unread,
      };
    }));
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.get('/:jobId', authenticateToken, async (req, res, next) => {
  try {
    if (req.params.jobId === 'public') return next();
    const owned = await getOwnedJob(req.params.jobId, req.userId);
    if (!owned) return res.status(403).json({ error: 'Forbidden' });
    const job = await prisma.jobPosting.findFirst({
      where: { id: req.params.jobId, venue: { deletedAt: null } },
      include: {
        venue: { select: { id: true, name: true, city: true, venueType: true } },
        applications: {
          orderBy: { appliedAt: 'desc' },
          select: {
            id: true, coverMessage: true, cvUrl: true, cvFileName: true, portfolioUrl: true, status: true, appliedAt: true,
            applicant: {
              select: {
                id: true,
                email: true,
                fullName: true,
                userProfile: {
                  select: { username: true, avatarUrl: true, isVerifiedPromoter: true },
                },
              },
            },
          },
        },
      },
    });
    if (!job) return res.status(403).json({ error: 'Forbidden' });
    return res.json(job);
  } catch (err) {
    return next(err);
  }
});

router.patch('/:jobId', authenticateToken, async (req, res, next) => {
  try {
    const ownedJob = await getOwnedJob(req.params.jobId, req.userId);
    if (!ownedJob) return res.status(403).json({ error: 'Forbidden' });
    const schema = postingSchema.partial().omit({ venueId: true }).extend({ status: z.enum(['OPEN', 'CLOSED', 'FILLED']).optional() });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const updated = await prisma.jobPosting.update({
      where: { id: req.params.jobId },
      data: parsed.data,
    });
    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

router.delete('/:jobId', authenticateToken, async (req, res, next) => {
  try {
    const ownedJob = await getOwnedJob(req.params.jobId, req.userId);
    if (!ownedJob) return res.status(403).json({ error: 'Forbidden' });
    if (ownedJob.deletedAt) {
      return res.json({ deleted: true, applicationCount: 0, alreadyDeleted: true });
    }

    const toReject = await prisma.jobApplication.findMany({
      where: {
        jobPostingId: ownedJob.id,
        status: { in: ['PENDING', 'SHORTLISTED'] },
      },
      include: {
        applicant: { select: { id: true, email: true, fullName: true } },
      },
    });

    const applicationCount = await prisma.jobApplication.count({
      where: { jobPostingId: ownedJob.id },
    });

    await prisma.$transaction(async (tx) => {
      if (toReject.length) {
        await tx.jobApplication.updateMany({
          where: {
            jobPostingId: ownedJob.id,
            status: { in: ['PENDING', 'SHORTLISTED'] },
          },
          data: { status: 'REJECTED' },
        });
      }
      await tx.jobPosting.update({
        where: { id: ownedJob.id },
        data: { deletedAt: new Date(), status: 'CLOSED' },
      });
    });

    const jobTitle = ownedJob.title;
    const venueName = ownedJob.venue?.name || 'the venue';
    await Promise.all(
      toReject.map((app) =>
        notifyApplicantRejected({
          applicant: app.applicant,
          jobTitle,
          venueName,
          applicationId: app.id,
          jobPostingId: ownedJob.id,
        }),
      ),
    );

    return res.json({
      deleted: true,
      softDeleted: true,
      applicationCount,
      rejectedCount: toReject.length,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/applications/:applicationId/unhire', authenticateToken, async (req, res, next) => {
  try {
    const application = await getApplicationForBusinessUser(req.params.applicationId, req.userId, {
      applicant: { select: { id: true, email: true, fullName: true } },
      jobPosting: {
        include: {
          venue: { select: { id: true, name: true, ownerUserId: true } },
        },
      },
    });
    if (!application) return res.status(403).json({ error: 'Forbidden' });
    if (application.status !== 'HIRED') {
      return res.status(400).json({ error: 'Only hired applicants can be removed from staff.' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.jobApplication.update({
        where: { id: application.id },
        data: { status: 'RELEASED' },
      });
      const posting = await tx.jobPosting.findUnique({
        where: { id: application.jobPostingId },
        select: { filledSpots: true },
      });
      const nextFilled = Math.max(0, (posting?.filledSpots || 0) - 1);
      await tx.jobPosting.update({
        where: { id: application.jobPostingId },
        data: {
          filledSpots: nextFilled,
          ...(application.jobPosting.status === 'FILLED' && nextFilled < application.jobPosting.totalSpots
            ? { status: 'CLOSED' }
            : {}),
        },
      });
      if (isPromoterJobPosting(application.jobPosting)) {
        await tx.venuePromoter.updateMany({
          where: {
            venueId: application.jobPosting.venueId,
            promoterUserId: application.applicant.id,
            status: 'ACTIVE',
          },
          data: { status: 'RELEASED' },
        });
      }
      return row;
    });

    await notifyApplicantReleased({
      applicant: application.applicant,
      jobTitle: application.jobPosting.title,
      venueName: application.jobPosting.venue.name,
      applicationId: application.id,
      jobPostingId: application.jobPostingId,
    });

    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

router.get('/:jobId/applications', authenticateToken, async (req, res, next) => {
  try {
    const ownedJob = await getOwnedJob(req.params.jobId, req.userId);
    if (!ownedJob) return res.status(403).json({ error: 'Forbidden' });
    const applications = await prisma.jobApplication.findMany({
      where: { jobPostingId: req.params.jobId },
      orderBy: { appliedAt: 'desc' },
      include: {
        applicant: {
          select: {
            id: true,
            fullName: true,
            email: true,
            username: true,
            userProfile: { select: { username: true, avatarUrl: true } },
          },
        },
      },
    });
    return res.json(
      applications.map((app) => ({
        ...app,
        applicant: {
          id: app.applicant.id,
          fullName: app.applicant.fullName,
          email: app.applicant.email,
          username: app.applicant.userProfile?.username || app.applicant.username || null,
          avatarUrl: app.applicant.userProfile?.avatarUrl || null,
        },
      })),
    );
  } catch (err) {
    return next(err);
  }
});

router.patch('/applications/:applicationId/status', authenticateToken, async (req, res, next) => {
  try {
    const schema = z.object({ status: z.enum(['SHORTLISTED', 'REJECTED', 'HIRED']) });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

    const application = await getApplicationForBusinessUser(req.params.applicationId, req.userId, {
      applicant: { select: { id: true, email: true, fullName: true } },
      jobPosting: { include: { venue: { include: { owner: { select: { email: true, fullName: true } } } } } },
    });
    if (!application) return res.status(403).json({ error: 'Forbidden' });

    const status = parsed.data.status;
    let becameFilled = false;
    let promoterReadyForVerification = false;
    const txResult = await prisma.$transaction(async (tx) => {
      const updated = await tx.jobApplication.update({
        where: { id: application.id },
        data: { status },
      });
      if (status === 'HIRED') {
        const posting = await tx.jobPosting.update({
          where: { id: application.jobPostingId },
          data: { filledSpots: { increment: 1 } },
        });
        if (isPromoterJobPosting(application.jobPosting)) {
          await tx.venuePromoter.upsert({
            where: {
              venueId_promoterUserId: {
                venueId: application.jobPosting.venueId,
                promoterUserId: application.applicant.id,
              },
            },
            create: {
              venueId: application.jobPosting.venueId,
              promoterUserId: application.applicant.id,
              jobApplicationId: application.id,
              status: 'ACTIVE',
            },
            update: {
              jobApplicationId: application.id,
              status: 'ACTIVE',
              hiredAt: new Date(),
            },
          });
          const profile = await tx.userProfile.findUnique({
            where: { userId: application.applicant.id },
            select: {
              promoterJobsAccepted: true,
              isPromoterStandard: true,
              isVerifiedPromoter: true,
              username: true,
            },
          });
          if (profile) {
            const nextCount = profile.promoterJobsAccepted + 1;
            const nextStandard = nextCount >= 20;
            await tx.userProfile.update({
              where: { userId: application.applicant.id },
              data: {
                promoterJobsAccepted: { increment: 1 },
                ...(nextStandard ? { isPromoterStandard: true } : {}),
              },
            });
            if (!profile.isPromoterStandard && nextStandard) {
              await createJobNotification({
                userId: application.applicant.id,
                type: 'job_application',
                title: "You've reached Promoter Standard!",
                body: "You've been hired for 20 venue promoter jobs.",
                actionUrl: '/Profile',
              });
              if (!profile.isVerifiedPromoter) {
                promoterReadyForVerification = {
                  name: application.applicant.fullName || profile.username || 'A promoter',
                };
              }
            }
          }
        }
        if (posting.filledSpots >= posting.totalSpots) {
          await tx.jobPosting.update({ where: { id: posting.id }, data: { status: 'FILLED' } });
          becameFilled = true;
        }
      }
      return updated;
    });

    if (promoterReadyForVerification) {
      notifyAdmins({
        subject: 'Promoter ready for admin verification',
        body: `${promoterReadyForVerification.name} reached Promoter Standard (20 hires) and is ready for admin verification.`,
        dashboardTab: 'promoters',
        ctaLabel: 'Review promoters',
      }).catch(() => {});
    }

    const jobTitle = application.jobPosting.title;
    const venueName = application.jobPosting.venue.name;
    if (application.applicant.email) {
      const subjects = {
        SHORTLISTED: `Great news — you've been shortlisted for ${jobTitle}`,
        REJECTED: `Update on your ${jobTitle} application`,
        HIRED: `Congratulations, you've been hired — ${jobTitle}`,
      };
      const messageText = {
        SHORTLISTED: `Great news! You have been shortlisted for ${jobTitle} at ${venueName}. Open the app to view details and messages.`,
        REJECTED: `Unfortunately, your application for ${jobTitle} at ${venueName} was not selected. Thank you for applying.`,
        HIRED: `Congratulations, you've been hired for ${jobTitle} at ${venueName}. Open the app for next steps and messages.`,
      };
      await sendEmail({
        to: application.applicant.email,
        subject: subjects[status],
        text: messageText[status] || `Your application status was updated. Open the app to view details.`,
      }).catch(() => {});
    }
    const statusTitles = {
      SHORTLISTED: "Great news, you're shortlisted",
      REJECTED: 'Application update',
      HIRED: "Congratulations, you've been hired",
    };
    const statusBodies = {
      SHORTLISTED: `Great news! You have been shortlisted for ${jobTitle} at ${venueName}.`,
      REJECTED: `Unfortunately, your application for ${jobTitle} at ${venueName} was not selected.`,
      HIRED: `Congratulations, you've been hired for ${jobTitle} at ${venueName}.`,
    };
    const isPromoterRole = isPromoterJobPosting(application.jobPosting);
    let promoterVenueThreadId = null;
    if (status === 'HIRED' && isPromoterRole) {
      const thread = await welcomePromoterThread({
        venueId: application.jobPosting.venueId,
        promoterUserId: application.applicant.id,
        venueName: venueName,
        jobApplicationId: application.id,
      });
      promoterVenueThreadId = thread.id;
    }
    const applicantThreadPath = status === 'HIRED' && isPromoterRole && promoterVenueThreadId
      ? promoterVenueThreadPath(promoterVenueThreadId)
      : myApplicationThreadPath(application.id, application.jobPostingId);
    const ownerThreadPath = status === 'HIRED'
      ? ownerBusinessMessagesPath(application.id, true, isPromoterRole, promoterVenueThreadId)
      : ownerBusinessMessagesPath(application.id, false, false);
    await createJobNotification({
      userId: application.applicant.id,
      type: 'job_application',
      title: statusTitles[status] || 'Application update',
      body: statusBodies[status] || `${jobTitle} at ${venueName}: your application was updated.`,
      actionUrl: applicantThreadPath,
    });
    if (status === 'HIRED' && isPromoterRole) {
      await createJobNotification({
        userId: application.applicant.id,
        type: 'job_application',
        title: 'Welcome to the Promoters team!',
        body: `Accept the Promoter Code of Conduct in Settings to qualify for the leaderboard. ${venueName} can assign you events to promote.`,
        actionUrl: '/Settings',
      });
      await createJobNotification({
        userId: application.jobPosting.venue.ownerUserId,
        type: 'job_application',
        title: 'Promoter hired',
        body: `${application.applicant.fullName || 'Your new promoter'} is ready in your Promoters inbox.`,
        actionUrl: ownerThreadPath,
      });
    }
    if (status === 'HIRED' && becameFilled) {
      // Notify owner
      await createJobNotification({
        userId: application.jobPosting.venue.ownerUserId,
        type: 'job_application',
        title: 'Job filled',
        body: `${jobTitle} at ${venueName} is now filled.`,
        actionUrl: `/BusinessJobs`,
      });

      // Notify other applicants (do not change their status automatically)
      const otherApplicants = await prisma.jobApplication.findMany({
        where: { jobPostingId: application.jobPostingId, applicantUserId: { not: application.applicant.id } },
        select: { applicantUserId: true },
      });
      const otherIds = [...new Set(otherApplicants.map((a) => a.applicantUserId).filter(Boolean))];
      await Promise.all(otherIds.map((uid) => createJobNotification({
        userId: uid,
        type: 'job_application',
        title: 'Position filled',
        body: `${jobTitle} at ${venueName} has been filled.`,
        actionUrl: `/MyJobApplications`,
      })));
    }
    if (status === 'HIRED' && application.jobPosting.venue.owner.email) {
      await sendEmail({
        to: application.jobPosting.venue.owner.email,
        subject: `Hire confirmed — ${jobTitle}`,
        text: `You marked ${application.applicant.fullName || 'an applicant'} as hired.`,
      }).catch(() => {});
    }
    return res.json(txResult);
  } catch (err) {
    return next(err);
  }
});

router.patch('/applications/:applicationId/complete', authenticateToken, async (req, res, next) => {
  try {
    const application = await getApplicationForBusinessUser(req.params.applicationId, req.userId, {
      jobPosting: { select: { id: true, title: true } },
      applicant: { select: { id: true } },
    });
    if (!application) return res.status(403).json({ error: 'Forbidden' });
    if (application.status !== 'HIRED') {
      return res.status(400).json({ error: 'Only hired applications can be marked complete.' });
    }
    const updated = await prisma.jobApplication.update({
      where: { id: application.id },
      data: { completedAt: new Date() },
      select: { id: true, completedAt: true, applicantUserId: true, jobPostingId: true },
    });
    return res.json({ success: true, application: updated });
  } catch (err) {
    return next(err);
  }
});

router.get('/applications/:applicationId/cv', authenticateToken, async (req, res, next) => {
  try {
    const application = await getApplicationForBusinessUser(req.params.applicationId, req.userId, {
      jobPosting: { select: { venueId: true } },
    });
    if (!application) return res.status(403).json({ error: 'Forbidden' });
    const cvRow = await prisma.jobApplication.findUnique({
      where: { id: application.id },
      select: { id: true, cvUrl: true, cvFileName: true },
    });
    logger.info('CV access attempt', { applicationId: req.params.applicationId, accessedBy: req.userId, accessedAt: new Date().toISOString() });
    const raw = cvRow?.cvUrl;
    const viewUrl = raw
      ? (privateDownloadUrl(raw) || signCloudinaryUrl(raw) || raw)
      : null;
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    return res.json({ cvUrl: raw, viewUrl, cvFileName: application.cvFileName });
  } catch (err) {
    return next(err);
  }
});

async function getApplicationWithAccess(applicationId, userId) {
  return prisma.jobApplication.findFirst({
    where: {
      id: applicationId,
      OR: [{ applicantUserId: userId }, { jobPosting: { venue: { ownerUserId: userId } } }],
    },
    include: {
      applicant: { select: { id: true, email: true, fullName: true } },
      jobPosting: { include: { venue: { include: { owner: { select: { id: true, email: true, fullName: true } } } } } },
    },
  });
}

router.get('/applications/:applicationId/messages', authenticateToken, async (req, res, next) => {
  try {
    const application = await getApplicationWithAccess(req.params.applicationId, req.userId);
    if (!application) return res.status(403).json({ error: 'Forbidden' });
    const senderIsOwner = application.jobPosting.venue.owner.id === req.userId;
    if (!senderIsOwner && !applicantMayMessage(application.status)) {
      return res.status(403).json({
        error:
          application.status === 'REJECTED'
            ? 'You cannot message this business while your application is rejected.'
            : 'You can message this venue after you are waitlisted or hired.',
      });
    }
    await prisma.jobMessage.updateMany({
      where: { applicationId: application.id, readAt: null, senderUserId: { not: req.userId } },
      data: { readAt: new Date() },
    });
    const messages = await prisma.jobMessage.findMany({
      where: { applicationId: application.id },
      orderBy: { sentAt: 'asc' },
      include: {
        sender: { select: { id: true, fullName: true, email: true } },
        replyTo: { select: { id: true, body: true, sentAt: true, senderUserId: true } },
      },
    });
    return res.json(
      messages.map((m) => ({
        ...m,
        replyTo: m.replyTo
          ? formatReplyPreview(m.replyTo, {
              bodyKey: 'body',
              labelKey: null,
            })
          : null,
      })),
    );
  } catch (err) {
    return next(err);
  }
});

router.post('/applications/:applicationId/messages', authenticateToken, async (req, res, next) => {
  try {
    const parsed = messageSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
    const application = await getApplicationWithAccess(req.params.applicationId, req.userId);
    if (!application) return res.status(403).json({ error: 'Forbidden' });
    const senderIsOwner = application.jobPosting.venue.owner.id === req.userId;
    if (!senderIsOwner && !applicantMayMessage(application.status)) {
      return res.status(403).json({
        error:
          application.status === 'REJECTED'
            ? 'You cannot message this business while your application is rejected.'
            : 'You can message this venue after you are waitlisted or hired.',
      });
    }
    const replyToMessageId = await validateReplyInThread(prisma, {
      model: 'jobMessage',
      threadField: 'applicationId',
      threadId: application.id,
      replyToMessageId: parsed.data.replyToMessageId,
    });
    const created = await prisma.jobMessage.create({
      data: {
        applicationId: application.id,
        jobPostingId: application.jobPostingId,
        senderUserId: req.userId,
        body: parsed.data.body,
        replyToMessageId,
      },
      include: { sender: { select: { id: true, fullName: true, email: true } } },
    });

    const recipient = senderIsOwner ? application.applicant : application.jobPosting.venue.owner;
    const recipientActionPath = senderIsOwner
      ? myApplicationThreadPath(application.id, application.jobPostingId)
      : ownerBusinessMessagesPath(
        application.id,
        application.status === 'HIRED',
        isPromoterJobPosting(application.jobPosting),
      );
    if (recipient?.email) {
      const appBase = (process.env.APP_URL || '').replace(/\/+$/, '');
      const appUrl = appBase ? `${appBase}${recipientActionPath}` : '';
      await sendEmail({
        to: recipient.email,
        subject: `New message regarding your application — ${application.jobPosting.title}`,
        text: `${created.sender.fullName || 'Someone'} sent you a message. Open the app to reply.${appUrl ? ` ${appUrl}` : ''}`,
      }).catch(() => {});
    }
    const recipientUserId = senderIsOwner ? application.applicant.id : application.jobPosting.venue.owner.id;
    const bodyText = parsed.data.body || '';
    const preview = bodyText.slice(0, 120);
    await createJobNotification({
      userId: recipientUserId,
      type: 'message',
      title: `Message: ${application.jobPosting.title}`,
      body: `${created.sender.fullName || 'Someone'}: ${preview}${bodyText.length > 120 ? '…' : ''}`,
      actionUrl: recipientActionPath,
    });
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
});

router.get('/applications/:applicationId/messages/unread-count', authenticateToken, async (req, res, next) => {
  try {
    const application = await getApplicationWithAccess(req.params.applicationId, req.userId);
    if (!application) return res.status(403).json({ error: 'Forbidden' });
    const count = await prisma.jobMessage.count({
      where: { applicationId: application.id, readAt: null, senderUserId: { not: req.userId } },
    });
    return res.json({ count });
  } catch (err) {
    return next(err);
  }
});

router.post('/:jobId/apply', authenticateToken, async (req, res, next) => {
  try {
    const canApply = await canApplyToJobs(req.userId, req.userRole);
    if (!canApply) return res.status(403).json({ error: 'Your account cannot apply to jobs' });
    const parsed = applicationSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const job = await prisma.jobPosting.findFirst({
      where: { id: req.params.jobId, status: 'OPEN', deletedAt: null },
      include: { venue: { select: { name: true, ownerUserId: true, owner: { select: { id: true, email: true } } } } },
    });
    if (!job) return res.status(404).json({ error: 'Job not found or closed' });
    if (job.closingDate && new Date(job.closingDate) <= new Date()) return res.status(400).json({ error: 'Applications are closed for this job' });

    const hourlyCount = await prisma.jobApplication.count({
      where: { applicantUserId: req.userId, appliedAt: { gte: new Date(Date.now() - HOUR_MS) } },
    });
    if (hourlyCount >= USER_HOURLY_LIMIT) return res.status(429).json({ error: 'Application rate limit exceeded. Try again later.' });

    const exists = await prisma.jobApplication.findUnique({
      where: { jobPostingId_applicantUserId: { jobPostingId: req.params.jobId, applicantUserId: req.userId } },
      select: { id: true },
    });
    if (exists) return res.status(409).json({ error: 'You have already applied for this position' });

    const created = await prisma.jobApplication.create({
      data: {
        jobPostingId: req.params.jobId,
        applicantUserId: req.userId,
        coverMessage: parsed.data.coverMessage,
        cvUrl: parsed.data.cvUrl ?? null,
        cvFileName: parsed.data.cvFileName ?? null,
        portfolioUrl: parsed.data.portfolioUrl ?? null,
        status: 'PENDING',
      },
    });

    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { fullName: true, email: true } });
    if (user?.email) {
      await sendEmail({
        to: user.email,
        subject: `Application received — ${job.title} at ${job.venue.name}`,
        text: 'Your application has been received. We will notify you of updates by email and in the app.',
      }).catch(() => {});
    }
    if (job.venue.owner.email) {
      await sendEmail({
        to: job.venue.owner.email,
        subject: `New application — ${job.title}`,
        text: `${user?.fullName || 'A user'} has applied. Review in your dashboard.`,
      }).catch(() => {});
    }
    await createJobNotification({
      userId: job.venue.ownerUserId,
      type: 'job_application',
      title: 'New job application',
      body: `${user?.fullName || 'Someone'} applied for ${job.title} at ${job.venue.name}.`,
      actionUrl: `/BusinessMessages?tab=jobs&application=${created.id}&venue_id=${job.venueId}`,
      venueId: job.venueId,
    });
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
});

export default router;
