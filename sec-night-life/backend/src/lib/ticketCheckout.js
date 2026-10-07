import { splitTicketCheckoutAmounts } from './platformSplit.js';
import { line, sumCheckoutLines } from './checkoutLines.js';
import { eventHasEnded } from './ticketHelpers.js';
import { withServiceFee } from './serviceFee.js';
import { chargeableMenuUnitPrice } from './menuHelpers.js';

/** Per-tier paid menu add-ons. Legacy events with only the event flag still allow add-ons. */
export function ticketTierAllowsMenuAddons(tier, event = null) {
  if (tier && typeof tier === 'object') {
    if (tier.allows_menu_addons === true || tier.allowsMenuAddons === true) return true;
    if (tier.allows_menu_addons === false || tier.allowsMenuAddons === false) return false;
  }
  return Boolean(event?.allowsTicketMenuAddons || event?.allows_ticket_menu_addons);
}

export function ticketTiersAllowMenuAddons(tiers) {
  const list = Array.isArray(tiers) ? tiers : [];
  return list.some((t) => t?.allows_menu_addons === true || t?.allowsMenuAddons === true);
}

/** Integer >= 1, or null when the venue left the cap blank / unlimited. */
export function parseMaxPerUser(tierOrRaw) {
  const raw = tierOrRaw && typeof tierOrRaw === 'object' ? tierOrRaw.max_per_user : tierOrRaw;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

export function userEventTierTicketWhere(userId, eventId, ticketTier) {
  return {
    userId: String(userId),
    eventId: String(eventId),
    kind: 'EVENT_TICKET',
    subtitle: ticketTier,
    refundedAt: null,
    hiddenFromHistoryAt: null,
  };
}

export async function countUserEventTierTickets(db, { userId, eventId, ticketTier }) {
  if (!userId || !eventId || !ticketTier) return 0;
  return db.ticket.count({
    where: userEventTierTicketWhere(userId, eventId, ticketTier),
  });
}

export async function countUserEventTicketsByTier(db, { userId, eventId }) {
  if (!userId || !eventId) return {};
  const rows = await db.ticket.groupBy({
    by: ['subtitle'],
    where: {
      userId: String(userId),
      eventId: String(eventId),
      kind: 'EVENT_TICKET',
      refundedAt: null,
      hiddenFromHistoryAt: null,
    },
    _count: { _all: true },
  });
  const out = {};
  for (const r of rows) {
    if (r.subtitle) out[r.subtitle] = r._count._all;
  }
  return out;
}

/**
 * Validate ticket tier + optional menu and compute checkout totals (ZAR).
 * Ticket tier: 4% SEC / 96% venue. Menu add-ons: 15% SEC / 85% venue.
 */
export async function computeTicketCheckout(prisma, {
  eventId,
  ticketTierName,
  quantity,
  selectedMenuItems = [],
  userId = null,
}) {
  const qty = Math.max(1, parseInt(String(quantity), 10) || 1);
  const event = await prisma.event.findFirst({
    where: { id: eventId, deletedAt: null },
    select: {
      id: true,
      eventFormat: true,
      ticketTiers: true,
      allowsTicketMenuAddons: true,
      venueId: true,
      date: true,
      startTime: true,
      endsAt: true,
      status: true,
    },
  });
  if (!event) return { ok: false, error: 'Event not found' };
  if (event.status && event.status !== 'published') {
    return { ok: false, error: 'Event is not available' };
  }
  if (eventHasEnded(event)) {
    return { ok: false, error: 'This event has ended. Tickets are no longer available.' };
  }

  const tiers = Array.isArray(event.ticketTiers) ? event.ticketTiers : [];
  const tier = tiers.find((t) => t.name === ticketTierName);
  if (!tier) return { ok: false, error: 'Ticket tier not found' };

  const available = Number(tier.quantity) - (Number(tier.sold) || 0);
  if (available < qty) return { ok: false, error: 'Not enough tickets available' };

  const maxPerUser = parseMaxPerUser(tier);
  let ownedCount = 0;
  let remainingForUser = null;
  if (maxPerUser != null && userId) {
    ownedCount = await countUserEventTierTickets(prisma, {
      userId,
      eventId: event.id,
      ticketTier: ticketTierName,
    });
    remainingForUser = Math.max(0, maxPerUser - ownedCount);
    if (ownedCount + qty > maxPerUser) {
      const label = ticketTierName || 'this ticket';
      if (remainingForUser <= 0) {
        return {
          ok: false,
          error: `You've reached the limit of ${maxPerUser} ${label} ticket${maxPerUser === 1 ? '' : 's'} per person.`,
        };
      }
      return {
        ok: false,
        error: `You can buy at most ${maxPerUser} ${label} ticket${maxPerUser === 1 ? '' : 's'} per person.`,
      };
    }
  }

  const ticketSubtotal = Math.round(Number(tier.price) * qty * 100) / 100;
  const menuLines = [];
  let menuTotal = 0;

  const menuPayload = Array.isArray(selectedMenuItems) ? selectedMenuItems : [];
  if (menuPayload.length > 0) {
    if (!ticketTierAllowsMenuAddons(tier, event)) {
      return { ok: false, error: 'Menu add-ons are not available for this ticket' };
    }
    const ids = menuPayload.map((m) => m.menuItemId).filter(Boolean);
    const rows = await prisma.venueMenuItem.findMany({
      where: { venueId: event.venueId, id: { in: ids }, isAvailable: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const sel of menuPayload) {
      const id = sel.menuItemId;
      const row = byId.get(id);
      if (!row) return { ok: false, error: 'Invalid menu item' };
      const itemQty = Math.max(0, parseInt(String(sel.quantity), 10) || 0);
      if (itemQty <= 0) continue;
      const unitPrice = chargeableMenuUnitPrice(row);
      const lineZar = Math.round(unitPrice * itemQty * 100) / 100;
      menuTotal += lineZar;
      menuLines.push({
        menuItemId: id,
        quantity: itemQty,
        unitPrice,
        name: row.name,
      });
    }
    menuTotal = Math.round(menuTotal * 100) / 100;
  }

  const baseLines = [line('tickets', `${ticketTierName} ×${qty}`, ticketSubtotal)];
  if (menuTotal > 0) {
    baseLines.push(line('menu', 'Menu add-ons', menuTotal));
  }
  const subtotal = Math.round((ticketSubtotal + menuTotal) * 100) / 100;
  const { lines, serviceFee, total } = withServiceFee(baseLines, subtotal);
  const { secAmount, recipientAmount } = splitTicketCheckoutAmounts(ticketSubtotal, menuTotal);

  return {
    ok: true,
    event,
    tier,
    ticketSubtotal,
    menuTotal,
    subtotal,
    serviceFee,
    total,
    menuLines,
    lines,
    secAmount,
    recipientAmount,
    ownedCount,
    remainingForUser,
    maxPerUser,
  };
}

export function buildTicketPaymentMetadata(base, computed) {
  const gross = computed.total;
  return {
    ...base,
    type: 'ticket',
    event_id: computed.event?.id || base.event_id,
    venue_id: computed.event?.venueId || base.venue_id,
    ticket_subtotal_zar: computed.ticketSubtotal,
    menu_zar: computed.menuTotal,
    menu_total_zar: computed.menuTotal,
    selected_menu_items: computed.menuLines,
    lines: computed.lines,
    subtotal_zar: computed.subtotal,
    service_fee_zar: computed.serviceFee,
    amount_total_zar: gross,
    platform_fee_zar: computed.secAmount,
    venue_share_zar: computed.recipientAmount,
  };
}

export async function expectedTicketTotalFromMetadata(prisma, metadata) {
  if (metadata?.amount_total_zar != null) {
    const fromLines = Array.isArray(metadata?.lines) ? sumCheckoutLines(metadata.lines) : 0;
    const declared = Number(metadata.amount_total_zar);
    if (fromLines > 0 && Math.abs(fromLines - declared) < 0.02) return declared;
    if (fromLines > 0) return fromLines;
    return declared;
  }
  const eventId = metadata?.event_id;
  const tier = metadata?.ticket_tier_name;
  if (!eventId || !tier) return 0;
  let menuItems = metadata?.selected_menu_items;
  if (typeof menuItems === 'string') {
    try {
      menuItems = JSON.parse(menuItems);
    } catch {
      menuItems = [];
    }
  }
  const result = await computeTicketCheckout(prisma, {
    eventId,
    ticketTierName: tier,
    quantity: metadata?.quantity || 1,
    selectedMenuItems: menuItems || [],
  });
  return result.ok ? result.total : 0;
}
