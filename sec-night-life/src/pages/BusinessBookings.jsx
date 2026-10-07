import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as authService from '@/services/authService';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiGet, apiPost } from '@/api/client';
import { toast } from 'sonner';
import {
  Users, Search, Loader2, ChevronRight, Ticket, Armchair, CalendarDays, Utensils,
} from 'lucide-react';
import PageBackHeader from '@/components/layout/PageBackHeader';
import VenueSwitcher from '@/components/business/VenueSwitcher';
import OrderFulfillControls, { OrderStatusBadge } from '@/components/business/OrderFulfillControls';
import EventSearchSelect from '@/components/business/EventSearchSelect';
import { useActiveVenue } from '@/context/ActiveVenueContext';
import { useBusinessVenueScope } from '@/hooks/useBusinessVenueScope';
import { format, parseISO } from 'date-fns';

function formatEventWhen(event) {
  if (!event?.date && !event?.startTime) return null;
  try {
    const datePart = event.date ? format(parseISO(event.date), 'EEE d MMM yyyy') : 'Date TBC';
    if (event.startTime) return `${datePart} · ${event.startTime}`;
    return datePart;
  } catch {
    return event?.date || null;
  }
}

function ticketScopeNotice(notice) {
  if (notice === 'past_event_use_past_scope') {
    return 'This event is in the past. Switch to Past events to see its ticket sales.';
  }
  if (notice === 'upcoming_event_use_active_scope') {
    return 'This event is upcoming. Switch to Active events to see its ticket sales.';
  }
  return null;
}

function StatusBadge({ status, label }) {
  const classMap = {
    open: 'sec-badge-success',
    active: 'sec-badge-gold',
    full: 'sec-badge-gold',
    closed: 'sec-badge-muted',
    admitted: 'sec-badge-success',
    pending: 'sec-badge-silver',
  };
  const key = (status || '').toLowerCase();
  return (
    <span className={`sec-badge ${classMap[key] || 'sec-badge-muted'}`}>
      {label || status}
    </span>
  );
}

function StatTile({ label, value, accent, subtitle }) {
  return (
    <div
      className="sec-card"
      style={{
        padding: '14px 16px',
        background: 'linear-gradient(145deg, var(--sec-bg-card) 0%, var(--sec-bg-elevated) 100%)',
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ? 'var(--sec-accent)' : 'var(--sec-text-primary)' }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 4, letterSpacing: '0.02em' }}>
        {label}
      </div>
      {subtitle ? (
        <div style={{ fontSize: 10, color: 'var(--sec-text-muted)', marginTop: 2, opacity: 0.85 }}>{subtitle}</div>
      ) : null}
    </div>
  );
}

function FilterBar({ children }) {
  return (
    <div
      className="flex flex-col sm:flex-row sm:flex-wrap"
      style={{
        gap: 10,
        marginBottom: 18,
        padding: '14px 16px',
        borderRadius: 14,
        background: 'var(--sec-bg-card)',
        border: '1px solid var(--sec-border)',
      }}
    >
      {children}
    </div>
  );
}

const dialogContentStyle = {
  backgroundColor: 'var(--sec-bg-elevated)',
  border: '1px solid var(--sec-border)',
  borderRadius: 'var(--radius-xl)',
  color: 'var(--sec-text-primary)',
  padding: 0,
  overflow: 'hidden',
};

function ticketPaidZar(order) {
  return Number(order?.grossPaidZar ?? order?.amountPaidZar ?? 0);
}

function roleLabel(role) {
  if (role === 'HOST') return 'Host fee';
  if (role === 'GUEST') return 'Guest join';
  if (role === 'ENTRANCE') return 'Entrance';
  return role || 'Payment';
}

function isSyntheticHostedId(id) {
  return String(id || '').startsWith('direct-vt-');
}

function sessionQueryFromEventGroup(group) {
  if (group?.isEntranceOnly || String(group?.id || '').startsWith('entrance-only-')) {
    return { entrance_only: true, event_id: group.event?.id || group.transactions?.[0]?.eventId };
  }
  const htId = group.hostedTable?.id;
  if (htId && !isSyntheticHostedId(htId)) {
    return { hosted_table_id: htId };
  }
  const tx = (group.transactions || [])[0];
  const venueTableId = tx?.venueTableId;
  const session = tx?.tableSessionNumber || 1;
  if (venueTableId) {
    return { venue_table_id: venueTableId, session };
  }
  return null;
}

function sessionStatusLabel(status) {
  if (status === 'ACTIVE') return 'Active';
  if (status === 'RESET') return 'Reset';
  return 'Ended';
}

function formatSessionWindow(sessionWindow) {
  if (!sessionWindow) return null;
  const { bookingDate, windowStartTime, windowEndTime } = sessionWindow;
  if (!bookingDate && !windowStartTime) return null;
  const datePart = bookingDate || '';
  const timePart =
    windowStartTime && windowEndTime
      ? `${windowStartTime} – ${windowEndTime}`
      : windowStartTime || windowEndTime || '';
  return [datePart, timePart].filter(Boolean).join(' · ');
}

function PaymentBreakdown({ participant }) {
  if (!participant) return null;
  const lines = [];
  if (Number(participant.joinFeeZar) > 0) lines.push(`Join fee R${Number(participant.joinFeeZar).toFixed(0)}`);
  if (Number(participant.ticketZar) > 0) lines.push(`Tickets R${Number(participant.ticketZar).toFixed(0)}`);
  if (Number(participant.entranceZar) > 0) lines.push(`Entrance R${Number(participant.entranceZar).toFixed(0)}`);
  if (Number(participant.menuZar) > 0) lines.push(`Menu R${Number(participant.menuZar).toFixed(0)}`);
  if (participant.settlementMode) lines.push(participant.settlementMode.replace(/_/g, ' '));
  if (!lines.length) return null;
  return (
    <p style={{ fontSize: 10, color: 'var(--sec-text-muted)', marginTop: 6 }}>
      {lines.join(' · ')}
    </p>
  );
}

function menuLineAmount(item) {
  const total = Number(item?.lineTotal ?? item?.lineTotalZar);
  if (Number.isFinite(total) && total > 0) return total;
  const unit = Number(item?.unitPrice ?? item?.price) || 0;
  const qty = Number(item?.qty || item?.quantity) || 1;
  return unit * qty;
}

function MenuItemsBlock({ items }) {
  if (!Array.isArray(items) || !items.length) return null;
  return (
    <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', fontSize: 11, color: 'var(--sec-text-secondary)' }}>
      {items.map((item, i) => {
        const amount = menuLineAmount(item);
        const name = item.name || item.label || 'Item';
        return (
          <li key={item.menuItemId || i} style={{ marginTop: i ? 4 : 0 }}>
            {item.qty || item.quantity}× {name}
            {amount > 0 ? ` · R${amount.toFixed(0)}` : ''}
          </li>
        );
      })}
    </ul>
  );
}

