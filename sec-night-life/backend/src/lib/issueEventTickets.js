import { prisma } from './prisma.js';
import { issueTicketAndNotify, sendConsolidatedEventTicketsEmail } from './issueTicket.js';
import { createInAppNotification } from './inAppNotifications.js';
import { createNotification } from './notifications.js';
import { logFriendActivity } from './friendActivity.js';
import { upsertConfirmedAttendance } from './eventAttendance.js';
import {
  eventStartsAtFromEvent,
  eventEndsAtFromEvent,
  visibleUntilAfterEventDate,
  holderDisplayNameFromUser,
} from './ticketHelpers.js';
import { recordPayoutAndMaybeTransfer, resolveRecipientCodeForVenue } from './paystackPayout.js';
import { splitTicketCheckoutAmounts, splitTicketGross } from './platformSplit.js';
import { promoterUserIdFromMetadata, recordPromoterConversion } from './promoterAttribution.js';
import { buildTicketDoorContext } from './ticketDoorContext.js';
import { logger } from './logger.js';
import { countUserEventTierTickets, parseMaxPerUser } from './ticketTierCaps.js';
import { netOfServiceFee } from './serviceFee.js';

export function normalizeTicketTiers(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (raw && typeof raw === 'object') {
    const values = Object.values(raw);
    if (values.every((v) => v && typeof v === 'object')) return values;
  }
  return [];
}

