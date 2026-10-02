import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { splitPlatformGross } from './platformSplit.js';
import { FEED_BOOST_ZAR_PER_DAY, clampBoostDays } from './feedBoost.js';
import { PAYOUT_MIN_ZAR, groupPayoutRowsByRecipient } from './payoutSchedule.js';
import { netOfServiceFee } from './serviceFee.js';

export { splitPlatformGross, splitPlatformGross as splitSecPlatform } from './platformSplit.js';

export const EXTERNAL_HOSTED_LISTING_ZAR = 200;
export const PROMOTION_PUBLISH_ZAR_PER_DAY = 50;
export const PROMOTION_BOOST_ZAR_PER_DAY = 150;

function requirePaystackKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    const err = new Error('Paystack is not configured');
    err.status = 500;
    throw err;
  }
  return key;
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
 * Server-side expected amount for platform fee / boost / listing checkouts.
 * Returns null when type is not a fixed-price platform product.
 */
export function expectedPlatformProductAmountZar(meta = {}) {
  const type = String(meta.type || meta.sec_kind || '');
  const boostDays = clampBoostDays(meta.boost_days ?? meta.boostDays ?? meta.days ?? 1);

  if (type === 'HOSTED_TABLE_EXTERNAL_LISTING') {
    return EXTERNAL_HOSTED_LISTING_ZAR;
  }
  if (type === 'TABLE_BOOST' || type === 'EVENT_BOOST' || type === 'VENUE_TABLE_BOOST' || type === 'HOUSE_PARTY_BOOST') {
    return FEED_BOOST_ZAR_PER_DAY * boostDays;
  }
  if (type === 'BOOST' || type === 'PROMOTION_BOOST') {
    return PROMOTION_BOOST_ZAR_PER_DAY * boostDays;
  }
  if (type === 'PROMOTION_PUBLISH' || meta.sec_kind === 'PROMOTION_PUBLISH') {
    const publishDays = Math.max(1, Math.min(90, Number(meta.publish_days ?? meta.publishDays ?? 1) || 1));
    const boostPart = Number(meta.boost_days ?? meta.boostDays ?? 0) || 0;
    const boostZar = boostPart > 0 ? PROMOTION_BOOST_ZAR_PER_DAY * clampBoostDays(boostPart) : 0;
    return publishDays * PROMOTION_PUBLISH_ZAR_PER_DAY + boostZar;
  }
  return null;
}

/** Record 100% SEC revenue (promotions, boosts, platform fees) — no recipient transfer. */
export async function recordSecPlatformRevenue(paymentReference, grossZar) {
  const gross = Number(grossZar) || 0;
  if (gross <= 0) return { skipped: true };
  return recordPayoutAndMaybeTransfer({
    paymentReference,
    grossZar: gross,
    secAmount: gross,
    recipientAmount: 0,
    recipientType: 'PLATFORM',
  });
}

const MISSING_RECIPIENT_MESSAGE =
  'Missing paystack recipient code — configure payouts in account settings.';

/**
 * Claim-or-create ledger row by unique paymentReference.
 * Recipient earnings stay PENDING until the weekly batch run (runWeeklyPayoutBatches)
 * sends one Paystack transfer per recipient.
 */