function EmptyState({ icon: Icon, title, description }) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '48px 24px',
        borderRadius: 16,
        background: 'var(--sec-bg-card)',
        border: '1px dashed var(--sec-border)',
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          margin: '0 auto 14px',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--sec-accent-muted)',
          border: '1px solid var(--sec-accent-border)',
        }}
      >
        <Icon size={24} style={{ color: 'var(--sec-accent)' }} />
      </div>
      <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 6 }}>{title}</p>
      <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', maxWidth: 360, margin: '0 auto', lineHeight: 1.5 }}>
        {description}
      </p>
    </div>
  );
}

export default function BusinessBookings() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeVenueId } = useActiveVenue();
  const venueScope = useBusinessVenueScope();
  const scopeKey = venueScope.staffContextToken || activeVenueId;
  const [user, setUser] = useState(null);
  const [mainTab, setMainTab] = useState('orders');
  const [tableSubTab, setTableSubTab] = useState('event');
  const [ticketSubTab, setTicketSubTab] = useState('tickets');
  const [dayVenueScope, setDayVenueScope] = useState('active');
  const [search, setSearch] = useState('');
  const [orderStatus, setOrderStatus] = useState('pending');
  const [orderDate, setOrderDate] = useState('');
  const [orderEventId, setOrderEventId] = useState('all');
  const [orderSource, setOrderSource] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [eventTimeScope, setEventTimeScope] = useState('active');
  const [ticketEventTimeScope, setTicketEventTimeScope] = useState('active');
  const [selectedEventId, setSelectedEventId] = useState('all');
  const [ticketEventId, setTicketEventId] = useState('all');
  const [detailTicket, setDetailTicket] = useState(null);
  const [sessionView, setSessionView] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setUser(await authService.loadUserOrLogin());
      } catch {
        // loadUserOrLogin redirects when no session remains
      }
    })();
  }, []);

  const { data: bookingsData, isLoading: eventTablesLoading, isError: eventTablesError, error: eventTablesQueryError } = useQuery({
    queryKey: ['biz-event-table-bookings', user?.id, selectedEventId, eventTimeScope, scopeKey, search],
    queryFn: () => {
      const params = new URLSearchParams({ event_scope: eventTimeScope });
      if (selectedEventId !== 'all') params.set('event_id', selectedEventId);
      if (search.trim()) params.set('q', search.trim());
      if (venueScope.venueQuery) {
        const extra = new URLSearchParams(venueScope.venueQuery);
        extra.forEach((v, k) => params.set(k, v));
      }
      return apiGet(`/api/business/event-table-bookings?${params.toString()}`);
    },
    enabled: !!user && mainTab === 'tables' && tableSubTab === 'event',
    refetchOnWindowFocus: true,
  });

  const { data: venueTableBookingsData, isLoading: venueBookingsLoading } = useQuery({
    queryKey: ['biz-venue-table-bookings', user?.id, scopeKey, dayVenueScope, search],
    queryFn: () => {
      const params = new URLSearchParams({ session_scope: dayVenueScope });
      if (search.trim()) params.set('q', search.trim());
      if (venueScope.venueQuery) {
        const extra = new URLSearchParams(venueScope.venueQuery);
        extra.forEach((v, k) => params.set(k, v));
      }
      return apiGet(`/api/business/venue-table-bookings?${params.toString()}`);
    },
    enabled: !!user && mainTab === 'tables' && tableSubTab === 'venue-day',
    refetchOnWindowFocus: true,
  });

  const { data: ticketBookingsData, isLoading: ticketsLoading } = useQuery({
    queryKey: ['biz-ticket-bookings', user?.id, ticketEventId, ticketEventTimeScope, scopeKey, search],
    queryFn: () => {
      const params = new URLSearchParams({ event_scope: ticketEventTimeScope });
      if (ticketEventId !== 'all') params.set('event_id', ticketEventId);
      if (search.trim()) params.set('q', search.trim());
      if (venueScope.venueQuery) {
        const extra = new URLSearchParams(venueScope.venueQuery);
        extra.forEach((v, k) => params.set(k, v));
      }
      return apiGet(`/api/business/ticket-bookings?${params.toString()}`);
    },
    enabled: !!user && mainTab === 'tickets',
    refetchOnWindowFocus: true,
  });

  const { data: ordersData, isLoading: ordersLoading } = useQuery({
    queryKey: ['biz-orders', user?.id, scopeKey, orderStatus, orderDate, orderEventId, orderSource, search],
    queryFn: () => {
      const params = new URLSearchParams({ status: orderStatus });
      if (search.trim()) params.set('q', search.trim());
      if (orderDate) params.set('date', orderDate);
      if (orderEventId && orderEventId !== 'all') params.set('event_id', orderEventId);
      if (orderSource && orderSource !== 'all') params.set('source', orderSource);
      if (venueScope.venueQuery) {
        const extra = new URLSearchParams(venueScope.venueQuery);
        extra.forEach((v, k) => params.set(k, v));
      }
      return apiGet(`/api/business/orders?${params.toString()}`);
    },
    enabled: !!user && mainTab === 'orders',
    refetchOnWindowFocus: true,
  });

  const { data: sessionDetail, isLoading: sessionDetailLoading } = useQuery({
    queryKey: ['biz-table-booking-detail', sessionView?.query, scopeKey],
    queryFn: () => {
      const params = new URLSearchParams();
      const q = sessionView.query;
      if (q.hosted_table_id) params.set('hosted_table_id', q.hosted_table_id);
      if (q.venue_table_id) {
        params.set('venue_table_id', q.venue_table_id);
        params.set('session', String(q.session || 1));
      } else if (q.session) {
        params.set('session', String(q.session || 1));
      }
      if (venueScope.venueQuery) {
        const extra = new URLSearchParams(venueScope.venueQuery);
        extra.forEach((v, k) => params.set(k, v));
      }
      return apiGet(`/api/business/table-booking-detail?${params.toString()}`);
    },
    enabled: !!user && !!sessionView?.query && !sessionView?.entranceGroup,
  });

  const releaseMutation = useMutation({
    mutationFn: (tableId) => apiPost(`/api/business/venue-tables/${tableId}/release`, {}),
    onSuccess: () => {
      toast.success('Table reset — slot is available for new bookings');
      queryClient.invalidateQueries({ queryKey: ['biz-venue-table-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['biz-day-venue-tables'] });
      queryClient.invalidateQueries({ queryKey: ['biz-event-table-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['event-venue-tables'] });
    },
    onError: (err) => {
      toast.error(err?.data?.error || err?.message || 'Could not release table');
    },
  });

  const eventTables = bookingsData?.items || [];
  const venueTableBookings = venueTableBookingsData?.items || [];
  const ticketOrders = ticketBookingsData?.items || [];
  const ticketTableGroups = ticketBookingsData?.tableGroups || [];
  const eventSummary = bookingsData?.summary;
  const ticketSummary = ticketBookingsData?.summary;

  useEffect(() => {
    setSelectedEventId('all');
  }, [scopeKey]);

  useEffect(() => {
    if (!eventTablesError || !eventTablesQueryError) return;
    const err = eventTablesQueryError;
    toast.error(err?.data?.error || err?.message || 'Could not load event table bookings');
  }, [eventTablesError, eventTablesQueryError]);

  useEffect(() => {
    setTicketEventId('all');
  }, [scopeKey]);

  useEffect(() => {
    setOrderEventId('all');
    setOrderDate('');
    setOrderSource('all');
  }, [scopeKey]);

  const filteredEventTables = eventTables
    .filter((group) => {
      if (statusFilter === 'all') return true;
      return (group.transactions || []).some((t) => t.role === statusFilter);
    })
    .filter((group) => {
      if (!search) return true;
      const q = search.toLowerCase();
      const matchesTable =
        (group?.event?.title || '').toLowerCase().includes(q) ||
        (group?.hostedTable?.tableName || '').toLowerCase().includes(q);
      const matchesGuest = (group.transactions || []).some((t) =>
        (t?.user?.username || '').toLowerCase().includes(q),
      );
      return matchesTable || matchesGuest;
    });

  const filteredVenueTables = venueTableBookings.filter((row) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (row.table?.tableName || '').toLowerCase().includes(q) ||
      (row.table?.venue?.name || '').toLowerCase().includes(q) ||
      (row.user?.username || '').toLowerCase().includes(q)
    );
  });

  const filteredTickets = ticketOrders.filter((order) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (order.event?.title || '').toLowerCase().includes(q) ||
      (order.tierName || '').toLowerCase().includes(q) ||
      (order.purchaser?.username || '').toLowerCase().includes(q) ||
      (order.paystackReference || '').toLowerCase().includes(q)
    );
  });

  const filteredTicketTableGroups = ticketTableGroups.filter((group) => {
    if (!search) return true;
    const q = search.toLowerCase();
    const matchesTable =
      (group?.event?.title || '').toLowerCase().includes(q) ||
      (group?.hostedTable?.tableName || '').toLowerCase().includes(q);
    const matchesGuest = (group.transactions || []).some((t) =>
      (t?.user?.username || '').toLowerCase().includes(q),
    );
    return matchesTable || matchesGuest;
  });

  const ticketTableStats = {
    tableCount: filteredTicketTableGroups.length,
    transactionCount: filteredTicketTableGroups.reduce((s, g) => s + Number(g.transactionCount || 0), 0),
    totalPaidZar:
      ticketSummary?.tablePaidZar != null
        ? Number(ticketSummary.tablePaidZar)
        : filteredTicketTableGroups.reduce((s, g) => s + Number(g.totalPaidZar || 0), 0),
  };

  const openEventTableSession = (group) => {
    const query = sessionQueryFromEventGroup(group);
    if (!query) return;
    if (query.entrance_only) {
      setSessionView({
        query: null,
        entranceGroup: group,
        title: 'Entrance only',
        subtitle: group.event?.title || 'Event booking',
      });
      return;
    }
    setSessionView({
      query,
      title: group.hostedTable?.tableName || 'Hosted table',
      subtitle: group.event?.title || 'Event booking',
    });
  };

  const openDayTableSession = (row) => {
    setSessionView({
      query: {
        venue_table_id: row.table?.id,
        hosted_table_id: row.table?.hostedTableId || undefined,
        session: row.sessionNumber ?? row.table?.tableSessionNumber ?? 1,
      },
      title: row.table?.tableName || 'Day table',
      subtitle: row.table?.venue?.name ? `${row.table.venue.name} · Day booking` : 'Day booking',
    });
  };

  const closeSessionView = () => setSessionView(null);

  const eventTableStats = {
    tableCount: filteredEventTables.length,
    totalRevenue: filteredEventTables.reduce((s, g) => s + Number(g.totalPaidZar || 0), 0),
    transactionCount: filteredEventTables.reduce((s, g) => s + Number(g.transactionCount || 0), 0),
    open: eventSummary?.hostedTablesOpen ?? 0,
    full: eventSummary?.hostedTablesFull ?? 0,
    pendingRequests: eventSummary?.pendingJoinRequests ?? 0,
  };

  if (!user) return null;

  const selectTriggerStyle = {
    backgroundColor: 'var(--sec-bg-elevated)',
    borderColor: 'var(--sec-border)',
    color: 'var(--sec-text-primary)',
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <PageBackHeader
        title="Bookings"
        subtitle="Find guests by username, then mark menu and min-spend orders as fulfilled"
        pageName="BusinessBookings"
      />

      <div className="pb-8">
        <div style={{ marginBottom: 20 }}>
          <VenueSwitcher />
        </div>

        <div style={{ position: 'relative', marginBottom: 16 }}>
          <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--sec-text-muted)' }} />
          <Input
            placeholder="Search @username, full name, event, or table…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-11 rounded-xl pl-10"
            style={selectTriggerStyle}
          />
        </div>

        <Tabs value={mainTab} onValueChange={setMainTab} className="w-full">
          <TabsList
            className="w-full sec-tabs-scroll justify-start gap-1 mb-6 rounded-xl p-1"
            style={{ background: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)', height: 'auto' }}
          >
            <TabsTrigger
              value="orders"
              className="flex-shrink-0 min-w-max rounded-lg data-[state=active]:bg-[var(--sec-bg-elevated)] data-[state=active]:shadow-sm"
              style={{ gap: 8, padding: '10px 16px', border: 'none', marginBottom: 0 }}
            >
              <Utensils size={16} />
              Orders
            </TabsTrigger>
            <TabsTrigger
              value="tables"
              className="flex-shrink-0 min-w-max rounded-lg data-[state=active]:bg-[var(--sec-bg-elevated)] data-[state=active]:shadow-sm"
              style={{ gap: 8, padding: '10px 16px', border: 'none', marginBottom: 0 }}
            >
              <Armchair size={16} />
              Table bookings
            </TabsTrigger>
            <TabsTrigger
              value="tickets"
              className="flex-shrink-0 min-w-max rounded-lg data-[state=active]:bg-[var(--sec-bg-elevated)] data-[state=active]:shadow-sm"
              style={{ gap: 8, padding: '10px 16px', border: 'none', marginBottom: 0 }}
            >
              <Ticket size={16} />
              Ticket bookings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="orders" className="mt-0">
            <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
              Prepaid menu items and minimum spend — tick a guest when they have received their order so the QR cannot be reused for free items.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
              <StatTile label="Needs serving" value={ordersData?.summary?.pending ?? 0} accent />
              <StatTile label="Fulfilled" value={ordersData?.summary?.fulfilled ?? 0} />
              <StatTile label="Total orders" value={ordersData?.summary?.total ?? 0} />
            </div>
            <FilterBar>
              <Select value={orderStatus} onValueChange={setOrderStatus}>
                <SelectTrigger className="w-full sm:w-[180px] h-10 rounded-xl" style={selectTriggerStyle}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--sec-bg-card)] border-[var(--sec-border)] text-[var(--sec-text-primary)]">
                  <SelectItem value="pending">Needs serving</SelectItem>
                  <SelectItem value="fulfilled">Fulfilled</SelectItem>
                  <SelectItem value="all">All orders</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="date"
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
                className="w-full sm:w-[180px] h-10 rounded-xl"
                style={selectTriggerStyle}
                aria-label="Filter by date"
              />
              <EventSearchSelect
                value={orderEventId}
                onValueChange={setOrderEventId}
                venueScope={venueScope}
                triggerStyle={selectTriggerStyle}
              />
              <Select value={orderSource} onValueChange={setOrderSource}>
                <SelectTrigger className="w-full sm:w-[200px] h-10 rounded-xl" style={selectTriggerStyle}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--sec-bg-card)] border-[var(--sec-border)] text-[var(--sec-text-primary)]">
                  <SelectItem value="all">All bookings</SelectItem>
                  <SelectItem value="event">Event bookings</SelectItem>
                  <SelectItem value="day">Day bookings</SelectItem>
                  <SelectItem value="ticket">Tickets</SelectItem>
                </SelectContent>
              </Select>
            </FilterBar>
            {ordersLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="animate-spin" style={{ color: 'var(--sec-accent)' }} /></div>
            ) : !(ordersData?.items || []).length ? (
              <EmptyState
                icon={Utensils}
                title={orderStatus === 'fulfilled' ? 'No fulfilled orders' : 'No orders waiting'}
                description={
                  search || orderDate || orderEventId !== 'all' || orderSource !== 'all'
                    ? 'Try a different username, date, event, or booking type.'
                    : 'Prepaid menu, min-spend and add-on orders appear here so staff can tick them as served.'
                }
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(ordersData.items || []).map((order) => (
                  <div
                    key={order.id}
                    className="sec-card"
                    style={{ padding: '14px 16px', border: '1px solid var(--sec-border)' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)' }}>
                          @{order.username || 'guest'}
                          {order.fullName ? ` · ${order.fullName}` : ''}
                          {order.isAddon ? (
                            <span className="sec-badge sec-badge-gold" style={{ marginLeft: 8, fontSize: 10 }}>
                              Add-on order
                            </span>
                          ) : null}
                        </p>
                        <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                          {[order.eventTitle, order.tableName].filter(Boolean).join(' · ') || 'Booking'}
                          {order.source === 'day' ? ' · Day booking' : ''}
                          {order.source === 'ticket' ? ' · Ticket' : ''}
                        </p>
                        <MenuItemsBlock items={order.menuItems} />
                        {order.isAddon ? (
                          <p style={{ fontSize: 11, color: 'var(--sec-text-secondary)', marginTop: 6 }}>
                            Extra order placed after the main booking. Serve separately; it has its own QR.
                          </p>
                        ) : (
                          <PaymentBreakdown participant={order} />
                        )}
                        {Number(order.minimumSpendZar) > 0 && !(order.menuItems || []).length ? (
                          <p style={{ fontSize: 11, color: 'var(--sec-text-secondary)', marginTop: 8 }}>
                            Minimum spend R{Number(order.minimumSpendZar).toFixed(0)}
                          </p>
                        ) : null}
                      </div>
                      <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--sec-accent)', flexShrink: 0 }}>
                        R{Number(order.amountPaidZar || 0).toFixed(0)}
                      </p>
                    </div>
                    <OrderFulfillControls
                      paystackReference={order.paystackReference}
                      hasServeableOrder
                      orderFulfilled={order.fulfilled}
                    />
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="tables" className="mt-0">
            <Tabs value={tableSubTab} onValueChange={setTableSubTab}>
              <TabsList className="mb-5 border-0 sec-tabs-scroll" style={{ background: 'transparent' }}>
                <TabsTrigger
                  value="event"
                  className="rounded-full px-4 py-2 text-sm data-[state=active]:bg-[var(--sec-accent-muted)] data-[state=active]:text-[var(--sec-accent)]"
                  style={{ border: '1px solid var(--sec-border)', marginBottom: 0 }}
                >
                  Event table bookings
                </TabsTrigger>
                <TabsTrigger
                  value="venue-day"
                  className="rounded-full px-4 py-2 text-sm data-[state=active]:bg-[var(--sec-accent-muted)] data-[state=active]:text-[var(--sec-accent)]"
                  style={{ border: '1px solid var(--sec-border)', marginBottom: 0 }}
                >
                  Day table bookings
                </TabsTrigger>
              </TabsList>

              <TabsContent value="event" className="mt-0">
                <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
                  SEC hosted tables — host fees, guest joins, and tier payments for your events.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 10, marginBottom: 16 }}>
                  <StatTile label="Tables" value={eventTableStats.tableCount} accent />
                  <StatTile label="Transactions" value={eventTableStats.transactionCount} />
                  <StatTile label="Open tables" value={eventTableStats.open} />
                  <StatTile label="Full tables" value={eventTableStats.full} />
                  <StatTile label="Join requests" value={eventTableStats.pendingRequests} />
                  <StatTile label="Paid" value={`R${Number(eventTableStats.totalRevenue || 0).toFixed(0)}`} accent />
                </div>

                <FilterBar>
                  <Select value={eventTimeScope} onValueChange={setEventTimeScope}>
                    <SelectTrigger className="w-full sm:w-[180px] h-10 rounded-xl" style={selectTriggerStyle}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--sec-bg-card)] border-[var(--sec-border)] text-[var(--sec-text-primary)]">
                      <SelectItem value="active">Active events</SelectItem>
                      <SelectItem value="past">Past events</SelectItem>
                      <SelectItem value="all">All events</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-full sm:w-[130px] h-10 rounded-xl" style={selectTriggerStyle}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--sec-bg-card)] border-[var(--sec-border)] text-[var(--sec-text-primary)]">
                      <SelectItem value="all">All roles</SelectItem>
                      <SelectItem value="HOST">Host fee</SelectItem>
                      <SelectItem value="GUEST">Guest join</SelectItem>
                    </SelectContent>
                  </Select>
                  <EventSearchSelect
                    value={selectedEventId}
                    onValueChange={(id) => {
                      setSelectedEventId(id);
                      if (id !== 'all') setEventTimeScope('all');
                    }}
                    venueScope={venueScope}
                    triggerStyle={selectTriggerStyle}
                  />
                </FilterBar>

                {eventTablesLoading ? (
                  <div className="flex justify-center py-16"><Loader2 className="animate-spin" style={{ color: 'var(--sec-accent)' }} /></div>
                ) : filteredEventTables.length === 0 ? (
                  <EmptyState
                    icon={Users}
                    title="No event table bookings"
                    description={search ? 'Try a different search term or broaden your filters.' : 'Bookings appear here when guests host or join tables at your events.'}
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {filteredEventTables.map((group) => (
                      <div
                        key={group.id}
                        className="sec-card"
                        style={{ padding: '14px 16px', border: '1px solid var(--sec-border)', cursor: 'pointer' }}
                        onClick={() => openEventTableSession(group)}
                        onKeyDown={(e) => e.key === 'Enter' && openEventTableSession(group)}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                          <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
                          <div style={{
                            width: 48, height: 48, borderRadius: 12, flexShrink: 0,
                            background: 'var(--sec-accent-muted)', border: '1px solid var(--sec-accent-border)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Users size={20} style={{ color: 'var(--sec-accent)' }} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {group.hostedTable?.tableName || 'Hosted table'}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--sec-text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {group.event?.title || 'Event booking'}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                              {group.transactionCount} transaction{group.transactionCount === 1 ? '' : 's'}
                              {group.isEntranceOnly || group.rolesSummary?.entrance
                                ? ` · ${group.rolesSummary?.entrance || group.transactionCount} entrance`
                                : ''}
                              {group.rolesSummary?.hosts ? ` · ${group.rolesSummary.hosts} host` : ''}
                              {group.rolesSummary?.guests ? ` · ${group.rolesSummary.guests} guest${group.rolesSummary.guests === 1 ? '' : 's'}` : ''}
                            </div>
                          </div>
                          </div>
                          <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4 w-full sm:w-auto shrink-0">
                          <div className="text-left sm:text-right">
                            <div style={{ fontSize: 15, fontWeight: 700, color: group.hostRefundStatus === 'REFUNDED' ? 'var(--sec-text-muted)' : 'var(--sec-accent)' }}>
                              R{Number(group.totalPaidZar || 0).toFixed(0)}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 2 }}>
                              {group.hostRefundStatus === 'REFUNDED' ? 'Refunded' : 'Paid'}
                            </div>
                          </div>
                          {group.hostRefundStatus === 'REFUNDED' ? (
                            <span
                              className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                              style={{ background: 'var(--sec-bg-hover)', color: 'var(--sec-text-muted)' }}
                            >
                              Refunded
                            </span>
                          ) : (
                            <StatusBadge status={(group.hostedTable?.status || '').toLowerCase()} />
                          )}
                          <ChevronRight size={18} style={{ color: 'var(--sec-text-muted)', flexShrink: 0 }} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="venue-day" className="mt-0">
                <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
                  Paid bookings from day table listings and custom table requests after guests complete checkout.
                </p>

                <Tabs value={dayVenueScope} onValueChange={setDayVenueScope}>
                  <TabsList className="mb-4 border-0" style={{ background: 'transparent' }}>
                    <TabsTrigger
                      value="active"
                      className="rounded-full px-4 py-2 text-sm data-[state=active]:bg-[var(--sec-accent-muted)] data-[state=active]:text-[var(--sec-accent)]"
                      style={{ border: '1px solid var(--sec-border)', marginBottom: 0 }}
                    >
                      Active
                    </TabsTrigger>
                    <TabsTrigger
                      value="past"
                      className="rounded-full px-4 py-2 text-sm data-[state=active]:bg-[var(--sec-accent-muted)] data-[state=active]:text-[var(--sec-accent)]"
                      style={{ border: '1px solid var(--sec-border)', marginBottom: 0 }}
                    >
                      Past tables
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

                {venueBookingsLoading ? (
                  <div className="flex justify-center py-16"><Loader2 className="animate-spin" style={{ color: 'var(--sec-accent)' }} /></div>
                ) : filteredVenueTables.length === 0 ? (
                  <EmptyState
                    icon={CalendarDays}
                    title={dayVenueScope === 'past' ? 'No past day tables' : 'No active day table bookings'}
                    description={
                      dayVenueScope === 'past'
                        ? 'Ended sessions from today appear here until midnight.'
                        : 'When guests pay for day tables or custom requests, they will show up here while the session is active.'
                    }
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {filteredVenueTables.map((row) => {
                      const specs = row.userSpecs || {};
                      return (
                        <div key={row.id} className="sec-card" style={{ padding: 16, border: '1px solid var(--sec-border)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                            <div>
                              <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--sec-text-primary)' }}>
                                {row.table?.tableName}
                                {(row.sessionNumber ?? row.table?.tableSessionNumber ?? 1) > 1 ? (
                                  <span style={{ marginLeft: 8, fontSize: 10, textTransform: 'uppercase', color: 'var(--sec-text-muted)', letterSpacing: '0.06em' }}>
                                    Session {row.sessionNumber ?? row.table.tableSessionNumber}
                                  </span>
                                ) : null}
                                {row.table?.isCustomListing ? (
                                  <span style={{ marginLeft: 8, fontSize: 10, textTransform: 'uppercase', color: 'var(--sec-accent)', letterSpacing: '0.06em' }}>Custom</span>
                                ) : null}
                              </p>
                              <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                                {row.table?.venue?.name}
                                {' · Day booking'}
                                {row.sessionEnded ? ' · Session ended' : ' · Active session'}
                              </p>
                              {(row.table?.startTime || row.table?.endTime) ? (
                                <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                                  {row.table.startTime || '—'}
                                  {' – '}
                                  {row.table.endTime || '—'}
                                </p>
                              ) : null}
                              <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                                @{row.user?.username || row.user?.fullName || 'Guest'}
                              </p>
                              <div style={{ marginTop: 8 }}>
                                <OrderStatusBadge
                                  hasServeableOrder={row.hasServeableOrder}
                                  orderFulfilled={row.orderFulfilled}
                                />
                              </div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--sec-accent)' }}>
                                R{Number(row.amountPaid || 0).toFixed(0)}
                              </p>
                              <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--sec-text-muted)', marginTop: 4 }}>
                                {row.settlementMode || '—'}
                              </p>
                            </div>
                          </div>
                          {(specs.guestCount || specs.notes) ? (
                            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--sec-border)', fontSize: 12, color: 'var(--sec-text-secondary)' }}>
                              {specs.guestCount != null ? <span>Guests: {specs.guestCount} · </span> : null}
                              {specs.notes ? <span className="italic">&ldquo;{specs.notes}&rdquo;</span> : null}
                            </div>
                          ) : null}
                          <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <Button variant="outline" size="sm" onClick={() => openDayTableSession(row)}>
                              View session
                            </Button>
                            {row.canRelease ? (
                              <Button
                                size="sm"
                                className="sec-btn-secondary"
                                disabled={releaseMutation.isPending}
                                onClick={() => {
                                  if (!window.confirm('End this table session and make the slot available for new bookings? Current guests\' table QRs will no longer admit. Past payments stay in Bookings & Analytics.')) return;
                                  releaseMutation.mutate(row.table?.id);
                                }}
                              >
                                {releaseMutation.isPending ? 'Resetting…' : 'Reset table'}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="tickets" className="mt-0">
            <Tabs value={ticketSubTab} onValueChange={setTicketSubTab}>
              <TabsList className="mb-5 border-0 sec-tabs-scroll" style={{ background: 'transparent' }}>
                <TabsTrigger
                  value="tickets"
                  className="rounded-full px-4 py-2 text-sm data-[state=active]:bg-[var(--sec-accent-muted)] data-[state=active]:text-[var(--sec-accent)]"
                  style={{ border: '1px solid var(--sec-border)', marginBottom: 0 }}
                >
                  Tickets
                </TabsTrigger>
                <TabsTrigger
                  value="tables"
                  className="rounded-full px-4 py-2 text-sm data-[state=active]:bg-[var(--sec-accent-muted)] data-[state=active]:text-[var(--sec-accent)]"
                  style={{ border: '1px solid var(--sec-border)', marginBottom: 0 }}
                >
                  Tables
                </TabsTrigger>
              </TabsList>

              <TabsContent value="tickets" className="mt-0">
                <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
                  Ticket purchases for your ticketing events — tier, quantity, and buyer details.
                </p>

                {ticketScopeNotice(ticketBookingsData?.notice) && (
                  <div
                    style={{
                      marginBottom: 16,
                      padding: '10px 14px',
                      borderRadius: 12,
                      border: '1px solid var(--sec-accent-border)',
                      background: 'var(--sec-accent-muted)',
                      fontSize: 13,
                      color: 'var(--sec-text-secondary)',
                    }}
                  >
                    {ticketScopeNotice(ticketBookingsData.notice)}
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
                  <StatTile label="Orders" value={ticketSummary?.orderCount ?? 0} accent />
                  <StatTile label="Tickets sold" value={ticketSummary?.ticketCount ?? 0} />
                  <StatTile label="Paid" value={`R${Number(ticketSummary?.totalGrossZar ?? ticketSummary?.totalRevenueZar ?? 0).toFixed(0)}`} accent />
                </div>

                <FilterBar>
                  <Select value={ticketEventTimeScope} onValueChange={setTicketEventTimeScope}>
                    <SelectTrigger className="w-[180px] h-10 rounded-xl" style={selectTriggerStyle}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--sec-bg-card)] border-[var(--sec-border)] text-[var(--sec-text-primary)]">
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="past">Past</SelectItem>
                      <SelectItem value="all">All</SelectItem>
                    </SelectContent>
                  </Select>
                  <EventSearchSelect
                    value={ticketEventId}
                    onValueChange={(id) => {
                      setTicketEventId(id);
                      if (id !== 'all') setTicketEventTimeScope('all');
                    }}
                    venueScope={venueScope}
                    triggerStyle={selectTriggerStyle}
                  />
                </FilterBar>

                {ticketsLoading ? (
                  <div className="flex justify-center py-16"><Loader2 className="animate-spin" style={{ color: 'var(--sec-accent)' }} /></div>
                ) : filteredTickets.length === 0 ? (
                  <EmptyState
                    icon={Ticket}
                    title="No ticket bookings yet"
                    description="When party goers buy tickets for your events, orders will appear here with tier and admission details."
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {filteredTickets.map((order) => (
                      <div
                        key={order.id}
                        className="sec-card"
                        style={{ padding: '14px 16px', border: '1px solid var(--sec-border)', cursor: 'pointer' }}
                        onClick={() => setDetailTicket(order)}
                        onKeyDown={(e) => e.key === 'Enter' && setDetailTicket(order)}
                        role="button"
                        tabIndex={0}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                          <div style={{
                            width: 48, height: 48, borderRadius: 12, flexShrink: 0,
                            background: 'var(--sec-accent-muted)', border: '1px solid var(--sec-accent-border)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Ticket size={20} style={{ color: 'var(--sec-accent)' }} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {order.event?.title || 'Ticket order'}
                            </div>
                            {formatEventWhen(order.event) && (
                              <div style={{ fontSize: 12, color: 'var(--sec-text-secondary)', marginTop: 2 }}>
                                {formatEventWhen(order.event)}
                                {order.event?.city ? ` · ${order.event.city}` : ''}
                              </div>
                            )}
                            <div style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                              {order.tierName} · {order.quantity} ticket{order.quantity === 1 ? '' : 's'} · @{order.purchaser?.username || 'guest'}
                              {order.fulfillmentPending ? ' · Preparing tickets' : ''}
                              {order.refundStatus === 'APPROVED' ? ' · Refunded' : ''}
                              {order.refundStatus === 'PENDING' ? ' · Refund pending' : ''}
                            </div>
                            <div style={{ marginTop: 6 }}>
                              <OrderStatusBadge
                                hasServeableOrder={order.hasServeableOrder}
                                orderFulfilled={order.orderFulfilled}
                              />
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            <div style={{ fontSize: 15, fontWeight: 700, color: order.refundStatus === 'APPROVED' ? 'var(--sec-text-muted)' : 'var(--sec-accent)' }}>
                              R{ticketPaidZar(order).toFixed(0)}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 2 }}>
                              {order.refundStatus === 'APPROVED' ? 'Refunded' : 'Paid'}
                            </div>
                          </div>
                          <ChevronRight size={18} style={{ color: 'var(--sec-text-muted)', flexShrink: 0 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="tables" className="mt-0">
                <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
                  Host and join tables at your ticketed events — same session view as event table bookings.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
                  <StatTile label="Tables" value={ticketTableStats.tableCount} accent />
                  <StatTile label="Transactions" value={ticketTableStats.transactionCount} />
                  <StatTile label="Paid" value={`R${Number(ticketTableStats.totalPaidZar || 0).toFixed(0)}`} accent />
                </div>

                <FilterBar>
                  <Select value={ticketEventTimeScope} onValueChange={setTicketEventTimeScope}>
                    <SelectTrigger className="w-[180px] h-10 rounded-xl" style={selectTriggerStyle}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--sec-bg-card)] border-[var(--sec-border)] text-[var(--sec-text-primary)]">
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="past">Past</SelectItem>
                      <SelectItem value="all">All</SelectItem>
                    </SelectContent>
                  </Select>
                  <EventSearchSelect
                    value={ticketEventId}
                    onValueChange={(id) => {
                      setTicketEventId(id);
                      if (id !== 'all') setTicketEventTimeScope('all');
                    }}
                    venueScope={venueScope}
                    triggerStyle={selectTriggerStyle}
                  />
                </FilterBar>

                {ticketsLoading ? (
                  <div className="flex justify-center py-16"><Loader2 className="animate-spin" style={{ color: 'var(--sec-accent)' }} /></div>
                ) : filteredTicketTableGroups.length === 0 ? (
                  <EmptyState
                    icon={Users}
                    title="No ticketed table bookings yet"
                    description="When guests host or join tables at your ticketed events, sessions will appear here."
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {filteredTicketTableGroups.map((group) => (
                      <div
                        key={`tt-${group.id}`}
                        className="sec-card"
                        style={{ padding: '14px 16px', border: '1px solid var(--sec-border)', cursor: 'pointer' }}
                        onClick={() => openEventTableSession(group)}
                        onKeyDown={(e) => e.key === 'Enter' && openEventTableSession(group)}
                        role="button"
                        tabIndex={0}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                          <div
                            style={{
                              width: 48,
                              height: 48,
                              borderRadius: 12,
                              flexShrink: 0,
                              background: 'var(--sec-accent-muted)',
                              border: '1px solid var(--sec-accent-border)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Users size={20} style={{ color: 'var(--sec-accent)' }} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 600 }}>
                              {group.hostedTable?.tableName || 'Table'}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--sec-text-secondary)', marginTop: 2 }}>
                              {group.event?.title || 'Ticketed event'}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                              {group.transactionCount} transaction{group.transactionCount === 1 ? '' : 's'}
                              {group.rolesSummary?.hosts ? ` · ${group.rolesSummary.hosts} host` : ''}
                              {group.rolesSummary?.guests
                                ? ` · ${group.rolesSummary.guests} guest${group.rolesSummary.guests === 1 ? '' : 's'}`
                                : ''}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--sec-accent)' }}>
                              R{Number(group.totalPaidZar || 0).toFixed(0)}
                            </div>
                          </div>
                          <ChevronRight size={18} style={{ color: 'var(--sec-text-muted)', flexShrink: 0 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </TabsContent>
        </Tabs>
      </div>

      {/* Table session detail (event + day bookings) */}
      <Dialog open={!!sessionView} onOpenChange={(open) => { if (!open) closeSessionView(); }}>
        <DialogContent className="sm:max-w-[480px] p-0 gap-0" style={dialogContentStyle}>
          {sessionView?.entranceGroup ? (
            <>
              <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--sec-border)' }}>
                <DialogHeader className="space-y-1 text-left">
                  <DialogTitle style={{ fontSize: 17, fontWeight: 700, color: 'var(--sec-text-primary)' }}>
                    Entrance only
                  </DialogTitle>
                  <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', margin: 0 }}>
                    {sessionView.subtitle}
                  </p>
                </DialogHeader>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--sec-accent)', marginLeft: 'auto' }}>
                    R{Number(sessionView.entranceGroup.totalPaidZar || 0).toFixed(0)} paid
                  </span>
                </div>
              </div>
              <div style={{ padding: '16px 20px', maxHeight: 'min(55vh, 400px)', overflowY: 'auto' }}>
                <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 10 }}>
                  Entrance payers
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(sessionView.entranceGroup.transactions || []).map((tx) => (
                    <div
                      key={tx.id}
                      style={{
                        padding: '12px 14px',
                        borderRadius: 12,
                        background: 'var(--sec-bg-card)',
                        border: '1px solid var(--sec-border)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-text-primary)' }}>
                          @{tx.user?.username || tx.user?.userProfile?.username || 'guest'}
                        </p>
                        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--sec-accent)' }}>
                          R{Number(tx.lineTotalZar || tx.amountTotal || 0).toFixed(0)}
                        </p>
                      </div>
                      {Number(tx.entranceZar) > 0 || Number(tx.menuTotalZar) > 0 ? (
                        <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                          {Number(tx.entranceZar) > 0 ? `Entrance R${Number(tx.entranceZar).toFixed(0)}` : ''}
                          {Number(tx.entranceZar) > 0 && Number(tx.menuTotalZar) > 0 ? ' · ' : ''}
                          {Number(tx.menuTotalZar) > 0 ? `Menu R${Number(tx.menuTotalZar).toFixed(0)}` : ''}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : sessionView ? (
            <>
              <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--sec-border)' }}>
                <DialogHeader className="space-y-1 text-left">
                  <DialogTitle style={{ fontSize: 17, fontWeight: 700, color: 'var(--sec-text-primary)' }}>
                    {sessionDetail?.tableName || sessionView.title}
                  </DialogTitle>
                  <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', margin: 0 }}>
                    {sessionDetail?.eventTitle || sessionView.subtitle}
                  </p>
                  {sessionDetail?.venueSlotName && sessionDetail.venueSlotName !== sessionDetail?.tableName ? (
                    <p style={{ fontSize: 12, color: 'var(--sec-accent)', margin: '6px 0 0' }}>
                      Venue table: {sessionDetail.venueSlotName}
                    </p>
                  ) : null}
                  {formatSessionWindow(sessionDetail?.sessionWindow) ? (
                    <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', margin: '6px 0 0' }}>
                      {formatSessionWindow(sessionDetail.sessionWindow)}
                    </p>
                  ) : null}
                  {sessionDetail?.sessionNumber ? (
                    <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', margin: '6px 0 0', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Session {sessionDetail.sessionNumber}
                    </p>
                  ) : null}
                </DialogHeader>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                  {sessionDetail ? (
                    <StatusBadge status={sessionDetail.status === 'ACTIVE' ? 'active' : 'closed'} label={sessionStatusLabel(sessionDetail.status)} />
                  ) : null}
                  {sessionDetailLoading ? (
                    <Loader2 size={14} className="animate-spin" style={{ color: 'var(--sec-text-muted)' }} />
                  ) : null}
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--sec-accent)', marginLeft: 'auto' }}>
                    R{Number(sessionDetail?.totalPaidZar || 0).toFixed(0)} paid
                  </span>
                </div>
              </div>
              <div style={{ padding: '16px 20px', maxHeight: 'min(55vh, 400px)', overflowY: 'auto' }}>
                {sessionDetail?.host ? (
                  <div style={{ marginBottom: 16 }}>
                    <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 8 }}>
                      Host
                    </p>
                    <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-text-primary)' }}>
                          @{sessionDetail.host.username || 'host'}
                        </p>
                        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--sec-accent)' }}>
                          R{Number(sessionDetail.host.amountPaid || 0).toFixed(0)}
                        </p>
                      </div>
                      <MenuItemsBlock items={sessionDetail.host.menuItems} />
                      <PaymentBreakdown participant={sessionDetail.host} />
                      <OrderFulfillControls
                        paystackReference={sessionDetail.host.paystackReference}
                        hasServeableOrder={sessionDetail.host.hasServeableOrder}
                        orderFulfilled={sessionDetail.host.orderFulfilled}
                        compact
                      />
                    </div>
                  </div>
                ) : null}
                {(sessionDetail?.members || []).length > 0 ? (
                  <div style={{ marginBottom: 16 }}>
                    <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 8 }}>
                      Joiners
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {sessionDetail.members.map((member, idx) => (
                        <div
                          key={`${member.user?.id || idx}`}
                          style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)' }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                            <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-text-primary)' }}>
                              @{member.user?.username || 'guest'}
                            </p>
                            <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--sec-accent)' }}>
                              R{Number(member.amountPaid || 0).toFixed(0)}
                            </p>
                          </div>
                          <MenuItemsBlock items={member.menuItems} />
                          <PaymentBreakdown participant={member} />
                          <OrderFulfillControls
                            paystackReference={member.paystackReference}
                            hasServeableOrder={member.hasServeableOrder}
                            orderFulfilled={member.orderFulfilled}
                            compact
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 10 }}>
                  Activity on this table
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(sessionDetail?.transactions || []).map((tx) => (
                    <div
                      key={tx.id}
                      style={{
                        padding: '12px 14px',
                        borderRadius: 12,
                        background: 'var(--sec-bg-card)',
                        border: '1px solid var(--sec-border)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                        <div style={{ minWidth: 0 }}>
                          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-text-primary)' }}>
                            {roleLabel(tx.role)}
                          </p>
                          <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                            @{tx.user?.username || 'guest'}
                          </p>
                          {tx.createdAt ? (
                            <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                              {format(parseISO(tx.createdAt), 'EEE d MMM yyyy · HH:mm')}
                            </p>
                          ) : null}
                          <MenuItemsBlock items={tx.menuItems} />
                          {(Number(tx.joinFeeZar) > 0 || Number(tx.menuZar) > 0) ? (
                            <p style={{ fontSize: 10, color: 'var(--sec-text-muted)', marginTop: 6 }}>
                              {Number(tx.joinFeeZar) > 0 ? `Join R${Number(tx.joinFeeZar).toFixed(0)}` : ''}
                              {Number(tx.joinFeeZar) > 0 && Number(tx.menuZar) > 0 ? ' · ' : ''}
                              {Number(tx.menuZar) > 0 ? `Menu R${Number(tx.menuZar).toFixed(0)}` : ''}
                            </p>
                          ) : null}
                          {tx.hasServeableOrder &&
                          tx.paystackReference &&
                          tx.paystackReference !== sessionDetail?.host?.paystackReference &&
                          !(sessionDetail?.members || []).some((m) => m.paystackReference === tx.paystackReference) ? (
                            <OrderFulfillControls
                              paystackReference={tx.paystackReference}
                              hasServeableOrder={tx.hasServeableOrder}
                              orderFulfilled={tx.orderFulfilled}
                              compact
                            />
                          ) : null}
                        </div>
                        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--sec-accent)', flexShrink: 0 }}>
                          R{Number(tx.lineTotalZar || 0).toFixed(0)}
                        </p>
                      </div>
                    </div>
                  ))}
                  {!sessionDetailLoading && !(sessionDetail?.transactions || []).length ? (
                    <p style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>No transactions recorded for this session.</p>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Ticket order detail */}
      <Dialog open={!!detailTicket} onOpenChange={() => setDetailTicket(null)}>
        <DialogContent className="sm:max-w-[480px] p-0 gap-0" style={dialogContentStyle}>
          {detailTicket && (
            <>
              <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--sec-border)' }}>
                <DialogHeader className="space-y-1 text-left">
                  <DialogTitle style={{ fontSize: 17, fontWeight: 700, color: 'var(--sec-text-primary)' }}>
                    Ticket order
                  </DialogTitle>
                  <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)', margin: '8px 0 0', lineHeight: 1.4 }}>
                    {detailTicket.event?.title}
                  </p>
                  {formatEventWhen(detailTicket.event) ? (
                    <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', margin: '6px 0 0' }}>
                      {formatEventWhen(detailTicket.event)}
                      {detailTicket.event?.city ? ` · ${detailTicket.event.city}` : ''}
                    </p>
                  ) : null}
                </DialogHeader>
                <div
                  style={{
                    marginTop: 16,
                    padding: '14px 16px',
                    borderRadius: 12,
                    background: 'var(--sec-accent-muted)',
                    border: '1px solid var(--sec-accent-border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <p style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--sec-text-muted)', margin: 0 }}>
                      Paid
                    </p>
                    <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--sec-accent)', margin: '4px 0 0' }}>
                      R{ticketPaidZar(detailTicket).toFixed(0)}
                    </p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', margin: 0 }}>{detailTicket.quantity} ticket{detailTicket.quantity === 1 ? '' : 's'}</p>
                    <p style={{ fontSize: 12, color: 'var(--sec-text-secondary)', margin: '4px 0 0' }}>@{detailTicket.purchaser?.username || 'guest'}</p>
                  </div>
                </div>
              </div>
              <div style={{ padding: '16px 20px' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 10,
                    marginBottom: detailTicket.fulfillmentPending || (detailTicket.tickets?.length > 0) ? 16 : 0,
                  }}
                >
                  <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)' }}>
                    <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', margin: 0 }}>Tier</p>
                    <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-text-primary)', margin: '6px 0 0', lineHeight: 1.4 }}>
                      {detailTicket.tierName}
                    </p>
                  </div>
                  <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)' }}>
                    <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', margin: 0 }}>Buyer</p>
                    <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--sec-text-primary)', margin: '6px 0 0' }}>
                      @{detailTicket.purchaser?.username || 'guest'}
                    </p>
                  </div>
                </div>
                <MenuItemsBlock items={detailTicket.menuAddons} />
                <OrderFulfillControls
                  paystackReference={detailTicket.paystackReference}
                  hasServeableOrder={detailTicket.hasServeableOrder}
                  orderFulfilled={detailTicket.orderFulfilled}
                />
                {detailTicket.fulfillmentPending ? (
                  <p
                    style={{
                      fontSize: 12,
                      color: 'var(--sec-text-secondary)',
                      borderRadius: 12,
                      border: '1px solid var(--sec-accent-border)',
                      background: 'var(--sec-accent-muted)',
                      padding: '10px 12px',
                      marginBottom: 16,
                      lineHeight: 1.5,
                    }}
                  >
                    Payment received — ticket QR codes are still being prepared. Refresh this page in a moment.
                  </p>
                ) : null}
                {detailTicket.tickets?.length > 0 ? (
                  <div>
                    <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--sec-text-muted)', marginBottom: 10 }}>
                      Ticket holders
                    </p>
                    <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' }}>
                      {detailTicket.tickets.map((t, index) => (
                        <li
                          key={t.id}
                          style={{
                            padding: '10px 12px',
                            borderRadius: 10,
                            background: 'var(--sec-bg-card)',
                            border: '1px solid var(--sec-border)',
                            fontSize: 13,
                            color: 'var(--sec-text-primary)',
                          }}
                        >
                          <span style={{ color: 'var(--sec-text-muted)', marginRight: 8 }}>{index + 1}.</span>
                          {t.holderDisplayName || 'Guest'}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {detailTicket.paystackReference ? (
                  <p style={{ fontSize: 11, color: 'var(--sec-text-muted)', marginTop: 16, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    Ref: {detailTicket.paystackReference}
                  </p>
                ) : null}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
