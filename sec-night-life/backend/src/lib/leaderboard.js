import { prisma } from './prisma.js';
import { conversionScoreFromPoints, promoterConversionStats } from './promoterAttribution.js';

const POLICY = {
  minAcceptedJobs: 20,
  minRatings: 3,
  minUniqueRaters: 2,
  staleDays: 120,
  scoreWeights: { quality: 40, execution: 25, consistency: 15, conversions: 15, compliance: 5 },
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function confidenceAdjustedRating(avg, count) {
  if (!count) return 0;
  return (avg * count + 3 * 5) / (count + 5);
}

function isSchemaDriftError(err) {
  return err?.code === 'P2022' || err?.code === 'P2021';
}

async function promoterActivityMap(userIds) {
  return promoterActivityMapFromJobApplications(userIds);
}

async function promoterActivityMapFromJobApplications(userIds) {
  const map = new Map();
  for (const id of userIds) map.set(id, { acceptedJobs: 0, completedJobs: 0, lastActivityAt: null });
  if (!userIds.length) return map;

  const applications = await prisma.jobApplication.findMany({
    where: {
      applicantUserId: { in: userIds },
      status: { in: ['HIRED'] },
      jobPosting: { positionRole: 'PROMOTER' },
    },
    select: {
      applicantUserId: true,
      status: true,
      appliedAt: true,
      completedAt: true,
    },
  });

  for (const app of applications) {
    const uid = app.applicantUserId;
    if (!uid || !map.has(uid)) continue;
    const item = map.get(uid);
    item.acceptedJobs += 1;
    if (app.completedAt) item.completedJobs += 1;
    const d = new Date(app.completedAt || app.appliedAt);
    if (!item.lastActivityAt || d > item.lastActivityAt) item.lastActivityAt = d;
  }
  return map;
}

function mergeActivity(activityA, activityB) {
  const merged = new Map();
  for (const [userId, a] of activityA.entries()) {
    const b = activityB.get(userId) || { acceptedJobs: 0, completedJobs: 0, lastActivityAt: null };
    const latest = a.lastActivityAt && b.lastActivityAt
      ? (a.lastActivityAt > b.lastActivityAt ? a.lastActivityAt : b.lastActivityAt)
      : (a.lastActivityAt || b.lastActivityAt || null);
    merged.set(userId, {
      acceptedJobs: Number(a.acceptedJobs || 0) + Number(b.acceptedJobs || 0),
      completedJobs: Number(a.completedJobs || 0) + Number(b.completedJobs || 0),
      lastActivityAt: latest,
    });
  }
  return merged;
}

export function computePromoterEligibility({
  isVerifiedPromoter,
  acceptedJobs,
  ratingCount,
  uniqueRaters,
  hasAcceptedCodeOfConduct,
  isActive,
  hasCompliancePenalty,
  hiddenByModeration,
}) {
  return {
    isVerifiedPromoter: !!isVerifiedPromoter,
    hasMinimumAcceptedJobs: acceptedJobs >= POLICY.minAcceptedJobs,
    hasRatings: ratingCount >= POLICY.minRatings,
    hasUniqueRaters: uniqueRaters >= POLICY.minUniqueRaters,
    hasAcceptedCodeOfConduct: !!hasAcceptedCodeOfConduct,
    isActive: !!isActive,
    hasCompliancePenalty: !!hasCompliancePenalty,
    hiddenByModeration: !!hiddenByModeration,
  };
}

export async function getPromotersLeaderboard({ page = 1, limit = 50, includeUnverified = false } = {}) {
  const take = Math.max(1, Math.min(Number(limit) || 50, 100));
  const pageNo = Math.max(1, Number(page) || 1);
  const skip = (pageNo - 1) * take;
  try {
    const users = await prisma.user.findMany({
      where: { deletedAt: null, suspendedAt: null },
      select: {
        id: true,
        username: true,
        userProfile: {
          select: {
            isVerifiedPromoter: true,
            avatarUrl: true,
            serviceRatingAvg: true,
            serviceRatingCount: true,
            leaderboardHidden: true,
            leaderboardHiddenReason: true,
            leaderboardHiddenUntil: true,
          },
        },
      },
    });
    const userIds = users.map((u) => u.id);
    const staleCutoff = new Date(Date.now() - POLICY.staleDays * 24 * 60 * 60 * 1000);

    const [legacyActivity, postingActivity, legalAcceptances, ratingsByUser, reportsByUser, blocksByUser, conversionStats] = await Promise.all([
      Promise.resolve(new Map()),
      promoterActivityMapFromJobApplications(userIds),
      prisma.legalDocumentAcceptance.findMany({
        where: { userId: { in: userIds }, documentType: 'PROMOTER_CODE_OF_CONDUCT' },
        orderBy: { acceptedAt: 'desc' },
        select: { userId: true, version: true, acceptedAt: true },
      }),
      prisma.serviceRating.groupBy({
        by: ['rateeUserId'],
        where: { rateeUserId: { in: userIds } },
        _avg: { score: true },
        _count: { _all: true, raterUserId: true },
      }),
      prisma.report.groupBy({
        by: ['targetId'],
        where: { targetType: 'user', targetId: { in: userIds }, status: { in: ['action_taken', 'resolved'] } },
        _count: { _all: true },
      }),
      prisma.block.groupBy({
        by: ['blockedId'],
        where: { blockedId: { in: userIds } },
        _count: { _all: true },
      }),
      promoterConversionStats(userIds),
    ]);
    const activity = mergeActivity(legacyActivity, postingActivity);

    const acceptanceMap = new Map();
    for (const row of legalAcceptances) if (!acceptanceMap.has(row.userId)) acceptanceMap.set(row.userId, row);
    const ratingMap = new Map(ratingsByUser.map((r) => [r.rateeUserId, r]));
    const raterPairs = await prisma.serviceRating.groupBy({
      by: ['rateeUserId', 'raterUserId'],
      where: { rateeUserId: { in: userIds } },
    });
    const uniqueRaterMap = new Map();
    for (const row of raterPairs) {
      uniqueRaterMap.set(row.rateeUserId, (uniqueRaterMap.get(row.rateeUserId) || 0) + 1);
    }
    const reportMap = new Map(reportsByUser.map((r) => [r.targetId, r._count._all]));
    const blockMap = new Map(blocksByUser.map((r) => [r.blockedId, r._count._all]));

    const ranked = users
      .map((u) => {
      const p = u.userProfile;
      const a = activity.get(u.id) || { acceptedJobs: 0, completedJobs: 0, lastActivityAt: null };
      const r = ratingMap.get(u.id);
      const avg = Number(r?._avg?.score ?? p?.serviceRatingAvg ?? 0);
      const ratingCount = Number(r?._count?._all ?? p?.serviceRatingCount ?? 0);
      const uniqueRaters = uniqueRaterMap.get(u.id) || 0;
      const reports = reportMap.get(u.id) || 0;
      const blocks = blockMap.get(u.id) || 0;
      const legal = acceptanceMap.get(u.id);

      const hidden = !!p?.leaderboardHidden &&
        (!p?.leaderboardHiddenUntil || new Date(p.leaderboardHiddenUntil) > new Date());
      const compliancePenalty = reports >= 3;
      const eligibility = computePromoterEligibility({
        isVerifiedPromoter: !!p?.isVerifiedPromoter,
        acceptedJobs: a.acceptedJobs,
        ratingCount,
        uniqueRaters,
        hasAcceptedCodeOfConduct: !!legal,
        isActive: !!a.lastActivityAt && a.lastActivityAt >= staleCutoff,
        hasCompliancePenalty: compliancePenalty,
        hiddenByModeration: hidden,
      });
      const eligible = (includeUnverified || eligibility.isVerifiedPromoter) &&
        eligibility.hasMinimumAcceptedJobs &&
        eligibility.hasRatings &&
        eligibility.hasUniqueRaters &&
        eligibility.hasAcceptedCodeOfConduct &&
        eligibility.isActive &&
        !eligibility.hasCompliancePenalty &&
        !eligibility.hiddenByModeration;

      const quality = clamp((confidenceAdjustedRating(avg, ratingCount) / 5) * 100, 0, 100);
      const execution = clamp((a.acceptedJobs ? a.completedJobs / a.acceptedJobs : 0) * 100, 0, 100);
      const daysSince = a.lastActivityAt ? (Date.now() - a.lastActivityAt.getTime()) / (1000 * 60 * 60 * 24) : 365;
      const consistency = clamp(100 - daysSince, 0, 100);
      const compliance = clamp(100 - reports * 18 - blocks * 8, 0, 100);
      const conv = conversionStats.get(u.id) || { conversionCount: 0, conversionPoints: 0 };
      const conversions = conversionScoreFromPoints(conv.conversionPoints);
      const score = (
        quality * POLICY.scoreWeights.quality +
        execution * POLICY.scoreWeights.execution +
        consistency * POLICY.scoreWeights.consistency +
        conversions * POLICY.scoreWeights.conversions +
        compliance * POLICY.scoreWeights.compliance
      ) / 100;

      return {
        promoterId: u.id,
        username: u.username,
        avatarUrl: p?.avatarUrl || null,
        ratingAvg: Number(avg.toFixed(2)),
        ratingCount,
        uniqueRaters,
        acceptedJobs: a.acceptedJobs,
        completedJobs: a.completedJobs,
        conversionCount: conv.conversionCount,
        conversionPoints: conv.conversionPoints,
        lastActivityAt: a.lastActivityAt,
        score: Number(score.toFixed(2)),
        scoreBreakdown: {
          quality: Number(quality.toFixed(2)),
          execution: Number(execution.toFixed(2)),
          consistency: Number(consistency.toFixed(2)),
          conversions: Number(conversions.toFixed(2)),
          compliance: Number(compliance.toFixed(2)),
        },
        legalAcceptance: legal || null,
        eligibility,
        badges: {
          verified: !!p?.isVerifiedPromoter,
          compliant: !compliancePenalty && compliance >= 70,
          rising: consistency >= 70 && quality >= 60,
        },
      };
      })
      .filter((x) => includeUnverified || x.eligibility.isVerifiedPromoter)
      .filter((x) => x.eligibility.hasMinimumAcceptedJobs)
      .filter((x) => x.eligibility.hasRatings)
      .filter((x) => x.eligibility.hasUniqueRaters)
      .filter((x) => x.eligibility.hasAcceptedCodeOfConduct)
      .filter((x) => x.eligibility.isActive)
      .filter((x) => !x.eligibility.hasCompliancePenalty)
      .filter((x) => !x.eligibility.hiddenByModeration)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.scoreBreakdown.quality !== a.scoreBreakdown.quality) return b.scoreBreakdown.quality - a.scoreBreakdown.quality;
        if (b.completedJobs !== a.completedJobs) return b.completedJobs - a.completedJobs;
        return new Date(b.lastActivityAt || 0).getTime() - new Date(a.lastActivityAt || 0).getTime();
      })
      .map((x, i) => ({ ...x, rank: i + 1 }));

    return {
      policy: POLICY,
      page: pageNo,
      limit: take,
      total: ranked.length,
      data: ranked.slice(skip, skip + take),
    };
  } catch (err) {
    if (!isSchemaDriftError(err)) throw err;

    const users = await prisma.user.findMany({
      where: { deletedAt: null, suspendedAt: null },
      select: {
        id: true,
        username: true,
        userProfile: {
          select: {
            isVerifiedPromoter: true,
            avatarUrl: true,
            serviceRatingAvg: true,
            serviceRatingCount: true,
          },
        },
      },
    });

    const ranked = users
      .filter((u) => u.userProfile?.isVerifiedPromoter)
      .filter((u) => (u.userProfile?.serviceRatingCount || 0) > 0)
      .map((u) => ({
        rank: 0,
        promoterId: u.id,
        username: u.username,
        avatarUrl: u.userProfile?.avatarUrl || null,
        ratingAvg: Number(u.userProfile?.serviceRatingAvg || 0),
        ratingCount: Number(u.userProfile?.serviceRatingCount || 0),
        uniqueRaters: 0,
        acceptedJobs: 0,
        completedJobs: 0,
        lastActivityAt: null,
        score: Number(u.userProfile?.serviceRatingAvg || 0),
        scoreBreakdown: { quality: Number(u.userProfile?.serviceRatingAvg || 0), execution: 0, consistency: 0, conversions: 0, compliance: 100 },
        conversionCount: 0,
        conversionPoints: 0,
        eligibility: {
          isVerifiedPromoter: true,
          hasMinimumAcceptedJobs: true,
          hasRatings: true,
          hasUniqueRaters: true,
          hasAcceptedCodeOfConduct: false,
          isActive: true,
          hasCompliancePenalty: false,
          hiddenByModeration: false,
        },
        badges: { verified: true, compliant: true, rising: false },
      }))
      .sort((a, b) => b.ratingAvg - a.ratingAvg)
      .map((x, i) => ({ ...x, rank: i + 1 }));

    return {
      policy: POLICY,
      page: pageNo,
      limit: take,
      total: ranked.length,
      data: ranked.slice(skip, skip + take),
    };
  }
}

