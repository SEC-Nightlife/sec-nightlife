import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { createPageUrl, buildPageUrl } from './utils';
import { prefetchPage } from './pages.config';
import * as authService from '@/services/authService';
import { useAuth } from '@/lib/AuthContext';
import { apiGet } from '@/api/client';
import { flushPendingLegalAccepts } from '@/lib/pendingLegalAccept';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useActiveVenueOptional } from '@/context/ActiveVenueContext';
import SecLogo from '@/components/ui/SecLogo';
import VenueSwitcher from '@/components/business/VenueSwitcher';
import MobileBottomNav from '@/components/layout/MobileBottomNav';
import MobileMoreSheet from '@/components/layout/MobileMoreSheet';
import PageBackHeader from '@/components/layout/PageBackHeader';
import { useIsMobile } from '@/hooks/useIsDesktop';
import { shouldShowMobileBackHeader, getMobilePageTitle, pageDrawsOwnStatusBarPadding } from '@/lib/mobilePageShell';
import { BUSINESS_PAGE_PERMISSIONS, useVenueStaffAccess } from '@/hooks/useVenueStaffAccess';
import { useBusinessVenueScope } from '@/hooks/useBusinessVenueScope';
import { getMobileNavState } from '@/lib/mobileNavVisibility';
import { MOBILE_MAIN_PADDING_BOTTOM } from '@/lib/layoutConstants';
import { useMobileNavFormHide } from '@/hooks/useMobileNavFormHide';
import { enterPartygoerMode } from '@/lib/activeViewMode';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import CookieNoticeBanner from '@/components/legal/CookieNoticeBanner';
import GuestAgeGate from '@/components/legal/GuestAgeGate';
import { isPublicDocumentPage } from '@/lib/publicAuthPaths';
import {
  Home, Users, Plus, MessageCircle, User, Calendar, Briefcase, Bell, Trophy, Crown,
  LayoutDashboard, BarChart3, Building2, Megaphone, BookOpen, Settings, Music2, Shield, RotateCcw, Armchair, Store,
  LayoutGrid, MapPin, LogIn,
} from 'lucide-react';

const iconProps = { size: 22, strokeWidth: 1.5 };

const MODES = [
  { id: 'partygoer', label: 'Party Goer', icon: Music2 },
  { id: 'business', label: 'Business', icon: Building2 },
];

function filterBusinessNav(items, canAccessPage, can) {
  return items.filter((item) => {
    if (item.isCreate) return can('events');
    if (!item.page) return false;
    if (item.page === 'Settings' || item.page === 'Notifications') return true;
    return canAccessPage(item.page);
  });
}

function businessNavUrl(page, { query = null, staffContextToken = null } = {}) {
  if (!page) return createPageUrl('BusinessDashboard');
  const params = staffContextToken ? { staff_ctx: staffContextToken } : undefined;
  const base = buildPageUrl(page, params);
  if (!query) return base;
  const q = query.startsWith('?') ? query.slice(1) : query;
  return base.includes('?') ? `${base}&${q}` : `${base}?${q}`;
}

