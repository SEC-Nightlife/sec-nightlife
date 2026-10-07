import { prisma } from './prisma.js';
import { splitPlatformGross, splitTicketCheckoutAmounts } from './platformSplit.js';
import {
  basePaymentReference,
  flattenPaymentMetadata,
  isHostedTableVenuePayment,
  isTicketPaymentMeta,
} from './paymentMetadata.js';
import { releaseVenueTableSlot, releaseVenueTableSlotForHostRefund } from './venueTableSlotRelease.js';
import {
  normalizeTicketTiers,
  ticketReferencesForPayment,
} from './issueEventTickets.js';
import { createNotification } from './notifications.js';
import { sendEmail } from './email.js';
import { logger } from './logger.js';
import { hideParticipationForRefund } from './tableHistory.js';
import { appendVenueTableRefundNotice } from './venueTableRefundNotice.js';
import { netOfServiceFee } from './serviceFee.js';

const ELIGIBLE_META_TYPES = new Set(['TABLE_CHECKOUT', 'VENUE_TABLE_JOIN', 'ticket', 'event', 'table']);
const EXCLUDED_META_TYPES = new Set([
  'TABLE_HOST_FEE',
  'HOSTED_TABLE_EXTERNAL_LISTING',
  'HOSTED_TABLE_JOIN',
  'TABLE_BOOST',
  'EVENT_BOOST',
  'VENUE_TABLE_BOOST',
  'HOUSE_PARTY_ENTRANCE',
  'HOUSE_PARTY_PUBLISH',
  'HOUSE_PARTY_BOOST',
  'promotion',
  'BOOST',
]);

/**
 * Default refund split uses the standard 15/85 platform rate.
 * Pass payment metadata for ticket purchases so stored 4% ticket + 15% menu fees are respected.
 */
export function computeRefundAmounts(grossZar, metadata = null) {
  const meta = metadata && typeof metadata === 'object' ? metadata : null;
  if (meta && (meta.type === 'ticket' || meta.type === 'event')) {
    if (meta.platform_fee_zar != null && meta.venue_share_zar != null) {
      const platformFeeKeptZar = Math.round(Number(meta.platform_fee_zar) * 100) / 100;
      const venueRefundDueZar = Math.round(Number(meta.venue_share_zar) * 100) / 100;
      const gross =
        Math.round((Number(grossZar) || platformFeeKeptZar + venueRefundDueZar) * 100) / 100;
      return {
        grossAmountZar: gross,
        venueRefundDueZar,
        platformFeeKeptZar,
      };
    }
    if (meta.ticket_subtotal_zar != null || meta.menu_zar != null || meta.menu_total_zar != null) {
      const ticketSub = Number(meta.ticket_subtotal_zar ?? grossZar) || 0;
      const menuSub = Number(meta.menu_total_zar ?? meta.menu_zar ?? 0) || 0;
      const split = splitTicketCheckoutAmounts(ticketSub, menuSub);
      return {
        grossAmountZar: split.gross || Math.round((Number(grossZar) || 0) * 100) / 100,
        venueRefundDueZar: split.recipientAmount,
        platformFeeKeptZar: split.secAmount,
      };
    }
  }
  const { gross, secAmount, recipientAmount } = splitPlatformGross(grossZar);
  return {
    grossAmountZar: gross,
    venueRefundDueZar: recipientAmount,
    platformFeeKeptZar: secAmount,
  };
}

export function isRefundedPaymentRef(ref, refundedRefs) {
  if (!ref || !refundedRefs) return false;
  const base = basePaymentReference(String(ref));
  return refundedRefs.has(String(ref)) || refundedRefs.has(base);
}

export function shouldCountPaymentTowardRevenue(ref, refundedRefs) {
  return Boolean(ref) && !isRefundedPaymentRef(ref, refundedRefs);
}

/** Load base Paystack refs with APPROVED refund for venue(s). */
export async function loadRefundedPaymentRefs(venueIds) {
  const ids = Array.isArray(venueIds) ? venueIds.filter(Boolean) : venueIds ? [venueIds] : [];
  if (!ids.length) return new Set();

  const rows = await prisma.refundRequest.findMany({
    where: {
      venueId: ids.length === 1 ? ids[0] : { in: ids },
      status: { in: ['APPROVED', 'PAID_BY_VENUE'] },
    },
    select: { paymentReference: true },
    take: 10000,
  });

  const refs = new Set();
  for (const r of rows) {
    if (r.paymentReference) {
      refs.add(r.paymentReference);
      refs.add(basePaymentReference(r.paymentReference));
    }
  }

  // Venue-scoped payment refunds only (avoid scanning all platform refunds).
  try {
    const venuePaymentOr = ids.flatMap((vid) => [
      { metadata: { path: ['venue_id'], equals: vid } },
      { metadata: { path: ['venueId'], equals: vid } },
    ]);
    const payments = await prisma.payment.findMany({
      where: {
        refundStatus: 'APPROVED',
        status: 'success',
        OR: venuePaymentOr,
      },
      select: { reference: true },
      take: 5000,
    });

    for (const p of payments) {
      if (p.reference) {
        refs.add(p.reference);
        refs.add(basePaymentReference(p.reference));
      }
    }
  } catch (e) {
    logger.warn('loadRefundedPaymentRefs payment scan failed', { err: e?.message });
  }

  return refs;
}

