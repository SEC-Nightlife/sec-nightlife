/**
 * Paystack-only payment routes.
 * NO Stripe or other gateways. All payments via Paystack.
 * SECURITY: JWT required for initialize/verify; webhook uses HMAC signature.
 */
import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken } from '../middleware/auth.js';
import { userHasIdentityVerified } from '../middleware/requireIdentityVerified.js';
import { createNotification, createNotifications } from '../lib/notifications.js';
import { logFriendActivity } from '../lib/friendActivity.js';
import { recordTableHistory, recordVenueHostParticipation, hostParticipationOccurredAt } from '../lib/tableHistory.js';
import { upsertConfirmedAttendance } from '../lib/eventAttendance.js';
import { sendEmail } from '../lib/email.js';
import { createInAppNotification } from '../lib/inAppNotifications.js';
import { logger } from '../lib/logger.js';
import { normalizeHostingConfig } from '../lib/hostingConfig.js';
import { expectedTotalFromMetadata } from '../lib/checkoutLines.js';
import {
  computeTicketCheckout,
  buildTicketPaymentMetadata,
  expectedTicketTotalFromMetadata,
} from '../lib/ticketCheckout.js';
import { computeEventEntranceCheckout, issueEventEntranceFromPayment } from '../lib/issueEventEntrance.js';
import { normalizeGuestGenderPreference } from '../lib/genderPreference.js';
import { getEventEntranceZar } from '../lib/hostedTableSecFees.js';
import {
  recordEventVenueTableBooking,
  recordGuestEventVenueTableBookingIfNeeded,
} from '../lib/eventVenueBooking.js';
import { ensureHostedTableFromVenueHostPayment, resolveVenueIdForHostedTable } from '../lib/venueTableHostAfterPayment.js';
import { resolveDailySessionNumber } from '../lib/dailyTableSession.js';
import { windowEndInstant } from '../lib/dayBookingWindows.js';
import {
  visibleUntilAfterEventDate,
  visibleUntilAfterParty,
  visibleUntilAfterHostedTable,
  visibleUntilForVenueTableMember,
  visibleUntilForDayVenueTable,
  eventStartsAtFromEvent,
  eventStartsAtFromHostedTable,
  eventEndsAtFromEvent,
  dayStartsAtFromVenueTable,
  dayEndsAtFromVenueTable,
  dayEventStartsAtFromMember,
  holderDisplayNameFromUser,
  venueTableTicketTitle,
  formatSpecsFromTable,
  formatSpecsFromVenueTable,
  formatSpecsFromHostedTable,
  refreshHostedTableTickets,
} from '../lib/ticketHelpers.js';
import { mergeMemberMenuItems, resolveVenueMenuSelections } from '../lib/menuHelpers.js';
import {
  buildVenueTableMemberTicketSummary,
  buildHostedTableJoinTicketSummary,
  buildHostedTableMenuTicketSummary,
  buildHostedTableHostTicketSummary,
} from '../lib/ticketMemberSummary.js';
import { issueTicketAndNotify } from '../lib/issueTicket.js';
import { issueEventTicketsFromPayment, ensureEventTicketsForPayment } from '../lib/issueEventTickets.js';
import { ensureVenueTableFulfillmentForPayment } from '../lib/ensureVenueTableFulfillment.js';
import { reconcileTableInvitesOnJoin } from '../lib/hostedTableInvites.js';
import { promoterUserIdFromMetadata, recordPromoterConversion } from '../lib/promoterAttribution.js';

async function applyPromoterAttribution({ metadata, eventId, buyerUserId, conversionType, amountZar, reference, quantity = 1 }) {
  const promoterUserId = promoterUserIdFromMetadata(metadata);
  if (!promoterUserId || !eventId || !buyerUserId) return null;
  return recordPromoterConversion({
    eventId,
    promoterUserId,
    conversionType,
    buyerUserId: String(buyerUserId),
    amountZar,
    paystackReference: reference,
    quantity,
  });
}

function parseTicketMenuItems(meta) {
  const raw = meta?.selected_menu_items;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
import { notifyPaymentSuccess } from '../lib/paymentNotifications.js';
import {
  recordPayoutAndMaybeTransfer,
  recordSecPlatformRevenue,
  resolveRecipientCodeForUser,
  resolveRecipientCodeForVenue,
  splitSecPlatform,
  applyTransferWebhookEvent,
  expectedPlatformProductAmountZar,
  EXTERNAL_HOSTED_LISTING_ZAR,
} from '../lib/paystackPayout.js';
import { ensureHostedTableLiveAfterListingPayment } from '../lib/hostedTableAfterListingPaid.js';
import { addUserToHostedTableGroupChat } from '../lib/hostedTableGroupChat.js';
import {
  activatePromotionAfterPublishPayment,
  isPromotionPublishPayment,
  resolvePromotionIdFromMetadata,
} from '../lib/promotionPublishAfterPayment.js';
import {
  abandonSupersededPendingPayments,
  buildPaystackInitializeBody,
} from '../lib/paystackInitialize.js';
import { netOfServiceFee, serviceFeeFromMeta } from '../lib/serviceFee.js';

const router = Router();

const tableCreateFromPaymentSchema = z.object({
  event_id: z.string().uuid(),
  venue_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  table_category: z.enum(['general', 'vip']).optional(),
  max_guests: z.number().int().min(1).max(500),
  min_spend: z.number().min(0).optional(),
  joining_fee: z.number().min(0).optional(),
  is_public: z.boolean().optional(),
  guest_gender_preference: z.enum(['ANY', 'MALE_ONLY', 'FEMALE_ONLY', 'OTHER_ONLY']).optional(),
});

const PAYMENT_TYPES = ['event', 'table', 'promotion', 'ticket', 'other'];

function requirePaystackKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    const err = new Error('Paystack is not configured');
    err.status = 500;
    throw err;
  }
  return key;
}

/** Public key for Paystack Inline in the browser (safe to expose). Set on the API alongside the secret. */
function getPaystackPublicKeyForClient() {
  return String(process.env.PAYSTACK_PUBLIC_KEY || process.env.VITE_PAYSTACK_PUBLIC_KEY || '').trim();
}

