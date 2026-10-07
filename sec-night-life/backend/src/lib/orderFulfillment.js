import { flattenPaymentMetadata, basePaymentReference } from './paymentMetadata.js';
import { isStaff, staffHasVenuePermission } from './access.js';
import { formatYmdSast } from './dayBookingWindows.js';
import { listAddonsForParent } from './addonOrders.js';

const PREPAY_SETTLEMENTS = new Set(['PREPAY_MENU', 'PREPAY_LUMP']);

const userBriefSelect = {
  id: true,
  username: true,
  fullName: true,
  userProfile: { select: { username: true } },
};

/** Fulfilment rows are kept after an undo (audit); only rows without undoneAt count. */
export function isFulfillmentActive(row) {
  return Boolean(row && !row.undoneAt);
}

function paymentIsRefunded(pay) {
  return Boolean(pay && (pay.refundedAt || pay.refundStatus === 'APPROVED'));
}

export function canonicalOrderReference(ref) {
  return basePaymentReference(ref).replace(/-\d+$/, '');
}

export function normalizeGuestSearch(raw) {
  return String(raw || '').trim().replace(/^@+/, '').toLowerCase();
}

export function textMatchesGuestSearch(haystack, q) {
  if (!q) return true;
  return String(haystack || '').toLowerCase().includes(q);
}

export function guestRecordMatchesSearch(record, q) {
  if (!q) return true;
  return (
    textMatchesGuestSearch(record?.username, q) ||
    textMatchesGuestSearch(record?.fullName, q) ||
    textMatchesGuestSearch(record?.eventTitle, q) ||
    textMatchesGuestSearch(record?.tableName, q) ||
    textMatchesGuestSearch(record?.paystackReference, q)
  );
}

export function coerceMenuSelectionArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseMenuItemLines(raw) {
  const arr = coerceMenuSelectionArray(raw);
  const lines = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const quantity = Math.max(0, parseInt(String(item.quantity ?? item.qty), 10) || 0);
    if (quantity <= 0) continue;
    const unit = Number(item.unitPrice ?? item.unit_price ?? item.price) || 0;
    const lineTotal =
      Number(item.lineTotal ?? item.lineTotalZar ?? item.line_total_zar ?? 0) ||
      (unit > 0 ? Math.round(unit * quantity * 100) / 100 : 0);
    const name = String(item.name || item.label || '').trim();
    lines.push({
      menuItemId: item.menuItemId || item.menu_item_id || item.menuItem_id || item.id || null,
      name,
      quantity,
      unitPrice: unit,
      lineTotal,
    });
  }
  return lines;
}