/** Sum refunded amounts approved within a period (for analytics transparency). */
export async function loadRefundedMetricsForPeriod(venueIds, since) {
  const ids = Array.isArray(venueIds) ? venueIds.filter(Boolean) : venueIds ? [venueIds] : [];
  if (!ids.length || !since) return { refundedGrossZar: 0, refundedVenueShareZar: 0 };

  const rows = await prisma.refundRequest.findMany({
    where: {
      venueId: ids.length === 1 ? ids[0] : { in: ids },
      status: { in: ['APPROVED', 'PAID_BY_VENUE'] },
      approvedAt: { gte: since },
    },
    select: { grossAmountZar: true, venueRefundDueZar: true },
    take: 10000,
  });

  return rows.reduce(
    (acc, r) => ({
      refundedGrossZar: acc.refundedGrossZar + (Number(r.grossAmountZar) || 0),
      refundedVenueShareZar: acc.refundedVenueShareZar + (Number(r.venueRefundDueZar) || 0),
    }),
    { refundedGrossZar: 0, refundedVenueShareZar: 0 },
  );
}

function resolveRefundType(meta, paymentType, memberRole) {
  const mtype = String(meta.type || paymentType || '');
  if (mtype === 'MENU_ADDON') return 'MENU_ADDON';
  if (mtype === 'HOSTED_TABLE_MENU') return 'HOSTED_TABLE_MENU';
  if (isTicketPaymentMeta(meta, paymentType)) return 'TICKET';
  const role = memberRole || meta.member_role || meta.memberRole;
  if (role === 'HOST' || meta.booking_mode === 'host' || meta.booking_mode === 'custom_host') {
    return 'TABLE_HOST';
  }
  return 'TABLE_JOIN';
}

async function resolveVenueTableMemberForRefund({ userId, payment, baseRef, meta }) {
  const memberInclude = { venueTable: { select: { id: true, eventId: true, venueId: true } } };
  let venueTableMember = await prisma.venueTableMember.findFirst({
    where: {
      userId,
      paystackReference: { in: [payment.reference, baseRef] },
    },
    include: memberInclude,
  });

  if (!venueTableMember) {
    const memberId = meta.venue_table_member_id ?? meta.venueTableMemberId;
    if (memberId) {
      venueTableMember = await prisma.venueTableMember.findFirst({
        where: { id: String(memberId), userId },
        include: memberInclude,
      });
    }
  }

  if (!venueTableMember) {
    const venueTableId = meta.venue_table_id ?? meta.venueTableId;
    const bookingMode = meta.booking_mode ?? meta.bookingMode;
    const isHost = bookingMode === 'host' || bookingMode === 'custom_host' || meta.member_role === 'HOST';
    if (venueTableId && isHost) {
      venueTableMember = await prisma.venueTableMember.findFirst({
        where: {
          userId,
          venueTableId: String(venueTableId),
          memberRole: 'HOST',
          status: { in: ['CONFIRMED', 'LEFT', 'REFUNDED'] },
        },
        orderBy: { paidAt: 'desc' },
        include: memberInclude,
      });
    }
  }

  return venueTableMember;
}

function isFreePaymentReference(ref) {
  return !ref || String(ref).startsWith('free_');
}

async function paymentHasFulfillmentProof({ userId, reference, baseRef }) {
  if (isFreePaymentReference(reference)) return false;
  const refs = [...new Set([reference, baseRef].filter(Boolean))];
  const member = await prisma.venueTableMember.findFirst({
    where: {
      userId,
      paystackReference: { in: refs },
      status: 'CONFIRMED',
    },
  });
  if (member) return true;
  const ticket = await prisma.ticket.findFirst({
    where: {
      userId,
      paystackReference: { in: refs },
      refundedAt: null,
      hiddenFromHistoryAt: null,
    },
  });
  return Boolean(ticket);
}

/**
 * Load a payment for refund flows. Only successful Paystack-settled payments qualify.
 * Does not promote pending → success based on fulfillment proof alone.
 * @param {{ userId: string, reference: string }} opts
 */
export async function resolvePaymentForRefund({ userId, reference }) {
  const trimmed = String(reference || '').trim();
  if (!trimmed || isFreePaymentReference(trimmed)) return null;

  const baseRef = basePaymentReference(trimmed);
  const payment = await prisma.payment.findFirst({
    where: {
      userId,
      OR: [{ reference: trimmed }, { reference: baseRef }],
    },
  });
  if (!payment) return null;
  if (payment.status === 'success') return payment;
  return null;
}

function subtractMenuItems(existingItems, removeItems) {
  const existing = Array.isArray(existingItems) ? existingItems : [];
  const remove = Array.isArray(removeItems) ? removeItems : [];
  if (!remove.length) return existing;
  const result = existing.map((row) => ({ ...row }));
  for (const rem of remove) {
    const id = rem.menuItemId || rem.menu_item_id;
    const qty = Number(rem.quantity) || 0;
    if (!id || qty <= 0) continue;
    const idx = result.findIndex((r) => (r.menuItemId || r.menu_item_id) === id);
    if (idx < 0) continue;
    const nextQty = Math.max(0, (Number(result[idx].quantity) || 0) - qty);
    if (nextQty <= 0) result.splice(idx, 1);
    else result[idx] = { ...result[idx], quantity: nextQty };
  }
  return result;
}

