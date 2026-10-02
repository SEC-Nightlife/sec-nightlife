import { flattenPaymentMetadata } from './paymentMetadata.js';

const ZAR_CHANNELS = ['card', 'eft', 'qr', 'bank_transfer'];

/**
 * Paystack checkout breaks when metadata is too large or nested (e.g. full menu lines).
 * Full metadata stays on our Payment row — only send a compact copy to Paystack.
 */
export function slimMetadataForPaystack(meta = {}, userId) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const slim = {
    user_id: String(userId || m.user_id || m.userId || ''),
    type: String(m.type || 'other'),
  };

  const scalarKeys = [
    'event_id',
    'eventId',
    'venue_id',
    'venueId',
    'ticket_tier_name',
    'ticketTierName',
    'quantity',
    'hosted_table_id',
    'hostedTableId',
    'hosted_table_member_id',
    'hostedTableMemberId',
    'venue_table_id',
    'venueTableId',
    'venue_table_member_id',
    'venueTableMemberId',
    'promotion_id',
    'promoId',
    'promoter_user_id',
    'amount_total_zar',
    'service_fee_zar',
    'booking_mode',
    'bookingMode',
    'window_start',
    'windowStart',
    'window_end',
    'windowEnd',
    'booking_date',
    'boostDays',
    'boost_days',
    'sec_kind',
  ];

  for (const key of scalarKeys) {
    if (m[key] != null && m[key] !== '') slim[key] = String(m[key]);
  }

  if (m.holder_names != null) {
    const raw =
      typeof m.holder_names === 'string' ? m.holder_names : JSON.stringify(m.holder_names);
    slim.holder_names = raw.slice(0, 480);
  }

  const menuRaw = m.selected_menu_items ?? m.selectedMenuItems;
  if (Array.isArray(menuRaw) && menuRaw.length) {
    slim.selected_menu_items = JSON.stringify(
      menuRaw.slice(0, 24).map((line) => ({
        menuItemId: line.menuItemId || line.menu_item_id || line.id,
        quantity: line.quantity,
      })),
    ).slice(0, 900);
  } else if (typeof menuRaw === 'string' && menuRaw) {
    slim.selected_menu_items = menuRaw.slice(0, 900);
  }

  return slim;
}

export function buildPaystackInitializeBody({ email, amountInCents, reference, metadata, userId }) {
  const appUrl = process.env.APP_URL ? String(process.env.APP_URL).replace(/\/$/, '') : '';
  return {
    email,
    amount: amountInCents,
    reference,
    currency: 'ZAR',
    channels: ZAR_CHANNELS,
    metadata: slimMetadataForPaystack(metadata, userId),
    callback_url: appUrl ? `${appUrl}/PaymentSuccess?ref=${reference}` : undefined,
  };
}

/**
 * Mark older pending payments as failed when the user starts a fresh checkout.
 */
export async function abandonSupersededPendingPayments(
  db,
  { userId, paymentType, eventId = null, ticketTier = null },
) {
  if (!userId) return { abandoned: 0 };

  const pending = await db.payment.findMany({
    where: {
      userId: String(userId),
      status: 'pending',
      ...(paymentType ? { type: paymentType } : {}),
    },
    select: { id: true, reference: true, metadata: true },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });

  const refs = [];
  const ids = [];
  for (const row of pending) {
    const m = flattenPaymentMetadata(row.metadata);
    if (eventId && String(m.event_id || m.eventId || '') !== String(eventId)) continue;
    if (ticketTier && String(m.ticket_tier_name || m.ticketTierName || '') !== String(ticketTier)) {
      continue;
    }
    ids.push(row.id);
    if (row.reference) refs.push(row.reference);
  }

  if (!ids.length) return { abandoned: 0 };

  await db.payment.updateMany({
    where: { id: { in: ids } },
    data: { status: 'failed' },
  });

  if (refs.length) {
    await db.transaction.updateMany({
      where: { stripeId: { in: refs } },
      data: { status: 'failed' },
    });
  }

  return { abandoned: ids.length };
}
