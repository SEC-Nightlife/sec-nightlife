import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import * as authService from '@/services/authService';
import { dataService } from '@/services/dataService';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Calendar, Plus, Edit2, Trash2, Eye, Search, Loader2, Armchair, Users, Crown, UserCheck, Zap, Download,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiGet, apiPut, apiPost, uploadFile } from '@/api/client';
import ImageCropDialog from '@/components/profile/ImageCropDialog';
import { useImageCropUpload } from '@/hooks/useImageCropUpload';
import { tierFeeTogglesFromTier, resolveTierFeesForSave } from '@/lib/tierBookingFees';
import { tierMinSpendsFromApi, resolveTierMinSpends } from '@/lib/tierMinSpend';
import TierIncludedItemsEditor from '@/components/business/TierIncludedItemsEditor';
import FeedBoostDialog, { maxBoostDaysUntil } from '@/components/business/FeedBoostDialog';
import EventPurchaseLogDialog from '@/components/business/EventPurchaseLogDialog';
import { isEventEnded } from '@/lib/eventLifecycle';
import PageBackHeader from '@/components/layout/PageBackHeader';
import { useActiveVenue } from '@/context/ActiveVenueContext';
import { useBusinessVenueScope } from '@/hooks/useBusinessVenueScope';
import { menuApiBase } from '@/lib/staffVenueApi';
import { launchPaystackInline, loadPaystackScript } from '@/lib/paystackInline';
import { completePaystackCheckout } from '@/lib/completePaystackCheckout';

import { COVER_CROP_DIALOG_PROPS as EVENT_COVER_CROP_DIALOG_PROPS } from '@/lib/coverImageAspect';

function isoToDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function emptyHostingSection() {
  return { max_tables: '', tiers: [], host_table_fee_zar: '', allows_custom_requests: false };
}

function emptyHostingForm() {
  return { general: emptyHostingSection(), vip: emptyHostingSection() };
}

function hostingFromApi(hc) {
  if (!hc || typeof hc !== 'object') return emptyHostingForm();
  const mapSection = (s) => ({
    max_tables: s?.max_tables != null && s.max_tables !== '' ? String(s.max_tables) : '',
    host_table_fee_zar: s?.host_table_fee_zar != null && s.host_table_fee_zar !== '' ? String(s.host_table_fee_zar) : '',
    allows_custom_requests: Boolean(s?.allows_custom_requests),
    tiers: Array.isArray(s?.tiers) && s.tiers.length
      ? s.tiers.map((t) => {
          const toggles = tierFeeTogglesFromTier(t);
          const spends = tierMinSpendsFromApi(t);
          return {
          tier_name: String(t.tier_name ?? t.name ?? ''),
          max_guests: String(t.max_guests ?? ''),
          ...spends,
          booking_fee_zar: String(t.booking_fee_zar ?? ''),
          host_table_fee_zar: String(t.host_table_fee_zar ?? ''),
          include_join_booking_fee: toggles.include_join_booking_fee,
          include_host_booking_fee: toggles.include_host_booking_fee,
          include_entrance_fee: t.include_entrance_fee !== false,
          tier_table_slots: String(t.tier_table_slots ?? ''),
          included_items: Array.isArray(t?.included_items)
            ? t.included_items.map((inc) => ({
                menu_item_id: String(inc.menu_item_id || inc.menuItemId || ''),
                quantity: String(inc.quantity ?? '1'),
              }))
            : [],
        };
        })
      : [],
  });
  return {
    general: mapSection(hc.general),
    vip: mapSection(hc.vip),
  };
}

function parseTierSlotsTotal(tiers = []) {
  return tiers.reduce((acc, t) => acc + (parseInt(String(t?.tier_table_slots || ''), 10) || 0), 0);
}

const EMPTY_TICKET_TIER = {
  name: '',
  price: '',
  quantity: '',
  max_per_user: '',
  description: '',
  sold: 0,
  allows_menu_addons: false,
};

const EMPTY_EVENT = {
  title: '', description: '', date: '', city: '', location_address: '', location_city: '', location_suburb: '', location_province: '', status: 'draft',
  cover_image_url: '', ticket_tiers: [],
  event_format: 'TABLE_HOSTING',
  start_time: '',
  ends_at: '',
  has_entrance_fee: false,
  entrance_fee_amount: '',
  allows_ticket_menu_addons: false,
  event_code: '',
  hosting_config: emptyHostingForm(),
  show_seating_plan: false,
  seating_plan_id: '',
};

const EVENT_CODE_REGEX = /^[A-Z]{2,4}-\d{4}-[A-Z0-9]{1,4}$/;

function suggestEventCode({ venueName, dateIso, existingCodes = [], excludeCode = '' }) {
  const words = String(venueName || 'SEC').split(/[\s&]+/).filter(Boolean);
  let prefix = words.map((w) => w.replace(/[^a-zA-Z]/g, '').charAt(0)).join('').toUpperCase().slice(0, 4);
  if (prefix.length < 2) prefix = (prefix + 'SEC').slice(0, 2);
  const d = dateIso ? new Date(`${dateIso}T00:00:00`) : new Date();
  const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const taken = new Set(
    (existingCodes || [])
      .map((c) => String(c).trim().toUpperCase())
      .filter((c) => c && c !== String(excludeCode || '').trim().toUpperCase()),
  );
  for (const suffix of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const code = `${prefix}-${mmdd}-${suffix}`;
    if (!taken.has(code)) return code;
  }
  return `${prefix}-${mmdd}-Z`;
}

