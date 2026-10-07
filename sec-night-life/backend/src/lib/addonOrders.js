/**
 * "Order more" menu add-ons placed after a guest already holds a ticket, entrance pass,
 * venue table pass or hosted table seat. Each add-on is its own Paystack payment,
 * its own venue order (OrderFulfillment kind MENU_ADDON) and its own order-only QR.
 */
import { prisma } from './prisma.js';
import { resolveVenueMenuSelections } from './menuHelpers.js';
import { serviceFeeForSubtotal, SERVICE_FEE_LINE_CODE, SERVICE_FEE_LABEL } from './serviceFee.js';
import { line } from './checkoutLines.js';
import { splitPlatformGross } from './platformSplit.js';
import {
  basePaymentReference,
  flattenPaymentMetadata,
} from './paymentMetadata.js';
import {
  eventHasEnded,
  ticketExpiresAtFromRow,
  eventStartsAtFromEvent,
  eventEndsAtFromEvent,
  eventStartsAtFromHostedTable,
  visibleUntilAfterHostedTable,
  holderDisplayNameFromUser,
} from './ticketHelpers.js';
import { ticketTierAllowsMenuAddons } from './ticketCheckout.js';
import { resolveVenueIdForHostedTable } from './venueTableHostAfterPayment.js';
import {
  recordPayoutAndMaybeTransfer,
  resolveRecipientCodeForVenue,
} from './paystackPayout.js';
import { issueTicketAndNotify } from './issueTicket.js';
import { createInAppNotification } from './inAppNotifications.js';
import { logger } from './logger.js';

export const MENU_ADDON_TYPE = 'MENU_ADDON';
export const MAX_ADDON_LINES = 30;
export const MAX_ADDON_QTY_PER_LINE = 50;
/** Unpaid add-on checkouts older than this are cancelled so they never block anything. */
export const ADDON_PENDING_TTL_MS = 2 * 60 * 60 * 1000;

const PARENT_TICKET_KINDS = {
  EVENT_TICKET: 'TICKET',
  EVENT_ENTRANCE: 'ENTRANCE',
  VENUE_TABLE_JOIN: 'VENUE_TABLE',
  HOSTED_TABLE_JOIN: 'HOSTED_TABLE',
  TABLE_HOST_FEE: 'HOSTED_TABLE',
};

function fail(status, error, code = undefined) {
  return { ok: false, status, error, ...(code ? { code } : {}) };
}

function itemsSummary(items, max = 3) {
  const list = Array.isArray(items) ? items : [];
  const head = list.slice(0, max).map((l) => `${l.quantity}× ${l.name}`);
  const rest = list.length - head.length;
  return rest > 0 ? `${head.join(', ')} +${rest} more` : head.join(', ');
}

async function parentPaymentRefunded(db, reference) {
  if (!reference) return false;
  const pay = await db.payment.findUnique({
    where: { reference: basePaymentReference(reference) },
    select: { refundStatus: true, refundedAt: true },
  });
  return Boolean(pay && (pay.refundedAt || pay.refundStatus === 'APPROVED' || pay.refundStatus === 'COMPLETED'));
}

