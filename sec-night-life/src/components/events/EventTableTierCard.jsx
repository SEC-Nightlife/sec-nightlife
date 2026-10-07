import React from 'react';
import { Crown } from 'lucide-react';

import { formatWindowLabel, isOvernightWindow } from '@/lib/dayBookingSlotUtils';
import { useMoney } from '@/hooks/useMoney';

export default function EventTableTierCard({ tier, onSelect, venueWindow }) {
  const money = useMoney();
  if (!tier) return null;
  const formatZar = (n) => (Number(n) > 0 ? money.format(n) : 'Free');
  const isVip = tier.category === 'vip';

  return (
    <button
      type="button"
      onClick={() => onSelect?.(tier)}
      className="sec-card"
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '16px 18px',
        border: '1px solid var(--sec-border)',
        background: 'linear-gradient(145deg, var(--sec-bg-card) 0%, var(--sec-bg-elevated) 100%)',
        cursor: 'pointer',
        transition: 'border-color 0.2s, transform 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--sec-accent-border)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--sec-border)';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--sec-text-primary)', margin: 0 }}>
              {tier.tierName}
            </h3>
            {isVip ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 6,
                  backgroundColor: 'var(--sec-accent-muted)',
                  color: 'var(--sec-accent)',
                  border: '1px solid var(--sec-accent-border)',
                }}
              >
                <Crown size={10} />
                VIP
              </span>
            ) : null}
          </div>
          <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', margin: 0 }}>
            Up to {tier.maxGuestsPerTable} guests per table
          </p>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--sec-accent)',
            whiteSpace: 'nowrap',
            padding: '4px 10px',
            borderRadius: 'var(--radius-pill)',
            backgroundColor: 'var(--sec-accent-muted)',
            border: '1px solid var(--sec-accent-border)',
          }}
        >
          {tier.totalSpotsRemaining} spots left
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '8px 16px',
          fontSize: 12,
          color: 'var(--sec-text-secondary)',
          marginBottom: 10,
        }}
      >
        {Number(tier.minSpendJoin ?? tier.minSpend) !== Number(tier.minSpendHost ?? tier.minSpendJoin ?? tier.minSpend) ? (
          <>
            <div>
              <span style={{ color: 'var(--sec-text-muted)', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Min spend (join)
              </span>
              <span style={{ fontWeight: 600, color: 'var(--sec-text-primary)' }}>
                {formatZar(tier.minSpendJoin ?? tier.minSpend)}
              </span>
            </div>
            <div>
              <span style={{ color: 'var(--sec-text-muted)', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Min spend (host)
              </span>
              <span style={{ fontWeight: 600, color: 'var(--sec-text-primary)' }}>
                {formatZar(tier.minSpendHost ?? tier.minSpendJoin ?? tier.minSpend)}
              </span>
            </div>
          </>
        ) : (
          <div>
            <span style={{ color: 'var(--sec-text-muted)', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Min spend
            </span>
            <span style={{ fontWeight: 600, color: 'var(--sec-text-primary)' }}>
              {formatZar(tier.minSpendJoin ?? tier.minSpend)}
            </span>
          </div>
        )}
        {Number(tier.hostBookingFeeZar) > 0 ? (
        <div>
          <span style={{ color: 'var(--sec-text-muted)', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Host from
          </span>
          <span style={{ fontWeight: 600, color: 'var(--sec-text-primary)' }}>{formatZar(tier.hostBookingFeeZar)}</span>
        </div>
        ) : null}
        {Number(tier.joinBookingFeeZar) > 0 ? (
        <div>
          <span style={{ color: 'var(--sec-text-muted)', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Join from
          </span>
          <span style={{ fontWeight: 600, color: 'var(--sec-text-primary)' }}>{formatZar(tier.joinBookingFeeZar)}</span>
        </div>
        ) : null}
        <div>
          <span style={{ color: 'var(--sec-text-muted)', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Tables open
          </span>
          <span style={{ fontWeight: 600, color: 'var(--sec-text-primary)' }}>
            {(() => {
              const host = tier.tablesOpenForHost || 0;
              const join = tier.tablesOpenForJoin || 0;
              if (host > 0 && join > 0) return `${host} to host · ${join} to join`;
              if (host > 0) return `${host} to host`;
              if (join > 0) return `${join} to join`;
              return 'None';
            })()}
          </span>
        </div>
      </div>

      <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', margin: 0 }}>
        {venueWindow
          ? `Open ${formatWindowLabel(venueWindow.startTime, venueWindow.endTime, isOvernightWindow(venueWindow.startTime, venueWindow.endTime))} · Tap to choose a table`
          : 'Tap to host or join a table in this tier'}
      </p>
    </button>
  );
}
