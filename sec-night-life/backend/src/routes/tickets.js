import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { ticketExpiresAtFromRow } from '../lib/ticketHelpers.js';
import { buildTicketDoorContext } from '../lib/ticketDoorContext.js';
import { buildTicketVerifyUrlWithHints, defaultTicketVerifyOrigin } from '../lib/ticketVerifyUrl.js';
import { evaluatePrintedHints, hostInstructionsForKind } from '../lib/ticketVerifyHints.js';
import { assertAdmitPermission, admitTicketTx, evaluateTicketEntryValidity } from '../lib/ticketAdmit.js';
import {
  assertOrderFulfillPermission,
  buildTicketOrderPayload,
  fulfillOrderByReference,
  unfulfillOrderByReference,
} from '../lib/orderFulfillment.js';

const router = Router();

async function orderFieldsForQr(req, ticket, door) {
  const order = await buildTicketOrderPayload(prisma, ticket);
  let staffCanFulfill = false;
  let fulfill_denied_reason = null;
  if (req.userId && order.has_serveable_order && door?.venue_id) {
    const perm = await assertOrderFulfillPermission(prisma, {
      userId: req.userId,
      userRole: req.userRole,
      venueId: door.venue_id,
    });
    staffCanFulfill = perm.ok;
    if (!perm.ok) fulfill_denied_reason = perm.reason || null;
  }
  return {
    ...order,
    can_fulfill_here: Boolean(staffCanFulfill && !order.order_fulfilled),
    can_unfulfill_here: Boolean(staffCanFulfill && order.order_fulfilled),
    fulfill_denied_reason: staffCanFulfill ? null : fulfill_denied_reason,
  };
}

function doorVerifySummary(door, holderName) {
  const bits = [];
  if (door.event_code) bits.push(door.event_code);
  if (holderName) bits.push(holderName);
  if (door.venue_name) bits.push(door.venue_name);
  if (door.event_title) bits.push(door.event_title);
  if (door.table_allocation_label) bits.push(door.table_allocation_label);
  return bits.length ? bits.join(' · ') : null;
}

function mapTicketRow(t) {
  const expiresAt = ticketExpiresAtFromRow(t);
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    subtitle: t.subtitle,
    paystack_reference: t.paystackReference,
    qr_token: t.qrToken,
    house_party_id: t.housePartyId,
    table_id: t.tableId,
    hosted_table_id: t.hostedTableId,
    event_id: t.eventId,
    venue_table_id: t.venueTableId,
    quantity: t.quantity,
    visible_until: t.visibleUntil,
    created_at: t.createdAt,
    holder_display_name: t.holderDisplayName,
    table_specs_summary: t.tableSpecsSummary,
    event_starts_at: t.eventStartsAt,
    expires_at: expiresAt,
    admitted_at: t.admittedAt,
    refunded_at: t.refundedAt,
    refund_status: t.refundedAt ? 'APPROVED' : null,
  };
}

function requestOrigin(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('host');
  return host ? `${proto}://${host}`.replace(/\/+$/, '') : '';
}

async function mapTicketRowWithDoor(req, t) {
  const door = await buildTicketDoorContext(prisma, t);
  const origin = defaultTicketVerifyOrigin();
  const verify_url = buildTicketVerifyUrlWithHints(origin, t.qrToken, {
    venueName: door.venue_name,
    eventStartsAt: t.eventStartsAt,
    eventCode: door.event_code,
  });
  return {
    ...mapTicketRow(t),
    venue_name: door.venue_name,
    venue_city: door.venue_city,
    event_title_door: door.event_title,
    event_code: door.event_code,
    table_allocation_label: door.table_allocation_label,
    check_location_line: door.check_location_line,
    door_verify_summary: doorVerifySummary(door, t.holderDisplayName),
    verify_url,
  };
}

