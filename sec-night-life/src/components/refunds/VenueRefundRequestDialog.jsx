import React from 'react';
import { format, parseISO } from 'date-fns';
import { Loader2, Copy, CheckCircle, XCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import SecLogo from '@/components/ui/SecLogo';
import { cn } from '@/lib/utils';
import { formatZar as formatRand } from '@/lib/money';

const formatZar = (n) => formatRand(n, { cents: true });

function StatusBadge({ status }) {
  const map = {
    PENDING: 'sec-badge-gold',
    APPROVED: 'sec-badge-success',
    REJECTED: 'sec-badge-muted',
    PAID_BY_VENUE: 'sec-badge-success',
  };
  return (
    <span className={`sec-badge ${map[status] || 'sec-badge-muted'}`}>
      {status === 'PAID_BY_VENUE' ? 'Paid' : status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

const FOOTER_CLASS =
  'relative z-10 shrink-0 border-t border-[var(--sec-accent-border)]/50 bg-[#0f1011]/95 backdrop-blur-sm px-5 sm:px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]';

function LuxuryDialogShell({ header, footer, children, className }) {
  return (
    <DialogContent
      className={cn(
        '!left-0 !right-0 !top-0 !bottom-0 !translate-x-0 !translate-y-0',
        'data-[state=open]:!translate-x-0 data-[state=open]:!translate-y-0',
        'data-[state=closed]:!translate-x-0 data-[state=closed]:!translate-y-0',
        'fixed z-50 m-auto h-fit w-[calc(100vw-2rem)] max-w-lg',
        'flex flex-col max-h-[90vh] overflow-hidden p-0 gap-0',
        'border-[var(--sec-accent-border)] shadow-2xl rounded-[10px]',
        className,
      )}
      style={{
        background: 'linear-gradient(160deg, rgba(192,192,192,0.14) 0%, #141418 38%, #0f1011 100%)',
      }}
    >
      <img
        src="/Logo/sec-email-logo-transparent.png"
        alt=""
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-44 sm:w-48 h-44 sm:h-48 opacity-[0.07] select-none"
        onError={(e) => {
          e.currentTarget.src = '/sec-logo.png';
        }}
      />
      {header ? <div className="relative z-10 shrink-0 px-5 sm:px-6 pt-5 sm:pt-6">{header}</div> : null}
      <div className="relative z-10 flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y px-5 sm:px-6 py-4">
        {children}
      </div>
      {footer ? <div className={FOOTER_CLASS}>{footer}</div> : null}
    </DialogContent>
  );
}

function FieldLabel({ children }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--sec-accent-bright)]/80 mb-1.5">
      {children}
    </p>
  );
}

export function VenueRefundRequestDialog({
  selected,
  open,
  onOpenChange,
  onCopyWallet,
  onApprove,
  onDecline,
  onMarkPaid,
  approvePending,
  markPaidPending,
}) {
  if (!selected) return null;

  const guestName = selected.user?.fullName || selected.user?.username || 'Guest';

  const header = (
    <DialogHeader className="space-y-3 p-0">
      <div className="flex items-center justify-between gap-3 pr-8">
        <div className="flex items-center gap-3 min-w-0 sm:gap-3.5">
          <SecLogo size={42} variant="icon" asset="transparent" />
          <DialogTitle className="text-lg sm:text-xl font-semibold tracking-tight text-white">
            Refund request
          </DialogTitle>
        </div>
      </div>
      <div className="flex justify-between items-center gap-2">
        <StatusBadge status={selected.status} />
        <span className="text-xs text-[var(--sec-text-muted)] shrink-0">
          {format(parseISO(selected.createdAt), 'd MMM yyyy HH:mm')}
        </span>
      </div>
    </DialogHeader>
  );

  let footer = null;
  if (selected.status === 'PENDING') {
    footer = (
      <div className="flex flex-col sm:flex-row gap-2">
        <Button
          className="flex-1 sec-btn-primary h-11"
          disabled={approvePending}
          onClick={() => onApprove(selected.id)}
        >
          {approvePending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <CheckCircle className="w-4 h-4 mr-1.5" />
          )}
          Approve
        </Button>
        <Button
          variant="outline"
          className="flex-1 h-11 border-[var(--sec-accent-border)] bg-black/20 hover:bg-black/30 hover:border-[var(--sec-accent-bright)]/40"
          onClick={onDecline}
        >
          <XCircle className="w-4 h-4 mr-1.5" />
          Decline
        </Button>
      </div>
    );
  } else if (selected.status === 'APPROVED') {
    footer = (
      <Button
        className="w-full h-11 border-[var(--sec-accent-border)]"
        variant="outline"
        disabled={markPaidPending}
        onClick={() => onMarkPaid(selected.id)}
      >
        {markPaidPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Mark paid off-app'}
      </Button>
    );
  } else if (selected.status === 'REJECTED' && selected.rejectTemplateKeys) {
    footer = (
      <div className="text-xs text-[var(--sec-text-muted)] rounded-lg border border-[var(--sec-border)] bg-black/20 px-3 py-2">
        Decline reason:{' '}
        {(Array.isArray(selected.rejectTemplateKeys) ? selected.rejectTemplateKeys : []).join(', ')}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <LuxuryDialogShell header={header} footer={footer}>
        <div className="space-y-4 text-sm pb-2">
          <div className="rounded-xl border border-[var(--sec-accent-border)]/60 bg-black/25 px-4 py-3">
            <FieldLabel>Guest</FieldLabel>
            <p className="font-semibold text-white text-base">{guestName}</p>
          </div>

          <div className="rounded-xl border border-[var(--sec-accent-border)]/60 bg-black/25 px-4 py-3">
            <FieldLabel>Reason</FieldLabel>
            <p className="whitespace-pre-wrap text-[#F0F0F4] leading-relaxed">
              {selected.userReason}
            </p>
          </div>

          <div className="rounded-xl border border-[var(--sec-accent-border)] bg-black/30 p-4 space-y-3">
            <div className="flex justify-between items-center text-[var(--sec-text-muted)]">
              <span>Gross paid</span>
              <span className="text-white">{formatZar(selected.grossAmountZar)}</span>
            </div>
            <div className="flex justify-between items-center pt-1 border-t border-[var(--sec-accent-border)]/50">
              <span className="font-semibold text-[var(--sec-accent-bright)]">You refund</span>
              <span className="text-lg font-bold text-[var(--sec-accent-bright)]">
                {formatZar(selected.venueRefundDueZar)}
              </span>
            </div>
            <div className="flex justify-between text-xs text-[var(--sec-text-muted)]">
              <span>SEC Cancellation fee</span>
              <span>{formatZar(selected.platformFeeKeptZar)}</span>
            </div>
          </div>

          <div>
            <FieldLabel>Guest Sec Wallet ID</FieldLabel>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <code className="flex-1 px-3 py-2.5 rounded-xl bg-black/40 border border-[var(--sec-accent-border)] font-mono text-sm text-white break-all">
                {selected.userWalletCode}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="border-[var(--sec-accent-border)] hover:border-[var(--sec-accent-bright)]/50 shrink-0 h-11 w-full sm:w-11"
                onClick={() => onCopyWallet(selected.userWalletCode)}
              >
                <Copy className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-xs text-[var(--sec-text-muted)] mt-2 leading-relaxed">
              Look up this ID in Sec Wallet and pay the guest from your bank off-app.
            </p>
          </div>
        </div>
      </LuxuryDialogShell>
    </Dialog>
  );
}

export function VenueRefundDeclineDialog({
  open,
  onOpenChange,
  rejectKey,
  onRejectKeyChange,
  rejectTemplates,
  onConfirm,
  confirmPending,
  disabled,
}) {
  const header = (
    <DialogHeader className="p-0">
      <div className="flex items-center gap-3 pr-8 sm:gap-3.5">
        <SecLogo size={40} variant="icon" asset="transparent" />
        <DialogTitle className="text-lg sm:text-xl font-semibold tracking-tight text-white">
          Decline refund
        </DialogTitle>
      </div>
    </DialogHeader>
  );

  const footer = (
    <Button
      className="w-full h-11"
      variant="destructive"
      disabled={confirmPending || disabled}
      onClick={onConfirm}
    >
      {confirmPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm decline'}
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <LuxuryDialogShell className="max-w-md" header={header} footer={footer}>
        <div className="space-y-4 pb-2">
          <p className="text-sm text-[var(--sec-text-muted)] leading-relaxed">
            Select a reason — guests only see approved template messages (no free text).
          </p>
          <Select value={rejectKey} onValueChange={onRejectKeyChange}>
            <SelectTrigger className="bg-black/30 border-[var(--sec-accent-border)] h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {rejectTemplates.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </LuxuryDialogShell>
    </Dialog>
  );
}

export { StatusBadge, formatZar };