export async function recordPayoutAndMaybeTransfer(opts) {
  const {
    paymentReference,
    grossZar,
    secAmount,
    recipientAmount,
    recipientType,
    recipientUserId = null,
    recipientVenueId = null,
    paystackRecipientCode = null,
  } = opts;

  const existing = await prisma.payoutLedger.findUnique({
    where: { paymentReference },
  });
  if (existing) {
    return { status: existing.status, ledgerId: existing.id, skipped: true };
  }

  const isPlatform = recipientType === 'PLATFORM' || recipientAmount <= 0;
  try {
    const row = await prisma.payoutLedger.create({
      data: isPlatform
        ? {
          paymentReference,
          grossAmount: grossZar,
          secAmount,
          recipientAmount,
          recipientType: 'PLATFORM',
          recipientUserId: null,
          recipientVenueId: null,
          status: 'SKIPPED_NO_RECIPIENT',
          errorMessage: null,
        }
        : {
          paymentReference,
          grossAmount: grossZar,
          secAmount,
          recipientAmount,
          recipientType,
          recipientUserId,
          recipientVenueId,
          status: 'PENDING',
          errorMessage: paystackRecipientCode ? null : MISSING_RECIPIENT_MESSAGE,
        },
    });
    if (!isPlatform && !paystackRecipientCode) {
      logger.warn('payout pending: no recipient code', { paymentReference, recipientUserId, recipientVenueId });
    }
    return isPlatform
      ? { status: 'SKIPPED_NO_RECIPIENT', ledgerId: row.id }
      : { status: 'PENDING', ledgerId: row.id, queued: true };
  } catch (e) {
    if (e?.code === 'P2002') {
      const again = await prisma.payoutLedger.findUnique({ where: { paymentReference } });
      return { status: again?.status, ledgerId: again?.id, skipped: true };
    }
    throw e;
  }
}

