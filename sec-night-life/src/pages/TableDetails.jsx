import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createPageUrl, buildPageUrl, getStoredPromoterRef } from '@/utils';
import { isHostedEventListing } from '@/lib/hostedListingUrl';
import * as authService from '@/services/authService';
import { dataService } from '@/services/dataService';
import { apiGet, apiPost } from '@/api/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft, Share2, Users, DollarSign, Calendar, Clock,
  BadgeCheck, MessageCircle, UserPlus, Check, X, Crown,
  MoreVertical, CreditCard, Link as LinkIcon, Copy, ChevronRight,
  MapPin, Navigation,
} from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { format, parseISO, isToday, isTomorrow } from 'date-fns';
import { motion } from 'framer-motion';
import { getEventImage } from '@/lib/placeholders';
import { isIdentityVerifiedUser } from '@/lib/identityVerification';
import { toast } from 'sonner';

import InviteFriendsDialog from '@/components/tables/InviteFriendsDialog';
import HostedTableExperience from '@/components/tables/HostedTableExperience';
import AddonOrdersList from '@/components/orders/AddonOrdersList';
import OrderMoreDialog from '@/components/orders/OrderMoreDialog';
import SeatingPlanViewer from '@/components/seating/SeatingPlanViewer';
import { normalizeGuestSeatingPlans } from '@/lib/seatingPlanUtils';
import RefundPolicyNote from '@/components/legal/RefundPolicyNote';
import { launchPaystackInline, loadPaystackScript } from '@/lib/paystackInline';
import { completePaystackCheckout } from '@/lib/completePaystackCheckout';
import QRCode from 'qrcode';
import { resolveTicketVerifyUrl } from '@/utils';
import VenueMenuBrowser, { getVenueMenuCartStats } from '@/components/menu/VenueMenuBrowser';
import TableCheckoutFooter from '@/components/menu/TableCheckoutFooter';
import { mobileFooterPadding, MOBILE_NAV_BOTTOM_OFFSET } from '@/lib/layoutConstants';
import CheckoutCart from '@/components/checkout/CheckoutCart';
import { CustomTableRequestForm } from '@/components/tables/CustomTableRequestModal';
import DayBookingTimeSlotPicker, { isWindowValid } from '@/components/tables/DayBookingTimeSlotPicker';
import { getDirectionsActions } from '@/lib/openDirections';
import { useMoney } from '@/hooks/useMoney';
import {
  isDayBookingVenueTable,
  resolveDayBookingContext,
  canRestoreVenueCheckoutDraft,
} from '@/lib/resolveDayBookingContext';

const guestBookQueryOpts = {
  staleTime: 0,
  refetchOnMount: 'always',
  refetchOnWindowFocus: true,
};

/* ── small shared helpers ─────────────────────────────────────── */

function CircleBtn({ onClick, children, style = {} }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
        backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', color: 'var(--sec-text-secondary)',
        transition: 'border-color 0.15s, background-color 0.15s',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function StatCell({ value, label, valueStyle = {} }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <p style={{ fontSize: 20, fontWeight: 700, color: 'var(--sec-text-primary)', letterSpacing: '-0.02em', ...valueStyle }}>
        {value}
      </p>
      <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 2, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {label}
      </p>
    </div>
  );
}