async function paystackFetch(path, { method = 'GET', body } = {}) {
  const key = requirePaystackKey();
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.status) {
    const msg = data?.message || 'Paystack request failed';
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Merge Paystack verify metadata with what we stored on Payment.
 * Paystack often echoes incomplete metadata and may overwrite keys like `type` — our DB copy must win.
 */
function mergePaymentMetadataFromVerify(priorMeta, paystackData) {
  const rawMd = paystackData?.metadata;
  let fromCharge = {};
  if (rawMd && typeof rawMd === 'object' && !Array.isArray(rawMd)) {
    fromCharge = rawMd;
  } else if (typeof rawMd === 'string') {
    try {
      fromCharge = JSON.parse(rawMd) || {};
    } catch {
      fromCharge = {};
    }
  }
  return { ...fromCharge, ...priorMeta };
}

function isObjectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function flattenPaymentMetadata(value) {
  if (!isObjectRecord(value)) return {};
  const nested = isObjectRecord(value.metadata) ? value.metadata : {};
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

async function getVenueTablePayoutStatus(reference) {
  const log = await prisma.splitPaymentLog.findFirst({ where: { reference } });
  if (!log) return { ledger: 'missing' };
  const payout = await prisma.payoutLedger.findFirst({ where: { paymentReference: reference } });
  return {
    ledger: 'ok',
    secAmount: log.secAmount,
    venueAmount: log.venueAmount,
    transferStatus: payout?.status || 'pending',
  };
}

async function finalizePaymentIfFulfilled(reference, paystackData = null) {
  const pay = await prisma.payment.findUnique({
    where: { reference },
    select: { status: true, metadata: true, amount: true },
  });
  if (!pay) return;
  const meta = flattenPaymentMetadata(pay.metadata);
  if (pay.status === 'success' && meta.side_effects_applied) return;

  // Only finalize when domain fulfillment is actually complete.
  // Never mark a pending payment as success here — that stranded external listings
  // when side effects were skipped but Paystack had already charged the card.
  const fulfillmentComplete = await isPaymentFulfillmentComplete(reference, meta);
  if (!fulfillmentComplete) return;

  const paystackOk = paystackData?.status === 'success' || pay.status === 'success';
  if (!paystackOk) return;

  const amount =
    paystackData?.amount != null && Number(paystackData.amount) > 0
      ? Number(paystackData.amount) / 100
      : Number(pay.amount) || 0;
  const { side_effects_processing: _sp, side_effects_processing_at: _spa, ...metaBase } = meta;
  await prisma.payment.updateMany({
    where: { reference },
    data: {
      status: 'success',
      ...(amount > 0 ? { amount } : {}),
      metadata: {
        ...metaBase,
        side_effects_applied: true,
        side_effects_processing: false,
      },
    },
  });
}

const SIDE_EFFECTS_PROCESSING_STALE_MS = 2 * 60 * 1000;
const HOST_FULFILLMENT_TX_OPTS = { timeout: 30000, maxWait: 10000 };

function sideEffectsProcessingIsStale(meta) {
  if (!meta?.side_effects_processing) return true;
  const started = meta.side_effects_processing_at
    ? new Date(meta.side_effects_processing_at).getTime()
    : 0;
  if (!started || Number.isNaN(started)) return true;
  return Date.now() - started > SIDE_EFFECTS_PROCESSING_STALE_MS;
}

async function applyReferenceSideEffects(reference, paystackData) {
  const priorPay = await prisma.payment.findUnique({
    where: { reference },
    select: { metadata: true, userId: true, email: true, type: true, status: true, amount: true },
  });
  if (!priorPay) return;
  const priorMeta = flattenPaymentMetadata(priorPay.metadata);
  if (priorMeta.side_effects_applied) {
    await runPaymentRepairPaths(reference, paystackData, { replayIncomplete: false });
    await finalizePaymentIfFulfilled(reference, paystackData);
    return;
  }

  if (priorMeta.side_effects_processing && !sideEffectsProcessingIsStale(priorMeta)) {
    await runPaymentRepairPaths(reference, paystackData, { replayIncomplete: false });
    await finalizePaymentIfFulfilled(reference, paystackData);
    return;
  }

  const metadata = flattenPaymentMetadata(mergePaymentMetadataFromVerify(priorMeta, paystackData));

  const claimed = await prisma.payment.updateMany({
    where: {
      reference,
      NOT: { metadata: { path: ['side_effects_applied'], equals: true } },
    },
    data: {
      metadata: {
        ...metadata,
        side_effects_processing: true,
        side_effects_processing_at: new Date().toISOString(),
      },
    },
  });
  if (claimed.count === 0) {
    const latest = await prisma.payment.findUnique({
      where: { reference },
      select: { metadata: true },
    });
    const latestMeta = flattenPaymentMetadata(latest?.metadata);
    if (latestMeta.side_effects_processing && !sideEffectsProcessingIsStale(latestMeta)) {
      await runPaymentRepairPaths(reference, paystackData, { replayIncomplete: false });
      await finalizePaymentIfFulfilled(reference, paystackData);
      return;
    }
    await runPaymentRepairPaths(reference, paystackData, { replayIncomplete: false });
    await finalizePaymentIfFulfilled(reference, paystackData);
    return;
  }

  const userId = priorPay.userId || metadata.user_id || metadata.userId || null;
  const email =
    paystackData?.customer?.email || priorPay.email || metadata.email || 'unknown@secnightlife.app';
  // Prefer Paystack kobo amount; fall back to the Payment row (ZAR). Missing priorPay.amount
  // previously collapsed to 0 and silently skipped EXTERNAL_LISTING activation.
  const chargedAmount =
    paystackData?.amount != null && Number(paystackData.amount) > 0
      ? Number(paystackData.amount) / 100
      : Number(priorPay?.amount) || 0;
  // Venue/host gross for every split, payout, and booking total below — excludes the SEC service fee.
  const serviceFeeZar = serviceFeeFromMeta(metadata);
  const amount = netOfServiceFee(metadata, chargedAmount);
  const type = metadata.type || 'other';

  try {
  // Legacy: update Transaction if exists
  await prisma.transaction.updateMany({
    where: { stripeId: reference },
    data: { status: 'paid', metadata: paystackData },
  });

  if (serviceFeeZar > 0) {
    await recordSecPlatformRevenue(`${reference}:service_fee`, serviceFeeZar);
  }

  const PROMO_MS_DAY = 24 * 60 * 60 * 1000;
  const promoId = resolvePromotionIdFromMetadata(metadata);
  const isPromoPublish = isPromotionPublishPayment(metadata, priorPay.type);
  if (!promoId && (metadata.sec_kind === 'PROMOTION_PUBLISH' || metadata.type === 'BOOST')) {
    console.warn('applyReferenceSideEffects: promotion metadata missing promoId', {
      reference,
      sec_kind: metadata.sec_kind,
      type: metadata.type,
    });
  }

  if (isPromoPublish && promoId) {
    const activation = await activatePromotionAfterPublishPayment({
      promoId,
      metadata,
      reference,
      payerUserId: priorPay.userId || userId,
      payerEmail: email,
      sendNotification: true,
    });
    if (!activation.activated && activation.reason !== 'already_live') {
      console.error('PROMOTION_PUBLISH: activation failed', {
        reference,
        promoId,
        reason: activation.reason,
        status: activation.promotion?.status,
      });
      throw new Error(
        activation.reason
          ? `Promotion activation failed: ${activation.reason}`
          : 'Promotion activation failed after payment',
      );
    }
    if (amount > 0) {
      await recordSecPlatformRevenue(reference, amount);
    }
  } else if ((metadata.sec_kind === 'BOOST' || metadata.type === 'BOOST') && promoId) {
    const boostDaysRaw = metadata.boostDays ?? metadata.boost_days;
    const boostDays = Math.min(30, Math.max(1, parseInt(String(boostDaysRaw || '7'), 10) || 7));
    const boostExpiry = new Date(Date.now() + boostDays * PROMO_MS_DAY);

    const preBoost = await prisma.promotion.findFirst({
      where: { id: String(promoId), deletedAt: null },
      select: { boostPaystackRef: true },
    });
    if (preBoost?.boostPaystackRef === reference) {
      // Idempotent: same Paystack reference already applied
    } else {
      await prisma.promotion.updateMany({
        where: { id: String(promoId), deletedAt: null },
        data: {
          boosted: true,
          boostedAt: new Date(),
          boostExpiresAt: boostExpiry,
          boostPaystackRef: reference,
          status: 'ACTIVE',
        },
      });

      const promo = await prisma.promotion.findFirst({
        where: { id: String(promoId), deletedAt: null },
        select: { id: true, title: true, venueId: true, boostExpiresAt: true },
      });
      if (promo) {
        const venue = await prisma.venue.findFirst({
          where: { id: promo.venueId, deletedAt: null },
          select: { ownerUserId: true, name: true, owner: { select: { email: true } } },
        });
        const boostTitle = 'Promotion boost active';
        const boostBody = `"${promo.title}" is now boosted for ${venue?.name || 'your venue'}.`;
        const payerId = String(priorPay.userId || userId || venue?.ownerUserId || '');
        const payerEmail =
          email && email !== 'unknown@secnightlife.app' ? email : venue?.owner?.email || null;
        await notifyPaymentSuccess({
          userId: payerId,
          email: payerEmail,
          title: boostTitle,
          body: boostBody,
          actionUrl: '/BusinessPromotions',
          referenceId: promo.id,
          referenceType: 'PROMOTION',
          emailSubject: `${boostTitle} — ${promo.title}`,
        });
      }
    }
    if (amount > 0) {
      await recordSecPlatformRevenue(reference, amount);
    }
  }

  const housePartyIdMeta = metadata.housePartyId || metadata.house_party_id;
  if (metadata.type === 'HOUSE_PARTY_PUBLISH' && housePartyIdMeta && userId) {
    const party = await prisma.houseParty.findFirst({ where: { id: String(housePartyIdMeta) } });
    if (party && party.hostUserId === userId) {
      await prisma.houseParty.update({
        where: { id: party.id },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          publishPaystackRef: reference,
        },
      });
      await createInAppNotification({
        userId: party.hostUserId,
        type: 'EVENT_JOINED',
        title: 'Party live',
        body: 'Your house party is now live!',
        referenceId: party.id,
        referenceType: 'HOUSE_PARTY',
      });
      if (amount > 0) {
        await recordSecPlatformRevenue(reference, amount);
      }
    }
  }

  if (metadata.type === 'HOUSE_PARTY_BOOST' && housePartyIdMeta && userId) {
    const boostExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const party = await prisma.houseParty.findFirst({ where: { id: String(housePartyIdMeta) } });
    if (party && party.hostUserId === userId) {
      await prisma.houseParty.update({
        where: { id: party.id },
        data: {
          boosted: true,
          boostedAt: new Date(),
          boostExpiresAt: boostExpiry,
          boostPaystackRef: reference,
        },
      });
      await createInAppNotification({
        userId: party.hostUserId,
        type: 'EVENT_JOINED',
        title: 'Boost active',
        body: 'Your house party boost is active for 7 days!',
        referenceId: party.id,
        referenceType: 'HOUSE_PARTY',
      });
      if (amount > 0) {
        await recordSecPlatformRevenue(reference, amount);
      }
    }
  }

  const hostedTableBoostId = metadata.hostedTableId || metadata.hosted_table_id;
  if (metadata.type === 'TABLE_BOOST' && hostedTableBoostId && userId) {
    const boostDaysRaw = metadata.boostDays ?? metadata.boost_days;
    const boostDays = Math.min(30, Math.max(1, parseInt(String(boostDaysRaw || '7'), 10) || 7));
    const boostExpiry = new Date(Date.now() + boostDays * 24 * 60 * 60 * 1000);
    const ht = await prisma.hostedTable.findFirst({ where: { id: String(hostedTableBoostId) } });
    if (ht && ht.hostUserId === userId) {
      await prisma.hostedTable.update({
        where: { id: ht.id },
        data: {
          boosted: true,
          boostedAt: new Date(),
          boostExpiresAt: boostExpiry,
          boostPaystackRef: reference,
        },
      });
      if (amount > 0) {
        await recordSecPlatformRevenue(reference, amount);
      }
    }
  }

  const eventBoostId = metadata.eventId || metadata.event_id;
  if (metadata.type === 'EVENT_BOOST' && eventBoostId) {
    const boostDaysRaw = metadata.boostDays ?? metadata.boost_days;
    const boostDays = Math.min(30, Math.max(1, parseInt(String(boostDaysRaw || '1'), 10) || 1));
    const boostExpiry = new Date(Date.now() + boostDays * 24 * 60 * 60 * 1000);
    const evt = await prisma.event.findFirst({
      where: { id: String(eventBoostId), deletedAt: null },
      include: { venue: { select: { ownerUserId: true, name: true } } },
    });
    if (evt) {
      await prisma.event.update({
        where: { id: evt.id },
        data: {
          boosted: true,
          boostedAt: new Date(),
          boostExpiresAt: boostExpiry,
          boostPaystackRef: reference,
        },
      });
      if (amount > 0) {
        await recordSecPlatformRevenue(reference, amount);
      }
      if (evt.venue?.ownerUserId) {
        await createInAppNotification({
          userId: evt.venue.ownerUserId,
          type: 'EVENT_JOINED',
          title: 'Event boost active',
          body: `"${evt.title}" is boosted for ${boostDays} day${boostDays === 1 ? '' : 's'}.`,
          referenceId: evt.id,
          referenceType: 'EVENT',
        });
      }
    }
  }

  const venueTableBoostId = metadata.venueTableId || metadata.venue_table_id;
  if (metadata.type === 'VENUE_TABLE_BOOST' && venueTableBoostId) {
    const boostDaysRaw = metadata.boostDays ?? metadata.boost_days;
    const boostDays = Math.min(30, Math.max(1, parseInt(String(boostDaysRaw || '1'), 10) || 1));
    const boostExpiry = new Date(Date.now() + boostDays * 24 * 60 * 60 * 1000);
    const vt = await prisma.venueTable.findFirst({
      where: { id: String(venueTableBoostId) },
      include: { venue: { select: { ownerUserId: true, name: true } } },
    });
    if (vt) {
      await prisma.venueTable.update({
        where: { id: vt.id },
        data: {
          boosted: true,
          boostedAt: new Date(),
          boostExpiresAt: boostExpiry,
          boostPaystackRef: reference,
        },
      });
      if (amount > 0) {
        await recordSecPlatformRevenue(reference, amount);
      }
      if (vt.venue?.ownerUserId) {
        await createInAppNotification({
          userId: vt.venue.ownerUserId,
          type: 'EVENT_JOINED',
          title: 'Table boost active',
          body: `"${vt.tableName}" is boosted for ${boostDays} day${boostDays === 1 ? '' : 's'}.`,
          referenceId: vt.id,
          referenceType: 'VENUE_TABLE',
        });
      }
    }
  }

  if (metadata.type === 'HOSTED_TABLE_MENU' && userId) {
    const htid = metadata.hosted_table_id || metadata.hostedTableId;
    const memberId = metadata.hosted_table_member_id || metadata.hostedTableMemberId;
    const menuZar = Number(metadata.menu_zar || amount || 0);
    if (htid && memberId && menuZar > 0) {
      const mem = await prisma.hostedTableMember.findFirst({
        where: { id: String(memberId), hostedTableId: String(htid), userId: String(userId) },
        include: { hostedTable: { include: { event: true } } },
      });
      const alreadyMenu = await prisma.payoutLedger.findFirst({
        where: { paymentReference: reference },
      });
      if (mem && mem.status === 'GOING' && !alreadyMenu) {
        const added = metadata.selected_menu_items || metadata.selectedMenuItems || [];
        const merged = mergeMemberMenuItems(mem.selectedMenuItems, added);
        await prisma.$transaction(async (tx) => {
          await tx.hostedTableMember.update({
            where: { id: mem.id },
            data: {
              selectedMenuItems: merged,
              menuSpendPaid: { increment: menuZar },
            },
          });
          await tx.hostedTable.update({
            where: { id: mem.hostedTableId },
            data: { menuSpendTotal: { increment: menuZar } },
          });
        });
        const { secAmount, recipientAmount: venueAmount } = splitSecPlatform(menuZar);
        const venueId =
          mem.hostedTable?.event?.venueId ||
          metadata.venue_id ||
          metadata.venueId ||
          (mem.hostedTable ? await resolveVenueIdForHostedTable(prisma, mem.hostedTable) : null);
        if (venueId) {
          const venueCode = await resolveRecipientCodeForVenue(venueId);
          await recordPayoutAndMaybeTransfer({
            paymentReference: reference,
            grossZar: menuZar,
            secAmount,
            recipientAmount: venueAmount,
            recipientType: 'VENUE',
            recipientVenueId: venueId,
            recipientUserId: null,
            paystackRecipientCode: venueCode,
          });
        }
        if (venueId && mem.hostedTable?.eventId) {
          const role = mem.userId === mem.hostedTable.hostUserId ? 'HOST' : 'GUEST';
          await recordEventVenueTableBooking({
            venueId,
            eventId: mem.hostedTable.eventId,
            hostedTableId: mem.hostedTableId,
            userId: String(userId),
            role,
            paystackReference: reference,
            amountTotal: menuZar,
            componentZar: menuZar,
            selectedMenuItems: merged,
            hostingTierName: mem.hostedTable.tierIncludedItems?.tier_name || null,
            hostingCategory: mem.hostedTable.hostingCategory,
            menuTotalZar: menuZar,
          });
        }
        const ht = mem.hostedTable;
        const hostUser = await prisma.user.findUnique({
          where: { id: ht.hostUserId },
          select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
        });
        const payer = await prisma.user.findUnique({
          where: { id: String(userId) },
          select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
        });
        const vis = ht.event ? visibleUntilAfterEventDate(ht.event.date) : visibleUntilAfterHostedTable(ht);
        const eventStartsAt = ht.event
          ? eventStartsAtFromEvent(ht.event)
          : eventStartsAtFromHostedTable(ht);
        const eventEndsAt = ht.event ? eventEndsAtFromEvent(ht.event) : null;
        let menuItemsForSummary = merged;
        if (venueId && Array.isArray(merged) && merged.length) {
          const resolved = await resolveVenueMenuSelections(
            merged.map((line) => ({
              menuItemId: line.menuItemId,
              quantity: line.quantity,
            })),
            venueId,
          );
          menuItemsForSummary = resolved.items;
        }
        const menuSummary = buildHostedTableMenuTicketSummary({
          hostedTable: ht,
          hostUser,
          guestUser: payer,
          menuItems: menuItemsForSummary,
        });
        await issueTicketAndNotify(prisma, {
          userId: String(userId),
          email: payer?.email || email,
          paystackReference: reference,
          kind: 'HOSTED_TABLE_JOIN',
          title: `${ht.tableName} — Your menu order`,
          subtitle: ht.venueName,
          visibleUntil: vis,
          hostedTableId: ht.id,
          eventId: ht.eventId || null,
          quantity: 1,
          holderDisplayName: holderDisplayNameFromUser(payer),
          tableSpecsSummary: menuSummary,
          eventStartsAt,
          eventEndsAt,
        });
        await createInAppNotification({
          userId: String(userId),
          type: 'TABLE_JOINED',
          title: 'Menu order confirmed',
          body: `Your items for "${mem.hostedTable.tableName}" were added to the table. Show your menu QR to staff.`,
          referenceId: mem.hostedTableId,
          referenceType: 'HOSTED_TABLE',
        });
      }
    }
  }

  const venueTableId = metadata.venueTableId || metadata.venue_table_id;
  const venueTableMemberId = metadata.venueTableMemberId || metadata.venue_table_member_id;
  if (
    (metadata.type === 'VENUE_TABLE_JOIN' || metadata.type === 'TABLE_CHECKOUT') &&
    venueTableId &&
    venueTableMemberId &&
    userId
  ) {
    let hostFulfillmentError = null;
    await prisma.$transaction(async (tx) => {
      const member = await tx.venueTableMember.findFirst({
        where: { id: String(venueTableMemberId), venueTableId: String(venueTableId), userId: String(userId) },
        include: { venueTable: { include: { venue: true } } },
      });
      if (!member) return;
      if (member.status === 'CONFIRMED') return;
      const table = member.venueTable;
      const totalPaid = Number(amount || 0);
      const { secAmount, recipientAmount: venueAmount } = splitSecPlatform(totalPaid);

      const windowFields = memberWindowFieldsFromMetadata(member, metadata);
      const memberForHost = { ...member, ...windowFields };
      const isHostPayment = isVenueTableHostPayment(metadata, member);

      if (isHostPayment) {
        if (Object.keys(windowFields).length) {
          await tx.venueTableMember.update({
            where: { id: member.id },
            data: windowFields,
          });
        }
        const hostResult = await ensureHostedTableFromVenueHostPayment({
          tx,
          venueTable: table,
          userId: String(userId),
          paystackReference: reference,
          amountTotal: totalPaid,
          selectedMenuItems: metadata.selectedMenuItems || member.selectedMenuItems,
          settlementMode: metadata.settlement_mode || member.settlementMode,
          hostMember: memberForHost,
        });
        if (!hostResult.ok) {
          throw new Error(`host_fulfillment_failed:${hostResult.error || 'host_table_create_failed'}`);
        }
        const freshTable = await tx.venueTable.findUnique({ where: { id: table.id } });
        if (!freshTable?.hostedTableId) {
          throw new Error('host_fulfillment_failed:hosted_table_id_missing');
        }
      }

      const currentOccupancy = table.currentOccupancy + 1;
      const amountContributed = table.amountContributed + totalPaid;
      const nextStatus =
        currentOccupancy >= table.guestCapacity
          ? 'LOCKED'
          : (amountContributed >= table.minimumSpend ? 'PARTIALLY_FILLED' : 'AVAILABLE');
      const dailySessionNumber = resolveDailySessionNumber(table, new Date());

      await tx.venueTableMember.update({
        where: { id: member.id },
        data: {
          status: 'CONFIRMED',
          amountPaid: totalPaid,
          selectedMenuItems: metadata.selectedMenuItems || member.selectedMenuItems,
          paidAt: new Date(),
          paystackReference: reference,
          tableSessionNumber: dailySessionNumber,
          ...windowFields,
        },
      });
      try {
        const { ensureVenueTableThread } = await import('./venueTableMessages.js');
        await ensureVenueTableThread(member.id);
      } catch (threadErr) {
        console.warn('ensureVenueTableThread after payment failed', threadErr?.message);
      }
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
            memberId: member.id,
            totalAmount: totalPaid,
            secAmount,
            venueAmount,
            reference,
          },
        });
      }

      const user = await tx.user.findUnique({
        where: { id: String(userId) },
        include: { userProfile: { select: { username: true } } },
      });
      const username = user?.userProfile?.username || user?.username || 'someone';
      await createInAppNotification({
        userId: table.venue.ownerUserId,
        type: 'TABLE_JOINED',
        title: isHostPayment ? 'New table host' : 'Venue table joined',
        body: isHostPayment
          ? `@${username} is now hosting ${table.tableName} (R${totalPaid.toFixed(2)} paid).`
          : `@${username} joined your table ${table.tableName} and contributed R${totalPaid.toFixed(2)}`,
        referenceId: table.id,
        referenceType: 'VENUE_TABLE',
      });
    }, HOST_FULFILLMENT_TX_OPTS);

    const memberForRepair = await prisma.venueTableMember.findFirst({
      where: {
        id: String(venueTableMemberId),
        venueTableId: String(venueTableId),
        userId: String(userId),
      },
    });
    const isHostRepair = isVenueTableHostPayment(metadata, memberForRepair);
    if (isHostRepair && memberForRepair?.status === 'CONFIRMED') {
      const tableForRepair = await prisma.venueTable.findUnique({ where: { id: String(venueTableId) } });
      if (tableForRepair && !tableForRepair.hostedTableId) {
        await prisma.$transaction(async (tx) => {
          const freshTable = await tx.venueTable.findUnique({ where: { id: String(venueTableId) } });
          if (freshTable && !freshTable.hostedTableId) {
            const windowFields = memberWindowFieldsFromMetadata(memberForRepair, metadata);
            const hostResult = await ensureHostedTableFromVenueHostPayment({
              tx,
              venueTable: freshTable,
              userId: String(userId),
              paystackReference: reference,
              amountTotal: Number(amount || 0),
              selectedMenuItems: metadata.selectedMenuItems || memberForRepair.selectedMenuItems,
              settlementMode: metadata.settlement_mode || memberForRepair.settlementMode,
              hostMember: { ...memberForRepair, ...windowFields },
            });
            if (!hostResult.ok) {
              hostFulfillmentError = hostResult.error || hostFulfillmentError;
            }
          }
        }, HOST_FULFILLMENT_TX_OPTS);
      }
    }

    const vtAfterHost = await prisma.venueTable.findUnique({ where: { id: String(venueTableId) } });

    const vtMember = await prisma.venueTableMember.findFirst({
      where: {
        id: String(venueTableMemberId),
        venueTableId: String(venueTableId),
        userId: String(userId),
      },
      include: {
        venueTable: {
          select: { id: true, tableName: true, eventId: true, hostUserId: true },
        },
      },
    });
    if (vtMember?.venueTable) {
      const vtEv = vtMember.venueTable.eventId
        ? await prisma.event.findFirst({
            where: { id: vtMember.venueTable.eventId },
            select: { title: true },
          })
        : null;
      const isHostRole =
        (metadata.booking_mode || metadata.bookingMode) === 'host' ||
        (metadata.booking_mode || metadata.bookingMode) === 'custom_host' ||
        vtMember.memberRole === 'HOST';
      if (isHostRole) {
        recordVenueHostParticipation({
          userId: String(userId),
          venueTable: vtMember.venueTable,
          hostedTableId: vtAfterHost?.hostedTableId ?? null,
          member: vtMember,
          eventTitle: vtEv?.title || null,
        });
      } else {
        recordTableHistory({
          userId: String(userId),
          role: 'JOINED',
          venueTableId: vtMember.venueTable.id,
          eventId: vtMember.venueTable.eventId || null,
          tableName: vtMember.venueTable.tableName,
          eventTitle: vtEv?.title || null,
          occurredAt: hostParticipationOccurredAt(vtMember, vtMember.venueTable),
        });
      }
    }
    const bookingModePaid = metadata.booking_mode || metadata.bookingMode;
    const isHostPaymentPaid = isVenueTableHostPayment(metadata, vtMember);
    const payerRow = await prisma.user.findUnique({
      where: { id: String(userId) },
      select: { email: true },
    });
    const payerEmail = payerRow?.email || email;
    const hostTableReady = !isHostPaymentPaid || Boolean(vtAfterHost?.hostedTableId);
    if (hostTableReady) {
      if (isHostPaymentPaid) {
        await notifyPaymentSuccess({
          userId: String(userId),
          email: payerEmail,
          title: 'Table host payment confirmed',
          body: `You're now hosting ${vtMember?.venueTable?.tableName || 'your table'}. Open Host Dashboard to approve join requests and set table rules.`,
          actionUrl: '/HostDashboard?tab=tables&manage=1',
          referenceId: String(venueTableId),
          referenceType: 'VENUE_TABLE',
          emailSubject: `You're hosting ${vtMember?.venueTable?.tableName || 'your table'}`,
        });
      } else {
        await notifyPaymentSuccess({
          userId: String(userId),
          email: payerEmail,
          title: 'Table booking confirmed',
          body: `Your payment for ${vtMember?.venueTable?.tableName || 'your table'} was successful.`,
          actionUrl: `/TableDetails?id=${venueTableId}&source=venue`,
          referenceId: String(venueTableId),
          referenceType: 'VENUE_TABLE',
          emailSubject: `Booking confirmed — ${vtMember?.venueTable?.tableName || 'table'}`,
        });
      }
    }

    const vt = await prisma.venueTable.findUnique({
      where: { id: String(venueTableId) },
      include: { event: true, venue: true },
    });
    if (vt && userId && hostTableReady) {
      const member = await prisma.venueTableMember.findFirst({
        where: {
          id: String(venueTableMemberId),
          venueTableId: String(venueTableId),
          userId: String(userId),
        },
      });
      const vu = await prisma.user.findUnique({
        where: { id: String(userId) },
        select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
      });
      const visFallback = vt.event?.date
        ? visibleUntilForVenueTableMember(vt, vt.event)
        : visibleUntilForDayVenueTable(vt, new Date(), {
            windowEndsAt:
              member?.windowEndTime && member?.windowStartTime && member?.bookingDate
                ? windowEndInstant(member.bookingDate, member.windowStartTime, member.windowEndTime)
                : null,
            windowStartTime: member?.windowStartTime,
            windowEndTime: member?.windowEndTime,
            bookingDate: member?.bookingDate,
          });
      const eventStartsAt = vt.event
        ? eventStartsAtFromEvent(vt.event)
        : dayEventStartsAtFromMember(member, vt);
      const eventEndsAt = vt.event ? eventEndsAtFromEvent(vt.event) : null;
      const bookingMode = metadata.booking_mode || metadata.bookingMode;
      const settlementMode = metadata.settlement_mode || metadata.settlementMode || member?.settlementMode;
      const isHostMode = isVenueTableHostPayment(metadata, member);
      const minSpendZar = isHostMode
        ? Number(vt.hostMinimumSpend ?? vt.minimumSpend ?? 0)
        : Number(vt.minimumSpend ?? 0);
      let menuResolved = null;
      const menuSel = metadata.selectedMenuItems || member?.selectedMenuItems;
      if (Array.isArray(menuSel) && menuSel.length && vt.venueId) {
        menuResolved = await resolveVenueMenuSelections(menuSel, vt.venueId);
      }
      const tableSpecsSummary = await buildVenueTableMemberTicketSummary(prisma, {
        member,
        table: vt,
        venue: vt.venue,
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
        title: venueTableTicketTitle(vt.tableName, vt.event?.title, isHostMode),
        subtitle: vt.venue?.name || null,
        visibleUntil: visFallback,
        venueTableId: vt.id,
        hostedTableId: vt.hostedTableId || null,
        eventId: vt.eventId || null,
        quantity: 1,
        holderDisplayName: holderDisplayNameFromUser(vu),
        tableSpecsSummary,
        eventStartsAt,
        eventEndsAt,
      });
      const { secAmount: sAmt, recipientAmount: vAmt } = splitSecPlatform(Number(amount || 0));
      const venueCode = await resolveRecipientCodeForVenue(vt.venueId);
      await recordPayoutAndMaybeTransfer({
        paymentReference: reference,
        grossZar: Number(amount || 0),
        secAmount: sAmt,
        recipientAmount: vAmt,
        recipientType: 'VENUE',
        recipientVenueId: vt.venueId,
        recipientUserId: null,
        paystackRecipientCode: venueCode,
      });
      if (vt.eventId) {
        await recordGuestEventVenueTableBookingIfNeeded({
          venueTableId: vt.id,
          userId: String(userId),
          paystackReference: reference,
          amountTotal: Number(amount || 0),
          selectedMenuItems: metadata.selectedMenuItems || member?.selectedMenuItems,
          bookingMode,
          memberRole: member?.memberRole,
          tableSessionNumber: vt.tableSessionNumber,
        });
        try {
          const { addUserToEventGroupChat } = await import('../lib/groupChatHelpers.js');
          await addUserToEventGroupChat(vt.eventId, String(userId), vt.event?.title || vt.tableName);
        } catch (_) {
          /* non-fatal */
        }
      }
    }
  }

  if (metadata.type === 'TABLE_HOST_FEE' && userId) {
    // LEGACY: no new TABLE_HOST_FEE checkouts — kept for historical Paystack webhooks only.
    const hostedTableId = metadata.hosted_table_id || metadata.hostedTableId;
    if (hostedTableId) {
      const hosted = await prisma.hostedTable.findFirst({
        where: { id: String(hostedTableId), hostUserId: String(userId) },
        include: { event: { include: { venue: { select: { id: true, ownerUserId: true, name: true } } } } },
      });
      if (hosted && hosted.status === 'DRAFT' && !hosted.hostFeePaystackRef) {
        const entranceZar = Number(metadata.entrance_zar || 0);
        const hostFeeZar = Number(metadata.host_fee_zar || 0);
        const menuZar = Number(metadata.menu_zar ?? metadata.min_spend_zar ?? metadata.minSpendZar ?? 0) || 0;
        const minSpendZar = Number(metadata.min_spend_zar ?? 0) || 0;
        const expected = entranceZar + hostFeeZar + menuZar;
        const selectedMenuItems = metadata.selected_menu_items || metadata.selectedMenuItems || null;
        const tierIncludedItems = metadata.tier_included_items || metadata.tierIncludedItems || null;
        if (expected > 0 && Math.abs(Number(amount || 0) - expected) < 0.01) {
          const includedTotal = Array.isArray(tierIncludedItems?.items)
            ? tierIncludedItems.items.reduce(
                (s, i) => s + Number(i.price || 0) * Number(i.quantity || 0),
                0
              )
            : 0;
          const menuSpendTotal = Number((menuZar + includedTotal).toFixed(2));
          await prisma.hostedTable.update({
            where: { id: hosted.id },
            data: {
              status: 'ACTIVE',
              hostFeePaystackRef: reference,
              menuSpendTotal,
              ...(tierIncludedItems ? { tierIncludedItems } : {}),
            },
          });
          await ensureHostedTableLiveAfterListingPayment(hosted.id);
          const hostMem = await prisma.hostedTableMember.findFirst({
            where: { hostedTableId: hosted.id, userId: String(userId) },
          });
          if (hostMem) {
            await prisma.hostedTableMember.update({
              where: { id: hostMem.id },
              data: {
                selectedMenuItems: selectedMenuItems || hostMem.selectedMenuItems,
                menuSpendPaid: menuZar,
              },
            });
          }
          logFriendActivity({
            userId: String(userId),
            activityType: 'HOSTED_TABLE',
            referenceId: hosted.id,
            referenceType: 'HOSTED_TABLE',
            description: 'hosted a table',
          });
          recordTableHistory({
            userId: String(userId),
            role: 'HOST',
            hostedTableId: hosted.id,
            eventId: hosted.eventId || null,
            tableName: hosted.tableName,
            eventTitle: hosted.event?.title || null,
          });
          const venueCode = hosted.event?.venueId ? await resolveRecipientCodeForVenue(hosted.event.venueId) : null;
          if (hostFeeZar > 0) {
            await recordSecPlatformRevenue(`${reference}:hostfee`, hostFeeZar);
          }
          const venueShareZar = entranceZar + menuZar;
          if (venueShareZar > 0 && hosted.event?.venueId) {
            const { secAmount: secVenue, recipientAmount: venueTotal } = splitSecPlatform(venueShareZar);
            await recordPayoutAndMaybeTransfer({
              paymentReference: `${reference}:venue_share`,
              grossZar: venueShareZar,
              secAmount: secVenue,
              recipientAmount: venueTotal,
              recipientType: 'VENUE',
              recipientVenueId: hosted.event.venueId,
              recipientUserId: null,
              paystackRecipientCode: venueCode,
            });
          }
          const vis = hosted.event ? visibleUntilAfterEventDate(hosted.event.date) : visibleUntilAfterHostedTable(hosted);
          const eventStartsAt = hosted.event
            ? eventStartsAtFromEvent(hosted.event)
            : eventStartsAtFromHostedTable(hosted);
          const eventEndsAt = hosted.event ? eventEndsAtFromEvent(hosted.event) : null;
          const payer = await prisma.user.findUnique({
            where: { id: String(userId) },
            select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
          });
          const settlementMode = metadata.settlement_mode || metadata.settlementMode || null;
          let menuItemsForHost = selectedMenuItems;
          if (hosted.event?.venueId && Array.isArray(selectedMenuItems) && selectedMenuItems.length) {
            const resolved = await resolveVenueMenuSelections(selectedMenuItems, hosted.event.venueId);
            menuItemsForHost = resolved.items;
          }
          const hostTicketSummary = buildHostedTableHostTicketSummary({
            hostedTable: hosted,
            menuItems: menuItemsForHost,
            minSpendPrepaidZar: minSpendZar,
            settlementMode,
          });
          const hostPromoterId = promoterUserIdFromMetadata(metadata);
          await issueTicketAndNotify(prisma, {
            userId: String(userId),
            email: payer?.email || email,
            paystackReference: reference,
            kind: 'TABLE_HOST_FEE',
            title: `${hosted.tableName} — SEC host ticket`,
            subtitle: hosted.venueName,
            visibleUntil: vis,
            hostedTableId: hosted.id,
            eventId: hosted.eventId || null,
            quantity: 1,
            holderDisplayName: holderDisplayNameFromUser(payer),
            tableSpecsSummary: hostTicketSummary,
            eventStartsAt,
            eventEndsAt,
            promoterUserId: hostPromoterId,
          });
          await notifyPaymentSuccess({
            userId: String(userId),
            email: payer?.email || email,
            title: 'Hosted table payment confirmed',
            body: `Your payment for "${hosted.tableName}" was successful. Open Host Dashboard to manage join requests and table rules.`,
            actionUrl: '/HostDashboard?tab=tables&manage=1',
            referenceId: hosted.id,
            referenceType: 'HOSTED_TABLE',
            emailSubject: `Table host payment — ${hosted.tableName}`,
          });
          if (hosted.event?.venueId && hosted.eventId) {
            const totalZar = Number(amount || entranceZar + hostFeeZar + menuZar);
            await recordEventVenueTableBooking({
              venueId: hosted.event.venueId,
              eventId: hosted.eventId,
              hostedTableId: hosted.id,
              userId: String(userId),
              role: 'HOST',
              paystackReference: reference,
              amountTotal: totalZar,
              entranceZar: entranceZar || 0,
              componentZar: (hostFeeZar || 0) + (menuZar || 0),
              selectedMenuItems: selectedMenuItems || undefined,
              hostingTierName: metadata.hosting_tier_name || tierIncludedItems?.tier_name || null,
              hostingCategory: metadata.hosting_category || hosted.hostingCategory || null,
              menuTotalZar: menuZar || null,
              promoterUserId: hostPromoterId,
            });
            await applyPromoterAttribution({
              metadata,
              eventId: hosted.eventId,
              buyerUserId: userId,
              conversionType: 'TABLE_HOST',
              amountZar: totalZar,
              reference,
            });
          }
          await refreshHostedTableTickets(prisma, hosted.id);
          if (hosted.event?.venue?.ownerUserId) {
            await createInAppNotification({
              userId: hosted.event.venue.ownerUserId,
              type: 'TABLE_JOINED',
              title: 'Hosted table live',
              body: `${hosted.tableName} — host payment completed for ${hosted.event?.title || 'your event'}.`,
              referenceId: hosted.eventId,
              referenceType: 'EVENT',
            });
          }
        }
      }
    } else {
      const dup = await prisma.table.findFirst({ where: { hostFeePaystackRef: reference, deletedAt: null } });
      if (!dup) {
        const raw = metadata.table_create || metadata.tableCreate;
        const parsed = tableCreateFromPaymentSchema.safeParse(raw);
        if (parsed.success) {
          const d = parsed.data;
          const category = d.table_category === 'vip' ? 'vip' : 'general';
          const event = await prisma.event.findFirst({
            where: { id: d.event_id, deletedAt: null },
            include: { venue: { select: { id: true, ownerUserId: true, name: true } } },
          });
          if (event && event.venueId === d.venue_id) {
            const hosting = normalizeHostingConfig(event.hostingConfig);
            const fee = hosting[category]?.host_table_fee_zar ?? null;
            const entranceZar = getEventEntranceZar(event);
            const expected = Number(fee || 0) + entranceZar;
            if (fee != null && fee > 0 && Math.abs(Number(amount) - expected) < 0.01) {
              const pref = normalizeGuestGenderPreference(d.guest_gender_preference);
              const created = await prisma.table.create({
                data: {
                  eventId: d.event_id,
                  venueId: d.venue_id,
                  hostUserId: String(userId),
                  name: d.name,
                  tableCategory: category,
                  maxGuests: d.max_guests,
                  minSpend: d.min_spend ?? null,
                  joiningFee: d.joining_fee ?? null,
                  isPublic: d.is_public !== undefined ? d.is_public : true,
                  guestGenderPreference: pref,
                  hostFeePaystackRef: reference,
                },
              });
              const venueCode = await resolveRecipientCodeForVenue(event.venueId);
              const hostCode = await resolveRecipientCodeForUser(String(userId));
              if (entranceZar > 0) {
                const { secAmount: sEnt, recipientAmount: rEnt } = splitSecPlatform(entranceZar);
                await recordPayoutAndMaybeTransfer({
                  paymentReference: `${reference}:entrance`,
                  grossZar: entranceZar,
                  secAmount: sEnt,
                  recipientAmount: rEnt,
                  recipientType: 'VENUE',
                  recipientVenueId: event.venueId,
                  recipientUserId: null,
                  paystackRecipientCode: venueCode,
                });
              }
              const { secAmount: sHost, recipientAmount: rHost } = splitSecPlatform(Number(fee || 0));
              await recordPayoutAndMaybeTransfer({
                paymentReference: `${reference}:hostfee`,
                grossZar: Number(fee || 0),
                secAmount: sHost,
                recipientAmount: rHost,
                recipientType: 'USER',
                recipientUserId: String(userId),
                recipientVenueId: null,
                paystackRecipientCode: hostCode,
              });
              const vis = visibleUntilAfterEventDate(event.date);
              const eventStartsAt = eventStartsAtFromEvent(event);
              const eventEndsAt = eventEndsAtFromEvent(event);
              const payer = await prisma.user.findUnique({
                where: { id: String(userId) },
                select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
              });
              await issueTicketAndNotify(prisma, {
                userId: String(userId),
                email: payer?.email || email,
                paystackReference: reference,
                kind: 'TABLE_HOST_FEE',
                title: `${created.name} — SEC host ticket`,
                subtitle: event.title,
                visibleUntil: vis,
                tableId: created.id,
                eventId: event.id,
                quantity: 1,
                holderDisplayName: holderDisplayNameFromUser(payer),
                tableSpecsSummary: formatSpecsFromTable(created),
                eventStartsAt,
                eventEndsAt,
              });
            }
          }
        }
      }
    }
  }

  if (metadata.type === 'HOSTED_TABLE_EXTERNAL_LISTING' && userId) {
    const htid = metadata.hosted_table_id || metadata.hostedTableId;
    if (htid) {
      const ht = await prisma.hostedTable.findFirst({ where: { id: String(htid), hostUserId: String(userId) } });
      if (ht && ht.tableType === 'EXTERNAL_VENUE' && ht.status === 'DRAFT') {
        const dbAmount = Number(priorPay?.amount) || 0;
        const amountOk =
          Math.abs(Number(amount) - EXTERNAL_HOSTED_LISTING_ZAR) < 0.01 ||
          Math.abs(dbAmount - EXTERNAL_HOSTED_LISTING_ZAR) < 0.01;
        if (amountOk) {
          await prisma.hostedTable.update({
            where: { id: ht.id },
            data: {
              status: 'ACTIVE',
              externalListingPaystackRef: reference,
            },
          });
          await ensureHostedTableLiveAfterListingPayment(ht.id);
          logFriendActivity({
            userId: String(userId),
            activityType: 'HOSTED_TABLE',
            referenceId: ht.id,
            referenceType: 'HOSTED_TABLE',
            description: 'hosted a table',
          });
          recordTableHistory({
            userId: String(userId),
            role: 'HOST',
            hostedTableId: ht.id,
            eventId: ht.eventId || null,
            tableName: ht.tableName,
            eventTitle: null,
          });
          const payer = await prisma.user.findUnique({
            where: { id: String(userId) },
            select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
          });
          const vis = visibleUntilAfterHostedTable(ht);
          const eventStartsAt = eventStartsAtFromHostedTable(ht);
          await issueTicketAndNotify(prisma, {
            userId: String(userId),
            email: payer?.email || email,
            paystackReference: reference,
            kind: 'EXTERNAL_HOSTED_LISTING',
            title: `External table listing — ${ht.tableName}`,
            subtitle: ht.venueName,
            visibleUntil: vis,
            hostedTableId: ht.id,
            quantity: 1,
            holderDisplayName: holderDisplayNameFromUser(payer),
            tableSpecsSummary: formatSpecsFromHostedTable(ht),
            eventStartsAt,
            eventEndsAt: vis,
          });
          await recordSecPlatformRevenue(
            reference,
            Number(amount || dbAmount || EXTERNAL_HOSTED_LISTING_ZAR),
          );
        } else {
          console.error('HOSTED_TABLE_EXTERNAL_LISTING amount mismatch', {
            reference,
            amount,
            dbAmount,
            expected: EXTERNAL_HOSTED_LISTING_ZAR,
          });
          metadata.side_effects_error = `Listing fee amount mismatch: charged ${amount}, db ${dbAmount}, expected ${EXTERNAL_HOSTED_LISTING_ZAR}`;
        }
      }
    }
  }

  if (metadata.type === 'HOUSE_PARTY_ENTRANCE' && userId) {
    const partyId = metadata.house_party_id || metadata.housePartyId;
    const attendeeId = metadata.attendee_id || metadata.attendeeId;
    if (partyId && attendeeId) {
      const att = await prisma.housePartyAttendee.findFirst({
        where: { id: String(attendeeId), housePartyId: String(partyId), userId: String(userId) },
        include: { houseParty: true },
      });
      if (att && att.paystackReference !== reference && att.houseParty.hasEntranceFee && att.houseParty.entranceFeeAmount) {
        if (Math.abs(Number(amount) - att.houseParty.entranceFeeAmount) < 0.01) {
          await prisma.$transaction(async (tx) => {
            const cur = await tx.housePartyAttendee.findUnique({ where: { id: att.id } });
            if (!cur || cur.paystackReference === reference) return;
            await tx.housePartyAttendee.update({
              where: { id: att.id },
              data: { status: 'GOING', paystackReference: reference },
            });
            if (cur.status !== 'GOING') {
              await tx.houseParty.update({
                where: { id: String(partyId) },
                data: { spotsRemaining: { decrement: 1 } },
              });
            }
          });
          const freshAtt = await prisma.housePartyAttendee.findUnique({
            where: { id: att.id },
            include: { houseParty: true },
          });
          if (freshAtt?.paystackReference === reference) {
            const { secAmount: sAmt, recipientAmount: rAmt } = splitSecPlatform(Number(amount || 0));
            const hostCode = await resolveRecipientCodeForUser(freshAtt.houseParty.hostUserId);
            await recordPayoutAndMaybeTransfer({
              paymentReference: reference,
              grossZar: Number(amount || 0),
              secAmount: sAmt,
              recipientAmount: rAmt,
              recipientType: 'USER',
              recipientUserId: freshAtt.houseParty.hostUserId,
              recipientVenueId: null,
              paystackRecipientCode: hostCode,
            });
            const payer = await prisma.user.findUnique({
              where: { id: String(userId) },
              select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
            });
            const vis = visibleUntilAfterParty(freshAtt.houseParty);
            const eventStartsAt = freshAtt.houseParty.startTime;
            const partySpecs = freshAtt.houseParty.location
              ? `Location: ${freshAtt.houseParty.location}`
              : null;
            await issueTicketAndNotify(prisma, {
              userId: String(userId),
              email: payer?.email || email,
              paystackReference: reference,
              kind: 'HOUSE_PARTY',
              title: freshAtt.houseParty.title,
              subtitle: 'House party ticket',
              visibleUntil: vis,
              housePartyId: freshAtt.houseParty.id,
              quantity: 1,
              holderDisplayName: holderDisplayNameFromUser(payer),
              tableSpecsSummary: partySpecs,
              eventStartsAt,
            });
            await createInAppNotification({
              userId: freshAtt.houseParty.hostUserId,
              type: 'EVENT_JOINED',
              title: 'Paid guest',
              body: `Someone purchased a ticket for your party "${freshAtt.houseParty.title}".`,
              referenceId: freshAtt.houseParty.id,
              referenceType: 'HOUSE_PARTY',
            });
          }
        }
      }
    }
  }

  if (metadata.type === 'HOSTED_TABLE_JOIN' && userId) {
    const htid = metadata.hosted_table_id || metadata.hostedTableId;
    const memberId = metadata.hosted_table_member_id || metadata.hostedTableMemberId;
    if (htid && memberId) {
      const member = await prisma.hostedTableMember.findFirst({
        where: { id: String(memberId), hostedTableId: String(htid), userId: String(userId) },
        include: { hostedTable: true },
      });
      const htEvent = member?.hostedTable?.eventId
        ? await prisma.event.findFirst({
            where: { id: member.hostedTable.eventId, deletedAt: null },
            select: {
              id: true,
              title: true,
              venueId: true,
              date: true,
              startTime: true,
              endsAt: true,
              hasEntranceFee: true,
              entranceFeeAmount: true,
              venue: { select: { ownerUserId: true, name: true } },
            },
          })
        : null;
      const entranceZar = Number(metadata.entrance_zar || getEventEntranceZar(htEvent));
      const joinZar = Number(metadata.join_zar ?? member?.hostedTable?.joiningFee ?? 0) || 0;
      const menuZar = Number(metadata.menu_zar || metadata.menu_total_zar || 0) || 0;
      const expected = entranceZar + joinZar + menuZar;
      const alreadyFulfilled =
        member?.status === 'GOING' && member.paystackReference === reference;
      const amountOk =
        expected > 0 &&
        (Math.abs(Number(amount) - expected) < 0.01 ||
          Math.abs(Number(priorPay?.amount || 0) - expected) < 0.01);
      const existingJoinTicket = alreadyFulfilled
        ? await prisma.ticket.findUnique({ where: { paystackReference: reference } })
        : null;
      if (member && alreadyFulfilled && !existingJoinTicket && amountOk) {
        // Hotfix: member marked GOING after pay, but ticket issuance never ran.
        const htFinal = member.hostedTable;
        const payer = await prisma.user.findUnique({
          where: { id: String(userId) },
          select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
        });
        const hostUser = await prisma.user.findUnique({
          where: { id: htFinal.hostUserId },
          select: { fullName: true, username: true, userProfile: { select: { username: true } } },
        });
        const linkedVenueTable = await prisma.venueTable.findFirst({
          where: { hostedTableId: htFinal.id },
          select: {
            id: true,
            venueId: true,
            serviceDate: true,
            serviceEndDate: true,
            startTime: true,
            endTime: true,
          },
        });
        const vis = linkedVenueTable && !htEvent
          ? visibleUntilForDayVenueTable(linkedVenueTable, new Date(), {
              windowEndsAt: htFinal.windowEndsAt,
            })
          : visibleUntilAfterHostedTable(htFinal);
        const eventStartsAt =
          (htEvent && eventStartsAtFromEvent(htEvent)) ||
          (linkedVenueTable && dayStartsAtFromVenueTable(linkedVenueTable)) ||
          eventStartsAtFromHostedTable(htFinal);
        const eventEndsAt = htEvent
          ? eventEndsAtFromEvent(htEvent)
          : linkedVenueTable
            ? dayEndsAtFromVenueTable(linkedVenueTable)
            : null;
        const joinMenuItems = Array.isArray(metadata.selected_menu_items)
          ? metadata.selected_menu_items
          : Array.isArray(metadata.selectedMenuItems)
            ? metadata.selectedMenuItems
            : [];
        const joinSummary = buildHostedTableJoinTicketSummary({
          hostedTable: htFinal,
          hostUser,
          entranceZar,
          joinZar,
          menuItems: joinMenuItems,
        });
        await issueTicketAndNotify(prisma, {
          userId: String(userId),
          email: payer?.email || email,
          paystackReference: reference,
          kind: 'HOSTED_TABLE_JOIN',
          title: `${htFinal.tableName} — Join ticket`,
          subtitle: htFinal.venueName,
          visibleUntil: vis,
          hostedTableId: htFinal.id,
          eventId: htEvent?.id || null,
          quantity: 1,
          holderDisplayName: holderDisplayNameFromUser(payer),
          tableSpecsSummary: joinSummary,
          eventStartsAt,
          eventEndsAt,
          promoterUserId: promoterUserIdFromMetadata(metadata),
        });
      } else if (member && !alreadyFulfilled && amountOk) {
          await prisma.$transaction(async (tx) => {
            const htRow = await tx.hostedTable.findUnique({ where: { id: String(htid) } });
            const mem = await tx.hostedTableMember.findUnique({ where: { id: member.id } });
            if (!htRow || !mem || htRow.spotsRemaining <= 0) return;
            if (mem.status === 'GOING' && mem.paystackReference === reference) return;
            await tx.hostedTableMember.update({
              where: { id: member.id },
              data: {
                status: 'GOING',
                paystackReference: reference,
                joinFeePaid: joinZar,
                hostReviewedAt: new Date(),
                ...(Array.isArray(metadata.selected_menu_items) && metadata.selected_menu_items.length
                  ? { selectedMenuItems: metadata.selected_menu_items }
                  : {}),
              },
            });
            const nextSpots = htRow.spotsRemaining - 1;
            await tx.hostedTable.update({
              where: { id: htRow.id },
              data: {
                spotsRemaining: { decrement: 1 },
                ...(nextSpots <= 0 ? { status: 'FULL' } : {}),
              },
            });
            await reconcileTableInvitesOnJoin(tx, htRow.id, String(userId));
          });
          const memFresh = await prisma.hostedTableMember.findUnique({
            where: { id: String(memberId) },
            include: { hostedTable: true },
          });
          if (memFresh?.paystackReference === reference) {
            const htFinal = memFresh.hostedTable;
            const linkedVenueTable = await prisma.venueTable.findFirst({
              where: { hostedTableId: htFinal.id },
              select: {
                id: true,
                venueId: true,
                serviceDate: true,
                serviceEndDate: true,
                startTime: true,
                endTime: true,
              },
            });
            const htVenueId =
              htEvent?.venueId ||
              metadata.venue_id ||
              metadata.venueId ||
              linkedVenueTable?.venueId ||
              null;
            if (entranceZar > 0 && htVenueId) {
              const venueCode = await resolveRecipientCodeForVenue(htVenueId);
              const { secAmount: sEnt, recipientAmount: rEnt } = splitSecPlatform(entranceZar);
              await recordPayoutAndMaybeTransfer({
                paymentReference: `${reference}:entrance`,
                grossZar: entranceZar,
                secAmount: sEnt,
                recipientAmount: rEnt,
                recipientType: 'VENUE',
                recipientUserId: null,
                recipientVenueId: htVenueId,
                paystackRecipientCode: venueCode,
              });
            }
            if (joinZar > 0) {
              const hostCode = await resolveRecipientCodeForUser(htFinal.hostUserId);
              const { secAmount: sAmt, recipientAmount: rAmt } = splitSecPlatform(joinZar);
              await recordPayoutAndMaybeTransfer({
                paymentReference: `${reference}:join`,
                grossZar: joinZar,
                secAmount: sAmt,
                recipientAmount: rAmt,
                recipientType: 'USER',
                recipientUserId: htFinal.hostUserId,
                recipientVenueId: null,
                paystackRecipientCode: hostCode,
              });
            }
            if (menuZar > 0 && htVenueId) {
              const venueMenuCode = await resolveRecipientCodeForVenue(htVenueId);
              const { secAmount: sMenu, recipientAmount: rMenu } = splitSecPlatform(menuZar);
              await recordPayoutAndMaybeTransfer({
                paymentReference: `${reference}:menu`,
                grossZar: menuZar,
                secAmount: sMenu,
                recipientAmount: rMenu,
                recipientType: 'VENUE',
                recipientUserId: null,
                recipientVenueId: htVenueId,
                paystackRecipientCode: venueMenuCode,
              });
              await prisma.hostedTableMember.update({
                where: { id: String(memberId) },
                data: { menuSpendPaid: { increment: menuZar } },
              });
              await prisma.hostedTable.update({
                where: { id: htFinal.id },
                data: { menuSpendTotal: { increment: menuZar } },
              });
            }
            const payer = await prisma.user.findUnique({
              where: { id: String(userId) },
              select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
            });
            const hostUser = await prisma.user.findUnique({
              where: { id: htFinal.hostUserId },
              select: { fullName: true, username: true, userProfile: { select: { username: true } } },
            });
            const vis = linkedVenueTable && !htEvent
              ? visibleUntilForDayVenueTable(linkedVenueTable, new Date(), {
                  windowEndsAt: htFinal.windowEndsAt,
                })
              : visibleUntilAfterHostedTable(htFinal);
            const eventStartsAt =
              (htEvent && eventStartsAtFromEvent(htEvent)) ||
              (linkedVenueTable && dayStartsAtFromVenueTable(linkedVenueTable)) ||
              eventStartsAtFromHostedTable(htFinal);
            const eventEndsAt = htEvent
              ? eventEndsAtFromEvent(htEvent)
              : linkedVenueTable
                ? dayEndsAtFromVenueTable(linkedVenueTable)
                : null;
            const joinMenuItems = Array.isArray(metadata.selected_menu_items)
              ? metadata.selected_menu_items
              : Array.isArray(metadata.selectedMenuItems)
                ? metadata.selectedMenuItems
                : [];
            const joinSummary = buildHostedTableJoinTicketSummary({
              hostedTable: htFinal,
              hostUser,
              entranceZar,
              joinZar,
              menuItems: joinMenuItems,
            });
            const joinPromoterId = promoterUserIdFromMetadata(metadata);
            await issueTicketAndNotify(prisma, {
              userId: String(userId),
              email: payer?.email || email,
              paystackReference: reference,
              kind: 'HOSTED_TABLE_JOIN',
              title: `${htFinal.tableName} — Join ticket`,
              subtitle: htFinal.venueName,
              visibleUntil: vis,
              hostedTableId: htFinal.id,
              eventId: htEvent?.id || null,
              quantity: 1,
              holderDisplayName: holderDisplayNameFromUser(payer),
              tableSpecsSummary: joinSummary,
              eventStartsAt,
              eventEndsAt,
              promoterUserId: joinPromoterId,
            });
            if (htEvent?.venueId && htEvent?.id) {
              await recordEventVenueTableBooking({
                venueId: htEvent.venueId,
                eventId: htEvent.id,
                hostedTableId: htFinal.id,
                userId: String(userId),
                role: 'GUEST',
                paystackReference: reference,
                amountTotal: Number(amount || 0),
                entranceZar,
                componentZar: joinZar,
                promoterUserId: joinPromoterId,
              });
              await applyPromoterAttribution({
                metadata,
                eventId: htEvent.id,
                buyerUserId: userId,
                conversionType: 'TABLE_JOIN',
                amountZar: amount,
                reference,
              });
            }
            const payerName = payer?.fullName || payer?.username || 'A guest';
            await addUserToHostedTableGroupChat(htFinal.id, String(userId));
            if (htEvent?.id) {
              try {
                const { addUserToEventGroupChat } = await import('../lib/groupChatHelpers.js');
                await addUserToEventGroupChat(htEvent.id, String(userId), htEvent.title || htFinal.tableName);
              } catch (_) {
                /* non-fatal */
              }
            }
            if (htEvent?.venue?.ownerUserId) {
              await createInAppNotification({
                userId: htEvent.venue.ownerUserId,
                type: 'TABLE_JOINED',
                title: 'Hosted table guest paid',
                body: `${payerName} joined "${htFinal.tableName}" after successful payment.`,
                referenceId: htEvent.id,
                referenceType: 'EVENT',
              });
            }
            if (htFinal.hostUserId && String(htFinal.hostUserId) !== String(userId)) {
              await createInAppNotification({
                userId: htFinal.hostUserId,
                type: 'TABLE_JOINED',
                title: 'Guest joined your table',
                body: `${payerName} completed payment and is going to "${htFinal.tableName}".`,
                referenceId: htFinal.id,
                referenceType: 'HOSTED_TABLE',
              });
            }
            recordTableHistory({
              userId: String(userId),
              role: 'JOINED',
              hostedTableId: htFinal.id,
              eventId: htEvent?.id || htFinal.eventId || null,
              tableName: htFinal.tableName,
              eventTitle: htEvent?.title || null,
            });
          } else {
            metadata.side_effects_error = 'Hosted table join payment received but no spots remaining';
            console.error('HOSTED_TABLE_JOIN no spots remaining', { reference, htid, memberId });
          }
      } else if (member && expected > 0 && !amountOk) {
        metadata.side_effects_error = `Join amount mismatch: charged ${amount}, db ${priorPay?.amount}, expected ${expected}`;
        console.error('HOSTED_TABLE_JOIN amount mismatch', {
          reference,
          amount,
          dbAmount: priorPay?.amount,
          expected,
        });
      }
    }
  }

  const tableId = metadata.table_id;
  if (tableId && userId && metadata.type !== 'TABLE_HOST_FEE') {
    const table = await prisma.table.findFirst({
      where: { id: tableId, deletedAt: null },
      include: { venue: { select: { ownerUserId: true, name: true } } },
    });
    if (table) {
      const members = Array.isArray(table.members) ? [...table.members] : [];
      const memberIdx = members.findIndex((m) => m?.user_id === userId);
      const contribution = amount || (memberIdx >= 0 ? members[memberIdx]?.contribution : 0) || table.joiningFee || 0;
      if (memberIdx >= 0) {
        members[memberIdx] = { ...members[memberIdx], status: 'confirmed', contribution };
      } else {
        members.push({ user_id: userId, status: 'confirmed', contribution, joined_at: new Date().toISOString() });
      }
      const pendingRequests = Array.isArray(table.pendingRequests) ? table.pendingRequests.filter((id) => id !== userId) : [];
      const updated = await prisma.table.update({
        where: { id: tableId },
        data: {
          members,
          pendingRequests,
          currentGuests: members.length,
        },
      });

      const payer = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
      const payerName = payer?.fullName || 'Someone';

      await createNotifications({
        userIds: [table.hostUserId, table.venue?.ownerUserId],
        type: 'payment',
        title: 'Table payment confirmed',
        body: `${payerName} completed payment to join "${table.name}".`,
        actionUrl: `/ManageTable?id=${tableId}`,
      });

      await createNotification({
        userId,
        type: 'payment',
        title: 'Payment confirmed',
        body: `Your payment for "${table.name}" was confirmed.`,
        actionUrl: `/TableDetails?id=${tableId}`,
      });

      logFriendActivity({
        userId,
        activityType: 'JOINED_TABLE',
        referenceId: tableId,
        referenceType: 'TABLE',
        description: 'joined a table',
      });
      const joinEv = table.eventId
        ? await prisma.event.findFirst({ where: { id: table.eventId }, select: { title: true } })
        : null;
      recordTableHistory({
        userId,
        role: 'JOINED',
        tableId,
        eventId: table.eventId,
        tableName: table.name,
        eventTitle: joinEv?.title || null,
      });
      await upsertConfirmedAttendance(userId, table.eventId);

      if (updated.status === 'full') {
        await createNotifications({
          userIds: [table.hostUserId, table.venue?.ownerUserId],
          type: 'table_full',
          title: 'Table is fully booked',
          body: `"${table.name}" has reached max capacity.`,
          actionUrl: `/ManageTable?id=${tableId}`,
        });
      }

      const { secAmount: tSec, recipientAmount: tRec } = splitSecPlatform(Number(amount || 0));
      const hostPayCode = await resolveRecipientCodeForUser(table.hostUserId);
      await recordPayoutAndMaybeTransfer({
        paymentReference: reference,
        grossZar: Number(amount || 0),
        secAmount: tSec,
        recipientAmount: tRec,
        recipientType: 'USER',
        recipientUserId: table.hostUserId,
        recipientVenueId: null,
        paystackRecipientCode: hostPayCode,
      });
      const evRow = await prisma.event.findFirst({ where: { id: table.eventId, deletedAt: null } });
      const visT = evRow ? eventEndsAtFromEvent(evRow) || visibleUntilAfterEventDate(evRow.date) : new Date(Date.now() + 48 * 60 * 60 * 1000);
      const eventStartsAt = evRow ? eventStartsAtFromEvent(evRow) : null;
      const eventEndsAt = evRow ? eventEndsAtFromEvent(evRow) : null;
      const payerU = await prisma.user.findUnique({
        where: { id: String(userId) },
        select: { email: true, fullName: true, username: true, userProfile: { select: { username: true } } },
      });
      await issueTicketAndNotify(prisma, {
        userId: String(userId),
        email: payerU?.email || email,
        paystackReference: reference,
        kind: 'TABLE_JOIN',
        title: evRow?.title ? `${table.name} — ${evRow.title}` : table.name,
        subtitle: 'Table ticket',
        visibleUntil: visT,
        tableId,
        eventId: table.eventId,
        quantity: 1,
        holderDisplayName: holderDisplayNameFromUser(payerU),
        tableSpecsSummary: formatSpecsFromTable(table),
        eventStartsAt,
        eventEndsAt,
      });
    }
  }

  if (
    userId &&
    (type === 'ticket' || type === 'event') &&
    (metadata.ticket_tier_name || metadata.ticketTierName)
  ) {
    await issueEventTicketsFromPayment(prisma, {
      reference,
      userId,
      email,
      amount,
      metadata,
    });
  }

  if (userId && (metadata.type === 'EVENT_ENTRANCE' || type === 'EVENT_ENTRANCE')) {
    await issueEventEntranceFromPayment(prisma, {
      reference,
      userId,
      email,
      amount,
      metadata,
    });
  }

  const payType = PAYMENT_TYPES.includes(type) ? type : 'other';
  const refreshedPay = await prisma.payment.findUnique({
    where: { reference },
    select: { metadata: true },
  });
  const rawFinalMeta =
    refreshedPay?.metadata && typeof refreshedPay.metadata === 'object' ? refreshedPay.metadata : metadata;
  const { side_effects_processing: _sp, side_effects_processing_at: _spa, ...finalMetaBase } = rawFinalMeta;
  const fulfillmentComplete = await isPaymentFulfillmentComplete(reference, {
    ...finalMetaBase,
    type: finalMetaBase.type || type,
  });
  const finalMeta = {
    ...finalMetaBase,
    side_effects_applied: fulfillmentComplete,
    side_effects_processing: false,
  };
  const pmUp = await prisma.payment.updateMany({
    where: { reference },
    data: {
      status: 'success',
      amount: chargedAmount,
      type: payType,
      metadata: finalMeta,
    },
  });
  if (pmUp.count === 0) {
    await prisma.payment.create({
      data: {
        userId: userId || priorPay.userId || 'unknown',
        email,
        amount: chargedAmount,
        reference,
        status: 'success',
        type: payType,
        metadata: finalMeta,
      },
    });
  }
  } catch (sideEffectErr) {
    console.error('applyReferenceSideEffects failed:', sideEffectErr?.message);
    await prisma.payment.updateMany({
      where: { reference },
      data: {
        status: 'success',
        metadata: {
          ...metadata,
          side_effects_applied: false,
          side_effects_processing: false,
          side_effects_error: String(sideEffectErr?.message || sideEffectErr).slice(0, 500),
        },
      },
    });
  }
}

