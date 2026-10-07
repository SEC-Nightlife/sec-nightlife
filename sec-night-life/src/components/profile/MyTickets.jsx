import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { apiGet, apiDelete } from '@/api/client';
import { Card, CardContent } from "@/components/ui/card";
import { Ticket, Calendar, Trash2, RotateCcw, ShoppingBag } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { Button } from "@/components/ui/button";
import { Link } from 'react-router-dom';
import { createPageUrl, resolveTicketVerifyUrl } from '@/utils';
import { ticketDetailHrefFromTicket } from '@/lib/ticketDetailHref';
import TicketQrBlock from '@/components/tickets/TicketQrBlock';
import OrderMoreDialog from '@/components/orders/OrderMoreDialog';
import { toast } from 'sonner';
import {
  isLikelyOffline,
  loadMyTicketsSnapshot,
  saveMyTicketsSnapshot,
} from '@/lib/ticketOfflineCache';
import RefundRequestDialog from '@/components/refunds/RefundRequestDialog';
import { normalizePaymentRef, paymentRefMatchesEligible } from '@/lib/paymentRef';

const ORDER_MORE_KINDS = new Set([
  'EVENT_TICKET',
  'EVENT_ENTRANCE',
  'VENUE_TABLE_JOIN',
  'HOSTED_TABLE_JOIN',
  'TABLE_HOST_FEE',
]);

function ticketDetailHref(ticket) {
  return ticketDetailHrefFromTicket(ticket);
}

