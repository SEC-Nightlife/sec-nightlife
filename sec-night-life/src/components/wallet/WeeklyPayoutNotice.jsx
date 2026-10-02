import React from 'react';
import { CalendarClock } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { PAYOUT_MIN_ZAR, nextPayoutDate as fallbackNextPayoutDate } from '@/lib/payoutSchedule';

function formatZar(n) {
  return `R ${Number(n || 0).toFixed(2)}`;
}

/**
 * Weekly batched payout explainer for Sec Wallet (users/hosts) and venue wallets.
 * Pass wallet API fields when available; falls back to the client-side schedule.
 */
export default function WeeklyPayoutNotice({
  nextPayoutDate,
  payoutMinimumZar,
  queuedForNextPayout,
  compact = false,
  className = '',
}) {
  const min = Number(payoutMinimumZar) || PAYOUT_MIN_ZAR;
  let next = null;
  try {
    next = nextPayoutDate ? parseISO(nextPayoutDate) : fallbackNextPayoutDate();
  } catch {
    next = fallbackNextPayoutDate();
  }
  const nextLabel = next ? format(next, 'EEE d MMM') : 'Monday';
  const queued = queuedForNextPayout != null ? Number(queuedForNextPayout) || 0 : null;
  const belowMin = queued != null && queued > 0 && queued < min;

  if (compact) {
    return (
      <p className={`text-[11px] text-gray-500 leading-relaxed ${className}`}>
        Earnings are paid out weekly, every Monday, once your balance is at least {formatZar(min)}.
        Smaller balances roll over to the next week.
      </p>
    );
  }

  return (
    <div
      className={`flex gap-3 rounded-xl px-3 py-3 text-sm border border-[#262629] bg-[#141416] ${className}`}
    >
      <CalendarClock className="w-5 h-5 shrink-0 mt-0.5 text-[var(--sec-accent)]" />
      <div className="space-y-1 min-w-0">
        <p className="font-semibold text-white">Weekly payouts · next on {nextLabel}</p>
        <p className="text-xs text-gray-400 leading-relaxed">
          SEC combines your earnings into one bank transfer every Monday once your balance is at least{' '}
          {formatZar(min)}. Smaller balances roll over to the next week — nothing is lost.
        </p>
        {queued != null && queued > 0 ? (
          <p className="text-xs text-gray-400">
            Queued for next payout:{' '}
            <span className="font-semibold text-white">{formatZar(queued)}</span>
            {belowMin ? ` (below ${formatZar(min)} — rolls over)` : ''}
          </p>
        ) : null}
      </div>
    </div>
  );
}