async function ensureHostedTableJoinFulfillmentForPayment(reference, paystackData = null) {
  const pay = await prisma.payment.findUnique({
    where: { reference },
    select: { userId: true, amount: true, metadata: true, status: true },
  });
  if (!pay) return { repaired: false, reason: 'payment_not_found' };

  const paid = pay.status === 'success' || paystackData?.status === 'success';
  if (!paid) return { repaired: false, reason: 'not_paid' };

  const metadata = flattenPaymentMetadata(pay.metadata);
  if (metadata.type !== 'HOSTED_TABLE_JOIN') return { repaired: false, reason: 'wrong_type' };

  const memberId = metadata.hosted_table_member_id || metadata.hostedTableMemberId;
  if (!memberId) return { repaired: false, reason: 'missing_member' };

  const member = await prisma.hostedTableMember.findUnique({ where: { id: String(memberId) } });
  if (!member) return { repaired: false, reason: 'member_not_found' };

  const ticket = await prisma.ticket.findUnique({ where: { paystackReference: reference } });
  if (member.status === 'GOING' && ticket) return { repaired: false, reason: 'already_fulfilled' };

  const needsRepair =
    (member.status === 'PENDING' && member.hostReviewedAt) ||
    (member.status === 'GOING' && !ticket);
  if (!needsRepair) return { repaired: false, reason: 'no_repair_needed' };

  const priorMeta = flattenPaymentMetadata(pay.metadata);
  await prisma.payment.updateMany({
    where: { reference },
    data: {
      metadata: {
        ...priorMeta,
        side_effects_applied: false,
        side_effects_processing: false,
      },
    },
  });

  const amountKobo = paystackData?.amount ?? Math.round(Number(pay.amount || 0) * 100);
  await applyReferenceSideEffects(reference, {
    status: 'success',
    amount: amountKobo,
    metadata: pay.metadata,
  });

  return { repaired: true };
}

