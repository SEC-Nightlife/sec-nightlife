import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createPageUrl, getStoredPromoterRef } from '@/utils';
import { apiPost } from '@/api/client';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft, MapPin, Navigation, Crown, Users, UserPlus, Check, LogOut, QrCode,
} from 'lucide-react';
import { toast } from 'sonner';
import { launchPaystackInline } from '@/lib/paystackInline';
import { completePaystackCheckout } from '@/lib/completePaystackCheckout';
import MenuPicker, { menuSelectionToPayload, menuSelectionTotal } from '@/components/menu/MenuPicker';
import { SERVICE_FEE_ZAR, totalWithServiceFee } from '@/lib/serviceFee';
import InviteFriendsDialog from '@/components/tables/InviteFriendsDialog';
import HostedTableJoinWizard from '@/components/tables/HostedTableJoinWizard';
import SeatingPlanViewer from '@/components/seating/SeatingPlanViewer';
import { normalizeGuestSeatingPlans } from '@/lib/seatingPlanUtils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { MOBILE_NAV_BOTTOM_OFFSET, mobileFooterPadding } from '@/lib/layoutConstants';
import { getDirectionsActions } from '@/lib/openDirections';

function profileHref(userId) {
  if (!userId) return null;
  return `${createPageUrl('UserProfile')}?id=${encodeURIComponent(userId)}`;
}

function MemberAvatar({ user, size = 44 }) {
  const label = user?.full_name || user?.username || '?';
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        overflow: 'hidden',
        flexShrink: 0,
        background: 'var(--sec-accent-muted)',
        border: '1px solid var(--sec-accent-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: size * 0.38,
        color: 'var(--sec-accent)',
      }}
    >
      {user?.avatar_url ? (
        <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        label[0]?.toUpperCase()
      )}
    </div>
  );
}

