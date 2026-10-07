import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { format, parseISO, isToday, isTomorrow } from 'date-fns';
import { Clock, MapPin, Users } from 'lucide-react';
import { getEventImage, NIGHTLIFE_PLACEHOLDERS } from '@/lib/placeholders';
import { useMoney } from '@/hooks/useMoney';

export default function FeaturedEventCard({ event }) {
  const money = useMoney();
  const [imgError, setImgError] = useState(false);
  if (!event?.id) return null;

  const imgSrc = imgError ? NIGHTLIFE_PLACEHOLDERS.event : getEventImage(event?.cover_image_url);

  const getDateLabel = () => {
    if (!event.date) return '';
    const date = parseISO(event.date);
    if (isToday(date)) return 'Tonight';
    if (isTomorrow(date)) return 'Tomorrow';
    return format(date, 'EEE, MMM d');
  };

  return (
    <Link to={createPageUrl(`EventDetails?id=${event.id}`)} style={{ display: 'block', textDecoration: 'none' }}>
      <div
        style={{
          position: 'relative',
          height: 240,
          borderRadius: 'var(--radius-xl)',
          overflow: 'hidden',
          border: '1px solid var(--sec-border)',
          boxShadow: 'var(--shadow-card)',
          transition: 'border-color var(--transition-base), transform var(--transition-base)',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = 'var(--sec-border-hover)';
          e.currentTarget.style.transform = 'translateY(-2px)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = 'var(--sec-border)';
          e.currentTarget.style.transform = 'translateY(0)';
        }}
      >
        {/* Hero image */}
        <img
          src={imgSrc}
          alt={event.title}
          onError={() => setImgError(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          loading="lazy"
        />

        {/* Gradient overlay — stronger at bottom */}
        <div className="sec-overlay" style={{ position: 'absolute', inset: 0 }} />

        {/* Top-left: Date chip */}
        <div style={{
          position: 'absolute', top: 12, left: 12,
          backgroundColor: 'rgba(0,0,0,0.75)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 'var(--radius-pill)',
          padding: '5px 12px',
          fontSize: 11, fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'var(--sec-text-secondary)',
        }}>
          {getDateLabel()}
        </div>

        {/* Top-right: Featured badge */}
        {event.is_featured && (
          <div style={{ position: 'absolute', top: 12, right: 12 }}>
            <span className="sec-badge-pill sec-badge-gold"
              style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
              Featured
            </span>
          </div>
        )}

        {/* Bottom content */}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '16px 16px 18px' }}>
          <h3 style={{
            fontSize: 16, fontWeight: 700, color: 'var(--sec-text-primary)',
            marginBottom: 8, letterSpacing: '-0.02em',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {event.title}
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>
            {event.start_time && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Clock size={11} strokeWidth={1.5} />
                {event.start_time}
              </span>
            )}
            {event.city && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <MapPin size={11} strokeWidth={1.5} />
                {event.city}
              </span>
            )}
            {event.has_entrance_fee && event.entrance_fee_amount > 0 && (
              <span style={{ fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>
                Door {money.format(event.entrance_fee_amount)}
              </span>
            )}
            {event.total_attending > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Users size={11} strokeWidth={1.5} />
                {event.total_attending}
              </span>
            )}
          </div>
          {event.stats?.general && event.stats?.vip && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.35 }}>
              Table slots · Gen{' '}
              {event.stats.general.tables_remaining ?? '—'}
              {' · VIP '}
              {event.stats.vip.tables_remaining ?? '—'}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