async function applyHostedMenuRefundEffects(tx, {
  req,
  baseRef,
  now,
  meta,
  memberId,
  hostedTableId,
}) {
  const menuItems = Array.isArray(meta.selected_menu_items)
    ? meta.selected_menu_items
    : Array.isArray(meta.selectedMenuItems)
      ? meta.selectedMenuItems
      : [];
  const menuGross = Number(meta.menu_zar ?? req.grossAmountZar ?? 0);

  if (memberId && hostedTableId) {
    const member = await tx.hostedTableMember.findUnique({ where: { id: memberId } });
    if (member) {
      const nextItems = menuItems.length
        ? subtractMenuItems(member.selectedMenuItems, menuItems)
        : [];
      const nextMenuPaid = Math.max(0, Number(member.menuSpendPaid || 0) - menuGross);
      await tx.hostedTableMember.update({
        where: { id: member.id },
        data: {
          selectedMenuItems: nextItems.length ? nextItems : null,
          menuSpendPaid: nextMenuPaid,
        },
      });
      if (menuGross > 0) {
        await tx.hostedTable.update({
          where: { id: hostedTableId },
          data: { menuSpendTotal: { decrement: menuGross } },
        });
      }
    }
  }

  await tx.ticket.updateMany({
    where: {
      userId: req.userId,
      ...(hostedTableId ? { hostedTableId } : {}),
      refundedAt: null,
      title: { contains: 'menu order', mode: 'insensitive' },
      OR: [
        { paystackReference: baseRef },
        { paystackReference: { startsWith: `${baseRef}-` } },
      ],
    },
    data: { refundedAt: now, refundRequestId: req.id },
  });
}

