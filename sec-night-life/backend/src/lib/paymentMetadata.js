function isObjectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function flattenPaymentMetadata(value) {
  if (!isObjectRecord(value)) return {};
  const nested = isObjectRecord(value.metadata) ? value.metadata : {};
  return { ...nested, ...value };
}

export function basePaymentReference(ref) {
  const s = String(ref || '');
  const idx = s.indexOf(':');
  return idx >= 0 ? s.slice(0, idx) : s;
}

/** Suffix on payout ledger paymentReference: join / menu / entrance. */
export function ledgerPaymentComponent(ref) {
  const s = String(ref || '');
  const idx = s.indexOf(':');
  if (idx < 0) return null;
  const suffix = s.slice(idx + 1);
  if (suffix === 'join' || suffix === 'menu' || suffix === 'entrance') return suffix;
  return null;
}

export function isTicketPaymentMeta(meta, paymentType = null) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const t = String(m.type || paymentType || '');
  if (t === 'ticket' || paymentType === 'ticket') return true;
  if (t.includes('TICKET')) return true;
  if (t === 'event') return true;
  const eventId = m.event_id ?? m.eventId;
  const tier = m.ticket_tier_name ?? m.ticketTierName;
  return Boolean(eventId && tier);
}

const TABLE_PAYMENT_TYPES = new Set([
  'TABLE_CHECKOUT',
  'VENUE_TABLE_JOIN',
  'table',
  'HOSTED_TABLE_MENU',
  'HOSTED_TABLE_JOIN',
]);

/** Day booking payment (venue table with no linked event). */
export function isDayBookingPayment(meta) {
  if (!isObjectRecord(meta)) return false;
  // Explicit day-booking flag wins even if a stray event_id is present.
  if (meta.is_day_booking === true || meta.isDayBooking === true) return true;
  const eventId = meta.event_id ?? meta.eventId;
  if (eventId) return false;
  const t = String(meta.type || '');
  if (TABLE_PAYMENT_TYPES.has(t)) return true;
  // Sparse metadata still counts as day booking when a venue table id is present and no event.
  if (meta.venue_table_id || meta.venueTableId) return true;
  return false;
}

/** Day-booking host checkout (venue slot, no event). */
export function isDayBookingHostPayment(meta) {
  if (!isObjectRecord(meta)) return false;
  if (!isDayBookingPayment(meta)) return false;
  const bookingMode = meta.booking_mode || meta.bookingMode;
  const memberRole = meta.member_role || meta.memberRole;
  const isHost =
    bookingMode === 'host' ||
    bookingMode === 'custom_host' ||
    memberRole === 'HOST';
  if (!isHost) return false;
  const t = String(meta.type || '');
  return (
    t === 'TABLE_CHECKOUT' ||
    t === 'VENUE_TABLE_JOIN' ||
    t === 'table' ||
    t === '' ||
    isHostedTableVenuePayment(meta)
  );
}

/** Hosted-table guest join at a day-booking or event table. */
export function isHostedTableGuestJoinPayment(meta) {
  if (!isObjectRecord(meta)) return false;
  if (String(meta.type || '') !== 'HOSTED_TABLE_JOIN') return false;
  if (isDayBookingHostPayment(meta)) return false;
  const bookingMode = meta.booking_mode || meta.bookingMode;
  const memberRole = meta.member_role || meta.memberRole;
  if (bookingMode === 'join' || memberRole === 'GUEST') return true;
  return true;
}

/** Day-booking guest join (no event). */
export function isDayBookingGuestPayment(meta) {
  if (!isDayBookingPayment(meta)) return false;
  if (isDayBookingHostPayment(meta)) return false;
  if (isHostedTableGuestJoinPayment(meta)) return true;
  const bookingMode = meta.booking_mode || meta.bookingMode;
  const memberRole = meta.member_role || meta.memberRole;
  if (bookingMode === 'join' || memberRole === 'GUEST') return true;
  const t = String(meta.type || '');
  return t === 'TABLE_CHECKOUT' || t === 'VENUE_TABLE_JOIN' || t === 'table';
}

/** Guest join fee on an unhosted venue slot (revenue to venue, not host). */
export function isVenueDirectDayBookingJoinPayment(meta) {
  if (!isDayBookingPayment(meta)) return false;
  if (String(meta.type || '') === 'HOSTED_TABLE_JOIN') return false;
  if (isDayBookingHostPayment(meta)) return false;
  const bookingMode = meta.booking_mode || meta.bookingMode;
  const memberRole = meta.member_role || meta.memberRole;
  if (bookingMode === 'host' || bookingMode === 'custom_host' || memberRole === 'HOST') return false;
  const t = String(meta.type || '');
  return t === 'TABLE_CHECKOUT' || t === 'VENUE_TABLE_JOIN' || t === 'table';
}

