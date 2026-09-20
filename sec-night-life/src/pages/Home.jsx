import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { hostedListingDetailsPath } from '@/lib/hostedListingUrl';
import { dataService } from '@/services/dataService';
import * as authService from '@/services/authService';
import { apiGet, apiPost } from '@/api/client';
import { useAuth, hasStoredAuthTokens } from '@/lib/AuthContext';
import { prefetchPage } from '@/pages.config';
import { useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { format, isToday, isTomorrow, isValid, parseISO } from 'date-fns';
import { motion } from 'framer-motion';
import { ChevronRight, Search, SlidersHorizontal, BadgeCheck, Trophy, Bell, Users, RefreshCw } from 'lucide-react';

import FeaturedEventCard from '@/components/home/FeaturedEventCard';
import VenueCard from '@/components/home/VenueCard';
import TableOfferingCard from '@/components/home/TableOfferingCard';
import QuickActions from '@/components/home/QuickActions';
import StaffAccessBanner from '@/components/home/StaffAccessBanner';
import AdminAccessBanner from '@/components/home/AdminAccessBanner';
import PlatformAnnouncementBanner from '@/components/home/PlatformAnnouncementBanner';
import SecLogo from '@/components/ui/SecLogo';
import { getEventImage } from '@/lib/placeholders';
import { toast } from 'sonner';
import { launchPaystackInline } from '@/lib/paystackInline';
import { completePaystackCheckout } from '@/lib/completePaystackCheckout';
import { isEventEnded } from '@/lib/eventLifecycle';
import { usePreferences } from '@/context/PreferencesContext';
import { useNotificationUnreadCount } from '@/lib/useNotificationUnreadCount';

const ENTER_SEEN_KEY = 'sec_enter_seen_v1';

function readEnterSeen() {
  try {
    return localStorage.getItem(ENTER_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markEnterSeen() {
  try {
    localStorage.setItem(ENTER_SEEN_KEY, '1');
  } catch {
    /* ignore */
  }
}

function getOrCreateSessionId() {
  try {
    const existing = localStorage.getItem('sec_session_id');
    if (existing) return existing;
    const generated = crypto?.randomUUID ? crypto.randomUUID() : `sec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('sec_session_id', generated);
    return generated;
  } catch {
    return `sec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}


function getPromotionLabel(promotion) {
  if (promotion?.boosted) return 'Sponsored';
  if (!promotion?.promotionType) return 'Promotion';
  return String(promotion.promotionType)
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

const HomePromotionCard = React.memo(function HomePromotionCard({ promotion: p, onOpen, compact = false }) {
  const boosted = Boolean(p?.boosted);
  const label = getPromotionLabel(p);
  return (
    <div
      className="sec-card"
      role="link"
      tabIndex={0}
      aria-label={`Open ${p.venueName}`}
      onClick={() => onOpen(p)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(p);
        }
      }}
      style={{
        flex: compact ? '0 0 min(88vw, 320px)' : '1 1 auto',
        width: compact ? 'min(88vw, 320px)' : '100%',
        maxWidth: '100%',
        minWidth: 0,
        minHeight: compact ? 300 : 320,
        boxSizing: 'border-box',
        padding: 14,
        cursor: 'pointer',
        border: boosted ? '1px solid var(--sec-accent-border)' : '1px solid var(--sec-border)',
        background: boosted
          ? 'linear-gradient(160deg, var(--sec-bg-elevated) 0%, var(--sec-bg-card) 100%)'
          : 'var(--sec-bg-card)',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: boosted ? 'var(--shadow-card)' : undefined,
        scrollSnapAlign: compact ? 'start' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexShrink: 0 }}>
        <p
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: boosted ? 'var(--sec-accent-bright)' : 'var(--sec-text-muted)',
            margin: 0,
          }}
        >
          {label}
        </p>
        {boosted ? (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '3px 8px',
              borderRadius: 999,
              background: 'var(--sec-warning-muted)',
              color: 'var(--sec-warning)',
              border: '1px solid rgba(212, 160, 23, 0.35)',
            }}
          >
            Sponsored
          </span>
        ) : null}
      </div>
      <div
        style={{
          width: '100%',
          maxWidth: '100%',
          aspectRatio: '16 / 10',
          minHeight: 132,
          flexShrink: 0,
          overflow: 'hidden',
          borderRadius: 10,
          marginBottom: 10,
          background: 'var(--sec-bg-hover)',
        }}
      >
        {p.imageUrl ? (
          <img
            src={p.imageUrl}
            alt=""
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center',
              display: 'block',
              pointerEvents: 'none',
            }}
          />
        ) : null}
      </div>
      <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', flexShrink: 0 }}>{p.venueName} · {p.venueType}</p>
        <h3
          style={{
            fontSize: 16,
            fontWeight: 700,
            marginTop: 4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {p.title}
        </h3>
        <p
          style={{
            fontSize: 13,
            color: 'var(--sec-text-secondary)',
            marginTop: 6,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {p.body}
        </p>
        <p style={{ fontSize: 12, marginTop: 6, minHeight: '2.6em', color: 'var(--sec-text-secondary)', flexShrink: 0 }}>
          {p.eventName ? `Event: ${p.eventName}` : '\u00a0'}
        </p>
        <p style={{ fontSize: 11, marginTop: 6, color: 'var(--sec-text-muted)', flexShrink: 0 }}>
          {p.targetCity || 'Nationwide'} · Offer ends {new Date(p.endsAt).toLocaleDateString()}
        </p>
      </div>
      <p style={{ fontSize: 13, color: 'var(--sec-text-secondary)', paddingTop: 10, fontWeight: 600, flexShrink: 0 }}>
        View {p.venueName}
        <ChevronRight size={14} strokeWidth={2} style={{ display: 'inline-block', verticalAlign: 'middle', marginLeft: 4 }} />
      </p>
    </div>
  );
});

const PromoWithImpression = React.memo(function PromoWithImpression({ promotion, sessionId, onOpen, compact = false }) {
  const wrapRef = useRef(null);
  const fired = useRef(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || fired.current) return undefined;
    const ob = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !fired.current) {
            fired.current = true;
            void apiPost(`/api/promotions/${promotion.id}/track`, { type: 'VIEW', sessionId }, { skipAuth: false }).catch(() => {});
            ob.disconnect();
          }
        }
      },
      { threshold: 0.35, rootMargin: '48px' },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [promotion.id, sessionId]);
  return (
    <div ref={wrapRef} style={{ width: compact ? 'auto' : '100%', maxWidth: '100%', minWidth: 0, flexShrink: compact ? 0 : undefined }}>
      <HomePromotionCard promotion={promotion} onOpen={onOpen} compact={compact} />
    </div>
  );
});

