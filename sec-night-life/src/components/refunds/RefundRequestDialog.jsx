import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/api/client';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Check, ChevronDown, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { format, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';

function formatZar(n) {
  return `R ${Number(n || 0).toFixed(2)}`;
}

function formatPaymentDate(value) {
  if (!value) return '—';
  try {
    const d = parseISO(value);
    if (Number.isNaN(d.getTime())) return '—';
    return format(d, 'd MMM yyyy');
  } catch {
    return '—';
  }
}

function PaymentPicker({ items, selectedRef, onSelect, isLoading, isError, onRetry }) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 justify-center text-[var(--sec-text-muted)]">
        <Loader2 className="w-5 h-5 animate-spin shrink-0" />
        <span className="text-sm">Loading your payments…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-red-900/40 bg-red-950/20 p-4 text-center space-y-3">
        <p className="text-sm text-red-200/90">Could not load eligible payments.</p>
        <Button type="button" variant="outline" size="sm" className="border-[#262629]" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="rounded-lg border border-[var(--sec-border)] bg-[var(--sec-bg-elevated)] p-4 text-sm text-[var(--sec-text-muted)]">
        <p className="font-medium text-[var(--sec-text-primary)] mb-1">No eligible payments</p>
        <p>
          Refunds may already be pending, completed, or not available for this payment type (e.g. joining fees).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 max-h-52 overflow-y-auto pr-0.5">
      {items.map((p) => {
        const isSelected = selectedRef === p.reference;
        const partialMenu = p.label?.includes('Menu items only');
        return (
          <button
            key={p.reference}
            type="button"
            onClick={() => onSelect(p.reference)}
            className={cn(
              'w-full text-left rounded-xl border p-3 transition-colors',
              isSelected
                ? 'border-[var(--sec-accent)] bg-[var(--sec-accent-muted)]'
                : 'border-[var(--sec-border)] bg-[var(--sec-bg-elevated)] hover:border-[var(--sec-accent-border)]',
            )}
          >
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                  isSelected
                    ? 'border-[var(--sec-accent)] bg-[var(--sec-accent)] text-[var(--sec-bg-base)]'
                    : 'border-[var(--sec-border)]',
                )}
              >
                {isSelected ? <Check className="w-3 h-3" strokeWidth={3} /> : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-[var(--sec-text-primary)] leading-snug break-words">
                  {p.label || p.reference}
                </p>
                <p className="text-sm text-[var(--sec-text-muted)] mt-0.5">
                  {formatZar(p.amount)} · {formatPaymentDate(p.createdAt)}
                </p>
                {partialMenu ? (
                  <span className="inline-block mt-1.5 text-[10px] uppercase tracking-wide text-amber-200/90">
                    Menu items only
                  </span>
                ) : null}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export default function RefundRequestDialog({ open, onOpenChange, paymentReference, label, onSuccess }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [walletCode, setWalletCode] = useState('');
  const [policyOpen, setPolicyOpen] = useState(false);

  const { data: walletData } = useQuery({
    queryKey: ['sec-wallet-me'],
    queryFn: () => apiGet('/api/wallet/me'),
    enabled: open,
  });

  const {
    data: eligibleData,
    isLoading: eligibleLoading,
    isError: eligibleError,
    refetch: refetchEligible,
  } = useQuery({
    queryKey: ['refund-eligible-payments'],
    queryFn: () => apiGet('/api/refunds/eligible-payments'),
    enabled: open,
  });

  const [selectedRef, setSelectedRef] = useState(paymentReference || '');

  React.useEffect(() => {
    if (!open) return;
    if (paymentReference) {
      setSelectedRef(paymentReference);
    } else {
      setSelectedRef('');
      setReason('');
    }
    setPolicyOpen(false);
  }, [open, paymentReference]);

  React.useEffect(() => {
    if (walletData?.walletCode && !walletCode) {
      setWalletCode(walletData.walletCode);
    }
  }, [walletData?.walletCode, walletCode]);

  React.useEffect(() => {
    if (paymentReference) setSelectedRef(paymentReference);
  }, [paymentReference]);

  const eligibleItems = eligibleData?.items || [];

  const selectedPayment = eligibleItems.find(
    (p) => p.reference === selectedRef || p.reference === paymentReference,
  );

  const submitMutation = useMutation({
    mutationFn: (body) => apiPost('/api/refunds/request', body),
    onSuccess: () => {
      toast.success('Refund request submitted');
      queryClient.invalidateQueries({ queryKey: ['refund-my'] });
      queryClient.invalidateQueries({ queryKey: ['refund-eligible-payments'] });
      queryClient.invalidateQueries({ queryKey: ['my-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['profile-social'] });
      queryClient.invalidateQueries({ queryKey: ['table-history'] });
      setReason('');
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (e) => toast.error(e?.data?.error || e?.message || 'Could not submit request'),
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    const ref = selectedRef || paymentReference;
    if (!ref) {
      toast.error('Select a payment');
      return;
    }
    if (reason.trim().length < 10) {
      toast.error('Please describe your reason (at least 10 characters)');
      return;
    }
    if (!walletCode.trim()) {
      toast.error('Enter your Sec Wallet ID');
      return;
    }
    submitMutation.mutate({
      payment_reference: ref,
      reason: reason.trim(),
      wallet_code: walletCode.trim(),
    });
  };

  const due = selectedPayment?.venueRefundDueZar;
  const kept = selectedPayment?.platformFeeKeptZar;
  const serviceFee = selectedPayment?.serviceFeeZar;
  const canSubmit = Boolean(selectedRef || paymentReference);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[min(90vh,720px)] overflow-y-auto bg-[var(--sec-bg-card)] border-[var(--sec-border)] p-0 gap-0">
        <DialogHeader className="p-6 pb-3">
          <DialogTitle className="flex items-center gap-2 text-[var(--sec-text-primary)]">
            <RotateCcw className="w-5 h-5 text-[var(--sec-accent)]" />
            Request refund
          </DialogTitle>
          <DialogDescription className="sr-only">
            Choose a payment, explain your reason, and submit a refund request to the venue.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 pb-6">
          {!paymentReference ? (
            <div>
              <label className="text-xs font-medium text-[var(--sec-text-muted)] block mb-2">
                Select payment to refund
              </label>
              <PaymentPicker
                items={eligibleItems}
                selectedRef={selectedRef}
                onSelect={setSelectedRef}
                isLoading={eligibleLoading}
                isError={eligibleError}
                onRetry={() => refetchEligible()}
              />
            </div>
          ) : null}

          {label && paymentReference ? (
            <div className="rounded-lg border border-[var(--sec-border)] bg-[var(--sec-bg-elevated)] p-3">
              <p className="text-xs text-[var(--sec-text-muted)] mb-0.5">Refunding</p>
              <p className="text-sm font-medium text-[var(--sec-text-primary)]">{label}</p>
            </div>
          ) : null}

          {(due != null || kept != null) && (selectedRef || paymentReference) ? (
            <div className="rounded-lg border border-[var(--sec-border)] p-3 text-sm space-y-1">
              <div className="flex justify-between gap-3">
                <span className="text-[var(--sec-text-muted)]">Venue refund (if approved)</span>
                <span className="font-semibold text-[var(--sec-accent)] shrink-0">{formatZar(due)}</span>
              </div>
              <div className="flex justify-between gap-3 text-xs">
                <span className="text-[var(--sec-text-muted)]">SEC platform fee (non-refundable)</span>
                <span className="shrink-0">{formatZar(kept)}</span>
              </div>
              {Number(serviceFee) > 0 ? (
                <div className="flex justify-between gap-3 text-xs">
                  <span className="text-[var(--sec-text-muted)]">
                    SEC service fee (refunded only if the event is cancelled)
                  </span>
                  <span className="shrink-0">{formatZar(serviceFee)}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          <div>
            <label className="text-xs text-[var(--sec-text-muted)] block mb-1">Reason for refund</label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why you are requesting a refund…"
              rows={4}
              maxLength={2000}
              className="bg-[var(--sec-bg-elevated)] border-[var(--sec-border)] text-[16px]"
            />
          </div>

          <div>
            <label className="text-xs text-[var(--sec-text-muted)] block mb-1">Your Sec Wallet ID</label>
            <Input
              value={walletCode}
              onChange={(e) => setWalletCode(e.target.value.toUpperCase())}
              placeholder="SEC-U-XXXXXXXX"
              className="font-mono bg-[var(--sec-bg-elevated)] border-[var(--sec-border)] text-[16px]"
            />
            <p className="text-xs text-[var(--sec-text-muted)] mt-1">
              The venue uses this to look up your bank details and pay you off-app.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setPolicyOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 text-left text-xs text-[var(--sec-text-muted)] hover:text-[var(--sec-text-primary)] transition-colors"
          >
            <span>How refunds work</span>
            <ChevronDown
              className={cn('w-4 h-4 shrink-0 transition-transform', policyOpen && 'rotate-180')}
            />
          </button>
          {policyOpen ? (
            <p className="text-xs text-[var(--sec-text-muted)] leading-relaxed -mt-2">
              Refunds are handled by the venue, not SEC. If approved, the venue pays you{' '}
              <strong className="text-[var(--sec-text-primary)]">85%</strong> of the refundable amount to your Sec
              Wallet off-app (SEC keeps 15%). Joining fees are not refundable. Menu-only refunds apply when you paid
              for venue items. The R5 SEC service fee is only refunded if the event is cancelled. Your QR/ticket
              access for refunded items will be revoked.
            </p>
          ) : null}

          <Button
            type="submit"
            disabled={submitMutation.isPending || !canSubmit}
            className="w-full sec-btn-primary"
          >
            {submitMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Submit request
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