export async function validateRefundEligibility({ payment, userId, userWalletCode }) {
  if (!payment) return { ok: false, error: 'Payment not found', status: 404 };
  if (payment.userId !== userId) return { ok: false, error: 'Forbidden', status: 403 };
  if (payment.status !== 'success') return { ok: false, error: 'Only successful payments can be refunded', status: 400 };
  if (payment.refundStatus === 'APPROVED') {
    return { ok: false, error: 'This payment has already been refunded', status: 400 };
  }
  if (payment.refundStatus === 'PENDING') {
    return { ok: false, error: 'A refund request is already pending for this payment', status: 409 };
  }

  const meta = flattenPaymentMetadata(payment.metadata);
  const mtype = String(meta.type || payment.type || '');

  if (mtype === 'MENU_ADDON') {
    const baseRef = basePaymentReference(payment.reference);
    const addon = await prisma.menuAddonOrder.findUnique({ where: { paystackReference: baseRef } });
    if (!addon || addon.userId !== userId) return { ok: false, error: 'Add-on order not found', status: 404 };
    if (addon.status !== 'PAID') {
      return { ok: false, error: 'Only paid add-on orders can be refunded', status: 400 };
    }
    const served = await prisma.orderFulfillment.findUnique({ where: { paystackReference: baseRef } });
    if (served && !served.undoneAt) {
      return {
        ok: false,
        error: 'The venue already marked this add-on as served. Contact the venue if something was wrong.',
        status: 400,
      };
    }
    const walletCodeInput = String(userWalletCode || '').trim().toUpperCase();
    if (walletCodeInput !== 'SKIP') {
      const wallet = await prisma.secWallet.findFirst({
        where: { walletCode: walletCodeInput, ownerType: 'USER', userId },
      });
      if (!wallet) {
        return { ok: false, error: 'Invalid Sec Wallet ID — use your wallet code from Profile', status: 400 };
      }
    }
    const pending = await prisma.refundRequest.findFirst({
      where: { userId, paymentReference: baseRef, status: 'PENDING' },
    });
    if (pending) return { ok: false, error: 'You already have a pending refund request for this payment', status: 409 };
    return {
      ok: true,
      venueId: addon.venueId,
      baseRef,
      refundType: 'MENU_ADDON',
      grossAmountZar: Number(addon.subtotalZar || 0),
      meta,
      venueTableMember: null,
      venueTableId: null,
      hostedTableMemberId: null,
      hostedTableId: null,
      eventId: addon.eventId || null,
      ticketIds: addon.ticketId ? [addon.ticketId] : [],
      walletCode: walletCodeInput !== 'SKIP' ? walletCodeInput : null,
    };
  }

  if (mtype === 'HOSTED_TABLE_JOIN') {
    const menuZar = Number(meta.menu_zar || 0);
    if (menuZar <= 0) {
      return {
        ok: false,
        error: 'Joining fee and entrance fees are not eligible for refund',
        status: 400,
      };
    }
    const venueId = meta.venue_id ?? meta.venueId;
    if (!venueId) return { ok: false, error: 'Could not determine venue for this payment', status: 400 };
    const baseRef = basePaymentReference(payment.reference);
    const walletCodeInput = String(userWalletCode || '').trim().toUpperCase();
    if (walletCodeInput !== 'SKIP') {
      const wallet = await prisma.secWallet.findFirst({
        where: { walletCode: walletCodeInput, ownerType: 'USER', userId },
      });
      if (!wallet) {
        return { ok: false, error: 'Invalid Sec Wallet ID — use your wallet code from Profile', status: 400 };
      }
    }
    const pending = await prisma.refundRequest.findFirst({
      where: { userId, paymentReference: baseRef, status: 'PENDING' },
    });
    if (pending) return { ok: false, error: 'You already have a pending refund request for this payment', status: 409 };
    return {
      ok: true,
      venueId: String(venueId),
      baseRef,
      refundType: 'HOSTED_TABLE_MENU',
      grossAmountZar: menuZar,
      meta,
      venueTableMember: null,
      venueTableId: meta.venue_table_id ?? meta.venueTableId ?? null,
      hostedTableMemberId: meta.hosted_table_member_id ?? meta.hostedTableMemberId ?? null,
      hostedTableId: meta.hosted_table_id ?? meta.hostedTableId ?? null,
      eventId: meta.event_id ?? meta.eventId ?? null,
      ticketIds: [],
      walletCode: walletCodeInput !== 'SKIP' ? walletCodeInput : null,
      partialMenuOnly: true,
    };
  }

  if (mtype === 'HOSTED_TABLE_MENU') {
    const venueId = meta.venue_id ?? meta.venueId;
    if (!venueId) return { ok: false, error: 'Could not determine venue for this payment', status: 400 };
    const baseRef = basePaymentReference(payment.reference);
    const walletCodeInput = String(userWalletCode || '').trim().toUpperCase();
    if (walletCodeInput !== 'SKIP') {
      const wallet = await prisma.secWallet.findFirst({
        where: { walletCode: walletCodeInput, ownerType: 'USER', userId },
      });
      if (!wallet) {
        return { ok: false, error: 'Invalid Sec Wallet ID — use your wallet code from Profile', status: 400 };
      }
    }
    const pending = await prisma.refundRequest.findFirst({
      where: { userId, paymentReference: baseRef, status: 'PENDING' },
    });
    if (pending) return { ok: false, error: 'You already have a pending refund request for this payment', status: 409 };
    return {
      ok: true,
      venueId: String(venueId),
      baseRef,
      refundType: 'HOSTED_TABLE_MENU',
      grossAmountZar: netOfServiceFee(meta, payment.amount) || Number(meta.menu_zar || 0),
      meta,
      venueTableMember: null,
      venueTableId: meta.venue_table_id ?? meta.venueTableId ?? null,
      hostedTableMemberId: meta.hosted_table_member_id ?? meta.hostedTableMemberId ?? null,
      hostedTableId: meta.hosted_table_id ?? meta.hostedTableId ?? null,
      eventId: meta.event_id ?? meta.eventId ?? null,
      ticketIds: [],
      walletCode: walletCodeInput !== 'SKIP' ? walletCodeInput : null,
    };
  }

  if (EXCLUDED_META_TYPES.has(mtype)) {
    return { ok: false, error: 'This payment type is not eligible for refund', status: 400 };
  }
  if (isHostedTableVenuePayment(meta) && mtype !== 'TABLE_CHECKOUT' && mtype !== 'VENUE_TABLE_JOIN' && mtype !== 'HOSTED_TABLE_MENU') {
    return { ok: false, error: 'This payment type is not eligible for refund', status: 400 };
  }
  if (
    !ELIGIBLE_META_TYPES.has(mtype) &&
    !isTicketPaymentMeta(meta, payment.type) &&
    mtype !== 'TABLE_CHECKOUT' &&
    mtype !== 'VENUE_TABLE_JOIN' &&
    mtype !== 'HOSTED_TABLE_MENU'
  ) {
    return { ok: false, error: 'This payment type is not eligible for refund', status: 400 };
  }

  const venueId = meta.venue_id ?? meta.venueId;
  if (!venueId) return { ok: false, error: 'Could not determine venue for this payment', status: 400 };

  const baseRef = basePaymentReference(payment.reference);

  const pending = await prisma.refundRequest.findFirst({
    where: {
      userId,
      paymentReference: baseRef,
      status: 'PENDING',
    },
  });
  if (pending) return { ok: false, error: 'You already have a pending refund request for this payment', status: 409 };

  const walletCodeInput = String(userWalletCode || '').trim().toUpperCase();
  if (walletCodeInput !== 'SKIP') {
    const wallet = await prisma.secWallet.findFirst({
      where: {
        walletCode: walletCodeInput,
        ownerType: 'USER',
        userId,
      },
    });
    if (!wallet) {
      return { ok: false, error: 'Invalid Sec Wallet ID — use your wallet code from Profile', status: 400 };
    }
  }

  const resolvedWalletCode = walletCodeInput !== 'SKIP' ? walletCodeInput : null;

  const venueTableMember = await resolveVenueTableMemberForRefund({
    userId,
    payment,
    baseRef,
    meta,
  });

  const refundType = resolveRefundType(meta, payment.type, venueTableMember?.memberRole);

  let ticketIds = [];
  let eventId = meta.event_id ?? meta.eventId ?? venueTableMember?.venueTable?.eventId ?? null;

  if (refundType === 'TICKET') {
    const qty = Math.max(1, parseInt(String(meta.quantity || '1'), 10) || 1);
    const refs = ticketReferencesForPayment(baseRef, qty);
    const tickets = await prisma.ticket.findMany({
      where: {
        paystackReference: { in: refs },
        userId,
        refundedAt: null,
      },
      select: { id: true, subtitle: true, eventId: true },
    });
    if (!tickets.length) {
      return { ok: false, error: 'No active tickets found for this payment', status: 400 };
    }
    ticketIds = tickets.map((t) => t.id);
    eventId = eventId || tickets[0]?.eventId || null;
  }

  return {
    ok: true,
    venueId: String(venueId),
    baseRef,
    refundType,
    meta,
    venueTableMember,
    venueTableId: venueTableMember?.venueTableId ?? meta.venue_table_id ?? meta.venueTableId ?? null,
    eventId: eventId ? String(eventId) : null,
    ticketIds,
    walletCode: resolvedWalletCode,
  };
}

