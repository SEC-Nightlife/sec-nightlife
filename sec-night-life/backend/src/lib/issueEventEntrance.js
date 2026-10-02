import { prisma } from './prisma.js';
import { issueTicketAndNotify } from './issueTicket.js';
import { upsertConfirmedAttendance } from './eventAttendance.js';
import { recordEventVenueTableBooking } from './eventVenueBooking.js';
import {
  eventStartsAtFromEvent,
  eventEndsAtFromEvent,
  eventHasEnded,
  visibleUntilAfterEventDate,
  holderDisplayNameFromUser,
} from './ticketHelpers.js';
import { recordPayoutAndMaybeTransfer, resolveRecipientCodeForVenue, splitSecPlatform } from './paystackPayout.js';
import { computeEntranceCheckout, userHasPaidEventEntrance } from './entranceCheckout.js';
import { getEventEntranceZar } from './hostedTableSecFees.js';
import { resolveVenueMenuSelections } from './menuHelpers.js';
import { promoterUserIdFromMetadata, recordPromoterConversion } from './promoterAttribution.js';
import { logger } from './logger.js';

/**
 * Validate + compute standalone entrance checkout for an event.
 */
export async function computeEventEntranceCheckout(
  db,
  { eventId, selectedMenuItems = [], allowFreeClaim = false },
) {
  const event = await db.event.findFirst({
    where: { id: eventId, deletedAt: null },
    select: {
      id: true,
      title: true,
      venueId: true,
      date: true,
      startTime: true,
      endsAt: true,
      hasEntranceFee: true,
      entranceFeeAmount: true,
      eventFormat: true,
      status: true,
    },
  });
  if (!event) return { ok: false, error: 'Event not found' };
  if (event.eventFormat === 'TICKETING_ONLY') {
    return { ok: false, error: 'Entrance-only checkout is not available for ticketed events' };
  }
  if (event.status !== 'published') {
    return { ok: false, error: 'Event is not available' };
  }
  if (eventHasEnded(event)) {
    return { ok: false, error: 'This event has ended. Entrance is no longer available.' };
  }
  if (!event.hasEntranceFee) {
    return { ok: false, error: 'This event does not have an entrance fee' };
  }
  // Prefer explicit fee amount (incl. R0 free entrance); fall back to helper for paid fees.
  const rawFee = Number(event.entranceFeeAmount);
  const entranceZar =
    Number.isFinite(rawFee) && rawFee >= 0 ? Math.round(rawFee * 100) / 100 : getEventEntranceZar(event);
  if (entranceZar < 0) {
    return { ok: false, error: 'This event does not have an entrance fee' };
  }

  let menuZar = 0;
  let menuItems = [];
  if (Array.isArray(selectedMenuItems) && selectedMenuItems.length > 0) {
    const resolved = await resolveVenueMenuSelections(selectedMenuItems, event.venueId);
    menuZar = Number(resolved.totalZar || 0);
    menuItems = resolved.items || [];
  }

  const checkout = computeEntranceCheckout({
    entranceZar,
    menuTotal: menuZar,
    // Free entrance + menu uses paid checkout; fully free needs allowFreeClaim.
    allowZeroEntrance: allowFreeClaim || (entranceZar === 0 && menuZar > 0),
  });
  if (checkout.error) return { ok: false, error: checkout.error };
  if (checkout.total <= 0 && !allowFreeClaim) {
    return { ok: false, error: 'This event does not have an entrance fee' };
  }

  return {
    ok: true,
    event,
    entranceZar,
    menuZar,
    menuItems,
    subtotal: checkout.subtotal,
    serviceFee: checkout.serviceFee,
    total: checkout.total,
    platformFee: checkout.platformFee,
    venueShare: checkout.venueShare,
    lines: checkout.lines,
  };
}

/**
 * Fulfill EVENT_ENTRANCE payment: ticket QR, booking row, attendance, venue payout.
 */
export async function issueEventEntranceFromPayment(db, {
  reference,
  userId,
  email,
  amount = 0,
  metadata = {},
}) {
  const eventId = metadata.event_id || metadata.eventId;
  if (!eventId || !userId) {
    return { issued: false, skipped: true, reason: 'missing_metadata' };
  }

  const existingTicket = await db.ticket.findUnique({
    where: { paystackReference: reference },
  });
  if (existingTicket) {
    return { issued: false, skipped: true, reason: 'already_issued' };
  }

  const event = await db.event.findFirst({
    where: { id: eventId, deletedAt: null },
    include: { venue: { select: { id: true, name: true, ownerUserId: true } } },
  });
  if (!event) {
    return { issued: false, skipped: true, reason: 'event_not_found' };
  }

  const entranceZar = Number(metadata.entrance_zar ?? metadata.entranceZar ?? getEventEntranceZar(event)) || 0;
  const menuZar = Number(metadata.menu_zar ?? metadata.menuZar ?? 0) || 0;
  const selectedMenu =
    metadata.selected_menu_items || metadata.selectedMenuItems || null;

  const payer = await db.user.findUnique({
    where: { id: String(userId) },
    select: {
      email: true,
      fullName: true,
      username: true,
      userProfile: { select: { username: true } },
    },
  });

  const vis = eventEndsAtFromEvent(event) || visibleUntilAfterEventDate(event.date);
  const eventStartsAt = eventStartsAtFromEvent(event);
  const eventEndsAt = eventEndsAtFromEvent(event);

  await issueTicketAndNotify(db, {
    userId: String(userId),
    email: payer?.email || email,
    paystackReference: reference,
    kind: 'EVENT_ENTRANCE',
    title: event.title,
    subtitle: 'Entrance pass',
    visibleUntil: vis,
    eventId: event.id,
    quantity: 1,
    holderDisplayName: holderDisplayNameFromUser(payer),
    tableSpecsSummary: menuZar > 0 ? `Entrance + menu (R${menuZar.toFixed(0)})` : 'Entrance only',
    eventStartsAt,
    eventEndsAt,
  });

  await upsertConfirmedAttendance(userId, event.id);

  await recordEventVenueTableBooking({
    venueId: event.venueId,
    eventId: event.id,
    userId: String(userId),
    role: 'ENTRANCE',
    paystackReference: reference,
    amountTotal: Number(amount) || entranceZar + menuZar,
    entranceZar,
    menuTotalZar: menuZar > 0 ? menuZar : null,
    selectedMenuItems: selectedMenu,
    componentZar: null,
  });

  const gross = Number(amount) || entranceZar + menuZar;
  if (gross > 0) {
    const { secAmount, recipientAmount } = splitSecPlatform(gross);
    const venueCode = await resolveRecipientCodeForVenue(event.venueId);
    await recordPayoutAndMaybeTransfer({
      paymentReference: reference,
      grossZar: gross,
      secAmount,
      recipientAmount,
      recipientType: 'VENUE',
      recipientVenueId: event.venueId,
      recipientUserId: null,
      paystackRecipientCode: venueCode,
    });
  }

  const promoterUserId = promoterUserIdFromMetadata(metadata);
  if (promoterUserId) {
    try {
      await recordPromoterConversion({
        eventId: event.id,
        promoterUserId,
        conversionType: 'TICKET_PURCHASE',
        buyerUserId: String(userId),
        amountZar: gross,
        paystackReference: reference,
      });
    } catch (e) {
      logger?.warn?.('promoter conversion for entrance failed', { message: e?.message });
    }
  }

  return { issued: true, eventId: event.id };
}

export { userHasPaidEventEntrance, computeEntranceCheckout };