function HostCheckoutQrInline({ ticket }) {
  const [dataUrl, setDataUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const verifyUrl = resolveTicketVerifyUrl(ticket) || null;
    if (!verifyUrl) return undefined;
    QRCode.toDataURL(verifyUrl, {
      width: 160,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a0a0b', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ticket]);

  if (!ticket) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      {dataUrl ? (
        <img src={dataUrl} alt="Table pass QR" style={{ width: 160, height: 160, borderRadius: 8, background: '#fff', padding: 4 }} />
      ) : (
        <div style={{ width: 160, height: 160, borderRadius: 8, background: 'var(--sec-bg-elevated)' }} />
      )}
      {ticket.expires_at ? (
        <p style={{ fontSize: 12, color: 'var(--sec-text-secondary)', margin: 0 }}>
          Valid until {format(parseISO(ticket.expires_at), 'EEE d MMM, HH:mm')}
        </p>
      ) : null}
    </div>
  );
}

/* ── page ─────────────────────────────────────────────────────── */

export default function TableDetails() {
  const money = useMoney();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [showJoinDialog, setShowJoinDialog] = useState(false);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [joinMessage, setJoinMessage] = useState('');
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [hostPaySuccess, setHostPaySuccess] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [hostFulfillmentPending, setHostFulfillmentPending] = useState(false);
  const [awaitingFulfillment, setAwaitingFulfillment] = useState(false);
  const [fulfillmentError, setFulfillmentError] = useState(null);
  const [repairingFulfillment, setRepairingFulfillment] = useState(false);
  const [lastPaymentReference, setLastPaymentReference] = useState(null);
  const autoRepairAttemptedRef = useRef(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const urlParams = new URLSearchParams(window.location.search);
  const tableId = urlParams.get('id');
  const autoJoin = urlParams.get('join');
  const source = urlParams.get('source');
  const bookingModeParam = urlParams.get('mode');
  const settlementParam = urlParams.get('settlement');
  const checkoutParam = urlParams.get('checkout');
  const windowStartParam = urlParams.get('windowStart') || urlParams.get('window_start');
  const windowEndParam = urlParams.get('windowEnd') || urlParams.get('window_end');
  const [dayBookingWindow, setDayBookingWindow] = useState(null);
  const isVenueSource = source === 'venue';
  const isHostCheckout = bookingModeParam === 'host';
  const [selectedMenuItems, setSelectedMenuItems] = useState({});
  const [hostedMenuSelected, setHostedMenuSelected] = useState({});
  const [venueSettlementMode, setVenueSettlementMode] = useState(() =>
    settlementParam === 'PREPAY_LUMP' ? 'PREPAY_LUMP' : 'PREPAY_MENU',
  );
  const [venueCheckoutStep, setVenueCheckoutStep] = useState(() =>
    settlementParam === 'PREPAY_LUMP' ? 'checkout' : 'menu',
  );
  const [customRequestStep, setCustomRequestStep] = useState(null);
  const [customSubmitting, setCustomSubmitting] = useState(false);
  const [seatingViewerOpen, setSeatingViewerOpen] = useState(false);

  useEffect(() => { loadUser(); }, []);

  useEffect(() => {
    if (isVenueSource && user?.id) {
      loadPaystackScript().catch(() => {});
    }
  }, [isVenueSource, user?.id]);

  useEffect(() => {
    setSelectedMenuItems({});
    setDayBookingWindow(null);
  }, [tableId, bookingModeParam]);

  const loadUser = async () => {
    try {
      if (!authService.hasRefreshSession()) return;
      const { user: currentUser, userProfile: cachedProfile } = await authService.resolveUserForAction(
        window.location.href,
      );
      setUser(currentUser);
      if (cachedProfile) {
        setUserProfile(cachedProfile);
        return;
      }
      try {
        const profiles = await dataService.User.filter({ created_by: currentUser.email });
        if (profiles.length > 0) setUserProfile(profiles[0]);
      } catch {
        /* keep cached profile */
      }
    } catch (e) {
      // Soft fail — never clear local user while refresh session may still exist.
    }
  };

  const { data: table, isLoading } = useQuery({
    queryKey: ['table', tableId],
    queryFn: async () => { const t = await dataService.Table.filter({ id: tableId }); return t[0]; },
    enabled: !!tableId,
  });

  const { data: venueTable, isLoading: venueLoading } = useQuery({
    queryKey: ['venue-table', tableId],
    queryFn: async () => {
      try {
        return await apiGet(`/api/venue-tables/${tableId}`);
      } catch {
        return null;
      }
    },
    enabled: !!tableId && isVenueSource,
    retry: false,
    ...guestBookQueryOpts,
  });

  const { data: hostedTable, isLoading: hostedLoading } = useQuery({
    queryKey: ['hosted-table-detail', tableId],
    queryFn: async () => {
      try {
        return await apiGet(`/api/host/hosted-tables/${tableId}`);
      } catch {
        return null;
      }
    },
    enabled:
      !!tableId &&
      (source === 'hosted' ||
        (!isVenueSource && !isLoading && !table) ||
        (isVenueSource && !venueLoading && !venueTable)),
    retry: false,
  });

  useEffect(() => {
    if (!hostedTable?.kind || hostedTable.kind !== 'hosted') return;
    if (isHostedEventListing(hostedTable)) {
      navigate(buildPageUrl('EventDetails', { id: tableId, source: 'hosted' }), { replace: true });
    }
  }, [hostedTable, tableId, navigate]);

  const hostedEventId =
    hostedTable?.event_id ||
    hostedTable?.eventId ||
    venueTable?.eventId ||
    venueTable?.event?.id ||
    null;

  const venueTableSeatingPlans = normalizeGuestSeatingPlans(venueTable);

  const { data: hostedEventTiers } = useQuery({
    queryKey: ['event-table-tiers', hostedEventId],
    queryFn: () => apiGet(`/api/events/${encodeURIComponent(hostedEventId)}/table-tiers`),
    enabled: !!hostedEventId && venueTableSeatingPlans.length === 0,
  });

  const seatingPlans =
    venueTableSeatingPlans.length > 0
      ? venueTableSeatingPlans
      : normalizeGuestSeatingPlans(hostedEventTiers);
  const seatingPlan = seatingPlans[0] ?? null;

  const venueBookingMode = useMemo(() => {
    if (bookingModeParam === 'host') return 'host';
    if (bookingModeParam === 'join') return 'join';
    const specs = venueTable?.myMembership?.userSpecs;
    if (venueTable?.isCustomListing || specs?.guestCount) return 'custom_host';
    return 'join';
  }, [bookingModeParam, venueTable?.myMembership?.userSpecs, venueTable?.isCustomListing]);

  useEffect(() => {
    if (!isVenueSource || venueLoading || !venueTable) return;
    const isJoinMode = bookingModeParam === 'join' || (!bookingModeParam && venueBookingMode === 'join');
    const isDayBooking = isDayBookingVenueTable(venueTable);
    if (isJoinMode && venueTable.hostedTableId && !isDayBooking) {
      navigate(
        `${createPageUrl('TableDetails')}?id=${encodeURIComponent(venueTable.hostedTableId)}&source=hosted&join=1`,
        { replace: true },
      );
    }
  }, [isVenueSource, venueLoading, venueTable, bookingModeParam, venueBookingMode, navigate]);

  const needsTierOccupancy =
    isVenueSource &&
    !!venueTable &&
    isDayBookingVenueTable(venueTable) &&
    !Array.isArray(venueTable?.dayOccupancy);

  const { data: dayTierData } = useQuery({
    queryKey: ['venue-day-table-tiers', venueTable?.venueId],
    queryFn: () => apiGet(`/api/venues/${venueTable.venueId}/day-table-tiers`),
    enabled: needsTierOccupancy && !!venueTable?.venueId,
    ...guestBookQueryOpts,
  });

  const dayBookingCtx = useMemo(
    () =>
      venueTable
        ? resolveDayBookingContext(venueTable, { tierData: dayTierData })
        : null,
    [venueTable, dayTierData],
  );

  const isDayBookingTable = Boolean(dayBookingCtx?.isDayBooking);
  const venueDayWindow = dayBookingCtx?.venueWindow ?? null;
  const dayOccupancy = dayBookingCtx?.dayOccupancy ?? [];
  const availableGaps = dayBookingCtx?.availableGaps ?? [];
  const dayOpenToday = dayBookingCtx?.isOpenToday ?? false;

  useEffect(() => {
    if (!isDayBookingTable || !dayOpenToday) return;
    const fromUrl =
      windowStartParam && windowEndParam
        ? { startTime: windowStartParam, endTime: windowEndParam }
        : null;
    const membership = venueTable?.myMembership;
    const canRestore = canRestoreVenueCheckoutDraft(membership, { isHostCheckout });
    const fromMember =
      canRestore && membership?.windowStartTime && membership?.windowEndTime
        ? { startTime: membership.windowStartTime, endTime: membership.windowEndTime }
        : null;
    setDayBookingWindow(fromUrl || fromMember || null);
  }, [
    isDayBookingTable,
    venueTable?.id,
    venueTable?.myMembership?.windowStartTime,
    venueTable?.myMembership?.windowEndTime,
    venueTable?.myMembership?.status,
    venueTable?.myMembership?.paidAt,
    venueTable?.myMembership?.bookingDate,
    isHostCheckout,
    windowStartParam,
    windowEndParam,
    dayOpenToday,
  ]);

  const bookingWindow = isDayBookingTable && dayOpenToday ? dayBookingWindow : null;
  const maxBookingDurationHours = dayBookingCtx?.maxBookingDurationHours ?? null;
  const maxDurationMinutes =
    maxBookingDurationHours != null && Number(maxBookingDurationHours) > 0
      ? Number(maxBookingDurationHours) * 60
      : null;
  const dayWindowReady =
    !isDayBookingTable ||
    !dayOpenToday ||
    isWindowValid(venueDayWindow, bookingWindow, dayOccupancy, {
      mode: isHostCheckout ? 'host' : 'join',
      maxDurationMinutes,
    });

  useEffect(() => {
    if (settlementParam === 'PREPAY_LUMP') {
      setVenueSettlementMode('PREPAY_LUMP');
      setVenueCheckoutStep('checkout');
    } else if (settlementParam === 'PREPAY_MENU') {
      setVenueSettlementMode('PREPAY_MENU');
      setVenueCheckoutStep('menu');
    }
  }, [settlementParam]);

  const venueMenuSelectionPayload = useMemo(
    () =>
      Object.entries(selectedMenuItems)
        .filter(([, qty]) => Number(qty) > 0)
        .map(([menuItemId, quantity]) => ({ menuItemId, quantity: Number(quantity) })),
    [selectedMenuItems],
  );

  const { data: venueCheckoutPreview } = useQuery({
    queryKey: ['venue-checkout-preview', tableId, venueMenuSelectionPayload, venueSettlementMode, venueBookingMode, bookingWindow?.startTime, bookingWindow?.endTime],
    queryFn: () =>
      apiPost(`/api/venue-tables/${tableId}/checkout-preview`, {
        selectedMenuItems: venueMenuSelectionPayload,
        settlementMode: venueSettlementMode,
        bookingMode: venueBookingMode,
        ...(bookingWindow
          ? { windowStart: bookingWindow.startTime, windowEnd: bookingWindow.endTime }
          : {}),
      }),
    enabled: isVenueSource && !!tableId && !!venueTable && (!isDayBookingTable || dayWindowReady),
  });

  const venueMembership = venueTable?.myMembership;
  const activePayReference = lastPaymentReference || venueMembership?.paystackReference || null;

  const { data: hostCheckoutTicket } = useQuery({
    queryKey: ['host-checkout-ticket', activePayReference],
    queryFn: async () => {
      const rows = await apiGet('/api/tickets/my?bucket=active');
      const list = Array.isArray(rows) ? rows : rows?.tickets || [];
      return list.find((t) => t.paystack_reference === activePayReference) || null;
    },
    enabled: Boolean(
      activePayReference &&
        (hostPaySuccess || paymentComplete || hostFulfillmentPending || awaitingFulfillment),
    ),
    refetchInterval: (query) =>
      hostFulfillmentPending || awaitingFulfillment || (paymentComplete && !query.state.data)
        ? 4000
        : false,
  });

  const [orderMoreOpen, setOrderMoreOpen] = useState(false);

  useEffect(() => {
    if (urlParams.get('request') === '1') {
      setCustomRequestStep('menu');
    }
  }, []);

  const isAlreadyHostedByUser =
    isVenueSource &&
    isHostCheckout &&
    venueMembership?.status === 'CONFIRMED' &&
    (venueMembership?.memberRole === 'HOST' || venueTable?.hostUserId === user?.id);

  useEffect(() => {
    if (isAlreadyHostedByUser) setHostPaySuccess(true);
  }, [isAlreadyHostedByUser]);

  useEffect(() => {
    if (!isVenueSource || !venueMembership) return;
    if (
      venueMembership.status === 'CONFIRMED' &&
      (venueMembership.paidAt || Number(venueMembership.amountPaid) > 0)
    ) {
      setPaymentComplete(true);
    }
  }, [isVenueSource, venueMembership?.status, venueMembership?.paidAt, venueMembership?.amountPaid]);

  useEffect(() => {
    if (!hostCheckoutTicket) return;
    setPaymentComplete(true);
    if (isHostCheckout) setHostPaySuccess(true);
    setAwaitingFulfillment(false);
    setFulfillmentError(null);
  }, [hostCheckoutTicket, isHostCheckout]);

  useEffect(() => {
    if (!isVenueSource || !tableId || !venueMembership?.paystackReference) return;
    if (hostCheckoutTicket || autoRepairAttemptedRef.current) return;
    if (venueMembership.status !== 'CONFIRMED') return;
    if (!isHostCheckout && venueMembership.memberRole !== 'HOST') return;

    autoRepairAttemptedRef.current = true;
    const ref = venueMembership.paystackReference;
    setLastPaymentReference(ref);
    setAwaitingFulfillment(true);
    void completePaystackCheckout({
      reference: ref,
      queryClient,
      showToasts: false,
      pollUntilFulfilled: true,
      pollMaxMs: 90000,
    }).then((result) => {
      if (result.fulfilled) {
        setPaymentComplete(true);
        setHostPaySuccess(true);
        setFulfillmentError(null);
      } else if (result?.fulfillment?.error) {
        setFulfillmentError(result.fulfillment.error);
      }
      setAwaitingFulfillment(false);
      queryClient.invalidateQueries(['venue-table', tableId]);
      queryClient.invalidateQueries({ queryKey: ['my-tickets'] });
    });
  }, [
    isVenueSource,
    tableId,
    isHostCheckout,
    venueMembership?.paystackReference,
    venueMembership?.status,
    venueMembership?.memberRole,
    hostCheckoutTicket,
    queryClient,
  ]);

  const runRepairFulfillment = async (ref, { silent = false, showRepairing = false } = {}) => {
    if (!ref || !tableId) return null;
    if (showRepairing) setRepairingFulfillment(true);
    if (!silent) setFulfillmentError(null);
    try {
      const res = await apiPost(`/api/venue-tables/${tableId}/repair-fulfillment`, {
        paystackReference: ref,
      });
      queryClient.invalidateQueries(['venue-table', tableId]);
      queryClient.invalidateQueries({ queryKey: ['host-checkout-ticket', ref] });
      queryClient.invalidateQueries({ queryKey: ['my-tickets'] });
      if (res?.fulfilled) {
        setPaymentComplete(true);
        setHostPaySuccess(true);
        setFulfillmentError(null);
        setAwaitingFulfillment(false);
        if (!silent) toast.success('Table pass ready — check your QR below');
      } else if (!silent) {
        setFulfillmentError(res?.hostError || res?.reason || 'Could not complete table setup');
        toast.error('Table setup still incomplete', {
          description: `Reference ${ref}. Contact support if this persists.`,
        });
      } else if (res?.hostError) {
        setFulfillmentError(res.hostError);
      }
      return res;
    } catch (e) {
      const msg = e?.data?.error || e?.message || 'Repair failed';
      if (!silent) {
        setFulfillmentError(msg);
        toast.error(msg);
      }
      return null;
    } finally {
      if (showRepairing) setRepairingFulfillment(false);
    }
  };

  const retryRepairFulfillment = async () => {
    const ref = activePayReference;
    if (!ref || !tableId) return;
    await runRepairFulfillment(ref, { showRepairing: true });
  };

  useEffect(() => {
    if (!isVenueSource || !venueTable) return;
    const membership = venueTable.myMembership;
    const canRestore = canRestoreVenueCheckoutDraft(membership, { isHostCheckout });
    if (!canRestore) return;
    setSelectedMenuItems((prev) => {
      const next = { ...prev };
      const stored = membership?.selectedMenuItems || membership?.userSpecs?.selectedMenuItems;
      if (Array.isArray(stored)) {
        for (const s of stored) {
          const id = s.menuItemId || s.menu_item_id;
          if (id) next[id] = String(s.quantity || 1);
        }
      }
      return next;
    });
    const specs = membership?.userSpecs;
    if (membership?.status === 'APPROVED' || checkoutParam === '1') {
      if (specs?.minSpendMode === 'manual' && specs?.proposedMinimumSpend != null) {
        setVenueSettlementMode('PREPAY_LUMP');
      } else if (Array.isArray(specs?.selectedMenuItems) && specs.selectedMenuItems.length > 0) {
        setVenueSettlementMode('PREPAY_MENU');
      }
      setVenueCheckoutStep('checkout');
    }
  }, [isVenueSource, venueTable?.id, venueTable?.myMembership, isHostCheckout, checkoutParam]);

  const joinVenueTable = async () => {
    let actor = user;
    if (!actor?.id) {
      if (authService.hasRefreshSession()) {
        try {
          const { user: u } = await authService.resolveUserForAction(window.location.href);
          setUser(u);
          actor = u;
        } catch (err) {
          if (err?.name === 'AuthRequiredError') return;
          toast.error('Still signing you in — try again in a moment.');
          return;
        }
      } else {
        authService.redirectToLogin(window.location.href, { force: true });
        return;
      }
    }
    if (!actor?.id) {
      toast.error('Still signing you in — try again in a moment.');
      return;
    }
    const membership = venueTable?.myMembership;
    if (membership?.status === 'PENDING_VENUE_REVIEW') {
      toast.error('Awaiting venue approval before checkout');
      return;
    }
    if (membership?.status === 'DECLINED') {
      toast.error('Your request was declined');
      return;
    }
    if (venueCheckoutPreview?.error) {
      toast.error(venueCheckoutPreview.error);
      return;
    }
    if (!dayWindowReady) {
      toast.error('Choose a valid arrival and leave time');
      return;
    }
    const selected =
      venueSettlementMode === 'PREPAY_LUMP'
        ? []
        : Object.entries(selectedMenuItems)
            .filter(([, qty]) => Number(qty) > 0)
            .map(([menuItemId, quantity]) => ({ menuItemId, quantity: Number(quantity) }));
    setIsProcessingPayment(true);
    try {
      const pay = await apiPost(`/api/venue-tables/${tableId}/join`, {
        selectedMenuItems: selected,
        settlementMode: venueSettlementMode,
        bookingMode: venueBookingMode,
        ...(bookingWindow
          ? { windowStart: bookingWindow.startTime, windowEnd: bookingWindow.endTime }
          : {}),
      });
      const refreshBookingQueries = () => {
        queryClient.invalidateQueries(['venue-table', tableId]);
        queryClient.invalidateQueries({ queryKey: ['my-tickets'] });
        queryClient.invalidateQueries(['notifications']);
        queryClient.invalidateQueries(['notifications-unread']);
        if (venueTable?.eventId) {
          queryClient.invalidateQueries(['event', venueTable.eventId]);
          queryClient.invalidateQueries(['event-table-tiers', venueTable.eventId]);
        }
      };
      if (pay?.needsFulfillment && pay?.paystackReference) {
        setLastPaymentReference(pay.paystackReference);
        setAwaitingFulfillment(true);
        setPaymentComplete(true);
        void retryRepairFulfillment();
        return;
      }
      if (pay?.confirmed) {
        refreshBookingQueries();
        setPaymentComplete(true);
        if (isHostCheckout) {
          setHostPaySuccess(true);
          toast.success('You are now hosting this table');
        } else {
          toast.success('Booking confirmed');
        }
        return;
      }
      if (pay?.reference && pay?.access_code) {
        await launchPaystackInline({
          email: user?.email,
          amount: pay?.amount || pay?.amount_zar || 0,
          reference: pay.reference,
          accessCode: pay.access_code,
          authorizationUrl: pay.authorization_url,
          onSuccess: (payload) => {
            setLastPaymentReference(pay.reference);
            setAwaitingFulfillment(true);
            setFulfillmentError(null);

            void runRepairFulfillment(pay.reference, { silent: true });

            void completePaystackCheckout({
              reference: pay.reference,
              payload,
              queryClient,
              showToasts: true,
              retries: 4,
              baseDelayMs: 800,
              pollUntilFulfilled: true,
              pollMaxMs: 120000,
            }).then((result) => {
              refreshBookingQueries();
              if (result.fulfilled) {
                setPaymentComplete(true);
                if (isHostCheckout) setHostPaySuccess(true);
                setFulfillmentError(null);
              } else if (result?.fulfillment?.error) {
                setFulfillmentError(result.fulfillment.error);
              }
              setAwaitingFulfillment(false);
            });

            window.setTimeout(() => {
              void runRepairFulfillment(pay.reference, { silent: true }).then((res) => {
                if (res?.fulfilled) refreshBookingQueries();
              });
            }, 15000);
          },
        });
      } else {
        toast.error('Could not start payment. Please try again.');
      }
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Could not start payment');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const { data: event } = useQuery({
    queryKey: ['table-event', table?.event_id],
    queryFn: async () => { const e = await dataService.Event.filter({ id: table.event_id }); return e[0]; },
    enabled: !!table?.event_id,
  });

  const { data: venue } = useQuery({
    queryKey: ['table-venue', table?.venue_id],
    queryFn: async () => { const v = await dataService.Venue.filter({ id: table.venue_id }); return v[0]; },
    enabled: !!table?.venue_id,
  });

  const { data: host } = useQuery({
    queryKey: ['table-host', table?.host_user_id],
    queryFn: async () => {
      const u = await dataService.User.filter({ id: table.host_user_id });
      return u[0];
    },
    enabled: !!table?.host_user_id,
    staleTime: 120_000,
  });

  const { data: members = [] } = useQuery({
    queryKey: ['table-members', table?.id, (table?.members || []).map((m) => m.user_id).join(',')],
    queryFn: async () => {
      if (!table?.members?.length) return [];
      const ids = [...new Set(table.members.map((m) => m.user_id).filter(Boolean))];
      const profiles = await Promise.all(ids.map((id) => dataService.User.filter({ id })));
      const byId = new Map();
      for (const rows of profiles) {
        const u = Array.isArray(rows) ? rows[0] : rows;
        if (u?.id) byId.set(u.id, u);
      }
      return table.members.map((m) => byId.get(m.user_id)).filter(Boolean);
    },
    enabled: !!table?.members?.length,
    staleTime: 60_000,
  });

  const handleJoinTable = async () => {
    if (!userProfile) {
      if (authService.hasRefreshSession()) {
        try {
          await loadUser();
        } catch {
          /* ignore */
        }
        if (!userProfile && !user) {
          toast.error('Still signing you in — try again in a moment.');
          return;
        }
      } else {
        authService.redirectToLogin(window.location.href, { force: true });
        return;
      }
    }
    if (table.joining_fee > 0) { setShowJoinDialog(false); setShowPaymentDialog(true); }
    else joinMutation.mutate();
  };

  const handlePayment = async () => {
    if (window.self !== window.top) {
      alert('Payment checkout only works in the published app. Please open the app in a new tab.');
      return;
    }
    setIsProcessingPayment(true);
    try {
      const res = await apiPost('/api/payments/initialize', {
        amount: table.joining_fee,
        email: userProfile?.email || user?.email,
        description: `Join Table: ${table.name}`,
        metadata: {
          type: 'table',
          table_id: tableId,
          user_id: userProfile?.id || user?.id,
          ...(getStoredPromoterRef(table?.event_id) ? { promoter_user_id: getStoredPromoterRef(table?.event_id) } : {}),
        },
      });
      if (res?.reference && res?.access_code) {
        await launchPaystackInline({
          email: userProfile?.email || user?.email,
          amount: table.joining_fee,
          reference: res.reference,
          accessCode: res.access_code,
          onSuccess: async (payload) => {
            await completePaystackCheckout({ reference: res.reference, payload, queryClient, showToasts: false });
            queryClient.invalidateQueries(['table', tableId]);
            setShowPaymentDialog(false);
            toast.success('Payment successful');
          },
        });
      } else throw new Error('No payment reference');
    } catch {
      alert('Payment failed. Please try again.');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleShare = async () => {
    const shareUrl = `${window.location.origin}${createPageUrl('TableDetails')}?id=${tableId}`;
    if (navigator.share) {
      try { await navigator.share({ title: table.name, text: `Join my table at ${event?.title || 'this event'}!`, url: shareUrl }); }
      catch {}
    } else setShowShareDialog(true);
  };

  const copyLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}${createPageUrl('TableDetails')}?id=${tableId}`);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const joinMutation = useMutation({
    mutationFn: async () => {
      const updatedMembers = [
        ...(table.members || []),
        { user_id: userProfile?.id, status: 'pending', joined_at: new Date().toISOString(), contribution: 0 },
      ];
      await dataService.Table.update(tableId, {
        members: updatedMembers,
        pending_requests: [...(table.pending_requests || []), userProfile?.id],
      });
      await dataService.Notification.create({
        user_id: table.host_user_id, type: 'table_request',
        title: 'New Table Request',
        message: `${userProfile?.username || 'Someone'} wants to join your table "${table.name}"`,
        data: { table_id: tableId, user_id: userProfile?.id },
        action_url: createPageUrl(`TableDetails?id=${tableId}`),
      });
    },
    onSuccess: () => { setShowJoinDialog(false); queryClient.invalidateQueries(['table', tableId]); },
  });

  const acceptRequestMutation = useMutation({
    mutationFn: async (requestUserId) => {
      const member = table.members.find(m => m.user_id === requestUserId);
      const totalPayment = (member?.contribution || 0) + (table.joining_fee || 0);
      const updatedMembers = table.members.map(m =>
        m.user_id === requestUserId ? { ...m, status: 'confirmed' } : m
      );
      await dataService.Table.update(tableId, {
        members: updatedMembers,
        pending_requests: table.pending_requests.filter(id => id !== requestUserId),
        current_guests: (table.current_guests || 1) + 1,
      });
      if (totalPayment > 0) {
        await dataService.Notification.create({
          user_id: requestUserId, type: 'payment',
          title: 'Complete Your Payment',
          message: `Your request to join "${table.name}" was accepted! Complete your payment of R${totalPayment.toLocaleString()} to finalize.`,
          data: { table_id: tableId, amount: totalPayment, contribution: member?.contribution || 0, joining_fee: table.joining_fee || 0 },
          action_url: createPageUrl(`TablePayment?id=${tableId}`),
        });
      } else {
        await dataService.Notification.create({
          user_id: requestUserId, type: 'table_invite',
          title: 'Request Accepted!',
          message: `You've been accepted to join "${table.name}"`,
          data: { table_id: tableId },
          action_url: createPageUrl(`TableDetails?id=${tableId}`),
        });
      }
      const chats = await dataService.Chat.filter({ related_table_id: tableId });
      if (chats.length > 0) {
        const chat = chats[0];
        await dataService.Chat.update(chat.id, {
          participants: [...new Set([...chat.participants, requestUserId])],
        });
      }
    },
    onSuccess: () => { queryClient.invalidateQueries(['table', tableId]); },
  });

  const isHost = user?.id === table?.host_user_id;
  const identityOk = isIdentityVerifiedUser(user, userProfile);
  const isMember = table?.members?.some(m => m.user_id === userProfile?.id);
  const isPending = table?.pending_requests?.includes(userProfile?.id);
  const spotsLeft = (table?.max_guests || 10) - (table?.current_guests || 1);

  useEffect(() => {
    if (autoJoin === 'true' && userProfile && table && !isHost && !isMember && !isPending && spotsLeft > 0) {
      setShowJoinDialog(true);
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('join');
      window.history.replaceState({}, '', newUrl);
    }
  }, [autoJoin, userProfile, table, isHost, isMember, isPending, spotsLeft]);

  /* ── loading / not found ── */
  if (isVenueSource) {
    if (venueLoading) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
          <div className="sec-spinner" />
        </div>
      );
    }
    if (!venueTable) {
      if (hostedLoading) {
        return (
          <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
            <div className="sec-spinner" />
          </div>
        );
      }
      if (hostedTable?.kind === 'hosted') {
        if (isHostedEventListing(hostedTable)) {
          return (
            <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
              <div className="sec-spinner" />
            </div>
          );
        }
        return (
          <HostedTableExperience
            tableId={tableId}
            hostedTable={hostedTable}
            user={user}
            userProfile={userProfile}
            autoOpenJoin={autoJoin === '1' || autoJoin === 'true'}
            autoOpenCheckout={checkoutParam === '1'}
            onBack={() => navigate(-1)}
            seatingPlan={seatingPlan}
            seatingPlans={seatingPlans}
          />
        );
      }
      return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', backgroundColor: 'var(--sec-bg-base)' }}>Venue table not found</div>;
    }
    const includedSeed = {};
    for (const inc of venueTable.includedItems || []) {
      const id = inc.menu_item_id || inc.menuItemId;
      if (id) includedSeed[id] = Math.max(includedSeed[id] || 0, Number(inc.quantity) || 1);
    }

    const venueMenuItems = (venueTable.menuItems || []).map((item) => ({
      ...item,
      id: item.menuItemId || item.id,
      image_url: item.imageUrl || item.image_url,
      sub_category: item.sub_category || item.subCategory,
    }));
    const includedForPicker = (venueTable.includedItems || []).map((inc) => {
      const id = inc.menu_item_id || inc.menuItemId;
      const row = venueMenuItems.find((m) => m.id === id);
      return {
        menu_item_id: id,
        name: row?.name || inc.name || 'Included item',
        quantity: inc.quantity || 1,
        image_url: row?.image_url || null,
        price: row?.price || 0,
      };
    });
    const membership = venueTable.myMembership;
    const tablePurchased = paymentComplete || hostPaySuccess || isAlreadyHostedByUser;
    const showPurchasePanel = tablePurchased || hostFulfillmentPending || awaitingFulfillment;
    const membershipSpecs = membership?.userSpecs || {};
    const approvedCustomMin =
      membership?.status === 'APPROVED' && membershipSpecs.proposedMinimumSpend != null
        ? Number(membershipSpecs.proposedMinimumSpend)
        : null;
    const minSpendZar =
      approvedCustomMin != null
        ? approvedCustomMin
        : isHostCheckout
          ? Number(venueTable.hostMinimumSpend ?? venueTable.host_minimum_spend ?? venueTable.minimumSpend) || 0
          : Number(venueTable.minimumSpend) || 0;
    const { chargeableTotal, itemCount } = getVenueMenuCartStats(
      venueMenuItems,
      selectedMenuItems,
      includedForPicker,
    );
    const checkoutLines = venueCheckoutPreview?.lines?.length ? venueCheckoutPreview.lines : [];
    const checkoutTotal =
      venueCheckoutPreview?.total ?? checkoutLines.reduce((s, l) => s + Number(l.amount_zar || 0), 0);
    const isCustomHostCheckout = venueBookingMode === 'custom_host';
    const needsVenueApprovalBeforePay =
      (venueTable.isCustomListing && venueBookingMode !== 'join' && !isHostCheckout) ||
      (isCustomHostCheckout && !isHostCheckout && venueBookingMode !== 'join');
    const approvalOk =
      !needsVenueApprovalBeforePay ||
      isHostCheckout ||
      membership?.status === 'APPROVED' ||
      membership?.status === 'LEFT';
    const checkoutPreviewReady =
      Number(checkoutTotal) > 0 &&
      !venueCheckoutPreview?.error &&
      Array.isArray(venueCheckoutPreview?.lines);
    const minSpendMet =
      checkoutPreviewReady ||
      minSpendZar <= 0 ||
      venueSettlementMode === 'PREPAY_LUMP' ||
      chargeableTotal >= minSpendZar;
    const canPay = minSpendMet && approvalOk && !venueCheckoutPreview?.error && dayWindowReady;
    const inCustomRequestEntry = urlParams.get('request') === '1';
    const showCustomRequest =
      !isHostCheckout &&
      inCustomRequestEntry &&
      (venueTable.allowsCustomRequests || venueTable.isCustomListing) &&
      membership?.status !== 'APPROVED' &&
      membership?.status !== 'PENDING_VENUE_REVIEW';
    const inRequestFlow = showCustomRequest || (inCustomRequestEntry && membership?.status === 'PENDING_VENUE_REVIEW');
    const onRequestMenuStep = inRequestFlow && customRequestStep === 'menu';
    const onRequestDetailsStep = inRequestFlow && customRequestStep === 'details';
    const footerPad = onRequestMenuStep
      ? mobileFooterPadding(160)
      : onRequestDetailsStep
        ? mobileFooterPadding(24)
        : venueCheckoutStep === 'menu'
          ? mobileFooterPadding(minSpendZar > 0 ? 200 : 160)
          : mobileFooterPadding(120);
    return (
      <>
      <div style={{ minHeight: '100vh', background: 'var(--sec-bg-base)', padding: '12px 16px max(12px, env(safe-area-inset-top))', paddingBottom: footerPad }}>
        <button onClick={() => navigate(-1)} className="sec-btn sec-btn-ghost" style={{ marginBottom: 12 }}>Back</button>
        <div className="sec-card" style={{ padding: 16 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>{venueTable.tableName}</h1>
          <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>{venueTable.venue?.name}</p>
          {seatingPlan ? (
            <button
              type="button"
              onClick={() => setSeatingViewerOpen(true)}
              className="sec-link mt-2 text-sm inline-flex items-center gap-1"
              style={{ color: 'var(--sec-accent)' }}
            >
              <MapPin size={14} />
              View seating plan{seatingPlans.length > 1 ? ` (${seatingPlans.length} floors)` : ''}
            </button>
          ) : null}
          <p style={{ marginTop: 8, fontSize: 12, color: 'var(--sec-accent)', fontWeight: 600 }}>
            {isHostCheckout
              ? 'Hosting this table'
              : isCustomHostCheckout
                ? 'Complete your custom table booking'
                : 'Joining this table'}
          </p>
          {membership?.status === 'APPROVED' ? (
            <p style={{ marginTop: 6, fontSize: 12, color: 'var(--sec-success, #22c55e)' }}>
              Request approved — review your order and pay below.
            </p>
          ) : null}
          <p style={{ marginTop: 8 }}>{venueTable.description || 'No description'}</p>
          <p style={{ marginTop: 8, fontSize: 13 }}>{venueTable.spotsRemaining} spots left</p>
        </div>
        {tablePurchased && bookingWindow ? (
          <p style={{ marginTop: 12, fontSize: 12, color: 'var(--sec-text-secondary)' }}>
            Your booking window: {bookingWindow.startTime}–{bookingWindow.endTime}
          </p>
        ) : null}
        {showPurchasePanel ? (
          <div
            className="sec-card"
            style={{
              marginTop: 16,
              padding: 16,
              border: '1px solid var(--sec-success-muted, rgba(34,197,94,0.35))',
              background: 'var(--sec-success-muted, rgba(34,197,94,0.08))',
            }}
          >
            {(hostFulfillmentPending || awaitingFulfillment) && !hostCheckoutTicket && !fulfillmentError ? (
              <>
                <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 8 }}>
                  Preparing your table pass…
                </p>
                <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 0, color: 'var(--sec-text-secondary)' }}>
                  Payment received. Your QR ticket will appear here in a moment.
                </p>
              </>
            ) : fulfillmentError ? (
              <>
                <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-error, #ef4444)', marginBottom: 8 }}>
                  Payment received — table setup incomplete
                </p>
                <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 12, color: 'var(--sec-text-secondary)' }}>
                  {fulfillmentError}
                  {activePayReference ? (
                    <>
                      {' '}
                      Reference: <strong>{activePayReference}</strong>
                    </>
                  ) : null}
                </p>
                <button
                  type="button"
                  className="sec-btn sec-btn-primary sec-btn-full"
                  style={{ height: 44, marginBottom: 8 }}
                  disabled={repairingFulfillment}
                  onClick={() => void retryRepairFulfillment()}
                >
                  {repairingFulfillment ? 'Retrying…' : 'Retry fulfillment'}
                </button>
              </>
            ) : (
              <>
                <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-success, #22c55e)', marginBottom: 8 }}>
                  {isHostCheckout ? 'Paid — you are hosting this table' : 'Paid — your booking is confirmed'}
                </p>
                {isHostCheckout && hostCheckoutTicket ? (
                  <HostCheckoutQrInline ticket={hostCheckoutTicket} />
                ) : null}
                <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 12, color: 'var(--sec-text-secondary)' }}>
                  {isHostCheckout
                    ? 'Your QR ticket is in Profile → Tickets. Use Host Dashboard to approve join requests and set your table rules.'
                    : 'Your QR ticket is in Profile → Tickets.'}
                </p>
                {hostCheckoutTicket?.id && venueMembership?.status === 'CONFIRMED' ? (
                  <div style={{ marginBottom: 12 }}>
                    <AddonOrdersList ticketId={hostCheckoutTicket.id} className="mb-3" />
                    <button
                      type="button"
                      className="sec-btn sec-btn-secondary sec-btn-full"
                      style={{ height: 44 }}
                      onClick={() => setOrderMoreOpen(true)}
                    >
                      Order more from the menu
                    </button>
                    <OrderMoreDialog
                      open={orderMoreOpen}
                      onOpenChange={setOrderMoreOpen}
                      ticketId={hostCheckoutTicket.id}
                      email={user?.email}
                    />
                  </div>
                ) : null}
                {isHostCheckout ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <button
                      type="button"
                      className="sec-btn sec-btn-primary sec-btn-full"
                      style={{ height: 44 }}
                      onClick={() => navigate(createPageUrl('HostDashboard?tab=tables&manage=1'))}
                    >
                      Open Host Dashboard
                    </button>
                    <button
                      type="button"
                      className="sec-btn sec-btn-secondary sec-btn-full"
                      style={{ height: 44 }}
                      onClick={() => navigate(createPageUrl('Profile?tab=tickets'))}
                    >
                      View in Profile → Tickets
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="sec-btn sec-btn-primary sec-btn-full"
                    style={{ height: 44 }}
                    onClick={() => navigate(createPageUrl('Profile?tab=tickets'))}
                  >
                    View your QR ticket
                  </button>
                )}
              </>
            )}
          </div>
        ) : null}
        {onRequestDetailsStep ? (
          <CustomTableRequestForm
            compact
            venueMenuItems={venueMenuItems}
            selectedMenuItems={selectedMenuItems}
            submitting={customSubmitting}
            defaultWindow={bookingWindow}
            onBack={() => setCustomRequestStep('menu')}
            onSubmit={async (specs) => {
              setCustomSubmitting(true);
              try {
                await apiPost(`/api/venue-tables/${tableId}/request`, {
                  isCustom: true,
                  userSpecs: specs,
                });
                toast.success('Request sent — venue will review');
                setCustomRequestStep(null);
                queryClient.invalidateQueries(['venue-table', tableId]);
              } catch (e) {
                toast.error(e?.data?.error || e.message);
              } finally {
                setCustomSubmitting(false);
              }
            }}
          />
        ) : venueCheckoutStep === 'menu' ? (
          <>
            {inRequestFlow ? (
              <div
                className="sec-card"
                style={{
                  padding: '10px 14px',
                  marginBottom: 12,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--sec-accent)' }}>Step 1 of 2 · Choose menu</span>
                <span style={{ fontSize: 11, color: 'var(--sec-text-muted)' }}>Optional — add items for your request</span>
              </div>
            ) : null}
            {!tablePurchased && isDayBookingTable ? (
              <div style={{ marginTop: inRequestFlow ? 0 : 16, marginBottom: 16 }}>
                <DayBookingTimeSlotPicker
                  venueWindow={venueDayWindow}
                  value={dayBookingWindow}
                  onChange={setDayBookingWindow}
                  occupancy={dayOccupancy}
                  availableGaps={availableGaps}
                  serviceDay={dayBookingCtx?.serviceDay}
                  latestBookableEnd={dayBookingCtx?.latestBookableEnd}
                  isOvernight={dayBookingCtx?.isOvernight}
                  maxBookingDurationHours={maxBookingDurationHours}
                  mode={isHostCheckout ? 'host' : 'join'}
                  autoSelectDefault={!isHostCheckout}
                  closedToday={!dayOpenToday}
                  openDaysSummary={dayBookingCtx?.openDaysSummary}
                />
              </div>
            ) : null}
            <h2 style={{ fontSize: 15, fontWeight: 600, marginTop: inRequestFlow ? 0 : 16, marginBottom: 8 }}>
              {inRequestFlow ? 'Build your menu (optional)' : 'Select your menu'}
            </h2>
            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginBottom: 12 }}>
              {inRequestFlow
                ? 'Browse the full venue menu. When ready, continue to enter your table details.'
                : minSpendZar > 0
                  ? `Choose menu items worth at least R${minSpendZar.toFixed(0)}, or pay the minimum only and order on site (your QR is proof for staff).`
                  : 'Add items from the venue menu (optional).'}
            </p>
            <VenueMenuBrowser
              items={venueMenuItems}
              selected={selectedMenuItems}
              onChange={(id, qty) => {
                setVenueSettlementMode('PREPAY_MENU');
                setSelectedMenuItems((s) => ({ ...s, [id]: qty }));
              }}
              includedItems={includedForPicker}
              minimumSpendZar={inRequestFlow ? 0 : minSpendZar}
              venueLogoUrl={venueTable.venue?.logo_url || venueTable.venue?.logoUrl}
              hideStickyFooter
            />
          </>
        ) : (
          <>
            <button
              type="button"
              className="sec-btn"
              style={{
                marginTop: 14,
                marginBottom: 12,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 16px',
                borderRadius: 12,
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--sec-accent)',
                background: 'var(--sec-accent-muted)',
                border: '1px solid var(--sec-accent-border)',
              }}
              onClick={() => {
                setVenueCheckoutStep('menu');
                setVenueSettlementMode('PREPAY_MENU');
              }}
            >
              ← Edit menu selection
            </button>
            <CheckoutCart
              lines={checkoutLines}
              settlementMode={venueSettlementMode}
              minimumSpendZar={minSpendZar}
              footnote={
                venueSettlementMode === 'PREPAY_LUMP' && minSpendZar > 0
                  ? `You are prepaying R${minSpendZar.toFixed(0)} minimum spend. Choose drinks and food on site — show your SEC QR to staff.`
                  : undefined
              }
            />
          </>
        )}
        {membership?.status === 'PENDING_VENUE_REVIEW' ? (
          <p className="text-sm text-amber-400 mt-3 text-center">Request pending venue approval</p>
        ) : null}
        {venueCheckoutPreview?.error ? (
          <p style={{ color: 'var(--sec-warning)', fontSize: 13, marginTop: 12, textAlign: 'center' }}>
            {venueCheckoutPreview.error}
          </p>
        ) : null}
        {!dayWindowReady && isDayBookingTable && dayOpenToday && !tablePurchased ? (
          <p style={{ color: 'var(--sec-warning)', fontSize: 13, marginTop: 12, textAlign: 'center' }}>
            Choose a valid arrival and leave time within today&apos;s service window.
          </p>
        ) : null}
        {!canPay && venueCheckoutStep === 'checkout' && needsVenueApprovalBeforePay && !approvalOk ? (
          <p style={{ color: 'var(--sec-warning)', fontSize: 13, marginTop: 12, textAlign: 'center' }}>
            This custom table requires venue approval before you can pay. Submit a request and wait for approval.
          </p>
        ) : null}
        {!canPay && venueCheckoutStep === 'checkout' && minSpendZar > 0 && !venueCheckoutPreview?.error && approvalOk ? (
          <p style={{ color: 'var(--sec-text-muted)', fontSize: 12, marginTop: 8, textAlign: 'center' }}>
            {itemCount === 0
              ? 'Go back to choose menu items or pay the minimum spend only.'
              : 'Add more menu items to meet the minimum spend, or go back and choose “Skip menu”.'}
          </p>
        ) : null}
        {showCustomRequest && membership?.status !== 'PENDING_VENUE_REVIEW' && !customRequestStep ? (
          <button
            type="button"
            className="sec-btn sec-btn-primary sec-btn-full mt-3"
            style={{ height: 48, minHeight: 44 }}
            onClick={() => setCustomRequestStep('menu')}
          >
            Request custom table (venue reviews first)
          </button>
        ) : null}
        {onRequestMenuStep ? (
          <div
            className="table-checkout-footer sec-bottom-bar"
            style={{
              padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
              background: 'rgba(0,0,0,0.96)',
              borderTop: '1px solid var(--sec-border)',
              bottom: MOBILE_NAV_BOTTOM_OFFSET,
            }}
          >
            <div style={{ maxWidth: 960, margin: '0 auto', width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, fontSize: 13 }}>
                <span style={{ color: 'var(--sec-text-muted)' }}>
                  {itemCount} item{itemCount === 1 ? '' : 's'} selected
                </span>
                {chargeableTotal > 0 ? (
                  <span style={{ fontWeight: 700 }}>R{Number(chargeableTotal).toFixed(0)}</span>
                ) : null}
              </div>
              <button
                type="button"
                className="sec-btn sec-btn-primary sec-btn-full"
                style={{ height: 48, minHeight: 44 }}
                onClick={() => setCustomRequestStep('details')}
              >
                Continue to request details
              </button>
            </div>
          </div>
        ) : null}
        {!inRequestFlow && venueCheckoutStep === 'menu' && !tablePurchased ? (
          <TableCheckoutFooter
            itemCount={itemCount}
            cartTotalZar={chargeableTotal}
            minSpendZar={minSpendZar}
            minMet={minSpendMet}
            onContinue={() => {
              if (!dayWindowReady) {
                toast.error('Choose a valid arrival and leave time');
                return;
              }
              if (itemCount === 0 && minSpendZar > 0) {
                setVenueSettlementMode('PREPAY_LUMP');
              } else {
                setVenueSettlementMode('PREPAY_MENU');
              }
              setVenueCheckoutStep('checkout');
            }}
            continueLabel={
              itemCount === 0 && minSpendZar > 0
                ? 'Skip menu — pay minimum spend only'
                : 'Review order'
            }
          />
        ) : !inRequestFlow ? (
          <TableCheckoutFooter
            itemCount={itemCount}
            cartTotalZar={checkoutTotal}
            minSpendZar={minSpendZar}
            minMet
            onContinue={null}
          >
        {tablePurchased ? (
          <>
            <button
              type="button"
              disabled
              className="sec-btn sec-btn-primary sec-btn-full"
              style={{ height: 48, minHeight: 44, opacity: 0.65, cursor: 'default' }}
            >
              Paid
            </button>
            {isHostCheckout ? (
              <>
                <button
                  type="button"
                  className="sec-btn sec-btn-ghost sec-btn-full"
                  style={{ height: 44, marginTop: 8, border: '1px solid var(--sec-border)' }}
                  onClick={() => navigate(createPageUrl('HostDashboard?tab=tables&manage=1'))}
                >
                  Manage table in Host Dashboard
                </button>
                <button
                  type="button"
                  className="sec-btn sec-btn-ghost sec-btn-full"
                  style={{ height: 40, marginTop: 8, fontSize: 13 }}
                  onClick={() => navigate(createPageUrl('Profile?tab=tickets'))}
                >
                  View your QR ticket
                </button>
              </>
            ) : (
              <button
                type="button"
                className="sec-btn sec-btn-ghost sec-btn-full"
                style={{ height: 40, marginTop: 8, fontSize: 13 }}
                onClick={() => navigate(createPageUrl('Profile?tab=tickets'))}
              >
                View your QR ticket
              </button>
            )}
          </>
        ) : (
              <>
                <button
                  type="button"
                  onClick={joinVenueTable}
                  disabled={isProcessingPayment || !canPay}
                  className="sec-btn sec-btn-primary sec-btn-full"
                  style={{ height: 48, minHeight: 44 }}
                >
                  {isProcessingPayment
                    ? 'Processing…'
                    : checkoutTotal > 0
                      ? isHostCheckout || isCustomHostCheckout
                        ? `Pay R${checkoutTotal.toFixed(0)} to host`
                        : `Pay R${checkoutTotal.toFixed(0)} to join`
                      : 'Complete booking'}
                </button>
                <p style={{ color: 'var(--sec-warning)', fontSize: 12, marginTop: 4, textAlign: 'center' }}>
                  No refunds: once you pay, your booking is confirmed per venue policy.
                </p>
                <RefundPolicyNote />
              </>
            )}
          </TableCheckoutFooter>
        ) : null}
      </div>
      <SeatingPlanViewer
        open={seatingViewerOpen}
        onClose={() => setSeatingViewerOpen(false)}
        plans={seatingPlans}
      />
      </>
    );
  }

  if (isLoading || (!isVenueSource && !table && hostedLoading)) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
        <div className="sec-spinner" />
      </div>
    );
  }

  if (!isVenueSource && !table && hostedTable?.kind === 'hosted') {
    if (isHostedEventListing(hostedTable)) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
          <div className="sec-spinner" />
        </div>
      );
    }
    return (
      <HostedTableExperience
        tableId={tableId}
        hostedTable={hostedTable}
        user={user}
        userProfile={userProfile}
        autoOpenJoin={autoJoin === '1' || autoJoin === 'true'}
        autoOpenCheckout={checkoutParam === '1'}
        onBack={() => navigate(-1)}
        seatingPlan={seatingPlan}
        seatingPlans={seatingPlans}
      />
    );
  }

  if (!table) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)' }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Table not found</h2>
          <Link to={createPageUrl('Tables')} style={{ color: 'var(--sec-text-secondary)', fontSize: 14 }}>Browse Tables</Link>
        </div>
      </div>
    );
  }

  const progress = ((table?.current_guests || 1) / (table?.max_guests || 10)) * 100;
  const spendPerPerson = Math.ceil((table?.min_spend || 0) / (table?.max_guests || 1));
  const venueAddressLine = venue
    ? [venue.address, venue.suburb, venue.city, venue.province].filter(Boolean).join(', ')
    : '';

  const getDateLabel = () => {
    if (!event?.date) return '';
    const d = parseISO(event.date);
    if (isToday(d)) return 'Tonight';
    if (isTomorrow(d)) return 'Tomorrow';
    return format(d, 'EEE, MMM d');
  };

  /* ── status badge colour ── */
  const statusStyle = {
    open: { bg: 'var(--sec-success-muted)', color: 'var(--sec-success)', border: 'rgba(61,186,107,0.2)' },
    full: { bg: 'var(--sec-error-muted)', color: 'var(--sec-error)', border: 'rgba(217,85,85,0.2)' },
    closed: { bg: 'rgba(107,107,107,0.12)', color: 'var(--sec-text-muted)', border: 'rgba(107,107,107,0.2)' },
  }[table.status] || { bg: 'rgba(107,107,107,0.12)', color: 'var(--sec-text-muted)', border: 'rgba(107,107,107,0.2)' };

  /* ── capacity fill colour ── */
  const fillColor = progress < 50 ? 'var(--sec-success)' : progress < 85 ? 'var(--sec-accent)' : 'var(--sec-error)';

  /* ── dialog shared styles ── */
  const dialogContentStyle = {
    backgroundColor: 'var(--sec-bg-elevated)',
    border: '1px solid var(--sec-border)',
    borderRadius: 'var(--radius-xl)',
  };

  return (
    <div className="pb-24 lg:pb-8" style={{ minHeight: '100vh', backgroundColor: 'var(--sec-bg-base)' }}>

      {/* ── Header ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 40,
        backgroundColor: 'rgba(0,0,0,0.92)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid var(--sec-border)',
        padding: '0 20px', height: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <CircleBtn onClick={() => navigate(-1)}>
          <ChevronLeft size={18} strokeWidth={2} />
        </CircleBtn>
        <div style={{ display: 'flex', gap: 8 }}>
          <CircleBtn onClick={handleShare}>
            <Share2 size={16} strokeWidth={1.5} />
          </CircleBtn>
          {isHost && (
            <CircleBtn>
              <MoreVertical size={16} strokeWidth={1.5} />
            </CircleBtn>
          )}
        </div>
      </header>

      <div style={{ maxWidth: 960, margin: '0 auto', padding: '20px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Table info card ── */}
        <div className="sec-card" style={{ padding: '20px 20px 16px' }}>
          {/* Title row */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--sec-text-primary)', marginBottom: 4 }}>
                {table.name}
              </h1>
              <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>
                Hosted by {host?.username || 'Anonymous'}
              </p>
            </div>
            <span style={{
              padding: '4px 12px', borderRadius: 'var(--radius-pill)',
              fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
              backgroundColor: statusStyle.bg, color: statusStyle.color,
              border: `1px solid ${statusStyle.border}`,
              flexShrink: 0,
            }}>
              {table.status}
            </span>
          </div>

          {table.description && (
            <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', lineHeight: 1.6, marginBottom: 14 }}>
              {table.description}
            </p>
          )}

          {/* Capacity bar */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--sec-text-muted)' }}>Spots filled</span>
              <span style={{ fontWeight: 700, color: 'var(--sec-text-primary)' }}>
                {table.current_guests || 1}/{table.max_guests || 10}
              </span>
            </div>
            <div className="sec-progress" style={{ height: 4 }}>
              <motion.div
                className="sec-progress-fill"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
                style={{ backgroundColor: fillColor }}
              />
            </div>
          </div>

          {/* Stats — 3 columns */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12, paddingTop: 14,
            borderTop: '1px solid var(--sec-border)',
          }}>
            <StatCell value={money.format(table.min_spend)} label="Min Spend" />
            <StatCell value={money.format(spendPerPerson)} label="Per Person" />
            <StatCell
              value={spotsLeft}
              label="Spots Left"
              valueStyle={{ color: spotsLeft === 0 ? 'var(--sec-error)' : spotsLeft <= 2 ? 'var(--sec-warning)' : 'var(--sec-text-primary)' }}
            />
          </div>
        </div>

        {venueAddressLine && (
          <div className="sec-card" style={{ padding: '16px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <MapPin size={18} style={{ flexShrink: 0, marginTop: 2, color: 'var(--sec-accent)' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginBottom: 4 }}>Venue location</div>
                <div style={{ fontSize: 15, fontWeight: 500 }}>{venueAddressLine}</div>
                {(() => {
                  const dirs = getDirectionsActions({ address: venueAddressLine });
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                      <a
                        href={dirs.primary.href}
                        target="_blank"
                        rel="noreferrer"
                        className="sec-link"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14 }}
                      >
                        <Navigation size={16} />
                        {dirs.primary.label}
                      </a>
                      <a
                        href={dirs.secondary.href}
                        target="_blank"
                        rel="noreferrer"
                        className="sec-link"
                        style={{ fontSize: 13 }}
                      >
                        {dirs.secondary.label}
                      </a>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* ── Event row ── */}
        {event && (
          <Link
            to={createPageUrl(`EventDetails?id=${event.id}`)}
            className="sec-card"
            style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', textDecoration: 'none' }}
          >
            {/* Thumbnail */}
            <div style={{
              width: 56, height: 56, borderRadius: 'var(--radius-md)',
              backgroundColor: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)',
              overflow: 'hidden', flexShrink: 0,
            }}>
              {event.cover_image_url ? (
                <img src={getEventImage(event.cover_image_url)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Calendar size={20} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)' }} />
                </div>
              )}
            </div>

            {/* Info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {event.title}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--sec-text-muted)' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Calendar size={11} strokeWidth={1.5} />
                  {getDateLabel()}
                </span>
                {event.start_time && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Clock size={11} strokeWidth={1.5} />
                    {event.start_time}
                  </span>
                )}
              </div>
            </div>

            <ChevronRight size={16} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)', flexShrink: 0 }} />
          </Link>
        )}

        {/* ── Table Members ── */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Users size={15} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)' }} />
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--sec-text-primary)' }}>
              Table Members ({members.length})
            </h2>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {members.map((member, index) => {
              const memberData = table.members?.find(m => m.user_id === member.id);
              const isHostMember = member.id === table.host_user_id;
              const isPendingMember = memberData?.status === 'pending';
              const genderLabel =
                member.gender === 'male' ? 'Male' : member.gender === 'female' ? 'Female' : member.gender === 'other' ? 'Other' : null;

              return (
                <motion.div
                  key={member.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04 }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '12px 14px', borderRadius: 'var(--radius-lg)',
                    backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)',
                  }}
                >
                  {/* Avatar */}
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <div style={{
                      width: 40, height: 40, borderRadius: '50%',
                      backgroundColor: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)',
                      overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {member.avatar_url ? (
                        <img src={member.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--sec-text-secondary)' }}>
                          {(member.username || 'U')[0].toUpperCase()}
                        </span>
                      )}
                    </div>
                    {/* Host crown badge */}
                    {isHostMember && (
                      <div style={{
                        position: 'absolute', bottom: -2, right: -2,
                        width: 18, height: 18, borderRadius: '50%',
                        backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <Crown size={9} strokeWidth={2} style={{ color: 'var(--sec-accent)' }} />
                      </div>
                    )}
                  </div>

                  {/* Name + status */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 2 }}>
                      {member.username || 'User'}
                    </p>
                    <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>
                      {isHostMember ? 'Host' : isPendingMember ? 'Pending' : 'Confirmed'}
                    </p>
                    {genderLabel && (
                      <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 2 }}>
                        {genderLabel}
                      </p>
                    )}
                  </div>

                  {/* Host accept/reject controls */}
                  {isHost && isPendingMember && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => acceptRequestMutation.mutate(member.id)}
                        disabled={acceptRequestMutation.isPending}
                        style={{
                          width: 32, height: 32, borderRadius: '50%',
                          backgroundColor: 'var(--sec-success-muted)',
                          border: '1px solid rgba(61,186,107,0.2)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', color: 'var(--sec-success)',
                        }}
                      >
                        <Check size={14} strokeWidth={2.5} />
                      </button>
                      <button style={{
                        width: 32, height: 32, borderRadius: '50%',
                        backgroundColor: 'var(--sec-error-muted)',
                        border: '1px solid rgba(217,85,85,0.2)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', color: 'var(--sec-error)',
                      }}>
                        <X size={14} strokeWidth={2.5} />
                      </button>
                    </div>
                  )}

                  {member.is_verified_promoter && !isPendingMember && (
                    <BadgeCheck size={16} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />
                  )}
                </motion.div>
              );
            })}

            {members.length === 0 && (
              <div style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--sec-text-muted)', fontSize: 13 }}>
                No members yet
              </div>
            )}
          </div>
        </div>

        {/* ── Joining fee notice ── */}
        {table.joining_fee > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '14px 16px', borderRadius: 'var(--radius-lg)',
            backgroundColor: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)',
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 'var(--radius-md)', flexShrink: 0,
              backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <DollarSign size={16} strokeWidth={1.5} style={{ color: 'var(--sec-text-secondary)' }} />
            </div>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 2 }}>
                Joining Fee: R{table.joining_fee}
              </p>
              <p style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>Paid upfront to secure your spot</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Sticky bottom bar ── */}
      <div className="sec-bottom-bar sec-bottom-bar--responsive">
        <div style={{ display: 'flex', gap: 10, width: '100%', maxWidth: 960, margin: '0 auto' }}>
          {isHost ? (
            <>
              <button
                onClick={() => {
                  if (!identityOk) {
                    toast.error('Complete age verification in Profile to invite guests.');
                    return;
                  }
                  setShowInviteDialog(true);
                }}
                className="sec-btn sec-btn-secondary"
                style={{
                  width: 48,
                  height: 48,
                  padding: 0,
                  flexShrink: 0,
                  borderRadius: 'var(--radius-pill)',
                  opacity: identityOk ? 1 : 0.45,
                }}
                title={!identityOk ? 'Identity verification required' : 'Invite friends'}
              >
                <UserPlus size={18} strokeWidth={1.5} />
              </button>
              <Link
                to={createPageUrl(`ChatRoom?table=${tableId}`)}
                className="sec-btn sec-btn-secondary"
                style={{ flex: 1, height: 48, textDecoration: 'none' }}
              >
                <MessageCircle size={16} strokeWidth={1.5} />
                Chat
              </Link>
              <Link
                to={createPageUrl(`ManageTable?id=${tableId}`)}
                className="sec-btn sec-btn-primary"
                style={{ flex: 1, height: 48, textDecoration: 'none' }}
              >
                Manage
              </Link>
            </>
          ) : isMember ? (
            <Link
              to={createPageUrl(`ChatRoom?table=${tableId}`)}
              className="sec-btn sec-btn-primary sec-btn-full"
              style={{ height: 48, textDecoration: 'none' }}
            >
              <MessageCircle size={16} strokeWidth={1.5} />
              Open Chat
            </Link>
          ) : isPending ? (
            <button disabled className="sec-btn sec-btn-ghost sec-btn-full" style={{ height: 48, opacity: 0.55 }}>
              Request Pending…
            </button>
          ) : spotsLeft > 0 ? (
            <button
              onClick={() => {
                if (userProfile || user || authService.hasRefreshSession()) {
                  navigate(createPageUrl(`TableJoinOnboarding?id=${tableId}`));
                  return;
                }
                authService.redirectToLogin(window.location.href, { force: true });
              }}
              className="sec-btn sec-btn-primary sec-btn-full"
              style={{ height: 48, fontSize: 15 }}
            >
              <UserPlus size={16} strokeWidth={2} />
              Request to Join
            </button>
          ) : (
            <button disabled className="sec-btn sec-btn-ghost sec-btn-full" style={{ height: 48, opacity: 0.45 }}>
              Table Full
            </button>
          )}
        </div>
      </div>

      {/* ── Join dialog ── */}
      <Dialog open={showJoinDialog} onOpenChange={setShowJoinDialog}>
        <DialogContent style={dialogContentStyle}>
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--sec-text-primary)', fontSize: 17, fontWeight: 600 }}>
              Request to Join
            </DialogTitle>
            <DialogDescription style={{ color: 'var(--sec-text-muted)', fontSize: 13 }}>
              {table.joining_fee > 0 ? 'Payment required to join this table' : 'Send a message to the host with your request'}
            </DialogDescription>
          </DialogHeader>

          <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {table.joining_fee === 0 && (
              <Textarea
                placeholder="Hi! I'd love to join your table…"
                value={joinMessage}
                onChange={(e) => setJoinMessage(e.target.value)}
                style={{
                  backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)',
                  borderRadius: 'var(--radius-md)', color: 'var(--sec-text-primary)',
                  fontSize: 14, padding: '12px 14px', minHeight: 100, resize: 'none',
                }}
              />
            )}
            {table.joining_fee > 0 && (
              <div className="sec-card" style={{ padding: '16px' }}>
                <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 8 }}>
                  Joining Fee
                </p>
                <p style={{ fontSize: 26, fontWeight: 700, color: 'var(--sec-text-primary)', letterSpacing: '-0.02em', marginBottom: 6 }}>
                  R{table.joining_fee.toLocaleString()}
                </p>
                <p style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>
                  Secure your spot at this table. Payment confirms your attendance.
                </p>
                <div style={{ marginTop: 10 }}>
                  <RefundPolicyNote />
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setShowJoinDialog(false)} className="sec-btn sec-btn-ghost" style={{ flex: 1, height: 44 }}>
              Cancel
            </button>
            <button
              onClick={handleJoinTable}
              disabled={joinMutation.isPending || isProcessingPayment}
              className="sec-btn sec-btn-primary"
              style={{ flex: 1, height: 44 }}
            >
              {table.joining_fee > 0
                ? isProcessingPayment ? 'Processing…' : <><CreditCard size={14} strokeWidth={1.5} /> Pay &amp; Join</>
                : joinMutation.isPending ? 'Sending…' : 'Send Request'
              }
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Payment dialog ── */}
      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent style={dialogContentStyle}>
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--sec-text-primary)', fontSize: 17, fontWeight: 600 }}>
              Complete Payment
            </DialogTitle>
            <DialogDescription style={{ color: 'var(--sec-text-muted)', fontSize: 13 }}>
              Secure checkout powered by Paystack
            </DialogDescription>
          </DialogHeader>

          <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="sec-card" style={{ padding: '14px 16px' }}>
              <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginBottom: 4 }}>You&apos;re joining</p>
              <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--sec-text-primary)', marginBottom: 2 }}>{table.name}</p>
              {event && <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>at {event.title}</p>}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderRadius: 'var(--radius-lg)', backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)' }}>
              <span style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>Joining Fee</span>
              <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--sec-text-primary)' }}>
                R{table.joining_fee.toLocaleString()}
              </span>
            </div>

            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', textAlign: 'center' }}>
              A secure Paystack window opens on this page — you are not sent to another site.
            </p>
            <RefundPolicyNote className="text-center" />
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setShowPaymentDialog(false)} disabled={isProcessingPayment} className="sec-btn sec-btn-ghost" style={{ flex: 1, height: 44 }}>
              Cancel
            </button>
            <button onClick={handlePayment} disabled={isProcessingPayment} className="sec-btn sec-btn-primary" style={{ flex: 1, height: 44 }}>
              {isProcessingPayment ? 'Processing…' : <><CreditCard size={14} strokeWidth={1.5} /> Proceed to Payment</>}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Share dialog ── */}
      <Dialog open={showShareDialog} onOpenChange={setShowShareDialog}>
        <DialogContent style={dialogContentStyle}>
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--sec-text-primary)', fontSize: 17, fontWeight: 600 }}>
              Share Table
            </DialogTitle>
            <DialogDescription style={{ color: 'var(--sec-text-muted)', fontSize: 13 }}>
              Invite friends to join your table
            </DialogDescription>
          </DialogHeader>

          <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 14px', borderRadius: 'var(--radius-md)',
              backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)',
            }}>
              <LinkIcon size={14} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)', flexShrink: 0 }} />
              <input
                type="text"
                value={`${window.location.origin}${createPageUrl('TableDetails')}?id=${tableId}`}
                readOnly
                style={{
                  flex: 1, background: 'transparent', outline: 'none', border: 'none',
                  fontSize: 13, color: 'var(--sec-text-secondary)', minWidth: 0,
                }}
              />
              <button
                onClick={copyLink}
                className="sec-btn sec-btn-secondary"
                style={{ height: 32, padding: '0 12px', fontSize: 12, flexShrink: 0 }}
              >
                {copiedLink ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={1.5} />}
              </button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', textAlign: 'center' }}>
              {copiedLink ? 'Link copied to clipboard' : 'Share this link with friends'}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Invite friends dialog ── */}
      <InviteFriendsDialog
        open={showInviteDialog}
        onOpenChange={setShowInviteDialog}
        table={table}
        event={event}
      />
    </div>
  );
}