export async function restoreTicketTierInventory(tx, eventId, ticketTier) {
  if (!eventId || !ticketTier) return;
  const event = await tx.event.findUnique({ where: { id: eventId }, select: { ticketTiers: true } });
  if (!event) return;
  const tiers = normalizeTicketTiers(event.ticketTiers);
  const tierRow = tiers.find((t) => t.name === ticketTier);
  if (!tierRow) return;

  const actualCount = await tx.ticket.count({
    where: {
      eventId,
      kind: 'EVENT_TICKET',
      subtitle: ticketTier,
      hiddenFromHistoryAt: null,
      refundedAt: null,
    },
  });

  const updatedTiers = tiers.map((t) =>
    t.name === ticketTier ? { ...t, sold: actualCount } : t,
  );
  await tx.event.update({ where: { id: eventId }, data: { ticketTiers: updatedTiers } });
}

/**
 * Restore a join spot after refund approval.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 */
export async function restoreJoinSpot(tx, member, table) {
  const memberPaid = Number(member.amountPaid) || 0;
  const nextOccupancy = Math.max(0, (Number(table.currentOccupancy) || 0) - 1);
  const nextContributed = Math.max(0, (Number(table.amountContributed) || 0) - memberPaid);
  let nextStatus = table.status;
  if (table.status === 'LOCKED' && nextContributed >= table.minimumSpend) {
    nextStatus = 'LOCKED';
  } else if (nextOccupancy > 0 || nextContributed > 0) {
    nextStatus = 'PARTIALLY_FILLED';
  } else if (!table.hostUserId && !table.hostedTableId) {
    nextStatus = 'AVAILABLE';
  } else {
    nextStatus = nextOccupancy >= table.guestCapacity ? 'FULL' : 'PARTIALLY_FILLED';
  }

  await tx.venueTableMember.update({
    where: { id: member.id },
    data: { status: 'REFUNDED' },
  });

  await tx.venueTable.update({
    where: { id: table.id },
    data: {
      currentOccupancy: nextOccupancy,
      amountContributed: nextContributed,
      status: nextStatus,
    },
  });

  const ticketRefs = [];
  if (member.paystackReference) {
    ticketRefs.push(member.paystackReference);
    ticketRefs.push(basePaymentReference(member.paystackReference));
  }
  if (ticketRefs.length) {
    await tx.ticket.updateMany({
      where: {
        userId: member.userId,
        venueTableId: table.id,
        paystackReference: { in: ticketRefs },
        refundedAt: null,
      },
      data: { refundedAt: new Date() },
    });
  }
}

const ZERO_BOOKING_AMOUNTS = {
  amountTotal: 0,
  entranceZar: 0,
  componentZar: 0,
  menuTotalZar: 0,
};

function paymentRefWhere(baseRef) {
  return {
    OR: [
      { paystackReference: baseRef },
      { paystackReference: { startsWith: `${baseRef}-` } },
    ],
  };
}

/**
 * Zero EventVenueTableBooking revenue for refunded payments.
 * Host refund with retained guests only clears the host row — guest rows stay.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 */