export default function MyTickets({ userId }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('active');
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundRef, setRefundRef] = useState(null);
  const [refundLabel, setRefundLabel] = useState('');
  const [orderMoreTicketId, setOrderMoreTicketId] = useState(null);
  const ticketsCache = useMemo(() => (userId ? loadMyTicketsSnapshot(userId) : null), [userId]);

  const activeQ = useQuery({
    queryKey: ['my-tickets', userId, 'active'],
    queryFn: () => apiGet('/api/tickets/my?bucket=active'),
    enabled: !!userId,
  });

  const inactiveQ = useQuery({
    queryKey: ['my-tickets', userId, 'inactive'],
    queryFn: () => apiGet('/api/tickets/my?bucket=inactive'),
    enabled: !!userId,
  });

  const { data: eligibleRefunds } = useQuery({
    queryKey: ['refund-eligible-payments'],
    queryFn: () => apiGet('/api/refunds/eligible-payments'),
    enabled: !!userId,
  });

  const eligibleRefundItems = eligibleRefunds?.items || [];
  const eligibleRefundCount = eligibleRefundItems.length;

  const isTicketRefundable = (ticketRef) =>
    eligibleRefundItems.some((item) => paymentRefMatchesEligible(ticketRef, item.reference));

  const isHostOrTableTicket = (ticket) => {
    const title = String(ticket.title || '');
    const kind = String(ticket.kind || ticket.ticket_kind || '');
    return title.includes('Host pass') || kind === 'VENUE_TABLE_JOIN';
  };

  const ticketCanRequestRefund = (ticket) => {
    if (ticket.refund_status || ticket.refunded_at) return false;
    const ref = normalizePaymentRef(ticket.paystack_reference);
    if (!ref || ref.startsWith('free_')) return false;
    return isTicketRefundable(ref) || isHostOrTableTicket(ticket);
  };

  useEffect(() => {
    if (!userId) return;
    const prev = loadMyTicketsSnapshot(userId) || { active: [], inactive: [], expired: [] };
    const next = {
      active: activeQ.isSuccess ? (activeQ.data ?? []) : prev.active,
      inactive: inactiveQ.isSuccess ? (inactiveQ.data ?? []) : (prev.inactive ?? prev.expired),
      expired: inactiveQ.isSuccess ? (inactiveQ.data ?? []) : (prev.expired ?? prev.inactive),
    };
    if (activeQ.isSuccess || inactiveQ.isSuccess) {
      saveMyTicketsSnapshot(userId, next);
    }
  }, [userId, activeQ.isSuccess, activeQ.data, inactiveQ.isSuccess, inactiveQ.data]);

  const deleteMutation = useMutation({
    mutationFn: (id) => apiDelete(`/api/tickets/my/${encodeURIComponent(id)}`),
    onSuccess: () => {
      toast.success('Removed from history');
      queryClient.invalidateQueries({ queryKey: ['my-tickets', userId] });
      queryClient.invalidateQueries({ queryKey: ['table-history', userId] });
      queryClient.invalidateQueries({ queryKey: ['profile-social'] });
    },
    onError: (e) => toast.error(e?.message || 'Could not delete'),
  });

  const offline = isLikelyOffline();
  const activeTickets =
    activeQ.data !== undefined
      ? activeQ.data
      : offline && ticketsCache?.active?.length
        ? ticketsCache.active
        : activeQ.isError && ticketsCache?.active?.length
          ? ticketsCache.active
          : [];
  const inactiveTickets =
    inactiveQ.data !== undefined
      ? inactiveQ.data
      : offline && (ticketsCache?.inactive?.length || ticketsCache?.expired?.length)
        ? (ticketsCache.inactive ?? ticketsCache.expired)
        : inactiveQ.isError && (ticketsCache?.inactive?.length || ticketsCache?.expired?.length)
          ? (ticketsCache.inactive ?? ticketsCache.expired)
          : [];

  const activeFromCache =
    activeQ.data === undefined && ticketsCache?.active?.length && (offline || activeQ.isError);
  const inactiveFromCache =
    inactiveQ.data === undefined &&
    (ticketsCache?.inactive?.length || ticketsCache?.expired?.length) &&
    (offline || inactiveQ.isError);

  const activeLoading =
    activeQ.isLoading && !(offline && ticketsCache?.active?.length) && activeTickets.length === 0;
  const inactiveLoading =
    inactiveQ.isLoading &&
    !(offline && (ticketsCache?.inactive?.length || ticketsCache?.expired?.length)) &&
    inactiveTickets.length === 0;

  function ticketPhase(ticket) {
    const now = Date.now();
    const exp = ticket.expires_at || ticket.visible_until;
    const start = ticket.event_starts_at;
    if (start && Date.parse(start) > now) return 'upcoming';
    if (exp && Date.parse(exp) <= now) return 'expired';
    return 'inactive';
  }

  const TicketCard = ({ ticket }) => {
    const expiresRaw = ticket.expires_at || ticket.visible_until;
    const expiresLabel = expiresRaw
      ? format(parseISO(expiresRaw), 'MMM dd, yyyy HH:mm')
      : '—';
    const isInactiveTab = tab === 'inactive';
    const isRefunded = Boolean(ticket.refund_status || ticket.refunded_at);
    const phase = isRefunded ? 'refunded' : ticketPhase(ticket);
    const verifyUrl = resolveTicketVerifyUrl(ticket);
    const doorTimeLabel = ticket.event_starts_at
      ? format(parseISO(ticket.event_starts_at), 'EEE MMM d · HH:mm')
      : null;
    const isAddon = ticket.kind === 'MENU_ADDON';
    const canOrderMore =
      !isAddon && !isRefunded && !isInactiveTab && ORDER_MORE_KINDS.has(String(ticket.kind || ''));

    return (
      <Card className="glass-card border-[#262629] hover:border-[var(--sec-accent)]/30 transition-all">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1 min-w-0 space-y-2 order-2 sm:order-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-white leading-snug break-words">{ticket.title}</h3>
                  {isRefunded && (
                    <span className="sec-badge sec-badge-muted text-[10px] mt-1 inline-block">Refunded</span>
                  )}
                  {isAddon && (
                    <span className="sec-badge sec-badge-gold text-[10px] mt-1 inline-block">
                      Add-on order · not an entry pass
                    </span>
                  )}
                  {ticket.holder_display_name && (
                    <p className="text-xs text-gray-500 mt-0.5 truncate">{ticket.holder_display_name}</p>
                  )}
                </div>
                <img
                  src="/sec-logo.png"
                  alt=""
                  className="h-8 w-8 object-contain opacity-90 shrink-0 hidden sm:block"
                  onError={(e) => {
                    e.currentTarget.src = '/Logo/sec-email-logo-transparent.png';
                  }}
                />
              </div>
              {ticket.subtitle && (
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <Ticket className="w-3.5 h-3.5 shrink-0" />
                  <span className="break-words">{ticket.subtitle}</span>
                </div>
              )}
              {ticket.table_specs_summary && (
                <p className="text-xs text-gray-500 leading-relaxed whitespace-pre-line break-words">{ticket.table_specs_summary}</p>
              )}
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <Calendar className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {phase === 'refunded'
                    ? 'Refunded — QR no longer valid'
                    : phase === 'upcoming'
                    ? `Starts ${ticket.event_starts_at ? format(parseISO(ticket.event_starts_at), 'MMM dd, yyyy HH:mm') : '—'}`
                    : phase === 'expired'
                      ? `Expired ${expiresLabel}`
                      : `Valid through ${expiresLabel}`}
                </span>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="outline" size="sm" className="border-[#262629] h-8" asChild>
                  <Link to={ticketDetailHref(ticket)}>View details</Link>
                </Button>
                {canOrderMore && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-[#262629] h-8"
                    onClick={() => setOrderMoreTicketId(ticket.id)}
                  >
                    <ShoppingBag className="w-3.5 h-3.5 mr-1" />
                    Order more
                  </Button>
                )}
                {!isRefunded &&
                  ticketCanRequestRefund(ticket) &&
                  (!isInactiveTab || phase === 'expired') && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-[#262629] h-8"
                    onClick={() => {
                      setRefundRef(normalizePaymentRef(ticket.paystack_reference));
                      setRefundLabel(ticket.title);
                      setRefundOpen(true);
                    }}
                  >
                    <RotateCcw className="w-3.5 h-3.5 mr-1" />
                    Request refund
                  </Button>
                )}
                {isInactiveTab && phase === 'expired' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-red-900/50 text-red-400 hover:bg-red-950/30 h-8"
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(ticket.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1" />
                    Delete
                  </Button>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Issued {ticket.created_at ? format(parseISO(ticket.created_at), 'MMM dd, yyyy') : '—'}
              </p>
            </div>

            <div className="flex flex-col items-center sm:items-end gap-1 shrink-0 order-1 sm:order-2">
              <TicketQrBlock verifyUrl={verifyUrl} eventCode={ticket.event_code} />
              {(ticket.venue_name || doorTimeLabel) && (
                <p className="text-[10px] text-gray-400 text-center sm:text-right max-w-[11rem] leading-snug font-medium">
                  {[ticket.venue_name, doorTimeLabel].filter(Boolean).join(' · ')}
                </p>
              )}
              <span className="text-[10px] text-gray-400 text-center sm:text-right max-w-[11rem] leading-tight">
                {isAddon
                  ? 'Show to staff to collect this order'
                  : 'Venue and time are in the QR link for quick checks'}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  const openGeneralRefund = () => {
    setRefundRef(null);
    setRefundLabel('');
    setRefundOpen(true);
  };

  const emptyCopyActive = {
    title: 'No active tickets',
    hint: 'Book a table or buy an event ticket to see it here.',
  };
  const emptyCopyInactive = {
    title: 'No expired tickets',
    hint: 'Tickets move here after the event ends.',
  };

  const ticketRefundFallbackCount = useMemo(() => {
    const seen = new Set();
    for (const ticket of [...activeTickets, ...inactiveTickets]) {
      if (ticketCanRequestRefund(ticket)) {
        const ref = normalizePaymentRef(ticket.paystack_reference);
        if (ref) seen.add(ref);
      }
    }
    return seen.size;
  }, [activeTickets, inactiveTickets, eligibleRefundItems]);

  const showRefundBanner = eligibleRefundCount > 0 || ticketRefundFallbackCount > 0;
  const refundBannerCount = Math.max(eligibleRefundCount, ticketRefundFallbackCount);

  if (!userId) {
    return null;
  }

  return (
    <div className="space-y-4">
      {showRefundBanner && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between rounded-lg border border-[#262629] bg-[#0A0A0B] px-3 py-2.5">
          <p className="text-xs text-gray-400">
            {activeTickets.length === 0
              ? 'You have an eligible payment you can request a refund for.'
              : `You have ${refundBannerCount} eligible payment${refundBannerCount === 1 ? '' : 's'} for refund.`}
          </p>
          <Button variant="outline" size="sm" className="border-[#262629] shrink-0" onClick={openGeneralRefund}>
            <RotateCcw className="w-3.5 h-3.5 mr-1" />
            Request refund
            {refundBannerCount > 1 ? ` (${refundBannerCount})` : ''}
          </Button>
        </div>
      )}

      <div className="flex w-full rounded-lg border border-[#262629] bg-[#0A0A0B] p-1">
        <button
          type="button"
          className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
            tab === 'active' ? 'bg-[#1a1a1d] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'
          }`}
          onClick={() => setTab('active')}
        >
          Active
        </button>
        <button
          type="button"
          className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
            tab === 'inactive' ? 'bg-[#1a1a1d] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'
          }`}
          onClick={() => setTab('inactive')}
        >
          Inactive
        </button>
      </div>

      <p className="text-xs text-gray-500 px-1">
        Active shows all valid tickets, including upcoming events. Refunded and expired tickets are under Inactive.
      </p>

      {tab === 'active' && !activeLoading && activeTickets.length === 0 && inactiveTickets.length > 0 && (
        <p className="text-xs text-amber-200/90 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2">
          You have tickets under Inactive (expired or refunded). Switch to the Inactive tab to view them.
        </p>
      )}

      {(activeFromCache || inactiveFromCache) && (
        <p className="text-xs text-amber-200/90 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2">
          Offline or couldn&apos;t refresh — showing tickets last saved on this device. Open Profile online once to
          update.
        </p>
      )}

      {tab === 'active' && (
        <div className="mt-4 space-y-3">
          {activeLoading ? (
            <div className="text-center py-8 text-gray-500">Loading tickets...</div>
          ) : activeTickets.length === 0 ? (
            <div className="text-center py-12">
              <Ticket className="w-12 h-12 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400 mb-1">{emptyCopyActive.title}</p>
              <p className="text-gray-500 text-sm mb-4">{emptyCopyActive.hint}</p>
              <Link to={createPageUrl('Events')}>
                <Button className="sec-btn-accent">Browse events</Button>
              </Link>
            </div>
          ) : (
            activeTickets.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} />)
          )}
        </div>
      )}

      {tab === 'inactive' && (
        <div className="mt-4 space-y-3">
          {inactiveLoading ? (
            <div className="text-center py-8 text-gray-500">Loading tickets...</div>
          ) : inactiveTickets.length === 0 ? (
            <div className="text-center py-12">
              <Ticket className="w-12 h-12 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400 mb-1">{emptyCopyInactive.title}</p>
              <p className="text-gray-500 text-sm">{emptyCopyInactive.hint}</p>
            </div>
          ) : (
            inactiveTickets.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} />)
          )}
        </div>
      )}

      <OrderMoreDialog
        open={Boolean(orderMoreTicketId)}
        onOpenChange={(v) => {
          if (!v) setOrderMoreTicketId(null);
        }}
        ticketId={orderMoreTicketId}
      />

      <RefundRequestDialog
        open={refundOpen}
        onOpenChange={setRefundOpen}
        paymentReference={refundRef}
        label={refundLabel}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ['my-tickets', userId] });
          queryClient.invalidateQueries({ queryKey: ['profile-social'] });
          queryClient.invalidateQueries({ queryKey: ['table-history', userId] });
        }}
      />
    </div>
  );
}
