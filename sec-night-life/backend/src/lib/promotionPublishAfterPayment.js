import { prisma } from './prisma.js';
import { notifyPaymentSuccess } from './paymentNotifications.js';
import { expectedPlatformProductAmountZar } from './paystackPayout.js';

const PROMO_MS_DAY = 24 * 60 * 60 * 1000;
const MAX_PROMO_SPAN_MS = 30 * PROMO_MS_DAY;

export function resolvePromotionIdFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  return (
    metadata.promotedPostId ||
    metadata.promotion_id ||
    metadata.promoted_post_id ||
    metadata.promotionId ||
    null
  );
}

export function isPromotionPublishPayment(metadata, paymentType) {
  if (!metadata || typeof metadata !== 'object') return false;
  const kind = String(metadata.sec_kind || metadata.secKind || '').toUpperCase();
  const metaType = String(metadata.type || '').toUpperCase();
  if (kind === 'BOOST' || metaType === 'BOOST') return false;
  if (kind === 'PROMOTION_PUBLISH' || metaType === 'PROMOTION_PUBLISH') return true;
  if (String(paymentType || '').toLowerCase() === 'promotion' && resolvePromotionIdFromMetadata(metadata)) {
    return true;
  }
  return false;
}

/**
 * Activate a draft/ended promotion after a successful publish payment.
 * @returns {Promise<{ activated: boolean, promotion: object | null, reason?: string }>}
 */
export async function activatePromotionAfterPublishPayment({
  promoId,
  metadata,
  reference,
  payerUserId,
  payerEmail,
  sendNotification = true,
}) {
  const id = String(promoId || '').trim();
  if (!id) return { activated: false, promotion: null, reason: 'missing_promotion_id' };

  const publishDays = Math.min(
    30,
    Math.max(1, parseInt(String(metadata?.publishDays ?? metadata?.publish_days ?? '1'), 10) || 1),
  );
  const boostDays = Math.min(
    30,
    Math.max(0, parseInt(String(metadata?.boostDays ?? metadata?.boost_days ?? '0'), 10) || 0),
  );

  const now = new Date();
  const existingPromo = await prisma.promotion.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, title: true, venueId: true, status: true, startAt: true, endAt: true },
  });
  if (!existingPromo) return { activated: false, promotion: null, reason: 'promotion_not_found' };
  if (!['DRAFT', 'ENDED'].includes(existingPromo.status)) {
    return { activated: false, promotion: existingPromo, reason: 'already_live' };
  }

  let startAt = existingPromo.startAt ? new Date(existingPromo.startAt) : now;
  let endAt = existingPromo.endAt ? new Date(existingPromo.endAt) : new Date(now.getTime() + publishDays * PROMO_MS_DAY);

  const scheduleValid =
    !Number.isNaN(startAt.getTime()) &&
    !Number.isNaN(endAt.getTime()) &&
    endAt > startAt &&
    endAt.getTime() - startAt.getTime() <= MAX_PROMO_SPAN_MS;

  if (!scheduleValid) {
    startAt = now;
    endAt = new Date(now.getTime() + publishDays * PROMO_MS_DAY);
  }

  const spanDays = Math.max(1, Math.ceil((endAt.getTime() - startAt.getTime()) / PROMO_MS_DAY));
  const paid = reference
    ? await prisma.payment.findUnique({
        where: { reference: String(reference) },
        select: { amount: true },
      })
    : null;
  const charged = Number(paid?.amount) || 0;
  const expected = expectedPlatformProductAmountZar({
    type: 'PROMOTION_PUBLISH',
    publish_days: Math.max(spanDays, publishDays),
    boost_days: boostDays,
  });
  if (charged + 0.02 < expected) {
    return { activated: false, promotion: existingPromo, reason: 'underpaid' };
  }

  const boostData =
    boostDays > 0
      ? {
          boosted: true,
          boostedAt: now,
          boostExpiresAt: new Date(now.getTime() + boostDays * PROMO_MS_DAY),
          boostPaystackRef: reference,
        }
      : {
          boosted: false,
          boostedAt: null,
          boostExpiresAt: null,
          boostPaystackRef: null,
        };

  const publishUp = await prisma.promotion.updateMany({
    where: { id, deletedAt: null, status: { in: ['DRAFT', 'ENDED'] } },
    data: {
      status: 'ACTIVE',
      startAt,
      endAt,
      ...boostData,
    },
  });

  if (publishUp.count === 0) {
    const current = await prisma.promotion.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, title: true, venueId: true, status: true, startAt: true, endAt: true },
    });
    return { activated: false, promotion: current, reason: 'update_failed' };
  }

  const promo = await prisma.promotion.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, title: true, venueId: true, status: true, startAt: true, endAt: true },
  });

  if (sendNotification && promo) {
    const venue = await prisma.venue.findFirst({
      where: { id: promo.venueId, deletedAt: null },
      select: { ownerUserId: true, name: true, owner: { select: { email: true } } },
    });
    const titleNote = boostDays > 0 ? 'Promotion is live and boosted' : 'Promotion is live';
    const bodyNote =
      boostDays > 0
        ? `"${promo.title}" is live for ${publishDays} day(s) with boost on ${venue?.name || 'your venue'}.`
        : `"${promo.title}" is live for ${publishDays} day(s) on ${venue?.name || 'your venue'}.`;
    const notifyUserId = String(payerUserId || venue?.ownerUserId || '');
    const notifyEmail =
      payerEmail && payerEmail !== 'unknown@secnightlife.app' ? payerEmail : venue?.owner?.email || null;
    await notifyPaymentSuccess({
      userId: notifyUserId,
      email: notifyEmail,
      title: titleNote,
      body: bodyNote,
      actionUrl: '/BusinessPromotions',
      referenceId: promo.id,
      referenceType: 'PROMOTION',
      emailSubject: `${titleNote} — ${promo.title}`,
    });
  }

  return { activated: true, promotion: promo };
}
