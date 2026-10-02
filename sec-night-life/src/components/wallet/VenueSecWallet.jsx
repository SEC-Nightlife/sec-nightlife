import React, { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiGet, apiPost, apiDelete } from '@/api/client';
import { format, parseISO } from 'date-fns';
import {
  Wallet, AlertCircle, ArrowDownLeft, Loader2, Search, Copy, Trash2, User,
} from 'lucide-react';
import { toast } from 'sonner';
import { VenuePayoutSetup } from './WalletPayoutSetup';
import WeeklyPayoutNotice from './WeeklyPayoutNotice';
import { asArray } from '@/utils';

function formatZar(n) {
  return `R ${Number(n || 0).toFixed(2)}`;
}

async function copyText(label, value) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(String(value));
    toast.success(`${label} copied`);
  } catch {
    toast.error('Could not copy');
  }
}

export default function VenueSecWallet({ venues: venuesProp, onVenuesUpdated }) {
  const venues = asArray(venuesProp);
  const [selectedVenueId, setSelectedVenueId] = useState(venues[0]?.id || '');
  const [lookupCode, setLookupCode] = useState('');

  useEffect(() => {
    if (!venues.length) return;
    if (!selectedVenueId || !venues.some((v) => v.id === selectedVenueId)) {
      setSelectedVenueId(venues[0].id);
    }
  }, [venues, selectedVenueId]);

  const selectedVenue = venues.find((v) => v.id === selectedVenueId);
  const [lookupResult, setLookupResult] = useState(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [revealLoading, setRevealLoading] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['sec-wallet-venue', selectedVenueId],
    queryFn: () => apiGet(`/api/wallet/venue/${selectedVenueId}`),
    enabled: !!selectedVenueId,
  });

  const { data: recipientsData, refetch: refetchRecipients } = useQuery({
    queryKey: ['wallet-recipients', selectedVenueId],
    queryFn: () => apiGet(`/api/wallet/venue/${selectedVenueId}/recipients`),
    enabled: !!selectedVenueId,
  });

  const saveRecipient = useMutation({
    mutationFn: (targetWalletId) =>
      apiPost(`/api/wallet/venue/${selectedVenueId}/recipients`, {
        target_wallet_id: targetWalletId,
        label: lookupResult?.user?.fullName || lookupResult?.user?.username || null,
      }),
    onSuccess: () => {
      toast.success('Saved to recipient list');
      refetchRecipients();
    },
    onError: (e) => toast.error(e?.message || 'Could not save'),
  });

  const removeRecipient = useMutation({
    mutationFn: (id) => apiDelete(`/api/wallet/venue/${selectedVenueId}/recipients/${id}`),
    onSuccess: () => {
      toast.success('Recipient removed');
      refetchRecipients();
    },
    onError: (e) => toast.error(e?.message || 'Could not remove'),
  });

  const runLookup = async () => {
    if (!lookupCode.trim() || !selectedVenueId) return;
    setLookupLoading(true);
    setLookupResult(null);
    try {
      const res = await apiPost('/api/wallet/lookup', {
        wallet_code: lookupCode.trim(),
        venue_id: selectedVenueId,
      });
      setLookupResult(res);
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Lookup failed');
    } finally {
      setLookupLoading(false);
    }
  };

  const revealAccountNumber = async () => {
    if (!lookupCode.trim() || !selectedVenueId || !lookupResult) return;
    setRevealLoading(true);
    try {
      const res = await apiPost('/api/wallet/lookup/reveal', {
        wallet_code: lookupCode.trim(),
        venue_id: selectedVenueId,
      });
      setLookupResult((prev) => ({
        ...prev,
        payout: {
          ...(prev?.payout || {}),
          account_number: res.account_number,
          account_number_masked: res.account_number_masked,
          account_name: res.account_name || prev?.payout?.account_name,
          bank_code: res.bank_code || prev?.payout?.bank_code,
          bank_name: res.bank_name || prev?.payout?.bank_name,
        },
      }));
      toast.success('Full account number revealed for refund payout');
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Could not reveal account number');
    } finally {
      setRevealLoading(false);
    }
  };

  if (!venues.length) {
    return <p className="text-sm text-gray-500">Complete venue onboarding to access your Sec Wallet.</p>;
  }

  const venueHasWallet = (v) =>
    Boolean(v?.payout_setup_complete || v?.paystack_recipient_code || v?.paystackRecipientCode);

  return (
    <div className="space-y-4">
      {venues.length > 1 ? (
        <div className="rounded-xl border border-[#262629] bg-[#141416] p-3 space-y-2">
          <p className="text-xs text-gray-400">
            Each venue needs its own Sec Wallet bank details — they are not shared across venues.
          </p>
          <ul className="space-y-1.5">
            {venues.map((v) => {
              const set = venueHasWallet(v);
              return (
                <li key={v.id} className="flex items-center justify-between gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedVenueId(v.id);
                      setLookupResult(null);
                    }}
                    className={`text-left truncate hover:text-white ${
                      v.id === selectedVenueId ? 'text-white font-medium' : 'text-gray-400'
                    }`}
                  >
                    {v.name}
                  </button>
                  <span className={`text-[10px] uppercase shrink-0 ${set ? 'text-green-500' : 'text-amber-400'}`}>
                    {set ? 'Set' : 'Missing'}
                  </span>
                </li>
              );
            })}
          </ul>
          <label className="block pt-1">
            <span className="text-xs text-gray-500">Editing venue</span>
            <select
              value={selectedVenueId}
              onChange={(e) => {
                setSelectedVenueId(e.target.value);
                setLookupResult(null);
              }}
              className="w-full mt-1 px-3 py-2.5 rounded-xl border border-[#262629] bg-[#0A0A0B] text-white"
            >
              {venues.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </label>
        </div>
      ) : selectedVenue ? (
        <div>
          <p className="text-xs text-gray-500">Venue</p>
          <p className="text-white font-medium mt-1">{selectedVenue.name}</p>
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--sec-accent)]" />
        </div>
      ) : (
        <>
          <div
            className="rounded-2xl p-5 border border-[#262629]"
            style={{ background: 'linear-gradient(135deg, var(--sec-accent-muted) 0%, #141416 60%)' }}
          >
            <div className="flex items-center gap-2 text-[var(--sec-accent)] mb-2">
              <Wallet className="w-5 h-5" />
              <span className="text-xs font-semibold uppercase tracking-wider">Venue Sec Wallet</span>
            </div>
            <p className="text-xs text-gray-500 mb-3">Venue wallet IDs are private — paste a user&apos;s ID to pay them via your bank.</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-black/30 p-3 border border-[#262629]/80">
                <p className="text-xs text-gray-500">Pending</p>
                <p className="text-lg font-bold" style={{ color: 'var(--sec-accent-bright)' }}>{formatZar(data?.pendingBalance)}</p>
              </div>
              <div className="rounded-xl bg-black/30 p-3 border border-[#262629]/80">
                <p className="text-xs text-gray-500">Received</p>
                <p className="text-lg font-bold text-green-400">{formatZar(data?.totalReceived)}</p>
              </div>
            </div>
            <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
              Pending is money owed to your venue that will be included in the next weekly payout. Received means
              the bank transfer was sent. Your bank may take 1–2 business days to show the credit (longer on weekends or public holidays).
              Match amounts here with your bank statement.
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
              style={{ border: '1px solid var(--sec-accent-border)', background: 'var(--sec-accent-muted)', color: 'var(--sec-text-primary)' }}
            >
              <AlertCircle className="w-5 h-5 shrink-0" style={{ color: 'var(--sec-accent-bright)' }} />
              <p>Set up venue payout details so your earnings can be included in the weekly Monday payout to your business account.</p>
            </div>
          )}

          <div>
            <h4 className="text-sm font-semibold text-gray-400 mb-2">Venue payout details</h4>
            <VenuePayoutSetup
              venues={venues.map((v) =>
                v.id === selectedVenueId && data?.payoutSetupComplete
                  ? {
                      ...v,
                      payout_setup_complete: true,
                      paystack_recipient_code: v.paystack_recipient_code || v.paystackRecipientCode || 'set',
                      paystackRecipientCode: v.paystackRecipientCode || v.paystack_recipient_code || 'set',
                    }
                  : v,
              )}
              selectedVenueId={selectedVenueId}
              onVenueChange={setSelectedVenueId}
              onVenuesUpdated={(next) => {
                onVenuesUpdated?.(next);
                refetch();
              }}
            />
          </div>

          <div className="rounded-xl border border-[#262629] bg-[#141416] p-4 space-y-3">
            <h4 className="text-sm font-semibold text-white flex items-center gap-2">
              <Search className="w-4 h-4 text-[var(--sec-accent)]" />
              Look up user payout details
            </h4>
            <p className="text-xs text-gray-500">Paste a party goer&apos;s Sec Wallet ID to view bank details for off-app payment.</p>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                value={lookupCode}
                onChange={(e) => setLookupCode(e.target.value.toUpperCase())}
                placeholder="SEC-U-XXXXXXXX"
                className="min-w-0 w-full flex-1 px-3 py-2.5 rounded-xl border border-[#262629] bg-[#0A0A0B] text-white font-mono text-sm"
              />
              <button
                type="button"
                disabled={lookupLoading || !lookupCode.trim()}
                onClick={runLookup}
                className="w-full sm:w-auto shrink-0 px-4 py-2.5 rounded-xl bg-[var(--sec-accent)] text-black font-semibold text-sm disabled:opacity-50"
              >
                {lookupLoading ? '...' : 'Look up'}
              </button>
            </div>

            {lookupResult && (
              <div className="rounded-xl border border-[#262629] bg-[#0A0A0B] p-4 space-y-3">
                <div className="flex items-center gap-2 min-w-0">
                  <User className="w-4 h-4 text-gray-400 shrink-0" />
                  <span className="font-medium truncate">{lookupResult.user?.fullName || lookupResult.user?.username}</span>
                  <span className="text-xs text-gray-500 shrink-0 truncate">@{lookupResult.user?.username}</span>
                </div>
                {lookupResult.payout ? (
                  <div className="space-y-2 text-sm">
                    <PayoutCopyRow label="Account name" value={lookupResult.payout.account_name} />
                    <PayoutCopyRow
                      label="Account number"
                      value={lookupResult.payout.account_number || lookupResult.payout.account_number_masked}
                      masked={lookupResult.payout.account_number ? null : lookupResult.payout.account_number_masked}
                    />
                    <PayoutCopyRow label="Bank code" value={lookupResult.payout.bank_code} />
                    {lookupResult.payout.bank_name && (
                      <p className="text-xs text-gray-500">Bank: {lookupResult.payout.bank_name}</p>
                    )}
                    {!lookupResult.payout.account_number && (
                      <button
                        type="button"
                        disabled={revealLoading}
                        onClick={revealAccountNumber}
                        className="w-full py-2 rounded-lg border border-[var(--sec-accent)]/40 text-sm text-[var(--sec-accent)] disabled:opacity-50"
                      >
                        {revealLoading ? 'Revealing…' : 'Reveal full account number for refund'}
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="text-sm" style={{ color: 'var(--sec-accent-bright)' }}>Payout details unavailable.</p>
                )}
                <button
                  type="button"
                  className="w-full py-2 rounded-lg border border-[#262629] text-sm hover:border-[var(--sec-accent)]/40"
                  onClick={() => saveRecipient.mutate(lookupResult.targetWalletId)}
                  disabled={saveRecipient.isPending}
                >
                  Save to recipient list
                </button>
              </div>
            )}
          </div>

          <div>
            <h4 className="text-sm font-semibold text-gray-400 mb-2">Saved recipients</h4>
            {(recipientsData?.recipients || []).length === 0 ? (
              <p className="text-sm text-gray-600">No saved recipients yet.</p>
            ) : (
              <ul className="space-y-2">
                {recipientsData.recipients.map((r) => (
                  <li key={r.id} className="rounded-xl border border-[#262629] bg-[#0A0A0B] p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-sm">{r.user?.fullName || r.label || 'Recipient'}</p>
                        <p className="text-xs text-gray-500 font-mono">{r.walletCode}</p>
                      </div>
                      <button
                        type="button"
                        className="p-1.5 text-gray-500 hover:text-red-400"
                        onClick={() => removeRecipient.mutate(r.id)}
                        aria-label="Remove recipient"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    {r.payout && (
                      <div className="mt-2 space-y-1.5 text-xs">
                        <PayoutCopyRow label="Name" value={r.payout.account_name} compact />
                        <PayoutCopyRow label="Account" value={r.payout.account_number_masked} compact />
                        <PayoutCopyRow label="Bank code" value={r.payout.bank_code} compact />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="text-sm font-semibold text-gray-400 mb-2">Venue earnings</h4>
            {(data?.transactions || []).length === 0 ? (
              <p className="text-sm text-gray-600">No earnings yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.transactions.slice(0, 15).map((tx) => (
                  <li key={tx.id} className="flex items-center gap-3 p-3 rounded-xl bg-[#0A0A0B] border border-[#262629]">
                    <ArrowDownLeft className="w-4 h-4 text-[var(--sec-accent)]" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{tx.label}</p>
                      <p className="text-xs text-gray-500">
                        {tx.createdAt ? format(parseISO(tx.createdAt), 'MMM d, yyyy') : ''}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold">{formatZar(tx.amount)}</p>
                      <p
                        className={`text-[10px] uppercase ${
                          tx.status === 'TRANSFERRED'
                            ? 'text-green-500'
                            : tx.status === 'PROCESSING'
                              ? 'text-sky-400'
                              : 'text-[var(--sec-accent)]'
                        }`}
                      >
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
        </>
      )}
    </div>
  );
}

function PayoutCopyRow({ label, value, masked, compact }) {
  return (
    <div className={`flex items-center justify-between gap-2 ${compact ? '' : 'py-1'}`}>
      <div className="min-w-0">
        <span className="text-gray-500">{label}: </span>
        <span className="text-gray-200">{masked || value || '—'}</span>
      </div>
      {value && (
        <button
          type="button"
          className="shrink-0 p-1.5 rounded-lg hover:bg-white/5 text-gray-400"
          onClick={() => copyText(label, value)}
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