export default function Layout({ children, currentPageName }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, userProfile } = useAuth();
  const queryClient = useQueryClient();
  const activeVenueCtx = useActiveVenueOptional();
  const staffAccess = useVenueStaffAccess();
  const venueScope = useBusinessVenueScope();
  const [notificationCount, setNotificationCount] = useState(0);
  const [messageUnread, setMessageUnread] = useState(0);
  const [hostUnread, setHostUnread] = useState(0);
  const prevMessageUnreadRef = useRef(null);
  const [activeMode, setActiveMode] = useState(null);
  const [userRoles, setUserRoles] = useState({ partygoer: true, host: false, business: false });
  const [showModeSwitcher, setShowModeSwitcher] = useState(false);
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  const [complianceAccess, setComplianceAccess] = useState({ canReview: false, isSuperAdmin: false });
  const [hasStaffAssignments, setHasStaffAssignments] = useState(false);

  const needsComplianceAccess =
    activeMode === 'business' ||
    currentPageName === 'AdminDashboard' ||
    String(currentPageName || '').startsWith('Admin');

  const { data: staffVenuesList = [] } = useQuery({
    queryKey: ['staff-venues'],
    queryFn: () =>
      apiGet('/api/staff/venues').then((r) => (Array.isArray(r) ? r : r?.items || [])),
    enabled: !!user?.id,
    staleTime: 5 * 60_000,
  });

  const { data: rolesMe } = useQuery({
    queryKey: ['user-roles-me', user?.id],
    queryFn: () => apiGet('/api/user-roles/me'),
    enabled: !!user?.id,
    staleTime: 5 * 60_000,
  });

  const { data: complianceData } = useQuery({
    queryKey: ['compliance-access'],
    queryFn: () => apiGet('/api/compliance-documents/me/access'),
    enabled: !!user?.id && needsComplianceAccess,
    staleTime: 5 * 60_000,
  });

  function playMessageChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.06;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      setTimeout(() => {
        o.stop();
        ctx.close();
      }, 140);
    } catch {}
  }

  useEffect(() => {
    if (prevMessageUnreadRef.current !== null && messageUnread > prevMessageUnreadRef.current) {
      playMessageChime();
    }
    prevMessageUnreadRef.current = messageUnread;
  }, [messageUnread]);

  const badgeQueryKey = [
    'layout-unread-badges',
    user?.id,
    activeMode,
    venueScope.venueQuery || '',
  ];

  const { data: badgeCounts, refetch: refetchBadges } = useQuery({
    queryKey: badgeQueryKey,
    enabled: Boolean(user?.id) && !(activeMode === 'business' && !venueScope.venueQuery),
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const businessMode = activeMode === 'business';
      const venueQs = businessMode && venueScope.venueQuery ? `?${venueScope.venueQuery}` : '';
      const msgUrl = businessMode
        ? `/api/business/inbox/unread-count${venueQs}`
        : '/api/messages/unread-total';
      const notifUrl = businessMode
        ? `/api/notifications/unread-count${venueQs}`
        : '/api/notifications/unread-count';
      const [unreadRes, msgRes, hostRes] = await Promise.allSettled([
        apiGet(notifUrl),
        apiGet(msgUrl),
        // Host unread only when not pure partygoer chrome (defer cost on Home).
        activeMode === 'partygoer'
          ? Promise.resolve({ count: 0 })
          : apiGet('/api/host/notifications/unread-count'),
      ]);
      const notif =
        unreadRes.status === 'fulfilled' && typeof unreadRes.value?.count === 'number'
          ? unreadRes.value.count
          : 0;
      let msgs = 0;
      if (msgRes.status === 'fulfilled') {
        const m = msgRes.value;
        msgs = typeof m?.total === 'number' ? m.total : typeof m?.count === 'number' ? m.count : 0;
      }
      const host =
        hostRes.status === 'fulfilled' && typeof hostRes.value?.count === 'number'
          ? hostRes.value.count
          : 0;
      return { notif, msgs, host };
    },
  });

  useEffect(() => {
    if (!user?.id) {
      setNotificationCount(0);
      setMessageUnread(0);
      setHostUnread(0);
      return;
    }
    if (activeMode === 'business' && !venueScope.venueQuery) {
      setNotificationCount(0);
      setMessageUnread(0);
      setHostUnread(0);
      return;
    }
    if (!badgeCounts) return;
    setNotificationCount(badgeCounts.notif);
    setMessageUnread(badgeCounts.msgs);
    setHostUnread(badgeCounts.host);
    queryClient.setQueryData(['notifications-unread'], badgeCounts.notif);
  }, [user?.id, activeMode, venueScope.venueQuery, badgeCounts, queryClient]);


  useEffect(() => {
    const onRefresh = (event) => {
      const detail = event?.detail;
      if (detail && typeof detail === 'object') {
        if (typeof detail.notif === 'number') {
          setNotificationCount(Math.max(0, detail.notif));
          queryClient.setQueryData(['notifications-unread'], Math.max(0, detail.notif));
        }
        if (typeof detail.msgs === 'number') {
          setMessageUnread(Math.max(0, detail.msgs));
        }
        if (typeof detail.host === 'number') {
          setHostUnread(Math.max(0, detail.host));
        }
        if (detail.skipRefetch) return;
      }
      void refetchBadges();
    };
    window.addEventListener('sec_notifications_refresh', onRefresh);
    return () => window.removeEventListener('sec_notifications_refresh', onRefresh);
  }, [refetchBadges, queryClient]);

  useEffect(() => {
    if (!user?.id) {
      setNotificationCount(0);
      setMessageUnread(0);
      setHostUnread(0);
      setUserRoles({ partygoer: true, host: false, business: false });
      setActiveMode(null);
      setComplianceAccess({ canReview: false, isSuperAdmin: false });
      setHasStaffAssignments(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        await flushPendingLegalAccepts();
      } catch {}
      const ownedVenues = activeVenueCtx?.venues ?? [];
      const ownsVenue =
        user.role === 'VENUE' ||
        !!rolesMe?.business ||
        ownedVenues.some((v) => v.is_owner === true || v.isOwner === true);
      const hasStaff = staffVenuesList.length > 0;
      if (!cancelled) setHasStaffAssignments(hasStaff);

      const canUseBusinessMode = ownsVenue || hasStaff;
      if (cancelled) return;
      setUserRoles({ partygoer: true, host: true, business: canUseBusinessMode });

      const saved = localStorage.getItem('sec_active_mode');
      let defaultMode = 'partygoer';
      if (saved === 'business' && canUseBusinessMode) defaultMode = 'business';
      else if (saved === 'partygoer') defaultMode = 'partygoer';
      else if (ownsVenue) defaultMode = 'business';
      else defaultMode = 'partygoer';
      if (saved === 'business' && !canUseBusinessMode) {
        localStorage.setItem('sec_active_mode', 'partygoer');
      }
      setActiveMode(defaultMode);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.role, rolesMe, staffVenuesList, activeVenueCtx?.venues]);

  useEffect(() => {
    if (!user?.id) {
      setComplianceAccess({ canReview: false, isSuperAdmin: false });
      return;
    }
    if (complianceData) {
      setComplianceAccess({
        canReview: !!complianceData.canReview,
        isSuperAdmin: !!complianceData.isSuperAdmin,
      });
    }
  }, [user?.id, complianceData]);

  const switchMode = (mode) => {
    setActiveMode(mode);
    localStorage.setItem('sec_active_mode', mode);
    window.dispatchEvent(new CustomEvent('sec_active_mode_changed', { detail: { mode } }));
  };

  useEffect(() => {
    const onModeChanged = (event) => {
      const mode = event?.detail?.mode || localStorage.getItem('sec_active_mode');
      if (mode === 'partygoer' || mode === 'business') setActiveMode(mode);
    };
    window.addEventListener('sec_active_mode_changed', onModeChanged);
    return () => window.removeEventListener('sec_active_mode_changed', onModeChanged);
  }, []);

  useEffect(() => {
    if (!user?.id) return undefined;
    const pages = ['Notifications', 'Friends', 'Profile', 'Messages', 'HostDashboard', 'Events', 'Home', 'Tables'];
    const run = () => {
      pages.forEach((p) => prefetchPage(p));
    };
    if (typeof requestIdleCallback !== 'undefined') {
      const id = requestIdleCallback(run, { timeout: 5000 });
      return () => cancelIdleCallback(id);
    }
    const tid = window.setTimeout(run, 2000);
    return () => clearTimeout(tid);
  }, [user?.id]);

  const prefetchNav = (page) => {
    if (page) prefetchPage(page);
  };

  const modeForGuard =
    activeMode && userRoles[activeMode] ? activeMode : (userRoles.business ? 'business' : 'partygoer');

  useEffect(() => {
    if (!user || !staffAccess.isStaffOnly || staffAccess.venuesLoading) return;
    if (currentPageName === 'BusinessDashboard' && !staffAccess.can('dashboard')) {
      navigate(createPageUrl('StaffDashboard'), { replace: true });
      return;
    }
    if (!staffAccess.inStaffSession && modeForGuard !== 'business') return;
    const perm = BUSINESS_PAGE_PERMISSIONS[currentPageName];
    if (perm && !staffAccess.can(perm)) {
      navigate(createPageUrl('StaffDashboard'), { replace: true });
    }
  }, [user, modeForGuard, staffAccess.isStaffOnly, staffAccess.inStaffSession, staffAccess.venuesLoading, staffAccess.can, currentPageName, navigate]);

  const { hideBottomNav: pageHidesNav } = getMobileNavState({ pageName: currentPageName, searchParams });
  const formHidesNav = useMobileNavFormHide();
  const navOverlayHidden = !pageHidesNav && currentPageName !== 'HostDashboard' && formHidesNav;
  const isMobile = useIsMobile();
  const showLayoutBackHeader = isMobile && shouldShowMobileBackHeader(currentPageName);

  const hideNav =
    ['Onboarding', 'ProfileSetup', 'VenueOnboarding', 'Welcome', 'Login', 'Register', 'VerifyEmail', 'ForgotPassword', 'ResetPassword'].includes(currentPageName) ||
    isPublicDocumentPage(currentPageName);
  if (hideNav) {
    return (
      <div
        className="min-h-screen pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        style={{ backgroundColor: 'var(--sec-bg-base)', color: 'var(--sec-text-primary)' }}
      >
        {children}
        <CookieNoticeBanner />
      </div>
    );
  }

  const isGuestBrowse = !user;

  const badge = Math.max(0, Number(notificationCount) || 0);
  const availableModes = MODES.filter(m => userRoles[m.id]);
  const canAdminDashboard =
    Boolean(user?.can_admin_dashboard) || ['ADMIN', 'SUPER_ADMIN'].includes(user?.role);
  const complianceNavItem = complianceAccess.canReview
    ? [{ name: 'Compliance Review', icon: Shield, page: 'AdminDashboard', query: '?tab=compliance-documents' }]
    : [];

  const NAV = {
    partygoer: {
      primary: [
        { name: 'Home', icon: Home, page: 'Home' },
        { name: 'Host', icon: Crown, page: 'HostDashboard' },
        { name: 'Friends', icon: Users, page: 'Friends' },
        { name: 'Create', icon: Plus, page: 'HostDashboard', query: '?create=table' },
        { name: 'Messages', icon: MessageCircle, page: 'Messages' },
        { name: 'Profile', icon: User, page: 'Profile' },
      ],
      secondary: [
        { name: 'Events', icon: Calendar, page: 'Events' },
        { name: 'Vendors', icon: Store, page: 'Vendors' },
        { name: 'Jobs', icon: Briefcase, page: 'Jobs' },
        { name: 'Notifications', icon: Bell, page: 'Notifications', badge },
        { name: 'Leaderboard', icon: Trophy, page: 'Leaderboard' },
        ...(hasStaffAssignments ? [{ name: 'Staff Dashboard', icon: Shield, page: 'StaffDashboard' }] : []),
        ...complianceNavItem,
        ...(canAdminDashboard ? [{ name: 'Admin', icon: LayoutDashboard, page: 'AdminDashboard' }] : []),
      ],
    },
    business: {
      primary: [
        { name: 'Dashboard', icon: LayoutDashboard, page: 'BusinessDashboard' },
        { name: 'Analytics', icon: BarChart3, page: 'VenueAnalytics' },
        { name: 'Venue', icon: Building2, page: 'VenueProfile' },
        { name: 'Events', icon: Calendar, page: 'BusinessEvents' },
        { name: 'Bookings', icon: BookOpen, page: 'BusinessBookings' },
        { name: 'Tables', icon: Armchair, page: 'BusinessVenueTables' },
        { name: 'Refunds', icon: RotateCcw, page: 'BusinessRefundRequests' },
        { name: 'Menu', icon: BookOpen, page: 'BusinessMenu' },
      ],
      secondary: [
        { name: 'Vendors', icon: Store, page: 'Vendors' },
        { name: 'Post Job', icon: Briefcase, page: 'CreateJob' },
        { name: 'Jobs', icon: Briefcase, page: 'BusinessJobs' },
        { name: 'Promotions', icon: Megaphone, page: 'BusinessPromotions' },
        { name: 'Messages', icon: MessageCircle, page: 'BusinessMessages' },
        { name: 'Notifications', icon: Bell, page: 'Notifications', badge },
        ...complianceNavItem,
        { name: 'Settings', icon: Settings, page: 'Settings' },
      ],
    },
  };

  const mode = modeForGuard;
  const guestPrimaryNav = [
    { name: 'Home', icon: Home, page: 'Home' },
    { name: 'Events', icon: Calendar, page: 'Events' },
    { name: 'Map', icon: MapPin, page: 'Map' },
    { name: 'Log in', icon: LogIn, page: 'Login' },
    { name: 'Sign up', icon: User, page: 'Register' },
  ];
  const { primary: primaryNav, secondary: secondaryNav } = isGuestBrowse
    ? { primary: guestPrimaryNav, secondary: [] }
    : NAV[mode];

  const filterNavForStaff = (items) =>
    mode === 'business' && staffAccess.isStaffOnly
      ? filterBusinessNav(items, staffAccess.canAccessPage, staffAccess.can)
      : items;

  const withMessageBadge = (items) =>
    items.map((item) => {
      if ((item.page === 'Messages' || item.page === 'BusinessMessages') && messageUnread > 0) {
        return { ...item, badge: messageUnread };
      }
      if (item.page === 'HostDashboard' && hostUnread > 0) return { ...item, badge: hostUnread };
      return item;
    });
  const primaryNavB = withMessageBadge(filterNavForStaff(primaryNav));
  const secondaryNavB = withMessageBadge(filterNavForStaff(secondaryNav));

  const resolveNavTarget = (item) => {
    if (!item?.page) return createPageUrl('Home');
    if (staffAccess.staffContextToken && BUSINESS_PAGE_PERMISSIONS[item.page]) {
      return businessNavUrl(item.page, {
        query: item.query,
        staffContextToken: staffAccess.staffContextToken,
      });
    }
    return item.query ? `${createPageUrl(item.page)}${item.query}` : createPageUrl(item.page);
  };

  const attachNavTargets = (items) =>
    items.map((item) => ({ ...item, navTo: item.page ? resolveNavTarget(item) : null }));

  const onAdminNavClick = (page) => {
    if (page === 'AdminDashboard') enterPartygoerMode();
  };

  // Mobile: Unified 5-tab bottom nav — stay party-goer during staff sessions; 5th slot = More
  // Guests get browse-only tabs (Home / Events / Map) + Log in.
  const effectiveNavMode = staffAccess.inStaffSession ? 'partygoer' : mode;
  let mobileNav = isGuestBrowse
    ? [
        { name: 'Home', icon: Home, page: 'Home' },
        { name: 'Events', icon: Calendar, page: 'Events' },
        { name: 'Map', icon: MapPin, page: 'Map' },
        { name: 'Log in', icon: LogIn, page: 'Login' },
      ]
    : effectiveNavMode === 'business'
    ? [
        { name: 'Home', icon: LayoutDashboard, page: 'BusinessDashboard' },
        { name: 'Events', icon: Calendar, page: 'BusinessEvents' },
        { name: 'Create', icon: Plus, page: null, isCreate: true },
        { name: 'Messages', icon: MessageCircle, page: 'BusinessMessages' },
        { name: 'More', icon: LayoutGrid, page: null, isMore: true },
      ]
    : [
        { name: 'Home', icon: Home, page: 'Home' },
        { name: 'Host', icon: Crown, page: 'HostDashboard' },
        { name: 'Create', icon: Plus, page: 'HostDashboard', query: '?create=table' },
        { name: 'Messages', icon: MessageCircle, page: 'Messages' },
        { name: 'More', icon: LayoutGrid, page: null, isMore: true },
      ];
  mobileNav = attachNavTargets(withMessageBadge(filterNavForStaff(mobileNav)));

  // More sheet = desktop destinations not already on the bottom bar (Profile always included)
  const mobileBarKeys = new Set(
    mobileNav
      .filter((i) => i.page && !i.isMore)
      .map((i) => `${i.page}${i.query || ''}`),
  );
  // Create tab uses HostDashboard?create=table — still keep Host in More only if not bar'd without query
  const moreSource = [
    ...NAV[effectiveNavMode].primary,
    ...NAV[effectiveNavMode].secondary,
  ];
  // Ensure Profile is always reachable from More
  if (!moreSource.some((i) => i.page === 'Profile')) {
    moreSource.push({ name: 'Profile', icon: User, page: 'Profile' });
  }
  const moreNavItems = attachNavTargets(
    withMessageBadge(
      filterNavForStaff(
        moreSource.filter((item) => {
          if (!item.page) return false;
          const key = `${item.page}${item.query || ''}`;
          // Keep Create out of More (already center tab); keep exact bar pages out
          if (item.query === '?create=table') return false;
          if (mobileBarKeys.has(key)) return false;
          // Business Messages is on the bar — skip duplicate
          if (effectiveNavMode === 'business' && item.page === 'BusinessMessages') return false;
          if (effectiveNavMode === 'partygoer' && item.page === 'Messages') return false;
          return true;
        }),
      ),
    ),
  );

  const isActive = (page) => {
    if (page === 'CreateJob' && currentPageName === 'CreateJob') return true;
    return currentPageName === page;
  };

  const moreSheetActive =
    showMoreSheet ||
    moreNavItems.some((item) => item.page && isActive(item.page));

  if (currentPageName === 'TicketVerify') {
    return (
      <div className="min-h-screen" style={{ backgroundColor: 'var(--sec-bg-base)', color: 'var(--sec-text-primary)' }}>
        {children}
      </div>
    );
  }

  return (
    <div
      className="min-h-[100dvh] min-h-screen"
      style={{ backgroundColor: 'var(--sec-bg-base)', color: 'var(--sec-text-primary)' }}
      data-mobile-nav-visible={pageHidesNav || navOverlayHidden ? 'false' : 'true'}
    >

      {/* ── Desktop Sidebar ── */}
      <aside
        className="hidden lg:flex"
        style={{
          position: 'fixed', left: 0, top: 0, height: '100vh', width: 240,
          backgroundColor: 'var(--sec-bg-base)',
          borderRight: '1px solid var(--sec-border)',
          flexDirection: 'column', zIndex: 50,
        }}
      >
        <div style={{ padding: '22px 20px 20px', borderBottom: '1px solid var(--sec-border)' }}>
          <Link to={createPageUrl('Home')} style={{ display: 'flex', alignItems: 'center', textDecoration: 'none', color: 'inherit' }} onMouseEnter={() => prefetchNav('Home')} onFocus={() => prefetchNav('Home')}>
            <SecLogo size={48} variant="full" />
          </Link>
        </div>

        {user && mode === 'business' && (
          <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid var(--sec-border)' }}>
            <VenueSwitcher className="w-full" />
          </div>
        )}

        {user && availableModes.length > 1 && (
          <div style={{ padding: '10px 10px 8px', borderBottom: '1px solid var(--sec-border)' }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 4, padding: '0 10px' }}>
              Viewing As
            </div>
            {availableModes.map(m => {
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => switchMode(m.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', borderRadius: 8,
                    backgroundColor: active ? 'var(--sec-accent-muted)' : 'transparent',
                    border: active ? '1px solid var(--sec-accent-border)' : '1px solid transparent',
                    color: active ? 'var(--sec-text-primary)' : 'var(--sec-text-muted)',
                    cursor: 'pointer', fontSize: 13, fontWeight: active ? 600 : 400, transition: 'all 0.15s', textAlign: 'left',
                  }}
                >
                  <m.icon size={15} strokeWidth={1.5} />
                  {m.label}
                </button>
              );
            })}
          </div>
        )}

        <nav style={{ flex: 1, padding: '14px 10px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {attachNavTargets(primaryNavB).map((item) => (
              <Link
                key={item.page + item.name + (item.query || '')}
                to={item.navTo}
                className="sec-nav-item"
                onClick={() => onAdminNavClick(item.page)}
                onMouseEnter={() => prefetchNav(item.page)}
                onFocus={() => prefetchNav(item.page)}
                style={{ position: 'relative', ...(isActive(item.page) ? { color: 'var(--sec-text-primary)', backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' } : {}) }}
              >
                <item.icon {...iconProps} />
                <span>{item.name}</span>
                {item.page === 'HostDashboard' && item.query === '?create=table' && (
                  <span className="sec-badge sec-badge-gold" style={{ marginLeft: 'auto' }}>New</span>
                )}
                {item.badge > 0 && (
                  <span className="sec-nav-count-badge" style={{ marginLeft: 'auto' }}>
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </Link>
          ))}
          <div style={{ margin: '10px 2px', height: 1, backgroundColor: 'var(--sec-border)' }} />
          {attachNavTargets(secondaryNavB).map((item) => (
            <Link
              key={item.page + item.name}
              to={item.navTo}
              className="sec-nav-item"
              onClick={() => onAdminNavClick(item.page)}
              onMouseEnter={() => prefetchNav(item.page)}
              onFocus={() => prefetchNav(item.page)}
              style={{ position: 'relative', ...(isActive(item.page) ? { color: 'var(--sec-text-primary)', backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' } : {}) }}
            >
              <item.icon {...iconProps} />
              <span>{item.name}</span>
              {item.badge > 0 && (
                <span className="sec-nav-count-badge" style={{ marginLeft: 'auto' }}>
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
            </Link>
          ))}
        </nav>

        <div style={{ padding: 10, borderTop: '1px solid var(--sec-border)' }}>
          {userProfile ? (
            <Link to={createPageUrl('Profile')} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8, textDecoration: 'none', color: 'inherit', transition: 'background-color 0.15s' }} onMouseEnter={(e) => { prefetchNav('Profile'); e.currentTarget.style.backgroundColor = 'var(--sec-bg-card)'; }} onFocus={() => prefetchNav('Profile')} onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}>
              <div style={{ width: 34, height: 34, borderRadius: '50%', backgroundColor: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {userProfile.avatar_url ? <img src={userProfile.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-text-secondary)' }}>{(userProfile.username || user?.full_name || 'U')[0].toUpperCase()}</span>}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{userProfile.username || user?.full_name}</div>
                <div style={{ fontSize: 11, color: 'var(--sec-text-muted)' }}>View profile</div>
              </div>
            </Link>
          ) : (
            <button onClick={() => authService.redirectToLogin()} className="sec-btn sec-btn-primary sec-btn-full">Sign In</button>
          )}
        </div>
      </aside>

      {/* ── Main Content ── */}
      <main
        className={`lg:ml-[240px] min-h-[100dvh] min-h-screen w-full lg:w-[calc(100%-240px)] max-w-app md:max-w-app-md lg:max-w-none mx-auto lg:mx-0 px-4 sm:px-6 box-border min-w-0 lg:pb-10 ${
          isMobile && pageHidesNav
            ? 'pb-[env(safe-area-inset-bottom)]'
            : isMobile
              ? 'pb-[calc(84px+env(safe-area-inset-bottom))]'
              : ''
        }`}
        style={(() => {
          const showComplianceBanner =
            complianceAccess.canReview &&
            currentPageName !== 'AdminDashboard' &&
            currentPageName !== 'Profile';
          const shellNeedsTopInset =
            isMobile &&
            !showComplianceBanner &&
            !pageDrawsOwnStatusBarPadding(currentPageName, showLayoutBackHeader);
          const style = {};
          if (isMobile && !pageHidesNav) style.scrollPaddingBottom = MOBILE_MAIN_PADDING_BOTTOM;
          if (shellNeedsTopInset) style.paddingTop = 'env(safe-area-inset-top)';
          return Object.keys(style).length ? style : undefined;
        })()}
      >
        {complianceAccess.canReview && currentPageName !== 'AdminDashboard' && currentPageName !== 'Profile' && (
          <div
            className="lg:hidden"
            style={{
              paddingTop: 'max(12px, env(safe-area-inset-top))',
              paddingLeft: 'max(16px, env(safe-area-inset-left))',
              paddingRight: 'max(16px, env(safe-area-inset-right))',
            }}
          >
            <button
              type="button"
              onClick={() => {
                enterPartygoerMode();
                navigate(`${createPageUrl('AdminDashboard')}?tab=compliance-documents`);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '12px 14px',
                borderRadius: 14,
                textDecoration: 'none',
                color: 'var(--sec-text-primary)',
                backgroundColor: 'var(--sec-accent-muted)',
                border: '1px solid var(--sec-accent-border)',
                cursor: 'pointer',
              }}
            >
              <Shield size={16} style={{ color: 'var(--sec-accent)' }} />
              <span style={{ fontSize: 14, fontWeight: 600 }}>Open Compliance Review</span>
            </button>
          </div>
        )}
        {showLayoutBackHeader ? (
          <PageBackHeader
            title={getMobilePageTitle(currentPageName)}
            pageName={currentPageName}
          />
        ) : null}
        {children}
      </main>


      {/* ── Mobile profile switcher (Instagram-style) ── */}
      <Dialog open={showModeSwitcher} onOpenChange={setShowModeSwitcher}>
        <DialogContent
          className="max-w-sm"
          style={{
            backgroundColor: 'var(--sec-bg-card)',
            borderColor: 'var(--sec-border)',
            color: 'var(--sec-text-primary)',
          }}
        >
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--sec-text-primary)' }}>Viewing as</DialogTitle>
            <DialogDescription style={{ color: 'var(--sec-text-muted)' }}>
              Switch between your accounts
            </DialogDescription>
          </DialogHeader>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {availableModes.map((m) => {
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => {
                    switchMode(m.id);
                    setShowModeSwitcher(false);
                    // take user to the “home” of that mode
                    const dest = m.id === 'business' ? 'BusinessDashboard' : 'Home';
                    navigate(createPageUrl(dest));
                  }}
                  className="sec-card"
                  style={{
                    padding: 14,
                    borderRadius: 14,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    border: active ? '1px solid var(--sec-accent-border)' : '1px solid var(--sec-border)',
                    backgroundColor: active ? 'var(--sec-accent-muted)' : 'var(--sec-bg-elevated)',
                    color: 'var(--sec-text-primary)',
                  }}
                >
                  <m.icon size={18} strokeWidth={1.5} />
                  <div style={{ flex: 1, textAlign: 'left' }}>
                    <div style={{ fontWeight: 600 }}>{m.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>
                      {active ? 'Current' : 'Tap to switch'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {!pageHidesNav ? (
        <>
          <MobileBottomNav
            items={mobileNav}
            isActive={isActive}
            hidden={navOverlayHidden}
            availableModes={availableModes}
            onOpenModeSwitcher={() => setShowModeSwitcher(true)}
            onOpenMore={() => setShowMoreSheet(true)}
            moreActive={moreSheetActive}
            onPrefetch={prefetchNav}
          />
          <MobileMoreSheet
            open={showMoreSheet}
            onOpenChange={setShowMoreSheet}
            items={moreNavItems}
            isActive={isActive}
            mode={effectiveNavMode}
            availableModes={availableModes}
            onSwitchMode={(nextMode) => {
              switchMode(nextMode);
              const dest = nextMode === 'business' ? 'BusinessDashboard' : 'Home';
              navigate(createPageUrl(dest));
            }}
            onPrefetch={prefetchNav}
            onAdminNavClick={onAdminNavClick}
          />
        </>
      ) : null}
      {isGuestBrowse ? <GuestAgeGate /> : null}
      <CookieNoticeBanner />
    </div>
  );
}
