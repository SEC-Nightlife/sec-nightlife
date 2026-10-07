import { prisma } from './prisma.js';

export const OPEN_INQUIRY_STATUSES = ['REQUESTED', 'ACCEPTED'];
/** Statuses that let the venue and vendor message each other without being friends. */
export const MESSAGING_INQUIRY_STATUSES = ['REQUESTED', 'ACCEPTED', 'COMPLETED'];
export const MAX_INQUIRIES_PER_DAY = 10;

/**
 * Allowed transitions per actor. `vendor` = listing owner, `venue` = venue owner / requester.
 * @type {Record<string, { from: string[], to: string, actors: Array<'vendor'|'venue'> }>}
 */
export const INQUIRY_ACTIONS = {
  accept: { from: ['REQUESTED'], to: 'ACCEPTED', actors: ['vendor'] },
  decline: { from: ['REQUESTED', 'ACCEPTED'], to: 'DECLINED', actors: ['vendor'] },
  complete: { from: ['ACCEPTED'], to: 'COMPLETED', actors: ['vendor', 'venue'] },
  cancel: { from: ['REQUESTED', 'ACCEPTED'], to: 'CANCELLED', actors: ['venue'] },
};

/**
 * @param {string} action
 * @param {string} currentStatus
 * @param {'vendor'|'venue'} actor
 * @returns {{ ok: true, to: string } | { ok: false, status: number, error: string }}
 */
export function resolveInquiryTransition(action, currentStatus, actor) {
  const rule = INQUIRY_ACTIONS[action];
  if (!rule) return { ok: false, status: 400, error: 'Unknown action' };
  if (!rule.actors.includes(actor)) {
    return {
      ok: false,
      status: 403,
      error: actor === 'vendor' ? 'Only the venue can do this.' : 'Only the vendor can do this.',
    };
  }
  if (!rule.from.includes(currentStatus)) {
    return {
      ok: false,
      status: 409,
      error: `This request is ${String(currentStatus).toLowerCase()} and can't be changed that way.`,
    };
  }
  return { ok: true, to: rule.to };
}

/** True when a live or completed hire request links these two users (either direction). */
export async function hasVendorInquiryLink(userA, userB, db = prisma) {
  if (!userA || !userB || userA === userB) return false;
  const row = await db.vendorInquiry.findFirst({
    where: {
      status: { in: MESSAGING_INQUIRY_STATUSES },
      OR: [
        { requesterUserId: userA, vendorBusiness: { userId: userB } },
        { requesterUserId: userB, vendorBusiness: { userId: userA } },
        { venue: { ownerUserId: userA }, vendorBusiness: { userId: userB } },
        { venue: { ownerUserId: userB }, vendorBusiness: { userId: userA } },
      ],
    },
    select: { id: true },
  });
  return Boolean(row);
}

export function formatInquiry(row) {
  if (!row) return null;
  return {
    id: row.id,
    vendor_id: row.vendorBusinessId,
    venue_id: row.venueId,
    requester_user_id: row.requesterUserId,
    event_date: row.eventDate ? row.eventDate.toISOString() : null,
    message: row.message,
    status: row.status,
    vendor_response: row.vendorResponse ?? null,
    responded_at: row.respondedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    cancelled_at: row.cancelledAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    vendor: row.vendorBusiness
      ? {
          id: row.vendorBusiness.id,
          name: row.vendorBusiness.name,
          category: row.vendorBusiness.category,
          owner_user_id: row.vendorBusiness.userId,
        }
      : undefined,
    venue: row.venue
      ? { id: row.venue.id, name: row.venue.name, logo_url: row.venue.logoUrl ?? null, owner_user_id: row.venue.ownerUserId }
      : undefined,
    requester: row.requester
      ? {
          id: row.requester.id,
          username: row.requester.userProfile?.username || row.requester.username || null,
          avatar_url: row.requester.userProfile?.avatarUrl ?? null,
        }
      : undefined,
  };
}

export const inquiryInclude = {
  vendorBusiness: { select: { id: true, name: true, category: true, userId: true } },
  venue: { select: { id: true, name: true, logoUrl: true, ownerUserId: true } },
  requester: {
    select: { id: true, username: true, userProfile: { select: { username: true, avatarUrl: true } } },
  },
};
