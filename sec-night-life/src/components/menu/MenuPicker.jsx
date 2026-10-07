import React, { useMemo } from 'react';
import { Minus, Plus } from 'lucide-react';
import { groupMenuByCategory } from '@/lib/groupMenuByCategory';
import { useMoney } from '@/hooks/useMoney';

/** Build map of bundled included quantities by menu item id. */
export function includedQtyMap(includedItems = []) {
  const map = new Map();
  for (const inc of includedItems) {
    const id = inc.menu_item_id || inc.menuItemId || inc.id;
    if (!id) continue;
    map.set(id, (map.get(id) || 0) + Math.max(1, Number(inc.quantity) || 1));
  }
  return map;
}

/** Full selection total (all qty × price). */
export function menuSelectionTotal(items, selected, includedItems = []) {
  let sum = 0;
  for (const [id, qty] of Object.entries(selected || {})) {
    const item = items.find((m) => m.id === id);
    if (item) sum += Number(item.price) * Number(qty || 0);
  }
  for (const inc of includedItems) {
    const id = inc.menu_item_id || inc.menuItemId || inc.id;
    if (id && !selected?.[id]) {
      sum += Number(inc.price || 0) * Number(inc.quantity || 0);
    }
  }
  return sum;
}

/** Chargeable total: only quantities above tier-included bundle count. */
export function menuSelectionChargeableTotal(items, selected, includedItems = []) {
  const bundled = includedQtyMap(includedItems);
  let total = 0;
  for (const [id, qtyRaw] of Object.entries(selected || {})) {
    const qty = Number(qtyRaw) || 0;
    if (qty <= 0) continue;
    const item = items.find((m) => m.id === id);
    if (!item) continue;
    const extra = Math.max(0, qty - (bundled.get(id) || 0));
    total += Number(item.price) * extra;
  }
  return total;
}

export function menuSelectionToPayload(items, selected) {
  return Object.entries(selected || {})
    .filter(([, qty]) => Number(qty) > 0)
    .map(([menuItemId, quantity]) => {
      const item = items.find((m) => m.id === menuItemId);
      return {
        menuItemId,
        quantity: Number(quantity),
        unitPrice: item ? Number(item.price) : 0,
        name: item?.name || '',
        image_url: item?.image_url || item?.imageUrl || null,
      };
    });
}

function QtyStepper({ qty, onDec, onInc, disabled }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        disabled={disabled || qty <= 0}
        onClick={onDec}
        aria-label="Decrease"
        className="sec-btn"
        style={{ width: 32, height: 32, padding: 0, borderRadius: '50%' }}
      >
        <Minus size={14} />
      </button>
      <span style={{ minWidth: 18, textAlign: 'center', fontWeight: 700 }}>{qty}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onInc}
        aria-label="Increase"
        className="sec-btn sec-btn-primary"
        style={{ width: 32, height: 32, padding: 0, borderRadius: '50%' }}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

/**
 * Compact menu picker (hosted table add-ons). Uses same category grouping and +/- controls.
 */
export default function MenuPicker({
  items = [],
  selected = {},
  onChange,
  disabled = false,
  includedItems = [],
}) {
  const money = useMoney();
  const normalized = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        image_url: item.image_url || item.imageUrl || null,
        price: Number(item.price) || 0,
      })),
    [items],
  );
  const sections = useMemo(() => groupMenuByCategory(normalized), [normalized]);
  const cartTotal = menuSelectionTotal(normalized, selected, includedItems);

  if (!normalized.length && !includedItems.length) {
    return (
      <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>
        This venue has not added menu items yet.
      </p>
    );
  }

  return (
    <div>
      {includedItems.length > 0 && (
        <div className="sec-card" style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>Included with your tier</div>
          {includedItems.map((inc, i) => (
            <div key={`inc-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
              {inc.image_url ? (
                <img src={inc.image_url} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover' }} />
              ) : (
                <div style={{ width: 44, height: 44, borderRadius: 8, background: 'var(--sec-bg-hover)' }} />
              )}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{inc.name}</div>
                <div style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>×{inc.quantity}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {sections.map(({ category, items: catItems }) => (
        <div key={category} className="sec-card" style={{ padding: 14, marginBottom: 10 }}>
          <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13 }}>{category}</div>
          {catItems.map((item) => {
            const qty = Number(selected[item.id] || 0);
            return (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  marginBottom: 12,
                  opacity: disabled ? 0.6 : 1,
                }}
              >
                {item.image_url ? (
                  <img
                    src={item.image_url}
                    alt=""
                    style={{ width: 52, height: 52, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                  />
                ) : (
                  <div style={{ width: 52, height: 52, borderRadius: 8, background: 'var(--sec-bg-hover)', flexShrink: 0 }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{item.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--sec-accent)' }}>{money.format(item.price)}</div>
                </div>
                <QtyStepper
                  qty={qty}
                  disabled={disabled}
                  onDec={() => onChange(item.id, Math.max(0, qty - 1))}
                  onInc={() => onChange(item.id, qty + 1)}
                />
              </div>
            );
          })}
        </div>
      ))}

      <div
        style={{
          marginTop: 8,
          padding: 12,
          borderRadius: 10,
          border: '1px solid var(--sec-border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>Selection total</span>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{money.format(cartTotal)}</span>
      </div>
    </div>
  );
}