export async function cancelBookingsForRefund(tx, { req, baseRef, guestsRetained = false }) {
  if (!req?.userId || !baseRef) return;

  if (req.refundType === 'HOSTED_TABLE_MENU' || req.refundType === 'TICKET' || req.refundType === 'MENU_ADDON') return;

  if (req.refundType === 'TABLE_HOST') {
    const hostWhere = {
      userId: req.userId,
      role: 'HOST',
      ...paymentRefWhere(baseRef),
    };
    await tx.eventVenueTableBooking.updateMany({ where: hostWhere, data: ZERO_BOOKING_AMOUNTS });

    if (req.venueTableId) {
      await tx.eventVenueTableBooking.updateMany({
        where: { venueTableId: req.venueTableId, userId: req.userId, role: 'HOST' },
        data: ZERO_BOOKING_AMOUNTS,
      });
      if (!guestsRetained) {
        const vt = await tx.venueTable.findUnique({
          where: { id: req.venueTableId },
          select: { hostedTableId: true },
        });
        if (vt?.hostedTableId) {
          await tx.eventVenueTableBooking.updateMany({
            where: { hostedTableId: vt.hostedTableId, userId: req.userId, role: 'HOST' },
            data: ZERO_BOOKING_AMOUNTS,
          });
        }
      }
    }
    return;
  }

  if (req.refundType === 'TABLE_JOIN') {
    await tx.eventVenueTableBooking.updateMany({
      where: { userId: req.userId, role: 'GUEST', ...paymentRefWhere(baseRef) },
      data: ZERO_BOOKING_AMOUNTS,
    });
    if (req.venueTableMemberId) {
      const member = await tx.venueTableMember.findUnique({
        where: { id: req.venueTableMemberId },
        select: { venueTableId: true },
      });
      if (member?.venueTableId) {
        await tx.eventVenueTableBooking.updateMany({
          where: {
            venueTableId: member.venueTableId,
            userId: req.userId,
            role: 'GUEST',
          },
          data: ZERO_BOOKING_AMOUNTS,
        });
      }
    }
  }
}

/**
 * Apply all side effects when a venue approves a refund.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 */