/** Join fee component paid directly to the venue on unhosted day-booking slots. */
export function venueDirectJoinFeeZar(meta) {
  if (!isObjectRecord(meta)) return 0;
  const fromField = Number(meta.booking_fee_zar ?? meta.bookingFeeZar ?? 0) || 0;
  if (fromField > 0) return fromField;
  const lines = Array.isArray(meta.lines) ? meta.lines : [];
  const line = lines.find((l) => l && l.code === 'booking_fee');
  return line ? Number(line.amount_zar || line.amountZar || 0) || 0 : 0;
}

/** Host / custom-table checkout via venue inventory (creates a hosted table). */
export function isHostedTableVenuePayment(meta) {
  if (!isObjectRecord(meta)) return false;
  const bookingMode = meta.booking_mode || meta.bookingMode;
  if (bookingMode === 'host' || bookingMode === 'custom_host') return true;
  if (meta.hosted_table_id || meta.hostedTableId) return true;
  const memberRole = meta.member_role || meta.memberRole;
  return memberRole === 'HOST';
}

const EXCLUDED_ANALYTICS_TYPES = new Set([
  'TABLE_BOOST',
  'EVENT_BOOST',
  'VENUE_TABLE_BOOST',
  'HOUSE_PARTY_ENTRANCE',
  'HOUSE_PARTY_PUBLISH',
  'HOUSE_PARTY_BOOST',
  'promotion',
  'BOOST',
]);

/** Boosts, promotions, and house-party fees are excluded from venue analytics. */
export function isExcludedFromVenueAnalytics(mtype, paymentType = null) {
  const t = String(mtype || paymentType || '');
  if (!t) return false;
  if (EXCLUDED_ANALYTICS_TYPES.has(t)) return true;
  const upper = t.toUpperCase();
  if (upper.includes('BOOST') || upper.includes('PROMOTION') || upper.includes('HOUSE_PARTY')) return true;
  return false;
}

/** Menu item purchases from the venue menu (HOSTED_TABLE_MENU or ledger :menu). */
export function isMenuPayment(meta, mtype, ledgerRef = null) {
  const component = ledgerPaymentComponent(ledgerRef);
  if (component === 'menu') return true;
  const t = String(mtype || meta?.type || '');
  return t === 'HOSTED_TABLE_MENU' || t === 'MENU_ADDON';
}

export function createEmptyRevenueCounters() {
  return {
    ticketPaymentZar: 0,
    ticketPaymentNetZar: 0,
    entrancePaymentZar: 0,
    entrancePaymentNetZar: 0,
    ticketedTableHostPaymentZar: 0,
    ticketedTableHostPaymentNetZar: 0,
    ticketedTableJoinPaymentZar: 0,
    ticketedTableJoinPaymentNetZar: 0,
    ticketedTableMenuPaymentZar: 0,
    ticketedTableMenuPaymentNetZar: 0,
    hostedTablePaymentZar: 0,
    hostedTablePaymentNetZar: 0,
    dayBookingHostPaymentZar: 0,
    dayBookingHostPaymentNetZar: 0,
    dayBookingGuestPaymentZar: 0,
    dayBookingGuestPaymentNetZar: 0,
    dayBookingMenuPaymentZar: 0,
    dayBookingMenuPaymentNetZar: 0,
    menuPaymentZar: 0,
    menuPaymentNetZar: 0,
    dayBookingVenueJoinFeeVolumeZar: 0,
    dayBookingOtherPaymentZar: 0,
    dayBookingOtherPaymentNetZar: 0,
    venueTablePaymentZar: 0,
    venueTablePaymentNetZar: 0,
    otherPaymentZar: 0,
    otherPaymentNetZar: 0,
  };
}

/** True when payment metadata clearly belongs to a TICKETING_ONLY event. */
export function isTicketedEventPayment(meta) {
  const m = isObjectRecord(meta) ? meta : {};
  if (isDayBookingPayment(m)) return false;
  const fmt = String(m.event_format || m.eventFormat || '');
  if (fmt === 'TICKETING_ONLY' || Boolean(m.ticketed_event_tables)) return true;
  if (fmt === 'TABLE_HOSTING') return false;
  if (isTicketPaymentMeta(m, m.type)) return true;
  return false;
}

