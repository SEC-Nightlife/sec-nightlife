/**
 * Human-readable payout labels for Sec Wallet UI and Paystack transfer reasons.
 */

export function basePaymentReference(paymentReference) {
  const ref = String(paymentReference || '');
  const cut = ref.search(/:(menu|join)\b/i);
  if (cut > 0) return ref.slice(0, cut);
  return ref;
}

function flattenMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const nested = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
  return { ...nested, ...value };
}

/** Short type label from payment metadata and/or ledger reference. */
export function payoutTypeLabel({ paymentReference = '', metadata = null } = {}) {
  const ref = String(paymentReference || '');
  const meta = flattenMeta(metadata);
  const type = String(meta.type || meta.sec_kind || meta.secKind || '').toUpperCase();

  if (ref.includes(':menu') || /:menu$/i.test(ref) || type === 'HOSTED_TABLE_MENU') {
    return 'Menu order';
  }
  if (type === 'MENU_ADDON') {
    return 'Add-on order';
  }
  if (ref.includes(':join') || type === 'HOSTED_TABLE_JOIN' || type === 'VENUE_TABLE_JOIN') {
    return 'Table join';
  }
  if (
    type === 'TICKET'
    || type === 'EVENT'
    || meta.ticket_tier_name
    || meta.ticketTierName
    || ref.toLowerCase().includes('ticket')
  ) {
    return 'Event ticket';
  }
  if (type === 'TABLE_CHECKOUT' || type === 'VENUE_TABLE') {
    return 'Table booking';
  }
  if (type === 'TABLE_HOST_FEE') {
    return 'Host fee';
  }
  if (type === 'EVENT_ENTRANCE' || type === 'HOUSE_PARTY_ENTRANCE') {
    return 'Entrance';
  }
  if (type.includes('BOOST') || type === 'PROMOTION_PUBLISH' || type === 'PROMOTION_BOOST') {
    return 'Promotion';
  }
  if (ref.includes('table') || ref.includes('TABLE')) return 'Table booking';
  if (ref.includes('host')) return 'Host fee';
  if (ref.includes('promo')) return 'Promotion';
  if (type) return 'Earnings';
  return 'Earnings';
}

function contextName(metadata) {
  const meta = flattenMeta(metadata);
  const name =
    meta.event_title
    || meta.eventTitle
    || meta.venue_name
    || meta.venueName
    || meta.table_name
    || meta.tableName
    || null;
  if (!name) return null;
  return String(name).replace(/\s+/g, ' ').trim().slice(0, 40);
}

/**
 * Paystack transfer reason (max ~100 chars). Banks may shorten further.
 */
export function buildPaystackTransferReason({ paymentReference = '', metadata = null } = {}) {
  const typeLabel = payoutTypeLabel({ paymentReference, metadata });
  const ctx = contextName(metadata);
  let reason = ctx ? `SEC Nightlife · ${typeLabel} · ${ctx}` : `SEC Nightlife · ${typeLabel}`;
  if (reason.length > 100) {
    reason = `SEC Nightlife · ${typeLabel}`.slice(0, 100);
  }
  return reason;
}