function parseTicketMenuItems(meta) {
  const raw = meta?.selected_menu_items ?? meta?.selectedMenuItems;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function ticketReferencesForPayment(reference, qty) {
  if (qty <= 1) return [reference];
  return Array.from({ length: qty }, (_, i) => `${reference}-${i + 1}`);
}

async function syncTierSoldFromTickets(db, eventId, ticketTier) {
  const event = await db.event.findUnique({ where: { id: eventId }, select: { ticketTiers: true } });
  if (!event) return;
  const tiers = normalizeTicketTiers(event.ticketTiers);
  const tierRow = tiers.find((t) => t.name === ticketTier);
  if (!tierRow) return;
  const actualCount = await db.ticket.count({
    where: {
      eventId,
      kind: 'EVENT_TICKET',
      subtitle: ticketTier,
      hiddenFromHistoryAt: null,
      refundedAt: null,
    },
  });
  const currentSold = Number(tierRow.sold) || 0;
  if (actualCount !== currentSold) {
    const updatedTiers = tiers.map((t) =>
      t.name === ticketTier ? { ...t, sold: actualCount } : t,
    );
    await db.event.update({ where: { id: eventId }, data: { ticketTiers: updatedTiers } });
  }
}

export { syncTierSoldFromTickets as restoreTicketTierInventoryFromTickets };

function ticketPayoutAmounts(amount, metadata) {
  const grossZar = Number(amount || 0);
  let eSec;
  let eRec;
  if (metadata?.platform_fee_zar != null && metadata?.venue_share_zar != null) {
    eSec = Math.round(Number(metadata.platform_fee_zar) * 100) / 100;
    eRec = Math.round(Number(metadata.venue_share_zar) * 100) / 100;
  } else if (
    metadata?.ticket_subtotal_zar != null
    || metadata?.menu_zar != null
    || metadata?.menu_total_zar != null
  ) {
    const ticketSub = Number(metadata.ticket_subtotal_zar ?? grossZar) || 0;
    const menuSub = Number(metadata.menu_total_zar ?? metadata.menu_zar ?? 0) || 0;
    const split = splitTicketCheckoutAmounts(ticketSub, menuSub);
    eSec = split.secAmount;
    eRec = split.recipientAmount;
  } else {
    const split = splitTicketGross(grossZar);
    eSec = split.secAmount;
    eRec = split.recipientAmount;
  }
  return { grossZar, eSec, eRec };
}

/**
 * Idempotently record venue share for a ticket payment (even if tickets already exist).
 */
export async function ensureVenueTicketPayoutLedger({
  reference,
  amount = 0,
  metadata = {},
  venueId = null,
}) {
  if (!reference) return { skipped: true, reason: 'missing_reference' };

  const existing = await prisma.payoutLedger.findUnique({
    where: { paymentReference: reference },
  });
  if (existing) {
    return { skipped: true, status: existing.status, ledgerId: existing.id };
  }

  let resolvedVenueId = venueId || metadata.venue_id || metadata.venueId || null;
  const eventId = metadata.event_id || metadata.eventId;
  if (!resolvedVenueId && eventId) {
    const event = await prisma.event.findFirst({
      where: { id: String(eventId), deletedAt: null },
      select: { venueId: true },
    });
    resolvedVenueId = event?.venueId || null;
  }
  if (!resolvedVenueId) {
    return { skipped: true, reason: 'missing_venue' };
  }

  const { grossZar, eSec, eRec } = ticketPayoutAmounts(amount, metadata);
  if (grossZar <= 0 || eRec <= 0) {
    return { skipped: true, reason: 'no_recipient_share' };
  }

  const vCode = await resolveRecipientCodeForVenue(resolvedVenueId);
  return recordPayoutAndMaybeTransfer({
    paymentReference: reference,
    grossZar,
    secAmount: eSec,
    recipientAmount: eRec,
    recipientType: 'VENUE',
    recipientVenueId: resolvedVenueId,
    recipientUserId: null,
    paystackRecipientCode: vCode,
  });
}

/**
 * Idempotently issue EVENT_TICKET rows after a successful ticket payment.
 */
export async function issueEventTicketsFromPayment(db, {
  reference,
  userId,
  email,
  amount = 0,
  metadata = {},
  skipSoldUpdate = false,
  skipSideNotifications = false,
}) {
  const eventId = metadata.event_id || metadata.eventId;
  const ticketTier = metadata.ticket_tier_name || metadata.ticketTierName;
  const qty = Math.max(1, parseInt(String(metadata.quantity || '1'), 10) || 1);
  const paymentType = String(metadata.type || '');

  if (!eventId || !ticketTier || !userId) {
    return { issued: 0, skipped: true, reason: 'missing_metadata' };
  }

  if (paymentType && paymentType !== 'ticket' && paymentType !== 'event') {
    return { issued: 0, skipped: true, reason: 'wrong_payment_type' };
  }

  const refs = ticketReferencesForPayment(reference, qty);
  const existing = await db.ticket.findMany({
    where: { paystackReference: { in: refs } },
    select: { id: true, paystackReference: true },
  });
  const existingCount = existing.length;
  if (existingCount >= qty) {
    await syncTierSoldFromTickets(db, eventId, ticketTier);
    await ensureVenueTicketPayoutLedger({
      reference,
      amount,
      metadata,
    }).catch((err) => {
      logger.warn('ensureVenueTicketPayoutLedger on already_issued failed', {
        reference,
        err: err?.message,
      });
    });
    return { issued: 0, skipped: true, reason: 'already_issued', existing: existingCount };
  }

  const event = await db.event.findFirst({
    where: { id: String(eventId), deletedAt: null },
    include: {
      venue: { select: { ownerUserId: true, name: true, address: true, city: true } },
    },
  });
  if (!event) {
    logger.warn('issueEventTickets: event not found', { eventId, reference });
    return { issued: 0, skipped: true, reason: 'event_not_found' };
  }

  const tiers = normalizeTicketTiers(event.ticketTiers);
  if (!tiers.length) {
    logger.warn('issueEventTickets: no ticket tiers on event', { eventId, reference });
    return { issued: 0, skipped: true, reason: 'no_tiers' };
  }

  const tierRow = tiers.find((t) => t.name === ticketTier);
  if (!tierRow) {
    logger.warn('issueEventTickets: tier not found', { eventId, ticketTier, reference });
    return { issued: 0, skipped: true, reason: 'tier_not_found' };
  }

  const toIssue = qty - existingCount;
  const soldIncrement = skipSoldUpdate ? 0 : toIssue;

  const payerEv = await db.user.findUnique({
    where: { id: String(userId) },
    select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
  });
  const visEv = eventEndsAtFromEvent(event) || visibleUntilAfterEventDate(event.date);
  const eventStartsAt = eventStartsAtFromEvent(event);
  const eventEndsAt = eventEndsAtFromEvent(event);

  let holderNames = [];
  try {
    const raw = metadata.holder_names ?? metadata.holderNames;
    holderNames = typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
  } catch {
    holderNames = [];
  }

  const menuItems = parseTicketMenuItems(metadata);
  const ticketPromoterId = promoterUserIdFromMetadata(metadata);
  const locParts = [
    event.locationAddress || event.venue?.address,
    event.locationCity || event.city,
  ].filter(Boolean);

  const existingRefs = new Set(existing.map((t) => t.paystackReference));
  const issuedTickets = [];
  let issued = 0;

  try {
  await db.$transaction(async (tx) => {
    const cap = parseMaxPerUser(tierRow);
    if (cap != null && toIssue > 0) {
      const owned = await countUserEventTierTickets(tx, {
        userId,
        eventId: event.id,
        ticketTier,
      });
      if (owned + toIssue > cap) {
        const err = new Error(`You can buy at most ${cap} of this ticket per person.`);
        err.code = 'PER_USER_CAP';
        throw err;
      }
    }
    if (soldIncrement > 0) {
      const fresh = await tx.event.findUnique({ where: { id: event.id }, select: { ticketTiers: true } });
      const freshTiers = normalizeTicketTiers(fresh?.ticketTiers);
      const updatedTiers = freshTiers.map((t) =>
        t.name === ticketTier ? { ...t, sold: (Number(t.sold) || 0) + soldIncrement } : t,
      );
      await tx.event.update({ where: { id: event.id }, data: { ticketTiers: updatedTiers } });
    }

    for (let i = 0; i < qty; i += 1) {
      const payRef = refs[i];
      if (existingRefs.has(payRef)) continue;

      const holder = String(holderNames[i] || '').trim() || holderDisplayNameFromUser(payerEv);
      const summaryLines = [
        ticketTier,
        tierRow.description ? String(tierRow.description) : null,
        `R${Number(tierRow.price || 0).toLocaleString('en-ZA')}`,
        holder ? `Guest: ${holder}` : null,
        event.title,
        locParts.length ? locParts.join(', ') : null,
      ];
      if (menuItems.length > 0 && i === 0) {
        summaryLines.push('Menu add-ons:');
        for (const m of menuItems) {
          summaryLines.push(`${m.quantity}× ${m.name}`);
        }
      }

      const ticket = await issueTicketAndNotify(tx, {
        userId: String(userId),
        email: null,
        skipEmail: true,
        skipNotification: true,
        paystackReference: payRef,
        kind: 'EVENT_TICKET',
        title: event.title,
        subtitle: ticketTier,
        visibleUntil: visEv,
        eventId: event.id,
        quantity: 1,
        holderDisplayName: holder,
        tableSpecsSummary: summaryLines.filter(Boolean).join('\n'),
        eventStartsAt,
        eventEndsAt,
        promoterUserId: ticketPromoterId,
      });
      issuedTickets.push({ ticket, holderLabel: holder ? `Guest: ${holder}` : `Guest ${i + 1}` });
      issued += 1;
    }
  });
  } catch (err) {
    if (err?.code === 'PER_USER_CAP' || err?.cause?.code === 'PER_USER_CAP') {
      logger.warn('issueEventTickets: per-user cap exceeded', { eventId, ticketTier, userId, reference });
      return { issued: 0, skipped: true, reason: 'per_user_cap', error: err.message };
    }
    throw err;
  }

  // Always ensure venue payout ledger when tickets exist (not gated on notifications).
  if (issuedTickets.length > 0 || existingCount > 0) {
    await ensureVenueTicketPayoutLedger({
      reference,
      amount,
      metadata,
      venueId: event.venueId,
    }).catch((err) => {
      logger.warn('ensureVenueTicketPayoutLedger failed', { reference, err: err?.message });
    });
  }

  if (issuedTickets.length > 0) {
    const emailPayload = [];
    for (const { ticket, holderLabel } of issuedTickets) {
      const door = await buildTicketDoorContext(db, ticket);
      emailPayload.push({
        qrToken: ticket.qrToken,
        paystackReference: ticket.paystackReference,
        eventStartsAt: ticket.eventStartsAt,
        holderLabel,
        door,
      });
    }

    const ticketWord = issued === 1 ? 'ticket' : 'tickets';
    await createInAppNotification({
      userId: String(userId),
      type: 'EVENT_JOINED',
      title: issued === 1 ? 'Ticket confirmed' : `${issued} tickets confirmed`,
      body: `${event.title}. View your ${ticketWord} under Profile → Tickets.`,
      referenceId: issuedTickets[0].ticket.id,
      referenceType: 'TICKET',
    });

    await sendConsolidatedEventTicketsEmail({
      to: payerEv?.email || email,
      eventTitle: event.title,
      tierName: ticketTier,
      tickets: emailPayload,
    });

    if (!skipSideNotifications) {
      logFriendActivity({
        userId,
        activityType: 'JOINED_EVENT',
        referenceId: event.id,
        referenceType: 'EVENT',
        description: 'joined an event',
      });
      await upsertConfirmedAttendance(userId, event.id);
      if (event.eventFormat !== 'TICKETING_ONLY') {
        const { addUserToEventGroupChat } = await import('./groupChatHelpers.js');
        await addUserToEventGroupChat(event.id, userId, event.title);
      }

      await createNotification({
        userId: event.venue?.ownerUserId,
        type: 'payment',
        title: 'Ticket purchase',
        body: `${qty} ticket(s) sold for "${event.title}" at ${event.venue?.name || 'your venue'}.`,
        actionUrl: `/BusinessEvents`,
      });
    }
  }

  if (issued > 0) {
    const promoterUserId = promoterUserIdFromMetadata(metadata);
    if (promoterUserId) {
      await recordPromoterConversion({
        eventId: event.id,
        promoterUserId,
        conversionType: 'TICKET_PURCHASE',
        buyerUserId: String(userId),
        amountZar: amount,
        paystackReference: reference,
        quantity: qty,
      }).catch(() => {});
    }
  }

  if (skipSoldUpdate && issued === 0 && existingCount > 0) {
    await syncTierSoldFromTickets(db, eventId, ticketTier);
  }

  return { issued, skipped: issued === 0, reason: issued ? 'ok' : 'partial_or_none' };
}

/** Repair path: ensure tickets exist for a paid ticket payment reference. */
export async function ensureEventTicketsForPayment(reference, paystackData = null) {
  const pay = await prisma.payment.findUnique({
    where: { reference },
    select: { userId: true, email: true, amount: true, metadata: true, status: true },
  });
  if (!pay) return { repaired: false };
  const paid = pay.status === 'success' || paystackData?.status === 'success';
  if (!paid) return { repaired: false };

  const metadata = pay.metadata && typeof pay.metadata === 'object' ? pay.metadata : {};
  const type = metadata.type;
  const ticketTier = metadata.ticket_tier_name || metadata.ticketTierName;
  if ((type !== 'ticket' && type !== 'event') || !ticketTier) {
    return { repaired: false };
  }

  const amount = netOfServiceFee(
    metadata,
    paystackData?.amount ? paystackData.amount / 100 : Number(pay.amount || 0),
  );
  const result = await issueEventTicketsFromPayment(prisma, {
    reference,
    userId: pay.userId,
    email: pay.email,
    amount,
    metadata,
    skipSoldUpdate: false,
    skipSideNotifications: false,
  });

  if (result.issued > 0 || result.skipped) {
    const qty = Math.max(1, parseInt(String(metadata.quantity || '1'), 10) || 1);
    const refs =
      qty <= 1
        ? [reference]
        : Array.from({ length: qty }, (_, i) => `${reference}-${i + 1}`);
    const ticketCount = await prisma.ticket.count({ where: { paystackReference: { in: refs } } });
    if (ticketCount >= qty) {
      await ensureVenueTicketPayoutLedger({
        reference,
        amount,
        metadata,
      }).catch(() => {});
      const ledger = await prisma.payoutLedger.findUnique({
        where: { paymentReference: reference },
        select: { id: true },
      });
      if (!ledger) {
        return { repaired: result.issued > 0, ...result, ledgerMissing: true };
      }
      const priorMeta = metadata && typeof metadata === 'object' ? metadata : {};
      await prisma.payment.updateMany({
        where: { reference },
        data: {
          status: 'success',
          metadata: {
            ...priorMeta,
            side_effects_applied: true,
            side_effects_processing: false,
            repaired_at: new Date().toISOString(),
          },
        },
      });
    }
  }

  return { repaired: result.issued > 0, ...result };
}
