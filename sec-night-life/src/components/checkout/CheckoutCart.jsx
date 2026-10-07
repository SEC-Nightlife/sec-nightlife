import React from 'react';
import { SERVICE_FEE_ZAR } from '@/lib/serviceFee';
import ChargedInZarNote from '@/components/checkout/ChargedInZarNote';

const SERVICE_FEE_NOTE = `A flat R${SERVICE_FEE_ZAR} SEC service fee is added to paid checkouts (non-refundable unless the event is cancelled).`;

export const CHECKOUT_FOOTNOTES = {
  venue:
    `SEC retains 15% of the booking subtotal; the venue receives 85%. ${SERVICE_FEE_NOTE}`,
  venueHost:
    `SEC retains 15% of the booking subtotal; the venue receives 85%. ${SERVICE_FEE_NOTE} After payment you can set table rules in Host Dashboard.`,
  hostedJoin:
    `Your total includes entrance (if any), joining fee, and menu items due now. ${SERVICE_FEE_NOTE}`,
  hostedMenu:
    `Menu orders are split 85% to the venue and 15% to SEC. ${SERVICE_FEE_NOTE}`,
};

/**
 * Checkout breakdown for table bookings.
 * SEC's 15% is taken from the subtotal — not shown as a separate line item.
 * The flat service fee arrives from the server as its own line.
 */
export default function CheckoutCart({
  lines = [],
  settlementMode = 'PREPAY_MENU',
  onSettlementChange,
  showSettlementOptions = false,
  minimumSpendZar = 0,
  footnote,
}) {
  const total = lines.reduce((s, l) => s + Number(l.amount_zar || 0), 0);

  return (
    <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--sec-border)', backgroundColor: 'var(--sec-bg-card)' }}>
      <h3 className="text-sm font-semibold" style={{ color: 'var(--sec-text-primary)' }}>
        Order summary
      </h3>
      <ul className="space-y-2">
        {lines.map((l) => (
          <li key={l.code} className="flex justify-between text-sm">
            <span style={{ color: 'var(--sec-text-secondary)' }}>{l.label}</span>
            <span style={{ color: 'var(--sec-text-primary)' }}>R{Number(l.amount_zar).toFixed(2)}</span>
          </li>
        ))}
      </ul>
      {lines.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--sec-text-muted)' }}>No charges yet.</p>
      ) : null}
      <div className="border-t pt-2 flex justify-between font-semibold text-sm" style={{ borderColor: 'var(--sec-border)' }}>
        <span>Total due now</span>
        <span style={{ color: 'var(--sec-accent)' }}>R{total.toFixed(2)}</span>
      </div>
      <ChargedInZarNote amountZar={total} style={{ textAlign: 'right' }} />
      {lines.length > 0 && footnote ? (
        <p className="text-[10px] leading-relaxed pt-1" style={{ color: 'var(--sec-text-muted)' }}>
          {footnote}
        </p>
      ) : null}
      {showSettlementOptions && Number(minimumSpendZar) > 0 ? (
        <p className="text-xs pt-2" style={{ color: 'var(--sec-text-muted)' }}>
          Select menu items to meet the minimum spend (R{Number(minimumSpendZar).toFixed(0)}) before checkout.
        </p>
      ) : null}
    </div>
  );
}