export async function applyRefundApproval(tx, refundRequest) {
  const now = new Date();
  const claimed = await tx.refundRequest.updateMany({
    where: { id: refundRequest.id, status: 'PENDING' },
    data: {
      status: 'APPROVED',
      approvedAt: now,
      approvedByUserId: refundRequest.approvedByUserId,
    },
  });
  if (claimed.count !== 1) {
    const err = new Error('This request has already been processed');
    err.status = 400;
    throw err;
  }
  const req = await tx.refundRequest.findUnique({ where: { id: refundRequest.id } });

  const baseRef = basePaymentReference(req.paymentReference);
  const payment = await tx.payment.findFirst({
    where: { reference: { in: [req.paymentReference, baseRef] }, status: 'success' },
  });

  if (payment) {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        refundStatus: 'APPROVED',
        refundedAt: now,
        refundRequestId: req.id,
      },
    });
  }

  // Manual venue→guest refund: mark ledgers so wallet/analytics do not treat as normal earnings.
  // Menu-only refunds of a hosted join leave the host's join payout (and the service fee) alone.
  const payMetaForLedger = payment ? flattenPaymentMetadata(payment.metadata) : {};
  const menuOnlyOfJoin =
    req.refundType === 'HOSTED_TABLE_MENU' && String(payMetaForLedger.type || '') === 'HOSTED_TABLE_JOIN';
  await tx.payoutLedger.updateMany({
    where: {
      ...(menuOnlyOfJoin
        ? { paymentReference: `${baseRef}:menu` }
        : {
            OR: [
              { paymentReference: { in: [req.paymentReference, baseRef, `${baseRef}:join`, `${baseRef}:menu`] } },
              { paymentReference: { startsWith: `${baseRef}:` }, NOT: { paymentReference: `${baseRef}:service_fee` } },
            ],
          }),
      status: { not: 'REFUNDED_MANUAL' },
    },
    data: {
      status: 'REFUNDED_MANUAL',
      errorMessage: 'Marked after venue-approved manual guest refund (no Paystack clawback).',
    },
  });

  const ticketIds = Array.isArray(req.ticketIds) ? req.ticketIds : [];
  if (ticketIds.length) {
    await tx.ticket.updateMany({
      where: { id: { in: ticketIds }, refundedAt: null },
      data: { refundedAt: now, refundRequestId: req.id },
    });

    const tickets = await tx.ticket.findMany({
      where: { id: { in: ticketIds } },
      select: { subtitle: true, eventId: true },
    });
    const tiersSeen = new Set();
    for (const t of tickets) {
      if (!t.eventId || !t.subtitle) continue;
      const key = `${t.eventId}:${t.subtitle}`;
      if (tiersSeen.has(key)) continue;
      tiersSeen.add(key);
      await restoreTicketTierInventory(tx, t.eventId, t.subtitle);
    }
  } else if (req.refundType === 'TICKET') {
    const qty = 1;
    const refs = ticketReferencesForPayment(baseRef, qty);
    await tx.ticket.updateMany({
      where: {
        paystackReference: { startsWith: baseRef },
        userId: req.userId,
        refundedAt: null,
      },
      data: { refundedAt: now, refundRequestId: req.id },
    });
    const sample = await tx.ticket.findFirst({
      where: { paystackReference: { startsWith: baseRef } },
      select: { subtitle: true, eventId: true },
    });
    if (sample?.eventId && sample?.subtitle) {
      await restoreTicketTierInventory(tx, sample.eventId, sample.subtitle);
    }
  }

  let tableHostGuestsRetained = false;
  if (req.refundType === 'TABLE_HOST' && req.venueTableId) {
    const venueTable = await tx.venueTable.findUnique({
      where: { id: req.venueTableId },
      select: { id: true, hostedTableId: true },
    });
    const hostedGuests =
      venueTable?.hostedTableId
        ? await tx.hostedTableMember.count({
            where: {
              hostedTableId: venueTable.hostedTableId,
              status: 'GOING',
              userId: { not: req.userId },
            },
          })
        : 0;
    tableHostGuestsRetained = hostedGuests > 0;

    if (req.venueTableMemberId) {
      await tx.venueTableMember.update({
        where: { id: req.venueTableMemberId },
        data: { status: 'REFUNDED' },
      });
    }

    await tx.ticket.updateMany({
      where: {
        userId: req.userId,
        venueTableId: req.venueTableId,
        refundedAt: null,
        OR: [
          { paystackReference: baseRef },
          { paystackReference: { startsWith: `${baseRef}-` } },
        ],
      },
      data: { refundedAt: now, refundRequestId: req.id },
    });

    if (hostedGuests > 0 && venueTable?.hostedTableId) {
      await releaseVenueTableSlotForHostRefund(tx, req.venueTableId, { hostUserId: req.userId });
    } else {
      await releaseVenueTableSlot(tx, req.venueTableId);
    }
  }

  if (req.refundType === 'MENU_ADDON') {
    const addon = await tx.menuAddonOrder.findUnique({ where: { paystackReference: baseRef } });
    if (addon && addon.status === 'PAID') {
      await tx.menuAddonOrder.update({
        where: { id: addon.id },
        data: { status: 'REFUNDED', refundedAt: now },
      });
      if (addon.hostedTableId && Number(addon.subtotalZar) > 0) {
        await tx.hostedTable.updateMany({
          where: { id: addon.hostedTableId, menuSpendTotal: { gte: addon.subtotalZar } },
          data: { menuSpendTotal: { decrement: addon.subtotalZar } },
        });
      }
    }
    await tx.ticket.updateMany({
      where: { paystackReference: baseRef, userId: req.userId, refundedAt: null },
      data: { refundedAt: now, refundRequestId: req.id },
    });
  }

  if (req.refundType === 'HOSTED_TABLE_MENU') {
    const payMeta = payment ? flattenPaymentMetadata(payment.metadata) : {};
    const hostedTableId = payMeta.hosted_table_id ?? payMeta.hostedTableId ?? null;
    const memberId = payMeta.hosted_table_member_id ?? payMeta.hostedTableMemberId ?? null;
    await applyHostedMenuRefundEffects(tx, {
      req,
      baseRef,
      now,
      meta: payMeta,
      memberId,
      hostedTableId,
    });
  }

  if (req.refundType === 'TABLE_JOIN' && req.venueTableMemberId) {
    const member = await tx.venueTableMember.findUnique({
      where: { id: req.venueTableMemberId },
    });
    const table = member
      ? await tx.venueTable.findUnique({ where: { id: member.venueTableId } })
      : null;
    if (member && table) {
      await restoreJoinSpot(tx, member, table);
      await tx.ticket.updateMany({
        where: {
          userId: req.userId,
          venueTableId: table.id,
          refundedAt: null,
          OR: [
            { paystackReference: baseRef },
            { paystackReference: { startsWith: `${baseRef}-` } },
          ],
        },
        data: { refundedAt: now, refundRequestId: req.id },
      });
    }
  }

  let hostedTableIdForHistory = null;
  if (req.venueTableId) {
    const vt = await tx.venueTable.findUnique({
      where: { id: req.venueTableId },
      select: { hostedTableId: true },
    });
    hostedTableIdForHistory = vt?.hostedTableId ?? null;
  }
  if (!hostedTableIdForHistory && payment) {
    const payMeta = flattenPaymentMetadata(payment.metadata);
    hostedTableIdForHistory = payMeta.hosted_table_id ?? payMeta.hostedTableId ?? null;
  }

  await cancelBookingsForRefund(tx, {
    req,
    baseRef,
    guestsRetained: tableHostGuestsRetained,
  });

  if (
    req.venueTableMemberId &&
    (req.refundType === 'TABLE_HOST' || req.refundType === 'TABLE_JOIN')
  ) {
    await appendVenueTableRefundNotice(tx, {
      venueTableMemberId: req.venueTableMemberId,
      refundType: req.refundType,
      guestsRetained: tableHostGuestsRetained,
    });
  }

  await hideParticipationForRefund(tx, {
    userId: req.userId,
    venueTableId: req.venueTableId,
    hostedTableId: hostedTableIdForHistory,
  });

  return req;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendRefundEmail(params, context) {
  try {
    await sendEmail(params);
  } catch (e) {
    logger.warn(`refund email failed (${context})`, {
      err: e?.message,
      to: params?.to,
      code: e?.code,
    });
  }
}

