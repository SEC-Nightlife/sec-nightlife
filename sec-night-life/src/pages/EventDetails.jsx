import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { createPageUrl, buildPageUrl, storePromoterRef } from '@/utils';
import { mobileBackNavigate } from '@/lib/mobileBackNavigation';
import { useIsMobile } from '@/hooks/useIsDesktop';
import * as authService from '@/services/authService';
import { useAuth } from '@/lib/AuthContext';
import { dataService } from '@/services/dataService';
import { apiGet, apiPatch } from '@/api/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ChevronLeft, Share2, Heart, Calendar, Clock, MapPin,
  Users, Ticket, BadgeCheck, Music, Star, ChevronRight, Navigation, Sparkles,
} from 'lucide-react';
import { format, parseISO, isToday, isTomorrow } from 'date-fns';

import EventTableTierCard from '@/components/events/EventTableTierCard';
import EventTableTierSheet from '@/components/events/EventTableTierSheet';
import SeatingPlanCTA from '@/components/seating/SeatingPlanCTA';
import SeatingPlanViewer from '@/components/seating/SeatingPlanViewer';
import { normalizeGuestSeatingPlans } from '@/lib/seatingPlanUtils';
import EventShareModal from '@/components/events/EventShareModal';
import ReportDialog from '@/components/moderation/ReportDialog';
import HostedTableExperience from '@/components/tables/HostedTableExperience';
import { isHostedEventListing } from '@/lib/hostedListingUrl';
import { parseMaxPerUser } from '@/lib/ticketTierLimits';
import { getDirectionsActions } from '@/lib/openDirections';
import { isEventEnded } from '@/lib/eventLifecycle';
import { useMoney } from '@/hooks/useMoney';