export default function BusinessEvents() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [form, setForm] = useState({ ...EMPTY_EVENT });
  const [search, setSearch] = useState('');
  const [lifecycleTab, setLifecycleTab] = useState('upcoming');
  const [deleteId, setDeleteId] = useState(null);
  const [tablesEventId, setTablesEventId] = useState(null);
  const [hidingTableId, setHidingTableId] = useState(null);
  const [resettingTableId, setResettingTableId] = useState(null);
  const [coverUploading, setCoverUploading] = useState(false);
  const [createMode, setCreateMode] = useState('tables');
  const [importDayTiers, setImportDayTiers] = useState(false);
  const [importingDayTiers, setImportingDayTiers] = useState(false);
  const [selectedPromoterIds, setSelectedPromoterIds] = useState([]);
  const [boostEvent, setBoostEvent] = useState(null);
  const [boostBusy, setBoostBusy] = useState(false);
  const [downloadingEventId, setDownloadingEventId] = useState(null);
  const [purchaseLog, setPurchaseLog] = useState(null);

  const coverCrop = useImageCropUpload({
    onCropped: async (file) => {
      setCoverUploading(true);
      try {
        const r = await uploadFile(file);
        if (r?.file_url) setForm((p) => ({ ...p, cover_image_url: r.file_url }));
        else toast.error('Upload did not return a URL');
      } catch (err) {
        toast.error(err?.message || 'Upload failed');
      } finally {
        setCoverUploading(false);
      }
    },
  });
  useEffect(() => {
    loadPaystackScript().catch(() => {});
  }, []);
  useEffect(() => {
    (async () => {
      try { setUser(await authService.loadUserOrLogin()); }
      catch { /* loadUserOrLogin redirects when no session remains */ }
    })();
  }, []);

  useEffect(() => {
    if (!user?.email) return;
    dataService.User.filter({ created_by: user.email }).then((profiles) => {
      setUserProfile(profiles?.[0] || null);
    }).catch(() => {});
  }, [user?.email]);

  const { activeVenue: venue } = useActiveVenue();
  const venueScope = useBusinessVenueScope();
  const scopeKey = venueScope.staffContextToken || venue?.id;
  const hasVenueScope = venueScope.inStaffSession || !!venue;

  const menuBase = menuApiBase({
    inStaffSession: venueScope.inStaffSession,
    staffContextToken: venueScope.staffContextToken,
    venueId: venue?.id,
  });

  const { data: venueMenuItems = [] } = useQuery({
    queryKey: ['venue-menu', scopeKey],
    queryFn: () => apiGet(`${menuBase}/menu-items`),
    enabled: !!menuBase,
  });

  const { data: events = [], isLoading } = useQuery({
    queryKey: ['biz-events', scopeKey],
    queryFn: () =>
      venueScope.inStaffSession
        ? apiGet(`/api/events?staff_ctx=${encodeURIComponent(venueScope.staffContextToken)}`)
        : dataService.Event.filter({ venue_id: venue.id }),
    enabled: hasVenueScope && (venueScope.inStaffSession || !!venue),
  });

  const promotersUrl = venueScope.inStaffSession && venueScope.staffContextToken
    ? `/api/events/roster/promoters?staff_ctx=${encodeURIComponent(venueScope.staffContextToken)}`
    : venue?.id
      ? `/api/events/venue/${venue.id}/promoters`
      : null;

  const { data: venuePromoters = [] } = useQuery({
    queryKey: ['venue-promoters', scopeKey],
    queryFn: () => apiGet(promotersUrl).then((r) => r?.data || []),
    enabled: !!promotersUrl,
  });

  const seatingPlansQs = venueScope.staffContextToken
    ? `?staff_ctx=${encodeURIComponent(venueScope.staffContextToken)}`
    : venue?.id
      ? `?venue_id=${encodeURIComponent(venue.id)}`
      : '';
  const { data: seatingPlansData } = useQuery({
    queryKey: ['venue-seating-plans', scopeKey],
    queryFn: () => apiGet(`/api/business/venue-seating-plans${seatingPlansQs}`),
    enabled: !!seatingPlansQs,
  });
  const venueSeatingPlans = seatingPlansData?.items ?? [];

  const { data: eventTablesData, isLoading: eventTablesLoading, refetch: refetchEventTables } = useQuery({
    queryKey: ['event-venue-tables', tablesEventId],
    queryFn: () => apiGet(`/api/business/event-venue-tables?event_id=${encodeURIComponent(tablesEventId)}`),
    enabled: !!tablesEventId,
  });

  const tablesEvent = events.find((e) => e.id === tablesEventId);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      let saved;
      if (editingEvent) {
        saved = await dataService.Event.update(editingEvent.id, data);
      } else {
        const createUrl = venueScope.inStaffSession && venueScope.staffContextToken
          ? `/api/events?staff_ctx=${encodeURIComponent(venueScope.staffContextToken)}`
          : '/api/events';
        const createBody = venueScope.inStaffSession
          ? data
          : { ...data, venue_id: venue.id };
        saved = await apiPost(createUrl, createBody);
      }
      const eventId = editingEvent?.id || saved?.id;
      if (eventId && selectedPromoterIds.length >= 0) {
        await apiPut(`/api/events/${eventId}/promoters`, { promoterUserIds: selectedPromoterIds });
      }
      return saved;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['biz-events'] });
      toast.success(editingEvent ? 'Event updated' : 'Event created');
      closeDialog();
    },
    onError: (err) => toast.error(err?.data?.error || err?.message || 'Failed to save event'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => dataService.Event.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['biz-events'] });
      toast.success('Event deleted');
      setDeleteId(null);
    },
    onError: () => toast.error('Failed to delete event'),
  });

  async function resetTableForRelisting(tableId) {
    if (
      !window.confirm(
        'End this table session and make the slot available for new host/join bookings? Current guests\' table QRs will no longer admit. Past payments stay in Bookings & Analytics.',
      )
    ) {
      return;
    }
    setResettingTableId(tableId);
    try {
      await apiPost(`/api/business/venue-tables/${tableId}/release`);
      toast.success('Table reset — slot is available for new bookings');
      refetchEventTables();
    } catch (e) {
      toast.error(e?.data?.error || e.message || 'Could not reset table');
    } finally {
      setResettingTableId(null);
    }
  }

  async function hideTableFromListings(tableId) {
    if (!window.confirm('Remove this table from guest listings? Guests already on this table are not affected.')) return;
    setHidingTableId(tableId);
    try {
      await apiPost(`/api/business/venue-tables/${tableId}/hide-from-listings`);
      toast.success('Table removed from listings');
      refetchEventTables();
    } catch (e) {
      toast.error(e?.data?.error || e.message || 'Could not hide table');
    } finally {
      setHidingTableId(null);
    }
  }

  async function restoreTableToListings(tableId) {
    setHidingTableId(tableId);
    try {
      await apiPost(`/api/business/venue-tables/${tableId}/restore-to-listings`);
      toast.success('Table restored to listings');
      refetchEventTables();
    } catch (e) {
      toast.error(e?.data?.error || e.message || 'Could not restore table');
    } finally {
      setHidingTableId(null);
    }
  }

  const openCreate = () => {
    setEditingEvent(null);
    setCreateMode('tables');
    setForm({ ...EMPTY_EVENT });
    setSelectedPromoterIds([]);
    setDialogOpen(true);
  };

  const downloadPurchaseLog = async (evt) => {
    if (!evt?.id || downloadingEventId) return;
    setDownloadingEventId(evt.id);
    try {
      const qs =
        venueScope.inStaffSession && venueScope.staffContextToken
          ? `?staff_ctx=${encodeURIComponent(venueScope.staffContextToken)}`
          : '';
      const data = await apiGet(`/api/business/events/${encodeURIComponent(evt.id)}/purchase-log${qs}`, {
        timeoutMs: 60_000,
      });
      if (!data?.groups && !data?.xlsxBase64) throw new Error('Could not build purchase log');
      setPurchaseLog(data);
      const n = Number(data.rowCount) || 0;
      if (n === 0) toast.success('Opened purchase log — no purchases yet');
      else toast.success(`Opened purchase log (${n} ${n === 1 ? 'purchase' : 'purchases'})`);
    } catch (err) {
      toast.error(err?.data?.error || err?.message || 'Could not download purchase log');
    } finally {
      setDownloadingEventId(null);
    }
  };

  const openEdit = async (evt) => {
    if (isEventEnded(evt)) {
      toast.error('Past events cannot be edited. View or delete only.');
      return;
    }
    setEditingEvent(evt);
    setForm({
      title: evt.title || '',
      description: evt.description || '',
      date: evt.date || '',
      city: evt.city || '',
      location_address: evt.location_address || '',
      location_city: evt.location_city || evt.city || '',
      location_suburb: evt.location_suburb || '',
      location_province: evt.location_province || '',
      status: evt.status || 'draft',
      cover_image_url: evt.cover_image_url || '',
      ticket_tiers: (evt.ticket_tiers || []).map((t) => ({
        ...t,
        allows_menu_addons:
          t.allows_menu_addons === true || t.allowsMenuAddons === true
            ? true
            : t.allows_menu_addons === false || t.allowsMenuAddons === false
              ? false
              : Boolean(evt.allows_ticket_menu_addons),
      })),
      start_time: evt.start_time || '',
      ends_at: isoToDatetimeLocal(evt.ends_at),
      has_entrance_fee: !!evt.has_entrance_fee,
      entrance_fee_amount: evt.entrance_fee_amount != null && evt.entrance_fee_amount !== ''
        ? String(evt.entrance_fee_amount)
        : '',
      hosting_config: hostingFromApi(evt.hosting_config),
      event_format: evt.event_format || 'TABLE_HOSTING',
      allows_ticket_menu_addons: Boolean(evt.allows_ticket_menu_addons),
      event_code: evt.event_code || '',
      show_seating_plan: Boolean(evt.show_seating_plan),
      seating_plan_id: evt.seating_plan_id || '',
    });
    setCreateMode(evt.event_format === 'TICKETING_ONLY' ? 'ticketing' : 'tables');
    try {
      const assigned = await apiGet(`/api/events/${evt.id}/promoters`);
      setSelectedPromoterIds((assigned?.data || []).map((p) => p.promoterUserId));
    } catch {
      setSelectedPromoterIds([]);
    }
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingEvent(null);
    setForm({ ...EMPTY_EVENT });
    setSelectedPromoterIds([]);
  };

  const togglePromoter = (promoterUserId) => {
    setSelectedPromoterIds((prev) =>
      prev.includes(promoterUserId)
        ? prev.filter((id) => id !== promoterUserId)
        : [...prev, promoterUserId],
    );
  };

  const handleSave = () => {
    if (editingEvent && isEventEnded(editingEvent)) {
      toast.error('This event has ended and cannot be updated.');
      return;
    }
    if (!form.title || !form.date) {
      toast.error('Please fill in title and date');
      return;
    }
    if (createMode !== 'ticketing' && form.has_entrance_fee) {
      const amt = parseFloat(String(form.entrance_fee_amount).replace(',', '.'));
      if (Number.isNaN(amt) || amt < 0) {
        toast.error('Please enter a valid entrance fee amount');
        return;
      }
    }
    const payload = {
      title: form.title,
      date: form.date,
      city: form.city?.trim() || undefined,
      location_address: form.location_address?.trim() || undefined,
      location_city: form.location_city?.trim() || undefined,
      location_suburb: form.location_suburb?.trim() || undefined,
      location_province: form.location_province?.trim() || undefined,
      status: form.status,
      has_entrance_fee: form.has_entrance_fee,
      entrance_fee_amount: form.has_entrance_fee
        ? parseFloat(String(form.entrance_fee_amount).replace(',', '.'))
        : null,
    };
    const codeRaw = String(form.event_code || '').trim();
    if (codeRaw) {
      const code = codeRaw.toUpperCase();
      if (!EVENT_CODE_REGEX.test(code)) {
        toast.error('Event code must match PREFIX-MMDD-SUFFIX (e.g. VV-0619-A)');
        return;
      }
      payload.event_code = code;
    } else {
      payload.event_code = null;
    }
    if (form.description) payload.description = form.description;
    if (form.cover_image_url) payload.cover_image_url = form.cover_image_url;
    if (form.ticket_tiers?.length) payload.ticket_tiers = form.ticket_tiers;
    if (form.start_time) payload.start_time = form.start_time;
    else if (editingEvent) payload.start_time = null;
    if (form.ends_at) {
      const end = new Date(form.ends_at);
      if (!Number.isNaN(end.getTime())) payload.ends_at = end.toISOString();
    }

    const isTicketing = createMode === 'ticketing';
    payload.event_format = isTicketing ? 'TICKETING_ONLY' : 'TABLE_HOSTING';

    if (isTicketing) {
      const tiers = (form.ticket_tiers || []).map((t) => {
        const row = {
          name: String(t.name || '').trim(),
          price: Number(t.price),
          quantity: parseInt(String(t.quantity), 10) || 0,
          description: String(t.description || '').trim(),
          sold: Number(t.sold) || 0,
          allows_menu_addons: Boolean(t.allows_menu_addons),
        };
        const capRaw = String(t.max_per_user ?? '').trim();
        if (capRaw) {
          const cap = parseInt(capRaw, 10);
          if (Number.isFinite(cap) && cap >= 1) row.max_per_user = cap;
        }
        return row;
      }).filter((t) => t.name);
      if (form.status === 'published' && tiers.length === 0) {
        toast.error('Add at least one ticket tier to publish');
        return;
      }
      for (const t of tiers) {
        if (!Number.isFinite(t.price) || t.price < 0) {
          toast.error('Each ticket tier needs a valid price');
          return;
        }
        if (t.quantity < 1) {
          toast.error('Each ticket tier needs quantity of at least 1');
          return;
        }
        if (t.max_per_user != null) {
          if (t.max_per_user < 1) {
            toast.error('Max tickets per guest must be at least 1, or leave blank for unlimited');
            return;
          }
          if (t.max_per_user > t.quantity) {
            toast.error(`Max tickets per guest for ${t.name} cannot exceed available quantity`);
            return;
          }
        }
      }
      payload.ticket_tiers = tiers;
      payload.has_entrance_fee = false;
      payload.entrance_fee_amount = null;
      payload.allows_ticket_menu_addons = tiers.some((t) => t.allows_menu_addons);
    } else {
      payload.allows_ticket_menu_addons = false;
    }

    const hostingPayload = {
      general: { max_tables: null, tiers: [], host_table_fee_zar: null, allows_custom_requests: false },
      vip: { max_tables: null, tiers: [], host_table_fee_zar: null, allows_custom_requests: false },
    };
    for (const cat of ['general', 'vip']) {
      const sec = form.hosting_config?.[cat];
      const maxT = String(sec?.max_tables || '').trim();
      if (maxT) {
        const n = parseInt(maxT, 10);
        if (Number.isNaN(n) || n < 1) {
          toast.error(`${cat === 'vip' ? 'VIP' : 'General'} max hosted tables must be a positive number`);
          return;
        }
        hostingPayload[cat].max_tables = n;
      }
      const hostFeeRaw = String(sec?.host_table_fee_zar ?? '').trim();
      if (hostFeeRaw) {
        const hostFee = parseFloat(hostFeeRaw.replace(',', '.'));
        if (Number.isNaN(hostFee) || hostFee < 0) {
          toast.error(`${cat === 'vip' ? 'VIP' : 'General'} host table fee must be 0 or more`);
          return;
        }
        hostingPayload[cat].host_table_fee_zar = hostFee;
      }
      hostingPayload[cat].allows_custom_requests = Boolean(sec?.allows_custom_requests);
      const rawTiers = sec?.tiers || [];
      const hasPartialTier = rawTiers.some((t) => {
        const name = String(t?.tier_name || '').trim();
        const guests = String(t?.max_guests || '').trim();
        const slots = String(t?.tier_table_slots ?? '').trim();
        const minJoin = String(t?.min_spend_join ?? t?.min_spend ?? '').trim();
        const minHost = String(t?.min_spend_host ?? '').trim();
        const hasMinSpend = minJoin !== '' || minHost !== '';
        const fields = [name, guests, slots, hasMinSpend ? 'spend' : ''];
        const filled = fields.filter((v) => v !== '').length;
        const complete = name && guests && slots && hasMinSpend;
        return filled > 0 && !complete;
      });
      if (hasPartialTier) {
        toast.error(
          `${cat === 'vip' ? 'VIP' : 'General'} tiers must include all fields: name, max guests, min spend, and hosted tables.`,
        );
        return;
      }
      const tierRows = rawTiers.filter(
        (t) =>
          String(t?.tier_name || '').trim() &&
          String(t?.max_guests || '').trim() &&
          (String(t?.min_spend_join ?? t?.min_spend ?? '').trim() !== '' ||
            String(t?.min_spend_host ?? t?.min_spend ?? '').trim() !== '') &&
          String(t?.tier_table_slots ?? '').trim() !== ''
      );
      const parsedTiers = [];
      let totalTierSlots = 0;
      for (const t of tierRows) {
        const mg = parseInt(String(t.max_guests).trim(), 10);
        const spends = resolveTierMinSpends(t);
        const slots = parseInt(String(t.tier_table_slots).trim(), 10);
        if (Number.isNaN(mg) || mg < 1 || Number.isNaN(slots) || slots < 1) {
          toast.error(`Check ${cat === 'vip' ? 'VIP' : 'General'} pricing tiers (guests and table slots)`);
          return;
        }
        if (spends.min_spend_join < 0 || spends.min_spend_host < 0) {
          toast.error(`Check ${cat === 'vip' ? 'VIP' : 'General'} minimum spend amounts`);
          return;
        }
        const tierName = String(t.tier_name || '').trim();
        if (!tierName) {
          toast.error(`Each ${cat === 'vip' ? 'VIP' : 'General'} tier needs a name`);
          return;
        }
        const included = (t.included_items || [])
          .map((inc) => ({
            menu_item_id: String(inc.menu_item_id || '').trim(),
            quantity: Math.max(1, parseInt(String(inc.quantity || '1'), 10) || 1),
          }))
          .filter((inc) => inc.menu_item_id);
        const fees = resolveTierFeesForSave(t);
        if (fees.include_join_booking_fee && fees.booking_fee_zar < 0) {
          toast.error(`Check ${cat === 'vip' ? 'VIP' : 'General'} join booking fee on tier "${tierName}"`);
          return;
        }
        if (fees.include_host_booking_fee && fees.host_table_fee_zar < 0) {
          toast.error(`Check ${cat === 'vip' ? 'VIP' : 'General'} host booking fee on tier "${tierName}"`);
          return;
        }
        const tierPayload = {
          tier_name: tierName,
          max_guests: mg,
          min_spend: spends.min_spend_join,
          min_spend_join: spends.min_spend_join,
          min_spend_host: spends.min_spend_host,
          tier_table_slots: slots,
          booking_fee_zar: fees.booking_fee_zar,
          host_table_fee_zar: fees.host_table_fee_zar,
          include_join_booking_fee: fees.include_join_booking_fee,
          include_host_booking_fee: fees.include_host_booking_fee,
          include_entrance_fee: t.include_entrance_fee !== false,
        };
        if (included.length) tierPayload.included_items = included;
        parsedTiers.push(tierPayload);
        totalTierSlots += slots;
      }
      if (parsedTiers.length > 0 && hostingPayload[cat].max_tables == null) {
        toast.error(`${cat === 'vip' ? 'VIP' : 'General'} max hosted tables is required when pricing tiers are configured`);
        return;
      }
      if (parsedTiers.length > 0 && totalTierSlots !== hostingPayload[cat].max_tables) {
        toast.error(
          `${cat === 'vip' ? 'VIP' : 'General'} tier table counts must add up to max hosted tables (${hostingPayload[cat].max_tables}). Current sum: ${totalTierSlots}.`,
        );
        return;
      }
      hostingPayload[cat].tiers = parsedTiers;
    }
    const hasAnyHostingTiers = ['general', 'vip'].some((c) => hostingPayload[c].tiers.length > 0);
    if (hasAnyHostingTiers || !isTicketing) {
      payload.hosting_config = hostingPayload;
    } else {
      payload.hosting_config = null;
    }

    if (isTicketing) {
      payload.show_seating_plan = false;
      payload.seating_plan_id = null;
      saveMutation.mutate(payload);
      return;
    }

    payload.show_seating_plan = Boolean(form.show_seating_plan);
    payload.seating_plan_id = form.show_seating_plan
      ? (form.seating_plan_id || venueSeatingPlans.find((p) => p.is_default)?.id || venueSeatingPlans[0]?.id || null)
      : null;
    if (payload.show_seating_plan && !payload.seating_plan_id) {
      toast.error('Upload a seating plan first, or choose one from your library');
      return;
    }
    saveMutation.mutate(payload);
  };

  const filtered = events
    .filter((e) => {
      const ended = isEventEnded(e);
      if (lifecycleTab === 'draft') return e.status === 'draft' && !ended;
      if (lifecycleTab === 'past') return ended;
      return !ended && e.status !== 'draft';
    })
    .filter(e => !search || (e.title ?? '').toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  if (!user) return null;

  if (!hasVenueScope) {
    return (
      <div style={{ padding: 40, textAlign: 'center', maxWidth: 400, margin: '0 auto' }}>
        <Calendar size={32} style={{ color: 'var(--sec-text-muted)', margin: '0 auto 12px' }} />
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>No Venue Found</h2>
        <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', marginBottom: 20 }}>
          {venueScope.inStaffSession ? 'Staff venue context is missing or expired.' : 'Register a venue first to manage events.'}
        </p>
        {!venueScope.inStaffSession ? (
          <Button onClick={() => navigate(createPageUrl('VenueOnboarding'))} style={{ backgroundColor: 'var(--sec-accent)', color: '#000' }}>
            Register Venue
          </Button>
        ) : null}
      </div>
    );
  }

  const displayVenueName = venueScope.venueName || venue?.name || 'Venue';

  return (
    <div className="max-w-[900px] mx-auto">
      <PageBackHeader title="Events Manager" subtitle={`${displayVenueName} · ${events.length} events`} pageName="BusinessEvents" />
      <div className="px-4 pb-6 pt-4">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 20 }}>
        <Button onClick={openCreate} style={{ backgroundColor: 'var(--sec-accent)', color: '#000', fontWeight: 600 }} className="h-10 rounded-xl">
          <Plus size={16} className="mr-1.5" /> Create Event
        </Button>
      </div>
      {!userProfile?.payment_setup_complete ? (
        <div className="rounded-xl p-3 mb-3" style={{ backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)' }}>
          <p style={{ fontSize: 13, color: 'var(--sec-text-primary)' }}>
            Payout details missing. Your venue payouts can remain pending until setup is complete in
            {' '}<Link to={createPageUrl('BusinessDashboard')} style={{ color: 'var(--sec-accent)', textDecoration: 'underline' }}>Sec Wallet on Business Dashboard</Link>.
          </p>
        </div>
      ) : null}

      {/* Filters */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(['upcoming', 'past', 'draft']).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setLifecycleTab(tab)}
              className="h-10 rounded-xl px-4 text-sm font-semibold transition-colors"
              style={{
                backgroundColor: lifecycleTab === tab ? 'var(--sec-accent)' : 'var(--sec-bg-card)',
                color: lifecycleTab === tab ? '#000' : 'var(--sec-text-secondary)',
                border: `1px solid ${lifecycleTab === tab ? 'var(--sec-accent)' : 'var(--sec-border)'}`,
              }}
            >
              {tab === 'upcoming' ? 'Upcoming' : tab === 'past' ? 'Past' : 'Drafts'}
            </button>
          ))}
        </div>
        <div style={{ position: 'relative', width: '100%' }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--sec-text-muted)' }} />
          <Input
            placeholder="Search events..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
            className="h-10 rounded-xl pl-9 w-full"
          />
        </div>
      </div>
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Loader2 size={24} className="animate-spin" style={{ color: 'var(--sec-accent)', margin: '0 auto' }} />
        </div>
      ) : filtered.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: 40, borderRadius: 14,
          backgroundColor: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)',
        }}>
          <Calendar size={28} style={{ color: 'var(--sec-text-muted)', margin: '0 auto 10px' }} />
          <p style={{ fontSize: 14, color: 'var(--sec-text-muted)', marginBottom: 14 }}>
            {search
              ? 'No matching events found'
              : lifecycleTab === 'past'
                ? 'No past events'
                : lifecycleTab === 'draft'
                  ? 'No drafts yet'
                  : 'No upcoming events'}
          </p>
          {!search && lifecycleTab !== 'past' && (
            <Button onClick={openCreate} variant="outline" className="rounded-xl" style={{ borderColor: 'var(--sec-border)' }}>
              <Plus size={15} className="mr-1.5" /> Create your first event
            </Button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((evt) => {
            const ended = isEventEnded(evt);
            return (
            <div key={evt.id} className="sec-biz-list-card">
              <div className="sec-biz-list-card__head">
                {evt.cover_image_url ? (
                  <img src={evt.cover_image_url} alt="" className="sec-biz-list-card__thumb" />
                ) : (
                  <div className="sec-biz-list-card__thumb-placeholder">
                    <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--sec-accent)', lineHeight: 1 }}>
                      {evt.date ? new Date(evt.date + 'T00:00').getDate() : '—'}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--sec-text-muted)', textTransform: 'uppercase' }}>
                      {evt.date ? new Date(evt.date + 'T00:00').toLocaleDateString('en', { month: 'short' }) : ''}
                    </span>
                  </div>
                )}
                <div className="sec-biz-list-card__body">
                  <div className="sec-biz-list-card__title">{evt.title}</div>
                  <div className="sec-biz-list-card__meta">
                    {evt.date}
                    {evt.start_time ? ` · ${evt.start_time}` : ''}
                    {' · '}{evt.location_city || evt.city}
                    {evt.event_code ? ` · ${evt.event_code}` : ''}
                  </div>
                </div>
              </div>
              <div className="sec-biz-list-card__footer">
                <span
                  className={`sec-badge ${
                    ended ? 'sec-badge-gold' : evt.status === 'published' ? 'sec-badge-success' : 'sec-badge-gold'
                  }`}
                >
                  {ended ? 'Ended' : evt.status}
                </span>
                {evt.boosted && !ended ? (
                  <span className="sec-badge sec-badge-gold">Boosted</span>
                ) : null}
                <div className="sec-biz-list-card__actions">
                  <button
                    onClick={() => navigate(createPageUrl('EventDetails') + '?id=' + evt.id)}
                    style={{ padding: 8, borderRadius: 8, border: 'none', cursor: 'pointer', backgroundColor: 'transparent', color: 'var(--sec-text-muted)' }}
                    title="View"
                  >
                    <Eye size={16} />
                  </button>
                  {lifecycleTab !== 'draft' ? (
                  <button
                    type="button"
                    onClick={() => downloadPurchaseLog(evt)}
                    disabled={downloadingEventId === evt.id}
                    style={{
                      padding: 8,
                      borderRadius: 8,
                      border: 'none',
                      cursor: downloadingEventId === evt.id ? 'wait' : 'pointer',
                      backgroundColor: 'transparent',
                      color: 'var(--sec-text-muted)',
                      opacity: downloadingEventId && downloadingEventId !== evt.id ? 0.5 : 1,
                    }}
                    title="View purchase log"
                  >
                    {downloadingEventId === evt.id ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  </button>
                  ) : null}
                  {!ended && evt.status === 'published' ? (
                  <button
                    onClick={() => setBoostEvent(evt)}
                    style={{
                      padding: 8,
                      borderRadius: 8,
                      border: 'none',
                      cursor: 'pointer',
                      backgroundColor: 'transparent',
                      color: evt.boosted ? 'var(--sec-warning)' : 'var(--sec-text-muted)',
                    }}
                    title={evt.boosted ? 'Boosted — extend boost' : 'Boost in Home feed'}
                  >
                    <Zap size={16} />
                  </button>
                  ) : null}
                  {!ended && evt.status === 'published' ? (
                  <button
                    onClick={() => setTablesEventId(evt.id)}
                    style={{ padding: 8, borderRadius: 8, border: 'none', cursor: 'pointer', backgroundColor: 'transparent', color: 'var(--sec-text-muted)' }}
                    title="Manage tables"
                  >
                    <Armchair size={16} />
                  </button>
                  ) : null}
                  {!ended ? (
                  <button
                    onClick={() => openEdit(evt)}
                    style={{ padding: 8, borderRadius: 8, border: 'none', cursor: 'pointer', backgroundColor: 'transparent', color: 'var(--sec-text-muted)' }}
                    title="Edit"
                  >
                    <Edit2 size={16} />
                  </button>
                  ) : null}
                  <button
                    onClick={() => setDeleteId(evt.id)}
                    style={{ padding: 8, borderRadius: 8, border: 'none', cursor: 'pointer', backgroundColor: 'transparent', color: 'var(--sec-error)' }}
                    title="Delete"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className="text-white sm:max-w-[520px] flex flex-col max-h-[90vh] overflow-hidden p-0 gap-0"
          style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
        >
          <DialogHeader className="px-6 pt-6 pb-3 shrink-0 border-b border-[var(--sec-border)]">
            <DialogTitle>{editingEvent ? 'Edit Event' : 'Create Event'}</DialogTitle>
            {!editingEvent ? (
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  className="flex-1 text-xs py-2 rounded-full border transition-colors"
                  style={{
                    borderColor: createMode === 'tables' ? 'var(--sec-accent-border)' : 'var(--sec-border)',
                    background: createMode === 'tables' ? 'var(--sec-accent-muted)' : 'transparent',
                  }}
                  onClick={() => setCreateMode('tables')}
                >
                  Tables &amp; hosting
                </button>
                <button
                  type="button"
                  className="flex-1 text-xs py-2 rounded-full border transition-colors"
                  style={{
                    borderColor: createMode === 'ticketing' ? 'var(--sec-accent-border)' : 'var(--sec-border)',
                    background: createMode === 'ticketing' ? 'var(--sec-accent-muted)' : 'transparent',
                  }}
                  onClick={() => setCreateMode('ticketing')}
                >
                  Ticketed entry
                </button>
              </div>
            ) : (
              <p className="text-xs text-gray-500 mt-2">
                {createMode === 'ticketing' ? 'Ticketed event' : 'Table hosting event'}
              </p>
            )}
          </DialogHeader>
          <div className="overflow-y-auto overscroll-contain px-6 py-4 flex-1 min-h-0">
          <div className="space-y-4">
            <div>
              <Label className="text-gray-400 text-sm">Event Title *</Label>
              <Input
                value={form.title}
                onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
                placeholder="Friday Night Live"
                className="mt-1.5 h-11 rounded-xl"
                style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
              />
            </div>
            <div>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <Label className="text-gray-400 text-sm">Door verification code (optional)</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-[var(--sec-accent)]"
                  onClick={() => {
                    const suggested = suggestEventCode({
                      venueName: displayVenueName,
                      dateIso: form.date,
                      existingCodes: events.map((e) => e.event_code).filter(Boolean),
                      excludeCode: editingEvent?.event_code,
                    });
                    setForm((p) => ({ ...p, event_code: suggested }));
                  }}
                >
                  Use suggested
                </Button>
              </div>
              <Input
                value={form.event_code}
                onChange={(e) => setForm((p) => ({ ...p, event_code: e.target.value.toUpperCase() }))}
                placeholder="VV-0619-A"
                className="mt-1.5 h-11 rounded-xl font-mono tracking-wide"
                style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
              />
              <p className="text-xs text-gray-500 mt-1.5">
                Format: PREFIX-MMDD-SUFFIX (e.g. VV-0619-A). Shown on guest QR codes for quick door checks.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-gray-400 text-sm">Date *</Label>
                <Input
                  type="date"
                  value={form.date}
                  onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
                  className="mt-1.5 h-11 rounded-xl"
                style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                />
              </div>
              <div>
                <Label className="text-gray-400 text-sm">City (legacy optional)</Label>
                <Input
                  value={form.city}
                  onChange={e => setForm(p => ({ ...p, city: e.target.value }))}
                  placeholder="Optional: fallback uses venue city"
                  className="mt-1.5 h-11 rounded-xl"
                style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                />
              </div>
            </div>
            <div className="space-y-3 rounded-xl border p-4" style={{ borderColor: 'var(--sec-border)', backgroundColor: 'var(--sec-bg-elevated)' }}>
              <h3 className="text-sm font-semibold" style={{ color: 'var(--sec-text-primary)' }}>
                Event location override (optional)
              </h3>
              <p className="text-xs text-gray-500">
                Leave any field empty to use this venue's location for that field.
              </p>
              <div>
                <Label className="text-gray-400 text-sm">Address</Label>
                <Input
                  value={form.location_address}
                  onChange={e => setForm(p => ({ ...p, location_address: e.target.value }))}
                  placeholder="Optional street address override"
                  className="mt-1.5 h-11 rounded-xl"
                  style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <Label className="text-gray-400 text-sm">City</Label>
                  <Input
                    value={form.location_city}
                    onChange={e => setForm(p => ({ ...p, location_city: e.target.value }))}
                    placeholder="Optional city override"
                    className="mt-1.5 h-11 rounded-xl"
                    style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                  />
                </div>
                <div>
                  <Label className="text-gray-400 text-sm">Suburb</Label>
                  <Input
                    value={form.location_suburb}
                    onChange={e => setForm(p => ({ ...p, location_suburb: e.target.value }))}
                    placeholder="Optional suburb override"
                    className="mt-1.5 h-11 rounded-xl"
                    style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                  />
                </div>
                <div>
                  <Label className="text-gray-400 text-sm">Province</Label>
                  <Input
                    value={form.location_province}
                    onChange={e => setForm(p => ({ ...p, location_province: e.target.value }))}
                    placeholder="Optional province override"
                    className="mt-1.5 h-11 rounded-xl"
                    style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                  />
                </div>
              </div>
            </div>
            <div>
              <Label className="text-gray-400 text-sm">Start time</Label>
              <Input
                type="time"
                value={form.start_time}
                onChange={e => setForm(p => ({ ...p, start_time: e.target.value }))}
                className="mt-1.5 h-11 rounded-xl max-w-[200px]"
                style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
              />
              <p className="text-xs text-gray-500 mt-1">Optional. Leave empty if the time is not set yet.</p>
            </div>
            <div>
              <Label className="text-gray-400 text-sm">End date &amp; time</Label>
              <Input
                type="datetime-local"
                value={form.ends_at}
                onChange={(e) => setForm((p) => ({ ...p, ends_at: e.target.value }))}
                className="mt-1.5 h-11 rounded-xl max-w-[280px]"
                style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
              />
              <p className="text-xs text-gray-500 mt-1">Required when publishing. Feeds and tickets use this as the event end.</p>
            </div>
            {createMode !== 'ticketing' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="entrance-fee"
                    checked={form.has_entrance_fee}
                    onCheckedChange={(v) => setForm((p) => ({ ...p, has_entrance_fee: v === true }))}
                  />
                  <Label htmlFor="entrance-fee" className="text-gray-300 text-sm cursor-pointer">
                    Entrance fee
                  </Label>
                </div>
                {form.has_entrance_fee && (
                  <div>
                    <Label className="text-gray-400 text-sm">Entrance fee (ZAR) *</Label>
                    <Input
                      type="number"
                      min={0}
                      step={0.01}
                      value={form.entrance_fee_amount}
                      onChange={e => setForm(p => ({ ...p, entrance_fee_amount: e.target.value }))}
                      placeholder="0.00"
                      className="mt-1.5 h-11 rounded-xl max-w-[200px]"
                      style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                    />
                  </div>
                )}
              </div>
            )}
            {createMode === 'ticketing' ? (
              <div
                className="space-y-3 rounded-xl border p-4"
                style={{ borderColor: 'var(--sec-border)', backgroundColor: 'var(--sec-bg-elevated)' }}
              >
                <h3 className="text-sm font-semibold">Ticket tiers</h3>
                <p className="text-xs text-gray-500">
                  Guests buy tickets — no table hosting or entrance fee. Each ticket gets its own QR. Optionally let guests add paid items from your venue menu on a tier.
                </p>
                {(form.ticket_tiers || []).map((tier, idx) => (
                  <div
                    key={idx}
                    className="space-y-2 p-3 rounded-xl border"
                    style={{ borderColor: 'var(--sec-border)', backgroundColor: 'var(--sec-bg-card)' }}
                  >
                    <Input
                      placeholder="Tier name (e.g. VIP)"
                      value={tier.name}
                      onChange={(e) => {
                        const next = [...(form.ticket_tiers || [])];
                        next[idx] = { ...next[idx], name: e.target.value };
                        setForm((p) => ({ ...p, ticket_tiers: next }));
                      }}
                      className="h-10 rounded-xl"
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <Input
                        type="number"
                        min={0}
                        placeholder="Price (ZAR)"
                        value={tier.price}
                        onChange={(e) => {
                          const next = [...(form.ticket_tiers || [])];
                          next[idx] = { ...next[idx], price: e.target.value };
                          setForm((p) => ({ ...p, ticket_tiers: next }));
                        }}
                        className="h-10 rounded-xl"
                      />
                      <Input
                        type="number"
                        min={1}
                        placeholder="Available qty"
                        value={tier.quantity}
                        onChange={(e) => {
                          const next = [...(form.ticket_tiers || [])];
                          next[idx] = { ...next[idx], quantity: e.target.value };
                          setForm((p) => ({ ...p, ticket_tiers: next }));
                        }}
                        className="h-10 rounded-xl"
                      />
                      <Input
                        type="number"
                        min={1}
                        placeholder="Max per guest"
                        value={tier.max_per_user ?? ''}
                        onChange={(e) => {
                          const next = [...(form.ticket_tiers || [])];
                          next[idx] = { ...next[idx], max_per_user: e.target.value };
                          setForm((p) => ({ ...p, ticket_tiers: next }));
                        }}
                        className="h-10 rounded-xl"
                      />
                    </div>
                    <p className="text-[11px]" style={{ color: 'var(--sec-text-muted)' }}>
                      Max tickets per guest is optional — leave blank for no per-person cap.
                    </p>
                    <Textarea
                      rows={2}
                      placeholder="What this ticket includes"
                      value={tier.description || ''}
                      onChange={(e) => {
                        const next = [...(form.ticket_tiers || [])];
                        next[idx] = { ...next[idx], description: e.target.value };
                        setForm((p) => ({ ...p, ticket_tiers: next }));
                      }}
                      className="rounded-xl text-sm"
                    />
                    <div className="flex items-start gap-2 pt-1">
                      <Checkbox
                        id={`ticket-tier-menu-${idx}`}
                        checked={Boolean(tier.allows_menu_addons)}
                        onCheckedChange={(v) => {
                          const next = [...(form.ticket_tiers || [])];
                          next[idx] = { ...next[idx], allows_menu_addons: v === true };
                          setForm((p) => ({ ...p, ticket_tiers: next }));
                        }}
                      />
                      <Label htmlFor={`ticket-tier-menu-${idx}`} className="text-gray-300 text-sm cursor-pointer leading-snug">
                        Guests can add items from this venue’s menu (optional)
                      </Label>
                    </div>
                    {tier.allows_menu_addons && !(venueMenuItems || []).length ? (
                      <p className="text-[11px]" style={{ color: 'var(--sec-text-muted)' }}>
                        No menu items yet.{' '}
                        <button
                          type="button"
                          className="underline"
                          style={{ color: 'var(--sec-accent)' }}
                          onClick={() => navigate(createPageUrl('BusinessMenu'))}
                        >
                          Add a menu
                        </button>{' '}
                        so guests can pick food and drinks when they buy this ticket.
                      </p>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-red-400"
                      onClick={() =>
                        setForm((p) => ({
                          ...p,
                          ticket_tiers: (p.ticket_tiers || []).filter((_, i) => i !== idx),
                        }))
                      }
                    >
                      Remove tier
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm((p) => ({
                      ...p,
                      ticket_tiers: [...(p.ticket_tiers || []), { ...EMPTY_TICKET_TIER }],
                    }))
                  }
                >
                  <Plus size={14} className="mr-1" /> Add ticket tier
                </Button>
              </div>
            ) : null}
            {createMode === 'tables' ? (
              <div
                className="space-y-3 rounded-xl border p-4 mb-4"
                style={{ borderColor: 'var(--sec-border)', backgroundColor: 'var(--sec-bg-elevated)' }}
              >
                <h3 className="text-sm font-semibold" style={{ color: 'var(--sec-text-primary)' }}>
                  Seating & floor plan
                </h3>
                <p className="text-xs text-gray-500">
                  Let guests preview where they&apos;ll be seated before they book a table for this event.
                </p>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={Boolean(form.show_seating_plan)}
                    disabled={venueSeatingPlans.length === 0}
                    onCheckedChange={(v) =>
                      setForm((p) => ({
                        ...p,
                        show_seating_plan: Boolean(v),
                        seating_plan_id:
                          v && !p.seating_plan_id
                            ? (venueSeatingPlans.find((pl) => pl.is_default)?.id || venueSeatingPlans[0]?.id || '')
                            : p.seating_plan_id,
                      }))
                    }
                  />
                  Show seating plan for this event
                </label>
                {venueSeatingPlans.length === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--sec-text-muted)' }}>
                    Upload plans in{' '}
                    <Link to={createPageUrl('BusinessVenueSeatingPlans')} className="sec-link" style={{ color: 'var(--sec-accent)' }}>
                      Seating plans
                    </Link>{' '}
                    first.
                  </p>
                ) : null}
                {form.show_seating_plan && venueSeatingPlans.length > 0 ? (
                  <div>
                    <Label className="text-xs text-gray-400">Plan for this event</Label>
                    <select
                      className="mt-1 w-full h-10 rounded-xl px-3 text-sm"
                      style={{
                        background: 'var(--sec-bg-card)',
                        border: '1px solid var(--sec-border)',
                        color: 'var(--sec-text-primary)',
                      }}
                      value={form.seating_plan_id || venueSeatingPlans.find((p) => p.is_default)?.id || venueSeatingPlans[0]?.id || ''}
                      onChange={(e) => setForm((p) => ({ ...p, seating_plan_id: e.target.value }))}
                    >
                      {venueSeatingPlans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.name}{plan.is_default ? ' (default)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
            ) : null}
            {/* Import day listing tiers */}
            <div
              className="rounded-xl border p-4 mb-4"
              style={{ borderColor: 'var(--sec-border)', backgroundColor: 'var(--sec-bg-elevated)' }}
            >
              <label className="flex items-center gap-2 text-sm cursor-pointer mb-2">
                <Checkbox
                  checked={importDayTiers}
                  disabled={importingDayTiers}
                  onCheckedChange={async (v) => {
                    const on = Boolean(v);
                    setImportDayTiers(on);
                    if (!on) return;
                    const venueId = venueScope.venueId || venue?.id;
                    if (!venueId) {
                      toast.error('No venue selected');
                      setImportDayTiers(false);
                      return;
                    }
                    setImportingDayTiers(true);
                    try {
                      const data = await apiGet(`/api/business/day-venue-tables?venue_id=${encodeURIComponent(venueId)}`);
                      const items = (data?.items || []).filter((t) => !t.isCustomListing && t.isActive !== false);
                      const byKey = new Map();
                      for (const row of items) {
                        const cat = String(row.tableCategory || row.table_category || 'general').toLowerCase() === 'vip' ? 'vip' : 'general';
                        const name = row.tierLabel || row.tableName?.replace(/\s#\d+$/, '') || 'Tier';
                        const key = `${cat}::${name}`;
                        if (!byKey.has(key)) {
                          byKey.set(key, {
                            cat,
                            tier_name: name,
                            max_guests: String(row.guestCapacity ?? 6),
                            min_spend: String(row.minimumSpend ?? ''),
                            min_spend_join: String(row.minimumSpend ?? ''),
                            min_spend_host: String(row.hostMinimumSpend ?? row.minimumSpend ?? ''),
                            booking_fee_zar: String(row.bookingFeeZar ?? ''),
                            host_table_fee_zar: String(row.hostTableFeeZar ?? ''),
                            include_join_booking_fee: Number(row.bookingFeeZar || 0) > 0,
                            include_host_booking_fee: Number(row.hostTableFeeZar || 0) > 0,
                            include_entrance_fee: true,
                            tier_table_slots: 0,
                            included_items: Array.isArray(row.includedItems)
                              ? row.includedItems.map((inc) => ({
                                  menu_item_id: String(inc.menu_item_id || inc.menuItemId || ''),
                                  quantity: String(inc.quantity ?? '1'),
                                }))
                              : [],
                          });
                        }
                        const cur = byKey.get(key);
                        cur.tier_table_slots += 1;
                      }
                      const nextHosting = emptyHostingForm();
                      for (const tier of byKey.values()) {
                        const cat = tier.cat;
                        const { cat: _c, ...rest } = tier;
                        nextHosting[cat].tiers.push({
                          ...rest,
                          tier_table_slots: String(rest.tier_table_slots),
                        });
                      }
                      for (const cat of ['general', 'vip']) {
                        const sum = nextHosting[cat].tiers.reduce(
                          (a, t) => a + (parseInt(String(t.tier_table_slots), 10) || 0),
                          0,
                        );
                        nextHosting[cat].max_tables = sum > 0 ? String(sum) : '';
                      }
                      if (![...byKey.values()].length) {
                        toast.error('No day booking table listings found to import');
                        setImportDayTiers(false);
                        return;
                      }
                      setForm((p) => ({ ...p, hosting_config: nextHosting }));
                      toast.success('Imported day listing tiers — review slots and fees before publishing');
                    } catch (e) {
                      toast.error(e?.data?.error || e.message || 'Could not import day listings');
                      setImportDayTiers(false);
                    } finally {
                      setImportingDayTiers(false);
                    }
                  }}
                />
                Import tables from Day bookings listings
              </label>
              <p className="text-xs text-gray-500">
                Prefills General / VIP tiers from your Tables & day bookings page. Adjust slot counts and entrance include before publishing.
              </p>
            </div>
            {(['general', 'vip']).map((cat) => {
              const label = cat === 'vip' ? 'VIP' : 'General';
              const sec = form.hosting_config?.[cat] || emptyHostingSection();
              const tiers = sec.tiers || [];
              return (
                <div
                  key={cat}
                  className="space-y-3 rounded-xl border p-4"
                  style={{ borderColor: 'var(--sec-border)', backgroundColor: 'var(--sec-bg-elevated)' }}
                >
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--sec-text-primary)' }}>
                    {label} venue tables
                  </h3>
                  <p className="text-xs text-gray-500">
                    Guests pay minimum spend at checkout (plus optional booking and entrance fees you enable per tier). Included items are bundled; they may add more from your menu.
                  </p>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={Boolean(sec.allows_custom_requests)}
                      onCheckedChange={(v) =>
                        setForm((p) => ({
                          ...p,
                          hosting_config: {
                            ...p.hosting_config,
                            [cat]: { ...p.hosting_config[cat], allows_custom_requests: Boolean(v) },
                          },
                        }))
                      }
                    />
                    Allow guests to request a custom table (you approve before they pay)
                  </label>
                  <div>
                    <Label className="text-gray-400 text-sm">Max hosted tables (optional)</Label>
                    <Input
                      type="number"
                      min={1}
                      value={sec.max_tables}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          hosting_config: {
                            ...p.hosting_config,
                            [cat]: { ...p.hosting_config[cat], max_tables: e.target.value },
                          },
                        }))
                      }
                      placeholder="No limit if empty"
                      className="mt-1.5 h-11 rounded-xl max-w-[200px]"
                      style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Caps how many {label.toLowerCase()} tables can be hosted for this event.
                    </p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <Label className="text-gray-400 text-sm">Table pricing tiers (optional)</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-lg text-xs"
                        style={{ borderColor: 'var(--sec-border)' }}
                        onClick={() =>
                          setForm((p) => ({
                            ...p,
                            hosting_config: {
                              ...p.hosting_config,
                              [cat]: {
                                ...p.hosting_config[cat],
                                tiers: [
                                  ...(p.hosting_config[cat].tiers || []),
                                  {
                                    tier_name: '',
                                    max_guests: '',
                                    min_spend: '',
                                    min_spend_join: '',
                                    min_spend_host: '',
                                    booking_fee_zar: '',
                                    host_table_fee_zar: '',
                                    include_join_booking_fee: false,
                                    include_host_booking_fee: false,
                                    include_entrance_fee: true,
                                    tier_table_slots: '',
                                    included_items: [],
                                  },
                                ],
                              },
                            },
                          }))
                        }
                      >
                        <Plus size={14} className="mr-1" /> Add tier
                      </Button>
                    </div>
                    <p
                      className={`text-xs mb-2 ${
                        sec.max_tables && parseTierSlotsTotal(tiers) > (parseInt(String(sec.max_tables), 10) || 0)
                          ? 'text-red-400'
                          : 'text-gray-500'
                      }`}
                    >
                      Allocated tier tables:{' '}
                      {parseTierSlotsTotal(tiers)}
                      {' / '}
                      {(parseInt(String(sec.max_tables || ''), 10) || 0) || '-'}
                    </p>
                    <p className="text-xs text-gray-500 mb-2">Guests per table and minimum spend (ZAR).</p>
                    <div className="space-y-2">
                      {tiers.map((tier, idx) => (
                        <div key={idx} className="flex gap-2 items-end flex-wrap">
                          <div className="flex-1 min-w-[120px]">
                            <Label className="text-xs text-gray-500">Tier name</Label>
                            <Input
                              value={tier.tier_name || ''}
                              onChange={(e) => {
                                const next = [...(form.hosting_config[cat].tiers || [])];
                                next[idx] = { ...next[idx], tier_name: e.target.value };
                                setForm((p) => ({
                                  ...p,
                                  hosting_config: {
                                    ...p.hosting_config,
                                    [cat]: { ...p.hosting_config[cat], tiers: next },
                                  },
                                }));
                              }}
                              className="mt-1 h-10 rounded-xl"
                              style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                              placeholder={`e.g. ${label} Bronze`}
                            />
                          </div>
                          <div className="flex-1 min-w-[100px]">
                            <Label className="text-xs text-gray-500">Max guests</Label>
                            <Input
                              type="number"
                              min={1}
                              value={tier.max_guests}
                              onChange={(e) => {
                                const next = [...(form.hosting_config[cat].tiers || [])];
                                next[idx] = { ...next[idx], max_guests: e.target.value };
                                setForm((p) => ({
                                  ...p,
                                  hosting_config: {
                                    ...p.hosting_config,
                                    [cat]: { ...p.hosting_config[cat], tiers: next },
                                  },
                                }));
                              }}
                              className="mt-1 h-10 rounded-xl"
                              style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                            />
                          </div>
                          <div className="w-full col-span-2 space-y-2">
                            <label className="flex items-center gap-2 text-xs cursor-pointer">
                              <Checkbox
                                checked={Boolean(tier.include_join_booking_fee)}
                                onCheckedChange={(v) => {
                                  const next = [...(form.hosting_config[cat].tiers || [])];
                                  next[idx] = { ...next[idx], include_join_booking_fee: Boolean(v) };
                                  setForm((p) => ({
                                    ...p,
                                    hosting_config: {
                                      ...p.hosting_config,
                                      [cat]: { ...p.hosting_config[cat], tiers: next },
                                    },
                                  }));
                                }}
                              />
                              Charge join booking fee
                            </label>
                            {createMode !== 'ticketing' && form.has_entrance_fee ? (
                              <label className="flex items-center gap-2 text-xs cursor-pointer">
                                <Checkbox
                                  checked={tier.include_entrance_fee !== false}
                                  onCheckedChange={(v) => {
                                    const next = [...(form.hosting_config[cat].tiers || [])];
                                    next[idx] = { ...next[idx], include_entrance_fee: Boolean(v) };
                                    setForm((p) => ({
                                      ...p,
                                      hosting_config: {
                                        ...p.hosting_config,
                                        [cat]: { ...p.hosting_config[cat], tiers: next },
                                      },
                                    }));
                                  }}
                                />
                                Include entrance fee at checkout
                              </label>
                            ) : null}
                            {tier.include_join_booking_fee ? (
                              <Input
                                type="number"
                                min={0}
                                placeholder="Join fee (ZAR)"
                                value={tier.booking_fee_zar || ''}
                                onChange={(e) => {
                                  const next = [...(form.hosting_config[cat].tiers || [])];
                                  next[idx] = { ...next[idx], booking_fee_zar: e.target.value };
                                  setForm((p) => ({
                                    ...p,
                                    hosting_config: {
                                      ...p.hosting_config,
                                      [cat]: { ...p.hosting_config[cat], tiers: next },
                                    },
                                  }));
                                }}
                                className="h-10 rounded-xl"
                                style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                              />
                            ) : null}
                            <div>
                              <Label className="text-xs text-gray-500">Min spend to join (ZAR)</Label>
                              <Input
                                type="number"
                                min={0}
                                step={0.01}
                                value={tier.min_spend_join ?? tier.min_spend ?? ''}
                                onChange={(e) => {
                                  const next = [...(form.hosting_config[cat].tiers || [])];
                                  next[idx] = { ...next[idx], min_spend_join: e.target.value };
                                  setForm((p) => ({
                                    ...p,
                                    hosting_config: {
                                      ...p.hosting_config,
                                      [cat]: { ...p.hosting_config[cat], tiers: next },
                                    },
                                  }));
                                }}
                                className="mt-1 h-10 rounded-xl"
                                style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                              />
                            </div>
                            <label className="flex items-center gap-2 text-xs cursor-pointer">
                              <Checkbox
                                checked={Boolean(tier.include_host_booking_fee)}
                                onCheckedChange={(v) => {
                                  const next = [...(form.hosting_config[cat].tiers || [])];
                                  next[idx] = { ...next[idx], include_host_booking_fee: Boolean(v) };
                                  setForm((p) => ({
                                    ...p,
                                    hosting_config: {
                                      ...p.hosting_config,
                                      [cat]: { ...p.hosting_config[cat], tiers: next },
                                    },
                                  }));
                                }}
                              />
                              Charge host booking fee
                            </label>
                            {tier.include_host_booking_fee ? (
                              <Input
                                type="number"
                                min={0}
                                placeholder="Host fee (ZAR)"
                                value={tier.host_table_fee_zar || ''}
                                onChange={(e) => {
                                  const next = [...(form.hosting_config[cat].tiers || [])];
                                  next[idx] = { ...next[idx], host_table_fee_zar: e.target.value };
                                  setForm((p) => ({
                                    ...p,
                                    hosting_config: {
                                      ...p.hosting_config,
                                      [cat]: { ...p.hosting_config[cat], tiers: next },
                                    },
                                  }));
                                }}
                                className="h-10 rounded-xl"
                                style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                              />
                            ) : null}
                            <div>
                              <Label className="text-xs text-gray-500">Min spend to host (ZAR)</Label>
                              <Input
                                type="number"
                                min={0}
                                step={0.01}
                                value={tier.min_spend_host ?? tier.min_spend ?? ''}
                                onChange={(e) => {
                                  const next = [...(form.hosting_config[cat].tiers || [])];
                                  next[idx] = { ...next[idx], min_spend_host: e.target.value };
                                  setForm((p) => ({
                                    ...p,
                                    hosting_config: {
                                      ...p.hosting_config,
                                      [cat]: { ...p.hosting_config[cat], tiers: next },
                                    },
                                  }));
                                }}
                                className="mt-1 h-10 rounded-xl"
                                style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                              />
                            </div>
                          </div>
                          <div className="flex-1 min-w-[120px]">
                            <Label className="text-xs text-gray-500">Hosted tables (tier)</Label>
                            <Input
                              type="number"
                              min={1}
                              value={tier.tier_table_slots || ''}
                              onChange={(e) => {
                                const next = [...(form.hosting_config[cat].tiers || [])];
                                const raw = e.target.value;
                                const nextSlots = parseInt(String(raw || ''), 10) || 0;
                                const maxTables = parseInt(String(form.hosting_config?.[cat]?.max_tables || ''), 10) || 0;
                                const usedByOthers = next.reduce(
                                  (acc, row, rowIdx) =>
                                    rowIdx === idx ? acc : acc + (parseInt(String(row?.tier_table_slots || ''), 10) || 0),
                                  0,
                                );
                                if (maxTables > 0 && nextSlots + usedByOthers > maxTables) {
                                  toast.error(
                                    `${label} tier allocations cannot exceed ${maxTables} total hosted tables for this category.`,
                                  );
                                  return;
                                }
                                next[idx] = { ...next[idx], tier_table_slots: raw };
                                setForm((p) => ({
                                  ...p,
                                  hosting_config: {
                                    ...p.hosting_config,
                                    [cat]: { ...p.hosting_config[cat], tiers: next },
                                  },
                                }));
                              }}
                              className="mt-1 h-10 rounded-xl"
                              style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
                            />
                          </div>
                          {venueMenuItems.length > 0 && (
                            <div className="w-full mt-2">
                              <Label className="text-xs text-gray-500">
                                Items included with this table (free for guests)
                              </Label>
                              <TierIncludedItemsEditor
                                includedItems={tier.included_items || []}
                                venueMenuItems={venueMenuItems}
                                onChange={(items) => {
                                  const next = [...(form.hosting_config[cat].tiers || [])];
                                  next[idx] = { ...next[idx], included_items: items };
                                  setForm((p) => ({
                                    ...p,
                                    hosting_config: {
                                      ...p.hosting_config,
                                      [cat]: { ...p.hosting_config[cat], tiers: next },
                                    },
                                  }));
                                }}
                              />
                            </div>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-10 text-red-400"
                            onClick={() =>
                              setForm((p) => ({
                                ...p,
                                hosting_config: {
                                  ...p.hosting_config,
                                  [cat]: {
                                    ...p.hosting_config[cat],
                                    tiers: (p.hosting_config[cat].tiers || []).filter((_, i) => i !== idx),
                                  },
                                },
                              }))
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
            <div>
              <Label className="text-gray-400 text-sm">Description</Label>
              <Textarea
                value={form.description}
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                placeholder="Event details..."
                className="mt-1.5 rounded-xl resize-none"
                style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                rows={3}
              />
            </div>
            <div>
              <Label className="text-gray-400 text-sm">Cover image</Label>
              {form.cover_image_url ? (
                <img
                  src={form.cover_image_url}
                  alt=""
                  className="mt-2 max-h-36 rounded-lg border object-contain"
                  style={{ borderColor: 'var(--sec-border)' }}
                />
              ) : null}
              <Input
                type="file"
                accept="image/*"
                disabled={coverUploading}
                className="mt-1.5 rounded-xl cursor-pointer"
                style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}
                onChange={coverCrop.handleInputChange}
              />
              <p className="text-xs text-gray-500 mt-1">Upload a file (required to publish).</p>
            </div>
            <div>
              <Label className="text-gray-400 text-sm">Assign promoters</Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Choose hired promoters to promote this event with their personal referral links.
              </p>
              {venuePromoters.length === 0 ? (
                <p className="text-xs text-gray-500 p-3 rounded-xl" style={{ backgroundColor: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)' }}>
                  Hire promoters from Jobs first — they will appear here.
                </p>
              ) : (
                <div className="flex flex-col gap-2 max-h-40 overflow-y-auto">
                  {venuePromoters.map((p) => (
                    <label
                      key={p.promoterUserId}
                      className="flex items-center gap-3 p-2 rounded-xl cursor-pointer"
                      style={{ backgroundColor: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)' }}
                    >
                      <Checkbox
                        checked={selectedPromoterIds.includes(p.promoterUserId)}
                        onCheckedChange={() => togglePromoter(p.promoterUserId)}
                      />
                      <span className="text-sm">{p.username || p.fullName || 'Promoter'}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div>
              <Label className="text-gray-400 text-sm">Status</Label>
              <Select value={form.status} onValueChange={v => setForm(p => ({ ...p, status: v }))}>
                <SelectTrigger className="mt-1.5 h-11 rounded-xl" style={{ backgroundColor: 'var(--sec-bg-elevated)', borderColor: 'var(--sec-border)' }}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }} className="text-white">
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-3 pt-2 pb-1">
              <Button variant="outline" onClick={closeDialog} className="flex-1 h-11 rounded-xl" style={{ borderColor: 'var(--sec-border)' }}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={saveMutation.isPending}
                className="flex-1 h-11 rounded-xl font-semibold"
                style={{ backgroundColor: 'var(--sec-accent)', color: '#000' }}
              >
                {saveMutation.isPending ? <Loader2 size={16} className="animate-spin mr-1.5" /> : null}
                {editingEvent ? 'Update' : 'Create'}
              </Button>
            </div>
          </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Event table listings */}
      <Dialog open={!!tablesEventId} onOpenChange={(open) => !open && setTablesEventId(null)}>
        <DialogContent
          className="text-white sm:max-w-[560px] max-h-[85vh] overflow-y-auto p-0 gap-0"
          style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}
        >
          <div className="p-6 pb-4 border-b" style={{ borderColor: 'var(--sec-border)' }}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Armchair size={18} style={{ color: 'var(--sec-accent)' }} />
                Event tables
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-gray-400 mt-2 leading-relaxed">
              {tablesEvent?.title || 'Event'} — live guest counts per table. Remove empty slots from listings without affecting guests already booked.
            </p>
            {eventTablesData?.summary ? (
              <div className="flex flex-wrap gap-2 mt-4">
                {[
                  ['In use', eventTablesData.summary.inUse, 'var(--sec-accent)'],
                  ['Available', eventTablesData.summary.available, '#34d399'],
                  ['Hidden', eventTablesData.summary.hidden, '#9ca3af'],
                ].map(([label, count, color]) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full"
                    style={{
                      background: 'var(--sec-bg-elevated)',
                      border: '1px solid var(--sec-border)',
                      color,
                    }}
                  >
                    {label}: {count}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          {eventTablesLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="animate-spin" style={{ color: 'var(--sec-accent)' }} />
            </div>
          ) : (eventTablesData?.items || []).length === 0 ? (
            <p className="text-sm text-gray-500 py-10 px-6 text-center">
              No table slots for this event yet. Table-hosting events generate slots from hosting tiers; ticketed events only show slots if tables were synced.
            </p>
          ) : (
            <div className="space-y-3 p-4">
              {(eventTablesData?.items || []).map((t) => {
                const isVip =
                  t.hostingCategory === 'VIP' ||
                  String(t.hostingTierKey || '').startsWith('vip') ||
                  /vip/i.test(String(t.tierLabel || t.tableName || ''));
                const statusColor = t.inUse
                  ? 'var(--sec-accent)'
                  : t.isActive
                    ? '#34d399'
                    : '#9ca3af';
                return (
                  <div
                    key={t.id}
                    className="rounded-2xl border overflow-hidden"
                    style={{
                      borderColor: t.inUse ? 'var(--sec-accent-border)' : 'var(--sec-border)',
                      background: t.inUse
                        ? 'linear-gradient(160deg, var(--sec-bg-elevated) 0%, var(--sec-bg-card) 100%)'
                        : 'var(--sec-bg-elevated)',
                    }}
                  >
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-semibold text-sm truncate">{t.tableName}</p>
                            {isVip ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full"
                                style={{ color: 'var(--sec-accent)', background: 'var(--sec-accent-muted)', border: '1px solid var(--sec-accent-border)' }}>
                                <Crown size={10} /> VIP
                              </span>
                            ) : null}
                          </div>
                          <p className="text-xs text-gray-500 mt-1">{t.tierLabel || 'Table slot'}</p>
                          {(t.tableSessionNumber ?? 1) > 1 ? (
                            <p className="text-[10px] text-gray-500 mt-1">Session {t.tableSessionNumber}</p>
                          ) : null}
                          {t.hostLabel ? (
                            <p className="text-xs mt-1.5 inline-flex items-center gap-1 text-gray-400">
                              <UserCheck size={12} style={{ color: 'var(--sec-accent)' }} />
                              Host: {t.hostLabel}
                            </p>
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
                            <span className="inline-flex items-center gap-1.5 text-gray-300">
                              <Users size={13} style={{ color: 'var(--sec-accent)' }} />
                              {t.usageLabel}
                            </span>
                            <span className="text-gray-500">{t.spotsRemaining ?? 0} spots left</span>
                          </div>
                          <div
                            className="h-1.5 rounded-full overflow-hidden"
                            style={{ background: 'rgba(255,255,255,0.06)' }}
                          >
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${t.fillPercent ?? 0}%`,
                                background: 'linear-gradient(90deg, var(--sec-accent), #e8c547)',
                              }}
                            />
                          </div>
                          {t.hasJoiningFee && t.joiningFee > 0 ? (
                            <p className="text-[11px] text-gray-500 mt-2">
                              Joining fee: R{Number(t.joiningFee).toFixed(0)}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-xs mt-2 text-gray-500">{t.usageLabel}</p>
                      )}
                    </div>

                    {(t.canResetTable || t.canHideFromListings || t.canRestoreToListings) && (
                      <div
                        className="px-4 py-3 border-t flex justify-end gap-2 flex-wrap"
                        style={{ borderColor: 'var(--sec-border)', background: 'rgba(0,0,0,0.2)' }}
                      >
                        {t.canResetTable ? (
                          <Button
                            size="sm"
                            className="h-8 text-xs sec-btn-secondary"
                            disabled={resettingTableId === t.id || hidingTableId === t.id}
                            onClick={() => resetTableForRelisting(t.id)}
                          >
                            {resettingTableId === t.id ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              'Reset table'
                            )}
                          </Button>
                        ) : null}
                        {t.canHideFromListings ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={hidingTableId === t.id}
                            className="h-8 text-xs"
                            style={{ borderColor: 'var(--sec-border)' }}
                            onClick={() => hideTableFromListings(t.id)}
                          >
                            {hidingTableId === t.id ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              'Remove from listings'
                            )}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={hidingTableId === t.id}
                            className="h-8 text-xs"
                            style={{ borderColor: 'var(--sec-accent-border)', color: 'var(--sec-accent)' }}
                            onClick={() => restoreTableToListings(t.id)}
                          >
                            Restore to listings
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="text-white sm:max-w-[380px]" style={{ backgroundColor: 'var(--sec-bg-card)', borderColor: 'var(--sec-border)' }}>
          <DialogHeader>
            <DialogTitle>Delete Event</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-400 mt-1">Are you sure you want to delete this event? This action cannot be undone.</p>
          <div className="flex gap-3 mt-4">
            <Button variant="outline" onClick={() => setDeleteId(null)} className="flex-1 h-10 rounded-xl" style={{ borderColor: 'var(--sec-border)' }}>
              Cancel
            </Button>
            <Button
              onClick={() => deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
              className="flex-1 h-10 rounded-xl text-white font-semibold"
              style={{ backgroundColor: 'var(--sec-error)' }}
            >
              {deleteMutation.isPending ? <Loader2 size={16} className="animate-spin mr-1.5" /> : null}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ImageCropDialog
        open={coverCrop.cropOpen}
        onOpenChange={coverCrop.onCropOpenChange}
        imageSrc={coverCrop.cropSrc}
        title="Crop event cover"
        onCropped={coverCrop.handleCropped}
        outputFileName="event-cover.jpg"
        {...EVENT_COVER_CROP_DIALOG_PROPS}
      />
      <FeedBoostDialog
        open={Boolean(boostEvent)}
        onOpenChange={(open) => {
          if (!open) setBoostEvent(null);
        }}
        title={boostEvent ? `Boost “${boostEvent.title}”` : 'Boost event'}
        description="Boosted events show up more often on Home and in Discover while the boost is active."
        maxDays={
          boostEvent
            ? maxBoostDaysUntil(
                boostEvent.ends_at ||
                  (boostEvent.date ? `${boostEvent.date}T23:59:59` : null),
              )
            : 1
        }
        busy={boostBusy}
        onConfirm={async (days) => {
          if (!boostEvent?.id) return;
          setBoostBusy(true);
          try {
            const pay = await apiPost(`/api/events/${boostEvent.id}/boost`, { days });
            if (!pay?.reference || !pay?.access_code) throw new Error('Could not start payment');
            await launchPaystackInline({
              email: user?.email,
              amount: pay.amount_zar,
              reference: pay.reference,
              accessCode: pay.access_code,
              authorizationUrl: pay.authorization_url,
              onSuccess: async (payload) => {
                await completePaystackCheckout({
                  reference: pay.reference,
                  payload,
                  queryClient,
                  showToasts: false,
                });
                toast.success('Event boost is active');
                setBoostEvent(null);
                queryClient.invalidateQueries({ queryKey: ['biz-events'] });
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
      <EventPurchaseLogDialog
        open={Boolean(purchaseLog)}
        onOpenChange={(open) => {
          if (!open) setPurchaseLog(null);
        }}
        data={purchaseLog}
      />
      </div>
    </div>
  );
}