/** Paystack transfer references may only use alphanumeric, underscore, and hyphen. */
export function sanitizePaystackTransferReference(raw) {
  return String(raw || '')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

const BATCH_REF_PREFIX = 'secbatch-';

function batchIdFromTransferRef(ref) {
  const s = String(ref || '');
  if (!s.startsWith(BATCH_REF_PREFIX)) return null;
  return s.slice(BATCH_REF_PREFIX.length).split('-')[0] || null;
}

function roundZar(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function resolveRecipientCodeForGroup(group) {
  if (group.recipientVenueId) return resolveRecipientCodeForVenue(group.recipientVenueId);
  if (group.recipientUserId) return resolveRecipientCodeForUser(group.recipientUserId);
  return null;
}

function batchTransferReason(saleCount) {
  const n = Number(saleCount) || 0;
  return `SEC Nightlife · Weekly payout · ${n} sale${n === 1 ? '' : 's'}`.slice(0, 100);
}

/**
 * Send one Paystack transfer for a batch. Claimed rows move to PROCESSING on success.
 * On failure the batch is FAILED and its rows stay PENDING (still attached) for the daily retry.
 */
async function sendBatchTransfer(batchId, paystackRecipientCode) {
  const batch = await prisma.payoutBatch.findUnique({
    where: { id: batchId },
    include: {
      ledgers: {
        where: { status: { in: ['PENDING', 'FAILED'] } },
        select: { id: true, recipientAmount: true },
      },
    },
  });
  if (!batch) return { skipped: true, reason: 'not_found' };

  const total = roundZar(batch.ledgers.reduce((s, r) => s + (Number(r.recipientAmount) || 0), 0));
  const amountKobo = Math.round(total * 100);
  if (!batch.ledgers.length || amountKobo < 100) {
    await prisma.payoutBatch.update({
      where: { id: batch.id },
      data: { status: 'FAILED', totalAmount: total, errorMessage: 'Closed: no payable rows left in batch' },
    });
    await prisma.payoutLedger.updateMany({
      where: { batchId: batch.id, status: { in: ['PENDING', 'FAILED'] } },
      data: { batchId: null },
    });
    return { batchId: batch.id, status: 'FAILED', skipped: true, reason: 'empty' };
  }

  const baseRef = sanitizePaystackTransferReference(`${BATCH_REF_PREFIX}${batch.id}`);
  // Paystack rejects reusing a reference after fail/reverse — append a retry suffix.
  const transferReference = batch.paystackTransferRef
    ? sanitizePaystackTransferReference(`${baseRef}-r${Date.now().toString(36)}`)
    : baseRef;
  const ledgerIds = batch.ledgers.map((r) => r.id);

  try {
    const transfer = await paystackFetch('/transfer', {
      method: 'POST',
      body: {
        source: 'balance',
        amount: amountKobo,
        recipient: paystackRecipientCode,
        reason: batchTransferReason(ledgerIds.length),
        reference: transferReference,
      },
    });
    const ref = transfer?.data?.reference || transferReference;
    await prisma.payoutBatch.update({
      where: { id: batch.id },
      data: { status: 'PROCESSING', totalAmount: total, paystackTransferRef: ref, errorMessage: null },
    });
    await prisma.payoutLedger.updateMany({
      where: { id: { in: ledgerIds } },
      data: { status: 'PROCESSING', paystackTransferRef: ref, errorMessage: null },
    });
    return { batchId: batch.id, status: 'PROCESSING', total, rows: ledgerIds.length, transferRef: ref };
  } catch (e) {
    const msg = (e?.message || String(e)).slice(0, 2000);
    await prisma.payoutBatch.update({
      where: { id: batch.id },
      data: { status: 'FAILED', totalAmount: total, paystackTransferRef: transferReference, errorMessage: msg },
    });
    await prisma.payoutLedger.updateMany({
      where: { id: { in: ledgerIds } },
      data: { status: 'PENDING', errorMessage: msg },
    });
    logger.error('paystack batch transfer failed (rows left PENDING for retry)', {
      batchId: batch.id,
      total,
      err: msg,
    });
    return { batchId: batch.id, status: 'FAILED', total, rows: ledgerIds.length, error: msg };
  }
}

/**
 * Weekly payout run (Monday cron): group unbatched PENDING recipient rows and send
 * one transfer per venue/user whose total is at least PAYOUT_MIN_ZAR. Smaller totals carry over.
 */
export async function runWeeklyPayoutBatches({ minZar = PAYOUT_MIN_ZAR, limit = 5000 } = {}) {
  await requeueRetryableFailedPayouts({ limit: 500 });

  const rows = await prisma.payoutLedger.findMany({
    where: {
      status: 'PENDING',
      batchId: null,
      recipientType: { in: ['USER', 'VENUE'] },
      recipientAmount: { gt: 0 },
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(limit, 10000),
    select: {
      id: true,
      recipientType: true,
      recipientUserId: true,
      recipientVenueId: true,
      recipientAmount: true,
    },
  });

  const { eligible, carriedOver } = groupPayoutRowsByRecipient(rows, minZar);
  const summary = {
    scannedRows: rows.length,
    recipients: eligible.length + carriedOver.length,
    carriedOver: carriedOver.length,
    batched: 0,
    transferred: 0,
    failed: 0,
    missingRecipient: 0,
    totalSentZar: 0,
    batches: [],
  };

  for (const group of eligible) {
    try {
      const code = await resolveRecipientCodeForGroup(group);
      if (!code) {
        summary.missingRecipient += 1;
        await prisma.payoutLedger.updateMany({
          where: { id: { in: group.rowIds }, batchId: null, status: 'PENDING' },
          data: { errorMessage: MISSING_RECIPIENT_MESSAGE },
        });
        continue;
      }

      const batch = await prisma.payoutBatch.create({
        data: {
          recipientType: group.recipientType,
          recipientUserId: group.recipientUserId,
          recipientVenueId: group.recipientVenueId,
          totalAmount: group.total,
          status: 'PROCESSING',
        },
      });
      // Claim rows atomically so overlapping runs never double-pay a sale.
      const claimed = await prisma.payoutLedger.updateMany({
        where: { id: { in: group.rowIds }, batchId: null, status: 'PENDING' },
        data: { batchId: batch.id },
      });
      if (claimed.count === 0) {
        await prisma.payoutBatch.delete({ where: { id: batch.id } }).catch(() => null);
        continue;
      }

      summary.batched += 1;
      const result = await sendBatchTransfer(batch.id, code);
      if (result.status === 'PROCESSING') {
        summary.transferred += 1;
        summary.totalSentZar = roundZar(summary.totalSentZar + (result.total || 0));
      } else {
        summary.failed += 1;
      }
      summary.batches.push({
        batchId: batch.id,
        recipientType: group.recipientType,
        status: result.status,
        total: result.total,
        rows: result.rows,
      });
    } catch (e) {
      summary.failed += 1;
      logger.error('runWeeklyPayoutBatches group failed', { key: group.key, err: e?.message });
    }
  }

  logger.info('weekly payout batches run', {
    scannedRows: summary.scannedRows,
    batched: summary.batched,
    transferred: summary.transferred,
    failed: summary.failed,
    carriedOver: summary.carriedOver,
    totalSentZar: summary.totalSentZar,
  });
  return summary;
}

/**
 * Daily cron: retry FAILED batches that still hold PENDING rows (e.g. Paystack balance
 * was short on Monday because weekend sales had not settled yet).
 */
export async function retryFailedPayoutBatches({ limit = 50 } = {}) {
  const batches = await prisma.payoutBatch.findMany({
    where: {
      status: 'FAILED',
      ledgers: { some: { status: { in: ['PENDING', 'FAILED'] } } },
    },
    orderBy: { updatedAt: 'asc' },
    take: Math.min(limit, 100),
    select: { id: true, recipientUserId: true, recipientVenueId: true },
  });

  let retried = 0;
  let failed = 0;
  let missingRecipient = 0;
  for (const b of batches) {
    try {
      const code = await resolveRecipientCodeForGroup(b);
      if (!code) {
        missingRecipient += 1;
        continue;
      }
      const result = await sendBatchTransfer(b.id, code);
      if (result.status === 'PROCESSING') retried += 1;
      else if (!result.skipped) failed += 1;
    } catch (e) {
      failed += 1;
      logger.error('retryFailedPayoutBatches batch failed', { batchId: b.id, err: e?.message });
    }
  }
  return { scanned: batches.length, retried, failed, missingRecipient };
}

/**
 * Re-queue a single PENDING/FAILED ledger row for the next weekly payout.
 * Kept for admin tooling; no longer sends a per-sale transfer.
 */
export async function retryPayoutLedgerTransfer(ledgerId) {
  const row = await prisma.payoutLedger.findUnique({ where: { id: ledgerId } });
  if (!row) return { skipped: true, reason: 'not_found' };
  if (!['PENDING', 'FAILED'].includes(row.status)) {
    return { status: row.status, ledgerId: row.id, skipped: true };
  }
  if (row.recipientType === 'PLATFORM' || Number(row.recipientAmount) <= 0) {
    return { status: row.status, ledgerId: row.id, skipped: true };
  }
  const code = await resolveRecipientCodeForGroup(row);
  await prisma.payoutLedger.update({
    where: { id: row.id },
    data: {
      status: 'PENDING',
      errorMessage: code ? null : MISSING_RECIPIENT_MESSAGE,
    },
  });
  return { status: 'PENDING', ledgerId: row.id, queued: true, reason: code ? 'next_payout' : 'no_recipient' };
}

async function verifyTransferStatus(ref) {
  const data = await paystackFetch(`/transfer/verify/${encodeURIComponent(ref)}`);
  return {
    status: String(data?.data?.status || '').toLowerCase(),
    payload: {
      reference: data?.data?.reference || ref,
      transfer_code: data?.data?.transfer_code,
      reason: data?.data?.reason || data?.message,
    },
  };
}

/**
 * Poll Paystack for PROCESSING transfers (webhook lag / missed transfer.success).
 * Covers weekly batches and legacy per-sale transfers.
 */
export async function syncProcessingPayoutTransfers({ limit = 30 } = {}) {
  const take = Math.min(limit, 50);
  const [batches, legacyRows] = await Promise.all([
    prisma.payoutBatch.findMany({
      where: { status: 'PROCESSING', paystackTransferRef: { not: null } },
      orderBy: { updatedAt: 'asc' },
      take,
    }),
    prisma.payoutLedger.findMany({
      where: { status: 'PROCESSING', batchId: null, paystackTransferRef: { not: null } },
      orderBy: { updatedAt: 'asc' },
      take,
    }),
  ]);

  let checked = 0;
  let transferred = 0;
  let requeued = 0;
  let pending = 0;
  const statuses = [];

  const targets = [
    ...batches.map((b) => ({ kind: 'batch', id: b.id, amount: b.totalAmount, ref: b.paystackTransferRef })),
    ...legacyRows.map((r) => ({ kind: 'ledger', id: r.id, amount: r.recipientAmount, ref: r.paystackTransferRef })),
  ];

  for (const t of targets) {
    const ref = String(t.ref || '').trim();
    if (!ref) continue;
    checked += 1;
    try {
      const { status, payload } = await verifyTransferStatus(ref);
      statuses.push({ kind: t.kind, id: t.id, amount: t.amount, status, ref: ref.slice(0, 24) });
      if (status === 'success') {
        await applyTransferWebhookEvent('transfer.success', payload);
        transferred += 1;
      } else if (status === 'failed' || status === 'reversed' || status === 'abandoned') {
        await applyTransferWebhookEvent(
          status === 'reversed' ? 'transfer.reversed' : 'transfer.failed',
          { ...payload, reason: payload.reason || status },
        );
        requeued += 1;
      } else {
        // otp, pending, receiving, etc. — leave PROCESSING
        pending += 1;
      }
    } catch (e) {
      logger.warn('syncProcessingPayoutTransfers verify failed', { kind: t.kind, id: t.id, ref, err: e?.message });
      statuses.push({ kind: t.kind, id: t.id, amount: t.amount, status: 'verify_error', err: e?.message });
      pending += 1;
    }
  }

  return { checked, transferred, requeued, pending, statuses };
}

async function applyBatchTransferEvent(event, batch, transferRefStr, data) {
  if (event === 'transfer.success') {
    await prisma.payoutBatch.update({
      where: { id: batch.id },
      data: {
        status: 'TRANSFERRED',
        paystackTransferRef: transferRefStr || batch.paystackTransferRef,
        errorMessage: null,
      },
    });
    await prisma.payoutLedger.updateMany({
      where: { batchId: batch.id, status: { in: ['PROCESSING', 'PENDING', 'FAILED'] } },
      data: { status: 'TRANSFERRED', errorMessage: null },
    });
    return { matched: true, batchId: batch.id, status: 'TRANSFERRED' };
  }

  if (event === 'transfer.failed' || event === 'transfer.reversed') {
    const msg = (data?.reason || data?.message || event).toString().slice(0, 2000);
    await prisma.payoutBatch.update({
      where: { id: batch.id },
      data: {
        status: 'FAILED',
        paystackTransferRef: transferRefStr || batch.paystackTransferRef,
        errorMessage: msg,
      },
    });
    await prisma.payoutLedger.updateMany({
      where: { batchId: batch.id, status: 'PROCESSING' },
      data: { status: 'PENDING', errorMessage: msg },
    });
    return { matched: true, batchId: batch.id, status: 'FAILED' };
  }

  return { matched: true, batchId: batch.id, status: batch.status };
}

/**
 * Apply transfer webhook events to payout batches (weekly) or legacy per-sale ledger rows.
 */
export async function applyTransferWebhookEvent(event, data) {
  const transferRef =
    data?.reference ||
    data?.transfer_code ||
    data?.transfer_reference ||
    null;
  const transferRefStr = typeof transferRef === 'string' ? transferRef : null;

  if (transferRefStr) {
    const batchIdHint = batchIdFromTransferRef(transferRefStr);
    const batch = await prisma.payoutBatch.findFirst({
      where: {
        OR: [
          { paystackTransferRef: transferRefStr },
          ...(batchIdHint ? [{ id: batchIdHint }] : []),
        ],
      },
    });
    if (batch) return applyBatchTransferEvent(event, batch, transferRefStr, data);
  }

  const payoutIdx = transferRefStr ? transferRefStr.lastIndexOf('-payout-') : -1;
  const ledgerIdHint = payoutIdx >= 0 ? transferRefStr.slice(payoutIdx + '-payout-'.length) : null;
  const paymentHint = payoutIdx > 0 ? transferRefStr.slice(0, payoutIdx) : null;

  let row = null;
  if (transferRefStr) {
    row = await prisma.payoutLedger.findFirst({
      where: {
        batchId: null,
        OR: [
          { paystackTransferRef: transferRefStr },
          ...(ledgerIdHint ? [{ id: ledgerIdHint }] : []),
          ...(paymentHint ? [{ paymentReference: paymentHint }] : []),
        ],
      },
    });
  }
  if (!row && paymentHint) {
    // Sanitized refs replace ":" with "-" (e.g. ref:menu → ref-menu)
    row = await prisma.payoutLedger.findFirst({
      where: {
        batchId: null,
        OR: [
          { paymentReference: paymentHint },
          { paymentReference: paymentHint.replace(/-/g, ':') },
        ],
      },
    });
  }
  if (!row) {
    logger.warn('transfer webhook: ledger not found', { event, transferRef });
    return { matched: false };
  }
  if (row.status === 'REFUNDED_MANUAL') {
    return { matched: true, ledgerId: row.id, status: row.status, skipped: true };
  }

  if (event === 'transfer.success') {
    await prisma.payoutLedger.update({
      where: { id: row.id },
      data: {
        status: 'TRANSFERRED',
        paystackTransferRef: transferRefStr || row.paystackTransferRef,
        errorMessage: null,
      },
    });
    return { matched: true, ledgerId: row.id, status: 'TRANSFERRED' };
  }

  if (event === 'transfer.failed' || event === 'transfer.reversed') {
    // Back to PENDING so the amount joins the next weekly batch.
    await prisma.payoutLedger.update({
      where: { id: row.id },
      data: {
        status: 'PENDING',
        paystackTransferRef: transferRefStr || row.paystackTransferRef,
        errorMessage: (data?.reason || data?.message || event).toString().slice(0, 2000),
      },
    });
    return { matched: true, ledgerId: row.id, status: 'PENDING' };
  }

  return { matched: true, ledgerId: row.id, status: row.status };
}

/**
 * Mark ledgers for a payment as manually refunded (no Paystack clawback).
 * The SEC service fee row stays — it is only returned when an event is cancelled (handled by support).
 */
export async function markPayoutsRefundedManual(paymentReference) {
  const refs = [
    paymentReference,
    `${paymentReference}:join`,
    `${paymentReference}:menu`,
  ];
  const result = await prisma.payoutLedger.updateMany({
    where: {
      OR: [
        { paymentReference: { in: refs } },
        { paymentReference: { startsWith: `${paymentReference}:` } },
      ],
      NOT: { paymentReference: `${paymentReference}:service_fee` },
      status: { not: 'REFUNDED_MANUAL' },
    },
    data: {
      status: 'REFUNDED_MANUAL',
      errorMessage: 'Marked after venue-approved manual guest refund (no Paystack clawback).',
    },
  });
  return result;
}

const RETRYABLE_FAILED_ERROR_PATTERNS = [
  /balance is not enough/i,
  /illegal special characters/i,
  /insufficient/i,
  /try again/i,
  /timeout/i,
  /temporar/i,
  /rate limit/i,
  /transfer\.failed/i,
  /transfer\.reversed/i,
  // Small sales are now combined into a weekly batch, so per-sale minimums no longer apply.
  /below minimum transfer/i,
];

function isRetryableFailedPayoutError(message) {
  const msg = String(message || '');
  if (!msg) return true; // legacy FAILED with no message — allow retry
  return RETRYABLE_FAILED_ERROR_PATTERNS.some((re) => re.test(msg));
}

/**
 * Flip legacy FAILED rows back to PENDING so they join the next weekly batch.
 */
export async function requeueRetryableFailedPayouts({ limit = 200, where: extraWhere = {} } = {}) {
  const rows = await prisma.payoutLedger.findMany({
    where: {
      status: 'FAILED',
      batchId: null,
      recipientType: { in: ['USER', 'VENUE'] },
      recipientAmount: { gt: 0 },
      ...extraWhere,
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(limit, 500),
    select: { id: true, errorMessage: true },
  });

  let requeued = 0;
  for (const row of rows) {
    if (!isRetryableFailedPayoutError(row.errorMessage)) continue;
    await prisma.payoutLedger.update({
      where: { id: row.id },
      data: {
        status: 'PENDING',
        errorMessage: row.errorMessage
          ? `Requeued for next payout: ${row.errorMessage}`.slice(0, 2000)
          : 'Requeued for next payout',
      },
    });
    requeued += 1;
  }
  return { scanned: rows.length, requeued };
}

/**
 * Cron/admin/wallet-setup: tidy PENDING/FAILED payouts so they are ready for the next
 * weekly batch (requeue retryable FAILED rows, clear "missing recipient" once a wallet exists).
 * Does not send transfers — runWeeklyPayoutBatches does that on Mondays.
 */
export async function retryStuckPayouts({
  limit = 50,
  recipientUserId = null,
  recipientVenueId = null,
  includeOwnerVenueFallback = false,
  requeueFailed = true,
} = {}) {
  const scope = {};
  if (recipientVenueId) {
    scope.recipientVenueId = String(recipientVenueId);
  } else if (recipientUserId) {
    const userId = String(recipientUserId);
    if (includeOwnerVenueFallback) {
      const ownedVenues = await prisma.venue.findMany({
        where: {
          ownerUserId: userId,
          deletedAt: null,
          OR: [{ paystackRecipientCode: null }, { paystackRecipientCode: '' }],
        },
        select: { id: true },
      });
      const venueIds = ownedVenues.map((v) => v.id);
      if (venueIds.length) {
        scope.OR = [{ recipientUserId: userId }, { recipientVenueId: { in: venueIds } }];
      } else {
        scope.recipientUserId = userId;
      }
    } else {
      scope.recipientUserId = userId;
    }
  }

  const requeue = requeueFailed
    ? await requeueRetryableFailedPayouts({ limit: Math.min(limit * 4, 200), where: scope })
    : { scanned: 0, requeued: 0 };

  const rows = await prisma.payoutLedger.findMany({
    where: {
      status: 'PENDING',
      batchId: null,
      recipientType: { in: ['USER', 'VENUE'] },
      recipientAmount: { gt: 0 },
      ...scope,
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(limit, 200),
    select: { id: true, recipientUserId: true, recipientVenueId: true, errorMessage: true },
  });

  let readyForNextPayout = 0;
  let missingRecipient = 0;
  const codeCache = new Map();
  for (const row of rows) {
    const key = row.recipientVenueId ? `V:${row.recipientVenueId}` : `U:${row.recipientUserId}`;
    if (!codeCache.has(key)) codeCache.set(key, await resolveRecipientCodeForGroup(row));
    const code = codeCache.get(key);
    if (!code) {
      missingRecipient += 1;
      continue;
    }
    readyForNextPayout += 1;
    if (row.errorMessage && /missing paystack recipient/i.test(row.errorMessage)) {
      await prisma.payoutLedger.update({ where: { id: row.id }, data: { errorMessage: null } });
    }
  }

  return {
    scanned: rows.length,
    retried: 0,
    skipped: missingRecipient,
    failed: 0,
    readyForNextPayout,
    missingRecipient,
    requeue,
  };
}

export async function resolveRecipientCodeForUser(userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { paystackRecipientCode: true },
  });
  return u?.paystackRecipientCode || null;
}

/** Venue payouts use that venue's Sec Wallet only — never the owner's personal recipient. */
export async function resolveRecipientCodeForVenue(venueId) {
  const v = await prisma.venue.findFirst({
    where: { id: venueId, deletedAt: null },
    select: { paystackRecipientCode: true },
  });
  const code = v?.paystackRecipientCode && String(v.paystackRecipientCode).trim();
  return code || null;
}

function flattenPaymentMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const nested = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
  return { ...nested, ...value };
}

/**
 * Idempotently record venue-table payout ledger (SEC 15% + venue 85%) when missing.
 */
export async function ensureVenueTablePayoutLedger({ reference, amountZar, venueId }) {
  const gross = Number(amountZar) || 0;
  if (!reference || gross <= 0 || !venueId) {
    return { skipped: true, reason: 'invalid_input' };
  }

  const existing = await prisma.payoutLedger.findUnique({ where: { paymentReference: reference } });
  if (existing) {
    return { skipped: true, status: existing.status, ledgerId: existing.id };
  }

  const { secAmount, recipientAmount } = splitPlatformGross(gross);
  const venueCode = await resolveRecipientCodeForVenue(venueId);
  const result = await recordPayoutAndMaybeTransfer({
    paymentReference: reference,
    grossZar: gross,
    secAmount,
    recipientAmount,
    recipientType: 'VENUE',
    recipientVenueId: venueId,
    recipientUserId: null,
    paystackRecipientCode: venueCode,
  });
  return { skipped: false, ...result };
}

/**
 * Backfill missing payout ledgers for successful venue table checkouts.
 */
export async function repairMissingVenueTablePayouts({ sinceDays = 60, limit = 80 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000);
  const payments = await prisma.payment.findMany({
    where: { status: 'success', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit * 3, 500),
    select: { reference: true, amount: true, metadata: true },
  });

  const tableTypes = new Set(['TABLE_CHECKOUT', 'VENUE_TABLE_JOIN']);
  let repaired = 0;
  let skipped = 0;

  for (const pay of payments) {
    if (repaired + skipped >= limit) break;
    const meta = flattenPaymentMetadata(pay.metadata);
    if (!tableTypes.has(String(meta.type || ''))) continue;

    const venueId = meta.venue_id ?? meta.venueId;
    const memberId = meta.venueTableMemberId ?? meta.venue_table_member_id;
    if (!venueId || !memberId) continue;

    const ledger = await prisma.payoutLedger.findUnique({ where: { paymentReference: pay.reference } });
    if (ledger) {
      skipped += 1;
      continue;
    }

    const member = await prisma.venueTableMember.findUnique({
      where: { id: String(memberId) },
      select: { status: true },
    });
    if (member?.status !== 'CONFIRMED') continue;

    const result = await ensureVenueTablePayoutLedger({
      reference: pay.reference,
      amountZar: netOfServiceFee(meta, pay.amount),
      venueId: String(venueId),
    });
    if (!result.skipped) repaired += 1;
    else skipped += 1;
  }

  return { repaired, skipped, scanned: payments.length };
}

/**
 * Backfill missing host join-fee payout ledgers for successful HOSTED_TABLE_JOIN payments.
 */
export async function repairMissingHostedTableJoinPayouts({ sinceDays = 90, limit = 100 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000);
  const payments = await prisma.payment.findMany({
    where: { status: 'success', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit * 5, 800),
    select: { reference: true, amount: true, metadata: true },
  });

  let repaired = 0;
  let skipped = 0;

  for (const pay of payments) {
    if (repaired + skipped >= limit) break;
    const meta = flattenPaymentMetadata(pay.metadata);
    if (String(meta.type || '') !== 'HOSTED_TABLE_JOIN') continue;

    const joinZar = Number(meta.join_zar ?? meta.joinZar ?? 0) || 0;
    if (joinZar <= 0) {
      skipped += 1;
      continue;
    }

    const joinRef = `${pay.reference}:join`;
    const ledger = await prisma.payoutLedger.findUnique({ where: { paymentReference: joinRef } });
    if (ledger) {
      skipped += 1;
      continue;
    }

    const hostedTableId = meta.hosted_table_id ?? meta.hostedTableId;
    if (!hostedTableId) continue;

    const ht = await prisma.hostedTable.findUnique({
      where: { id: String(hostedTableId) },
      select: { hostUserId: true },
    });
    if (!ht?.hostUserId) continue;

    const hostCode = await resolveRecipientCodeForUser(ht.hostUserId);
    const { secAmount, recipientAmount } = splitPlatformGross(joinZar);
    const result = await recordPayoutAndMaybeTransfer({
      paymentReference: joinRef,
      grossZar: joinZar,
      secAmount,
      recipientAmount,
      recipientType: 'USER',
      recipientUserId: ht.hostUserId,
      recipientVenueId: null,
      paystackRecipientCode: hostCode,
    });
    if (!result.skipped) repaired += 1;
    else skipped += 1;
  }

  return { repaired, skipped, scanned: payments.length };
}