export default function EventDetails() {
  const money = useMoney();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const { user: authUser, userProfile: authProfile, isAuthenticated } = useAuth();
  const [user, setUser] = useState(authUser);
  const [userProfile, setUserProfile] = useState(authProfile);
  const [isInterested, setIsInterested] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [selectedTier, setSelectedTier] = useState(null);
  const [promoterBanner, setPromoterBanner] = useState(null);
  const [seatingViewerOpen, setSeatingViewerOpen] = useState(false);

  const urlParams = new URLSearchParams(window.location.search);
  const eventId = urlParams.get('id');
  const refPromoterId = urlParams.get('ref');
  const source = urlParams.get('source');
  const isHostedSource = source === 'hosted';
  const autoJoin = urlParams.get('join');
  const checkoutParam = urlParams.get('checkout');

  useEffect(() => {
    if (authUser) setUser(authUser);
    if (authProfile) setUserProfile(authProfile);
  }, [authUser, authProfile]);

  useEffect(() => {
    loadUser();
  }, [eventId]);

  const requireSignedIn = () => {
    if (user || authUser || isAuthenticated || authService.hasRefreshSession()) {
      return true;
    }
    authService.redirectToLogin(window.location.href, { force: true });
    return false;
  };

  const loadUser = async () => {
    try {
      let currentUser = authUser;
      if (!currentUser) {
        if (!authService.hasRefreshSession()) return;
        try {
          const session = await authService.resolveUserForAction(window.location.href);
          currentUser = session.user;
        } catch (err) {
          if (err?.name === 'AuthRequiredError') return;
          // Soft fail: keep AuthContext / cached user; never treat as logged out.
          return;
        }
      }
      if (currentUser) setUser(currentUser);
      let profile = authProfile;
      if (!profile) {
        try {
          const rows = await apiGet('/api/users/profile');
          profile = Array.isArray(rows) ? rows[0] : rows;
        } catch {
          /* fallback below */
        }
      }
      if (!profile && currentUser?.email) {
        try {
          const profiles = await dataService.User.filter({ created_by: currentUser.email });
          profile = profiles[0];
        } catch {
          /* no profile */
        }
      }
      if (profile) {
        setUserProfile(profile);
        setIsInterested(!!eventId && profile.interested_events?.includes(eventId));
      } else if (!authProfile) {
        setIsInterested(false);
      }
    } catch {
      // Never clear user while a refresh session may still exist.
    }
  };

  const { data: hostedTable, isLoading: hostedLoading } = useQuery({
    queryKey: ['hosted-table-detail', eventId],
    queryFn: async () => {
      try {
        return await apiGet(`/api/host/hosted-tables/${eventId}`);
      } catch {
        return null;
      }
    },
    enabled: !!eventId && isHostedSource,
    retry: false,
  });

  useEffect(() => {
    if (!isHostedSource || !hostedTable?.kind) return;
    if (!isHostedEventListing(hostedTable)) {
      navigate(buildPageUrl('TableDetails', { id: eventId, source: 'hosted' }), { replace: true });
    }
  }, [isHostedSource, hostedTable, eventId, navigate]);

  const { data: event, isLoading } = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => apiGet(`/api/events/${eventId}`),
    enabled: !!eventId && !isHostedSource,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const eventEnded = Boolean(event?.ended) || isEventEnded(event);

  useEffect(() => {
    if (!eventId || !refPromoterId) return;
    (async () => {
      try {
        const assigned = await apiGet(`/api/events/${eventId}/promoters`);
        const match = (assigned?.data || []).find((p) => p.promoterUserId === refPromoterId);
        if (match) {
          storePromoterRef(eventId, refPromoterId);
          setPromoterBanner(match);
        }
      } catch {
        /* ignore invalid ref */
      }
    })();
  }, [eventId, refPromoterId]);

  const { data: venue } = useQuery({
    queryKey: ['venue', event?.venue_id],
    queryFn: async () => {
      const venues = await dataService.Venue.filter({ id: event.venue_id });
      return venues[0];
    },
    enabled: !!event?.venue_id,
  });

  const { data: tableTiersData } = useQuery({
    queryKey: ['event-table-tiers', eventId],
    queryFn: () => apiGet(`/api/events/${encodeURIComponent(eventId)}/table-tiers`),
    enabled: !!eventId,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const tableTiers = eventEnded ? [] : (tableTiersData?.tiers ?? []);
  const customListingId = tableTiersData?.customListingId ?? null;
  const allowsCustomRequests = tableTiersData?.allowsCustomRequests ?? false;
  const seatingPlans = normalizeGuestSeatingPlans(tableTiersData);
  const seatingPlan = seatingPlans[0] ?? null;

  const toggleInterestMutation = useMutation({
    mutationFn: async () => {
      if (!requireSignedIn()) {
        throw new Error('Sign in required');
      }
      const newInterested = !isInterested;
      const base = userProfile?.interested_events || [];
      const updatedEvents = newInterested
        ? [...new Set([...base, eventId])]
        : base.filter((id) => id !== eventId);
      const res = await apiPatch('/api/users/profile', { interested_events: updatedEvents });
      return { newInterested, profile: res };
    },
    onSuccess: ({ newInterested, profile }) => {
      if (profile && typeof profile === 'object') {
        setUserProfile(profile);
        setIsInterested(profile.interested_events?.includes(eventId) || false);
      } else {
        setIsInterested(newInterested);
      }
      toast.success(newInterested ? 'Added to interested events' : 'Removed from interested events', {
        action: newInterested
          ? {
              label: 'View on Events',
              onClick: () => navigate(createPageUrl('Events')),
            }
          : undefined,
      });
      queryClient.invalidateQueries(['event', eventId]);
      queryClient.invalidateQueries({ queryKey: ['user-profile'] });
    },
    onError: (err) => {
      if (err?.message !== 'Sign in required') {
        toast.error(err?.message || 'Could not update your saved events');
      }
    },
  });

  if (isHostedSource) {
    if (hostedLoading) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
          <div className="sec-spinner" />
        </div>
      );
    }
    if (hostedTable?.kind === 'hosted' && isHostedEventListing(hostedTable)) {
      return (
        <HostedTableExperience
          tableId={eventId}
          hostedTable={hostedTable}
          user={user}
          userProfile={userProfile}
          autoOpenJoin={autoJoin === '1' || autoJoin === 'true'}
          autoOpenCheckout={checkoutParam === '1'}
          onBack={() => navigate(-1)}
        />
      );
    }
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Event not found</h2>
          <Link to={createPageUrl('Events')} className="sec-link" style={{ color: 'var(--sec-text-secondary)' }}>
            Browse Events
          </Link>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
        <div className="sec-spinner" />
      </div>
    );
  }

  if (!event) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Event not found</h2>
          <Link to={createPageUrl('Events')} className="sec-link" style={{ color: 'var(--sec-text-secondary)' }}>
            Browse Events
          </Link>
        </div>
      </div>
    );
  }

  const getDateLabel = () => {
    if (!event.date) return '';
    const date = parseISO(event.date);
    if (isToday(date)) return 'Tonight';
    if (isTomorrow(date)) return 'Tomorrow';
    return format(date, 'EEEE, MMMM d');
  };

  const lowestTicketPrice = event.ticket_tiers?.reduce((min, tier) =>
    tier.price < min ? tier.price : min, event.ticket_tiers?.[0]?.price || 0
  );

  const totalSpotsRemaining = tableTiers.reduce((sum, t) => sum + Number(t.totalSpotsRemaining || 0), 0);

  const venueLine =
    [event.venue_address, event.venue_suburb, event.venue_city || venue?.city]
      .filter(Boolean)
      .join(', ') || event.city || venue?.city || 'TBA';

  const mapQuery = event.venue_address || venue?.address || venueLine;

  return (
    <div className="pb-24 lg:pb-8" style={{ minHeight: '100vh', backgroundColor: 'var(--sec-bg-base)' }}>

      {/* ── Hero image ── */}
      <div style={{ position: 'relative', height: 300 }}>
        {event.cover_image_url ? (
          <img
            src={event.cover_image_url}
            alt={event.title}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div style={{
            width: '100%', height: '100%',
            background: 'linear-gradient(135deg, #141414 0%, #0A0A0A 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Calendar size={48} strokeWidth={1} style={{ color: 'var(--sec-border-strong)' }} />
          </div>
        )}
        {/* Overlay */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(to top, var(--sec-bg-base) 0%, rgba(0,0,0,0.5) 50%, rgba(0,0,0,0.25) 100%)',
        }} />

        {/* Top controls */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px',
        }}>
          <button
            onClick={() => {
              if (isMobile) mobileBackNavigate(navigate, setSearchParams, 'EventDetails', searchParams);
              else navigate(-1);
            }}
            style={{
              width: 40, height: 40, borderRadius: '50%',
              backgroundColor: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
              border: '1px solid rgba(255,255,255,0.10)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--sec-text-primary)',
            }}
          >
            <ChevronLeft size={20} strokeWidth={2} />
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {user && (
              <button
                type="button"
                onClick={() => toggleInterestMutation.mutate()}
                disabled={toggleInterestMutation.isPending}
                style={{
                  width: 40, height: 40, borderRadius: '50%',
                  backgroundColor: isInterested ? 'rgba(61,186,107,0.9)' : 'rgba(0,0,0,0.55)',
                  backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: 'var(--sec-text-primary)',
                }}
                aria-label={isInterested ? 'Interested' : 'Mark interested'}
              >
                {isInterested ? (
                  <BadgeCheck size={18} strokeWidth={2} />
                ) : (
                  <Heart size={18} strokeWidth={1.5} />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              style={{
                width: 40, height: 40, borderRadius: '50%',
                backgroundColor: 'rgba(0,0,0,0.55)',
                backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                border: '1px solid rgba(255,255,255,0.10)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', color: 'var(--sec-text-primary)',
              }}
            >
              <Share2 size={18} strokeWidth={1.5} />
            </button>
            {user && (
              <ReportDialog
                targetType="event"
                targetId={eventId}
                targetLabel={event.title}
                triggerLabel="Report"
                triggerClassName="min-h-[40px] px-3"
              />
            )}
          </div>
        </div>

        {/* Age badge */}
        {event.age_limit && (
          <div style={{
            position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
            padding: '4px 14px', borderRadius: 'var(--radius-pill)',
            backgroundColor: 'rgba(0,0,0,0.60)', backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.10)',
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--sec-text-primary)' }}>
              {event.age_limit}+
            </span>
          </div>
        )}
      </div>

      {/* ── Content ── */}
      <div style={{ maxWidth: 960, margin: '-24px auto 0', padding: '0 20px', position: 'relative' }}>

        {/* Title + venue */}
        <div style={{ marginBottom: 20 }}>
          {promoterBanner ? (
            <div
              className="sec-card"
              style={{
                padding: '10px 14px',
                marginBottom: 12,
                fontSize: 13,
                color: 'var(--sec-text-muted)',
                borderColor: 'var(--sec-accent-border)',
              }}
            >
              Promoted by{' '}
              <Link
                to={`${createPageUrl('UserProfile')}?id=${encodeURIComponent(promoterBanner.promoterUserId)}`}
                style={{ color: 'var(--sec-accent)', fontWeight: 600, textDecoration: 'none' }}
              >
                @{promoterBanner.username || promoterBanner.fullName || 'promoter'}
              </Link>
            </div>
          ) : null}
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8, letterSpacing: '-0.02em', color: 'var(--sec-text-primary)' }}>
            {event.title}
          </h1>
          {venue && (
            <Link
              to={createPageUrl(`VenueProfile?id=${venue.id}`)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                color: 'var(--sec-text-muted)', textDecoration: 'none',
                fontSize: 14, transition: 'color 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--sec-text-secondary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--sec-text-muted)'}
            >
              {venue.logo_url && (
                <img src={venue.logo_url} alt="" style={{ width: 20, height: 20, borderRadius: '50%', objectFit: 'cover' }} />
              )}
              <span>{venue.name}</span>
              {venue.is_verified && <BadgeCheck size={14} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />}
              <ChevronRight size={14} strokeWidth={1.5} />
            </Link>
          )}
          {user && isInterested && (
            <p style={{ marginTop: 12, fontSize: 13, color: 'var(--sec-text-muted)', lineHeight: 1.5 }}>
              Saved — find this and your other picks on the{' '}
              <Link to={createPageUrl('Events')} className="sec-link" style={{ color: 'var(--sec-accent)', fontWeight: 600 }}>
                Events
              </Link>{' '}
              page.
            </p>
          )}
        </div>

        {/* ── Quick info grid — 4 tiles ── */}
        <div className="sec-card" style={{ padding: 16, marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {[
              { icon: Calendar, label: 'Date', value: getDateLabel() },
              { icon: Clock, label: 'Time', value: event.start_time || 'TBA' },
              { icon: MapPin, label: 'Location', value: venueLine },
              {
                icon: Users,
                label: eventEnded ? 'Attended' : 'Going',
                value: `${event.attendee_count ?? event.stats?.going_count ?? event.total_attending ?? 0} people`,
              },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 'var(--radius-md)',
                  backgroundColor: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <Icon size={16} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
                </div>
                <div>
                  <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginBottom: 2, fontWeight: 500 }}>{label}</p>
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>{value}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {event.stats && tableTiers.length > 0 && (
          <div className="sec-card" style={{ padding: 16, marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: 'var(--sec-text-primary)' }}>Tables & attendance</h2>
            <div style={{ display: 'grid', gap: 10, fontSize: 13, color: 'var(--sec-text-muted)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>Going</span>
                <span style={{ color: 'var(--sec-text-primary)', fontWeight: 600 }}>{event.stats.going_count ?? 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>Hosted tables (all)</span>
                <span style={{ color: 'var(--sec-text-primary)', fontWeight: 600 }}>{event.stats.hosted_tables}</span>
              </div>
              {event.stats.general && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--sec-text-primary)', marginTop: 4 }}>General</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingLeft: 8 }}>
                    <span>Slots left</span>
                    <span style={{ color: 'var(--sec-text-primary)', fontWeight: 600 }}>
                      {event.stats.general.tables_remaining ?? '—'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingLeft: 8 }}>
                    <span>Open to join</span>
                    <span style={{ color: 'var(--sec-text-primary)', fontWeight: 600 }}>{event.stats.general.tables_with_join_space}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingLeft: 8 }}>
                    <span>Full</span>
                    <span style={{ color: 'var(--sec-text-primary)', fontWeight: 600 }}>{event.stats.general.tables_full}</span>
                  </div>
                </>
              )}
              {event.stats.vip && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--sec-text-primary)', marginTop: 4 }}>VIP</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingLeft: 8 }}>
                    <span>Slots left</span>
                    <span style={{ color: 'var(--sec-text-primary)', fontWeight: 600 }}>
                      {event.stats.vip.tables_remaining ?? '—'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingLeft: 8 }}>
                    <span>Open to join</span>
                    <span style={{ color: 'var(--sec-text-primary)', fontWeight: 600 }}>{event.stats.vip.tables_with_join_space}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingLeft: 8 }}>
                    <span>Full</span>
                    <span style={{ color: 'var(--sec-text-primary)', fontWeight: 600 }}>{event.stats.vip.tables_full}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {!eventEnded && event.event_format !== 'TICKETING_ONLY' && event.has_entrance_fee && event.entrance_fee_amount != null && (
          <div className="sec-card" style={{
            padding: '12px 16px', marginBottom: 20,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <Ticket size={16} strokeWidth={1.5} style={{ color: 'var(--sec-accent)', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginBottom: 2, fontWeight: 500 }}>Entrance fee</p>
              <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--sec-text-primary)' }}>
                {Number(event.entrance_fee_amount) <= 0 ? 'Free' : money.format(event.entrance_fee_amount)}
              </p>
            </div>
            <button
              type="button"
              className="sec-btn sec-btn-primary"
              style={{ height: 36, padding: '0 14px', fontSize: 13 }}
              onClick={() => {
                if (!requireSignedIn()) return;
                navigate(createPageUrl(`EventEntranceCheckout?id=${eventId}`));
              }}
            >
              {Number(event.entrance_fee_amount) <= 0 ? 'Get free entrance' : 'Pay to enter'}
            </button>
          </div>
        )}

        {!eventEnded && event.event_format !== 'TICKETING_ONLY' && event.has_entrance_fee && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 8,
              marginBottom: 20,
            }}
          >
            <button
              type="button"
              className="sec-btn"
              style={{
                height: 44,
                fontSize: 13,
                background: 'var(--sec-bg-card)',
                border: '1px solid var(--sec-border)',
                color: 'var(--sec-text-primary)',
              }}
              onClick={() => {
                if (!requireSignedIn()) return;
                navigate(createPageUrl(`EventEntranceCheckout?id=${eventId}`));
              }}
            >
              Pay to enter
            </button>
            <button
              type="button"
              className="sec-btn"
              style={{
                height: 44,
                fontSize: 13,
                background: 'var(--sec-bg-card)',
                border: '1px solid var(--sec-border)',
                color: 'var(--sec-text-primary)',
              }}
              onClick={() => {
                const section = document.querySelector('[data-tables-section]');
                if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              Host
            </button>
            <button
              type="button"
              className="sec-btn"
              style={{
                height: 44,
                fontSize: 13,
                background: 'var(--sec-bg-card)',
                border: '1px solid var(--sec-border)',
                color: 'var(--sec-text-primary)',
              }}
              onClick={() => {
                const section = document.querySelector('[data-tables-section]');
                if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              Join
            </button>
          </div>
        )}

        {/* ── Description ── */}
        {event.description && (
          <div style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, color: 'var(--sec-text-primary)' }}>About</h2>
            <p style={{ color: 'var(--sec-text-muted)', fontSize: 14, lineHeight: 1.65 }}>{event.description}</p>
          </div>
        )}

        {/* ── Music genres ── */}
        {event.music_genres?.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Music size={15} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
              Music
            </h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {event.music_genres.map((genre, index) => (
                <span key={index} className="sec-chip active" style={{ height: 32, padding: '0 14px', fontSize: 12 }}>
                  {genre}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── Featured Artists ── */}
        {event.featured_artists?.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Star size={15} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />
              Featured Artists
            </h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {event.featured_artists.map((artist, index) => (
                <span key={index} className="sec-chip">
                  {artist}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── Tickets ── */}
        {event.ticket_tiers?.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Ticket size={15} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
              Tickets
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {event.ticket_tiers.map((tier, index) => (
                <div key={index} className="sec-card" style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '14px 16px',
                }}>
                  <div>
                    <p style={{ fontWeight: 600, fontSize: 14, color: 'var(--sec-text-primary)', marginBottom: 2 }}>{tier.name}</p>
                    {tier.description && (
                      <p style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>{tier.description}</p>
                    )}
                    {parseMaxPerUser(tier) != null && (
                      <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                        Limit {parseMaxPerUser(tier)} per person
                      </p>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontWeight: 700, fontSize: 16, color: 'var(--sec-text-primary)', letterSpacing: '-0.01em' }}>
                      {money.format(tier.price)}
                    </p>
                    {tier.quantity && (
                      <p style={{ fontSize: 11, color: 'var(--sec-text-muted)' }}>
                        {tier.quantity - (tier.sold || 0)} left
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {(!eventEnded && (event.event_format !== 'TICKETING_ONLY' || tableTiers.length > 0)) ? (
        <div data-tables-section style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Users size={15} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
              Table tiers ({tableTiers.length})
            </h2>
            <span style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>
              {event.event_format === 'TICKETING_ONLY' ? 'Table pass = entry' : 'Host or join on Sec'}
            </span>
          </div>

          {seatingPlan ? (
            <div style={{ marginBottom: 12 }}>
              <SeatingPlanCTA
                plan={seatingPlan}
                planCount={seatingPlans.length}
                onView={() => setSeatingViewerOpen(true)}
              />
            </div>
          ) : null}

          {tableTiers.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {tableTiers.map((tier) => (
                <EventTableTierCard
                  key={tier.tierKey}
                  tier={tier}
                  onSelect={setSelectedTier}
                />
              ))}
            </div>
          ) : (
            <div className="sec-card" style={{ textAlign: 'center', padding: '32px 24px' }}>
              <p style={{ fontSize: 14, color: 'var(--sec-text-muted)' }}>The venue has not listed tables for this event yet.</p>
            </div>
          )}

          {tableTiers.length > 0 ? (
            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', textAlign: 'center' }}>
              Select a tier to host your own table or join an existing one
            </p>
          ) : null}

          {allowsCustomRequests && customListingId ? (
            <div
              className="sec-card"
              style={{
                marginTop: 16,
                padding: '16px 18px',
                border: '1px solid rgba(212, 175, 55, 0.35)',
                background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.08) 0%, rgba(20, 20, 20, 0.95) 100%)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'var(--sec-accent-muted)',
                    color: 'var(--sec-accent)',
                    flexShrink: 0,
                  }}
                >
                  <Sparkles size={18} />
                </div>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--sec-text-primary)', margin: '0 0 4px' }}>
                    Need something bespoke?
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', margin: 0, lineHeight: 1.5 }}>
                    Request a custom table — guest count, minimum spend, and menu picks. The venue reviews before checkout.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="sec-btn sec-btn-primary sec-btn-full"
                style={{ height: 46, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                onClick={() =>
                  navigate(buildPageUrl('TableDetails', { id: customListingId, source: 'venue', request: '1' }))
                }
              >
                <Sparkles size={16} />
                Request Custom Table
              </button>
            </div>
          ) : null}
        </div>
        ) : null}

        {(!eventEnded && (event.event_format !== 'TICKETING_ONLY' || tableTiers.length > 0)) ? (
        <EventTableTierSheet
          tier={selectedTier}
          open={Boolean(selectedTier)}
          onClose={() => setSelectedTier(null)}
          customListingId={customListingId}
          allowsCustomRequests={allowsCustomRequests}
          eventId={eventId}
        />
        ) : null}

        {/* ── Location / directions ── */}
        {mapQuery && (() => {
          const dirs = getDirectionsActions({ address: mapQuery });
          return (
            <div style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <a
                href={dirs.primary.href}
                target="_blank"
                rel="noopener noreferrer"
                className="sec-list-row"
                style={{ backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)', borderRadius: 'var(--radius-lg)' }}
              >
                <div style={{
                  width: 40, height: 40, borderRadius: 'var(--radius-md)',
                  backgroundColor: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <Navigation size={18} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 2 }}>{dirs.primary.label}</p>
                  <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {venueLine}
                  </p>
                </div>
                <ChevronRight size={16} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)', flexShrink: 0 }} />
              </a>
              <a
                href={dirs.secondary.href}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 13, color: 'var(--sec-accent)', paddingLeft: 4 }}
              >
                {dirs.secondary.label}
              </a>
            </div>
          );
        })()}
      </div>

      {/* ── Sticky bottom bar — price left / CTA right ── */}
      <div className="sec-bottom-bar sec-bottom-bar--responsive">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', maxWidth: 960, margin: '0 auto' }}>
          {eventEnded ? (
            <>
              <div className="sec-bottom-bar__price">
                <div className="sec-bottom-bar__price-label">Attended</div>
                <div className="sec-bottom-bar__price-value">
                  {event.attendee_count ?? event.stats?.going_count ?? event.total_attending ?? 0}
                </div>
              </div>
              <div className="sec-bottom-bar__cta">
                <button type="button" className="sec-btn sec-btn-full" disabled>
                  This event has ended
                </button>
              </div>
            </>
          ) : event.event_format === 'TICKETING_ONLY' && event.ticket_tiers?.length > 0 ? (
            <>
              <div className="sec-bottom-bar__price">
                <div className="sec-bottom-bar__price-label">From</div>
                <div className="sec-bottom-bar__price-value">
                  {lowestTicketPrice <= 0 ? 'Free' : money.format(lowestTicketPrice)}
                </div>
              </div>
              <div className="sec-bottom-bar__cta" style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="sec-btn sec-btn-primary"
                  style={{ flex: 1 }}
                  onClick={() => {
                    if (!requireSignedIn()) return;
                    navigate(createPageUrl(`TicketCheckout?id=${eventId}`));
                  }}
                >
                  {lowestTicketPrice <= 0 ? 'Get free tickets' : 'Buy tickets'}
                </button>
                {tableTiers.length > 0 && (
                  <button
                    type="button"
                    className="sec-btn"
                    style={{
                      flex: 1,
                      background: 'var(--sec-bg-elevated)',
                      border: '1px solid var(--sec-border)',
                      color: 'var(--sec-text-primary)',
                    }}
                    onClick={() => {
                      const section = document.querySelector('[data-tables-section]');
                      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  >
                    Tables
                  </button>
                )}
              </div>
            </>
          ) : tableTiers.length > 0 ? (
            <>
              <div className="sec-bottom-bar__price">
                <div className="sec-bottom-bar__price-label">
                  {event.has_entrance_fee ? 'Entrance' : 'Spots left'}
                </div>
                <div className="sec-bottom-bar__price-value">
                  {event.has_entrance_fee
                    ? Number(event.entrance_fee_amount || 0) <= 0
                      ? 'Free'
                      : money.format(event.entrance_fee_amount || 0)
                    : totalSpotsRemaining}
                </div>
              </div>
              <div className="sec-bottom-bar__cta" style={{ display: 'flex', gap: 8 }}>
                {event.has_entrance_fee && (
                  <button
                    type="button"
                    className="sec-btn"
                    style={{
                      flex: 1,
                      background: 'var(--sec-bg-elevated)',
                      border: '1px solid var(--sec-border)',
                      color: 'var(--sec-text-primary)',
                      fontSize: 13,
                    }}
                    onClick={() => {
                      if (!requireSignedIn()) return;
                      navigate(createPageUrl(`EventEntranceCheckout?id=${eventId}`));
                    }}
                  >
                    {Number(event.entrance_fee_amount || 0) <= 0 ? 'Get free entrance' : 'Pay to enter'}
                  </button>
                )}
                <button
                  className="sec-btn sec-btn-primary"
                  style={{ flex: 1 }}
                  onClick={() => {
                    const section = document.querySelector('[data-tables-section]');
                    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  Host / Join
                </button>
              </div>
            </>
          ) : event.ticket_tiers?.length > 0 ? (
            <>
              <div className="sec-bottom-bar__price">
                <div className="sec-bottom-bar__price-label">From</div>
                <div className="sec-bottom-bar__price-value">
                  {lowestTicketPrice <= 0 ? 'Free' : money.format(lowestTicketPrice)}
                </div>
              </div>
              <div className="sec-bottom-bar__cta">
                <button
                  type="button"
                  className="sec-btn sec-btn-primary sec-btn-full"
                  onClick={() => {
                    if (!requireSignedIn()) return;
                    navigate(createPageUrl(`TicketCheckout?id=${eventId}`));
                  }}
                >
                  {lowestTicketPrice <= 0 ? 'Get free tickets' : 'Buy tickets'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="sec-bottom-bar__cta">
                <button
                  type="button"
                  className="sec-btn sec-btn-primary sec-btn-full"
                  disabled={toggleInterestMutation.isPending}
                  onClick={() => {
                    if (!requireSignedIn()) return;
                    toggleInterestMutation.mutate();
                  }}
                  style={
                    isInterested
                      ? {
                          background: 'var(--sec-success)',
                          color: '#fff',
                          border: '1px solid rgba(255,255,255,0.2)',
                        }
                      : undefined
                  }
                >
                  {isInterested ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <BadgeCheck size={18} strokeWidth={2} />
                      Interested
                    </span>
                  ) : (
                    "I'm Interested"
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <EventShareModal
        open={shareOpen}
        onOpenChange={setShareOpen}
        eventId={eventId}
        eventTitle={event.title}
      />
      <SeatingPlanViewer
        open={seatingViewerOpen}
        onClose={() => setSeatingViewerOpen(false)}
        plans={seatingPlans}
      />
    </div>
  );
}
