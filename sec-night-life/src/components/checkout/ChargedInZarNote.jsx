import React from 'react';
import { useMoney } from '@/hooks/useMoney';

/**
 * Under checkout totals when the viewer browses in another currency:
 * "≈ $12.40 · Charged in ZAR: R220.00". Renders nothing for rand viewers.
 */
export default function ChargedInZarNote({ amountZar, style }) {
  const money = useMoney();
  const v = Number(amountZar);
  if (!money.isConverted || !Number.isFinite(v) || v <= 0) return null;
  return (
    <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', margin: '4px 0 0', ...style }}>
      {money.format(v)} · Charged in ZAR: {money.formatZar(v, { cents: true })}
    </p>
  );
}
