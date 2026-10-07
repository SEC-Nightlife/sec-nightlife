import React from 'react';
import { Globe, MapPin, Flag } from 'lucide-react';
import { usePreferences } from '@/context/PreferencesContext';
import { FEED_SCOPE_LABELS } from '@/hooks/useFeedScope';
import { countryName } from '@/lib/countries';

const OPTIONS = [
  { value: 'local', icon: MapPin },
  { value: 'national', icon: Flag },
  { value: 'worldwide', icon: Globe },
];

/** Segmented control for what feeds show: near me, my country, or worldwide. */
export default function FeedScopeToggle({ compact = false }) {
  const { feedScope, setFeedScope, viewerCountryCode } = usePreferences();
  const nationalLabel = viewerCountryCode ? countryName(viewerCountryCode) : FEED_SCOPE_LABELS.national;
  return (
    <div
      role="radiogroup"
      aria-label="Show content from"
      style={{
        display: 'inline-flex',
        padding: 3,
        gap: 2,
        borderRadius: 999,
        background: 'var(--sec-bg-card)',
        border: '1px solid var(--sec-border)',
        maxWidth: '100%',
      }}
    >
      {OPTIONS.map(({ value, icon: Icon }) => {
        const active = feedScope === value;
        const label = value === 'national' ? nationalLabel : FEED_SCOPE_LABELS[value];
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={label}
            onClick={() => setFeedScope(value)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: compact ? '6px 9px' : '7px 12px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              background: active ? 'var(--sec-accent)' : 'transparent',
              color: active ? 'var(--sec-bg-base)' : 'var(--sec-text-secondary)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <Icon size={13} strokeWidth={2} />
            {compact && !active ? null : <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
