import React, { useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import SecLogo from '@/components/ui/SecLogo';
import { menuSelectionTotal, menuSelectionToPayload } from '@/components/menu/MenuPicker';
import { useMoney } from '@/hooks/useMoney';

export function CustomTableRequestForm({
  onSubmit,
  submitting = false,
  venueMenuItems = [],
  selectedMenuItems = {},
  onBack,
  compact = false,
  defaultWindow = null,
}) {
  const money = useMoney();
  const [minSpendMode, setMinSpendMode] = useState('manual');
  const [form, setForm] = useState({
    guestCount: 4,
    preferredDate: '',
    preferredTime: defaultWindow?.startTime || '',
    preferredEndTime: defaultWindow?.endTime || '',
    proposedMinimumSpend: '',
    notes: '',
  });

  const menuPayload = useMemo(
    () => menuSelectionToPayload(venueMenuItems, selectedMenuItems),
    [venueMenuItems, selectedMenuItems],
  );

  const menuTotal = useMemo(() => {
    if (minSpendMode !== 'menu') return 0;
    return menuSelectionTotal(venueMenuItems, selectedMenuItems);
  }, [venueMenuItems, selectedMenuItems, minSpendMode]);

  const today = new Date().toISOString().slice(0, 10);
  const itemCount = menuPayload.reduce((n, l) => n + l.quantity, 0);

  const handleSubmit = () => {
    const selectedItems =
      minSpendMode === 'menu' && menuPayload.length > 0
        ? menuPayload.map(({ menuItemId, quantity }) => ({ menuItemId, quantity }))
        : undefined;
    onSubmit?.({
      guestCount: form.guestCount,
      preferredDate: form.preferredDate || undefined,
      proposedMinimumSpend:
        minSpendMode === 'manual' && form.proposedMinimumSpend
          ? parseFloat(form.proposedMinimumSpend)
          : minSpendMode === 'menu' && menuTotal > 0
            ? menuTotal
            : undefined,
      notes: form.notes,
      preferredTime: form.preferredTime,
      preferredEndTime: form.preferredEndTime || undefined,
      minSpendMode,
      selectedMenuItems: selectedItems,
    });
  };

  const canSubmit =
    !submitting &&
    form.preferredTime &&
    form.preferredEndTime &&
    form.preferredEndTime > form.preferredTime &&
    (minSpendMode === 'manual'
      ? Boolean(form.proposedMinimumSpend)
      : menuTotal > 0);

  return (
    <div className="custom-table-request-form" style={{ display: 'flex', flexDirection: 'column', gap: compact ? 12 : 16 }}>
      <div
        style={{
          background: 'var(--sec-gradient-silver)',
          borderRadius: 'var(--radius-lg)',
          padding: compact ? '14px 16px' : '16px 18px',
          position: 'relative',
        }}
      >
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="sec-btn sec-btn-ghost sec-btn-sm"
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              background: 'rgba(0,0,0,0.35)',
              color: '#fff',
              border: 'none',
              borderRadius: '50%',
              width: 32,
              height: 32,
              padding: 0,
            }}
            aria-label="Back to menu"
          >
            <ChevronLeft size={16} />
          </button>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <SecLogo size={compact ? 36 : 44} variant="mark" asset="transparent" className="custom-table-request-modal__logo" />
          <h2 style={{ fontSize: compact ? 16 : 18, fontWeight: 700, color: '#111', margin: 0 }}>Custom table request</h2>
        </div>
        <p style={{ fontSize: 13, color: 'rgba(0,0,0,0.65)', margin: 0 }}>
          Tell the venue what you need. They review before you pay.
        </p>
      </div>

      {itemCount > 0 ? (
        <div
          className="rounded-xl border p-3"
          style={{ borderColor: 'var(--sec-border)', backgroundColor: 'var(--sec-bg-card)' }}
        >
          <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--sec-text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Menu selection ({itemCount} item{itemCount === 1 ? '' : 's'})
          </p>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 13 }}>
            {menuPayload.map((line) => (
              <li key={line.menuItemId} style={{ marginBottom: 4 }}>
                {line.quantity}× {line.name}
                {line.unitPrice > 0 ? ` · ${money.format(line.unitPrice * line.quantity)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--sec-text-secondary)', display: 'block', marginBottom: 8 }}>
          Guest count
        </label>
        <input
          type="number"
          min={1}
          max={500}
          value={form.guestCount}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            setForm((f) => ({
              ...f,
              guestCount: Number.isFinite(n) ? Math.min(500, Math.max(1, n)) : 1,
            }));
          }}
          className="w-full"
          style={{
            height: 44,
            padding: '0 14px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--sec-border)',
            backgroundColor: 'var(--sec-bg-card)',
            color: 'var(--sec-text-primary)',
            fontSize: 14,
          }}
        />
      </div>

      <div className="custom-table-request-form__datetime" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--sec-text-secondary)', display: 'block', marginBottom: 8 }}>
            Preferred date
          </label>
          <input
            type="date"
            min={today}
            value={form.preferredDate}
            onChange={(e) => setForm((f) => ({ ...f, preferredDate: e.target.value }))}
            className="w-full"
            style={{
              height: 44,
              padding: '0 14px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--sec-border)',
              backgroundColor: 'var(--sec-bg-card)',
              color: 'var(--sec-text-primary)',
              fontSize: 14,
            }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--sec-text-secondary)', display: 'block', marginBottom: 8 }}>
            Preferred start time
          </label>
          <input
            type="time"
            value={form.preferredTime}
            onChange={(e) => setForm((f) => ({ ...f, preferredTime: e.target.value }))}
            className="w-full"
            style={{
              height: 44,
              padding: '0 14px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--sec-border)',
              backgroundColor: 'var(--sec-bg-card)',
              color: 'var(--sec-text-primary)',
              fontSize: 14,
            }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--sec-text-secondary)', display: 'block', marginBottom: 8 }}>
            Preferred end time
          </label>
          <input
            type="time"
            value={form.preferredEndTime}
            min={form.preferredTime || undefined}
            onChange={(e) => setForm((f) => ({ ...f, preferredEndTime: e.target.value }))}
            className="w-full"
            style={{
              height: 44,
              padding: '0 14px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--sec-border)',
              backgroundColor: 'var(--sec-bg-card)',
              color: 'var(--sec-text-primary)',
              fontSize: 14,
            }}
          />
        </div>
      </div>

      <div>
        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--sec-text-secondary)', marginBottom: 8 }}>Minimum spend</p>
        <div className="flex gap-2 mb-3">
          <button
            type="button"
            className="flex-1 text-xs py-2.5 rounded-full border min-h-[44px]"
            style={{
              borderColor: minSpendMode === 'menu' ? 'var(--sec-accent-border)' : 'var(--sec-border)',
              background: minSpendMode === 'menu' ? 'var(--sec-accent-muted)' : 'transparent',
            }}
            onClick={() => setMinSpendMode('menu')}
          >
            From menu
          </button>
          <button
            type="button"
            className="flex-1 text-xs py-2.5 rounded-full border min-h-[44px]"
            style={{
              borderColor: minSpendMode === 'manual' ? 'var(--sec-accent-border)' : 'var(--sec-border)',
              background: minSpendMode === 'manual' ? 'var(--sec-accent-muted)' : 'transparent',
            }}
            onClick={() => setMinSpendMode('manual')}
          >
            Type amount
          </button>
        </div>
        {minSpendMode === 'menu' ? (
          <div
            className="rounded-xl border p-3"
            style={{ borderColor: 'var(--sec-border)', backgroundColor: 'var(--sec-bg-card)' }}
          >
            {menuTotal > 0 ? (
              <p className="text-sm" style={{ color: 'var(--sec-accent)', fontWeight: 600, margin: 0 }}>
                Estimated total: {money.format(menuTotal)}
              </p>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', margin: 0 }}>
                Go back and add items from the menu, or switch to type an amount.
              </p>
            )}
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--sec-text-muted)', fontSize: 14 }}>R</span>
            <input
              type="number"
              min={0}
              value={form.proposedMinimumSpend}
              onChange={(e) => setForm((f) => ({ ...f, proposedMinimumSpend: e.target.value }))}
              placeholder="e.g. 5000"
              style={{
                width: '100%',
                height: 44,
                padding: '0 14px 0 28px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--sec-border)',
                backgroundColor: 'var(--sec-bg-card)',
                color: 'var(--sec-text-primary)',
                fontSize: 14,
              }}
            />
          </div>
        )}
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--sec-text-secondary)', display: 'block', marginBottom: 8 }}>
          Notes for the venue
        </label>
        <Textarea
          rows={2}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          placeholder="Seating preferences, occasion, special requests…"
          style={{
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--sec-border)',
            backgroundColor: 'var(--sec-bg-card)',
            color: 'var(--sec-text-primary)',
          }}
        />
      </div>

      <button
        type="button"
        disabled={!canSubmit}
        className="sec-btn sec-btn-primary sec-btn-full"
        style={{ height: 48, minHeight: 44 }}
        onClick={handleSubmit}
      >
        {submitting ? 'Submitting…' : 'Submit request for review'}
      </button>
    </div>
  );
}

/** @deprecated Use step-based CustomTableRequestForm in TableDetails instead. */
export default function CustomTableRequestModal(props) {
  if (!props.open) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <CustomTableRequestForm {...props} />
    </div>
  );
}
