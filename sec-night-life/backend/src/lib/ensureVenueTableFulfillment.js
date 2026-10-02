import { prisma } from './prisma.js';
import { issueTicketAndNotify } from './issueTicket.js';
import { ensureHostedTableFromVenueHostPayment } from './venueTableHostAfterPayment.js';
import { resolveDailySessionNumber } from './dailyTableSession.js';
import { recordEventVenueTableBooking, recordGuestEventVenueTableBookingIfNeeded } from './eventVenueBooking.js';
import { resolveVenueMenuSelections } from './menuHelpers.js';
import { buildVenueTableMemberTicketSummary } from './ticketMemberSummary.js';
import {
  visibleUntilForVenueTableMember,
  visibleUntilForDayVenueTable,
  eventStartsAtFromEvent,
  eventEndsAtFromEvent,
  dayEventStartsAtFromMember,
  holderDisplayNameFromUser,
  venueTableTicketTitle,
} from './ticketHelpers.js';
import { recordVenueHostParticipation } from './tableHistory.js';
import { windowEndInstant } from './dayBookingWindows.js';
import { splitSecPlatform, ensureVenueTablePayoutLedger } from './paystackPayout.js';
import { logger } from './logger.js';
import { netOfServiceFee } from './serviceFee.js';

const HOST_FULFILLMENT_TX_OPTS = { timeout: 30000, maxWait: 10000 };

function flattenMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const nested = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
  return { ...nested, ...value };
}

function memberWindowFieldsFromMetadata(member, metadata) {
  const startTime =
    metadata.window_start || metadata.windowStart || member?.windowStartTime || null;
  const endTime = metadata.window_end || metadata.windowEnd || member?.windowEndTime || null;
  const bookingRaw = metadata.booking_date || member?.bookingDate || null;
  const bookingDate = bookingRaw ? new Date(bookingRaw) : null;
  if (!startTime || !endTime) return {};
  return {
    windowStartTime: String(startTime),
    windowEndTime: String(endTime),
    ...(bookingDate && !Number.isNaN(bookingDate.getTime()) ? { bookingDate } : {}),
  };
}

function isVenueTableHostPayment(metadata, member) {
  const bookingMode = metadata.booking_mode || metadata.bookingMode;
  return bookingMode === 'host' || bookingMode === 'custom_host' || member?.memberRole === 'HOST';
}

/**
 * Repair path: ensure venue-table checkout fulfillment for a paid reference.
 * Handles PENDING_PAYMENT members, missing tickets, and missing hosted-table links.
 */