export async function getPromoterStatusForUser(userId) {
  const [profile, legal, venuePromoter, leaderboard] = await Promise.all([
    prisma.userProfile.findUnique({
      where: { userId },
      select: {
        isVerifiedPromoter: true,
        isPromoterStandard: true,
        promoterJobsAccepted: true,
        serviceRatingCount: true,
      },
    }),
    prisma.legalDocumentAcceptance.findFirst({
      where: { userId, documentType: 'PROMOTER_CODE_OF_CONDUCT' },
      orderBy: { acceptedAt: 'desc' },
      select: { version: true, acceptedAt: true },
    }),
    prisma.venuePromoter.findFirst({
      where: { promoterUserId: userId, status: 'ACTIVE' },
      select: { id: true },
    }),
    getPromotersLeaderboard({ page: 1, limit: 500 }),
  ]);

  const me = leaderboard.data.find((x) => x.promoterId === userId);
  const nextSteps = [];
  if (!venuePromoter && !profile?.promoterJobsAccepted) {
    nextSteps.push('Apply for and get hired on a venue Promoter role job');
  }
  if (!legal) nextSteps.push('Accept the Promoter Code of Conduct in Settings');
  if (!profile?.isVerifiedPromoter) nextSteps.push('Request verified promoter status from SEC admin after meeting milestones');
  if ((profile?.promoterJobsAccepted || 0) < POLICY.minAcceptedJobs) {
    nextSteps.push(`Complete ${POLICY.minAcceptedJobs - (profile?.promoterJobsAccepted || 0)} more promoter hires`);
  }
  if ((profile?.serviceRatingCount || 0) < POLICY.minRatings) {
    nextSteps.push(`Earn ${POLICY.minRatings - (profile?.serviceRatingCount || 0)} more venue ratings`);
  }

  return {
    isHiredPromoter: !!venuePromoter,
    hasAcceptedCodeOfConduct: !!legal,
    isVerifiedPromoter: !!profile?.isVerifiedPromoter,
    isPromoterStandard: !!profile?.isPromoterStandard,
    promoterJobsAccepted: profile?.promoterJobsAccepted || 0,
    featured: !!me,
    rank: me?.rank || null,
    score: me?.score || 0,
    conversionCount: me?.conversionCount || 0,
    conversionPoints: me?.conversionPoints || 0,
    eligibility: me?.eligibility || null,
    nextSteps,
  };
}