const externalListingRepairInFlight = new Set();

/** Re-apply side effects when R200 external listing payment succeeded but table stayed DRAFT. */
async function ensureExternalListingFulfillmentForPayment(reference, paystackData = null) {
  if (externalListingRepairInFlight.has(reference)) {
    return { repaired: false, reason: 'reentrant' };
  }
  externalListingRepairInFlight.add(reference);
  try {
    const pay = await prisma.payment.findUnique({
      where: { reference },
      select: { userId: true, amount: true, metadata: true, status: true },
    });
    if (!pay) return { repaired: false, reason: 'payment_not_found' };

    const paid = pay.status === 'success' || paystackData?.status === 'success';
    if (!paid) return { repaired: false, reason: 'not_paid' };

    const metadata = flattenPaymentMetadata(pay.metadata);
    if (metadata.type !== 'HOSTED_TABLE_EXTERNAL_LISTING') return { repaired: false, reason: 'wrong_type' };

    const htid = metadata.hosted_table_id || metadata.hostedTableId;
    if (!htid) return { repaired: false, reason: 'missing_hosted_table' };

    const ht = await prisma.hostedTable.findFirst({
      where: { id: String(htid), hostUserId: String(pay.userId || metadata.user_id || '') },
      select: { id: true, status: true, externalListingPaystackRef: true, tableType: true },
    });
    if (!ht) return { repaired: false, reason: 'table_not_found' };
    if (ht.tableType !== 'EXTERNAL_VENUE') return { repaired: false, reason: 'wrong_table_type' };

    const ticket = await prisma.ticket.findUnique({ where: { paystackReference: reference } });
    if (ht.status === 'ACTIVE' && ht.externalListingPaystackRef === reference && ticket) {
      return { repaired: false, reason: 'already_fulfilled' };
    }

    const needsRepair =
      ht.status === 'DRAFT' ||
      ht.externalListingPaystackRef !== reference ||
      !ticket;
    if (!needsRepair) return { repaired: false, reason: 'no_repair_needed' };

    const priorMeta = flattenPaymentMetadata(pay.metadata);
    await prisma.payment.updateMany({
      where: { reference },
      data: {
        metadata: {
          ...priorMeta,
          side_effects_applied: false,
          side_effects_processing: false,
        },
      },
    });

    const amountKobo =
      paystackData?.amount != null && Number(paystackData.amount) > 0
        ? Number(paystackData.amount)
        : Math.round(Number(pay.amount || EXTERNAL_HOSTED_LISTING_ZAR) * 100);
    await applyReferenceSideEffects(reference, {
      status: 'success',
      amount: amountKobo,
      metadata: {
        ...priorMeta,
        type: 'HOSTED_TABLE_EXTERNAL_LISTING',
        hosted_table_id: String(htid),
        user_id: String(pay.userId || priorMeta.user_id || ''),
      },
    });

    const fresh = await prisma.hostedTable.findUnique({
      where: { id: ht.id },
      select: { status: true, externalListingPaystackRef: true },
    });
    const freshTicket = await prisma.ticket.findUnique({ where: { paystackReference: reference } });
    return {
      repaired: fresh?.status === 'ACTIVE' && fresh?.externalListingPaystackRef === reference,
      reason:
        fresh?.status === 'ACTIVE' && fresh?.externalListingPaystackRef === reference
          ? freshTicket
            ? 'ok'
            : 'activated_without_ticket'
          : 'still_not_active',
    };
  } finally {
    externalListingRepairInFlight.delete(reference);
  }
}