export async function ensureVenueTableFulfillmentForPayment(reference, paystackData = null) {
  const pay = await prisma.payment.findUnique({
    where: { reference },
    select: { userId: true, email: true, amount: true, metadata: true, status: true },
  });
  if (!pay) return { repaired: false, reason: 'payment_not_found' };

  const paid = pay.status === 'success' || paystackData?.status === 'success';
  if (!paid) return { repaired: false, reason: 'not_paid' };

  const metadata = flattenMetadata(pay.metadata);
  const type = metadata.type;
  if (type !== 'TABLE_CHECKOUT' && type !== 'VENUE_TABLE_JOIN') {
    return { repaired: false, reason: 'wrong_type' };
  }

  const venueTableId = metadata.venueTableId || metadata.venue_table_id;
  const venueTableMemberId = metadata.venueTableMemberId || metadata.venue_table_member_id;
  const userId = pay.userId || metadata.user_id || metadata.userId;
  if (!venueTableId || !venueTableMemberId || !userId) {
    return { repaired: false, reason: 'missing_metadata' };
  }

  const amount = netOfServiceFee(
    metadata,
    paystackData?.amount ? paystackData.amount / 100 : Number(pay.amount || 0),
  );
  const email = pay.email || paystackData?.customer?.email || metadata.email || 'unknown@secnightlife.app';
  let repaired = false;
  let hostFulfillmentError = null;

  let member = await prisma.venueTableMember.findFirst({
    where: {
      id: String(venueTableMemberId),
      venueTableId: String(venueTableId),
      userId: String(userId),
    },
    include: { venueTable: { include: { venue: true } } },
  });
  if (!member) return { repaired: false, reason: 'member_not_found' };

  const windowFields = memberWindowFieldsFromMetadata(member, metadata);

  if (member.status === 'PENDING_PAYMENT') {
    await prisma.$transaction(async (tx) => {
      const freshMember = await tx.venueTableMember.findFirst({
        where: { id: member.id },
        include: { venueTable: { include: { venue: true } } },
      });
      if (!freshMember || freshMember.status === 'CONFIRMED') return;

      const table = freshMember.venueTable;
      const totalPaid = Number(amount || 0);
      const { secAmount, recipientAmount: venueAmount } = splitSecPlatform(totalPaid);
      const memberForHost = { ...freshMember, ...windowFields };
      const isHostPayment = isVenueTableHostPayment(metadata, freshMember);

      if (isHostPayment && !table.hostedTableId) {
        if (Object.keys(windowFields).length) {
          await tx.venueTableMember.update({
            where: { id: freshMember.id },
            data: windowFields,
          });
        }
        const hostResult = await ensureHostedTableFromVenueHostPayment({
          tx,
          venueTable: table,
          userId: String(userId),
          paystackReference: reference,
          amountTotal: totalPaid,
          selectedMenuItems: metadata.selectedMenuItems || freshMember.selectedMenuItems,
          settlementMode: metadata.settlement_mode || freshMember.settlementMode,
          hostMember: memberForHost,
        });
        if (!hostResult.ok) {
          hostFulfillmentError = hostResult.error || 'host_table_create_failed';
          throw new Error(`host_fulfillment_failed:${hostFulfillmentError}`);
        }
      }

      const currentOccupancy = table.currentOccupancy + 1;
      const amountContributed = table.amountContributed + totalPaid;
      const nextStatus =
        currentOccupancy >= table.guestCapacity
          ? 'LOCKED'
          : amountContributed >= table.minimumSpend
            ? 'PARTIALLY_FILLED'
            : 'AVAILABLE';
      const dailySessionNumber = resolveDailySessionNumber(table, new Date());

      await tx.venueTableMember.update({
        where: { id: freshMember.id },
        data: {
          status: 'CONFIRMED',
          amountPaid: totalPaid,
          selectedMenuItems: metadata.selectedMenuItems || freshMember.selectedMenuItems,
          paidAt: new Date(),
          paystackReference: reference,
          tableSessionNumber: dailySessionNumber,
          ...windowFields,
        },
      });
      await tx.venueTable.update({
        where: { id: table.id },
        data: {
          amountContributed: { increment: totalPaid },
          currentOccupancy: { increment: 1 },
          status: nextStatus,
        },
      });
      const existingLog = await tx.splitPaymentLog.findFirst({ where: { reference } });
      if (!existingLog) {
        await tx.splitPaymentLog.create({
          data: {
            venueTableId: table.id,
            memberId: freshMember.id,
            totalAmount: totalPaid,
            secAmount,
            venueAmount,
            reference,
          },
        });
      }
    }, HOST_FULFILLMENT_TX_OPTS).catch((err) => {
      logger.warn('ensureVenueTableFulfillmentForPayment confirm failed', {
        reference,
        err: err?.message,
      });
    });
    repaired = true;
    member = await prisma.venueTableMember.findFirst({
      where: { id: String(venueTableMemberId) },
      include: { venueTable: { include: { venue: true } } },
    });
  } else if (Object.keys(windowFields).length) {
    await prisma.venueTableMember.update({
      where: { id: member.id },
      data: windowFields,
    });
    member = { ...member, ...windowFields };
    repaired = true;
  }

  const vt = await prisma.venueTable.findUnique({
    where: { id: String(venueTableId) },
    include: { event: true, venue: true },
  });
  if (!vt || member?.status !== 'CONFIRMED') {
    return { repaired, reason: repaired ? 'confirmed_pending_ticket' : 'not_confirmed' };
  }

  const isHostMode = isVenueTableHostPayment(metadata, member);

  if (isHostMode && !vt.hostedTableId) {
    await prisma.$transaction(async (tx) => {
      const freshTable = await tx.venueTable.findUnique({ where: { id: vt.id } });
      if (freshTable && !freshTable.hostedTableId) {
        const hostResult = await ensureHostedTableFromVenueHostPayment({
          tx,
          venueTable: freshTable,
          userId: String(userId),
          paystackReference: reference,
          amountTotal: amount,
          selectedMenuItems: metadata.selectedMenuItems || member.selectedMenuItems,
          settlementMode: metadata.settlement_mode || member.settlementMode,
          hostMember: member,
        });
        if (!hostResult.ok) {
          hostFulfillmentError = hostResult.error || hostFulfillmentError;
        } else {
          repaired = true;
        }
      }
    }, HOST_FULFILLMENT_TX_OPTS);
  }

  const refreshedVt = await prisma.venueTable.findUnique({
    where: { id: String(venueTableId) },
    include: { event: true, venue: true },
  });

  if (isHostMode && !refreshedVt?.hostedTableId) {
    logger.warn('ensureVenueTableFulfillmentForPayment: host table still missing', {
      reference,
      venueTableId,
      error: hostFulfillmentError,
    });
    return {
      repaired,
      reason: 'host_table_missing',
      hostError: hostFulfillmentError || 'hosted_table_id_missing',
    };
  }

  if (isHostMode && refreshedVt?.hostedTableId && refreshedVt.eventId) {
    const existingBooking = await prisma.eventVenueTableBooking.findFirst({
      where: {
        hostedTableId: refreshedVt.hostedTableId,
        userId: String(userId),
        role: 'HOST',
      },
    });
    if (!existingBooking) {
      await recordEventVenueTableBooking({
        venueId: refreshedVt.venueId,
        eventId: refreshedVt.eventId,
        hostedTableId: refreshedVt.hostedTableId,
        userId: String(userId),
        role: 'HOST',
        paystackReference: reference,
        amountTotal: amount,
      });
      repaired = true;
    }
  }

  if (!isHostMode && refreshedVt?.eventId) {
    const guestBooking = await recordGuestEventVenueTableBookingIfNeeded({
      venueTableId: refreshedVt.id,
      userId: String(userId),
      paystackReference: reference,
      amountTotal: amount,
      selectedMenuItems: metadata.selectedMenuItems || member.selectedMenuItems,
      bookingMode: metadata.booking_mode || metadata.bookingMode,
      memberRole: member.memberRole,
    });
    if (guestBooking) repaired = true;
  }

  const existingTicket = await prisma.ticket.findUnique({ where: { paystackReference: reference } });
  if (!existingTicket) {
    const vu = await prisma.user.findUnique({
      where: { id: String(userId) },
      select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
    });
    const visFallback = refreshedVt.event?.date
      ? visibleUntilForVenueTableMember(refreshedVt, refreshedVt.event)
      : visibleUntilForDayVenueTable(refreshedVt, new Date(), {
          windowEndsAt:
            member?.windowEndTime && member?.windowStartTime && member?.bookingDate
              ? windowEndInstant(member.bookingDate, member.windowStartTime, member.windowEndTime)
              : null,
          windowStartTime: member?.windowStartTime,
          windowEndTime: member?.windowEndTime,
          bookingDate: member?.bookingDate,
        });
    const eventStartsAt = refreshedVt.event
      ? eventStartsAtFromEvent(refreshedVt.event)
      : dayEventStartsAtFromMember(member, refreshedVt);
    const eventEndsAt = refreshedVt.event ? eventEndsAtFromEvent(refreshedVt.event) : null;
    const bookingMode = metadata.booking_mode || metadata.bookingMode;
    const settlementMode = metadata.settlement_mode || metadata.settlementMode || member.settlementMode;
    const minSpendZar = isHostMode
      ? Number(refreshedVt.hostMinimumSpend ?? refreshedVt.minimumSpend ?? 0)
      : Number(refreshedVt.minimumSpend ?? 0);
    let menuResolved = null;
    const menuSel = metadata.selectedMenuItems || member.selectedMenuItems;
    if (Array.isArray(menuSel) && menuSel.length && refreshedVt.venueId) {
      menuResolved = await resolveVenueMenuSelections(menuSel, refreshedVt.venueId);
    }
    const tableSpecsSummary = await buildVenueTableMemberTicketSummary(prisma, {
      member,
      table: refreshedVt,
      venue: refreshedVt.venue,
      bookingMode,
      settlementMode,
      minSpendZar,
      menuItemsResolved: menuResolved,
    });
    await issueTicketAndNotify(prisma, {
      userId: String(userId),
      email: vu?.email || email,
      paystackReference: reference,
      kind: 'VENUE_TABLE_JOIN',
      title: venueTableTicketTitle(
        refreshedVt.tableName,
        refreshedVt.event?.title,
        isHostMode,
      ),
      subtitle: refreshedVt.venue?.name || null,
      visibleUntil: visFallback,
      venueTableId: refreshedVt.id,
      hostedTableId: refreshedVt.hostedTableId || null,
      eventId: refreshedVt.eventId || null,
      quantity: 1,
      holderDisplayName: holderDisplayNameFromUser(vu),
      tableSpecsSummary,
      eventStartsAt,
      eventEndsAt,
    });
    if (isHostMode) {
      await recordVenueHostParticipation({
        userId: String(userId),
        venueTable: refreshedVt,
        hostedTableId: refreshedVt.hostedTableId || null,
        member,
        eventTitle: refreshedVt.event?.title || null,
        awaitable: true,
      });
    }
    repaired = true;
  }

  const payoutResult = await ensureVenueTablePayoutLedger({
    reference,
    amountZar: Number(amount || 0),
    venueId: refreshedVt.venueId,
  }).catch((e) => {
    logger.warn('venue table repair payout failed', { err: e?.message });
    return { skipped: true };
  });
  if (payoutResult && !payoutResult.skipped) repaired = true;

  if (pay.status !== 'success') {
    const latestMember = await prisma.venueTableMember.findFirst({
      where: { id: String(venueTableMemberId) },
      select: { status: true, paystackReference: true },
    });
    const paystackOk = paystackData?.status === 'success';
    const memberOk =
      latestMember?.status === 'CONFIRMED' &&
      Boolean(latestMember.paystackReference || reference);
    if (paystackOk || memberOk) {
      await prisma.payment.update({
        where: { reference },
        data: { status: 'success' },
      });
    }
  }

  return { repaired, reason: repaired ? 'ok' : 'already_complete', payout: payoutResult };
}