/** @param {'all'|'events'|'day_bookings'|'ticketed_events'} scope */
export function paymentMatchesRevenueScope(meta, scope) {
  if (scope === 'all') return true;
  const m = isObjectRecord(meta) ? meta : {};
  const isDay = isDayBookingPayment(m);
  const hasEvent = Boolean(m.event_id ?? m.eventId);

  if (scope === 'day_bookings') return isDay;
  if (scope === 'ticketed_events') {
    if (isDay) return false;
    if (isTicketedEventPayment(m)) return true;
    // Ambiguous event-linked rows: allow; route filters by TICKETING_ONLY event id set.
    if (hasEvent) {
      const fmt = String(m.event_format || m.eventFormat || '');
      return fmt !== 'TABLE_HOSTING';
    }
    return false;
  }
  if (scope === 'events') {
    if (isDay) return false;
    if (hasEvent) return true;
    if (isTicketPaymentMeta(m, m.type)) return true;
    if (isHostedTableVenuePayment(m)) return true;
    const t = String(m.type || '');
    return t === 'HOSTED_TABLE_JOIN' || t === 'TABLE_HOST_FEE' || t === 'HOSTED_TABLE_EXTERNAL_LISTING';
  }
  return true;
}

function bumpCounter(counters, grossKey, netKey, gross, net) {
  counters[grossKey] = (counters[grossKey] || 0) + (Number(gross) || 0);
  counters[netKey] = (counters[netKey] || 0) + (Number(net) || 0);
}

/**
 * Classify revenue into buckets with gross + net amounts.
 * Returns true when the row was counted toward analytics totals.
 * Boosts, promotions, and house-party fees are never counted.
 * @param {'all'|'events'|'day_bookings'|'ticketed_events'} revenueScope
 * @param {string|null} [ledgerRef] - full payout ledger paymentReference (may include :menu suffix)
 */