const incompletePaymentReplayInFlight = new Set();

/**
 * Generic self-heal: if Paystack succeeded but domain fulfillment is incomplete,
 * clear the claim flags and re-run applyReferenceSideEffects for ANY payment type.
 */
async function ensureIncompletePaymentReplay(reference, paystackData = null) {
  if (incompletePaymentReplayInFlight.has(reference)) {
    return { repaired: false, reason: 'reentrant' };
  }
  incompletePaymentReplayInFlight.add(reference);
  try {
    const pay = await prisma.payment.findUnique({
      where: { reference },
      select: { status: true, amount: true, metadata: true, email: true },
    });
    if (!pay) return { repaired: false, reason: 'payment_not_found' };

    const paid = pay.status === 'success' || paystackData?.status === 'success';
    if (!paid) return { repaired: false, reason: 'not_paid' };

    const meta = flattenPaymentMetadata(pay.metadata);
    if (await isPaymentFulfillmentComplete(reference, meta)) {
      return { repaired: false, reason: 'already_complete' };
    }

    await prisma.payment.updateMany({
      where: { reference },
      data: {
        metadata: {
          ...meta,
          side_effects_applied: false,
          side_effects_processing: false,
        },
      },
    });

    const amountKobo =
      paystackData?.amount != null && Number(paystackData.amount) > 0
        ? Number(paystackData.amount)
        : Math.round(Number(pay.amount || 0) * 100);

    await applyReferenceSideEffects(reference, {
      status: 'success',
      amount: amountKobo,
      customer: { email: pay.email || paystackData?.customer?.email },
      metadata: meta,
    });

    const refreshed = await prisma.payment.findUnique({
      where: { reference },
      select: { metadata: true },
    });
    const complete = await isPaymentFulfillmentComplete(
      reference,
      flattenPaymentMetadata(refreshed?.metadata),
    );
    return { repaired: complete, reason: complete ? 'ok' : 'still_incomplete' };
  } finally {
    incompletePaymentReplayInFlight.delete(reference);
  }
}