function HomeSessionSkeleton() {
  return (
    <div className="min-h-screen" style={{ minHeight: '100vh', backgroundColor: 'var(--sec-bg-base)' }}>
      <header
        className="sticky top-0 z-40 border-b border-[var(--sec-border)] min-h-[60px] pt-[env(safe-area-inset-top)]"
        style={{ backgroundColor: 'rgba(0,0,0,0.92)' }}
      >
        <div className="max-w-[1120px] mx-auto w-full px-4 sm:px-5 py-4">
          <div className="h-4 w-40 rounded bg-[var(--sec-bg-elevated)] animate-pulse" />
          <div className="h-3 w-28 rounded bg-[var(--sec-bg-elevated)] animate-pulse mt-2" />
        </div>
      </header>
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '24px 20px' }}>
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="sec-card mb-4 animate-pulse"
            style={{ height: 120, backgroundColor: 'var(--sec-bg-card)' }}
          />
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, userProfile, logout, checkAppState, isLoadingAuth } = useAuth();
  const notificationUnread = useNotificationUnreadCount(!!user?.id);
  const { location: locPrefs, geoCoords } = usePreferences();
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [venueSectionInView, setVenueSectionInView] = useState(false);
  const venuesSectionRef = useRef(null);
  const [selectedCity, setSelectedCity] = useState('all');
  const [selectedVenueType, setSelectedVenueType] = useState('all');
  const [sessionId] = useState(() => getOrCreateSessionId());
  const pullCooldownRef = useRef(0);
  const [showEnterSplash, setShowEnterSplash] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (hasStoredAuthTokens()) return false;
    return !readEnterSeen();
  });

  useEffect(() => {
    if (!user && !hasStoredAuthTokens()) {
      void prefetchPage('Onboarding');
      void prefetchPage('Login');
      void prefetchPage('Register');
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      setShowEnterSplash(false);
      return;
    }
    if (hasStoredAuthTokens()) {
      setShowEnterSplash(false);
      return;
    }
    setShowEnterSplash(!readEnterSeen());
  }, [user]);

  useEffect(() => {
    if (!user && hasStoredAuthTokens()) {
      void checkAppState();
    }
  }, [user, checkAppState]);

  // Dead / expired tokens must not trap guests on the Home skeleton.
  useEffect(() => {
    if (user || !hasStoredAuthTokens()) return undefined;
    if (isLoadingAuth) {
      const t = setTimeout(() => {
        if (!user && hasStoredAuthTokens()) {
          logout(false);
        }
      }, 10000);
      return () => clearTimeout(t);
    }
    logout(false);
    return undefined;
  }, [user, isLoadingAuth, logout]);

  const guestBrowseReady = !!user?.id || !hasStoredAuthTokens();

  const { data: staffAssignments = [] } = useQuery({
    queryKey: ['staff-venues'],
    queryFn: () =>
      apiGet('/api/staff/venues').then((r) => (Array.isArray(r) ? r : r?.items || [])),
    enabled: !!user?.id,
    staleTime: 5 * 60_000,
  });

  const refreshHomeData = useCallback(
    async (showToast = true) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['home-bootstrap'] }),
        queryClient.invalidateQueries({ queryKey: ['home-feed'] }),
        queryClient.invalidateQueries({ queryKey: ['featured-events'] }),
        queryClient.invalidateQueries({ queryKey: ['featured-events-details'] }),
        queryClient.invalidateQueries({ queryKey: ['all-venues'] }),
        queryClient.invalidateQueries({ queryKey: ['staff-venues'] }),
      ]);
      if (showToast) toast.success('Feed refreshed');
    },
    [queryClient],
  );

  useEffect(() => {
    let armed = false;
    let startY = 0;
    const onTouchStart = (e) => {
      if (window.scrollY > 8) return;
      armed = true;
      startY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e) => {
      if (!armed) return;
      const y = e.touches[0]?.clientY ?? 0;
      if (y - startY > 72) {
        armed = false;
        const t = Date.now();
        if (t - pullCooldownRef.current < 2500) return;
        pullCooldownRef.current = t;
        void refreshHomeData(false);
      }
    };
    const onTouchEnd = () => {
      armed = false;
    };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [refreshHomeData]);

  /** Feed scope: location off → nationwide; location on → geo radius; else city fallback. */
  const homeFeedCity = useMemo(() => {
    if (locPrefs?.useLocation) return '';
    if (selectedCity && selectedCity !== 'all') return String(selectedCity).trim();
    if (userProfile?.city) return String(userProfile.city).trim();
    return '';
  }, [selectedCity, userProfile?.city, locPrefs?.useLocation]);
  const homeFeedScopeAll = !locPrefs?.useLocation && !homeFeedCity;
  const homeFeedGeoKey = locPrefs?.useLocation && geoCoords
    ? `${geoCoords.lat.toFixed(3)},${geoCoords.lng.toFixed(3)},${locPrefs.radiusKm ?? 25}`
    : null;

  const handlePromotionClick = async (promotion) => {
    void apiPost(`/api/promotions/${promotion.id}/track`, { type: 'CLICK', sessionId }).catch(() => {});
    navigate(createPageUrl(`VenueProfile?id=${promotion.venueId}`));
  };

  const joinHostedTable = async (tableId) => {
    let sessionUser = user;
    if (!sessionUser?.id || !sessionUser?.email) {
      if (authService.hasRefreshSession()) {
        try {
          const { user: u } = await authService.resolveUserForAction(window.location.href);
          if (!u?.id) {
            toast.error('Still signing you in — try again in a moment.');
            return;
          }
          sessionUser = u;
        } catch (err) {
          if (err?.name === 'AuthRequiredError') return;
          toast.error('Still signing you in — try again in a moment.');
          return;
        }
      } else {
        const returnUrl = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
        navigate(`${createPageUrl('Login')}?returnUrl=${returnUrl}`);
        toast.message('Sign in to join a table');
        return;
      }
    }
    try {
      const r = await apiPost(`/api/host/tables/${tableId}/join`, {});
      queryClient.invalidateQueries({ queryKey: ['home-table-offerings'] });
      queryClient.invalidateQueries({ queryKey: ['home-feed'] });
      if (r?.pending) {
        toast.success('Request sent. The host will approve your join.');
        return;
      }
      if (r?.pendingPayment && r?.reference && r?.access_code) {
        const amount = Number(r.amount_zar ?? 0);
        launchPaystackInline({
          email: sessionUser.email,
          amount,
          reference: r.reference,
          accessCode: r.access_code,
          onSuccess: async (payload) => {
            await completePaystackCheckout({ reference: r.reference, payload, queryClient });
            queryClient.invalidateQueries({ queryKey: ['home-table-offerings'] });
            queryClient.invalidateQueries({ queryKey: ['home-feed'] });
          },
          onCancel: () => {
            toast.message('Checkout closed', {
              description: 'No charge was completed. Open the table again to retry.',
            });
          },
        });
        return;
      }
      toast.success('You are on the guest list.');
    } catch (e) {
      toast.error(e?.message || 'Could not join table');
    }
  };

  const listStale = 120_000;

  const feedScopeKey = homeFeedScopeAll ? 'all' : homeFeedGeoKey || homeFeedCity || 'all';
  const {
    data: feedPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading: feedLoading,
  } = useInfiniteQuery({
    queryKey: ['home-feed', sessionId, feedScopeKey],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const cursor = pageParam ?? 0;
      if (cursor === 0) {
        const boot = queryClient.getQueryData(['home-bootstrap', sessionId, feedScopeKey]);
        if (boot?.feed?.items) return boot.feed;
      }
      const params = new URLSearchParams({
        cursor: String(cursor),
        limit: '12',
        sessionId,
      });
      if (homeFeedScopeAll) params.set('scope', 'all');
      else if (homeFeedGeoKey && geoCoords) {
        params.set('lat', String(geoCoords.lat));
        params.set('lng', String(geoCoords.lng));
        params.set('radius_km', String(locPrefs?.radiusKm ?? 25));
      } else if (homeFeedCity) params.set('city', homeFeedCity);
      else params.set('scope', 'all');
      return apiGet(`/api/home/feed?${params.toString()}`, { headers: { 'x-session-id': sessionId } });
    },
    getNextPageParam: (lastPage) => (lastPage?.nextCursor != null ? parseInt(lastPage.nextCursor, 10) : undefined),
    enabled: guestBrowseReady,
    staleTime: 60_000,
  });

  const bootstrapScopeKey = feedScopeKey;

  const fetchHomeBootstrap = useCallback(async () => {
    const params = new URLSearchParams({
      sessionId,
      tableLimit: '24',
      promoLimit: '12',
    });
    if (homeFeedScopeAll) params.set('scope', 'all');
    else if (homeFeedGeoKey && geoCoords) {
      params.set('lat', String(geoCoords.lat));
      params.set('lng', String(geoCoords.lng));
      params.set('radius_km', String(locPrefs?.radiusKm ?? 25));
    } else if (homeFeedCity) params.set('city', homeFeedCity);
    else params.set('scope', 'all');

    try {
      return await apiGet(`/api/home/bootstrap?${params.toString()}`, {
        headers: { 'x-session-id': sessionId },
      });
    } catch (err) {
      const [announcementsRes, tableRes, promoRes, followedRes, communityRes] = await Promise.allSettled([
        apiGet('/api/home/announcements'),
        apiGet(`/api/home/table-offerings?limit=24&sessionId=${encodeURIComponent(sessionId)}`, {
          headers: { 'x-session-id': sessionId },
        }),
        apiGet(`/api/promotions/feed?limit=12&page=1&${params.toString()}`, {
          headers: { 'x-session-id': sessionId },
          skipAuth: true,
        }),
        apiGet('/api/home/followed-promoters'),
        apiGet('/api/home/community-hosted-events?limit=12'),
      ]);
      return {
        announcements:
          announcementsRes.status === 'fulfilled'
            ? announcementsRes.value?.announcements || []
            : [],
        tableOfferings:
          tableRes.status === 'fulfilled' ? tableRes.value?.items || [] : [],
        promotions: {
          results:
            promoRes.status === 'fulfilled' ? promoRes.value?.results || [] : [],
        },
        followedPromoters: {
          items:
            followedRes.status === 'fulfilled' ? followedRes.value?.items || [] : [],
        },
        communityHostedEvents:
          communityRes.status === 'fulfilled' ? communityRes.value?.items || [] : [],
      };
    }
  }, [sessionId, homeFeedScopeAll, homeFeedGeoKey, geoCoords, homeFeedCity, locPrefs?.radiusKm]);

  const { data: homeBootstrap, isLoading: bootstrapLoading } = useQuery({
    queryKey: ['home-bootstrap', sessionId, bootstrapScopeKey],
    queryFn: fetchHomeBootstrap,
    enabled: guestBrowseReady,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!homeBootstrap?.feed?.items) return;
    queryClient.setQueryData(['home-feed', sessionId, bootstrapScopeKey], {
      pages: [homeBootstrap.feed],
      pageParams: [0],
    });
    if (homeBootstrap.featuredEvents) {
      queryClient.setQueryData(['featured-events-details', 'auto'], homeBootstrap.featuredEvents);
    }
  }, [homeBootstrap, queryClient, sessionId, bootstrapScopeKey]);

  const followedPromoterEvents = homeBootstrap?.followedPromoters?.items || [];
  const platformAnnouncements = homeBootstrap?.announcements || [];
  const homePromotions = homeBootstrap?.promotions?.results || [];
  const promotionsFeedLoading = bootstrapLoading;

  const feedRows = useMemo(() => (feedPages?.pages || []).flatMap((p) => p.items || []), [feedPages]);
  const feedScope = feedPages?.pages?.[0]?.feedScope;
  const feedScopeHint =
    feedScope === 'local'
      ? 'Venues and events near you — order changes each session.'
      : locPrefs?.useLocation
        ? 'Showing venues and events across SEC — few venues near you. Order changes each session.'
        : 'Order changes based on your area and session.';

  // Upcoming/featured come from bootstrap + feed (no extra Event.filter / featured-details).
  const events = useMemo(() => {
    const fromFeed = (feedPages?.pages || [])
      .flatMap((p) => p.items || [])
      .filter((row) => row?.kind === 'event')
      .map((row) => row.data);
    const fromFeatured = homeBootstrap?.featuredEvents || [];
    const byId = new Map();
    for (const e of [...fromFeatured, ...fromFeed]) {
      if (e?.id && !byId.has(e.id)) byId.set(e.id, e);
    }
    return [...byId.values()];
  }, [feedPages, homeBootstrap?.featuredEvents]);

  const bootstrapTableItems = useMemo(() => {
    const items = homeBootstrap?.tableOfferings || [];
    return items.filter((o) => {
      if (o.type !== 'venue_event') return true;
      return !isEventEnded({ date: o.eventDate, ends_at: o.eventEndsAt, endsAt: o.eventEndsAt });
    });
  }, [homeBootstrap?.tableOfferings]);

  // Retry Available Tables if bootstrap returned empty (partial failure / race).
  const { data: fallbackTableOfferings, isLoading: fallbackTablesLoading } = useQuery({
    queryKey: ['home-table-offerings', sessionId],
    queryFn: () =>
      apiGet(`/api/home/table-offerings?limit=24&sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { 'x-session-id': sessionId },
      }),
    enabled: guestBrowseReady && !bootstrapLoading && bootstrapTableItems.length === 0,
    staleTime: listStale,
  });

  const tableOfferings = useMemo(() => {
    if (bootstrapTableItems.length > 0) return bootstrapTableItems;
    const items = fallbackTableOfferings?.items || [];
    return items.filter((o) => {
      if (o.type !== 'venue_event') return true;
      return !isEventEnded({ date: o.eventDate, ends_at: o.eventEndsAt, endsAt: o.eventEndsAt });
    });
  }, [bootstrapTableItems, fallbackTableOfferings?.items]);
  const tablesLoading = bootstrapLoading || (bootstrapTableItems.length === 0 && fallbackTablesLoading);

  useEffect(() => {
    if (!guestBrowseReady) return undefined;
    const el = venuesSectionRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVenueSectionInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setVenueSectionInView(true);
      },
      { rootMargin: '120px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [guestBrowseReady]);

  useEffect(() => {
    if (showFilters) setVenueSectionInView(true);
  }, [showFilters]);

  const shouldLoadVenues = showFilters || selectedCity !== 'all' || venueSectionInView;

  const { data: venues = [] } = useQuery({
    queryKey: ['all-venues', selectedCity],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '72' });
      if (selectedCity && selectedCity !== 'all') params.set('city', selectedCity);
      return apiGet(`/api/venues?${params.toString()}`);
    },
    staleTime: listStale,
    enabled: guestBrowseReady && shouldLoadVenues,
  });

  const cities = [...new Set(venues.map(v => v.city).filter(Boolean))];
  const followedVenueSet = new Set(userProfile?.followed_venues || []);
  const sortByFollowedVenueFirst = (items, getVenueId, tieBreaker) => {
    const withIndex = items.map((item, idx) => ({ item, idx }));
    withIndex.sort((a, b) => {
      const aFollowed = followedVenueSet.has(getVenueId(a.item));
      const bFollowed = followedVenueSet.has(getVenueId(b.item));
      if (aFollowed !== bFollowed) return aFollowed ? -1 : 1;
      const tie = tieBreaker ? tieBreaker(a.item, b.item) : 0;
      if (tie !== 0) return tie;
      return a.idx - b.idx;
    });
    return withIndex.map((x) => x.item);
  };

  const activeEventsOnly = useMemo(
    () => events.filter((e) => !isEventEnded(e)),
    [events],
  );

  const prioritizedEvents = sortByFollowedVenueFirst(
    activeEventsOnly,
    (e) => e.venue_id,
    (a, b) => {
      const aBoost = Boolean(a?.boosted);
      const bBoost = Boolean(b?.boosted);
      if (aBoost !== bBoost) return aBoost ? -1 : 1;
      const ad = a?.date ? new Date(a.date).getTime() : 0;
      const bd = b?.date ? new Date(b.date).getTime() : 0;
      return bd - ad;
    }
  );
  const filteredVenues = venues.filter(venue => {
    const q = searchQuery.toLowerCase();
    const matchesSearch = (venue.name ?? '').toLowerCase().includes(q) ||
                         (venue.city ?? '').toLowerCase().includes(q);
    const matchesCity = selectedCity === 'all' || venue.city === selectedCity;
    const matchesType = selectedVenueType === 'all' || venue.venue_type === selectedVenueType;
    return matchesSearch && matchesCity && matchesType;
  });

  const verifiedVenues = filteredVenues.filter(v => v.is_verified);
  const otherVenues = filteredVenues.filter(v => !v.is_verified);
  const upcomingEvents = prioritizedEvents.slice(0, 6);
  const communityHostedEvents = homeBootstrap?.communityHostedEvents || [];

  const featuredCards = homeBootstrap?.featuredEvents || [];

  const upcomingEventRows = useMemo(() => {
    const venueRows = upcomingEvents.map((event) => ({
      kind: 'venue_event',
      id: event.id,
      title: event.title,
      date: event.date,
      city: event.city,
      cover_image_url: event.cover_image_url,
      href: createPageUrl(`EventDetails?id=${event.id}`),
    }));
    const communityRows = communityHostedEvents.map((item) => ({
      kind: 'community_hosted',
      id: `hosted-${item.hostedTableId || item.id}`,
      title: item.title,
      date: item.date,
      city: item.venueName || item.city || null,
      cover_image_url: item.cover_image_url || item.coverImageUrl,
      href: hostedListingDetailsPath({
        id: item.hostedTableId || item.id,
        listingSurface: 'EVENT',
        isCommunityHosted: true,
      }),
    }));
    // Reserve Home slots for paid own-venue events so they are not crowded out.
    const communityTake = communityRows.slice(0, 4);
    const venueTake = venueRows.slice(0, Math.max(0, 8 - communityTake.length));
    return [...venueTake, ...communityTake].sort((a, b) => {
      const ad = a.date ? new Date(a.date).getTime() : 0;
      const bd = b.date ? new Date(b.date).getTime() : 0;
      return ad - bd;
    });
  }, [upcomingEvents, communityHostedEvents]);

  if (!user && hasStoredAuthTokens()) {
    return <HomeSessionSkeleton />;
  }

  if (!user && showEnterSplash) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 200,
          minHeight: '100vh',
          backgroundColor: 'var(--sec-bg-base)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 24px',
          paddingTop: 'max(40px, env(safe-area-inset-top))',
          paddingBottom: 'max(40px, env(safe-area-inset-bottom))',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 340 }}>
          <div style={{ marginBottom: 40, display: 'flex', justifyContent: 'center' }}>
            <SecLogo size={128} variant="full" />
          </div>
          <h1 className="sec-display" style={{ fontSize: 38, fontWeight: 700, marginBottom: 8 }}>
            SEC
          </h1>
          <p
            style={{
              color: 'var(--sec-text-muted)',
              fontSize: 12,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              fontWeight: 600,
              marginBottom: 24,
            }}
          >
            Your Night. Simplified.
          </p>
          <p
            style={{
              color: 'var(--sec-text-secondary)',
              fontSize: 15,
              lineHeight: 1.65,
              marginBottom: 40,
            }}
          >
            Discover events, book and join tables, and connect with the nightlife community.
          </p>
          <button
            type="button"
            onClick={() => {
              markEnterSeen();
              setShowEnterSplash(false);
            }}
            className="sec-btn sec-btn-primary sec-btn-full"
            style={{ fontSize: 15 }}
          >
            Browse nightlife
          </button>
          <button
            type="button"
            onMouseEnter={() => prefetchPage('Onboarding')}
            onPointerDown={() => prefetchPage('Onboarding')}
            onClick={() => {
              markEnterSeen();
              setShowEnterSplash(false);
              navigate(createPageUrl('Onboarding'));
            }}
            className="sec-btn sec-btn-ghost sec-btn-full"
            style={{ fontSize: 14, marginTop: 12 }}
          >
            Create account
          </button>
          <p style={{ marginTop: 16, fontSize: 13, color: 'var(--sec-text-muted)' }}>
            Already have an account?{' '}
            <button
              type="button"
              onMouseEnter={() => prefetchPage('Login')}
              onPointerDown={() => prefetchPage('Login')}
              onClick={() => {
                markEnterSeen();
                setShowEnterSplash(false);
                navigate(createPageUrl('Login'));
              }}
              className="underline font-medium"
              style={{ color: 'var(--sec-accent)' }}
            >
              Sign in
            </button>
          </p>
        </div>
      </div>
    );
  }

  const greetingName = user
    ? (userProfile?.username || user?.full_name?.split(' ')[0] || 'there')
    : null;
  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="min-h-screen" style={{ minHeight: '100vh', backgroundColor: 'var(--sec-bg-base)' }}>

      {/* ── Header ── */}
      <header
        className="sticky top-0 z-40 border-b border-[var(--sec-border)] min-h-[60px] pt-[env(safe-area-inset-top)]"
        style={{
          backgroundColor: 'rgba(0,0,0,0.92)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
        }}
      >
        <div className="max-w-[1120px] mx-auto w-full h-full px-4 sm:px-5 flex items-center justify-between gap-3 py-2 sm:py-0 sm:min-h-[60px]">
          <div className="flex-1 min-w-0">
            <h1 className="text-[15px] font-semibold text-[var(--sec-text-primary)] m-0 tracking-tight truncate">
              {user ? `${timeGreeting}, ${greetingName}` : 'SEC Nightlife'}
            </h1>
            <p className="text-xs text-[var(--sec-text-muted)] m-0 mt-0.5 truncate">
              {user ? "What's happening tonight" : 'Browse events — no account needed'}
            </p>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              className="sec-nav-icon"
              aria-label="Refresh feed"
              title="Refresh"
              onClick={() => void refreshHomeData(true)}
            >
              <RefreshCw size={18} strokeWidth={1.5} />
            </button>
            {user ? (
              <>
                <Link to={createPageUrl('Leaderboard')} className="sec-nav-icon" style={{ color: 'var(--sec-accent)' }}>
                  <Trophy size={18} strokeWidth={1.5} />
                </Link>
                <Link to={createPageUrl('Notifications')} className="sec-nav-icon relative" aria-label="Notifications">
                  <Bell size={18} strokeWidth={1.5} />
                  {notificationUnread > 0 ? (
                    <span className="absolute -top-1 -right-1 sec-nav-count-badge min-w-[16px] h-4 px-1 text-[9px]">
                      {notificationUnread > 99 ? '99+' : notificationUnread}
                    </span>
                  ) : null}
                </Link>
                <button
                  onClick={() => {
                    const ok = window.confirm('Sign out of SecNightlife?');
                    if (ok) logout();
                  }}
                  className="sec-btn sec-btn-ghost h-9 px-2 sm:px-3.5 text-xs rounded-full"
                  aria-label="Sign out"
                >
                  <span className="hidden sm:inline">Sign out</span>
                  <span className="sm:hidden text-[10px]">Out</span>
                </button>
              </>
            ) : (
              <>
                <Link
                  to={createPageUrl('Login')}
                  className="sec-btn sec-btn-ghost h-9 px-3 text-xs rounded-full"
                >
                  Log in
                </Link>
                <Link
                  to={createPageUrl('Register')}
                  className="sec-btn sec-btn-primary h-9 px-3 text-xs rounded-full"
                >
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '24px 20px 0' }}>

        {user ? <StaffAccessBanner assignments={staffAssignments} /> : null}
        {user && (user?.can_admin_dashboard || ['ADMIN', 'SUPER_ADMIN'].includes(user?.role)) ? (
          <AdminAccessBanner />
        ) : null}

        {/* ── Quick Actions ── */}
        {user ? (
          <div style={{ marginBottom: 32 }}>
            <QuickActions />
          </div>
        ) : (
          <div
            className="sec-card"
            style={{ marginBottom: 32, padding: 16, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}
          >
            <p style={{ margin: 0, fontSize: 14, color: 'var(--sec-text-secondary)', lineHeight: 1.5 }}>
              Browse freely. Log in to book tables, join events, and message hosts.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Link to={createPageUrl('Events')} className="sec-btn sec-btn-ghost h-9 px-3 text-xs rounded-full">
                Events
              </Link>
              <Link to={createPageUrl('Map')} className="sec-btn sec-btn-ghost h-9 px-3 text-xs rounded-full">
                Map
              </Link>
            </div>
          </div>
        )}

        {user ? <PlatformAnnouncementBanner announcements={platformAnnouncements} /> : null}

        {followedPromoterEvents.length > 0 && (
          <section style={{ marginBottom: 36 }}>
            <div className="sec-section-header">
              <div>
                <span className="sec-label">Following</span>
                <h2 style={{ fontSize: 19, fontWeight: 600, color: 'var(--sec-text-primary)', margin: '4px 0 0', letterSpacing: '-0.02em' }}>
                  From promoters you follow
                </h2>
              </div>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
              {followedPromoterEvents.map((item) => (
                <Link
                  key={`${item.promoterId}-${item.event.id}`}
                  to={createPageUrl(`EventDetails?id=${item.event.id}`)}
                  className="sec-card"
                  style={{ minWidth: 220, maxWidth: 240, padding: 12, borderRadius: 14, textDecoration: 'none', flexShrink: 0 }}
                >
                  {item.event.coverImageUrl ? (
                    <img src={item.event.coverImageUrl} alt="" loading="lazy" style={{ width: '100%', height: 100, objectFit: 'cover', borderRadius: 10, marginBottom: 8 }} />
                  ) : null}
                  <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--sec-text-primary)' }}>{item.event.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                    @{item.promoterUsername} · {item.event.venueName || item.event.city}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* ── Featured Events ── */}
        {featuredCards.length > 0 && (
          <section style={{ marginBottom: 36 }}>
            <div className="sec-section-header">
              <div>
                <span className="sec-label">Featured</span>
                <h2 style={{ fontSize: 19, fontWeight: 600, color: 'var(--sec-text-primary)', margin: '4px 0 0', letterSpacing: '-0.02em' }}>
                  Tonight&apos;s Events
                </h2>
              </div>
              <Link to={createPageUrl('Events')} className="sec-see-all">
                See all <ChevronRight size={14} strokeWidth={2} />
              </Link>
            </div>
            <div
              style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 4 }}
              className="scrollbar-hide -mx-5 px-5 lg:mx-0 lg:px-0"
            >
              {featuredCards.map((event, i) => (
                <motion.div
                  key={event.id}
                  initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.07 }}
                  style={{ flexShrink: 0, width: 288 }}
                >
                  <FeaturedEventCard event={event} />
                </motion.div>
              ))}
            </div>
          </section>
        )}

        <div className={`mb-9 ${upcomingEventRows.length > 0 ? 'xl:grid xl:grid-cols-2 xl:gap-8' : ''}`}>
          {/* ── Open Tables ── */}
          <section style={{ marginBottom: upcomingEventRows.length > 0 ? 0 : 36 }}>
            <div className="sec-section-header">
              <div>
                <span className="sec-label">Now Open</span>
                <h2 style={{ fontSize: 19, fontWeight: 600, color: 'var(--sec-text-primary)', margin: '4px 0 0', letterSpacing: '-0.02em' }}>
                  Available Tables
                </h2>
              </div>
              <Link to={createPageUrl('Tables')} className="sec-see-all">
                See all <ChevronRight size={14} strokeWidth={2} />
              </Link>
            </div>

            <motion.div
              style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 8 }}
              className="scrollbar-hide -mx-5 px-5 lg:mx-0 lg:px-0"
            >
              {tablesLoading
                ? [1, 2, 3].map((i) => (
                    <div
                      key={`table-skel-${i}`}
                      className="animate-pulse flex-shrink-0"
                      style={{
                        width: 288,
                        height: 168,
                        borderRadius: 16,
                        background: 'var(--sec-bg-card)',
                        border: '1px solid var(--sec-border)',
                      }}
                    />
                  ))
                : tableOfferings.map((offering, i) => (
                    <motion.div
                      key={offering.id}
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.05 }}
                    >
                      <TableOfferingCard offering={offering} wide={!!offering.boosted} />
                    </motion.div>
                  ))}
            </motion.div>

            {tableOfferings.length === 0 && !tablesLoading && (
              <div className="sec-card" style={{ textAlign: 'center', padding: '48px 24px' }}>
                <div style={{
                  width: 56, height: 56, borderRadius: '50%',
                  backgroundColor: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 16px',
                }}>
                  <Users size={24} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)' }} />
                </div>
                <p style={{ color: 'var(--sec-text-muted)', fontSize: 14, marginBottom: 20 }}>No open tables right now</p>
                {user ? (
                  <Link to={`${createPageUrl('HostDashboard')}?create=table`} className="sec-btn sec-btn-primary" style={{ display: 'inline-flex', padding: '10px 24px', textDecoration: 'none' }}>
                    Host table/event
                  </Link>
                ) : (
                  <Link to={createPageUrl('Login')} className="sec-btn sec-btn-primary" style={{ display: 'inline-flex', padding: '10px 24px', textDecoration: 'none' }}>
                    Sign in to host
                  </Link>
                )}
              </div>
            )}
          </section>

          {/* ── Upcoming Events (list rows) ── */}
          {upcomingEventRows.length > 0 && (
            <section style={{ marginTop: 36 }} className="xl:mt-0">
              <div className="sec-section-header">
                <div>
                  <span className="sec-label">Upcoming</span>
                  <h2 style={{ fontSize: 19, fontWeight: 600, color: 'var(--sec-text-primary)', margin: '4px 0 0', letterSpacing: '-0.02em' }}>
                    Events
                  </h2>
                </div>
                <Link to={createPageUrl('Events')} className="sec-see-all">
                  See all <ChevronRight size={14} strokeWidth={2} />
                </Link>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {upcomingEventRows.map((event, i) => (
                  <motion.div key={event.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
                    <Link
                      to={event.href}
                      className="sec-list-row"
                    >
                      <div className="sec-list-row__avatar-sq">
                        <img
                          src={getEventImage(event.cover_image_url)}
                          alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      </div>
                      <div className="sec-list-row__body">
                        <div className="sec-list-row__title">{event.title}</div>
                        <div className="sec-list-row__subtitle" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          {event.date && (() => {
                            const d = parseISO(event.date);
                            if (!isValid(d)) return null;
                            return (
                            <span>
                              {isToday(d) ? 'Tonight' :
                               isTomorrow(d) ? 'Tomorrow' :
                               format(d, 'EEE, MMM d')}
                            </span>
                            );
                          })()}
                          {event.city && <span>{event.city}</span>}
                          {event.kind === 'community_hosted' ? <span>Hosted</span> : null}
                        </div>
                      </div>
                      <div className="sec-list-row__action">
                        <ChevronRight size={16} strokeWidth={1.5} />
                      </div>
                    </Link>
                  </motion.div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* ── Promotions (boosted first) ── */}
        {(promotionsFeedLoading || homePromotions.length > 0) && (
          <section style={{ marginBottom: 36 }}>
            <div className="sec-section-header">
              <div>
                <span className="sec-label">Offers</span>
                <h2 style={{ fontSize: 19, fontWeight: 600, color: 'var(--sec-text-primary)', margin: '4px 0 0', letterSpacing: '-0.02em' }}>
                  Promotions
                </h2>
              </div>
            </div>
            {promotionsFeedLoading && homePromotions.length === 0 ? (
              <div style={{ display: 'flex', gap: 12, overflow: 'hidden' }}>
                {[1, 2].map((x) => (
                  <div key={x} className="sec-card" style={{ minWidth: 280, minHeight: 280, opacity: 0.5 }} />
                ))}
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  gap: 14,
                  overflowX: 'auto',
                  paddingBottom: 8,
                  scrollSnapType: 'x mandatory',
                  WebkitOverflowScrolling: 'touch',
                }}
              >
                {homePromotions.map((p) => (
                  <PromoWithImpression key={p.id} promotion={p} sessionId={sessionId} onOpen={handlePromotionClick} compact />
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── For you: mixed feed (cursor pagination) ── */}
        <section style={{ marginBottom: 30 }}>
          <div className="sec-section-header">
            <div>
              <span className="sec-label">For you</span>
              <h2 style={{ fontSize: 19, fontWeight: 600, color: 'var(--sec-text-primary)', margin: '4px 0 0', letterSpacing: '-0.02em' }}>
                Discover
              </h2>
            </div>
            <Link to={createPageUrl('Events')} className="sec-see-all">
              Explore <ChevronRight size={14} strokeWidth={2} />
            </Link>
          </div>

          {feedLoading && feedRows.length === 0 && (
            <div className="grid gap-3">
              {[1, 2, 3].map((x) => (
                <div key={x} className="sec-card" style={{ minHeight: 140, opacity: 0.55 }} />
              ))}
            </div>
          )}

          {!feedLoading && feedRows.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', marginTop: 4 }}>
              Nothing in your feed yet. Try another city or check back soon.
            </p>
          )}

          {feedRows.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {feedRows.map((row, i) => (
                <motion.div
                  key={`${row.kind}-${row.data?.id}-${i}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.03, 0.2) }}
                >
                  {row.kind === 'promotion' && (
                    <PromoWithImpression promotion={row.data} sessionId={sessionId} onOpen={handlePromotionClick} />
                  )}
                  {row.kind === 'event' && (
                    <Link
                      to={createPageUrl(`EventDetails?id=${row.data.id}`)}
                      className="sec-card"
                      style={{ display: 'flex', gap: 12, padding: 14, textDecoration: 'none', color: 'inherit', alignItems: 'center' }}
                    >
                      <div style={{ width: 88, height: 88, borderRadius: 12, overflow: 'hidden', flexShrink: 0, background: 'var(--sec-bg-hover)' }}>
                        <img src={getEventImage(row.data.cover_image_url)} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span className="sec-label">Event</span>
                        <div style={{ fontWeight: 600 }}>{row.data.title}</div>
                        <div style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>{row.data.city}</div>
                      </div>
                      <ChevronRight style={{ flexShrink: 0 }} size={18} strokeWidth={1.5} />
                    </Link>
                  )}
                  {row.kind === 'community_event' && (
                    <Link
                      to={hostedListingDetailsPath({
                        id: row.data.hostedTableId || row.data.id,
                        listingSurface: 'EVENT',
                        isCommunityHosted: true,
                      })}
                      className="sec-card"
                      style={{
                        display: 'flex',
                        gap: 12,
                        padding: 14,
                        textDecoration: 'none',
                        color: 'inherit',
                        alignItems: 'center',
                        borderColor: row.data.boosted ? 'var(--sec-accent-border)' : undefined,
                      }}
                    >
                      <div style={{ width: 88, height: 88, borderRadius: 12, overflow: 'hidden', flexShrink: 0, background: 'var(--sec-bg-hover)' }}>
                        <img src={getEventImage(row.data.cover_image_url)} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span className="sec-label">{row.data.boosted ? 'Promoted event' : 'Hosted event'}</span>
                        <div style={{ fontWeight: 600 }}>{row.data.title}</div>
                        <div style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                          {[row.data.city, row.data.spotsRemaining != null ? `${row.data.spotsRemaining} spots left` : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </div>
                      <ChevronRight style={{ flexShrink: 0 }} size={18} strokeWidth={1.5} />
                    </Link>
                  )}
                  {row.kind === 'venue' && (() => {
                    const { followed: _fol, ...venueRest } = row.data;
                    return <VenueCard venue={venueRest} />;
                  })()}
                </motion.div>
              ))}
            </div>
          )}

          {hasNextPage ? (
            <button
              type="button"
              className="sec-btn sec-btn-secondary sec-btn-full"
              style={{ marginTop: 16 }}
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          ) : null}

          {feedRows.length > 0 && (
            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 10 }}>
              {feedScopeHint} Pull to refresh by leaving Home and coming back.
            </p>
          )}
        </section>

        {/* ── Explore Venues ── */}
        <section ref={venuesSectionRef} style={{ marginBottom: 24 }}>
          <div style={{ marginBottom: 16 }}>
            <span className="sec-label">Directory</span>
            <h2 style={{ fontSize: 19, fontWeight: 600, color: 'var(--sec-text-primary)', margin: '4px 0 16px', letterSpacing: '-0.02em' }}>
              Venues
            </h2>

            {/* Search bar — pill style */}
            <div style={{ display: 'flex', gap: 8, marginBottom: showFilters ? 0 : 0 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <div style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--sec-text-muted)' }}>
                  <Search size={16} strokeWidth={1.5} />
                </div>
                <input
                  className="sec-input"
                  style={{ paddingLeft: 40 }}
                  placeholder="Search venues or cities…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <button
                onClick={() => setShowFilters(!showFilters)}
                style={{
                  width: 44, height: 44, borderRadius: 'var(--radius-pill)', flexShrink: 0,
                  backgroundColor: showFilters ? 'var(--sec-bg-hover)' : 'transparent',
                  border: `1px solid ${showFilters ? 'var(--sec-border-strong)' : 'var(--sec-border)'}`,
                  color: showFilters ? 'var(--sec-text-primary)' : 'var(--sec-text-muted)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                <SlidersHorizontal size={16} strokeWidth={1.5} />
              </button>
            </div>

            {showFilters && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}
              >
                <div>
                  <label className="sec-label" style={{ marginBottom: 6 }}>City</label>
                  <select value={selectedCity} onChange={(e) => setSelectedCity(e.target.value)}
                    className="sec-input-rect" style={{ height: 40, paddingTop: 0, paddingBottom: 0 }}>
                    <option value="all">All Cities</option>
                    {cities.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="sec-label" style={{ marginBottom: 6 }}>Type</label>
                  <select value={selectedVenueType} onChange={(e) => setSelectedVenueType(e.target.value)}
                    className="sec-input-rect" style={{ height: 40, paddingTop: 0, paddingBottom: 0 }}>
                    <option value="all">All Types</option>
                    <option value="nightclub">Nightclub</option>
                    <option value="lounge">Lounge</option>
                    <option value="bar">Bar</option>
                    <option value="rooftop">Rooftop</option>
                    <option value="beach_club">Beach Club</option>
                  </select>
                </div>
              </motion.div>
            )}
          </div>

          {verifiedVenues.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                <BadgeCheck size={13} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />
                <span className="sec-label" style={{ display: 'inline' }}>Verified Venues</span>
              </div>
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                {verifiedVenues.slice(0, 6).map(v => <VenueCard key={v.id} venue={v} />)}
              </div>
            </div>
          )}

          {otherVenues.length > 0 && (
            <div>
              <span className="sec-label" style={{ marginBottom: 12 }}>Other Venues</span>
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                {otherVenues.slice(0, 6).map(v => <VenueCard key={v.id} venue={v} />)}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