export function classifyVenuePaymentRevenueScoped(
  mtype,
  pType,
  gross,
  net,
  counters,
  metadata = null,
  revenueScope = 'all',
  ledgerRef = null,
) {
  const meta = isObjectRecord(metadata) ? metadata : {};
  // Day-booking scope: is_day_booking / day-booking heuristics win over stray event_id.
  if (revenueScope === 'day_bookings') {
    if ((meta.event_id ?? meta.eventId) && !isDayBookingPayment(meta)) return false;
  } else if (!paymentMatchesRevenueScope(meta, revenueScope)) {
    return false;
  }
  if (isExcludedFromVenueAnalytics(mtype, pType)) return false;

  const g = Number(gross) || 0;
  const n = net != null ? Number(net) || 0 : g;
  const t = String(mtype || '');

  if (revenueScope === 'day_bookings') {
    if (isMenuPayment(meta, t, ledgerRef)) {
      bumpCounter(counters, 'dayBookingMenuPaymentZar', 'dayBookingMenuPaymentNetZar', g, n);
      bumpCounter(counters, 'menuPaymentZar', 'menuPaymentNetZar', g, n);
      return true;
    }
    if (isDayBookingHostPayment(meta) || isHostedTableVenuePayment(meta)) {
      bumpCounter(counters, 'dayBookingHostPaymentZar', 'dayBookingHostPaymentNetZar', g, n);
      return true;
    }
    if (isDayBookingGuestPayment(meta)) {
      bumpCounter(counters, 'dayBookingGuestPaymentZar', 'dayBookingGuestPaymentNetZar', g, n);
      return true;
    }
    const component = ledgerPaymentComponent(ledgerRef);
    if (component === 'menu') {
      bumpCounter(counters, 'dayBookingMenuPaymentZar', 'dayBookingMenuPaymentNetZar', g, n);
      bumpCounter(counters, 'menuPaymentZar', 'menuPaymentNetZar', g, n);
      return true;
    }
    if (component === 'join') {
      bumpCounter(counters, 'dayBookingGuestPaymentZar', 'dayBookingGuestPaymentNetZar', g, n);
      return true;
    }
    // Sparse day-booking ledger rows (common when payment metadata is incomplete).
    // Venue recipient without :join/:menu is usually the host/table fee; guest joins use :join.
    if (!isTicketPaymentMeta(meta, pType)) {
      const bookingMode = meta.booking_mode || meta.bookingMode;
      const memberRole = meta.member_role || meta.memberRole;
      if (bookingMode === 'join' || memberRole === 'GUEST') {
        bumpCounter(counters, 'dayBookingGuestPaymentZar', 'dayBookingGuestPaymentNetZar', g, n);
      } else {
        bumpCounter(counters, 'dayBookingHostPaymentZar', 'dayBookingHostPaymentNetZar', g, n);
      }
      return true;
    }
    return false;
  }

  if (isMenuPayment(meta, t, ledgerRef)) {
    bumpCounter(counters, 'menuPaymentZar', 'menuPaymentNetZar', g, n);
    if (isDayBookingPayment(meta)) {
      bumpCounter(counters, 'dayBookingMenuPaymentZar', 'dayBookingMenuPaymentNetZar', g, n);
    }
    return true;
  }

  if (isDayBookingHostPayment(meta)) {
    bumpCounter(counters, 'dayBookingHostPaymentZar', 'dayBookingHostPaymentNetZar', g, n);
    return true;
  }

  if (t === 'TABLE_HOST_FEE' || t === 'HOSTED_TABLE_EXTERNAL_LISTING' || isHostedTableVenuePayment(meta)) {
    bumpCounter(counters, 'hostedTablePaymentZar', 'hostedTablePaymentNetZar', g, n);
    return true;
  }

  if (t === 'EVENT_ENTRANCE') {
    bumpCounter(counters, 'entrancePaymentZar', 'entrancePaymentNetZar', g, n);
    return true;
  }

  if (
    t === 'HOSTED_TABLE_JOIN' ||
    t === 'TABLE_CHECKOUT' ||
    t === 'VENUE_TABLE_JOIN' ||
    t === 'table'
  ) {
    if (isDayBookingGuestPayment(meta)) {
      bumpCounter(counters, 'dayBookingGuestPaymentZar', 'dayBookingGuestPaymentNetZar', g, n);
    } else {
      const bookingMode = String(meta.booking_mode || meta.bookingMode || '');
      const memberRole = String(meta.member_role || meta.memberRole || '');
      const component = ledgerPaymentComponent(ledgerRef);
      const isTicketedEventTables = String(meta.event_format || meta.eventFormat || '') === 'TICKETING_ONLY'
        || Boolean(meta.ticketed_event_tables);
      if (isTicketedEventTables) {
        if (component === 'menu' || isMenuPayment(meta, t, ledgerRef)) {
          bumpCounter(counters, 'ticketedTableMenuPaymentZar', 'ticketedTableMenuPaymentNetZar', g, n);
          bumpCounter(counters, 'menuPaymentZar', 'menuPaymentNetZar', g, n);
        } else if (bookingMode === 'host' || bookingMode === 'custom_host' || memberRole === 'HOST') {
          bumpCounter(counters, 'ticketedTableHostPaymentZar', 'ticketedTableHostPaymentNetZar', g, n);
        } else {
          bumpCounter(counters, 'ticketedTableJoinPaymentZar', 'ticketedTableJoinPaymentNetZar', g, n);
        }
      } else {
        bumpCounter(counters, 'venueTablePaymentZar', 'venueTablePaymentNetZar', g, n);
      }
    }
    return true;
  }

  if (isTicketPaymentMeta({ type: t }, pType) || isTicketPaymentMeta(meta, pType)) {
    bumpCounter(counters, 'ticketPaymentZar', 'ticketPaymentNetZar', g, n);
    return true;
  }

  // Ledger component fallbacks when metadata type is missing/unknown.
  const component = ledgerPaymentComponent(ledgerRef);
  if (component === 'join') {
    if (isDayBookingPayment(meta)) {
      bumpCounter(counters, 'dayBookingGuestPaymentZar', 'dayBookingGuestPaymentNetZar', g, n);
    } else {
      bumpCounter(counters, 'venueTablePaymentZar', 'venueTablePaymentNetZar', g, n);
    }
    return true;
  }
  if (component === 'entrance') {
    bumpCounter(counters, 'entrancePaymentZar', 'entrancePaymentNetZar', g, n);
    return true;
  }

  // Keep legitimate venue-scoped revenue in totals even when type metadata is sparse.
  // Boosts/promos already returned false above.
  const hasEvent = Boolean(meta.event_id ?? meta.eventId);
  if (hasEvent || isTicketPaymentMeta(meta, pType)) {
    bumpCounter(counters, 'ticketPaymentZar', 'ticketPaymentNetZar', g, n);
    return true;
  }
  if (isDayBookingPayment(meta)) {
    bumpCounter(counters, 'dayBookingGuestPaymentZar', 'dayBookingGuestPaymentNetZar', g, n);
    return true;
  }
  bumpCounter(counters, 'hostedTablePaymentZar', 'hostedTablePaymentNetZar', g, n);
  return true;
}

/** @deprecated use classifyVenuePaymentRevenueScoped — gross-only wrapper */
export function classifyVenuePaymentRevenue(mtype, pType, amount, counters, metadata = null) {
  classifyVenuePaymentRevenueScoped(mtype, pType, amount, amount, counters, metadata, 'all');
}