async function resolvePaymentRepairType(reference, paystackData) {
  const fromStack =
    paystackData?.metadata && typeof paystackData.metadata === 'object'
      ? flattenPaymentMetadata(paystackData.metadata)
      : null;
  if (fromStack?.type) return String(fromStack.type);
  const pay = await prisma.payment.findUnique({
    where: { reference },
    select: { metadata: true, type: true },
  });
  const meta = flattenPaymentMetadata(pay?.metadata);
  return String(meta?.type || pay?.type || '');
}

async function runPaymentRepairPaths(reference, paystackData, { replayIncomplete = true } = {}) {
  const type = await resolvePaymentRepairType(reference, paystackData).catch(() => '');
  const isTicket = type === 'ticket' || type === 'event' || type === 'EVENT_ENTRANCE';
  const isVenueTable = type === 'TABLE_CHECKOUT' || type === 'VENUE_TABLE_JOIN';
  const isHostedJoin = type === 'TABLE_HOST_FEE' || type === 'HOSTED_TABLE_JOIN';
  const isExternal = type === 'HOSTED_TABLE_EXTERNAL_LISTING';
  const runAll = !isTicket && !isVenueTable && !isHostedJoin && !isExternal;

  if (runAll || isTicket) {
    await ensureEventTicketsForPayment(reference, paystackData).catch((e) => {
      console.warn('ensureEventTicketsForPayment repair failed', e?.message);
    });
  }
  if (runAll || isVenueTable) {
    await ensureVenueTableFulfillmentForPayment(reference, paystackData).catch((e) => {
      console.warn('ensureVenueTableFulfillmentForPayment repair failed', e?.message);
    });
  }
  if (runAll || isHostedJoin) {
    await ensureHostedTableJoinFulfillmentForPayment(reference, paystackData).catch((e) => {
      console.warn('ensureHostedTableJoinFulfillmentForPayment repair failed', e?.message);
    });
  }
  if (runAll || isExternal) {
    await ensureExternalListingFulfillmentForPayment(reference, paystackData).catch((e) => {
      console.warn('ensureExternalListingFulfillmentForPayment repair failed', e?.message);
    });
  }
  if (replayIncomplete) {
    await ensureIncompletePaymentReplay(reference, paystackData).catch((e) => {
      console.warn('ensureIncompletePaymentReplay repair failed', e?.message);
    });
  }
  await finalizePaymentIfFulfilled(reference, paystackData);
}

async function isPaymentFulfillmentComplete(reference, paidMeta) {
  if (paidMeta.side_effects_applied) return true;

  const type = paidMeta.type || '';
  const secKind = String(paidMeta.sec_kind || paidMeta.secKind || '').toUpperCase();

  if (
    (type === 'ticket' || type === 'event') &&
    (paidMeta.ticket_tier_name || paidMeta.ticketTierName)
  ) {
    const qty = Math.max(1, parseInt(String(paidMeta.quantity || '1'), 10) || 1);
    const refs =
      qty <= 1
        ? [reference]
        : Array.from({ length: qty }, (_, i) => `${reference}-${i + 1}`);
    const count = await prisma.ticket.count({ where: { paystackReference: { in: refs } } });
    if (count < qty) return false;
    // Tickets alone are not enough — venue share ledger must exist (or platform skip).
    const ledger = await prisma.payoutLedger.findUnique({
      where: { paymentReference: reference },
      select: { id: true },
    });
    return Boolean(ledger);
  }

  if (type === 'TABLE_CHECKOUT' || type === 'VENUE_TABLE_JOIN') {
    const memberId = paidMeta.venueTableMemberId || paidMeta.venue_table_member_id;
    if (!memberId) return false;
    const member = await prisma.venueTableMember.findUnique({ where: { id: String(memberId) } });
    if (member?.status !== 'CONFIRMED') return false;
    const isHost = isVenueTableHostPayment(paidMeta, member);
    if (isHost) {
      const vt = await prisma.venueTable.findUnique({
        where: { id: member.venueTableId },
        select: { hostedTableId: true },
      });
      if (!vt?.hostedTableId) return false;
    }
    const ticket = await prisma.ticket.findUnique({ where: { paystackReference: reference } });
    return Boolean(ticket);
  }

  if (type === 'TABLE_HOST_FEE' || type === 'HOSTED_TABLE_JOIN') {
    if (type === 'HOSTED_TABLE_JOIN') {
      const memberId = paidMeta.hosted_table_member_id || paidMeta.hostedTableMemberId;
      if (memberId) {
        const member = await prisma.hostedTableMember.findUnique({ where: { id: String(memberId) } });
        if (member?.status !== 'GOING') return false;
      }
    } else if (type === 'TABLE_HOST_FEE') {
      const htid = paidMeta.hosted_table_id || paidMeta.hostedTableId;
      if (htid) {
        const ht = await prisma.hostedTable.findUnique({
          where: { id: String(htid) },
          select: { status: true, hostFeePaystackRef: true },
        });
        if (ht?.status === 'DRAFT' || ht?.hostFeePaystackRef !== reference) return false;
      }
    }
    const ticket = await prisma.ticket.findUnique({ where: { paystackReference: reference } });
    return Boolean(ticket);
  }

  if (type === 'EVENT_ENTRANCE') {
    const ticket = await prisma.ticket.findUnique({ where: { paystackReference: reference } });
    return Boolean(ticket);
  }

  if (type === 'HOSTED_TABLE_EXTERNAL_LISTING') {
    const htid = paidMeta.hosted_table_id || paidMeta.hostedTableId;
    if (!htid) return false;
    const ht = await prisma.hostedTable.findFirst({
      where: { id: String(htid) },
      select: { status: true, externalListingPaystackRef: true },
    });
    if (ht?.status !== 'ACTIVE' || ht.externalListingPaystackRef !== reference) return false;
    const ticket = await prisma.ticket.findUnique({ where: { paystackReference: reference } });
    return Boolean(ticket);
  }

  if (type === 'HOSTED_TABLE_MENU') {
    const ledger = await prisma.payoutLedger.findFirst({ where: { paymentReference: reference } });
    if (ledger) return true;
    const ticket = await prisma.ticket.findUnique({ where: { paystackReference: reference } });
    return Boolean(ticket);
  }

  if (type === 'HOUSE_PARTY_PUBLISH') {
    const partyId = paidMeta.house_party_id || paidMeta.housePartyId;
    if (!partyId) return false;
    const party = await prisma.houseParty.findUnique({
      where: { id: String(partyId) },
      select: { status: true, publishPaystackRef: true },
    });
    return Boolean(
      party &&
        ['PUBLISHED', 'COMPLETED'].includes(party.status) &&
        party.publishPaystackRef === reference,
    );
  }

  if (type === 'HOUSE_PARTY_BOOST') {
    const partyId = paidMeta.house_party_id || paidMeta.housePartyId;
    if (!partyId) return false;
    const party = await prisma.houseParty.findUnique({
      where: { id: String(partyId) },
      select: { boostPaystackRef: true },
    });
    return party?.boostPaystackRef === reference;
  }

  if (type === 'HOUSE_PARTY_ENTRANCE') {
    const attendeeId = paidMeta.attendee_id || paidMeta.attendeeId;
    if (attendeeId) {
      const att = await prisma.housePartyAttendee.findUnique({
        where: { id: String(attendeeId) },
        select: { status: true, paystackReference: true },
      });
      if (att?.status !== 'GOING' || att.paystackReference !== reference) return false;
    }
    const ticket = await prisma.ticket.findUnique({ where: { paystackReference: reference } });
    return Boolean(ticket);
  }

  if (type === 'TABLE_BOOST') {
    const htid = paidMeta.hosted_table_id || paidMeta.hostedTableId;
    if (!htid) return false;
    const ht = await prisma.hostedTable.findUnique({
      where: { id: String(htid) },
      select: { boostPaystackRef: true },
    });
    return ht?.boostPaystackRef === reference;
  }

  if (type === 'EVENT_BOOST') {
    const eventId = paidMeta.event_id || paidMeta.eventId;
    if (!eventId) return false;
    const evt = await prisma.event.findUnique({
      where: { id: String(eventId) },
      select: { boostPaystackRef: true },
    });
    return evt?.boostPaystackRef === reference;
  }

  if (type === 'VENUE_TABLE_BOOST') {
    const vtid = paidMeta.venue_table_id || paidMeta.venueTableId;
    if (!vtid) return false;
    const vt = await prisma.venueTable.findUnique({
      where: { id: String(vtid) },
      select: { boostPaystackRef: true },
    });
    return vt?.boostPaystackRef === reference;
  }

  const promoId = resolvePromotionIdFromMetadata(paidMeta);
  if (promoId && (type === 'BOOST' || secKind === 'BOOST')) {
    const promo = await prisma.promotion.findFirst({
      where: { id: String(promoId), deletedAt: null },
      select: { boostPaystackRef: true },
    });
    return promo?.boostPaystackRef === reference;
  }

  if (promoId && (isPromotionPublishPayment(paidMeta) || secKind === 'PROMOTION_PUBLISH')) {
    const promo = await prisma.promotion.findFirst({
      where: { id: String(promoId), deletedAt: null },
      select: { status: true },
    });
    return promo?.status === 'ACTIVE';
  }

  if (paidMeta.table_id && type !== 'TABLE_HOST_FEE') {
    const ticket = await prisma.ticket.findUnique({ where: { paystackReference: reference } });
    return Boolean(ticket);
  }

  return Boolean(paidMeta.side_effects_applied);
}

/** Re-run fulfillment for one Paystack reference (ops / cron / authenticated retry). */
export async function repairPaymentFulfillmentByReference(reference, paystackData = null) {
  const ref = String(reference || '').trim();
  if (!ref) return { repaired: false, reason: 'missing_reference' };

  const pay = await prisma.payment.findUnique({
    where: { reference: ref },
    select: { status: true, amount: true, metadata: true, email: true },
  });
  if (!pay) return { repaired: false, reason: 'payment_not_found' };

  let verifyData = paystackData;
  if (!verifyData || verifyData.status !== 'success') {
    try {
      const verified = await paystackFetch(`/transaction/verify/${encodeURIComponent(ref)}`);
      if (verified?.data?.status === 'success') verifyData = verified.data;
    } catch (e) {
      console.warn('repairPaymentFulfillmentByReference verify failed', e?.message);
    }
  }

  const amountKobo =
    verifyData?.amount != null && Number(verifyData.amount) > 0
      ? Number(verifyData.amount)
      : Math.round(Number(pay.amount || 0) * 100);

  const data = {
    status: 'success',
    amount: amountKobo,
    customer: { email: pay.email || verifyData?.customer?.email },
    metadata: flattenPaymentMetadata(pay.metadata),
    ...(verifyData && typeof verifyData === 'object' ? verifyData : {}),
    amount: amountKobo,
    status: 'success',
  };

  await applyReferenceSideEffects(ref, data);
  await runPaymentRepairPaths(ref, data, { replayIncomplete: true });

  const refreshed = await prisma.payment.findUnique({
    where: { reference: ref },
    select: { metadata: true, status: true },
  });
  const meta = flattenPaymentMetadata(refreshed?.metadata);
  const complete = await isPaymentFulfillmentComplete(ref, meta);
  return {
    repaired: complete,
    reason: complete ? 'ok' : meta.side_effects_error || 'still_incomplete',
    fulfillment_applied: complete,
    payment_status: refreshed?.status || pay.status,
  };
}