export async function notifyRefundSubmitted({
  refundRequest,
  venueName,
  userEmail,
  venueOwnerId,
  venueOwnerEmail,
  guestName,
}) {
  const amount = Number(refundRequest.venueRefundDueZar || 0).toFixed(2);
  const userReason = refundRequest.userReason || '';
  await createNotification({
    userId: venueOwnerId,
    type: 'refund_request',
    title: 'New refund request',
    body: `A guest requested a refund of R${amount} for ${venueName || 'your venue'}.`,
    actionUrl: '/BusinessRefundRequests',
  });

  let resolvedVenueEmail = venueOwnerEmail;
  if (!resolvedVenueEmail && venueOwnerId) {
    const owner = await prisma.user.findUnique({
      where: { id: venueOwnerId },
      select: { email: true },
    });
    resolvedVenueEmail = owner?.email || null;
  }

  const emailJobs = [];

  if (userEmail) {
    emailJobs.push(
      sendRefundEmail(
        {
          to: userEmail,
          subject: 'Refund request submitted — SEC Nightlife',
          html: `<p>Your refund request has been sent to ${escapeHtml(venueName || 'the venue')}. They will review it shortly.</p>`,
          text: `Your refund request has been sent to ${venueName || 'the venue'}. They will review it shortly.`,
        },
        'guest-submit',
      ),
    );
  } else {
    logger.warn('refund submit guest email skipped — no user email', {
      refundRequestId: refundRequest.id,
    });
  }

  if (resolvedVenueEmail) {
    const appBase = (process.env.APP_URL || 'https://secnightlife.com').replace(/\/+$/, '');
    const reviewUrl = `${appBase}/BusinessRefundRequests`;
    const guestLabel = guestName ? ` (<strong>${escapeHtml(guestName)}</strong>)` : '';
    emailJobs.push(
      sendRefundEmail(
        {
          to: resolvedVenueEmail,
          subject: `New refund request — ${venueName || 'your venue'}`,
          html: `<p>A guest${guestLabel} requested a refund of <strong>R${amount}</strong> for ${escapeHtml(venueName || 'your venue')}.</p>
                 <p><strong>Reason:</strong> ${escapeHtml(userReason)}</p>
                 <p><a href="${reviewUrl}" style="color:#C0C0C0;font-weight:600;">Review refund request in SEC</a></p>`,
          text: `A guest${guestName ? ` (${guestName})` : ''} requested a refund of R${amount} for ${venueName || 'your venue'}.\n\nReason: ${userReason}\n\nReview: ${reviewUrl}`,
        },
        'venue-submit',
      ),
    );
  } else {
    logger.warn('refund submit venue email skipped — no owner email', {
      refundRequestId: refundRequest.id,
      venueOwnerId,
    });
  }

  await Promise.all(emailJobs);
}

export async function notifyRefundApproved({ refundRequest, userId, userEmail, venueName }) {
  const amount = Number(refundRequest.venueRefundDueZar || 0).toFixed(2);
  await createNotification({
    userId,
    type: 'refund_approved',
    title: 'Refund approved',
    body: `${venueName || 'The venue'} approved your refund. Expect R${amount} paid to your Sec Wallet off-app.`,
    actionUrl: '/Profile',
  });

  if (userEmail) {
    await sendRefundEmail(
      {
        to: userEmail,
        subject: 'Refund approved — SEC Nightlife',
        html: `<p>Your refund was approved. The venue will pay R${amount} to your Sec Wallet off-app.${
          refundRequest.refundType === 'HOSTED_TABLE_MENU'
            ? ' Refunded menu items are removed from your table; your join pass stays valid when only menu was refunded.'
            : refundRequest.refundType === 'MENU_ADDON'
              ? ' Only this add-on order was refunded; your original ticket or table pass is still valid.'
              : ' Your ticket/QR access for this purchase has been revoked.'
        }</p>`,
      },
      'guest-approved',
    );
  }
}

export async function notifyRefundRejected({ refundRequest, userId, userEmail, venueName, messages }) {
  const body = messages?.length ? messages.join(' ') : 'Your refund request was declined.';
  await createNotification({
    userId,
    type: 'refund_rejected',
    title: 'Refund declined',
    body: `${venueName || 'The venue'} declined your refund request. ${body}`,
    actionUrl: '/Profile',
  });

  if (userEmail) {
    await sendRefundEmail(
      {
        to: userEmail,
        subject: 'Refund declined — SEC Nightlife',
        html: `<p>${escapeHtml(venueName || 'The venue')} declined your refund request.</p><p>${escapeHtml(body)}</p><p>You may submit a new request if your situation changes.</p>`,
      },
      'guest-rejected',
    );
  }
}

export function mapRefundRequestRow(row, { includeUser = false, includeVenue = false } = {}) {
  const ticketIds = Array.isArray(row.ticketIds) ? row.ticketIds : [];
  return {
    id: row.id,
    status: row.status,
    refundType: row.refundType,
    paymentReference: row.paymentReference,
    userReason: row.userReason,
    userWalletCode: row.userWalletCode,
    grossAmountZar: row.grossAmountZar,
    venueRefundDueZar: row.venueRefundDueZar,
    platformFeeKeptZar: row.platformFeeKeptZar,
    rejectTemplateKeys: row.rejectTemplateKeys,
    rejectParams: row.rejectParams,
    ticketIds,
    venueTableMemberId: row.venueTableMemberId,
    venueTableId: row.venueTableId,
    eventId: row.eventId,
    approvedAt: row.approvedAt,
    rejectedAt: row.rejectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    user: includeUser && row.user
      ? {
          id: row.user.id,
          fullName: row.user.fullName,
          username: row.user.userProfile?.username || row.user.username,
        }
      : undefined,
    venue: includeVenue && row.venue ? { id: row.venue.id, name: row.venue.name } : undefined,
  };
}
