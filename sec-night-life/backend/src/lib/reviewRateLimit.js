import { prisma } from './prisma.js';

export const REVIEWS_PER_HOUR_LIMIT = 5;

/** Reviews of any kind written by this user in the last hour (shared 5/hour limit). */
export async function countReviewsCreatedLastHour(reviewerId) {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const counts = await Promise.all([
    prisma.userReview.count({ where: { reviewerId, createdAt: { gte: since } } }),
    prisma.venueReview.count({ where: { reviewerId, createdAt: { gte: since } } }),
    prisma.venueUserReview.count({ where: { authorUserId: reviewerId, createdAt: { gte: since } } }),
    prisma.vendorReview.count({ where: { reviewerId, createdAt: { gte: since } } }),
    prisma.venueVendorReview.count({ where: { authorUserId: reviewerId, createdAt: { gte: since } } }),
  ]);
  return counts.reduce((s, n) => s + n, 0);
}

export async function isReviewRateLimited(reviewerId) {
  return (await countReviewsCreatedLastHour(reviewerId)) >= REVIEWS_PER_HOUR_LIMIT;
}