/** Batch-heal success payments whose domain fulfillment never finished. */
export async function repairStuckSuccessPayments({ limit = 40, sinceDays = 14 } = {}) {
  const since = new Date(Date.now() - Math.max(1, sinceDays) * 24 * 60 * 60 * 1000);
  const take = Math.min(150, Math.max(1, limit) * 3);
  const candidates = await prisma.payment.findMany({
    where: {
      status: 'success',
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take,
    select: { reference: true, metadata: true, amount: true, createdAt: true },
  });

  const results = [];
  for (const row of candidates) {
    if (results.length >= limit) break;
    const meta = flattenPaymentMetadata(row.metadata);
    if (meta.side_effects_applied === true) continue;
    const complete = await isPaymentFulfillmentComplete(row.reference, meta);
    if (complete) {
      await finalizePaymentIfFulfilled(row.reference, { status: 'success', amount: Math.round(Number(row.amount || 0) * 100) });
      continue;
    }
    const repair = await repairPaymentFulfillmentByReference(row.reference);
    results.push({ reference: row.reference, ...repair });
  }

  return {
    scanned: candidates.length,
    attempted: results.length,
    repaired: results.filter((r) => r.repaired).length,
    results,
  };
}

async function buildFulfillmentStatusResponse(reference) {
  const pay = await prisma.payment.findUnique({
    where: { reference },
    select: { status: true, metadata: true, type: true },
  });
  if (!pay) return null;

  const paidMeta = flattenPaymentMetadata(pay.metadata);
  const fulfillmentApplied = await isPaymentFulfillmentComplete(reference, {
    ...paidMeta,
    type: paidMeta.type || pay.type,
  });

  const paystackOk = pay.status === 'success';
  const bookingMode = paidMeta.booking_mode || paidMeta.bookingMode;
  const isHostCheckout =
    bookingMode === 'host' ||
    bookingMode === 'custom_host' ||
    paidMeta.member_role === 'HOST';

  return {
    status: paystackOk ? (fulfillmentApplied ? 'paid' : 'processing') : pay.status,
    paystack_status: paystackOk ? 'success' : pay.status === 'failed' ? 'failed' : 'pending',
    paystack_reference: reference,
    fulfillment: {
      applied: fulfillmentApplied,
      pending: paystackOk && !fulfillmentApplied,
      error: paidMeta.side_effects_error || null,
    },
    payment_type: paidMeta.type || pay.type || null,
    booking_mode: bookingMode || null,
    is_host_checkout: isHostCheckout,
  };
}

async function buildPaymentVerifyResponse(reference, paystackStatus) {
  const mapped =
    paystackStatus === 'success' ? 'paid' : paystackStatus === 'failed' ? 'failed' : 'pending';
  if (mapped !== 'paid') {
    return { status: mapped, paystack_status: paystackStatus };
  }

  const paidRow = await prisma.payment.findUnique({
    where: { reference },
    select: { metadata: true, type: true },
  });
  const paidMeta = flattenPaymentMetadata(paidRow?.metadata);
  const fulfillmentApplied = await isPaymentFulfillmentComplete(reference, paidMeta);
  const fulfillmentPending = paystackStatus === 'success' && !fulfillmentApplied;
  const payoutStatus = await getVenueTablePayoutStatus(reference).catch(() => ({ ledger: 'unknown' }));

  const responseStatus = fulfillmentApplied ? 'paid' : 'processing';

  const bookingMode = paidMeta.booking_mode || paidMeta.bookingMode;
  const isHostCheckout =
    bookingMode === 'host' ||
    bookingMode === 'custom_host' ||
    paidMeta.member_role === 'HOST';

  return {
    status: responseStatus,
    paystack_status: paystackStatus,
    paystack_reference: reference,
    fulfillment: {
      applied: fulfillmentApplied,
      pending: fulfillmentPending,
      error: paidMeta.side_effects_error || null,
    },
    payout_status: payoutStatus,
    payment_type: paidMeta.type || paidRow?.type || null,
    booking_mode: bookingMode || null,
    is_host_checkout: isHostCheckout,
  };
}

async function assertPaymentOwnership(reference, userId) {
  const payment = await prisma.payment.findUnique({
    where: { reference },
    select: { userId: true },
  });
  if (!payment) return { ok: false, code: 404, error: 'Payment reference not found' };
  if (!payment.userId || String(payment.userId) !== String(userId)) {
    return { ok: false, code: 403, error: 'Not authorized to verify this payment' };
  }
  return { ok: true };
}

/** Paystack charge.failed: mark Payment/Transaction failed and notify payer, venue, and table host when applicable. */
async function applyChargeFailedEffects(reference, payload) {
  const data = payload?.data || {};
  const metaFromCharge = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const prior = await prisma.payment.findUnique({
    where: { reference },
    select: { metadata: true, userId: true },
  });
  const priorMeta = prior?.metadata && typeof prior.metadata === 'object' ? prior.metadata : {};
  const mergedMeta = {
    ...priorMeta,
    ...metaFromCharge,
    charge_failed: {
      message: data.gateway_response || data.message || 'Payment failed',
      at: new Date().toISOString(),
    },
  };
  await prisma.payment.updateMany({
    where: { reference },
    data: { status: 'failed', metadata: mergedMeta },
  });
  await prisma.transaction.updateMany({
    where: { stripeId: reference },
    data: { status: 'failed', metadata: data },
  });

  const userId = String(metaFromCharge.user_id || prior?.userId || mergedMeta.user_id || '').trim();
  const ptype = metaFromCharge.type || mergedMeta.type;
  const failReason =
    data.gateway_response || data.message || 'Your bank or card issuer declined the payment.';

  if (userId) {
    await createNotification({
      userId,
      type: 'system',
      title: 'Payment did not go through',
      body: `${failReason} Try again or use another card. If this keeps happening, contact support.`,
      actionUrl: '/HostDashboard',
    });
    const failRefId = metaFromCharge.hosted_table_id || metaFromCharge.hostedTableId;
    await createInAppNotification({
      userId,
      type: 'TABLE_JOINED',
      title: 'Payment failed',
      body: failReason,
      referenceId: failRefId ? String(failRefId) : null,
      referenceType: failRefId ? 'HOSTED_TABLE' : null,
    });
  }

  if (ptype === 'TABLE_HOST_FEE') {
    const htid = metaFromCharge.hosted_table_id || metaFromCharge.hostedTableId;
    if (htid) {
      const ht = await prisma.hostedTable.findFirst({
        where: { id: String(htid) },
        include: { event: { include: { venue: { select: { ownerUserId: true } } } } },
      });
      const ownerId = ht?.event?.venue?.ownerUserId;
      if (ownerId && ht?.tableName) {
        await createNotification({
          userId: ownerId,
          type: 'system',
          title: 'Hosted table payment failed',
          body: `A host listing payment for "${ht.tableName}" did not complete. No card data is stored.`,
          actionUrl: '/BusinessBookings',
        });
      }
      if (
        ht?.status === 'DRAFT' &&
        ((ht.tableType === 'IN_APP_EVENT' && !ht.hostFeePaystackRef) ||
          (ht.tableType === 'EXTERNAL_VENUE' && !ht.externalListingPaystackRef))
      ) {
        await prisma.hostedTable.delete({ where: { id: ht.id } });
      }
    }
  }

  if (ptype === 'HOSTED_TABLE_JOIN') {
    const memberId = metaFromCharge.hosted_table_member_id || metaFromCharge.hostedTableMemberId;
    if (memberId) {
      const mem = await prisma.hostedTableMember.findUnique({ where: { id: String(memberId) } });
      if (mem?.status === 'PENDING' && !mem.paystackReference && !mem.hostReviewedAt) {
        await prisma.hostedTableMember.delete({ where: { id: mem.id } }).catch(() => {});
      }
    }
    const htid = metaFromCharge.hosted_table_id || metaFromCharge.hostedTableId;
    if (htid) {
      const ht = await prisma.hostedTable.findFirst({
        where: { id: String(htid) },
        include: { event: { include: { venue: { select: { ownerUserId: true } } } } },
      });
      const ownerId = ht?.event?.venue?.ownerUserId;
      if (ownerId) {
        await createNotification({
          userId: ownerId,
          type: 'system',
          title: 'Table join payment failed',
          body: `A guest payment to join "${ht?.tableName || 'a hosted table'}" was not completed.`,
          actionUrl: '/BusinessBookings',
        });
      }
      if (ht?.hostUserId && String(ht.hostUserId) !== userId) {
        await createNotification({
          userId: ht.hostUserId,
          type: 'system',
          title: 'Join payment incomplete',
          body: `A payment to join your table "${ht.tableName}" did not succeed. The guest can try again.`,
          actionUrl: '/HostDashboard',
        });
      }
    }
  }
}

const initSchema = z.object({
  amount: z.number().positive().max(1_000_000),
  email: z.string().email().optional(),
  description: z.string().max(2000).optional().nullable(),
  /** Venue/event IDs may be UUID or Cuid depending on DB row; do not over-restrict. */
  venue_id: z.union([z.string().min(1).max(64), z.null()]).optional(),
  event_id: z.union([z.string().min(1).max(64), z.null()]).optional(),
  metadata: z.record(z.any()).optional().nullable(),
});

const payoutRecipientSchema = z.object({
  holder_type: z.enum(['USER', 'VENUE']),
  venue_id: z.string().optional().nullable(),
  account_name: z.string().min(2).max(120),
  account_number: z.string().min(6).max(20),
  bank_code: z.string().min(2).max(20),
  currency: z.string().default('ZAR'),
});

// GET /api/payments/paystack-public-key — no auth; SPA inline checkout when VITE_PAYSTACK_PUBLIC_KEY is unset
router.get('/paystack-public-key', (_req, res) => {
  const pk = getPaystackPublicKeyForClient();
  if (!pk || !pk.startsWith('pk_')) {
    return res.status(503).json({
      error:
        'Paystack public key is not configured on the API. Set PAYSTACK_PUBLIC_KEY (pk_test_… or pk_live_…) in the backend environment next to PAYSTACK_SECRET_KEY.',
    });
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ public_key: pk });
});

router.post('/payout-recipient', authenticateToken, async (req, res, next) => {
  try {
    const parsed = payoutRecipientSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const d = parsed.data;

    let recipientVenueId = null;
    let previousRecipientCode = null;
    if (d.holder_type === 'VENUE') {
      if (!d.venue_id) return res.status(400).json({ error: 'venue_id is required for venue payout setup' });
      const venue = await prisma.venue.findFirst({
        where: { id: String(d.venue_id), deletedAt: null },
        select: { id: true, ownerUserId: true, paystackRecipientCode: true },
      });
      if (!venue) return res.status(404).json({ error: 'Venue not found' });
      if (venue.ownerUserId !== req.userId) return res.status(403).json({ error: 'Not authorized for this venue' });
      recipientVenueId = venue.id;
      previousRecipientCode = venue.paystackRecipientCode || null;
    } else {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { paystackRecipientCode: true },
      });
      previousRecipientCode = user?.paystackRecipientCode || null;
    }

    // South Africa (ZAR) uses BASA recipients; nuban is Nigeria/NGN only.
    const currency = String(d.currency || 'ZAR').toUpperCase();
    const paystackRecipientType = currency === 'ZAR' ? 'basa' : 'nuban';
    const recipientResp = await paystackFetch('/transferrecipient', {
      method: 'POST',
      body: {
        type: paystackRecipientType,
        name: d.account_name,
        account_number: d.account_number,
        bank_code: d.bank_code,
        currency,
      },
    });
    const recipientCode = recipientResp?.data?.recipient_code;
    if (!recipientCode) return res.status(502).json({ error: 'Paystack did not return a recipient code' });

    if (d.holder_type === 'VENUE') {
      await prisma.venue.update({
        where: { id: recipientVenueId },
        data: { paystackRecipientCode: recipientCode },
      });
    } else {
      await prisma.user.update({
        where: { id: req.userId },
        data: { paystackRecipientCode: recipientCode },
      });
      await prisma.userProfile.upsert({
        where: { userId: req.userId },
        create: { userId: req.userId, paymentSetupComplete: true },
        update: { paymentSetupComplete: true },
      });
    }

    // Ready queued earnings for the next weekly payout now that a recipient exists
    // (clears "missing recipient" flags; no transfer here; best-effort).
    let payoutRetry = null;
    try {
      const { retryStuckPayouts } = await import('../lib/paystackPayout.js');
      if (d.holder_type === 'VENUE') {
        payoutRetry = await retryStuckPayouts({ limit: 100, recipientVenueId });
      } else {
        payoutRetry = await retryStuckPayouts({
          limit: 100,
          recipientUserId: req.userId,
          includeOwnerVenueFallback: true,
        });
      }
      logger.info('post-wallet-setup payout retry', {
        holder_type: d.holder_type,
        venueId: recipientVenueId,
        userId: d.holder_type === 'USER' ? req.userId : undefined,
        ...payoutRetry,
      });
    } catch (retryErr) {
      logger.warn('post-wallet-setup payout retry failed', { err: retryErr?.message });
    }

    // Deactivate previous recipient only when no in-flight transfers for this holder.
    if (previousRecipientCode && previousRecipientCode !== recipientCode) {
      const processingWhere =
        d.holder_type === 'VENUE'
          ? { recipientVenueId, status: 'PROCESSING' }
          : { recipientUserId: req.userId, status: 'PROCESSING' };
      const inFlight = await prisma.payoutLedger.count({ where: processingWhere });
      if (inFlight === 0) {
        try {
          await paystackFetch(`/transferrecipient/${encodeURIComponent(previousRecipientCode)}`, {
            method: 'DELETE',
          });
        } catch (delErr) {
          // Ignore not-found / already-deleted; do not fail the new setup.
          logger.warn('paystack transfer recipient delete failed', {
            code: previousRecipientCode,
            err: delErr?.message,
          });
        }
      } else {
        logger.info('skipped deleting previous paystack recipient while transfers PROCESSING', {
          code: previousRecipientCode,
          inFlight,
        });
      }
    }

    return res.json({
      success: true,
      holder_type: d.holder_type,
      recipient_code: recipientCode,
      recipient_name: recipientResp?.data?.name || d.account_name,
      // Never expose full bank account numbers to the client after save.
      details: null,
      wallet_set: true,
      payout_retry: payoutRetry,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/payments/initialize — primary endpoint (spec-compliant)
router.post('/initialize', authenticateToken, async (req, res, next) => {
  try {
    const parsed = initSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const d = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true },
    });
    const email = d.email || user?.email || 'user@secnightlife.app';

    const amountInCents = Math.round(d.amount * 100);
    const reference = crypto.randomBytes(16).toString('hex');
    let meta = { ...(d.metadata || {}) };
    const type = meta.type || (d.venue_id && meta.promotion_id ? 'promotion' : d.event_id ? 'event' : 'table') || 'other';

    if (type === 'TABLE_HOST_FEE') {
      return res.status(410).json({
        error: 'This checkout type is retired. Host venue tables from the event or day booking page.',
        code: 'TABLE_HOST_FEE_RETIRED',
      });
    }

    if (type === 'ticket') {
      const computed = await computeTicketCheckout(prisma, {
        eventId: meta.event_id,
        ticketTierName: meta.ticket_tier_name,
        quantity: meta.quantity || 1,
        selectedMenuItems: parseTicketMenuItems(meta),
        userId: req.userId,
      });
      if (!computed.ok) return res.status(400).json({ error: computed.error });
      if (Math.abs(Number(d.amount) - computed.total) >= 0.02) {
        return res.status(400).json({
          error: 'Payment amount does not match checkout total.',
          expected_zar: computed.total,
        });
      }
      meta = buildTicketPaymentMetadata(meta, computed);
    } else if (type === 'EVENT_ENTRANCE') {
      const computed = await computeEventEntranceCheckout(prisma, {
        eventId: meta.event_id || d.event_id,
        selectedMenuItems: meta.selected_menu_items || meta.selectedMenuItems || [],
      });
      if (!computed.ok) return res.status(400).json({ error: computed.error });
      if (Math.abs(Number(d.amount) - computed.total) >= 0.02) {
        return res.status(400).json({
          error: 'Payment amount does not match checkout total.',
          expected_zar: computed.total,
        });
      }
      meta = {
        ...meta,
        type: 'EVENT_ENTRANCE',
        event_id: computed.event.id,
        venue_id: computed.event.venueId,
        entrance_zar: computed.entranceZar,
        menu_zar: computed.menuZar,
        subtotal_zar: computed.subtotal,
        service_fee_zar: computed.serviceFee,
        amount_total_zar: computed.total,
        platform_fee_zar: computed.platformFee,
        venue_share_zar: computed.venueShare,
        selected_menu_items: computed.menuItems.length ? computed.menuItems : undefined,
        lines: computed.lines,
      };
    } else if (['table', 'VENUE_TABLE_JOIN', 'TABLE_CHECKOUT', 'HOSTED_TABLE_JOIN'].includes(type)) {
      const expected = expectedTotalFromMetadata(meta);
      if (expected > 0 && Math.abs(Number(d.amount) - expected) >= 0.02) {
        return res.status(400).json({
          error: 'Payment amount does not match checkout total.',
          expected_zar: expected,
        });
      }
    } else {
      const platformExpected = expectedPlatformProductAmountZar(meta);
      if (platformExpected != null && Math.abs(Number(d.amount) - platformExpected) >= 0.02) {
        return res.status(400).json({
          error: 'Payment amount does not match product price.',
          expected_zar: platformExpected,
        });
      }
    }

    if (type === 'table' && !(await userHasIdentityVerified(req.userId))) {
      return res.status(403).json({
        error: 'Identity verification required to pay for table bookings.',
        code: 'IDENTITY_NOT_VERIFIED',
      });
    }

    if (type === 'ticket' || type === 'event') {
      await abandonSupersededPendingPayments(prisma, {
        userId: req.userId,
        paymentType: PAYMENT_TYPES.includes(type) ? type : 'ticket',
        eventId: meta.event_id || meta.eventId || d.event_id || null,
        ticketTier: meta.ticket_tier_name || meta.ticketTierName || null,
      });
    }

    // Create Payment (pending)
    await prisma.payment.create({
      data: {
        userId: req.userId,
        email,
        amount: d.amount,
        reference,
        status: 'pending',
        type: PAYMENT_TYPES.includes(type) ? type : 'other',
        metadata: { description: d.description, venue_id: d.venue_id, event_id: d.event_id, ...meta },
      },
    });

    // Legacy Transaction for backward compat
    await prisma.transaction.create({
      data: {
        userId: req.userId,
        venueId: d.venue_id || null,
        eventId: d.event_id || null,
        amount: d.amount,
        currency: 'ZAR',
        type: 'paystack',
        status: 'pending',
        stripeId: reference,
        metadata: { provider: 'paystack', reference, description: d.description, ...meta },
      },
    });

    const paystackResp = await paystackFetch('/transaction/initialize', {
      method: 'POST',
      body: buildPaystackInitializeBody({
        email,
        amountInCents,
        reference,
        userId: req.userId,
        metadata: { type, description: d.description, ...meta },
      }),
    });

    res.json({
      reference,
      authorization_url: paystackResp.data.authorization_url,
      access_code: paystackResp.data.access_code,
    });
  } catch (err) {
    next(err);
  }
});