export function mergeMenuLineSources(...raws) {
  const byKey = new Map();
  for (const raw of raws) {
    for (const line of parseMenuItemLines(raw)) {
      const key = line.menuItemId || `${line.name}:${line.quantity}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, line);
        continue;
      }
      const prevScore = (prev.name ? 2 : 0) + (Number(prev.lineTotal) > 0 ? 1 : 0);
      const nextScore = (line.name ? 2 : 0) + (Number(line.lineTotal) > 0 ? 1 : 0);
      byKey.set(key, nextScore > prevScore ? { ...prev, ...line } : { ...line, ...prev });
    }
  }
  return [...byKey.values()];
}

export function menuSourcesFromPaymentMeta(meta = {}) {
  return [
    meta.selected_menu_items ?? meta.selectedMenuItems,
    meta.included_items,
    meta.tier_included_items ?? meta.tierIncludedItems,
  ];
}

export function chargeBreakdownFromMeta(meta = {}, extras = {}) {
  const joinFeeZar =
    Number(meta.join_zar ?? meta.joinZar ?? 0) ||
    Number(meta.booking_fee_zar ?? meta.bookingFeeZar ?? extras.bookingFeeZar ?? 0) ||
    0;
  const entranceZar =
    Number(meta.entrance_zar ?? meta.entranceZar ?? extras.entranceZar ?? 0) || 0;
  const ticketZar =
    Number(meta.ticket_zar ?? meta.ticketZar ?? meta.tickets_zar ?? extras.ticketZar ?? 0) || 0;
  return { joinFeeZar, entranceZar, ticketZar };
}

export function summedMenuZar(lines, fallback = 0) {
  const sum = (lines || []).reduce((s, l) => s + (Number(l.lineTotal) || 0), 0);
  return Number(fallback) > 0 ? Number(fallback) : sum;
}

function catalogNameIsMissing(name) {
  const n = String(name || '').trim();
  return !n || n.toLowerCase() === 'item';
}

export async function loadMenuCatalogByIds(db, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await db.venueMenuItem.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, price: true, venueId: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

export function applyCatalogToMenuLines(lines, catalogById, venueId) {
  const catalog = catalogById instanceof Map ? catalogById : new Map();
  return (Array.isArray(lines) ? lines : []).map((line) => {
    const cat = line.menuItemId ? catalog.get(line.menuItemId) : null;
    const match = cat && (!venueId || !cat.venueId || cat.venueId === venueId) ? cat : null;
    const name = catalogNameIsMissing(line.name) ? (match?.name || line.name || 'Item') : line.name;
    const unit = Number(line.unitPrice) > 0 ? Number(line.unitPrice) : Number(match?.price) || 0;
    const qty = Number(line.quantity) || 1;
    const lineTotal =
      Number(line.lineTotal) > 0 ? Number(line.lineTotal) : Math.round(unit * qty * 100) / 100;
    return {
      menuItemId: line.menuItemId || null,
      name,
      quantity: qty,
      unitPrice: unit,
      lineTotal,
    };
  });
}

/** Fill names/prices from the venue catalog when snapshots only stored IDs. */
export async function hydrateMenuLines(db, lines, venueId) {
  const list = Array.isArray(lines) ? lines : [];
  if (!list.length) return [];
  const catalog = await loadMenuCatalogByIds(
    db,
    list.map((l) => l.menuItemId),
  );
  return applyCatalogToMenuLines(list, catalog, venueId);
}

export function orderDateYmd(order) {
  const d = order?.bookingDate || order?.eventDate || order?.createdAt;
  if (!d) return '';
  try {
    return formatYmdSast(d);
  } catch {
    return '';
  }
}

export function orderMatchesListFilters(order, { dateYmd = '', eventId = '', source = 'all' } = {}) {
  const date = String(dateYmd || '').trim();
  if (date && orderDateYmd(order) !== date) return false;
  const ev = String(eventId || '').trim();
  if (ev && ev !== 'all' && String(order.eventId || '') !== ev) return false;
  const src = String(source || 'all').toLowerCase();
  if (src && src !== 'all') {
    if (src === 'day' && order.source !== 'day') return false;
    if (src === 'event' && order.source !== 'event_table') return false;
    if (src === 'ticket' && order.source !== 'ticket') return false;
  }
  return true;
}

export function isServeableOrder({
  menuItems,
  menuZar,
  settlementMode,
  minimumSpendZar,
} = {}) {
  const items = Array.isArray(menuItems) ? menuItems : [];
  if (items.some((i) => (Number(i.quantity || i.qty) || 0) > 0)) return true;
  if (Number(menuZar) > 0) return true;
  const mode = String(settlementMode || '');
  if (PREPAY_SETTLEMENTS.has(mode) && Number(minimumSpendZar) > 0) return true;
  return false;
}

export function inferOrderKind({ paymentType, settlementMode, menuItems, menuZar, ticketKind } = {}) {
  const t = String(paymentType || '');
  const k = String(ticketKind || '');
  if (t === 'EVENT_ENTRANCE' || k === 'EVENT_ENTRANCE') return 'ENTRANCE_MENU';
  if (t === 'ticket' || k === 'EVENT_TICKET') return 'TICKET_MENU';
  const items = parseMenuItemLines(menuItems);
  if (
    String(settlementMode) === 'PREPAY_LUMP' &&
    items.length === 0 &&
    !(Number(menuZar) > 0)
  ) {
    return 'MIN_SPEND';
  }
  return 'TABLE_MENU';
}

function usernameOf(user) {
  if (!user) return '';
  return user.userProfile?.username || user.username || '';
}

function mapUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: usernameOf(user),
    fullName: user.fullName || null,
  };
}

export async function fulfillmentMapForReferences(db, refs) {
  const canonical = [...new Set((refs || []).map(canonicalOrderReference).filter(Boolean))];
  if (!canonical.length) return new Map();
  const rows = await db.orderFulfillment.findMany({
    where: { paystackReference: { in: canonical } },
  });
  return new Map(rows.map((r) => [r.paystackReference, r]));
}

export async function assertOrderFulfillPermission(db, { userId, userRole, venueId }) {
  if (!userId) return { ok: false, reason: 'Not signed in' };
  if (isStaff(userRole)) return { ok: true };
  if (!venueId) return { ok: false, reason: 'Venue not found' };
  if (await staffHasVenuePermission(userId, venueId, 'bookings')) return { ok: true };
  return { ok: false, reason: 'You need bookings access to mark orders as fulfilled.' };
}

async function loadRelatedForReference(db, reference) {
  const orRefs = [reference, `${reference}-1`];
  const [payment, booking, member, tickets, addon] = await Promise.all([
    db.payment.findFirst({
      where: { reference, status: 'success' },
      select: {
        reference: true,
        userId: true,
        amount: true,
        metadata: true,
        type: true,
        createdAt: true,
        refundStatus: true,
        refundedAt: true,
      },
    }),
    db.eventVenueTableBooking.findFirst({
      where: { paystackReference: { in: orRefs } },
      include: {
        user: { select: userBriefSelect },
        event: { select: { id: true, title: true, venueId: true, date: true } },
        hostedTable: { select: { id: true, tableName: true } },
        venueTable: { select: { id: true, tableName: true, venueId: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.venueTableMember.findFirst({
      where: { paystackReference: { in: orRefs } },
      include: {
        user: { select: userBriefSelect },
        venueTable: {
          select: {
            id: true,
            tableName: true,
            venueId: true,
            eventId: true,
            event: { select: { id: true, title: true, date: true } },
            minimumSpend: true,
            hostMinimumSpend: true,
          },
        },
      },
    }),
    db.ticket.findMany({
      where: {
        OR: [{ paystackReference: reference }, { paystackReference: { startsWith: `${reference}-` } }],
        refundedAt: null,
        hiddenFromHistoryAt: null,
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }),
    db.menuAddonOrder.findUnique({ where: { paystackReference: reference } }),
  ]);
  return { payment, booking, member, tickets, addon };
}

async function resolveAddonOrderContext(db, { reference, addon, ticket }) {
  if (addon.status !== 'PAID' && addon.status !== 'REFUNDED') {
    return { ok: false, status: 400, error: 'This add-on order has not been paid.', reference, venueId: addon.venueId };
  }
  const menuItems = await hydrateMenuLines(db, parseMenuItemLines(addon.items), addon.venueId);
  const [user, fulfillment, ev, vt, ht] = await Promise.all([
    db.user.findUnique({ where: { id: addon.userId }, select: userBriefSelect }),
    db.orderFulfillment.findUnique({ where: { paystackReference: reference } }),
    addon.eventId
      ? db.event.findUnique({ where: { id: addon.eventId }, select: { title: true, date: true } })
      : null,
    addon.venueTableId
      ? db.venueTable.findUnique({ where: { id: addon.venueTableId }, select: { tableName: true } })
      : null,
    addon.hostedTableId
      ? db.hostedTable.findUnique({ where: { id: addon.hostedTableId }, select: { tableName: true } })
      : null,
  ]);
  const fulfilled = isFulfillmentActive(fulfillment);
  return {
    ok: true,
    reference,
    venueId: addon.venueId,
    userId: addon.userId,
    user: mapUser(user) || { id: addon.userId, username: '', fullName: null },
    kind: 'MENU_ADDON',
    menuItems,
    menuZar: Number(addon.subtotalZar || 0),
    minimumSpendZar: 0,
    settlementMode: null,
    joinFeeZar: 0,
    entranceZar: 0,
    ticketZar: 0,
    amountPaidZar: Number(addon.totalZar || 0),
    eventId: addon.eventId || null,
    eventTitle: ev?.title || null,
    bookingDate: null,
    eventDate: ev?.date || null,
    tableName: ht?.tableName || vt?.tableName || null,
    ticketId: ticket?.id || addon.ticketId || null,
    createdAt: addon.paidAt || addon.createdAt,
    fulfilled,
    fulfilledAt: fulfilled ? fulfillment.fulfilledAt : null,
    fulfilledByUserId: fulfilled ? fulfillment.fulfilledByUserId : null,
    isAddon: true,
    parentKind: addon.parentKind,
    parentReference: addon.parentReference,
    refunded: addon.status === 'REFUNDED',
  };
}

export async function resolveOrderContext(db, rawReference) {
  const reference = canonicalOrderReference(rawReference);
  if (!reference) return { ok: false, status: 400, error: 'Missing payment reference' };

  const { payment, booking, member, tickets, addon } = await loadRelatedForReference(db, reference);
  const ticket = tickets[0] || null;
  if (addon) return resolveAddonOrderContext(db, { reference, addon, ticket });
  const meta = flattenPaymentMetadata(payment?.metadata);

  let venueId =
    booking?.venueId ||
    member?.venueTable?.venueId ||
    (meta.venue_id ? String(meta.venue_id) : null) ||
    (meta.venueId ? String(meta.venueId) : null);

  if (!venueId && ticket?.eventId) {
    const ev = await db.event.findFirst({
      where: { id: ticket.eventId, deletedAt: null },
      select: { venueId: true, title: true, id: true },
    });
    if (ev) venueId = ev.venueId;
  }
  if (!venueId && ticket?.venueTableId) {
    const vt = await db.venueTable.findUnique({
      where: { id: ticket.venueTableId },
      select: { venueId: true },
    });
    if (vt) venueId = vt.venueId;
  }
  if (!venueId && ticket?.hostedTableId) {
    const ht = await db.hostedTable.findUnique({
      where: { id: ticket.hostedTableId },
      select: { event: { select: { venueId: true } } },
    });
    if (ht?.event?.venueId) venueId = ht.event.venueId;
  }

  let menuItems = mergeMenuLineSources(
    ...menuSourcesFromPaymentMeta(meta),
    booking?.selectedMenuItems,
    member?.selectedMenuItems,
  );
  if (venueId) {
    menuItems = await hydrateMenuLines(db, menuItems, venueId);
  }

  const charges = chargeBreakdownFromMeta(meta, {
    bookingFeeZar: booking?.bookingFeeZar,
    entranceZar: booking?.entranceZar,
  });
  const menuZar =
    Number(meta.menu_zar ?? meta.menuZar ?? meta.menu_total_zar ?? 0) ||
    Number(booking?.menuTotalZar || 0) ||
    summedMenuZar(menuItems);
  const settlementMode =
    meta.settlement_mode ?? meta.settlementMode ?? booking?.settlementMode ?? member?.settlementMode ?? null;
  const minimumSpendZar =
    Number(meta.minimum_spend_zar ?? meta.minimumSpendZar ?? 0) ||
    Number(booking?.minimumSpendZar || 0) ||
    (member?.memberRole === 'HOST'
      ? Number(member?.venueTable?.hostMinimumSpend || 0)
      : Number(member?.venueTable?.minimumSpend || 0));

  if (
    !isServeableOrder({
      menuItems,
      menuZar,
      settlementMode,
      minimumSpendZar,
    })
  ) {
    return {
      ok: false,
      status: 400,
      error: 'This payment has no prepaid menu or minimum spend to fulfill.',
      reference,
      venueId,
    };
  }

  if (!venueId) {
    return { ok: false, status: 404, error: 'Could not match this order to a venue.' };
  }

  const userId = payment?.userId || booking?.userId || member?.userId || ticket?.userId;
  const user = booking?.user || member?.user || null;
  const eventTitle =
    booking?.event?.title ||
    member?.venueTable?.event?.title ||
    ticket?.title ||
    null;
  const eventId =
    booking?.eventId ||
    member?.venueTable?.eventId ||
    ticket?.eventId ||
    (meta.event_id ? String(meta.event_id) : null);
  const tableName =
    booking?.hostedTable?.tableName ||
    booking?.venueTable?.tableName ||
    member?.venueTable?.tableName ||
    null;

  const kind = inferOrderKind({
    paymentType: meta.type || payment?.type,
    settlementMode,
    menuItems,
    menuZar,
    ticketKind: ticket?.kind,
  });

  const fulfillment = await db.orderFulfillment.findUnique({
    where: { paystackReference: reference },
  });

  return {
    ok: true,
    reference,
    venueId,
    userId,
    user: mapUser(user) || (userId ? { id: userId, username: '', fullName: null } : null),
    kind,
    menuItems,
    menuZar,
    minimumSpendZar,
    settlementMode,
    joinFeeZar: charges.joinFeeZar,
    entranceZar: charges.entranceZar,
    ticketZar: charges.ticketZar,
    amountPaidZar: Number(payment?.amount || booking?.amountTotal || member?.amountPaid || 0),
    eventId,
    eventTitle,
    bookingDate: member?.bookingDate || null,
    eventDate: booking?.event?.date || member?.venueTable?.event?.date || null,
    tableName,
    ticketId: ticket?.id || null,
    createdAt: payment?.createdAt || booking?.createdAt || member?.paidAt || ticket?.createdAt || null,
    fulfilled: isFulfillmentActive(fulfillment),
    fulfilledAt: isFulfillmentActive(fulfillment) ? fulfillment.fulfilledAt : null,
    fulfilledByUserId: isFulfillmentActive(fulfillment) ? fulfillment.fulfilledByUserId : null,
    isAddon: false,
    refunded: paymentIsRefunded(payment),
  };
}

export async function fulfillOrderByReference(db, { rawReference, staffUserId, staffRole }) {
  const ctx = await resolveOrderContext(db, rawReference);
  if (!ctx.ok) return ctx;
  const perm = await assertOrderFulfillPermission(db, {
    userId: staffUserId,
    userRole: staffRole,
    venueId: ctx.venueId,
  });
  if (!perm.ok) return { ok: false, status: 403, error: perm.reason };
  if (!ctx.userId) return { ok: false, status: 400, error: 'Order has no guest user.' };
  if (ctx.refunded) {
    return { ok: false, status: 409, error: 'This order was refunded. Do not serve it.' };
  }

  const row = await db.orderFulfillment.upsert({
    where: { paystackReference: ctx.reference },
    create: {
      venueId: ctx.venueId,
      userId: ctx.userId,
      paystackReference: ctx.reference,
      kind: ctx.kind,
      fulfilledByUserId: staffUserId,
    },
    update: {
      fulfilledAt: new Date(),
      fulfilledByUserId: staffUserId,
      kind: ctx.kind,
      undoneAt: null,
      undoneByUserId: null,
    },
  });
  return { ok: true, fulfillment: row, order: { ...ctx, fulfilled: true, fulfilledAt: row.fulfilledAt } };
}

export async function unfulfillOrderByReference(db, { rawReference, staffUserId, staffRole }) {
  const ctx = await resolveOrderContext(db, rawReference);
  if (!ctx.ok) return ctx;
  const perm = await assertOrderFulfillPermission(db, {
    userId: staffUserId,
    userRole: staffRole,
    venueId: ctx.venueId,
  });
  if (!perm.ok) return { ok: false, status: 403, error: perm.reason };

  await db.orderFulfillment.updateMany({
    where: { paystackReference: ctx.reference, undoneAt: null },
    data: { undoneAt: new Date(), undoneByUserId: staffUserId },
  });
  return { ok: true, order: { ...ctx, fulfilled: false, fulfilledAt: null } };
}

function pushCandidate(map, candidate) {
  const ref = canonicalOrderReference(candidate.paystackReference);
  if (!ref) return;
  const existing = map.get(ref);
  if (!existing) {
    map.set(ref, { ...candidate, paystackReference: ref });
    return;
  }
  existing.menuItems = mergeMenuLineSources(existing.menuItems, candidate.menuItems);
  if (Number(candidate.menuZar) > Number(existing.menuZar || 0)) existing.menuZar = candidate.menuZar;
  if (Number(candidate.minimumSpendZar) > Number(existing.minimumSpendZar || 0)) {
    existing.minimumSpendZar = candidate.minimumSpendZar;
  }
  if (Number(candidate.joinFeeZar) > Number(existing.joinFeeZar || 0)) existing.joinFeeZar = candidate.joinFeeZar;
  if (Number(candidate.entranceZar) > Number(existing.entranceZar || 0)) existing.entranceZar = candidate.entranceZar;
  if (Number(candidate.ticketZar) > Number(existing.ticketZar || 0)) existing.ticketZar = candidate.ticketZar;
  if (!existing.settlementMode && candidate.settlementMode) existing.settlementMode = candidate.settlementMode;
  if (!existing.tableName && candidate.tableName) existing.tableName = candidate.tableName;
  if (!existing.eventTitle && candidate.eventTitle) existing.eventTitle = candidate.eventTitle;
  if (!existing.eventId && candidate.eventId) existing.eventId = candidate.eventId;
  if (!existing.bookingDate && candidate.bookingDate) existing.bookingDate = candidate.bookingDate;
  if (!existing.eventDate && candidate.eventDate) existing.eventDate = candidate.eventDate;
  if (candidate.source === 'day') existing.source = 'day';
}

export async function listVenueServeableOrders(db, {
  venueIds,
  q = '',
  status = 'pending',
  take = 300,
  dateYmd = '',
  eventId = '',
  source = 'all',
} = {}) {
  const query = normalizeGuestSearch(q);
  const statusFilter = ['pending', 'fulfilled', 'all'].includes(String(status)) ? String(status) : 'pending';
  const ids = (venueIds || []).filter(Boolean);
  if (!ids.length) {
    return { items: [], summary: { pending: 0, fulfilled: 0, total: 0 }, filters: { events: [] } };
  }

  const userSearch = query
    ? {
        OR: [
          { username: { contains: query, mode: 'insensitive' } },
          { fullName: { contains: query, mode: 'insensitive' } },
          { userProfile: { is: { username: { contains: query, mode: 'insensitive' } } } },
        ],
      }
    : undefined;

  const events = await db.event.findMany({
    where: { venueId: { in: ids }, deletedAt: null },
    select: { id: true, title: true, venueId: true, date: true },
  });
  const eventIds = events.map((e) => e.id);
  const eventById = new Map(events.map((e) => [e.id, e]));

  const venueTables = await db.venueTable.findMany({
    where: { venueId: { in: ids } },
    select: { id: true, tableName: true, venueId: true, eventId: true, hostedTableId: true },
  });
  const vtIds = venueTables.map((t) => t.id);
  const vtById = new Map(venueTables.map((t) => [t.id, t]));

  const hosted = eventIds.length
    ? await db.hostedTable.findMany({
        where: { eventId: { in: eventIds } },
        select: { id: true },
      })
    : [];
  // Day-booking hosted tables have no event; they hang off a venue table instead.
  const hostedIds = [
    ...new Set([...hosted.map((h) => h.id), ...venueTables.map((t) => t.hostedTableId).filter(Boolean)]),
  ];

  const ticketOr = [];
  if (eventIds.length) ticketOr.push({ eventId: { in: eventIds } });
  if (vtIds.length) ticketOr.push({ venueTableId: { in: vtIds } });
  if (hostedIds.length) ticketOr.push({ hostedTableId: { in: hostedIds } });

  const [bookings, members, tickets] = await Promise.all([
    db.eventVenueTableBooking.findMany({
      where: {
        venueId: { in: ids },
        paystackReference: { not: null },
        ...(userSearch ? { user: userSearch } : {}),
      },
      include: {
        user: { select: userBriefSelect },
        event: { select: { id: true, title: true, date: true } },
        hostedTable: { select: { tableName: true } },
        venueTable: { select: { tableName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 800,
    }),
    db.venueTableMember.findMany({
      where: {
        paystackReference: { not: null },
        status: { in: ['CONFIRMED', 'LEFT'] },
        venueTable: { venueId: { in: ids } },
        ...(userSearch ? { user: userSearch } : {}),
      },
      include: {
        user: { select: userBriefSelect },
        venueTable: {
          select: {
            id: true,
            tableName: true,
            venueId: true,
            eventId: true,
            event: { select: { title: true, date: true } },
            minimumSpend: true,
            hostMinimumSpend: true,
          },
        },
      },
      orderBy: { paidAt: 'desc' },
      take: 800,
    }),
    ticketOr.length
      ? db.ticket.findMany({
          where: {
            OR: ticketOr,
            refundedAt: null,
            hiddenFromHistoryAt: null,
            kind: { in: ['EVENT_TICKET', 'EVENT_ENTRANCE', 'HOSTED_TABLE_JOIN', 'VENUE_TABLE_JOIN', 'TABLE_JOIN'] },
            ...(userSearch ? { user: userSearch } : {}),
          },
          include: { user: { select: userBriefSelect } },
          orderBy: { createdAt: 'desc' },
          take: 800,
        })
      : [],
  ]);

  const refs = new Set();
  for (const row of bookings) if (row.paystackReference) refs.add(canonicalOrderReference(row.paystackReference));
  for (const row of members) if (row.paystackReference) refs.add(canonicalOrderReference(row.paystackReference));
  for (const row of tickets) if (row.paystackReference) refs.add(canonicalOrderReference(row.paystackReference));
  const refList = [...refs].filter(Boolean);

  const payments = refList.length
    ? await db.payment.findMany({
        where: { reference: { in: refList }, status: 'success' },
        select: {
          reference: true,
          amount: true,
          metadata: true,
          type: true,
          createdAt: true,
          userId: true,
          refundStatus: true,
          refundedAt: true,
        },
      })
    : [];
  const paymentByRef = new Map(payments.map((p) => [p.reference, p]));

  const candidates = new Map();

  for (const row of bookings) {
    const pay = paymentByRef.get(canonicalOrderReference(row.paystackReference));
    if (paymentIsRefunded(pay)) continue;
    const meta = flattenPaymentMetadata(pay?.metadata);
    const menuItems = mergeMenuLineSources(row.selectedMenuItems, ...menuSourcesFromPaymentMeta(meta));
    const charges = chargeBreakdownFromMeta(meta, {
      bookingFeeZar: row.bookingFeeZar,
      entranceZar: row.entranceZar,
    });
    const menuZar = Number(row.menuTotalZar || meta.menu_zar || 0);
    pushCandidate(candidates, {
      paystackReference: row.paystackReference,
      venueId: row.venueId,
      userId: row.userId,
      username: usernameOf(row.user),
      fullName: row.user?.fullName || null,
      eventId: row.eventId,
      eventTitle: row.event?.title || null,
      eventDate: row.event?.date || null,
      tableName: row.hostedTable?.tableName || row.venueTable?.tableName || null,
      source: 'event_table',
      menuItems,
      menuZar,
      minimumSpendZar: Number(row.minimumSpendZar || 0),
      settlementMode: row.settlementMode || meta.settlement_mode || null,
      joinFeeZar: charges.joinFeeZar,
      entranceZar: charges.entranceZar,
      ticketZar: charges.ticketZar,
      amountPaidZar: Number(pay?.amount || row.amountTotal || 0),
      kind: inferOrderKind({
        paymentType: meta.type || pay?.type,
        settlementMode: row.settlementMode,
        menuItems,
        menuZar,
      }),
      createdAt: row.createdAt,
    });
  }

  for (const row of members) {
    const pay = paymentByRef.get(canonicalOrderReference(row.paystackReference));
    if (paymentIsRefunded(pay)) continue;
    const meta = flattenPaymentMetadata(pay?.metadata);
    const menuItems = mergeMenuLineSources(row.selectedMenuItems, ...menuSourcesFromPaymentMeta(meta));
    const charges = chargeBreakdownFromMeta(meta);
    const minSpend =
      row.memberRole === 'HOST'
        ? Number(row.venueTable?.hostMinimumSpend || 0)
        : Number(row.venueTable?.minimumSpend || 0);
    const menuZar = Number(meta.menu_zar || 0);
    pushCandidate(candidates, {
      paystackReference: row.paystackReference,
      venueId: row.venueTable?.venueId,
      userId: row.userId,
      username: usernameOf(row.user),
      fullName: row.user?.fullName || null,
      eventId: row.venueTable?.eventId || null,
      eventTitle: row.venueTable?.event?.title || null,
      eventDate: row.venueTable?.event?.date || null,
      bookingDate: row.bookingDate || null,
      tableName: row.venueTable?.tableName || null,
      source: row.venueTable?.eventId ? 'event_table' : 'day',
      menuItems,
      menuZar,
      minimumSpendZar: minSpend,
      settlementMode: row.settlementMode || meta.settlement_mode || null,
      joinFeeZar: charges.joinFeeZar,
      entranceZar: charges.entranceZar,
      ticketZar: charges.ticketZar,
      amountPaidZar: Number(pay?.amount || row.amountPaid || 0),
      kind: inferOrderKind({
        paymentType: meta.type || pay?.type,
        settlementMode: row.settlementMode,
        menuItems,
        menuZar,
      }),
      createdAt: row.paidAt || row.joinedAt,
    });
  }

  for (const row of tickets) {
    const pay = paymentByRef.get(canonicalOrderReference(row.paystackReference));
    if (paymentIsRefunded(pay)) continue;
    const meta = flattenPaymentMetadata(pay?.metadata);
    const menuItems = mergeMenuLineSources(...menuSourcesFromPaymentMeta(meta));
    const charges = chargeBreakdownFromMeta(meta);
    const ev = row.eventId ? eventById.get(row.eventId) : null;
    const vt = row.venueTableId ? vtById.get(row.venueTableId) : null;
    const menuZar = Number(meta.menu_zar || meta.menu_total_zar || 0);
    pushCandidate(candidates, {
      paystackReference: row.paystackReference,
      venueId: ev?.venueId || vt?.venueId || null,
      userId: row.userId,
      username: usernameOf(row.user),
      fullName: row.user?.fullName || null,
      eventId: row.eventId,
      eventTitle: ev?.title || row.title,
      eventDate: ev?.date || null,
      tableName: vt?.tableName || null,
      source: row.kind === 'EVENT_TICKET' || row.kind === 'EVENT_ENTRANCE' ? 'ticket' : 'table',
      menuItems,
      menuZar,
      minimumSpendZar: Number(meta.minimum_spend_zar || 0),
      settlementMode: meta.settlement_mode || null,
      joinFeeZar: charges.joinFeeZar,
      entranceZar: charges.entranceZar,
      ticketZar: charges.ticketZar,
      amountPaidZar: Number(pay?.amount || 0),
      kind: inferOrderKind({
        paymentType: meta.type || pay?.type,
        settlementMode: meta.settlement_mode,
        menuItems,
        menuZar,
        ticketKind: row.kind,
      }),
      createdAt: pay?.createdAt || row.createdAt,
    });
  }

  // "Order more" add-ons: each one is its own order with its own reference.
  const addons = await db.menuAddonOrder.findMany({
    where: { venueId: { in: ids }, status: 'PAID' },
    orderBy: { paidAt: 'desc' },
    take: 800,
  });
  if (addons.length) {
    const addonUsers = await db.user.findMany({
      where: { id: { in: [...new Set(addons.map((a) => a.userId))] } },
      select: userBriefSelect,
    });
    const userById = new Map(addonUsers.map((u) => [u.id, u]));
    const hostedNames = new Map(
      (
        await db.hostedTable.findMany({
          where: { id: { in: [...new Set(addons.map((a) => a.hostedTableId).filter(Boolean))] } },
          select: { id: true, tableName: true },
        })
      ).map((h) => [h.id, h.tableName]),
    );
    for (const a of addons) {
      const u = userById.get(a.userId);
      const ev = a.eventId ? eventById.get(a.eventId) : null;
      const vt = a.venueTableId ? vtById.get(a.venueTableId) : null;
      const ticketParent = a.parentKind === 'TICKET' || a.parentKind === 'ENTRANCE';
      pushCandidate(candidates, {
        paystackReference: a.paystackReference,
        venueId: a.venueId,
        userId: a.userId,
        username: usernameOf(u),
        fullName: u?.fullName || null,
        eventId: a.eventId || null,
        eventTitle: ev?.title || null,
        eventDate: ev?.date || null,
        tableName: (a.hostedTableId && hostedNames.get(a.hostedTableId)) || vt?.tableName || null,
        source: ticketParent ? 'ticket' : a.eventId ? 'event_table' : 'day',
        menuItems: parseMenuItemLines(a.items),
        menuZar: Number(a.subtotalZar || 0),
        minimumSpendZar: 0,
        settlementMode: null,
        joinFeeZar: 0,
        entranceZar: 0,
        ticketZar: 0,
        amountPaidZar: Number(a.totalZar || 0),
        kind: 'MENU_ADDON',
        isAddon: true,
        parentKind: a.parentKind,
        parentReference: a.parentReference,
        createdAt: a.paidAt || a.createdAt,
      });
    }
  }

  const serveable = [...candidates.values()].filter((c) =>
    isServeableOrder({
      menuItems: c.menuItems,
      menuZar: c.menuZar,
      settlementMode: c.settlementMode,
      minimumSpendZar: c.minimumSpendZar,
    }),
  );

  const menuIds = [];
  for (const c of serveable) {
    for (const line of c.menuItems || []) {
      if (line.menuItemId) menuIds.push(line.menuItemId);
    }
  }
  const catalog = await loadMenuCatalogByIds(db, menuIds);
  for (const c of serveable) {
    c.menuItems = applyCatalogToMenuLines(c.menuItems, catalog, c.venueId);
    c.menuZar = summedMenuZar(c.menuItems, c.menuZar);
  }

  const fulfillMap = await fulfillmentMapForReferences(
    db,
    serveable.map((c) => c.paystackReference),
  );

  let items = serveable.map((c) => {
    const f = fulfillMap.get(c.paystackReference);
    return {
      ...c,
      id: c.paystackReference,
      fulfilled: isFulfillmentActive(f),
      fulfilledAt: isFulfillmentActive(f) ? f.fulfilledAt : null,
    };
  });

  if (query) items = items.filter((row) => guestRecordMatchesSearch(row, query));
  items = items.filter((row) =>
    orderMatchesListFilters(row, { dateYmd, eventId, source }),
  );

  const pending = items.filter((i) => !i.fulfilled).length;
  const fulfilled = items.filter((i) => i.fulfilled).length;
  if (statusFilter === 'pending') items = items.filter((i) => !i.fulfilled);
  else if (statusFilter === 'fulfilled') items = items.filter((i) => i.fulfilled);

  items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  items = items.slice(0, take);

  return {
    items,
    summary: { pending, fulfilled, total: pending + fulfilled },
    filters: { events: [] },
  };
}

export function applyFulfillmentToParticipant(entry, fulfillMap) {
  if (!entry) return entry;
  const ref = canonicalOrderReference(entry.paystackReference);
  const f = ref ? fulfillMap.get(ref) : null;
  const serveable = isServeableOrder({
    menuItems: entry.menuItems,
    menuZar: entry.menuZar,
    settlementMode: entry.settlementMode,
    minimumSpendZar: entry.minimumSpendZar,
  });
  return {
    ...entry,
    paystackReference: ref || entry.paystackReference || null,
    hasServeableOrder: serveable,
    orderFulfilled: isFulfillmentActive(f),
    orderFulfilledAt: isFulfillmentActive(f) ? f.fulfilledAt : null,
  };
}

export function serializeOrderForClient(order) {
  if (!order) return null;
  return {
    id: order.id || order.paystackReference,
    paystackReference: order.paystackReference,
    venueId: order.venueId,
    userId: order.userId,
    username: order.username || order.user?.username || '',
    fullName: order.fullName || order.user?.fullName || null,
    kind: order.kind,
    source: order.source || null,
    eventId: order.eventId || null,
    eventTitle: order.eventTitle || null,
    tableName: order.tableName || null,
    menuItems: order.menuItems || [],
    menuZar: Number(order.menuZar || 0),
    joinFeeZar: Number(order.joinFeeZar || 0),
    entranceZar: Number(order.entranceZar || 0),
    ticketZar: Number(order.ticketZar || 0),
    minimumSpendZar: Number(order.minimumSpendZar || 0),
    settlementMode: order.settlementMode || null,
    amountPaidZar: Number(order.amountPaidZar || 0),
    fulfilled: Boolean(order.fulfilled),
    fulfilledAt: order.fulfilledAt || null,
    isAddon: Boolean(order.isAddon),
    parentKind: order.parentKind || null,
    parentReference: order.parentReference || null,
    refunded: Boolean(order.refunded),
    createdAt: order.createdAt || null,
    bookingDate: order.bookingDate ? orderDateYmd({ bookingDate: order.bookingDate }) : orderDateYmd(order) || null,
  };
}

export async function buildTicketOrderPayload(db, ticket) {
  const ctx = await resolveOrderContext(db, ticket.paystackReference);
  const orderOnly = ticket.kind === 'MENU_ADDON';
  const addons = orderOnly
    ? []
    : await listAddonsForParent(db, {
        parentTicketId: ticket.id,
        parentReference: canonicalOrderReference(ticket.paystackReference),
        userId: ticket.userId,
      }).catch(() => []);
  if (!ctx.ok) {
    return {
      order_only: orderOnly,
      addons,
      has_serveable_order: false,
      menu_items: [],
      menu_zar: 0,
      minimum_spend_zar: 0,
      settlement_mode: null,
      order_fulfilled: false,
      order_fulfilled_at: null,
      paystack_reference: canonicalOrderReference(ticket.paystackReference),
    };
  }
  return {
    order_only: orderOnly,
    addons,
    order_refunded: Boolean(ctx.refunded),
    has_serveable_order: !ctx.refunded,
    menu_items: ctx.menuItems,
    menu_zar: ctx.menuZar,
    minimum_spend_zar: ctx.minimumSpendZar,
    settlement_mode: ctx.settlementMode,
    order_fulfilled: ctx.fulfilled,
    order_fulfilled_at: ctx.fulfilledAt,
    paystack_reference: ctx.reference,
    order_kind: ctx.kind,
  };
}
