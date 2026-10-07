import React, { useMemo, useState } from 'react';
import { Search, Minus, Plus } from 'lucide-react';
import { buildMenuHierarchy, filterMenuBySearch } from '@/lib/groupMenuHierarchy';
import MenuItemImagePreview from '@/components/menu/MenuItemImagePreview';
import { useMoney } from '@/hooks/useMoney';

function normalizeItem(item) {
  return {
    ...item,
    image_url: item.image_url || item.imageUrl || null,
    price: Number(item.price) || 0,
  };
}

export function MenuQtyStepper({ qty, onDec, onInc, disabled }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        borderRadius: 999,
        border: '1px solid var(--sec-border)',
        background: 'var(--sec-bg-elevated)',
        padding: '4px 6px',
      }}
    >
      <button
        type="button"
        disabled={disabled || qty <= 0}
        onClick={onDec}
        aria-label="Decrease quantity"
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '1px solid var(--sec-border)',
          background: 'var(--sec-bg-card)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: qty <= 0 ? 0.35 : 1,
        }}
      >
        <Minus size={14} />
      </button>
      <span style={{ minWidth: 20, textAlign: 'center', fontWeight: 700, fontSize: 14 }}>{qty}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onInc}
        aria-label="Increase quantity"
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: 'none',
          background: 'var(--sec-accent)',
          color: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Plus size={14} strokeWidth={2.5} />
      </button>
    </div>
  );
}

/**
 * Menu Maker–style browse: search, category + sub-category pills, item grid.
 * @param {'cart'|'manage'} mode
 */
export default function VenueMenuNavigator({
  items = [],
  mode = 'cart',
  selected = {},
  onChange,
  disabled = false,
  venueLogoUrl,
  renderManageActions,
}) {
  const money = useMoney();
  const [search, setSearch] = useState('');
  const [topCategory, setTopCategory] = useState(null);
  const [subCategory, setSubCategory] = useState('All');
  const [previewItem, setPreviewItem] = useState(null);

  const normalized = useMemo(() => items.map(normalizeItem), [items]);
  const filtered = useMemo(() => filterMenuBySearch(normalized, search), [normalized, search]);
  const hierarchy = useMemo(() => buildMenuHierarchy(filtered), [filtered]);

  const categories = hierarchy.categories;
  const activeTop = topCategory || categories[0]?.name || null;
  const activeCat = categories.find((c) => c.name === activeTop);
  const subcategories = activeCat?.subcategories || [];
  const activeSub =
    subcategories.find((s) => s.name === subCategory) ||
    subcategories.find((s) => s.name === 'All') ||
    subcategories[0];
  const displayItems = useMemo(() => {
    if (search.trim()) return filtered;
    const subItems = activeSub?.items || [];
    if (subItems.length > 0) return subItems;
    const allSub = subcategories.find((s) => s.name === 'All');
    if (allSub?.items?.length) return allSub.items;
    return subItems;
  }, [search, filtered, activeSub, subcategories]);

  if (!normalized.length) {
    return (
      <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>No menu items to show.</p>
    );
  }

  return (
    <div>
      {venueLogoUrl ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <img
            src={venueLogoUrl}
            alt=""
            style={{
              maxHeight: 48,
              maxWidth: 120,
              width: 'auto',
              height: 'auto',
              objectFit: 'contain',
              background: 'transparent',
            }}
          />
        </div>
      ) : null}

      <div
        className="sec-input-wrap"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
          padding: '0 12px',
          height: 42,
          borderRadius: 12,
          border: '1px solid var(--sec-border)',
          background: 'var(--sec-bg-card)',
        }}
      >
        <Search size={16} style={{ color: 'var(--sec-text-muted)', flexShrink: 0 }} />
        <input
          type="search"
          placeholder="Search menu..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            color: 'var(--sec-text-primary)',
            fontSize: 14,
            outline: 'none',
          }}
        />
      </div>

      {categories.length > 1 && !search.trim() ? (
        <div
          style={{
            display: 'flex',
            gap: 8,
            overflowX: 'auto',
            marginBottom: 10,
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {categories.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => {
                setTopCategory(c.name);
                setSubCategory('All');
              }}
              style={{
                flexShrink: 0,
                padding: '8px 16px',
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 600,
                border: `1px solid ${activeTop === c.name ? 'var(--sec-accent)' : 'var(--sec-border)'}`,
                background: activeTop === c.name ? 'var(--sec-accent-muted)' : 'var(--sec-bg-card)',
                color: activeTop === c.name ? 'var(--sec-accent)' : 'var(--sec-text-secondary)',
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
      ) : null}

      {subcategories.length > 1 && !search.trim() ? (
        <div
          style={{
            display: 'flex',
            gap: 6,
            overflowX: 'auto',
            marginBottom: 14,
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {subcategories.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setSubCategory(s.name)}
              style={{
                flexShrink: 0,
                padding: '6px 12px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 600,
                border: `1px solid ${subCategory === s.name ? 'var(--sec-text-primary)' : 'var(--sec-border)'}`,
                background: subCategory === s.name ? 'var(--sec-text-primary)' : 'var(--sec-bg-card)',
                color: subCategory === s.name ? '#000' : 'var(--sec-text-secondary)',
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}

      {activeSub && activeSub.name !== 'All' && !search.trim() ? (
        <p
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--sec-text-muted)',
            marginBottom: 10,
          }}
        >
          {activeSub.name}
        </p>
      ) : null}

      <div className="venue-menu-grid">
        {displayItems.map((item) => {
          const qty = Number(selected[item.id] || 0);
          return (
            <div
              key={item.id}
              className="sec-card"
              style={{
                padding: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                opacity: disabled ? 0.6 : 1,
              }}
            >
              {item.image_url ? (
                <button
                  type="button"
                  onClick={() => setPreviewItem(item)}
                  aria-label={`View photo of ${item.name}`}
                  style={{
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    width: '100%',
                    borderRadius: 10,
                    overflow: 'hidden',
                  }}
                >
                  <img
                    src={item.image_url}
                    alt=""
                    style={{ width: '100%', height: 72, objectFit: 'cover', display: 'block' }}
                  />
                </button>
              ) : (
                <div style={{ width: '100%', height: 72, borderRadius: 10, background: 'var(--sec-bg-hover)' }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{item.name}</div>
                {item.sub_category || item.subCategory ? (
                  <div style={{ fontSize: 10, color: 'var(--sec-text-muted)' }}>
                    {item.sub_category || item.subCategory}
                  </div>
                ) : null}
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--sec-accent)', marginTop: 4 }}>
                  {money.format(item.price)}
                </div>
              </div>
              {mode === 'cart' && onChange ? (
                <MenuQtyStepper
                  qty={qty}
                  disabled={disabled}
                  onDec={() => onChange(item.id, Math.max(0, qty - 1))}
                  onInc={() => onChange(item.id, qty + 1)}
                />
              ) : null}
              {mode === 'manage' && renderManageActions ? renderManageActions(item) : null}
            </div>
          );
        })}
      </div>

      {displayItems.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', marginTop: 12 }}>No items match your search.</p>
      ) : null}

      <MenuItemImagePreview
        open={Boolean(previewItem)}
        imageUrl={previewItem?.image_url}
        itemName={previewItem?.name}
        onClose={() => setPreviewItem(null)}
      />
    </div>
  );
}