// Backward compat: /paystack/initialize
router.post('/paystack/initialize', authenticateToken, async (req, res, next) => {
  try {
    const parsed = initSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    const d = parsed.data;
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { email: true } });
    const email = d.email || user?.email || 'user@secnightlife.app';
    const amountInCents = Math.round(d.amount * 100);
    const reference = crypto.randomBytes(16).toString('hex');
    let meta = { ...(d.metadata || {}) };
    const type = meta.type || (meta.promotion_id ? 'promotion' : d.event_id ? 'event' : 'table') || 'other';
    if (type === 'TABLE_HOST_FEE') {
      return res.status(410).json({
        error: 'This checkout type is retired. Host venue tables from the event or day booking page.',
        code: 'TABLE_HOST_FEE_RETIRED',
      });
    }
    if (type === 'ticket') {
      const computed = await computeTicketCheckout(prisma, {
        eventId: meta.event_id,
        ticketTierName: meta.ticket_tier_name,
        quantity: meta.quantity || 1,
        selectedMenuItems: parseTicketMenuItems(meta),
        userId: req.userId,
      });
      if (!computed.ok) return res.status(400).json({ error: computed.error });
      if (Math.abs(Number(d.amount) - computed.total) >= 0.02) {
        return res.status(400).json({
          error: 'Payment amount does not match checkout total.',
          expected_zar: computed.total,
        });
      }
      meta = buildTicketPaymentMetadata(meta, computed);
    } else if (type === 'EVENT_ENTRANCE') {
      const computed = await computeEventEntranceCheckout(prisma, {
        eventId: meta.event_id || d.event_id,
        selectedMenuItems: meta.selected_menu_items || meta.selectedMenuItems || [],
      });
      if (!computed.ok) return res.status(400).json({ error: computed.error });
      if (Math.abs(Number(d.amount) - computed.total) >= 0.02) {
        return res.status(400).json({
          error: 'Payment amount does not match checkout total.',
          expected_zar: computed.total,
        });
      }
      meta = {
        ...meta,
        type: 'EVENT_ENTRANCE',
        event_id: computed.event.id,
        venue_id: computed.event.venueId,
        entrance_zar: computed.entranceZar,
        menu_zar: computed.menuZar,
        subtotal_zar: computed.subtotal,
        service_fee_zar: computed.serviceFee,
        amount_total_zar: computed.total,
        platform_fee_zar: computed.platformFee,
        venue_share_zar: computed.venueShare,
        selected_menu_items: computed.menuItems.length ? computed.menuItems : undefined,
        lines: computed.lines,
      };
    } else if (['table', 'VENUE_TABLE_JOIN', 'TABLE_CHECKOUT', 'HOSTED_TABLE_JOIN'].includes(type)) {
      const expected = expectedTotalFromMetadata(meta);
      if (expected > 0 && Math.abs(Number(d.amount) - expected) >= 0.02) {
        return res.status(400).json({
          error: 'Payment amount does not match checkout total.',
          expected_zar: expected,
        });
      }
    } else {
      const platformExpected = expectedPlatformProductAmountZar(meta);
      if (platformExpected != null && Math.abs(Number(d.amount) - platformExpected) >= 0.02) {
        return res.status(400).json({
          error: 'Payment amount does not match product price.',
          expected_zar: platformExpected,
        });
      }
    }
    if (type === 'table' && !(await userHasIdentityVerified(req.userId))) {
      return res.status(403).json({
        error: 'Identity verification required to pay for table bookings.',
        code: 'IDENTITY_NOT_VERIFIED',
      });
    }
    if (type === 'ticket' || type === 'event') {
      await abandonSupersededPendingPayments(prisma, {
        userId: req.userId,
        paymentType: PAYMENT_TYPES.includes(type) ? type : 'ticket',
        eventId: meta.event_id || meta.eventId || d.event_id || null,
        ticketTier: meta.ticket_tier_name || meta.ticketTierName || null,
      });
    }
    await prisma.payment.create({
      data: { userId: req.userId, email, amount: d.amount, reference, status: 'pending', type: PAYMENT_TYPES.includes(type) ? type : 'other', metadata: { description: d.description, venue_id: d.venue_id, event_id: d.event_id, ...meta } },
    });
    await prisma.transaction.create({
      data: { userId: req.userId, venueId: d.venue_id || null, eventId: d.event_id || null, amount: d.amount, currency: 'ZAR', type: 'paystack', status: 'pending', stripeId: reference, metadata: { provider: 'paystack', reference, description: d.description, ...meta } },
    });
    const paystackResp = await paystackFetch('/transaction/initialize', {
      method: 'POST',
      body: buildPaystackInitializeBody({
        email,
        amountInCents,
        reference,
        userId: req.userId,
        metadata: { type, description: d.description, ...meta },
      }),
    });
    res.json({ reference, authorization_url: paystackResp.data.authorization_url, access_code: paystackResp.data.access_code });
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/:reference/fulfillment — DB-only fulfillment status (for fast polling)
router.get('/:reference/fulfillment', authenticateToken, async (req, res, next) => {
  try {
    const reference = req.params.reference;
    const ownership = await assertPaymentOwnership(reference, req.userId);
    if (!ownership.ok) return res.status(ownership.code).json({ error: ownership.error });
    const result = await buildFulfillmentStatusResponse(reference);
    if (!result) return res.status(404).json({ error: 'Payment reference not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/payments/:reference/repair-fulfillment — re-apply side effects after Paystack success
router.post('/:reference/repair-fulfillment', authenticateToken, async (req, res, next) => {
  try {
    const reference = req.params.reference;
    const ownership = await assertPaymentOwnership(reference, req.userId);
    if (!ownership.ok) return res.status(ownership.code).json({ error: ownership.error });
    const repair = await repairPaymentFulfillmentByReference(reference);
    const status = await buildFulfillmentStatusResponse(reference);
    res.json({ ...repair, ...(status || {}) });
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/verify/:reference — primary (spec-compliant)
router.get('/verify/:reference', authenticateToken, async (req, res, next) => {
  try {
    const reference = req.params.reference;
    const ownership = await assertPaymentOwnership(reference, req.userId);
    if (!ownership.ok) return res.status(ownership.code).json({ error: ownership.error });
    const paystackResp = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
    const status = paystackResp.data.status;
    const mapped = status === 'success' ? 'paid' : status === 'failed' ? 'failed' : 'pending';

    // Update Transaction
    await prisma.transaction.updateMany({
      where: { userId: req.userId, stripeId: reference },
      data: { status: mapped, metadata: paystackResp.data },
    });

    if (mapped === 'paid') {
      await applyReferenceSideEffects(reference, paystackResp.data);
      await runPaymentRepairPaths(reference, paystackResp.data);
      const paidRow = await prisma.payment.findUnique({
        where: { reference },
        select: { metadata: true, type: true, userId: true, email: true },
      });
      const paidMeta = flattenPaymentMetadata(paidRow?.metadata);
      const paidPromoId = resolvePromotionIdFromMetadata(paidMeta);
      if (paidPromoId && isPromotionPublishPayment(paidMeta, paidRow?.type)) {
        await activatePromotionAfterPublishPayment({
          promoId: paidPromoId,
          metadata: paidMeta,
          reference,
          payerUserId: paidRow?.userId || req.userId,
          payerEmail: paidRow?.email,
          sendNotification: false,
        });
      }
    } else {
      const existing = await prisma.payment.findUnique({
        where: { reference },
        select: { metadata: true },
      });
      const mergedMeta = mergePaymentMetadataFromVerify(
        flattenPaymentMetadata(existing?.metadata),
        paystackResp.data,
      );
      await prisma.payment.updateMany({
        where: { reference },
        data: { status: mapped, metadata: mergedMeta },
      });
    }

    res.json(await buildPaymentVerifyResponse(reference, status));
  } catch (err) {
    next(err);
  }
});

// Backward compat: /paystack/verify/:reference
router.get('/paystack/verify/:reference', authenticateToken, async (req, res, next) => {
  try {
    const reference = req.params.reference;
    const ownership = await assertPaymentOwnership(reference, req.userId);
    if (!ownership.ok) return res.status(ownership.code).json({ error: ownership.error });
    const paystackResp = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
    const status = paystackResp.data.status;
    const mapped = status === 'success' ? 'paid' : status === 'failed' ? 'failed' : 'pending';
    await prisma.transaction.updateMany({ where: { userId: req.userId, stripeId: reference }, data: { status: mapped, metadata: paystackResp.data } });
    if (mapped === 'paid') {
      await applyReferenceSideEffects(reference, paystackResp.data);
      await runPaymentRepairPaths(reference, paystackResp.data);
      const paidRow = await prisma.payment.findUnique({
        where: { reference },
        select: { metadata: true, type: true, userId: true, email: true },
      });
      const paidMeta = flattenPaymentMetadata(paidRow?.metadata);
      const paidPromoId = resolvePromotionIdFromMetadata(paidMeta);
      if (paidPromoId && isPromotionPublishPayment(paidMeta, paidRow?.type)) {
        await activatePromotionAfterPublishPayment({
          promoId: paidPromoId,
          metadata: paidMeta,
          reference,
          payerUserId: paidRow?.userId || req.userId,
          payerEmail: paidRow?.email,
          sendNotification: false,
        });
      }
    } else {
      const existing = await prisma.payment.findUnique({
        where: { reference },
        select: { metadata: true },
      });
      const mergedMeta = mergePaymentMetadataFromVerify(
        flattenPaymentMetadata(existing?.metadata),
        paystackResp.data,
      );
      await prisma.payment.updateMany({ where: { reference }, data: { status: mapped, metadata: mergedMeta } });
    }
    res.json(await buildPaymentVerifyResponse(reference, status));
  } catch (err) {
    next(err);
  }
});

// Paystack webhook handler — used by BOTH /api/webhooks/paystack and /api/payments/paystack/webhook
export async function paystackWebhookHandler(req, res) {
  const sig = req.headers['x-paystack-signature'];
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!sig || !key) return res.status(400).send('bad request');
  const hash = crypto.createHmac('sha512', key).update(req.body).digest('hex');
  const sigBuf = Buffer.from(String(sig));
  const hashBuf = Buffer.from(hash);
  if (sigBuf.length !== hashBuf.length || !crypto.timingSafeEqual(sigBuf, hashBuf)) {
    return res.status(401).send('invalid signature');
  }
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('invalid json');
  }

  const event = payload?.event;
  const data = payload?.data;

  if (event === 'transfer.success' || event === 'transfer.failed' || event === 'transfer.reversed') {
    try {
      await applyTransferWebhookEvent(event, data || {});
    } catch (e) {
      console.error('Paystack webhook transfer event error:', e?.message);
    }
    return res.status(200).send('ok');
  }

  if (event === 'charge.dispute.create' || event === 'charge.dispute.remind' || event === 'charge.dispute.resolve') {
    try {
      const reference = data?.transaction?.reference || data?.reference || null;
      if (reference) {
        const existing = await prisma.payment.findUnique({ where: { reference } });
        if (existing) {
          const meta =
            existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
              ? { ...existing.metadata }
              : {};
          meta.dispute = {
            event,
            status: data?.status || null,
            id: data?.id || null,
            updatedAt: new Date().toISOString(),
          };
          await prisma.payment.update({
            where: { id: existing.id },
            data: { metadata: meta },
          });
        }
      }
      const adminEmail = String(process.env.SUPER_ADMIN_EMAIL || '').trim();
      if (adminEmail) {
        await sendEmail({
          to: adminEmail,
          subject: `Paystack dispute: ${event}`,
          text: `Dispute event ${event} for reference ${reference || 'unknown'}.\nStatus: ${data?.status || 'n/a'}\nReview in Paystack dashboard.`,
        }).catch(() => {});
      }
    } catch (e) {
      console.error('Paystack webhook dispute error:', e?.message);
    }
    return res.status(200).send('ok');
  }

  const reference = data?.reference;
  if (!reference) return res.status(200).send('ok');

  if (event === 'charge.success') {
    try {
      const verified = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
      if (verified?.data?.status === 'success') {
        await applyReferenceSideEffects(reference, verified.data);
        await runPaymentRepairPaths(reference, verified.data);
      }
    } catch (e) {
      // Log but don't fail — Paystack may retry
      console.error('Paystack webhook applyReferenceSideEffects error:', e?.message);
    }
  }

  if (event === 'charge.failed') {
    try {
      await applyChargeFailedEffects(reference, payload);
    } catch (e) {
      console.error('Paystack webhook charge.failed error:', e?.message);
    }
  }

  return res.status(200).send('ok');
}

export default router;