router.get('/my', authenticateToken, async (req, res, next) => {
  try {
    const br = typeof req.query.bucket === 'string' ? req.query.bucket : 'active';
    const bp = z.enum(['active', 'inactive', 'expired', 'all']).safeParse(br);
    const bucket = bp.success ? bp.data : 'active';
    const normalizedBucket = bucket === 'expired' ? 'inactive' : bucket;
    const now = new Date();

    const rows = await prisma.ticket.findMany({
      where: {
        userId: req.userId,
        hiddenFromHistoryAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    const mapped = rows.map((t) => ({ raw: t, json: mapTicketRow(t) }));
    const filtered = mapped.filter(({ raw }) => {
      const exp = ticketExpiresAtFromRow(raw);
      const expired = exp <= now;
      const refunded = Boolean(raw.refundedAt);
      // Active = any ticket still valid (including upcoming events), not refunded.
      const isActive = !expired && !refunded;
      if (normalizedBucket === 'active') return isActive;
      if (normalizedBucket === 'inactive') return expired || refunded;
      return true;
    });

    const payload = await Promise.all(filtered.map(({ raw }) => mapTicketRowWithDoor(req, raw)));
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.post('/admit', authenticateToken, async (req, res, next) => {
  try {
    const body = z
      .object({
        qr_token: z.string().min(10),
      })
      .parse(req.body ?? {});
    const ticket = await prisma.ticket.findUnique({ where: { qrToken: body.qr_token } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const out = await prisma.$transaction(async (tx) =>
      admitTicketTx(tx, {
        ticketId: ticket.id,
        staffUserId: req.userId,
        staffRole: req.userRole,
      }),
    );
    if (!out.ok) {
      return res.status(out.status).json({
        error: out.error,
        admitted_at: out.admitted_at,
      });
    }
    res.json({
      success: true,
      admitted_at: out.admitted_at,
      event_id: out.event_id,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    next(err);
  }
});

router.delete('/my/:id', authenticateToken, async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const now = new Date();
    const t = await prisma.ticket.findFirst({
      where: { id, userId: req.userId, hiddenFromHistoryAt: null },
    });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    const exp = ticketExpiresAtFromRow(t);
    if (exp > now) {
      return res.status(400).json({ error: 'Only expired tickets can be removed from history' });
    }
    await prisma.ticket.update({
      where: { id },
      data: { hiddenFromHistoryAt: now },
    });
    res.status(204).send();
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid id' });
    next(err);
  }
});

router.get('/qr', optionalAuth, async (req, res, next) => {
  try {
    const token = z.string().min(1).parse(req.query.token);
    const now = new Date();
    const t = await prisma.ticket.findUnique({ where: { qrToken: token } });
    if (!t) return res.status(404).json({ valid: false, reason: 'Ticket not found' });
    const expiresAt = ticketExpiresAtFromRow(t);
    const door = await buildTicketDoorContext(prisma, t);
    const holder = t.holderDisplayName || null;
    const door_verify_summary = doorVerifySummary(door, holder);
    const hintEval = evaluatePrintedHints(req.query, door, t);
    const host_instructions = hostInstructionsForKind(t.kind);
    const orderFields = await orderFieldsForQr(req, t, door);

    if (expiresAt <= now) {
      const doorFieldsExpired = {
        venue_id: door.venue_id,
        venue_name: door.venue_name,
        venue_city: door.venue_city,
        event_title: door.event_title,
        event_code: door.event_code,
        table_allocation_label: door.table_allocation_label,
        check_location_line: door.check_location_line,
        door_verify_summary,
        host_instructions,
        order_only: t.kind === 'MENU_ADDON',
        viewer_authenticated: !!req.userId,
        can_admit_here: false,
        admit_denied_for_viewer: false,
        admit_denied_reason: null,
        already_admitted: !!t.admittedAt,
        admitted_at: t.admittedAt,
        ...hintEval,
      };
      return res.status(410).json({
        valid: false,
        reason: 'Ticket expired',
        expired: true,
        ticket_id: t.id,
        kind: t.kind,
        title: t.title,
        subtitle: t.subtitle,
        holder_display_name: t.holderDisplayName,
        table_specs_summary: t.tableSpecsSummary,
        event_starts_at: t.eventStartsAt,
        expires_at: expiresAt,
        ...doorFieldsExpired,
        ...orderFields,
      });
    }

    const entryValidity = await evaluateTicketEntryValidity(prisma, t);

    const viewer_authenticated = !!req.userId;
    let can_admit_here = false;
    let admit_denied_for_viewer = false;
    let admit_denied_reason = null;
    const orderOnly = t.kind === 'MENU_ADDON';
    if (req.userId && entryValidity.ok && !t.admittedAt && !orderOnly) {
      const perm = await assertAdmitPermission(prisma, req.userId, req.userRole, t, door);
      can_admit_here = perm.ok;
      if (!perm.ok) {
        admit_denied_for_viewer = true;
        admit_denied_reason = perm.reason || null;
      }
    }

    const doorFields = {
      venue_id: door.venue_id,
      venue_name: door.venue_name,
      venue_city: door.venue_city,
      event_title: door.event_title,
      event_code: door.event_code,
      table_allocation_label: door.table_allocation_label,
      check_location_line: door.check_location_line,
      door_verify_summary,
      host_instructions,
      order_only: orderOnly,
      viewer_authenticated,
      can_admit_here,
      admit_denied_for_viewer,
      admit_denied_reason,
      already_admitted: !!t.admittedAt,
      admitted_at: t.admittedAt,
      ...hintEval,
    };

    if (!entryValidity.ok) {
      return res.status(entryValidity.status).json({
        valid: false,
        reason: entryValidity.reason,
        expired: !!entryValidity.expired,
        session_ended: !!entryValidity.session_ended,
        ticket_id: t.id,
        kind: t.kind,
        title: t.title,
        subtitle: t.subtitle,
        holder_display_name: t.holderDisplayName,
        table_specs_summary: t.tableSpecsSummary,
        event_starts_at: t.eventStartsAt,
        expires_at: expiresAt,
        ...doorFields,
        ...orderFields,
      });
    }

    res.json({
      valid: true,
      ticket_id: t.id,
      kind: t.kind,
      title: t.title,
      subtitle: t.subtitle,
      quantity: t.quantity,
      event_id: t.eventId,
      table_id: t.tableId,
      hosted_table_id: t.hostedTableId,
      venue_table_id: t.venueTableId,
      house_party_id: t.housePartyId,
      holder_display_name: t.holderDisplayName,
      table_specs_summary: t.tableSpecsSummary,
      event_starts_at: t.eventStartsAt,
      expires_at: expiresAt,
      ...doorFields,
      ...orderFields,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ valid: false, reason: 'Invalid token' });
    next(err);
  }
});

router.post('/fulfill-order', authenticateToken, async (req, res, next) => {
  try {
    const body = z.object({ qr_token: z.string().min(10) }).parse(req.body ?? {});
    const ticket = await prisma.ticket.findUnique({ where: { qrToken: body.qr_token } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const out = await fulfillOrderByReference(prisma, {
      rawReference: ticket.paystackReference,
      staffUserId: req.userId,
      staffRole: req.userRole,
    });
    if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
    res.json({ success: true, order_fulfilled: true, fulfilled_at: out.order.fulfilledAt });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    next(err);
  }
});

router.post('/unfulfill-order', authenticateToken, async (req, res, next) => {
  try {
    const body = z.object({ qr_token: z.string().min(10) }).parse(req.body ?? {});
    const ticket = await prisma.ticket.findUnique({ where: { qrToken: body.qr_token } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const out = await unfulfillOrderByReference(prisma, {
      rawReference: ticket.paystackReference,
      staffUserId: req.userId,
      staffRole: req.userRole,
    });
    if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
    res.json({ success: true, order_fulfilled: false });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    next(err);
  }
});

export default router;