async function resolveHostedTableParent(db, { userId, hostedTableId, ticket = null }) {
  const ht = await db.hostedTable.findFirst({
    where: { id: String(hostedTableId) },
    include: {
      event: { select: { id: true, venueId: true, title: true, date: true, startTime: true, endsAt: true, status: true } },
    },
  });
  if (!ht) return fail(404, 'Table not found');
  if (ht.status === 'CLOSED') return fail(409, 'This table session has ended.');
  if (ht.event && eventHasEnded(ht.event)) return fail(409, 'This event has ended.');
  const venueId = ht.event?.venueId || (await resolveVenueIdForHostedTable(db, ht));
  if (!venueId) return fail(400, 'Menu orders are only available for tables at a venue.');

  const member = await db.hostedTableMember.findUnique({
    where: { hostedTableId_userId: { hostedTableId: ht.id, userId: String(userId) } },
  });
  if (!member || member.status !== 'GOING') {
    return fail(403, 'You must be on this table before ordering more.');
  }
  if (ht.hasJoiningFee && Number(ht.joiningFee || 0) > 0 && member.userId !== ht.hostUserId) {
    const joinPaid = Number(member.joinFeePaid || 0) > 0 || Boolean(member.paystackReference);
    if (!joinPaid) return fail(403, 'Complete your join payment before ordering more.');
  }

  let parentTicket = ticket;
  if (!parentTicket) {
    parentTicket = await db.ticket.findFirst({
      where: {
        userId: String(userId),
        hostedTableId: ht.id,
        kind: { in: ['HOSTED_TABLE_JOIN', 'TABLE_HOST_FEE', 'VENUE_TABLE_JOIN'] },
        refundedAt: null,
        hiddenFromHistoryAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  const eventStartsAt = parentTicket?.eventStartsAt
    || (ht.event ? eventStartsAtFromEvent(ht.event) : eventStartsAtFromHostedTable(ht));
  const visibleUntil = parentTicket
    ? ticketExpiresAtFromRow(parentTicket)
    : ht.event
      ? eventEndsAtFromEvent(ht.event)
      : visibleUntilAfterHostedTable(ht);
  if (visibleUntil && visibleUntil.getTime() <= Date.now()) {
    return fail(409, 'This table booking has ended.');
  }

  // Hosted joins can be menu-only refunded while the seat stays valid, so the member status
  // (not the parent payment's refund flag) decides eligibility here.
  const parentReference =
    member.paystackReference || parentTicket?.paystackReference || ht.hostFeePaystackRef || `hosted-member:${member.id}`;

  return {
    ok: true,
    parent: {
      kind: 'HOSTED_TABLE',
      venueId,
      parentReference: basePaymentReference(parentReference),
      parentTicketId: parentTicket?.id || null,
      eventId: ht.event?.id || ht.eventId || null,
      venueTableId: parentTicket?.venueTableId || null,
      venueTableMemberId: null,
      hostedTableId: ht.id,
      hostedTableMemberId: member.id,
      label: ht.tableName || 'Your table',
      venueName: ht.venueName || null,
      visibleUntil,
      eventStartsAt,
      eventEndsAt: ht.event ? eventEndsAtFromEvent(ht.event) : null,
    },
  };
}

/**
 * Work out what the guest is adding to, and whether ordering more is still allowed.
 * @param {{ userId: string, ticketId?: string|null, hostedTableId?: string|null }} input
 */
export async function resolveAddonParent(db, { userId, ticketId = null, hostedTableId = null }) {
  if (!ticketId && !hostedTableId) return fail(400, 'Choose the ticket or table you want to order on.');

  if (!ticketId && hostedTableId) {
    return resolveHostedTableParent(db, { userId, hostedTableId });
  }

  const ticket = await db.ticket.findUnique({ where: { id: String(ticketId) } });
  if (!ticket || ticket.userId !== String(userId)) return fail(404, 'Ticket not found');
  if (ticket.kind === 'MENU_ADDON') {
    return fail(400, 'Order more from your original ticket or table pass, not from an add-on.');
  }
  const kind = PARENT_TICKET_KINDS[ticket.kind];
  if (!kind) return fail(400, 'You cannot order menu items on this kind of pass.');
  if (ticket.refundedAt) return fail(409, 'This pass was refunded, so you cannot order more on it.');
  if (ticket.hiddenFromHistoryAt) return fail(409, 'This pass is no longer active. Use your current pass.');
  if (ticketExpiresAtFromRow(ticket).getTime() <= Date.now()) {
    return fail(409, 'This pass has expired.');
  }
  if (await parentPaymentRefunded(db, ticket.paystackReference)) {
    return fail(409, 'This booking was refunded, so you cannot order more on it.');
  }

  if (kind === 'HOSTED_TABLE') {
    if (!ticket.hostedTableId) return fail(400, 'This pass is not linked to a table.');
    return resolveHostedTableParent(db, { userId, hostedTableId: ticket.hostedTableId, ticket });
  }

  if (kind === 'VENUE_TABLE') {
    if (!ticket.venueTableId) return fail(400, 'This pass is not linked to a table.');
    const vt = await db.venueTable.findUnique({
      where: { id: ticket.venueTableId },
      select: { id: true, venueId: true, tableName: true, eventId: true, venue: { select: { name: true, deletedAt: true } } },
    });
    if (!vt || vt.venue?.deletedAt) return fail(404, 'Table not found');
    const member = await db.venueTableMember.findUnique({
      where: { venueTableId_userId: { venueTableId: vt.id, userId: String(userId) } },
      select: { id: true, status: true },
    });
    if (!member || member.status !== 'CONFIRMED') {
      return fail(409, 'This table session was ended, so you cannot order more on it.');
    }
    let eventEndsAt = null;
    const eventId = ticket.eventId || vt.eventId || null;
    if (eventId) {
      const ev = await db.event.findUnique({
        where: { id: eventId },
        select: { date: true, startTime: true, endsAt: true },
      });
      if (ev && eventHasEnded(ev)) return fail(409, 'This event has ended.');
      eventEndsAt = ev ? eventEndsAtFromEvent(ev) : null;
    }
    return {
      ok: true,
      parent: {
        kind,
        venueId: vt.venueId,
        parentReference: basePaymentReference(ticket.paystackReference),
        parentTicketId: ticket.id,
        eventId,
        venueTableId: vt.id,
        venueTableMemberId: member.id,
        hostedTableId: ticket.hostedTableId || null,
        hostedTableMemberId: null,
        label: vt.tableName || 'Your table',
        venueName: vt.venue?.name || null,
        visibleUntil: ticketExpiresAtFromRow(ticket),
        eventStartsAt: ticket.eventStartsAt,
        eventEndsAt,
      },
    };
  }

  // Event ticket or entrance pass.
  if (!ticket.eventId) return fail(400, 'This pass is not linked to an event.');
  const event = await db.event.findFirst({
    where: { id: ticket.eventId, deletedAt: null },
    select: {
      id: true,
      title: true,
      venueId: true,
      date: true,
      startTime: true,
      endsAt: true,
      status: true,
      ticketTiers: true,
      allowsTicketMenuAddons: true,
      venue: { select: { name: true, deletedAt: true } },
    },
  });
  if (!event || !event.venueId || event.venue?.deletedAt) return fail(404, 'Event not found');
  if (event.status && event.status !== 'published') return fail(409, 'This event is no longer available.');
  if (eventHasEnded(event)) return fail(409, 'This event has ended.');
  if (kind === 'TICKET') {
    const tiers = Array.isArray(event.ticketTiers) ? event.ticketTiers : [];
    const tier = tiers.find((t) => t?.name === ticket.subtitle) || null;
    if (!ticketTierAllowsMenuAddons(tier, event)) {
      return fail(403, 'Menu add-ons are not available for this ticket.');
    }
  }
  return {
    ok: true,
    parent: {
      kind,
      venueId: event.venueId,
      parentReference: basePaymentReference(ticket.paystackReference),
      parentTicketId: ticket.id,
      eventId: event.id,
      venueTableId: null,
      venueTableMemberId: null,
      hostedTableId: null,
      hostedTableMemberId: null,
      label: event.title || 'Your ticket',
      venueName: event.venue?.name || null,
      visibleUntil: ticketExpiresAtFromRow(ticket),
      eventStartsAt: ticket.eventStartsAt || eventStartsAtFromEvent(event),
      eventEndsAt: eventEndsAtFromEvent(event),
    },
  };
}

export function normalizeAddonSelections(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const merged = new Map();
  for (const sel of list) {
    const id = String(sel?.menuItemId || sel?.menu_item_id || sel?.id || '').trim();
    const qty = Math.floor(Number(sel?.quantity) || 0);
    if (!id || qty <= 0) continue;
    merged.set(id, Math.min(MAX_ADDON_QTY_PER_LINE, (merged.get(id) || 0) + qty));
  }
  return Array.from(merged.entries())
    .slice(0, MAX_ADDON_LINES)
    .map(([menuItemId, quantity]) => ({ menuItemId, quantity }));
}

/** Server-side pricing for an add-on (special prices honoured; hidden or deleted items rejected). */
export async function computeAddonCheckout(db, { userId, ticketId, hostedTableId, selectedMenuItems }) {
  const parentRes = await resolveAddonParent(db, { userId, ticketId, hostedTableId });
  if (!parentRes.ok) return parentRes;
  const selections = normalizeAddonSelections(selectedMenuItems);
  if (!selections.length) return fail(400, 'Select at least one menu item.');
  let resolved;
  try {
    resolved = await resolveVenueMenuSelections(selections, parentRes.parent.venueId, { guestVisibleOnly: true });
  } catch (e) {
    return fail(400, 'Some items are no longer on the menu. Refresh the menu and try again.');
  }
  const subtotal = Number(resolved.totalZar || 0);
  if (subtotal <= 0) return fail(400, 'Select at least one menu item.');
  const serviceFee = serviceFeeForSubtotal(subtotal);
  const total = Math.round((subtotal + serviceFee) * 100) / 100;
  const lines = [line('menu', 'Menu add-on', subtotal)];
  if (serviceFee > 0) lines.push(line(SERVICE_FEE_LINE_CODE, SERVICE_FEE_LABEL, serviceFee));
  return {
    ok: true,
    parent: parentRes.parent,
    items: resolved.items,
    subtotal,
    serviceFee,
    total,
    lines,
  };
}

export function buildAddonPaymentMetadata({ userId, computed }) {
  const p = computed.parent;
  const { secAmount, recipientAmount } = splitPlatformGross(computed.subtotal);
  return {
    type: MENU_ADDON_TYPE,
    user_id: userId,
    venue_id: p.venueId,
    parent_kind: p.kind,
    parent_reference: p.parentReference,
    parent_ticket_id: p.parentTicketId || undefined,
    event_id: p.eventId || undefined,
    venue_table_id: p.venueTableId || undefined,
    hosted_table_id: p.hostedTableId || undefined,
    is_day_booking: !p.eventId,
    menu_zar: computed.subtotal,
    subtotal_zar: computed.subtotal,
    service_fee_zar: computed.serviceFee,
    amount_total_zar: computed.total,
    platform_fee_zar: secAmount,
    venue_share_zar: recipientAmount,
    selected_menu_items: computed.items,
    lines: computed.lines,
  };
}

/** Persist the pending add-on row for a freshly initialized Paystack reference. */
export async function createPendingAddonOrder(db, { reference, userId, computed }) {
  const p = computed.parent;
  return db.menuAddonOrder.create({
    data: {
      paystackReference: reference,
      userId: String(userId),
      venueId: p.venueId,
      parentKind: p.kind,
      parentReference: p.parentReference,
      parentTicketId: p.parentTicketId,
      eventId: p.eventId,
      venueTableId: p.venueTableId,
      venueTableMemberId: p.venueTableMemberId,
      hostedTableId: p.hostedTableId,
      hostedTableMemberId: p.hostedTableMemberId,
      items: computed.items,
      subtotalZar: computed.subtotal,
      serviceFeeZar: computed.serviceFee,
      totalZar: computed.total,
    },
  });
}

/** Cancel this user's stale unpaid add-on checkouts (never touches paid rows). */
export async function cancelStalePendingAddons(db, userId) {
  const cutoff = new Date(Date.now() - ADDON_PENDING_TTL_MS);
  await db.menuAddonOrder.updateMany({
    where: { userId: String(userId), status: 'PENDING_PAYMENT', createdAt: { lt: cutoff } },
    data: { status: 'CANCELLED' },
  });
}

/**
 * Paystack success side effects for a MENU_ADDON payment. Safe to run more than once.
 * @returns {Promise<{ applied: boolean, reason?: string }>}
 */
export async function applyMenuAddonPayment({ reference, chargedAmountZar, metadata = {}, email = null }) {
  const addon = await prisma.menuAddonOrder.findUnique({ where: { paystackReference: reference } });
  if (!addon) {
    logger.error('MENU_ADDON payment without add-on row', { reference });
    return { applied: false, reason: 'missing_addon_row' };
  }
  if (addon.status === 'REFUNDED') return { applied: false, reason: 'refunded' };

  if (chargedAmountZar != null && Math.abs(Number(chargedAmountZar) - Number(addon.totalZar)) >= 0.02) {
    logger.error('MENU_ADDON amount mismatch', {
      reference,
      charged: chargedAmountZar,
      expected: addon.totalZar,
    });
    return { applied: false, reason: 'amount_mismatch' };
  }

  // PENDING_PAYMENT (or CANCELLED by the stale sweep while Paystack was still settling) → PAID exactly once.
  await prisma.$transaction(async (tx) => {
    const moved = await tx.menuAddonOrder.updateMany({
      where: { id: addon.id, status: { in: ['PENDING_PAYMENT', 'CANCELLED'] } },
      data: { status: 'PAID', paidAt: new Date() },
    });
    // Table-level min-spend progress only; member menuSpendPaid stays the join-time menu so
    // analytics and receipts (which read it) do not double count the add-on's own ledger row.
    if (moved.count === 1 && addon.hostedTableId) {
      await tx.hostedTable.updateMany({
        where: { id: addon.hostedTableId },
        data: { menuSpendTotal: { increment: addon.subtotalZar } },
      });
    }
  });

  const { secAmount, recipientAmount } = splitPlatformGross(addon.subtotalZar);
  const venueCode = await resolveRecipientCodeForVenue(addon.venueId);
  await recordPayoutAndMaybeTransfer({
    paymentReference: reference,
    grossZar: addon.subtotalZar,
    secAmount,
    recipientAmount,
    recipientType: 'VENUE',
    recipientVenueId: addon.venueId,
    recipientUserId: null,
    paystackRecipientCode: venueCode,
  });

  const [payer, venue, parentTicket] = await Promise.all([
    prisma.user.findUnique({
      where: { id: addon.userId },
      select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
    }),
    prisma.venue.findUnique({ where: { id: addon.venueId }, select: { name: true, ownerUserId: true } }),
    addon.parentTicketId ? prisma.ticket.findUnique({ where: { id: addon.parentTicketId } }) : null,
  ]);

  const items = Array.isArray(addon.items) ? addon.items : [];
  const parentLabel = parentTicket?.title || metadata.parent_label || 'your booking';
  const ticket = await issueTicketAndNotify(prisma, {
    userId: addon.userId,
    email: email || payer?.email || null,
    paystackReference: reference,
    kind: 'MENU_ADDON',
    title: `Add-on order — ${venue?.name || 'Venue'}`,
    subtitle: itemsSummary(items),
    visibleUntil: parentTicket
      ? ticketExpiresAtFromRow(parentTicket)
      : new Date(Date.now() + 24 * 60 * 60 * 1000),
    eventId: addon.eventId,
    venueTableId: addon.venueTableId,
    hostedTableId: addon.hostedTableId,
    quantity: 1,
    holderDisplayName: holderDisplayNameFromUser(payer),
    tableSpecsSummary: `Order only (not an entry pass) · for ${parentLabel}`,
    eventStartsAt: parentTicket?.eventStartsAt || null,
    skipNotification: true,
  });
  if (ticket && addon.ticketId !== ticket.id) {
    await prisma.menuAddonOrder.update({ where: { id: addon.id }, data: { ticketId: ticket.id } });
  }

  if (!addon.paidAt) {
    await createInAppNotification({
      userId: addon.userId,
      type: 'TABLE_JOINED',
      title: 'Add-on order confirmed',
      body: `${itemsSummary(items)}. Show the add-on QR to staff when you collect your order.`,
      referenceId: ticket?.id || addon.id,
      referenceType: 'TICKET',
    }).catch(() => {});
    if (venue?.ownerUserId) {
      await createInAppNotification({
        userId: venue.ownerUserId,
        type: 'TABLE_JOINED',
        title: 'New add-on order',
        body: `${holderDisplayNameFromUser(payer)} ordered more: ${itemsSummary(items)}.`,
        referenceId: `/BusinessBookings?venueId=${addon.venueId}&tab=orders`,
        referenceType: 'ROUTE',
      }).catch(() => {});
    }
  }

  return { applied: true };
}

/** Fulfilment check used by the payment repair path. */
export async function isMenuAddonFulfilled(db, reference) {
  const addon = await db.menuAddonOrder.findUnique({
    where: { paystackReference: reference },
    select: { status: true },
  });
  if (!addon) return false;
  if (addon.status === 'REFUNDED') return true;
  if (addon.status !== 'PAID') return false;
  const [ticket, ledger] = await Promise.all([
    db.ticket.findUnique({ where: { paystackReference: reference }, select: { id: true } }),
    db.payoutLedger.findUnique({ where: { paymentReference: reference }, select: { id: true } }),
  ]);
  return Boolean(ticket && ledger);
}

export function formatAddonOrder(addon, { ticket = null, fulfillment = null } = {}) {
  const fulfilled = Boolean(fulfillment && !fulfillment.undoneAt);
  return {
    id: addon.id,
    reference: addon.paystackReference,
    status: addon.status,
    parent_kind: addon.parentKind,
    parent_reference: addon.parentReference,
    parent_ticket_id: addon.parentTicketId,
    venue_id: addon.venueId,
    event_id: addon.eventId,
    venue_table_id: addon.venueTableId,
    hosted_table_id: addon.hostedTableId,
    items: Array.isArray(addon.items) ? addon.items : [],
    items_summary: itemsSummary(addon.items, 5),
    subtotal_zar: addon.subtotalZar,
    service_fee_zar: addon.serviceFeeZar,
    total_zar: addon.totalZar,
    paid_at: addon.paidAt,
    refunded_at: addon.refundedAt,
    created_at: addon.createdAt,
    fulfilled,
    fulfilled_at: fulfilled ? fulfillment.fulfilledAt : null,
    ticket: ticket
      ? { id: ticket.id, qr_token: ticket.qrToken, title: ticket.title, kind: ticket.kind }
      : null,
  };
}

/** Paid / refunded add-ons hanging off one parent purchase (for the guest or door staff). */
export async function listAddonsForParent(
  db,
  { parentTicketId = null, parentReference = null, hostedTableId = null, userId = null },
) {
  const or = [];
  if (parentTicketId) or.push({ parentTicketId: String(parentTicketId) });
  if (parentReference) or.push({ parentReference: basePaymentReference(String(parentReference)) });
  if (hostedTableId && userId) or.push({ hostedTableId: String(hostedTableId) });
  if (!or.length) return [];
  const rows = await db.menuAddonOrder.findMany({
    where: {
      OR: or,
      status: { in: ['PAID', 'REFUNDED'] },
      ...(userId ? { userId: String(userId) } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!rows.length) return [];
  const refs = rows.map((r) => r.paystackReference);
  const [tickets, fulfillments] = await Promise.all([
    db.ticket.findMany({ where: { paystackReference: { in: refs } } }),
    db.orderFulfillment.findMany({ where: { paystackReference: { in: refs } } }),
  ]);
  const tByRef = new Map(tickets.map((t) => [t.paystackReference, t]));
  const fByRef = new Map(fulfillments.map((f) => [f.paystackReference, f]));
  return rows.map((r) =>
    formatAddonOrder(r, { ticket: tByRef.get(r.paystackReference), fulfillment: fByRef.get(r.paystackReference) }),
  );
}

export function isMenuAddonMeta(meta) {
  return String(flattenPaymentMetadata(meta)?.type || '') === MENU_ADDON_TYPE;
}
