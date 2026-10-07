import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { fetchGuestVenueMenuItems } from '../lib/menuHelpers.js';
import {
  buildAddonPaymentMetadata,
  cancelStalePendingAddons,
  computeAddonCheckout,
  createPendingAddonOrder,
  listAddonsForParent,
  resolveAddonParent,
} from '../lib/addonOrders.js';
import { initializeServerPaystackPayment, newPaystackReference } from '../lib/paystackServerCheckout.js';

const router = Router();

const selectionSchema = z.object({
  menuItemId: z.string().min(1).max(64),
  quantity: z.coerce.number().int().min(1).max(50),
});

const initSchema = z
  .object({
    ticket_id: z.string().min(1).max(64).optional().nullable(),
    hosted_table_id: z.string().min(1).max(64).optional().nullable(),
    selected_menu_items: z.array(selectionSchema).min(1).max(30),
  })
  .refine((d) => d.ticket_id || d.hosted_table_id, { message: 'ticket_id or hosted_table_id is required' });

function parentQuery(q) {
  return {
    ticketId: typeof q.ticket_id === 'string' && q.ticket_id ? q.ticket_id : null,
    hostedTableId: typeof q.hosted_table_id === 'string' && q.hosted_table_id ? q.hosted_table_id : null,
  };
}

/** Can this guest order more on the given pass/table, and what is on the menu right now? */
router.get('/menu', authenticateToken, async (req, res, next) => {
  try {
    const { ticketId, hostedTableId } = parentQuery(req.query);
    const parentRes = await resolveAddonParent(prisma, { userId: req.userId, ticketId, hostedTableId });
    if (!parentRes.ok) {
      return res.json({ eligible: false, reason: parentRes.error, menu_items: [] });
    }
    const p = parentRes.parent;
    const menuItems = await fetchGuestVenueMenuItems(p.venueId);
    res.json({
      eligible: true,
      parent: {
        kind: p.kind,
        label: p.label,
        venue_id: p.venueId,
        venue_name: p.venueName,
        parent_ticket_id: p.parentTicketId,
        hosted_table_id: p.hostedTableId,
        available_until: p.visibleUntil,
      },
      menu_items: menuItems,
    });
  } catch (e) {
    next(e);
  }
});

/** This guest's add-on orders for one pass or table. */
router.get('/mine', authenticateToken, async (req, res, next) => {
  try {
    const { ticketId, hostedTableId } = parentQuery(req.query);
    let parentTicketId = ticketId;
    let parentReference = typeof req.query.parent_reference === 'string' ? req.query.parent_reference : null;
    if (ticketId) {
      const t = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { userId: true, paystackReference: true },
      });
      if (!t || t.userId !== req.userId) return res.json({ addons: [] });
      parentReference = parentReference || t.paystackReference;
    }
    const addons = await listAddonsForParent(prisma, {
      parentTicketId,
      parentReference,
      hostedTableId,
      userId: req.userId,
    });
    res.json({ addons });
  } catch (e) {
    next(e);
  }
});

router.post('/initialize', authenticateToken, requireVerified, async (req, res, next) => {
  try {
    const parsed = initSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;
    const computed = await computeAddonCheckout(prisma, {
      userId: req.userId,
      ticketId: d.ticket_id || null,
      hostedTableId: d.hosted_table_id || null,
      selectedMenuItems: d.selected_menu_items,
    });
    if (!computed.ok) {
      return res.status(computed.status || 400).json({ error: computed.error, code: computed.code });
    }
    await cancelStalePendingAddons(prisma, req.userId);

    const reference = newPaystackReference();
    const metadata = buildAddonPaymentMetadata({ userId: req.userId, computed });
    await createPendingAddonOrder(prisma, { reference, userId: req.userId, computed });
    let pay;
    try {
      pay = await initializeServerPaystackPayment({
        userId: req.userId,
        amountZar: computed.total,
        metadata,
        reference,
      });
    } catch (e) {
      await prisma.menuAddonOrder
        .updateMany({ where: { paystackReference: reference, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } })
        .catch(() => {});
      throw e;
    }
    res.json({
      pendingPayment: true,
      reference: pay.reference,
      access_code: pay.access_code,
      authorization_url: pay.authorization_url,
      email: pay.email,
      amount_zar: computed.total,
      subtotal_zar: computed.subtotal,
      service_fee_zar: computed.serviceFee,
      items: computed.items,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
