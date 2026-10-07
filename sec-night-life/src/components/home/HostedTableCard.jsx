import React from 'react';
import { Link } from 'react-router-dom';
import { MapPin, Star, Users } from 'lucide-react';
import { createPageUrl } from '@/utils';
import { hostedListingDetailsPath } from '@/lib/hostedListingUrl';
import { useMoney } from '@/hooks/useMoney';

export default function HostedTableCard({
  table,
  onJoin,
  compact = false,
  layout = 'card',
  footer = null,
}) {
  const money = useMoney();
  const title = table?.tableName || table?.venueName || 'Hosted table';
  const location = table?.displayLocation || table?.eventLocation?.displayLabel || table?.event?.city || table?.venueName;
  const hostName = table?.host?.username || table?.host?.fullName || 'Host';
  const rating = table?.host?.averageRating;
  const isVip = String(table?.hostingCategory || '').toUpperCase() === 'VIP';
  const sourceBadge = table?.tableType === 'IN_APP_EVENT' ? 'SEC event' : 'External';
  const joinedCount =
    table?.joinedCount != null
      ? Number(table.joinedCount)
      : Math.max(0, Number(table?.guestQuantity || 0) - Number(table?.spotsRemaining || 0));
  const joinLabel = table?.isPublic === false ? 'Request to join' : 'Join table';
  const joinFee =
    table?.hasJoiningFee && Number(table?.joiningFee || 0) > 0
      ? ` · ${money.format(table.joiningFee)} to join`
      : ' · Free join';

  const isPageLayout = layout === 'page';

  return (
    <div
      className="sec-card"
      style={{
        padding: 0,
        borderRadius: isPageLayout ? 18 : 14,
        border: table?.boosted ? '1px solid var(--sec-accent-border)' : '1px solid var(--sec-border)',
        background: table?.boosted ? 'var(--sec-bg-elevated)' : 'var(--sec-bg-card)',
        overflow: 'hidden',
        width: '100%',
      }}
    >
      {table?.photo ? (
        <img
          src={table.photo}
          alt=""
          style={{
            width: '100%',
            height: compact ? 120 : isPageLayout ? 200 : 140,
            objectFit: 'cover',
            display: 'block',
          }}
        />
      ) : null}
      <div style={{ padding: isPageLayout ? '18px 18px 16px' : compact ? 12 : 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: isPageLayout ? 18 : 14, lineHeight: 1.3 }}>{title}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
            <span className="sec-badge sec-badge-muted">{sourceBadge}</span>
            {isVip ? <span className="sec-badge sec-badge-gold">VIP</span> : <span className="sec-badge sec-badge-success">General</span>}
            {table?.isPublic === false ? <span className="sec-badge sec-badge-muted">Private</span> : null}
          </div>
        </div>

        {table?.tableDescription && isPageLayout ? (
          <p style={{ marginTop: 8, fontSize: 14, lineHeight: 1.5, color: 'var(--sec-text-muted)' }}>
            {table.tableDescription}
          </p>
        ) : null}

        <div
          style={{
            marginTop: 10,
            fontSize: isPageLayout ? 14 : 12,
            color: 'var(--sec-text-muted)',
            display: 'flex',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <MapPin size={isPageLayout ? 15 : 13} style={{ flexShrink: 0 }} />
          <span>{location || 'Location TBC'}</span>
        </div>

        <div style={{ marginTop: 8, fontSize: isPageLayout ? 14 : 12, color: 'var(--sec-text-secondary)' }}>
          Host: {hostName}
          {rating != null ? (
            <span style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Star size={12} /> {Number(rating).toFixed(1)}
            </span>
          ) : null}
        </div>

        <div
          style={{
            marginTop: 8,
            fontSize: isPageLayout ? 14 : 12,
            color: 'var(--sec-text-secondary)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            flexWrap: 'wrap',
          }}
        >
          <Users size={isPageLayout ? 15 : 13} />
          {joinedCount} joined · {table?.spotsRemaining ?? 0} spots left{joinFee}
        </div>

        <div
          className="hosted-table-card-actions"
          style={{
            display: 'flex',
            flexDirection: isPageLayout ? 'column' : 'row',
            gap: 10,
            marginTop: isPageLayout ? 18 : 12,
          }}
        >
          <button
            type="button"
            className={`sec-btn sec-btn-accent ${isPageLayout ? 'sec-btn-lg sec-btn-full' : 'sec-btn-md'}`}
            style={{ flex: isPageLayout ? undefined : 1, minHeight: isPageLayout ? 48 : 44 }}
            onClick={() => onJoin?.(table)}
          >
            {joinLabel}
          </button>
          <Link
            to={hostedListingDetailsPath(table)}
            className={`sec-btn sec-btn-secondary ${isPageLayout ? 'sec-btn-lg sec-btn-full' : 'sec-btn-md'}`}
            style={{
              flex: isPageLayout ? undefined : 1,
              textAlign: 'center',
              textDecoration: 'none',
              minHeight: isPageLayout ? 48 : 44,
            }}
          >
            View details
          </Link>
        </div>

        {footer ? <div style={{ marginTop: 12 }}>{footer}</div> : null}
      </div>
    </div>
  );
}
