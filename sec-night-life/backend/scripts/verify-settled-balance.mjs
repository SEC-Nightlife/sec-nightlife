/**
 * Ops: after Paystack Available is funded (Topup or Settled-to-Balance settlement),
 * retry stuck venue/host payouts and print ledger status.
 *
 * Usage (from backend/):
 *   CRON_SECRET=… DATABASE_URL=… node scripts/verify-settled-balance.mjs
 *   API_URL=https://api.secnightlife.com CRON_SECRET=… node scripts/verify-settled-balance.mjs
 *
 * Never commit secrets. Prefer: vercel env pull then source, or Neon MCP for ledger reads.
 */
import 'dotenv/config';

const API_URL = (process.env.API_URL || 'https://api.secnightlife.com').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET?.trim();

async function retryPayouts() {
  if (!CRON_SECRET) {
    console.error('CRON_SECRET is required');
    process.exit(1);
  }
  const res = await fetch(`${API_URL}/api/cron/retry-payouts`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  const body = await res.json().catch(() => ({}));
  console.log('retry-payouts HTTP', res.status, JSON.stringify(body));
  if (!res.ok) process.exit(1);
  return body;
}

async function ledgerSummary() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.log('DATABASE_URL not set — skip ledger summary (use Neon or Prisma Studio)');
    return null;
  }
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.payoutLedger.groupBy({
      by: ['status'],
      _count: { _all: true },
      _sum: { recipientAmount: true },
    });
    console.log('ledger_by_status:');
    for (const r of rows.sort((a, b) => b._count._all - a._count._all)) {
      const sum = r._sum.recipientAmount ?? 0;
      console.log(`  ${r.status}\tcount=${r._count._all}\tsum_zar=${Number(sum).toFixed(2)}`);
    }
    const recent = await prisma.payoutLedger.findMany({
      where: { status: { in: ['PROCESSING', 'TRANSFERRED'] } },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        status: true,
        recipientAmount: true,
        paystackTransferRef: true,
        updatedAt: true,
        recipientVenueId: true,
      },
    });
    console.log('recent_processing_or_transferred:', recent.length);
    for (const r of recent) {
      console.log(
        `  ${r.status} R${Number(r.recipientAmount).toFixed(2)} ref=${r.paystackTransferRef || '—'} ${r.updatedAt.toISOString()}`
      );
    }
    return { rows, recent };
  } finally {
    await prisma.$disconnect();
  }
}

const cronResult = await retryPayouts();
const summary = await ledgerSummary();

const transferred =
  summary?.rows?.find((r) => r.status === 'TRANSFERRED')?._count?._all ?? 0;
const processing =
  summary?.rows?.find((r) => r.status === 'PROCESSING')?._count?._all ?? 0;

if (transferred > 0 || processing > 0) {
  console.log('OK: at least one payout is PROCESSING or TRANSFERRED');
  process.exit(0);
}

console.log(
  'NOTE: still no PROCESSING/TRANSFERRED. If Available is R0, Topup R20–R50 or wait for Settled-to-Balance settlement, then re-run.'
);
// Non-zero so CI/ops notices; cron itself may still be healthy
process.exit(cronResult?.failed > 0 ? 2 : 0);
