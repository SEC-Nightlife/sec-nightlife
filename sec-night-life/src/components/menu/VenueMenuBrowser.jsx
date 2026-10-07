import React from 'react';
import { menuSelectionChargeableTotal } from '@/components/menu/MenuPicker';
import VenueMenuNavigator from '@/components/menu/VenueMenuNavigator';
import { useMoney } from '@/hooks/useMoney';

function normalizeItem(item) {
  return {
    ...item,
    image_url: item.image_url || item.imageUrl || null,
    price: Number(item.price) || 0,
  };
}

/**
 * Guest table checkout menu: navigator + min-spend progress (footer owned by TableDetails).
 */
export default function VenueMenuBrowser({
  items = [],
  selected = {},
  onChange,
  disabled = false,
  includedItems = [],
  minimumSpendZar = 0,
  venueLogoUrl,
  hideStickyFooter = true,
}) {
  const money = useMoney();
  const normalized = items.map(normalizeItem);
  const chargeableTotal = menuSelectionChargeableTotal(normalized, selected, includedItems);
  const minSpend = Number(minimumSpendZar) || 0;
  const minMet = minSpend <= 0 || chargeableTotal >= minSpend;

  if (!normalized.length && !includedItems.length) {
    return (
      <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>
        This venue has not added menu items yet.
      </p>
    );
  }

  return (
    <div style={{ paddingBottom: hideStickyFooter ? 0 : 120 }}>
      {includedItems.length > 0 && (
        <div className="sec-card" style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>
            Included with your table — not charged
          </div>
          <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginBottom: 10 }}>
            These quantities are bundled with your table. Add more from the menu below if you want extras.
          </p>
          {includedItems.map((inc, i) => (
            <div key={`inc-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
              {inc.image_url ? (
                <img src={inc.image_url} alt="" style={{ width: 56, height: 56, borderRadius: 10, objectFit: 'cover' }} />
              ) : (
                <div style={{ width: 56, height: 56, borderRadius: 10, background: 'var(--sec-bg-hover)' }} />
              )}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{inc.name}</div>
                <div style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>×{inc.quantity} · included</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <VenueMenuNavigator
        items={normalized}
        mode="cart"
        selected={selected}
        onChange={onChange}
        disabled={disabled}
        venueLogoUrl={venueLogoUrl}
      />

      {minSpend > 0 && (
        <div className="sec-card" style={{ padding: 12, marginTop: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, flexWrap: 'wrap', gap: 8 }}>
            <span style={{ color: 'var(--sec-text-muted)' }}>Chargeable menu total</span>
            <span style={{ fontWeight: 700, color: minMet ? 'var(--sec-success)' : 'var(--sec-text-primary)' }}>
              {money.format(chargeableTotal)} / {money.format(minSpend)} min
            </span>
          </div>
          {!minMet && (
            <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 8 }}>
              Add chargeable items from the menu, or pay the minimum upfront without selecting items.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Helpers for parent footer */
export function getVenueMenuCartStats(items, selected, includedItems) {
  const normalized = (items || []).map(normalizeItem);
  const chargeableTotal = menuSelectionChargeableTotal(normalized, selected, includedItems);
  const itemCount = Object.values(selected || {}).reduce(
    (s, q) => s + (Number(q) > 0 ? Number(q) : 0),
    0,
  );
  return { normalized, chargeableTotal, itemCount };
}
