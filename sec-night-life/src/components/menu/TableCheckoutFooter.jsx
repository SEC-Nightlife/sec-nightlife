import React from 'react';
import { MOBILE_NAV_BOTTOM_OFFSET } from '@/lib/layoutConstants';
import { useMoney } from '@/hooks/useMoney';

/**
 * Single sticky footer for venue table menu/checkout steps.
 */
export default function TableCheckoutFooter({
  itemCount = 0,
  cartTotalZar = 0,
  minSpendZar = 0,
  minMet = true,
  disabled = false,
  onContinue,
  continueLabel = 'Review order',
  children,
}) {
  const money = useMoney();
  const minSpend = Number(minSpendZar) || 0;
  const hasItems = itemCount > 0;
  const continueDisabled =
    disabled || !onContinue || (hasItems && minSpend > 0 && !minMet);

  return (
    <div
      className="table-checkout-footer sec-bottom-bar"
      style={{
        padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
        background: 'rgba(0,0,0,0.96)',
        borderTop: '1px solid var(--sec-border)',
        bottom: MOBILE_NAV_BOTTOM_OFFSET,
      }}
    >
      <div style={{ maxWidth: 960, margin: '0 auto', width: '100%' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginBottom: 10,
            fontSize: 13,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <span style={{ color: 'var(--sec-text-muted)' }}>
            {itemCount} item{itemCount === 1 ? '' : 's'}
            {minSpend > 0 && hasItems ? (
              <span style={{ marginLeft: 8 }}>
                · Min {money.format(minSpend)}
                {minMet ? '' : ` (${(minSpend - cartTotalZar).toFixed(0)} more needed)`}
              </span>
            ) : null}
          </span>
          {hasItems ? (
            <span style={{ fontWeight: 700, fontSize: 16 }}>{money.format(cartTotalZar)}</span>
          ) : minSpend > 0 ? (
            <span style={{ fontWeight: 700, fontSize: 16 }}>Min {money.format(minSpend)}</span>
          ) : null}
        </div>
        <div className="table-checkout-footer__actions" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {onContinue ? (
            <button
              type="button"
              className="sec-btn sec-btn-primary sec-btn-full"
              style={{ height: 48, minHeight: 44 }}
              disabled={continueDisabled}
              onClick={onContinue}
            >
              {continueLabel}
            </button>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}
