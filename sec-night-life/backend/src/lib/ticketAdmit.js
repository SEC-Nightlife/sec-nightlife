import { prisma } from './prisma.js';
import { isStaff } from './access.js';
import { buildTicketDoorContext } from './ticketDoorContext.js';
import { ticketExpiresAtFromRow } from './ticketHelpers.js';

async function resolveLinkedEventId(tx, ticket) {
  if (ticket.eventId) {
    const e = await tx.event.findFirst({
      where: { id: ticket.eventId, deletedAt: null },
      select: { id: true },
    });
    return e?.id || null;
  }
  if (ticket.hostedTableId) {
    const ht = await tx.hostedTable.findUnique({
      where: { id: ticket.hostedTableId },
      select: { eventId: true },
    });
    if (ht?.eventId) {
      const e = await tx.event.findFirst({
        where: { id: ht.eventId, deletedAt: null },
        select: { id: true },
      });
      return e?.id || null;
    }
  }
  if (ticket.tableId) {
    const tb = await tx.table.findFirst({
      where: { id: ticket.tableId, deletedAt: null },
      select: { eventId: true },
    });
    if (tb?.eventId) {
      const e = await tx.event.findFirst({
        where: { id: tb.eventId, deletedAt: null },
        select: { id: true },
      });
      return e?.id || null;
    }
  }
  if (ticket.venueTableId) {
    const vt = await tx.venueTable.findUnique({
      where: { id: ticket.venueTableId },
      select: { eventId: true },
    });
    if (vt?.eventId) {
      const e = await tx.event.findFirst({
        where: { id: vt.eventId, deletedAt: null },
        select: { id: true },
      });
      return e?.id || null;
    }
  }
  return null;
}

export async function assertAdmitPermission(tx, staffUserId, staffRole, ticket, door) {
  if (!staffUserId) return { ok: false, reason: 'Not signed in' };
  if (isStaff(staffRole)) return { ok: true };

  if (door?.venue_id) {
    const v = await tx.venue.findFirst({
      where: { id: door.venue_id, deletedAt: null },
      select: { ownerUserId: true },
    });
    if (v?.ownerUserId === staffUserId) return { ok: true };
  }

  if (ticket.housePartyId) {
    const hp = await tx.houseParty.findUnique({
      where: { id: ticket.housePartyId },
      select: { hostUserId: true },
    });
    if (hp?.hostUserId === staffUserId) return { ok: true };
  }

  if (ticket.hostedTableId) {
    const ht = await tx.hostedTable.findUnique({
      where: { id: ticket.hostedTableId },
      select: { hostUserId: true },
    });
    if (ht?.hostUserId === staffUserId) return { ok: true };
  }

  if (ticket.tableId) {
    const tb = await tx.table.findFirst({
      where: { id: ticket.tableId, deletedAt: null },
      select: { hostUserId: true },
    });
    if (tb?.hostUserId === staffUserId) return { ok: true };
  }

  return { ok: false, reason: 'You are not allowed to admit this ticket (venue owner, table host, party host, or staff only).' };
}

/**
 * Whether this ticket still represents an active table booking (not reset / checked out).
 * @param {import('@prisma/client').Prisma.TransactionClient | typeof prisma} tx
 */
export async function evaluateTicketEntryValidity(tx, ticket) {
  const now = new Date();
  if (ticket.kind === 'MENU_ADDON') {
    const addon = await tx.menuAddonOrder.findUnique({
      where: { paystackReference: ticket.paystackReference },
      select: { status: true },
    });
    if (ticket.refundedAt || addon?.status === 'REFUNDED') {
      return { ok: false, status: 403, reason: 'Refunded — this add-on order was refunded.', refunded: true };
    }
  }
  if (ticket.refundedAt) {
    return {
      ok: false,
      status: 403,
      reason: 'Refunded — this QR is no longer valid for entry.',
      refunded: true,
    };
  }
  if (ticketExpiresAtFromRow(ticket) <= now) {
    return { ok: false, status: 410, reason: 'Ticket expired', expired: true };
  }

  if (ticket.venueTableId && ticket.userId && ticket.kind === 'VENUE_TABLE_JOIN') {
    const member = await tx.venueTableMember.findUnique({
      where: {
        venueTableId_userId: { venueTableId: ticket.venueTableId, userId: ticket.userId },
      },
      select: { status: true },
    });
    if (!member || member.status !== 'CONFIRMED') {
      return {
        ok: false,
        status: 403,
        reason: 'Checked out — this table session was ended. This QR is no longer valid for entry.',
        session_ended: true,
      };
    }
  }

  if (ticket.hostedTableId) {
    const ht = await tx.hostedTable.findUnique({
      where: { id: ticket.hostedTableId },
      select: { status: true },
    });
    if (!ht || ht.status === 'CLOSED') {
      return {
        ok: false,
        status: 403,
        reason: 'Checked out — this table session was ended. This QR is no longer valid for entry.',
        session_ended: true,
      };
    }

    if (ticket.userId && (ticket.kind === 'HOSTED_TABLE_JOIN' || ticket.kind === 'TABLE_HOST_FEE')) {
      const member = await tx.hostedTableMember.findUnique({
        where: {
          hostedTableId_userId: { hostedTableId: ticket.hostedTableId, userId: ticket.userId },
        },
        select: { status: true },
      });
      if (!member || member.status !== 'GOING') {
        return {
          ok: false,
          status: 403,
          reason: 'Checked out — this guest is no longer on the table guest list.',
          session_ended: true,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * @param {import('@prisma/client').Prisma.TransactionClient | typeof prisma} tx
 */
export async function admitTicketTx(tx, { ticketId, staffUserId, staffRole }) {
  const t = await tx.ticket.findUnique({ where: { id: ticketId } });
  if (!t) return { ok: false, status: 404, error: 'Ticket not found' };
  if (t.kind === 'MENU_ADDON') {
    return {
      ok: false,
      status: 400,
      error: "This is an add-on order QR, not an entry pass. Scan the guest's ticket or table pass for entry.",
      order_only: true,
    };
  }

  const now = new Date();
  if (ticketExpiresAtFromRow(t) <= now) {
    return { ok: false, status: 410, error: 'Ticket expired' };
  }
  if (t.admittedAt) {
    return {
      ok: false,
      status: 409,
      error: 'Already admitted',
      admitted_at: t.admittedAt,
    };
  }

  const entryValidity = await evaluateTicketEntryValidity(tx, t);
  if (!entryValidity.ok) {
    return {
      ok: false,
      status: entryValidity.status,
      error: entryValidity.reason,
    };
  }

  const door = await buildTicketDoorContext(tx, t);
  const perm = await assertAdmitPermission(tx, staffUserId, staffRole, t, door);
  if (!perm.ok) return { ok: false, status: 403, error: perm.reason };

  const linkedEventId = await resolveLinkedEventId(tx, t);
  const eventIdForAttendance = t.eventId || linkedEventId;

  await tx.ticket.update({
    where: { id: t.id },
    data: {
      admittedAt: now,
      admittedByUserId: staffUserId,
    },
  });

  if (eventIdForAttendance && t.userId) {
    await tx.eventAttendance.upsert({
      where: {
        eventId_userId: { eventId: eventIdForAttendance, userId: t.userId },
      },
      create: {
        eventId: eventIdForAttendance,
        userId: t.userId,
        confirmed: true,
        checkedIn: true,
      },
      update: { checkedIn: true, confirmed: true },
    });
  }

  return {
    ok: true,
    status: 200,
    admitted_at: now,
    event_id: eventIdForAttendance,
  };
}
