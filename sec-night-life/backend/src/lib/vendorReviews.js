import { prisma } from './prisma.js';
import { confidenceAdjustedRating } from './leaderboard.js';

function round1(avg) {
  if (avg == null || Number.isNaN(Number(avg))) return 0;
  return Math.round(Number(avg) * 10) / 10;
}

export function emptyVendorStats() {
  return { averageRating: 0, totalReviews: 0, adjustedRating: 0 };
}

/**
 * Person + venue reviews combined (flagged reviews excluded, same as user profiles).
 * @param {string[]} vendorIds
 * @returns {Promise<Map<string, { averageRating: number, totalReviews: number, adjustedRating: number }>>}
 */
export async function vendorReviewStatsBatch(vendorIds, db = prisma) {
  const ids = [...new Set((vendorIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const where = { vendorBusinessId: { in: ids }, flagged: false };
  const [personRows, venueRows] = await Promise.all([
    db.vendorReview.groupBy({ by: ['vendorBusinessId'], where, _sum: { rating: true }, _count: { _all: true } }),
    db.venueVendorReview.groupBy({ by: ['vendorBusinessId'], where, _sum: { rating: true }, _count: { _all: true } }),
  ]);
  const acc = new Map();
  for (const r of [...personRows, ...venueRows]) {
    const cur = acc.get(r.vendorBusinessId) || { sum: 0, count: 0 };
    cur.sum += Number(r._sum?.rating || 0);
    cur.count += Number(r._count?._all || 0);
    acc.set(r.vendorBusinessId, cur);
  }
  for (const id of ids) {
    const a = acc.get(id);
    if (!a || !a.count) {
      out.set(id, emptyVendorStats());
      continue;
    }
    const avg = a.sum / a.count;
    out.set(id, {
      averageRating: round1(avg),
      totalReviews: a.count,
      adjustedRating: confidenceAdjustedRating(avg, a.count),
    });
  }
  return out;
}

export async function vendorReviewStats(vendorId, db = prisma) {
  const map = await vendorReviewStatsBatch([vendorId], db);
  return map.get(vendorId) || emptyVendorStats();
}

/** Completed hire requests for a vendor, keyed by venue and requester (for "Verified hire" badges). */
export async function completedHireIndex(vendorBusinessId, db = prisma) {
  const rows = await db.vendorInquiry.findMany({
    where: { vendorBusinessId, status: 'COMPLETED' },
    select: { id: true, venueId: true, requesterUserId: true },
  });
  const byVenue = new Map();
  const byUser = new Map();
  for (const r of rows) {
    if (!byVenue.has(r.venueId)) byVenue.set(r.venueId, r.id);
    if (!byUser.has(r.requesterUserId)) byUser.set(r.requesterUserId, r.id);
  }
  return { byVenue, byUser };
}

/** Owner account still active — listings from suspended or deleted owners are hidden. */
export const activeVendorOwnerWhere = { user: { deletedAt: null, suspendedAt: null } };

/** A vendor listing other people can see and review. */
export async function findPublicVendor(vendorId, db = prisma) {
  return db.vendorBusiness.findFirst({
    where: { id: vendorId, deletedAt: null, isPublished: true, ...activeVendorOwnerWhere },
    select: { id: true, name: true, userId: true },
  });
}
