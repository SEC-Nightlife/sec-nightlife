import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/api/client';
import { format, parseISO } from 'date-fns';
import { Wallet, Copy, AlertCircle, ArrowDownLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { UserPayoutSetup } from './WalletPayoutSetup';
import WeeklyPayoutNotice from './WeeklyPayoutNotice';
import { formatZar as formatRand } from '@/lib/money';

const formatZar = (n) => formatRand(n, { cents: true });

export default function UserSecWallet({ userProfile, onProfileUpdated }) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['sec-wallet-me'],
    queryFn: () => apiGet('/api/wallet/me'),
  });

  const copyWalletId = async () => {
    if (!data?.walletCode) return;
    try {
      await navigator.clipboard.writeText(data.walletCode);
      toast.success('Sec Wallet ID copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--sec-accent)]" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        className="relative overflow-hidden rounded-2xl p-5 border border-[#262629]"
        style={{
          background: 'linear-gradient(135deg, var(--sec-accent-muted) 0%, rgba(10,10,11,1) 55%)',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[var(--sec-accent)] mb-1">
              <Wallet className="w-5 h-5" />
              <span className="text-xs font-semibold uppercase tracking-wider">Sec Wallet</span>
            </div>
            <p className="text-2xl font-bold text-white tracking-wide">{data?.walletCode || '—'}</p>
            <p className="text-xs text-gray-500 mt-1">Share this ID with venues so they can pay you off-app</p>
          </div>
          <button
            type="button"
            onClick={copyWalletId}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#1a1a1d] border border-[#262629] text-sm text-white hover:border-[var(--sec-accent)]/40"
          >
            <Copy className="w-4 h-4" />
            Copy ID
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-5">
          <div className="rounded-xl bg-black/30 p-3 border border-[#262629]/80">
            <p className="text-xs text-gray-500">Pending balance</p>
            <p className="text-lg font-bold" style={{ color: 'var(--sec-accent-bright)' }}>{formatZar(data?.pendingBalance)}</p>
          </div>
          <div className="rounded-xl bg-black/30 p-3 border border-[#262629]/80">
            <p className="text-xs text-gray-500">Total received</p>
            <p className="text-lg font-bold text-green-400">{formatZar(data?.totalReceived)}</p>
          </div>
        </div>
        <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
          Pending is money owed to you that will be included in the next weekly payout. Received means the bank
          transfer was sent. Your bank may take 1–2 business days to show the credit (longer on weekends or public holidays).
          Match amounts here with your bank statement — look for SEC Nightlife on the transfer description when available.
        </p>
      </div>

      <WeeklyPayoutNotice
        nextPayoutDate={data?.nextPayoutDate}
        payoutMinimumZar={data?.payoutMinimumZar}
        queuedForNextPayout={data?.queuedForNextPayout}
      />

      {!data?.payoutSetupComplete && (
        <div
          className="flex gap-2 rounded-xl px-3 py-3 text-sm"
          style={{
            border: '1px solid var(--sec-accent-border)',
            background: 'var(--sec-accent-muted)',
            color: 'var(--sec-text-primary)',
          }}
        >
          <AlertCircle className="w-5 h-5 shrink-0" style={{ color: 'var(--sec-accent-bright)' }} />
          <p>
            Set up your payout details below so your earnings from tables and tickets can be included in the
            weekly Monday payout. Until then, pending amounts stay in your Sec Wallet.
          </p>
        </div>
      )}

      <div>
        <h4 className="text-sm font-semibold text-gray-400 mb-2">Payout details</h4>
        <UserPayoutSetup
          profile={{
            ...userProfile,
            payment_setup_complete:
              Boolean(userProfile?.payment_setup_complete) || Boolean(data?.payoutSetupComplete),
          }}
          onProfileUpdated={(patch) => {
            onProfileUpdated?.(patch);
            refetch();
          }}
        />
      </div>

      <div>
        <h4 className="text-sm font-semibold text-gray-400 mb-2">Recent earnings</h4>
        {(data?.transactions || []).length === 0 ? (
          <p className="text-sm text-gray-600 py-4">No transactions yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.transactions.slice(0, 15).map((tx) => (
              <li
                key={tx.id}
                className="flex items-center gap-3 p-3 rounded-xl bg-[#0A0A0B] border border-[#262629]"
              >
                <div className="w-9 h-9 rounded-lg bg-[var(--sec-accent-muted)] flex items-center justify-center">
                  <ArrowDownLeft className="w-4 h-4 text-[var(--sec-accent)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{tx.label || 'Payment'}</p>
                  <p className="text-xs text-gray-500">
                    {tx.createdAt ? format(parseISO(tx.createdAt), 'MMM d, yyyy · HH:mm') : ''}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-white">{formatZar(tx.amount)}</p>
                  <p className={`text-[10px] uppercase ${
                    tx.status === 'TRANSFERRED'
                      ? 'text-green-500'
                      : tx.status === 'PROCESSING'
                        ? 'text-sky-400'
                        : 'text-[var(--sec-accent)]'
                  }`}>
                    {tx.statusLabel
                      || (tx.status === 'TRANSFERRED'
                        ? 'Received'
                        : tx.status === 'PROCESSING'
                          ? 'Transferring'
                          : 'Next payout')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