function MenuLinesBlock({ lines, minSpendZar, label }) {
  if (lines?.length) {
    return (
      <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>
        {lines.map((line, i) => (
          <li key={i} style={{ fontSize: 13, color: 'var(--sec-text-secondary)', marginBottom: 4 }}>
            {line.quantity}× {line.name}
            <span style={{ color: 'var(--sec-text-muted)', marginLeft: 6 }}>
              @ R{Number(line.unitPrice || 0).toFixed(0)}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (minSpendZar > 0) {
    return (
      <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 6 }}>
        Minimum spend R{Number(minSpendZar).toFixed(0)} — no menu items yet
      </p>
    );
  }
  return <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 6 }}>No menu items yet</p>;
}

export default function HostedTableExperience({
  tableId,
  hostedTable,
  user,
  userProfile,
  onBack,
  autoOpenJoin = false,
  autoOpenCheckout = false,
  seatingPlan = null,
  seatingPlans = null,
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [joinWizardOpen, setJoinWizardOpen] = useState(false);
  const [joinPaid, setJoinPaid] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [hostedMenuSelected, setHostedMenuSelected] = useState({});
  const [seatingViewerOpen, setSeatingViewerOpen] = useState(false);

  const resolvedSeatingPlans =
    Array.isArray(seatingPlans) && seatingPlans.length > 0
      ? seatingPlans
      : normalizeGuestSeatingPlans(seatingPlan);
  const resolvedSeatingPlan = resolvedSeatingPlans[0] ?? null;

  const checkout = hostedTable.checkout || {};
  const entranceZ = Number(checkout.entrance_zar ?? 0);
  const joinZ = Number(checkout.joining_fee_zar ?? 0);
  const totalOnline = Number(checkout.total_pay_online_zar ?? entranceZ + joinZ);
  const stats = hostedTable.stats || {};
  const membershipReview = hostedTable.my_membership?.reviewStatus;
  const isPendingApproval = membershipReview === 'pending';
  const isAwaitingPayment = membershipReview === 'awaiting_payment';
  const isPendingMember = isPendingApproval || isAwaitingPayment;
  const requiresApproval = hostedTable.is_public === false || hostedTable.isPublic === false;
  const spotsRemaining = Number(
    hostedTable.spots_remaining ??
      stats.spots_remaining ??
      hostedTable.spotsRemaining ??
      0,
  );
  const tableStatus = hostedTable.status || 'ACTIVE';
  const isGoingMember = hostedTable.my_membership?.status === 'GOING';
  const hasCompletedJoinPayment = isGoingMember || joinPaid;
  const isHost = hostedTable.is_host;
  const tableJoinable =
    tableStatus === 'ACTIVE' && spotsRemaining > 0 && !isPendingMember;
  const venueMenu = hostedTable.venue_menu || [];
  const hostedMenuSubtotal = menuSelectionTotal(venueMenu, hostedMenuSelected);
  const goingMembers = (hostedTable.members || []).filter((m) => m.status === 'GOING');
  const isCommunityEvent =
    Boolean(hostedTable.is_community_event) ||
    (hostedTable.tableType === 'EXTERNAL_VENUE' &&
      hostedTable.listingSurface === 'EVENT' &&
      !hostedTable.eventId);
  // Own-place / non-SEC venue listings have no venue menu — hide Table orders.
  const isExternalOwnPlaceListing =
    (hostedTable.tableType === 'EXTERNAL_VENUE' || hostedTable.table_type === 'EXTERNAL_VENUE') &&
    !hostedTable.venueTableId &&
    !hostedTable.venue_table_id &&
    !hostedTable.eventId &&
    !hostedTable.event_id;
  const goingCount = Number(stats.member_count ?? goingMembers.length) || 0;
  const joiningFeeZar =
    hostedTable.hasJoiningFee && Number(hostedTable.joiningFee || joinZ || 0) > 0
      ? Number(hostedTable.joiningFee || joinZ)
      : 0;
  const mapQuery = hostedTable.resolvedAddress || hostedTable.venueAddress || hostedTable.venueName || '';

  const completeJoinPayment = async (menuPayload = []) => {
    const actorId = userProfile?.id || user?.id;
    if (!actorId) {
      authServiceRedirect();
      return;
    }
    try {
      setIsProcessingPayment(true);
      const r = await apiPost(`/api/host/tables/${tableId}/join/checkout`, {
        ...(menuPayload.length ? { selectedMenuItems: menuPayload } : {}),
      });
      if (r?.pendingPayment && r?.reference && r?.access_code) {
        const amount = Number(r.amount_zar ?? r.amount ?? totalOnline ?? 0);
        launchPaystackInline({
          email: user?.email,
          amount,
          reference: r.reference,
          accessCode: r.access_code,
          authorizationUrl: r.authorization_url,
          onSuccess: async (payload) => {
            const result = await completePaystackCheckout({ reference: r.reference, payload, queryClient });
            invalidateTableQueries();
            setJoinWizardOpen(false);
            if (result?.fulfilled) {
              setJoinPaid(true);
              toast.success('Payment complete — you joined the table. View your QR in Profile → Tickets.');
            }
          },
        });
        return;
      }
      toast.error('Could not start payment');
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Could not start payment');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  useEffect(() => {
    if (!autoOpenJoin || isHost || isGoingMember || isAwaitingPayment) return;
    setJoinWizardOpen(true);
  }, [autoOpenJoin, isHost, isGoingMember, isAwaitingPayment]);

  useEffect(() => {
    if (!autoOpenCheckout || isHost || isGoingMember || !isAwaitingPayment) return;
    setJoinWizardOpen(true);
  }, [autoOpenCheckout, isHost, isGoingMember, isAwaitingPayment]);

  const invalidateTableQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['hosted-table-detail', tableId] });
    queryClient.invalidateQueries({ queryKey: ['host-tables'] });
    queryClient.invalidateQueries({ queryKey: ['home-table-offerings'] });
    queryClient.invalidateQueries({ queryKey: ['biz-event-table-bookings'] });
    queryClient.invalidateQueries({ queryKey: ['my-tickets'] });
    if (userProfile?.id) {
      queryClient.invalidateQueries({ queryKey: ['table-history', userProfile.id] });
    }
  };

  const executeJoin = async (menuPayload = []) => {
    const actorId = userProfile?.id || user?.id;
    if (!actorId) {
      authServiceRedirect();
      return;
    }
    try {
      setIsProcessingPayment(true);
      const promoterRef = getStoredPromoterRef(hostedTable?.event?.id);
      const body = {
        ...(promoterRef ? { promoter_user_id: promoterRef } : {}),
        ...(menuPayload.length ? { selectedMenuItems: menuPayload } : {}),
      };
      const r = await apiPost(`/api/host/tables/${tableId}/join`, body);
      invalidateTableQueries();
      if (r?.pending) {
        toast.success('Request sent. The host will approve your join.');
        setJoinWizardOpen(false);
        return;
      }
      if (r?.pendingPayment && r?.reference && r?.access_code) {
        const amount = Number(r.amount_zar ?? r.amount ?? totalOnline ?? 0);
        launchPaystackInline({
          email: user?.email,
          amount,
          reference: r.reference,
          accessCode: r.access_code,
          authorizationUrl: r.authorization_url,
          onSuccess: async (payload) => {
            const result = await completePaystackCheckout({ reference: r.reference, payload, queryClient });
            invalidateTableQueries();
            setJoinWizardOpen(false);
            if (result?.fulfilled) setJoinPaid(true);
          },
        });
        return;
      }
      toast.success('You joined the table.');
      setJoinWizardOpen(false);
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Could not join table');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const authServiceRedirect = () => {
    import('@/services/authService').then((m) => {
      if (m.hasRefreshSession()) {
        toast.error('Still signing you in — try again in a moment.');
        return;
      }
      m.redirectToLogin(window.location.href, { force: true });
    });
  };

  const payHostedMenu = async () => {
    const payload = menuSelectionToPayload(venueMenu, hostedMenuSelected);
    if (!payload.length) {
      toast.error('Select at least one item');
      return;
    }
    try {
      setIsProcessingPayment(true);
      const r = await apiPost(`/api/host/tables/${tableId}/menu-order`, {
        selectedMenuItems: payload.map((p) => ({ menuItemId: p.menuItemId, quantity: p.quantity })),
      });
      if (r?.pendingPayment && r?.reference && r?.access_code) {
        launchPaystackInline({
          email: user?.email,
          amount: Number(r.amount_zar ?? 0),
          reference: r.reference,
          accessCode: r.access_code,
          authorizationUrl: r.authorization_url,
          onSuccess: async (payloadRef) => {
            await completePaystackCheckout({ reference: r.reference, payload: payloadRef, queryClient, showToasts: false });
            invalidateTableQueries();
            setHostedMenuSelected({});
            toast.success('Menu order paid — added to your table.');
          },
        });
      }
    } catch (e) {
      toast.error(e?.data?.error || e.message || 'Menu order failed');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleLeaveTable = async () => {
    setIsLeaving(true);
    try {
      await apiPost(`/api/host/tables/${tableId}/leave`);
      invalidateTableQueries();
      toast.success('You left the table.');
      setLeaveConfirmOpen(false);
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Could not leave table');
    } finally {
      setIsLeaving(false);
    }
  };

  const openPaymentWizard = () => {
    if (!user?.id && !userProfile?.id) {
      authServiceRedirect();
      return;
    }
    setJoinWizardOpen(true);
  };
  const openJoinWizard = openPaymentWizard;

  const cardStyle = {
    padding: 16,
    borderRadius: 16,
    background: 'var(--sec-bg-card)',
    border: '1px solid var(--sec-border)',
    marginTop: 14,
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--sec-bg-base)', paddingBottom: mobileFooterPadding(180) }}>
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          background: 'rgba(0,0,0,0.94)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid var(--sec-border)',
          padding: '0 16px',
          height: 56,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <button type="button" onClick={onBack || (() => navigate(-1))} className="sec-btn sec-btn-ghost" style={{ padding: 8 }}>
          <ChevronLeft size={20} />
        </button>
      </header>

      {hostedTable.photo ? (
        <div style={{ position: 'relative', height: 220, overflow: 'hidden' }}>
          <img src={hostedTable.photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 40%, var(--sec-bg-base) 100%)' }} />
        </div>
      ) : null}

      <div style={{ padding: '0 20px 20px', marginTop: hostedTable.photo ? -48 : 16 }}>
        {hostedTable.event?.title && (
          <span
            style={{
              display: 'inline-block',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--sec-accent)',
              background: 'var(--sec-accent-muted)',
              border: '1px solid var(--sec-accent-border)',
              borderRadius: 999,
              padding: '4px 10px',
              marginBottom: 10,
            }}
          >
            {hostedTable.event.title}
          </span>
        )}
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--sec-text-primary)' }}>
          {hostedTable.tableName}
        </h1>
        {resolvedSeatingPlan ? (
          <button
            type="button"
            onClick={() => setSeatingViewerOpen(true)}
            className="sec-link mt-2 text-sm inline-flex items-center gap-1"
            style={{ color: 'var(--sec-accent)' }}
          >
            <MapPin size={14} />
            View seating plan{resolvedSeatingPlans.length > 1 ? ` (${resolvedSeatingPlans.length} floors)` : ''}
          </button>
        ) : null}
        {hostedTable.venueSlotName &&
        hostedTable.venueSlotName !== hostedTable.tableName ? (
          <p style={{ fontSize: 13, color: 'var(--sec-accent)', marginTop: 8, lineHeight: 1.5 }}>
            Venue table: {hostedTable.venueSlotName}
            <span style={{ display: 'block', fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 4 }}>
              Show this to venue staff for seating
            </span>
          </p>
        ) : null}
        {hostedTable.tableDescription && (
          <p style={{ fontSize: 14, color: 'var(--sec-text-muted)', marginTop: 8, lineHeight: 1.5 }}>
            {hostedTable.tableDescription}
          </p>
        )}

        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            marginTop: 16,
            padding: '12px 14px',
            borderRadius: 14,
            background: 'var(--sec-accent-muted)',
            border: '1px solid var(--sec-accent-border)',
          }}
        >
          <StatPill icon={<Users size={14} />} label={`${spotsRemaining} spots left`} />
          <StatPill
            icon={<Users size={14} />}
            label={isCommunityEvent ? `${goingCount} going` : `${goingCount} members`}
          />
          {!isCommunityEvent && (stats.pending_invite_count ?? 0) > 0 && (
            <StatPill label={`${stats.pending_invite_count} pending`} muted />
          )}
        </div>

        {hostedTable.host && (
          <div style={cardStyle}>
            <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 10 }}>
              Host
            </p>
            <Link
              to={profileHref(hostedTable.host.id) || '#'}
              onClick={(e) => { if (!hostedTable.host.id) e.preventDefault(); }}
              style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: 'inherit' }}
            >
              <MemberAvatar user={hostedTable.host} size={48} />
              <div>
                <p style={{ fontWeight: 600, fontSize: 15 }}>
                  {hostedTable.host.full_name || hostedTable.host.username}
                  <Crown size={14} style={{ display: 'inline', marginLeft: 6, color: 'var(--sec-accent)' }} />
                </p>
                {hostedTable.host.username && (
                  <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>@{hostedTable.host.username}</p>
                )}
              </div>
            </Link>
          </div>
        )}

        {isCommunityEvent && joiningFeeZar > 0 ? (
          <div
            style={{
              ...cardStyle,
              background:
                'linear-gradient(135deg, rgba(192,192,192,0.12) 0%, rgba(255,255,255,0.04) 55%, rgba(192,192,192,0.08) 100%)',
              border: '1px solid var(--sec-accent-border)',
            }}
          >
            <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 8 }}>
              Joining fee
            </p>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.03em', color: 'var(--sec-text-primary)' }}>
                R{joiningFeeZar.toFixed(0)}
              </span>
              <span style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>per guest</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--sec-text-secondary)', marginTop: 8, lineHeight: 1.45 }}>
              Pay to join this event. Spots update as guests join or leave.
            </p>
          </div>
        ) : null}

        {!isCommunityEvent ? (
          <>
            <div style={cardStyle}>
              <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 10 }}>
                Guests at this table
              </p>
              {goingMembers.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>No guests yet</p>
              ) : (
                goingMembers.map((m) => (
                  <Link
                    key={m.userId}
                    to={profileHref(m.user?.id || m.userId) || '#'}
                    onClick={(e) => { if (!m.user?.id && !m.userId) e.preventDefault(); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '8px 0',
                      textDecoration: 'none',
                      color: 'inherit',
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                    }}
                  >
                    <MemberAvatar user={m.user} />
                    <div style={{ flex: 1 }}>
                      <p style={{ fontWeight: 500, fontSize: 14 }}>{m.user?.full_name || m.user?.username || 'Guest'}</p>
                      {m.user?.username && (
                        <p style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>@{m.user.username}</p>
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        padding: '3px 8px',
                        borderRadius: 999,
                        background: m.role === 'HOST' ? 'var(--sec-accent-muted)' : 'rgba(255,255,255,0.06)',
                        color: m.role === 'HOST' ? 'var(--sec-accent)' : 'var(--sec-text-muted)',
                      }}
                    >
                      {m.role === 'HOST' ? 'Host' : 'Guest'}
                    </span>
                  </Link>
                ))
              )}
            </div>

            {!isExternalOwnPlaceListing ? (
              <div style={cardStyle}>
                <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 12 }}>
                  Table orders
                </p>
                {hostedTable.host_orders && (
                  <div style={{ marginBottom: 14 }}>
                    <p style={{ fontWeight: 600, fontSize: 14, color: 'var(--sec-accent)' }}>Host</p>
                    <MenuLinesBlock
                      lines={hostedTable.host_orders.menuLines}
                      minSpendZar={hostedTable.host_orders.minSpendZar}
                    />
                  </div>
                )}
                {goingMembers
                  .filter((m) => m.role !== 'HOST')
                  .map((m) => (
                    <div key={m.userId} style={{ marginBottom: 12 }}>
                      <p style={{ fontWeight: 600, fontSize: 14 }}>{m.user?.full_name || m.user?.username || 'Guest'}</p>
                      <MenuLinesBlock lines={m.menuLines} />
                    </div>
                  ))}
              </div>
            ) : null}
          </>
        ) : null}

        <div style={{ ...cardStyle, opacity: 0.85 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <MapPin size={16} style={{ flexShrink: 0, marginTop: 2, color: 'var(--sec-accent)' }} />
            <div>
              <p style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>Location</p>
              <p style={{ fontSize: 14, fontWeight: 500 }}>{hostedTable.resolvedAddress}</p>
              {mapQuery && (() => {
                const dirs = getDirectionsActions({ address: mapQuery });
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                    <a
                      href={dirs.primary.href}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--sec-accent)' }}
                    >
                      <Navigation size={14} />
                      {dirs.primary.label}
                    </a>
                    <a
                      href={dirs.secondary.href}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 12, color: 'var(--sec-accent)' }}
                    >
                      {dirs.secondary.label}
                    </a>
                  </div>
                );
              })()}
            </div>
          </div>
          {!isCommunityEvent && (hostedTable.hosting_tier_name || hostedTable.hosting_category) && (
            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 12 }}>
              {[hostedTable.hosting_category, hostedTable.hosting_tier_name].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      </div>

      {isGoingMember && !isHost && venueMenu.length > 0 && (
        <div style={{ padding: '0 20px 20px' }}>
          <div style={cardStyle}>
            <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Add menu items</p>
            <MenuPicker
              items={venueMenu}
              selected={hostedMenuSelected}
              onChange={(id, qty) => setHostedMenuSelected((s) => ({ ...s, [id]: qty }))}
            />
            <Button
              className="w-full mt-3 bg-[var(--sec-accent)] text-black"
              disabled={isProcessingPayment}
              onClick={payHostedMenu}
            >
              {hostedMenuSubtotal > 0
                ? `Pay R${totalWithServiceFee(hostedMenuSubtotal).toFixed(2)} (incl. R${SERVICE_FEE_ZAR} service fee)`
                : 'Pay for selected items'}
            </Button>
          </div>
        </div>
      )}

      <footer
        className="sec-bottom-bar"
        style={{
          position: 'fixed',
          bottom: MOBILE_NAV_BOTTOM_OFFSET,
          left: 0,
          right: 0,
          zIndex: 51,
          padding: '12px 20px 24px',
          background: 'linear-gradient(180deg, transparent, var(--sec-bg-base) 30%)',
          borderTop: '1px solid var(--sec-border)',
        }}
      >
          {isHost ? (
            <div style={{ display: 'flex', gap: 10 }}>
              <Button
                variant="outline"
                className="flex-1 border-[var(--sec-accent-border)]"
                onClick={() => setShowInvite(true)}
              >
                <UserPlus size={16} className="mr-2" />
                Invite
              </Button>
              <Button
                className="flex-1 bg-[var(--sec-accent)] text-black hover:opacity-90"
                onClick={() => navigate(createPageUrl('HostDashboard?tab=tables&manage=1'))}
              >
                Host Dashboard
              </Button>
            </div>
          ) : hasCompletedJoinPayment ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <Button
                  variant="outline"
                  className="flex-1 border-[var(--sec-success)] text-[var(--sec-success)]"
                  disabled
                  style={{ opacity: 1 }}
                >
                  <Check size={16} className="mr-2" />
                  Paid
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 border-[var(--sec-accent-border)]"
                  onClick={() => setShowInvite(true)}
                >
                  <UserPlus size={16} className="mr-2" />
                  Invite
                </Button>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => navigate(createPageUrl('Profile?tab=tickets'))}
                >
                  <QrCode size={16} className="mr-2" />
                  View QR
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 border-red-500/40 text-red-400"
                  onClick={() => setLeaveConfirmOpen(true)}
                >
                  <LogOut size={16} className="mr-2" />
                  Leave table
                </Button>
              </div>
            </div>
          ) : isAwaitingPayment ? (
            <Button
              className="w-full h-12 sec-btn-accent font-semibold"
              disabled={isProcessingPayment}
              onClick={openPaymentWizard}
            >
              {isProcessingPayment
                ? 'Processing…'
                : totalOnline > 0
                  ? `Complete payment · R${totalWithServiceFee(totalOnline).toFixed(2)}`
                  : 'Complete payment'}
            </Button>
          ) : isPendingApproval ? (
            <Button className="w-full h-12 font-semibold" variant="outline" disabled>
              Request pending — awaiting host approval
            </Button>
          ) : !tableJoinable ? (
            <Button className="w-full h-12 font-semibold" variant="outline" disabled>
              {tableStatus !== 'ACTIVE' ? 'Table not available' : 'Table is full'}
            </Button>
          ) : (
            <Button
              className="w-full h-12 sec-btn-accent font-semibold"
              disabled={isProcessingPayment}
              onClick={openJoinWizard}
            >
              {requiresApproval
                ? 'Request to join'
                : totalOnline > 0
                  ? `Join · R${totalWithServiceFee(totalOnline).toFixed(2)}`
                  : 'Join table'}
            </Button>
          )}
      </footer>

      <HostedTableJoinWizard
        open={joinWizardOpen}
        onOpenChange={setJoinWizardOpen}
        tableName={hostedTable.tableName || 'this table'}
        venueMenu={isAwaitingPayment || !requiresApproval ? venueMenu : []}
        entranceZar={entranceZ}
        joinZar={joinZ}
        totalOnline={totalOnline}
        isProcessing={isProcessingPayment}
        requiresApproval={requiresApproval && !isAwaitingPayment}
        awaitingPayment={isAwaitingPayment}
        onConfirm={(menuPayload) =>
          isAwaitingPayment ? completeJoinPayment(menuPayload) : executeJoin(menuPayload)
        }
      />

      <Dialog open={leaveConfirmOpen} onOpenChange={setLeaveConfirmOpen}>
        <DialogContent className="bg-[var(--sec-bg-card)] border border-[var(--sec-border)] max-w-sm">
          <DialogHeader>
            <DialogTitle>Leave table?</DialogTitle>
            <DialogDescription>
              Your spot will be released. Payments are not refunded.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setLeaveConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              className="flex-1 bg-red-600 hover:bg-red-700 text-white"
              disabled={isLeaving}
              onClick={handleLeaveTable}
            >
              {isLeaving ? 'Leaving…' : 'Leave table'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <InviteFriendsDialog
        open={showInvite}
        onOpenChange={setShowInvite}
        table={{
          id: tableId,
          name: hostedTable.tableName,
          members: (hostedTable.members || []).map((m) => ({ user_id: m.userId, userId: m.userId })),
        }}
        maxInvites={hostedTable.invite_slots_remaining ?? hostedTable.stats?.invite_slots_remaining}
        source="hosted"
      />
      <SeatingPlanViewer
        open={seatingViewerOpen}
        onClose={() => setSeatingViewerOpen(false)}
        plans={resolvedSeatingPlans}
      />
    </div>
  );
}

function StatPill({ icon, label, muted }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        fontWeight: 600,
        padding: '6px 10px',
        borderRadius: 999,
        background: muted ? 'rgba(255,255,255,0.04)' : 'var(--sec-accent-muted)',
        color: muted ? 'var(--sec-text-muted)' : 'var(--sec-accent)',
      }}
    >
      {icon}
      {label}
    </span>
  );
}
