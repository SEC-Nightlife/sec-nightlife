import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken } from '../middleware/auth.js';
import {
  ensureSecWallet,
  aggregateWalletSummary,
  maskAccountNumber,
} from '../lib/secWallet.js';

const router = Router();

const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many wallet lookups. Try again later.' },
});

function requirePaystackKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    const err = new Error('Paystack is not configured');
    err.status = 500;
    throw err;
  }
  return key;
}

async function paystackFetch(path) {
  const key = requirePaystackKey();
  const res = await fetch(`https://api.paystack.co${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.status) {
    const err = new Error(data?.message || 'Paystack request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

async function fetchPayoutDetailsFromPaystack(recipientCode) {
  const resp = await paystackFetch(`/transferrecipient/${encodeURIComponent(recipientCode)}`);
  const d = resp?.data || {};
  const details = d.details || {};
  return {
    account_name: d.name || details.account_name || null,
    account_number: details.account_number || null,
    bank_code: details.bank_code || null,
    bank_name: details.bank_name || null,
    currency: d.currency || 'ZAR',
  };
}

async function assertVenueOwner(venueId, userId) {
  const venue = await prisma.venue.findFirst({
    where: { id: venueId, deletedAt: null },
    select: { id: true, ownerUserId: true },
  });
  if (!venue) {
    const err = new Error('Venue not found');
    err.status = 404;
    throw err;
  }
  if (venue.ownerUserId !== userId) {
    const err = new Error('Not authorized for this venue');
    err.status = 403;
    throw err;
  }
  return venue;
}

/** GET /api/wallet/me — party goer wallet */
router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    const wallet = await ensureSecWallet('USER', req.userId);
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        paystackRecipientCode: true,
        userProfile: { select: { paymentSetupComplete: true } },
      },
    });
    const summary = await aggregateWalletSummary({ userId: req.userId });
    const payoutComplete = Boolean(user?.paystackRecipientCode);

    res.json({
      walletCode: wallet.walletCode,
      shareable: true,
      ownerType: 'USER',
      payoutSetupComplete: payoutComplete,
      pendingBalance: summary.pendingBalance,
      totalReceived: summary.totalReceived,
      transactions: summary.transactions,
      payoutSchedule: summary.payoutSchedule,
      payoutMinimumZar: summary.payoutMinimumZar,
      nextPayoutDate: summary.nextPayoutDate,
      queuedForNextPayout: summary.queuedForNextPayout,
      meetsPayoutMinimum: summary.meetsPayoutMinimum,
      inTransit: summary.inTransit,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/wallet/venue/:venueId */
router.get('/venue/:venueId', authenticateToken, async (req, res, next) => {
  try {
    const venueId = z.string().uuid().parse(req.params.venueId);
    await assertVenueOwner(venueId, req.userId);
    const wallet = await ensureSecWallet('VENUE', venueId);
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { paystackRecipientCode: true, name: true },
    });
    const summary = await aggregateWalletSummary({
      venueId,
      // Show recent earnings with status (not only last 24h)
      transactionsSince: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      transactionLimit: 40,
    });
    const payoutComplete = Boolean(venue?.paystackRecipientCode);

    res.json({
      walletCode: wallet.walletCode,
      shareable: false,
      ownerType: 'VENUE',
      venueName: venue?.name || null,
      payoutSetupComplete: payoutComplete,
      pendingBalance: summary.pendingBalance,
      totalReceived: summary.totalReceived,
      transactions: summary.transactions,
      payoutSchedule: summary.payoutSchedule,
      payoutMinimumZar: summary.payoutMinimumZar,
      nextPayoutDate: summary.nextPayoutDate,
      queuedForNextPayout: summary.queuedForNextPayout,
      meetsPayoutMinimum: summary.meetsPayoutMinimum,
      inTransit: summary.inTransit,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid venue id' });
    next(err);
  }
});

/** POST /api/wallet/lookup — venue looks up user payout details by wallet code */
router.post('/lookup', authenticateToken, lookupLimiter, async (req, res, next) => {
  try {
    const body = z
      .object({
        wallet_code: z.string().min(6).max(40),
        venue_id: z.string().uuid(),
      })
      .parse(req.body ?? {});

    await assertVenueOwner(body.venue_id, req.userId);

    const targetWallet = await prisma.secWallet.findUnique({
      where: { walletCode: body.wallet_code.trim().toUpperCase() },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            username: true,
            paystackRecipientCode: true,
            userProfile: { select: { paymentSetupComplete: true, avatarUrl: true } },
          },
        },
      },
    });

    if (!targetWallet || targetWallet.ownerType !== 'USER' || !targetWallet.userId) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const targetUser = targetWallet.user;
    if (!targetUser?.paystackRecipientCode || !targetUser?.userProfile?.paymentSetupComplete) {
      return res.status(400).json({
        error: 'This user has not completed payout setup yet. Ask them to set up their Sec Wallet payout details first.',
      });
    }

    const payout = await fetchPayoutDetailsFromPaystack(targetUser.paystackRecipientCode);

    await prisma.walletLookupLog.create({
      data: {
        venueId: body.venue_id,
        targetUserId: targetUser.id,
        lookedUpById: req.userId,
      },
    });

    res.json({
      walletCode: targetWallet.walletCode,
      user: {
        id: targetUser.id,
        fullName: targetUser.fullName,
        username: targetUser.username,
        avatarUrl: targetUser.userProfile?.avatarUrl || null,
      },
      payout: {
        account_name: payout.account_name,
        account_number_masked: maskAccountNumber(payout.account_number),
        bank_code: payout.bank_code,
        bank_name: payout.bank_name,
        currency: payout.currency,
      },
      targetWalletId: targetWallet.id,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    next(err);
  }
});

/** POST /api/wallet/lookup/reveal — explicit reveal of full account number for refund payout */
router.post('/lookup/reveal', authenticateToken, lookupLimiter, async (req, res, next) => {
  try {
    const body = z
      .object({
        wallet_code: z.string().min(6).max(40),
        venue_id: z.string().uuid(),
      })
      .parse(req.body ?? {});

    await assertVenueOwner(body.venue_id, req.userId);

    const targetWallet = await prisma.secWallet.findUnique({
      where: { walletCode: body.wallet_code.trim().toUpperCase() },
      include: {
        user: {
          select: {
            id: true,
            paystackRecipientCode: true,
            userProfile: { select: { paymentSetupComplete: true } },
          },
        },
      },
    });

    if (!targetWallet || targetWallet.ownerType !== 'USER' || !targetWallet.userId) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const targetUser = targetWallet.user;
    if (!targetUser?.paystackRecipientCode || !targetUser?.userProfile?.paymentSetupComplete) {
      return res.status(400).json({
        error: 'This user has not completed payout setup yet.',
      });
    }

    const payout = await fetchPayoutDetailsFromPaystack(targetUser.paystackRecipientCode);

    await prisma.walletLookupLog.create({
      data: {
        venueId: body.venue_id,
        targetUserId: targetUser.id,
        lookedUpById: req.userId,
      },
    });

    res.json({
      account_number: payout.account_number,
      account_number_masked: maskAccountNumber(payout.account_number),
      account_name: payout.account_name,
      bank_code: payout.bank_code,
      bank_name: payout.bank_name,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    next(err);
  }
});

/** GET /api/wallet/venue/:venueId/recipients */
router.get('/venue/:venueId/recipients', authenticateToken, async (req, res, next) => {
  try {
    const venueId = z.string().uuid().parse(req.params.venueId);
    await assertVenueOwner(venueId, req.userId);

    const rows = await prisma.walletRecipient.findMany({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
      include: {
        targetWallet: {
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                username: true,
                paystackRecipientCode: true,
                userProfile: { select: { paymentSetupComplete: true, avatarUrl: true } },
              },
            },
          },
        },
      },
    });

    const recipients = [];
    for (const row of rows) {
      const u = row.targetWallet?.user;
      let payout = null;
      if (u?.paystackRecipientCode && u?.userProfile?.paymentSetupComplete) {
        try {
          const p = await fetchPayoutDetailsFromPaystack(u.paystackRecipientCode);
          payout = {
            account_name: p.account_name,
            account_number_masked: maskAccountNumber(p.account_number),
            bank_code: p.bank_code,
            bank_name: p.bank_name,
          };
        } catch {
          payout = null;
        }
      }
      recipients.push({
        id: row.id,
        label: row.label,
        walletCode: row.targetWallet?.walletCode,
        createdAt: row.createdAt,
        user: u
          ? {
              id: u.id,
              fullName: u.fullName,
              username: u.username,
              avatarUrl: u.userProfile?.avatarUrl || null,
            }
          : null,
        payout,
        payoutSetupComplete: Boolean(u?.userProfile?.paymentSetupComplete && u?.paystackRecipientCode),
      });
    }

    res.json({ recipients });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid venue id' });
    next(err);
  }
});

/** POST /api/wallet/venue/:venueId/recipients */
router.post('/venue/:venueId/recipients', authenticateToken, async (req, res, next) => {
  try {
    const venueId = z.string().uuid().parse(req.params.venueId);
    const body = z
      .object({
        target_wallet_id: z.string().min(1),
        label: z.string().max(80).optional().nullable(),
      })
      .parse(req.body ?? {});

    await assertVenueOwner(venueId, req.userId);

    const targetWallet = await prisma.secWallet.findFirst({
      where: { id: body.target_wallet_id, ownerType: 'USER' },
    });
    if (!targetWallet) return res.status(404).json({ error: 'User wallet not found' });

    const row = await prisma.walletRecipient.upsert({
      where: {
        venueId_targetWalletId: { venueId, targetWalletId: targetWallet.id },
      },
      create: {
        venueId,
        targetWalletId: targetWallet.id,
        label: body.label || null,
      },
      update: { label: body.label || null },
    });

    res.status(201).json({ id: row.id, success: true });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    next(err);
  }
});

/** DELETE /api/wallet/venue/:venueId/recipients/:recipientId */
router.delete('/venue/:venueId/recipients/:recipientId', authenticateToken, async (req, res, next) => {
  try {
    const venueId = z.string().uuid().parse(req.params.venueId);
    const recipientId = z.string().min(1).parse(req.params.recipientId);
    await assertVenueOwner(venueId, req.userId);

    const row = await prisma.walletRecipient.findFirst({
      where: { id: recipientId, venueId },
    });
    if (!row) return res.status(404).json({ error: 'Recipient not found' });

    await prisma.walletRecipient.delete({ where: { id: recipientId } });
    res.json({ success: true });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    next(err);
  }
});

export default router;
