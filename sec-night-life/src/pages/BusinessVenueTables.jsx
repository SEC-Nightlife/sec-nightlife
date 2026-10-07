import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createPageUrl } from '@/utils';
import { apiGet, apiPost, apiPatch } from '@/api/client';
import { toast } from 'sonner';
import { Plus, Armchair, Settings, Loader2, Users, UserCheck, Trash2, ChevronDown, ChevronRight, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import TableTierEditor from '@/components/business/TableTierEditor';
import ServiceWeekdayPicker from '@/components/business/ServiceWeekdayPicker';
import FeedBoostDialog, { maxBoostDaysUntil } from '@/components/business/FeedBoostDialog';
import { resolveTierFeesForSave } from '@/lib/tierBookingFees';
import { resolveTierMinSpends } from '@/lib/tierMinSpend';
import { emptyServiceScheduleMap, scheduleMapFromApi, scheduleMapToApi, formatServiceScheduleSummary } from '@/lib/serviceSchedule';
import { parseDayTierIndex, countTierSlotsInList, totalSpotsForTier, groupDayTablesByTier } from '@/lib/dayListingTiers';
import { LayoutGrid } from 'lucide-react';
import { VENUE_DECLINE_TEMPLATES, formatMenuLines } from '@/lib/venueTableMessageTemplates';
import PageBackHeader from '@/components/layout/PageBackHeader';
import { useActiveVenue } from '@/context/ActiveVenueContext';
import { useBusinessVenueScope } from '@/hooks/useBusinessVenueScope';
import VenueSwitcher from '@/components/business/VenueSwitcher';
import { businessVenueQuery } from '@/lib/businessVenueQuery';
import { menuApiBase } from '@/lib/staffVenueApi';
import { launchPaystackInline, loadPaystackScript } from '@/lib/paystackInline';
import { completePaystackCheckout } from '@/lib/completePaystackCheckout';
import * as authService from '@/services/authService';

export default function BusinessVenueTables() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState(
    ['listings', 'requests', 'settings'].includes(initialTab) ? initialTab : 'listings',
  );

  useEffect(() => {
    const q = searchParams.get('tab');
    if (q && ['listings', 'requests', 'settings'].includes(q) && q !== tab) setTab(q);
  }, [searchParams]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    description: '',
    serviceDays: emptyServiceScheduleMap(),
    allowsCustomRequests: false,
    tiers: [{ tier_name: 'Standard', max_guests: '6', min_spend: '2000', booking_fee_zar: '200', tier_table_slots: '1', table_category: 'general', included_items: [] }],
  });
  const [declineTemplatesByMember, setDeclineTemplatesByMember] = useState({});
  const [declineParamsByMember, setDeclineParamsByMember] = useState({});
  const [venueFees, setVenueFees] = useState({
    host_table_fee_zar: '',
    custom_table_booking_fee_zar: '',
    max_booking_duration_hours: '',
  });
  const [actionTableId, setActionTableId] = useState(null);
  const [boostTarget, setBoostTarget] = useState(null);
  const [boostBusy, setBoostBusy] = useState(false);
  const [userEmail, setUserEmail] = useState('');

  useEffect(() => {
    loadPaystackScript().catch(() => {});
    authService.getCurrentUser().then((u) => {
      if (u?.email) setUserEmail(u.email);
    }).catch(() => {});
  }, []);
  const [editingTableId, setEditingTableId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [expandedTierKey, setExpandedTierKey] = useState(null);

  const { activeVenue } = useActiveVenue();
  const venueScope = useBusinessVenueScope();
  const hasVenueScope = venueScope.inStaffSession || !!activeVenue?.id;
  const scopeKey = venueScope.staffContextToken || activeVenue?.id;
  const scopeQs = businessVenueQuery({
    staffCtx: venueScope.staffContextToken,
    venueId: venueScope.inStaffSession ? null : activeVenue?.id,
  });
  const menuBase = menuApiBase({
    inStaffSession: venueScope.inStaffSession,
    staffContextToken: venueScope.staffContextToken,
    venueId: activeVenue?.id,
  });

  const { data: dayTablesData, isLoading, refetch: refetchDayTables } = useQuery({
    queryKey: ['biz-day-venue-tables', scopeKey],
    queryFn: () => apiGet(`/api/business/day-venue-tables?${scopeQs}`),
    enabled: hasVenueScope && !!scopeQs,
  });

  const venueId = dayTablesData?.venue?.id || (venueScope.inStaffSession ? null : activeVenue?.id);
  const venue = venueId
    ? {
        id: venueId,
        name: dayTablesData?.venue?.name || venueScope.venueName || activeVenue?.name,
      }
    : null;

  const invalidateGuestBookCaches = useCallback(() => {
    if (!venueId) return;
    qc.invalidateQueries({ queryKey: ['venue-day-table-tiers', venueId] });
    qc.invalidateQueries({ queryKey: ['venue', venueId] });
    qc.invalidateQueries({ queryKey: ['venue-table'] });
  }, [qc, venueId]);

  const { data: venueDetailFromApi } = useQuery({
    queryKey: ['venue-detail', venueId],
    queryFn: () => apiGet(`/api/venues/${venueId}`),
    enabled: !!venueId && !venueScope.inStaffSession,
  });

  const venueDetail = venueScope.inStaffSession
    ? dayTablesData?.venue || null
    : venueDetailFromApi;

  const { data: menuItems = [] } = useQuery({
    queryKey: ['venue-menu-biz', scopeKey],
    queryFn: () => apiGet(menuBase ? `${menuBase}/menu-items` : `/api/business/venues/${venueId}/menu-items`),
    enabled: !!menuBase || (!!venueId && !venueScope.inStaffSession),
  });

  const dayTables = dayTablesData?.items || [];
  const dayTablesSummary = dayTablesData?.summary;
  const tierGroups = useMemo(() => groupDayTablesByTier(dayTables), [dayTables]);
  const customListing = dayTables.find((t) => t.isCustomListing);

  async function hideTableFromListings(tableId) {
    if (!window.confirm('Remove this table from guest listings? Guests already on this table are not affected.')) return;
    setActionTableId(tableId);
    try {
      await apiPost(`/api/business/venue-tables/${tableId}/hide-from-listings`);
      toast.success('Removed from listings');
      refetchDayTables();
      qc.invalidateQueries({ queryKey: ['biz-venue-tables'] });
    } catch (e) {
      toast.error(e?.data?.error || e.message || 'Could not hide table');
    } finally {
      setActionTableId(null);
    }
  }

  async function restoreTableToListings(tableId) {
    setActionTableId(tableId);
    try {
      await apiPost(`/api/business/venue-tables/${tableId}/restore-to-listings`);
      toast.success('Restored to listings');
      refetchDayTables();
      qc.invalidateQueries({ queryKey: ['biz-venue-tables'] });
    } catch (e) {
      toast.error(e?.data?.error || e.message || 'Could not restore table');
    } finally {
      setActionTableId(null);
    }
  }

  async function resetTableForRelisting(tableId) {
    if (
      !window.confirm(
        'End this table session and make the slot available for new bookings? Current guests\' table QRs will no longer admit. Past payments stay in Bookings & Analytics.',
      )
    ) {
      return;
    }
    setActionTableId(tableId);
    try {
      await apiPost(`/api/business/venue-tables/${tableId}/release`);
      toast.success('Table reset — slot is available for new bookings');
      refetchDayTables();
      qc.invalidateQueries({ queryKey: ['biz-venue-tables'] });
      qc.invalidateQueries({ queryKey: ['biz-venue-table-bookings'] });
    } catch (e) {
      toast.error(e?.data?.error || e.message || 'Could not reset table');
    } finally {
      setActionTableId(null);
    }
  }

  const { data: reservations } = useQuery({
    queryKey: ['biz-venue-reservations', scopeKey],
    queryFn: () => apiGet(`/api/business/venue-table-reservations?status=pending&${scopeQs}`),
    enabled: hasVenueScope && !!scopeQs,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const serviceSchedule = scheduleMapToApi(form.serviceDays);
      if (!serviceSchedule.length) throw new Error('Select at least one day of the week');
      const tiers = form.tiers.map((tier) => {
        if (!tier.tier_name?.trim()) throw new Error('Each tier needs a name');
        const fees = resolveTierFeesForSave(tier);
        const spends = resolveTierMinSpends(tier);
        return {
          tier_name: tier.tier_name.trim(),
          max_guests: parseInt(tier.max_guests, 10) || 6,
          min_spend: spends.min_spend_join,
          min_spend_join: spends.min_spend_join,
          min_spend_host: spends.min_spend_host,
          booking_fee_zar: fees.booking_fee_zar,
          host_table_fee_zar: fees.host_table_fee_zar,
          tier_table_slots: parseInt(tier.tier_table_slots, 10) || 1,
          table_category: String(tier.table_category || 'general').toLowerCase() === 'vip' ? 'vip' : 'general',
          included_items: tier.included_items || [],
        };
      });
      await apiPost('/api/venue-tables/sync-day-listings', {
        venueId,
        description: form.description || null,
        serviceSchedule,
        allowsCustomRequests: false,
        tiers,
      });
    },
    onSuccess: () => {
      toast.success('Listing(s) created');
      qc.invalidateQueries({ queryKey: ['biz-day-venue-tables'] });
      qc.invalidateQueries({ queryKey: ['biz-venue-tables'] });
      invalidateGuestBookCaches();
      setShowForm(false);
    },
    onError: (e) => toast.error(e?.message || e?.data?.error || 'Could not create'),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ tableId, payload }) => apiPatch(`/api/venue-tables/${tableId}`, payload),
    onSuccess: () => {
      toast.success('Listing updated');
      qc.invalidateQueries({ queryKey: ['biz-day-venue-tables'] });
      qc.invalidateQueries({ queryKey: ['biz-venue-tables'] });
      invalidateGuestBookCaches();
      setEditingTableId(null);
      setEditForm(null);
    },
    onError: (e) => toast.error(e?.data?.error || e?.message || 'Could not update listing'),
  });

  const startEditListing = (table) => {
    const tierIndex = parseDayTierIndex(table.hostingTierKey);
    const tierTableSlots =
      tierIndex != null ? countTierSlotsInList(dayTables, tierIndex) : 1;
    setEditingTableId(table.id);
    setEditForm({
      tierIndex,
      tierTableSlots: String(tierTableSlots),
      tableName: table.tableName?.replace(/\s#\d+$/, '') || table.tierLabel || '',
      description: table.description || '',
      guestCapacity: String(table.guestCapacity ?? 6),
      minimumSpend: String(table.minimumSpend ?? 0),
      hostMinimumSpend: String(table.hostMinimumSpend ?? table.minimumSpend ?? 0),
      bookingFeeZar: String(table.bookingFeeZar ?? 0),
      hostTableFeeZar: String(table.hostTableFeeZar ?? 0),
      tableCategory: table.tableCategory === 'vip' ? 'vip' : 'general',
      serviceDays: scheduleMapFromApi(table.serviceSchedule),
      allowsCustomRequests: Boolean(table.allowsCustomRequests),
    });
  };

  const submitEditListing = async (e) => {
    e.preventDefault();
    if (!editingTableId || !editForm) return;
    const serviceSchedule = scheduleMapToApi(editForm.serviceDays);
    if (!serviceSchedule.length) {
      toast.error('Select at least one day of the week');
      return;
    }
    try {
      if (editForm.tierIndex != null) {
        await apiPost('/api/venue-tables/adjust-day-tier', {
          venueId,
          tierIndex: editForm.tierIndex,
          tierTableSlots: parseInt(editForm.tierTableSlots, 10) || 1,
          tableName: editForm.tableName.trim(),
          description: editForm.description.trim() || null,
          guestCapacity: parseInt(editForm.guestCapacity, 10) || 6,
          minimumSpend: parseFloat(editForm.minimumSpend) || 0,
          hostMinimumSpend: parseFloat(editForm.hostMinimumSpend) || 0,
          bookingFeeZar: parseFloat(editForm.bookingFeeZar) || 0,
          hostTableFeeZar: parseFloat(editForm.hostTableFeeZar) || 0,
          table_category: editForm.tableCategory === 'vip' ? 'vip' : 'general',
          serviceSchedule,
        });
        toast.success('Listing updated');
        await refetchDayTables();
        qc.invalidateQueries({ queryKey: ['biz-day-venue-tables'] });
        qc.invalidateQueries({ queryKey: ['biz-venue-tables'] });
        invalidateGuestBookCaches();
        setEditingTableId(null);
        setEditForm(null);
      } else {
        updateMutation.mutate({
          tableId: editingTableId,
          payload: {
            tableName: editForm.tableName.trim(),
            description: editForm.description.trim() || null,
            guestCapacity: parseInt(editForm.guestCapacity, 10) || 6,
            minimumSpend: parseFloat(editForm.minimumSpend) || 0,
            hostMinimumSpend: parseFloat(editForm.hostMinimumSpend) || 0,
            bookingFeeZar: parseFloat(editForm.bookingFeeZar) || 0,
            hostTableFeeZar: parseFloat(editForm.hostTableFeeZar) || 0,
            serviceSchedule,
            serviceDate: null,
            serviceEndDate: null,
            startTime: null,
            endTime: null,
            allowsCustomRequests: editForm.allowsCustomRequests,
            tierLabel: editForm.tableName.trim(),
          },
        });
      }
    } catch (err) {
      toast.error(err?.data?.error || err.message || 'Could not update listing');
    }
  };

  const deleteTierListing = async (tierIndex) => {
    const idx = tierIndex ?? editForm?.tierIndex;
    if (idx == null || !venueId) return;
    if (
      !window.confirm(
        'Delete this tier and all its table slots? Empty slots are removed permanently. You must reset any in-use tables first.',
      )
    ) {
      return;
    }
    try {
      await apiPost('/api/venue-tables/delete-day-tier', {
        venueId,
        tierIndex: idx,
      });
      toast.success('Tier deleted');
      qc.invalidateQueries({ queryKey: ['biz-day-venue-tables'] });
      qc.invalidateQueries({ queryKey: ['biz-venue-tables'] });
      invalidateGuestBookCaches();
      setEditingTableId(null);
      setEditForm(null);
    } catch (err) {
      toast.error(err?.data?.error || err.message || 'Could not delete tier');
    }
  };

  const reviewMutation = useMutation({
    mutationFn: ({ tableId, memberId, action, declineTemplateKeys, declineParams }) =>
      apiPatch(`/api/venue-tables/${tableId}/reservations/${memberId}`, {
        action,
        declineTemplateKeys: action === 'decline' ? declineTemplateKeys : undefined,
        declineParams: action === 'decline' ? declineParams : undefined,
      }),
    onSuccess: () => {
      toast.success('Updated');
      qc.invalidateQueries({ queryKey: ['biz-venue-reservations'] });
    },
    onError: (e) => toast.error(e?.data?.error || e.message),
  });

  const saveVenueFlags = useMutation({
    mutationFn: (accepts) => apiPatch(`/api/venues/${venueId}`, { accepts_day_bookings: accepts }),
    onSuccess: () => {
      toast.success('Venue settings saved');
      qc.invalidateQueries({ queryKey: ['venue-detail', venueId] });
      qc.invalidateQueries({ queryKey: ['biz-day-venue-tables', scopeKey] });
      invalidateGuestBookCaches();
    },
    onError: (e) => toast.error(e?.data?.error || e.message),
  });

  const saveSeatingPlanDay = useMutation({
    mutationFn: (enabled) =>
      apiPatch(`/api/venues/${venueId}`, { show_seating_plan_for_day_bookings: enabled }),
    onSuccess: () => {
      toast.success('Seating plan setting saved');
      qc.invalidateQueries({ queryKey: ['venue-detail', venueId] });
      qc.invalidateQueries({ queryKey: ['biz-day-venue-tables', scopeKey] });
      invalidateGuestBookCaches();
    },
    onError: (e) => toast.error(e?.data?.error || e.message),
  });

  const { data: seatingPlansData } = useQuery({
    queryKey: ['venue-seating-plans', scopeKey],
    queryFn: () => apiGet(`/api/business/venue-seating-plans?${scopeQs}`),
    enabled: hasVenueScope && !!scopeQs,
  });
  const seatingPlanCount = seatingPlansData?.items?.length ?? 0;

  const saveVenueFees = useMutation({
    mutationFn: () => {
      const rawMax = String(venueFees.max_booking_duration_hours ?? '').trim();
      const max_booking_duration_hours =
        rawMax === '' ? null : Math.max(1, parseInt(rawMax, 10) || 1);
      return apiPatch(`/api/venues/${venueId}`, {
        host_table_fee_zar: parseFloat(venueFees.host_table_fee_zar) || 0,
        custom_table_booking_fee_zar: parseFloat(venueFees.custom_table_booking_fee_zar) || 0,
        max_booking_duration_hours,
      });
    },
    onSuccess: () => {
      toast.success('Fees saved');
      qc.invalidateQueries({ queryKey: ['venue-detail', venueId] });
      qc.invalidateQueries({ queryKey: ['biz-day-venue-tables', scopeKey] });
      invalidateGuestBookCaches();
    },
    onError: (e) => toast.error(e?.data?.error || e.message),
  });

  useEffect(() => {
    if (venueDetail) {
      setVenueFees({
        host_table_fee_zar: String(venueDetail.host_table_fee_zar ?? ''),
        custom_table_booking_fee_zar: String(venueDetail.custom_table_booking_fee_zar ?? ''),
        max_booking_duration_hours:
          venueDetail.max_booking_duration_hours != null
            ? String(venueDetail.max_booking_duration_hours)
            : '',
      });
    }
  }, [
    venueDetail?.id,
    venueDetail?.host_table_fee_zar,
    venueDetail?.custom_table_booking_fee_zar,
    venueDetail?.max_booking_duration_hours,
  ]);

  async function setCustomRequestsEnabled(enabled) {
    if (!venueId) return;
    setActionTableId('custom-requests');
    try {
      if (enabled) {
        await apiGet(
          `/api/venue-tables/day-custom-listing?venueId=${encodeURIComponent(venueId)}`,
        );
        toast.success('Custom table requests enabled');
      } else if (customListing?.id) {
        await apiPost(`/api/business/venue-tables/${customListing.id}/hide-from-listings`);
        toast.success('Custom table requests disabled');
      }
      refetchDayTables();
      qc.invalidateQueries({ queryKey: ['biz-venue-tables'] });
    } catch (e) {
      toast.error(e?.data?.error || e.message || 'Could not update custom requests');
    } finally {
      setActionTableId(null);
    }
  }

  if (!hasVenueScope) {
    return (
      <div className="sec-page flex flex-col items-center justify-center min-h-[50vh] px-6 text-center">
        <Armchair size={40} className="mb-4 opacity-40" />
        <h2 className="text-lg font-semibold mb-2">No venue yet</h2>
        <p className="text-sm text-[var(--sec-text-muted)] mb-6">Register your venue to manage tables and day bookings.</p>
        <Button onClick={() => navigate(createPageUrl('VenueOnboarding'))}>Register venue</Button>
      </div>
    );
  }

  if (!venueId && isLoading) {
    return (
      <div className="sec-page flex items-center justify-center min-h-[50vh]">
        <Loader2 className="animate-spin" style={{ color: 'var(--sec-accent)' }} />
      </div>
    );
  }

  if (!venueId) {
    return (
      <div className="sec-page flex flex-col items-center justify-center min-h-[50vh] px-6 text-center">
        <Armchair size={40} className="mb-4 opacity-40" />
        <h2 className="text-lg font-semibold mb-2">Venue unavailable</h2>
        <p className="text-sm text-[var(--sec-text-muted)] mb-6">
          Could not load this venue for tables & day bookings.
        </p>
      </div>
    );
  }

  const renderSlotRow = (t) => {
    const statusColor = t.inUse
      ? 'var(--sec-accent)'
      : t.isActive
        ? '#34d399'
        : '#9ca3af';
    return (
      <div
        key={t.id}
        className="rounded-xl border p-3"
        style={{
          borderColor: t.inUse ? 'var(--sec-accent-border)' : 'var(--sec-border)',
          background: 'var(--sec-bg-elevated)',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">{t.tableName}</p>
            {t.hostLabel ? (
              <p className="text-xs mt-1 inline-flex items-center gap-1 text-[var(--sec-text-muted)]">
                <UserCheck size={12} style={{ color: 'var(--sec-accent)' }} />
                Host: {t.hostLabel}
              </p>
            ) : null}
            {(t.tableSessionNumber ?? 1) > 1 ? (
              <p className="text-[10px] text-[var(--sec-text-muted)] mt-1">Session {t.tableSessionNumber}</p>
            ) : null}
          </div>
          <span
            className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full shrink-0"
            style={{
              color: statusColor,
              background: `${statusColor}18`,
              border: `1px solid ${statusColor}44`,
            }}
          >
            {t.inUse ? 'In use' : t.isActive ? 'Available' : 'Hidden'}
          </span>
        </div>
        {t.inUse ? (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="inline-flex items-center gap-1.5 text-[var(--sec-text-secondary)]">
                <Users size={13} style={{ color: 'var(--sec-accent)' }} />
                {t.usageLabel}
              </span>
              <span className="text-[var(--sec-text-muted)]">{t.spotsRemaining ?? 0} spots left</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${t.fillPercent ?? 0}%`,
                  background: 'linear-gradient(90deg, var(--sec-accent), #e8c547)',
                }}
              />
            </div>
          </div>
        ) : (
          <p className="text-xs mt-2 text-[var(--sec-text-muted)]">{t.usageLabel}</p>
        )}
        {(t.canResetTable || t.canHideFromListings || t.canRestoreToListings) ? (
          <div className="mt-3 flex justify-end gap-2 flex-wrap">
            {t.canResetTable ? (
              <Button
                size="sm"
                className="h-8 text-xs sec-btn-secondary"
                disabled={actionTableId === t.id}
                onClick={() => resetTableForRelisting(t.id)}
              >
                {actionTableId === t.id ? <Loader2 size={14} className="animate-spin" /> : 'Reset table'}
              </Button>
            ) : null}
            {t.canHideFromListings ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actionTableId === t.id}
                className="h-8 text-xs"
                style={{ borderColor: 'var(--sec-border)' }}
                onClick={() => hideTableFromListings(t.id)}
              >
                {actionTableId === t.id ? <Loader2 size={14} className="animate-spin" /> : 'Remove from listings'}
              </Button>
            ) : (
              t.canRestoreToListings ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionTableId === t.id}
                  className="h-8 text-xs"
                  style={{ borderColor: 'var(--sec-accent-border)', color: 'var(--sec-accent)' }}
                  onClick={() => restoreTableToListings(t.id)}
                >
                  Restore to listings
                </Button>
              ) : null
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const pending = reservations?.items || [];
  const dayBookingsOn = Boolean(venueDetail?.accepts_day_bookings);
  const seatingPlanDayOn = Boolean(venueDetail?.show_seating_plan_for_day_bookings);
  const customRequestsOn = Boolean(customListing?.isActive);

  return (
    <div className="sec-page max-w-3xl mx-auto pb-28">
      <PageBackHeader
        title="Tables & day bookings"
        subtitle="Venue listings for any day or synced from published events"
        pageName="BusinessVenueTables"
      />
      <div className="px-4 pt-4">

      {!venueScope.inStaffSession ? (
        <div className="mb-4">
          <VenueSwitcher />
        </div>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v);
          setSearchParams({ tab: v });
        }}
      >
        <TabsList className="grid w-full grid-cols-3 mb-6">
          <TabsTrigger value="listings">Listings</TabsTrigger>
          <TabsTrigger value="requests">Requests{pending.length > 0 ? ` (${pending.length})` : ''}</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="listings" className="space-y-4">
          <p className="text-sm text-[var(--sec-text-muted)] leading-relaxed">
            Manage day listings — hide empty slots from guest browse, or reset in-use tables so new guests can book again during the same service window.
          </p>

          {dayTablesSummary ? (
            <div className="flex flex-wrap gap-2">
              {[
                ['In use', dayTablesSummary.inUse, 'var(--sec-accent)'],
                ['Available', dayTablesSummary.available, '#34d399'],
                ['Hidden', dayTablesSummary.hidden, '#9ca3af'],
              ].map(([label, count, color]) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border border-[var(--sec-border)]"
                  style={{ background: 'var(--sec-bg-elevated)', color }}
                >
                  {label}: {count}
                </span>
              ))}
            </div>
          ) : null}

          <Button className="sec-btn sec-btn-primary" onClick={() => setShowForm((v) => !v)}>
            <Plus size={16} className="mr-2" /> New day listing
          </Button>

          {showForm && (
            <form
              className="sec-card p-5 space-y-4 border border-[var(--sec-border)]"
              onSubmit={(e) => {
                e.preventDefault();
                createMutation.mutate();
              }}
            >
              <Label>Description (optional)</Label>
              <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
              <ServiceWeekdayPicker
                value={form.serviceDays}
                onChange={(serviceDays) => setForm((f) => ({ ...f, serviceDays }))}
              />
              <div>
                <p className="text-sm font-semibold text-[var(--sec-text-primary)] mb-2">Table tiers</p>
                <p className="text-xs text-[var(--sec-text-muted)] mb-3">
                  Define each tier guests can host or join. Set how many identical tables are available per tier.
                </p>
                <TableTierEditor
                  tiers={form.tiers}
                  onChange={(tiers) => setForm((f) => ({ ...f, tiers }))}
                  venueMenuItems={menuItems}
                  showSlots
                />
              </div>
              <Button type="submit" disabled={createMutation.isPending} className="w-full sec-btn-primary">
                {createMutation.isPending ? 'Creating…' : 'Create listings'}
              </Button>
            </form>
          )}

          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="animate-spin" /></div>
          ) : tierGroups.length === 0 ? (
            <div className="sec-card p-8 text-center text-sm text-[var(--sec-text-muted)]">
              No day listings yet. Add a listing above, or enable day bookings in Settings.
            </div>
          ) : (
            <div className="space-y-3">
              {tierGroups.map((group) => {
                const sample = group.sample;
                const scheduleLabel = formatServiceScheduleSummary(sample?.serviceSchedule)
                  || (sample?.serviceDate
                    ? `${new Date(sample.serviceDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}${sample.startTime ? ` · ${sample.startTime}` : ''}${sample.endTime ? `–${sample.endTime}` : ''}`
                    : null);
                const expanded = expandedTierKey === group.key;
                const tierStatusColor = group.inUseCount > 0
                  ? 'var(--sec-accent)'
                  : group.availableCount > 0
                    ? '#34d399'
                    : '#9ca3af';
                const statusParts = [];
                if (group.inUseCount > 0) statusParts.push(`${group.inUseCount} in use`);
                if (group.availableCount > 0) statusParts.push(`${group.availableCount} available`);
                if (group.hiddenCount > 0) statusParts.push(`${group.hiddenCount} hidden`);

                return (
                  <div
                    key={group.key}
                    className="sec-card overflow-hidden border"
                    style={{
                      borderColor: group.inUseCount > 0 ? 'var(--sec-accent-border)' : 'var(--sec-border)',
                    }}
                  >
                    <button
                      type="button"
                      className="w-full p-4 text-left"
                      onClick={() => setExpandedTierKey(expanded ? null : group.key)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            {expanded ? (
                              <ChevronDown size={16} className="shrink-0 text-[var(--sec-text-muted)]" />
                            ) : (
                              <ChevronRight size={16} className="shrink-0 text-[var(--sec-text-muted)]" />
                            )}
                            <p className="font-semibold text-sm">{group.tierName}</p>
                            {sample?.tableCategory === 'vip' ? (
                              <span
                                className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                                style={{
                                  color: 'var(--sec-accent)',
                                  background: 'var(--sec-accent-muted)',
                                  border: '1px solid var(--sec-accent-border)',
                                }}
                              >
                                VIP
                              </span>
                            ) : null}
                          </div>
                          <p className="text-xs text-[var(--sec-text-muted)] mt-1 ml-6">
                            {group.tableCount} table{group.tableCount === 1 ? '' : 's'}
                            {scheduleLabel ? ` · ${scheduleLabel}` : ''}
                            {' · '}Min R{Number(sample?.minimumSpend || 0).toFixed(0)}
                            {' · '}Join fee R{Number(sample?.bookingFeeZar || 0).toFixed(0)}
                            {' · '}Host fee R{Number(sample?.hostTableFeeZar || 0).toFixed(0)}
                          </p>
                          <p className="text-xs text-[var(--sec-text-muted)] mt-1 ml-6">
                            {statusParts.join(' · ') || 'No tables'}
                          </p>
                        </div>
                        <span
                          className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full shrink-0"
                          style={{
                            color: tierStatusColor,
                            background: `${tierStatusColor}18`,
                            border: `1px solid ${tierStatusColor}44`,
                          }}
                        >
                          {group.inUseCount > 0 ? 'In use' : group.availableCount > 0 ? 'Available' : 'Hidden'}
                        </span>
                      </div>
                    </button>

                    {expanded ? (
                      <div
                        className="px-4 pb-4 border-t space-y-3"
                        style={{ borderColor: 'var(--sec-border)', background: 'rgba(0,0,0,0.15)' }}
                      >
                        <div className="flex justify-end gap-2 flex-wrap pt-3">
                          {(() => {
                            const boostable =
                              group.tables.find((t) => t.isActive && !t.isCustomListing) || sample;
                            const anyBoosted = group.tables.some((t) => t.boosted);
                            if (!boostable?.id || !boostable.isActive) return null;
                            return (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs"
                                style={{
                                  borderColor: anyBoosted ? 'var(--sec-warning)' : 'var(--sec-border)',
                                  color: anyBoosted ? 'var(--sec-warning)' : undefined,
                                }}
                                onClick={() =>
                                  setBoostTarget({
                                    tableId: boostable.id,
                                    name: group.tierName,
                                    endAt:
                                      boostable.serviceEndDate ||
                                      boostable.serviceDate ||
                                      null,
                                  })
                                }
                              >
                                <Zap size={12} className="mr-1" />
                                {anyBoosted ? 'Extend boost' : 'Boost in feed'}
                              </Button>
                            );
                          })()}
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs"
                            style={{ borderColor: 'var(--sec-border)' }}
                            onClick={() => startEditListing(sample)}
                          >
                            Edit tier
                          </Button>
                          {group.canDeleteTier ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs text-red-400 border-red-400/40"
                              onClick={() => deleteTierListing(group.tierIndex)}
                            >
                              <Trash2 size={12} className="mr-1" />
                              Delete tier
                            </Button>
                          ) : null}
                        </div>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--sec-text-muted)]">
                          Tables in this tier
                        </p>
                        {group.tables.map((t) => renderSlotRow(t))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {editingTableId && editForm ? (
            <form
              className="sec-card p-5 space-y-4 border border-[var(--sec-accent-border)]"
              onSubmit={submitEditListing}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-sm">Edit listing</h3>
                <button
                  type="button"
                  className="text-xs text-[var(--sec-text-muted)]"
                  onClick={() => {
                    setEditingTableId(null);
                    setEditForm(null);
                  }}
                >
                  Cancel
                </button>
              </div>
              <div>
                <Label>Table name</Label>
                <Input
                  value={editForm.tableName}
                  onChange={(e) => setEditForm((f) => ({ ...f, tableName: e.target.value }))}
                  required
                />
              </div>
              <div>
                <Label>Description</Label>
                <Input
                  value={editForm.description}
                  onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>
              {editForm.tierIndex != null ? (
                <div>
                  <Label>Table type</Label>
                  <div className="flex gap-2 mt-1">
                    <button
                      type="button"
                      className="h-9 flex-1 rounded-lg text-xs font-semibold border"
                      style={{
                        borderColor:
                          (editForm.tableCategory || 'general') === 'general'
                            ? 'var(--sec-accent-border)'
                            : 'var(--sec-border)',
                        background:
                          (editForm.tableCategory || 'general') === 'general'
                            ? 'var(--sec-accent-muted)'
                            : 'transparent',
                        color: 'var(--sec-text-primary)',
                      }}
                      onClick={() => setEditForm((f) => ({ ...f, tableCategory: 'general' }))}
                    >
                      General
                    </button>
                    <button
                      type="button"
                      className="h-9 flex-1 rounded-lg text-xs font-semibold border"
                      style={{
                        borderColor:
                          editForm.tableCategory === 'vip' ? 'var(--sec-accent-border)' : 'var(--sec-border)',
                        background:
                          editForm.tableCategory === 'vip' ? 'var(--sec-accent-muted)' : 'transparent',
                        color: 'var(--sec-text-primary)',
                      }}
                      onClick={() => setEditForm((f) => ({ ...f, tableCategory: 'vip' }))}
                    >
                      VIP
                    </button>
                  </div>
                </div>
              ) : null}
              <ServiceWeekdayPicker
                value={editForm.serviceDays}
                onChange={(serviceDays) => setEditForm((f) => ({ ...f, serviceDays }))}
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Join min spend (R)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={editForm.minimumSpend}
                    onChange={(e) => setEditForm((f) => ({ ...f, minimumSpend: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>Host min spend (R)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={editForm.hostMinimumSpend}
                    onChange={(e) => setEditForm((f) => ({ ...f, hostMinimumSpend: e.target.value }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Join fee (R)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={editForm.bookingFeeZar}
                    onChange={(e) => setEditForm((f) => ({ ...f, bookingFeeZar: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>Host fee (R)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={editForm.hostTableFeeZar}
                    onChange={(e) => setEditForm((f) => ({ ...f, hostTableFeeZar: e.target.value }))}
                  />
                </div>
              </div>
              <div>
                <Label>Max guests per table</Label>
                <Input
                  type="number"
                  min={1}
                  value={editForm.guestCapacity}
                  onChange={(e) => setEditForm((f) => ({ ...f, guestCapacity: e.target.value }))}
                />
              </div>
              {editForm.tierIndex != null ? (
                <div
                  className="rounded-lg border p-3 space-y-2"
                  style={{ borderColor: 'var(--sec-accent-border)', background: 'var(--sec-accent-muted)' }}
                >
                  <div className="flex items-start gap-2">
                    <LayoutGrid size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--sec-accent)' }} />
                    <div className="flex-1">
                      <Label className="text-sm font-semibold text-[var(--sec-text-primary)]">
                        Tables available to host / join
                      </Label>
                      <p className="text-[11px] text-[var(--sec-text-muted)] mt-0.5">
                        How many identical tables of this tier guests can book. One host per table; joiners fill remaining spots.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <Input
                      type="number"
                      min={1}
                      max={50}
                      value={editForm.tierTableSlots}
                      onChange={(e) => setEditForm((f) => ({ ...f, tierTableSlots: e.target.value }))}
                      className="h-10 w-24 text-center font-semibold"
                    />
                    <span className="text-xs text-[var(--sec-text-secondary)]">
                      {totalSpotsForTier(editForm.tierTableSlots, editForm.guestCapacity)} total guest spots
                      ({editForm.tierTableSlots || 1} × {editForm.guestCapacity || 6})
                    </span>
                  </div>
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <Button type="submit" disabled={updateMutation.isPending} className="w-full sec-btn-primary">
                  {updateMutation.isPending ? 'Saving…' : 'Save changes'}
                </Button>
                {editForm.tierIndex != null ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full text-red-400 border-red-400/40 hover:bg-red-400/10"
                    onClick={() => deleteTierListing()}
                  >
                    <Trash2 size={14} className="mr-2" />
                    Delete tier
                  </Button>
                ) : null}
              </div>
            </form>
          ) : null}
        </TabsContent>

        <TabsContent value="requests">
          {pending.length === 0 ? (
            <p className="text-sm text-center text-[var(--sec-text-muted)] py-8">No pending table requests.</p>
          ) : (
            <div className="space-y-3">
              {pending.map((r) => {
                const specs = r.userSpecs || {};
                const menuLines = formatMenuLines(
                  specs.selectedMenuItems || r.selectedMenuItems,
                  menuItems,
                );
                const menuTotal = menuLines.reduce((s, l) => s + l.lineTotal, 0);
                const minSpend =
                  specs.proposedMinimumSpend != null
                    ? Number(specs.proposedMinimumSpend)
                    : menuTotal > 0
                      ? menuTotal
                      : null;
                return (
                  <div
                    key={r.id}
                    className="sec-card p-5 border border-[var(--sec-border)]"
                    style={{ background: 'linear-gradient(180deg, #121214 0%, #0a0a0b 100%)' }}
                  >
                    <div className="flex justify-between items-start gap-3 mb-3">
                      <div>
                        <p className="font-semibold text-base">{r.table?.tableName || 'Custom table request'}</p>
                        <p className="text-xs text-[var(--sec-text-muted)] mt-0.5">
                          @{r.user?.username || r.user?.fullName || 'guest'}
                        </p>
                      </div>
                      {r.table?.event?.title ? (
                        <span className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border border-[var(--sec-border)]">
                          {r.table.event.title}
                        </span>
                      ) : null}
                    </div>
                    <div className="grid grid-cols-2 gap-2 mb-3">
                      {specs.guestCount != null ? (
                        <div className="rounded-xl p-2.5 border border-[var(--sec-border)] bg-[var(--sec-bg-elevated)]">
                          <p className="text-[10px] uppercase tracking-wide text-[var(--sec-text-muted)]">Guests</p>
                          <p className="text-sm font-medium mt-0.5">{specs.guestCount}</p>
                        </div>
                      ) : null}
                      {specs.preferredDate || specs.preferredTime ? (
                        <div className="rounded-xl p-2.5 border border-[var(--sec-border)] bg-[var(--sec-bg-elevated)]">
                          <p className="text-[10px] uppercase tracking-wide text-[var(--sec-text-muted)]">When</p>
                          <p className="text-sm font-medium mt-0.5">
                            {[specs.preferredDate, specs.preferredTime].filter(Boolean).join(' · ')}
                          </p>
                        </div>
                      ) : null}
                      {minSpend != null && minSpend > 0 ? (
                        <div className="rounded-xl p-2.5 border border-[var(--sec-border)] bg-[var(--sec-bg-elevated)]">
                          <p className="text-[10px] uppercase tracking-wide text-[var(--sec-text-muted)]">Min spend</p>
                          <p className="text-sm font-medium mt-0.5">
                            R{minSpend.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}
                            {specs.minSpendMode === 'menu' ? ' (menu)' : specs.minSpendMode === 'manual' ? ' (manual)' : ''}
                          </p>
                        </div>
                      ) : null}
                    </div>
                    {menuLines.length > 0 ? (
                      <div className="mb-3">
                        <p className="text-[10px] uppercase tracking-wide text-[var(--sec-text-muted)] mb-2">Menu selection</p>
                        <div className="flex flex-wrap gap-1.5">
                          {menuLines.map((line, i) => (
                            <span
                              key={i}
                              className="text-xs px-2 py-1 rounded-full border border-[var(--sec-border)]"
                            >
                              {line.qty}× {line.label}
                              {line.lineTotal > 0 ? ` · R${line.lineTotal.toFixed(0)}` : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {specs.notes ? (
                      <p className="text-sm text-[var(--sec-text-secondary)] mb-3 italic">&ldquo;{specs.notes}&rdquo;</p>
                    ) : null}
                    <p className="text-[10px] uppercase tracking-wide text-[var(--sec-text-muted)] mb-2">Decline reasons (pick one or more)</p>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {VENUE_DECLINE_TEMPLATES.map((t) => {
                        const selected = (declineTemplatesByMember[r.id] || []).includes(t.key);
                        return (
                        <button
                          key={t.key}
                          type="button"
                          className="text-xs px-2.5 py-1.5 rounded-full border transition-colors"
                          style={{
                            borderColor: selected ? 'var(--sec-accent-border)' : 'var(--sec-border)',
                            background: selected ? 'var(--sec-accent-muted)' : 'transparent',
                          }}
                          onClick={() => {
                            setDeclineTemplatesByMember((d) => {
                              const cur = d[r.id] || [];
                              const next = cur.includes(t.key)
                                ? cur.filter((k) => k !== t.key)
                                : [...cur, t.key];
                              return { ...d, [r.id]: next };
                            });
                          }}
                        >
                          {t.label}
                        </button>
                        );
                      })}
                    </div>
                    {(declineTemplatesByMember[r.id] || []).includes('decline_increase_min_spend') ? (
                      <div className="mb-3">
                        <Label className="text-xs text-[var(--sec-text-muted)]">Preferred minimum spend (ZAR)</Label>
                        <Input
                          type="number"
                          min={0}
                          className="mt-1 h-9 max-w-[200px]"
                          placeholder="e.g. 8000"
                          value={declineParamsByMember[r.id]?.preferredMinimumSpend ?? ''}
                          onChange={(e) =>
                            setDeclineParamsByMember((p) => ({
                              ...p,
                              [r.id]: { ...p[r.id], preferredMinimumSpend: e.target.value },
                            }))
                          }
                        />
                      </div>
                    ) : null}
                    {(declineTemplatesByMember[r.id] || []).includes('decline_add_menu_items') ? (
                      <div className="mb-3">
                        <Label className="text-xs text-[var(--sec-text-muted)]">Menu items should total at least (ZAR)</Label>
                        <Input
                          type="number"
                          min={0}
                          className="mt-1 h-9 max-w-[200px]"
                          placeholder="e.g. 4500"
                          value={declineParamsByMember[r.id]?.preferredMenuTotal ?? ''}
                          onChange={(e) =>
                            setDeclineParamsByMember((p) => ({
                              ...p,
                              [r.id]: { ...p[r.id], preferredMenuTotal: e.target.value },
                            }))
                          }
                        />
                      </div>
                    ) : null}
                    {(declineTemplatesByMember[r.id] || []).includes('decline_no_tables_datetime') ? (
                      <div className="mb-3 grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-md">
                        <div>
                          <Label className="text-xs text-[var(--sec-text-muted)]">Available date</Label>
                          <Input
                            type="date"
                            className="mt-1 h-9"
                            value={declineParamsByMember[r.id]?.availableDate ?? ''}
                            onChange={(e) =>
                              setDeclineParamsByMember((p) => ({
                                ...p,
                                [r.id]: { ...p[r.id], availableDate: e.target.value },
                              }))
                            }
                          />
                        </div>
                        <div>
                          <Label className="text-xs text-[var(--sec-text-muted)]">Available time</Label>
                          <Input
                            type="time"
                            className="mt-1 h-9"
                            value={declineParamsByMember[r.id]?.availableTime ?? ''}
                            onChange={(e) =>
                              setDeclineParamsByMember((p) => ({
                                ...p,
                                [r.id]: { ...p[r.id], availableTime: e.target.value },
                              }))
                            }
                          />
                        </div>
                      </div>
                    ) : null}
                    {(declineTemplatesByMember[r.id] || []).includes('decline_too_many_guests') ? (
                      <div className="mb-3">
                        <Label className="text-xs text-[var(--sec-text-muted)]">Maximum guests we can seat</Label>
                        <Input
                          type="number"
                          min={1}
                          max={500}
                          className="mt-1 h-9 max-w-[200px]"
                          placeholder="e.g. 6"
                          value={declineParamsByMember[r.id]?.maxGuestCount ?? ''}
                          onChange={(e) =>
                            setDeclineParamsByMember((p) => ({
                              ...p,
                              [r.id]: { ...p[r.id], maxGuestCount: e.target.value },
                            }))
                          }
                        />
                      </div>
                    ) : null}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="sec-btn-primary"
                        onClick={() => reviewMutation.mutate({ tableId: r.table.id, memberId: r.id, action: 'approve' })}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={(() => {
                          const keys = declineTemplatesByMember[r.id] || [];
                          if (!keys.length) return true;
                          if (keys.includes('decline_increase_min_spend')) {
                            const n = parseFloat(declineParamsByMember[r.id]?.preferredMinimumSpend);
                            if (!Number.isFinite(n) || n < 0) return true;
                          }
                          if (keys.includes('decline_add_menu_items')) {
                            const n = parseFloat(declineParamsByMember[r.id]?.preferredMenuTotal);
                            if (!Number.isFinite(n) || n < 0) return true;
                          }
                          if (keys.includes('decline_no_tables_datetime')) {
                            const p = declineParamsByMember[r.id] || {};
                            if (!p.availableDate || !p.availableTime) return true;
                          }
                          if (keys.includes('decline_too_many_guests')) {
                            const n = parseInt(declineParamsByMember[r.id]?.maxGuestCount, 10);
                            if (!Number.isFinite(n) || n < 1) return true;
                          }
                          return false;
                        })()}
                        onClick={() => {
                          const keys = declineTemplatesByMember[r.id] || [];
                          const params = {};
                          if (keys.includes('decline_increase_min_spend')) {
                            params.preferredMinimumSpend = parseFloat(declineParamsByMember[r.id]?.preferredMinimumSpend);
                          }
                          if (keys.includes('decline_add_menu_items')) {
                            params.preferredMenuTotal = parseFloat(declineParamsByMember[r.id]?.preferredMenuTotal);
                          }
                          if (keys.includes('decline_no_tables_datetime')) {
                            params.availableDate = declineParamsByMember[r.id]?.availableDate;
                            params.availableTime = declineParamsByMember[r.id]?.availableTime;
                          }
                          if (keys.includes('decline_too_many_guests')) {
                            params.maxGuestCount = parseInt(declineParamsByMember[r.id]?.maxGuestCount, 10);
                          }
                          reviewMutation.mutate({
                            tableId: r.table.id,
                            memberId: r.id,
                            action: 'decline',
                            declineTemplateKeys: keys,
                            declineParams: params,
                          });
                        }}
                      >
                        Decline
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="settings" className="sec-card p-5 border border-[var(--sec-border)]">
          <div className="flex items-center gap-3">
            <Settings size={18} className="opacity-70" />
            <div className="flex-1">
              <p className="font-medium">Show Book on Sec for non-event days</p>
              <p className="text-xs text-[var(--sec-text-muted)] mt-1">
                When on, your venue profile shows day bookings guests can reserve outside events.
              </p>
            </div>
            <Switch
              checked={dayBookingsOn}
              onCheckedChange={(v) => saveVenueFlags.mutate(v)}
              disabled={saveVenueFlags.isPending}
            />
          </div>
          <div className="mt-6 flex items-center gap-3 border-t border-[var(--sec-border)] pt-5">
            <div className="flex-1">
              <p className="font-medium">Allow custom table requests</p>
              <p className="text-xs text-[var(--sec-text-muted)] mt-1">
                When on, guests can request a bespoke table on Book on Sec instead of picking a listed tier.
              </p>
            </div>
            <Switch
              checked={customRequestsOn}
              onCheckedChange={setCustomRequestsEnabled}
              disabled={!dayBookingsOn || actionTableId === 'custom-requests'}
            />
          </div>
          <div className="mt-6 flex items-center gap-3 border-t border-[var(--sec-border)] pt-5">
            <div className="flex-1">
              <p className="font-medium">Show seating plan on day bookings</p>
              <p className="text-xs text-[var(--sec-text-muted)] mt-1">
                When on, guests see your default floor plan on Book on Sec before choosing a table.
                {seatingPlanCount === 0 ? (
                  <>
                    {' '}
                    <Link to={createPageUrl('BusinessVenueSeatingPlans')} className="sec-link" style={{ color: 'var(--sec-accent)' }}>
                      Upload a plan
                    </Link>{' '}
                    first.
                  </>
                ) : null}
              </p>
            </div>
            <Switch
              checked={seatingPlanDayOn}
              onCheckedChange={(v) => saveSeatingPlanDay.mutate(v)}
              disabled={seatingPlanCount === 0 || saveSeatingPlanDay.isPending}
            />
          </div>
          <div className="mt-6 space-y-3 border-t border-[var(--sec-border)] pt-5">
            <p className="text-sm font-medium">Booking duration (optional)</p>
            <div>
              <Label className="text-xs">Maximum booking duration (hours)</Label>
              <Input
                className="mt-1 h-9"
                type="number"
                min={1}
                placeholder="No limit"
                value={venueFees.max_booking_duration_hours}
                onChange={(e) =>
                  setVenueFees((f) => ({ ...f, max_booking_duration_hours: e.target.value }))
                }
              />
              <p className="text-xs text-[var(--sec-text-muted)] mt-1">
                Leave blank for no limit. When set, guests hosting or joining day tables cannot book longer than this.
              </p>
            </div>
          </div>
          <div className="mt-6 space-y-3 border-t border-[var(--sec-border)] pt-5">
            <p className="text-sm font-medium">Default fees (custom table hosts)</p>
            <div>
              <Label className="text-xs">Host table fee (ZAR)</Label>
              <Input
                className="mt-1 h-9"
                type="number"
                min={0}
                value={venueFees.host_table_fee_zar}
                onChange={(e) => setVenueFees((f) => ({ ...f, host_table_fee_zar: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">Custom table booking fee (ZAR)</Label>
              <Input
                className="mt-1 h-9"
                type="number"
                min={0}
                value={venueFees.custom_table_booking_fee_zar}
                onChange={(e) => setVenueFees((f) => ({ ...f, custom_table_booking_fee_zar: e.target.value }))}
              />
            </div>
            <Button
              type="button"
              className="sec-btn-primary w-full"
              disabled={saveVenueFees.isPending}
              onClick={() => saveVenueFees.mutate()}
            >
              Save booking settings
            </Button>
          </div>
          {dayBookingsOn && venue?.id ? (
            <div className="mt-6 border-t border-[var(--sec-border)] pt-5">
              <p className="text-sm font-medium">Host at your venue</p>
              <p className="text-xs text-[var(--sec-text-muted)] mt-1 mb-3">
                You can host a table at your own venue like any guest — normal host fees apply.
              </p>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => navigate(createPageUrl(`VenueBook?venueId=${venueId}`))}
              >
                Host a table here
              </Button>
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
      </div>
      <FeedBoostDialog
        open={Boolean(boostTarget)}
        onOpenChange={(open) => {
          if (!open) setBoostTarget(null);
        }}
        title={boostTarget ? `Boost “${boostTarget.name}”` : 'Boost listing'}
        description="Boosted day listings appear more often under Available Tables on Home."
        maxDays={maxBoostDaysUntil(boostTarget?.endAt)}
        busy={boostBusy}
        onConfirm={async (days) => {
          if (!boostTarget?.tableId) return;
          setBoostBusy(true);
          try {
            const pay = await apiPost(`/api/business/venue-tables/${boostTarget.tableId}/boost`, {
              days,
            });
            if (!pay?.reference || !pay?.access_code) throw new Error('Could not start payment');
            await launchPaystackInline({
              email: userEmail,
              amount: pay.amount_zar,
              reference: pay.reference,
              accessCode: pay.access_code,
              authorizationUrl: pay.authorization_url,
              onSuccess: async (payload) => {
                await completePaystackCheckout({
                  reference: pay.reference,
                  payload,
                  queryClient: qc,
                  showToasts: false,
                });
                toast.success('Table boost is active');
                setBoostTarget(null);
                qc.invalidateQueries({ queryKey: ['biz-day-venue-tables'] });
              },
              onCancel: () => toast.message('Boost checkout cancelled'),
            });
          } catch (err) {
            toast.error(err?.data?.error || err?.message || 'Boost failed');
          } finally {
            setBoostBusy(false);
          }
        }}
      />
    </div>
  );
}
