import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { createPageUrl, getPublicAppOrigin } from '@/utils';
import { hostedListingDetailsPath } from '@/lib/hostedListingUrl';
import * as authService from '@/services/authService';
import { dataService } from '@/services/dataService';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Plus, Loader2, Armchair, Users, Star, Calendar, MapPin } from 'lucide-react';
import SecLogo from '@/components/ui/SecLogo';
import GoogleAddressInput from '@/components/GoogleAddressInput';
import { Input } from '@/components/ui/input';
import { launchPaystackInline } from '@/lib/paystackInline';
import { completePaystackCheckout } from '@/lib/completePaystackCheckout';
import ImageCropDialog from '@/components/profile/ImageCropDialog';
import { useImageCropUpload } from '@/hooks/useImageCropUpload';
import { uploadHostedTablePhotoFile } from '@/lib/uploadHostedTablePhoto';
import { COVER_CROP_DIALOG_PROPS } from '@/lib/coverImageAspect';
import HostedTableHostCard from '@/components/host/HostedTableHostCard';
import FeedBoostDialog, {
  FEED_BOOST_ZAR_PER_DAY,
  maxBoostDaysUntil,
} from '@/components/business/FeedBoostDialog';
import { splitHostDashboardTables } from '@/lib/hostTableDashboard';
import PageBackHeader from '@/components/layout/PageBackHeader';
import WeeklyPayoutNotice from '@/components/wallet/WeeklyPayoutNotice';
import { useIsMobile } from '@/hooks/useIsDesktop';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';

function formatVenueAddressForSubmit({ venueAddress, suburb, province }) {
  const base = String(venueAddress || '').trim();
  const parts = [base];
  const sub = String(suburb || '').trim();
  const prov = String(province || '').trim();
  if (sub && !base.toLowerCase().includes(sub.toLowerCase())) parts.push(sub);
  if (prov && !base.toLowerCase().includes(prov.toLowerCase())) parts.push(prov);
  return parts.filter(Boolean).join(', ');
}

/** Hosted table row uses HostedTableStatus (DRAFT / ACTIVE / FULL). */
const TABLE_HOST_STATUS_BADGE = {
  DRAFT: { label: 'Awaiting listing payment', bg: 'var(--sec-warning-muted)', color: 'var(--sec-text-primary)' },
  ACTIVE: { label: 'Live', bg: 'var(--sec-success-muted)', color: 'var(--sec-text-primary)' },
  FULL: { label: 'Full', bg: 'var(--sec-bg-hover)', color: 'var(--sec-text-muted)' },
  CLOSED: { label: 'Closed', bg: 'var(--sec-bg-hover)', color: 'var(--sec-text-muted)' },
};

export default function HostDashboard() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('tables');
  const { data: walletSummary } = useQuery({
    queryKey: ['sec-wallet-me'],
    queryFn: () => apiGet('/api/wallet/me'),
    staleTime: 60_000,
  });
  const [tablesSubTab, setTablesSubTab] = useState('upcoming');
  const [showTableModal, setShowTableModal] = useState(false);
  const createFormScrollRef = useRef(null);
  const [tableForm, setTableForm] = useState({
    tableType: 'EXTERNAL_VENUE',
    listingSurface: 'TABLE',
    tableName: '',
    tableDescription: '',
    eventType: 'CLUB_TABLE',
    eventId: '',
    venueName: '',
    venueAddress: '',
    suburb: '',
    province: '',
    latitude: null,
    longitude: null,
    eventDate: '',
    eventTime: '21:00',
    eventEndDate: '',
    eventEndTime: '23:59',
    guestQuantity: 4,
    hostingCategory: 'GENERAL',
    hostingTierIndex: 0,
    tierMaxGuests: null,
    hasJoiningFee: false,
    joiningFee: '',
    photo: '',
    photoPublicId: '',
    drinkPreferences: '',
    desiredCompany: '',
    isPublic: true,
  });
  const [locatingAddress, setLocatingAddress] = useState(false);
  const [boostTarget, setBoostTarget] = useState(null);
  const [boostBusy, setBoostBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingTableId, setPendingTableId] = useState(null);
  const [inviteOpenTableId, setInviteOpenTableId] = useState(null);
  const [inviteSearch, setInviteSearch] = useState('');
  const [manageTableId, setManageTableId] = useState(null);
  const [rulesForm, setRulesForm] = useState({
    tableName: '',
    isPublic: true,
    hasJoiningFee: false,
    joiningFee: '',
    photo: '',
    photoPublicId: '',
    eventDate: '',
    eventTime: '',
    eventEndDate: '',
    eventEndTime: '',
  });
  const [rulesPhotoPreview, setRulesPhotoPreview] = useState('');
  const [savingRules, setSavingRules] = useState(false);
  const [approvingUserId, setApprovingUserId] = useState(null);

  const createTablePhotoCrop = useImageCropUpload({
    onCropped: async (file) => {
      try {
        const result = await uploadHostedTablePhotoFile(file);
        if (!result) return;
        setTableForm((f) => ({ ...f, photo: result.imageUrl, photoPublicId: result.imagePublicId }));
      } catch (e) {
        toast.error(e?.message || 'Photo upload failed');
      }
    },
  });

  const manageTablePhotoCrop = useImageCropUpload({
    onCropped: async (file) => {
      try {
        const result = await uploadHostedTablePhotoFile(file);
        if (!result) return;
        setRulesForm((f) => ({ ...f, photo: result.imageUrl, photoPublicId: result.imagePublicId }));
        setRulesPhotoPreview(result.imageUrl);
      } catch (e) {
        toast.error(e?.message || 'Photo upload failed');
      }
    },
  });

  useEffect(() => {
    authService
      .requireAuthOrLogin(window.location.href)
      .then(async ({ user: u }) => {
        setUser(u);
        await dataService.User.filter({ created_by: u.email });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const c = searchParams.get('create');
    const preEventId = searchParams.get('event');
    if (c === 'party') {
      toast.message('House parties are no longer available', {
        description: 'Browse SEC events or host at your own venue instead.',
      });
      navigate(createPageUrl('Events'), { replace: true });
      return;
    }
    if (c === 'table') {
      if (preEventId) {
        navigate(createPageUrl(`EventDetails?id=${preEventId}`));
        return;
      }
      setShowTableModal(true);
      setTab('tables');
    }
    if (c === 'invite') {
      setTab('tables');
      setSearchParams({}, { replace: true });
    }
    if (searchParams.get('tab') === 'tables') setTab('tables');
    if (searchParams.get('tab') === 'activity') setTab('activity');
  }, [searchParams, setSearchParams, navigate]);

  useEffect(() => {
    if (searchParams.get('create') !== 'table') {
      setShowTableModal(false);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!inviteOpenTableId) setInviteSearch('');
  }, [inviteOpenTableId]);

  useBodyScrollLock(showTableModal);

  useEffect(() => {
    const onRejected = () => toast.error('Please choose an image file');
    window.addEventListener('sec-image-crop-rejected', onRejected);
    return () => window.removeEventListener('sec-image-crop-rejected', onRejected);
  }, []);

  useEffect(() => {
    if (!showTableModal || !isMobile) return undefined;

    let root = null;
    let cancelled = false;

    const onFocusIn = (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      window.requestAnimationFrame(() => {
        try {
          target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        } catch {
          /* ignore */
        }
      });
    };

    const attach = () => {
      if (cancelled) return;
      root = createFormScrollRef.current;
      if (!root) {
        window.requestAnimationFrame(attach);
        return;
      }
      root.addEventListener('focusin', onFocusIn);
    };
    attach();

    return () => {
      cancelled = true;
      root?.removeEventListener('focusin', onFocusIn);
    };
  }, [showTableModal, isMobile]);

  function closeTableModal() {
    setShowTableModal(false);
    setSearchParams({}, { replace: true });
  }

  const inviteUserSearchQ = useQuery({
    queryKey: ['host-invite-user-search', inviteSearch.trim()],
    queryFn: () => apiGet(`/api/host/invite-user-search?q=${encodeURIComponent(inviteSearch.trim())}`),
    enabled: Boolean(inviteOpenTableId && inviteSearch.trim().length >= 2),
    staleTime: 20_000,
  });

  const { data: tables = [], isLoading: loadT } = useQuery({
    queryKey: ['host-tables', user?.id],
    queryFn: () => apiGet('/api/host/tables'),
    enabled: !!user?.id,
  });

  const { upcoming: upcomingTables, past: pastTables } = useMemo(
    () => splitHostDashboardTables(tables),
    [tables],
  );

  useEffect(() => {
    const requestsTableId = searchParams.get('requests');
    if (!requestsTableId) return;
    setTab('tables');
    setPendingTableId(requestsTableId);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('requests');
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (searchParams.get('manage') !== '1' || !upcomingTables.length) return;
    const firstInApp = upcomingTables.find((t) => t.tableType === 'IN_APP_EVENT' && t.status === 'ACTIVE');
    if (!firstInApp) return;
    setTab('tables');
    setManageTableId(firstInApp.id);
    setRulesForm({
      tableName: firstInApp.tableName || '',
      isPublic: firstInApp.isPublic !== false,
      hasJoiningFee: Boolean(firstInApp.hasJoiningFee),
      joiningFee: firstInApp.joiningFee ? String(firstInApp.joiningFee) : '',
    });
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('manage');
      return next;
    }, { replace: true });
  }, [searchParams, upcomingTables, setSearchParams]);

  const { data: activity } = useQuery({
    queryKey: ['host-activity', user?.id],
    queryFn: () => apiGet('/api/host/activity/summary'),
    enabled: !!user?.id,
  });

  const { data: pendingRequests = [], refetch: refetchPending, isFetching: pendingLoading } = useQuery({
    queryKey: ['host-table-pending', pendingTableId],
    queryFn: () => apiGet(`/api/host/tables/${pendingTableId}/pending-requests`),
    enabled: !!pendingTableId,
  });

  const submitTable = async () => {
    setSaving(true);
    try {
      if (!tableForm.venueName || !tableForm.eventDate) {
        toast.error('Place name and date required');
        setSaving(false);
        return;
      }
      if (!tableForm.venueAddress?.trim()) {
        toast.error('Enter the address so guests know where to meet');
        setSaving(false);
        return;
      }
      if (!tableForm.tableName?.trim()) {
        toast.error('Add a title for your listing');
        setSaving(false);
        return;
      }
      if (!tableForm.eventEndDate || !tableForm.eventEndTime) {
        toast.error('Add an end date and end time for your listing');
        setSaving(false);
        return;
      }
      const created = await apiPost('/api/host/tables', {
        tableType: 'EXTERNAL_VENUE',
        listingSurface: tableForm.listingSurface === 'EVENT' ? 'EVENT' : 'TABLE',
        tableName: tableForm.tableName.trim(),
        tableDescription: tableForm.tableDescription || null,
        eventType: tableForm.eventType,
        venueName: tableForm.venueName,
        venueAddress: formatVenueAddressForSubmit(tableForm),
        eventDate: new Date(tableForm.eventDate).toISOString(),
        eventTime: tableForm.eventTime,
        eventEndDate: new Date(tableForm.eventEndDate).toISOString(),
        eventEndTime: tableForm.eventEndTime,
        guestQuantity: tableForm.guestQuantity,
        hasJoiningFee: tableForm.hasJoiningFee,
        joiningFee: tableForm.hasJoiningFee ? Number(tableForm.joiningFee) : null,
        photo: tableForm.photo || null,
        photoPublicId: tableForm.photoPublicId || null,
        drinkPreferences: tableForm.drinkPreferences || null,
        desiredCompany: tableForm.desiredCompany || null,
        isPublic: tableForm.isPublic,
      });
      if (created?.payment?.reference && created?.payment?.access_code) {
        launchPaystackInline({
          email: user?.email,
          amount: 200,
          reference: created.payment.reference,
          accessCode: created.payment.access_code,
          onSuccess: async (payload) => {
            await completePaystackCheckout({
              reference: created.payment.reference,
              payload,
              queryClient,
              showToasts: false,
              pollUntilFulfilled: true,
              pollMaxMs: 45000,
            });
            queryClient.invalidateQueries({ queryKey: ['host-tables'] });
            queryClient.invalidateQueries({ queryKey: ['home-bootstrap'] });
            const asEvent = tableForm.listingSurface === 'EVENT';
            toast.success(
              asEvent
                ? 'Listing is live — it appears under Upcoming Events on Home.'
                : 'Listing is live — it appears under Available Tables on Home.',
            );
            setShowTableModal(false);
            setSearchParams({}, { replace: true });
          },
          onCancel: () => {
            toast.message('Checkout closed', {
              description: 'Your listing stays in draft until you complete the listing payment.',
            });
            queryClient.invalidateQueries(['host-tables']);
          },
        });
        return;
      }
      queryClient.invalidateQueries(['host-tables']);
      toast.success('Listing published');
      setShowTableModal(false);
      setSearchParams({}, { replace: true });
    } catch (e) {
      toast.error(e?.message || 'Could not create listing');
    } finally {
      setSaving(false);
    }
  };

  const boostTable = async (id) => {
    const row = (tables || []).find((t) => t.id === id);
    setBoostTarget({
      id,
      name: row?.tableName || row?.venueName || 'Listing',
      endAt: row?.eventDate || row?.windowEndsAt || null,
    });
  };

  const confirmBoostDays = async (days) => {
    if (!boostTarget?.id) return;
    setBoostBusy(true);
    try {
      const pay = await apiPost(`/api/host/tables/${boostTarget.id}/boost`, { days });
      if (!pay?.reference || !pay?.access_code) throw new Error('Could not start payment');
      await launchPaystackInline({
        email: user?.email,
        amount: pay.amount_zar ?? days * FEED_BOOST_ZAR_PER_DAY,
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
          queryClient.invalidateQueries({ queryKey: ['host-tables'] });
          queryClient.invalidateQueries({ queryKey: ['home-bootstrap'] });
          queryClient.invalidateQueries({ queryKey: ['home-table-offerings'] });
          toast.success(`Listing boosted for ${days} day${days === 1 ? '' : 's'}`);
          setBoostTarget(null);
        },
        onCancel: () => toast.message('Boost checkout cancelled'),
      });
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Payment failed to start');
    } finally {
      setBoostBusy(false);
    }
  };

  const copyHostedTableLink = async (tableId) => {
    const row = (tables || []).find((t) => t.id === tableId) || { id: tableId };
    const url = `${getPublicAppOrigin()}${hostedListingDetailsPath(row)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(row.listingSurface === 'EVENT' ? 'Event link copied' : 'Table link copied');
    } catch {
      toast.error('Could not copy link');
    }
  };

  const startRetryListingPayment = async (tableId) => {
    try {
      const pay = await apiPost(`/api/host/tables/${encodeURIComponent(tableId)}/retry-listing-payment`, {});
      if (pay?.reference && pay?.access_code) {
        launchPaystackInline({
          email: user?.email,
          amount: Number(pay.amount_zar || 0),
          reference: pay.reference,
          accessCode: pay.access_code,
          onSuccess: async (payload) => {
            await completePaystackCheckout({
              reference: pay.reference,
              payload,
              queryClient,
              showToasts: false,
              pollUntilFulfilled: true,
              pollMaxMs: 45000,
            });
            queryClient.invalidateQueries({ queryKey: ['host-tables', user?.id] });
            queryClient.invalidateQueries({ queryKey: ['home-bootstrap'] });
            toast.success('Payment received — your listing is live on Home.');
          },
          onCancel: () => {
            toast.message('Checkout closed', {
              description: 'Your listing stays in draft until payment succeeds. You can retry from My Tables/Events.',
            });
            queryClient.invalidateQueries({ queryKey: ['host-tables', user?.id] });
          },
        });
      } else {
        toast.message('Nothing to pay', {
          description: 'This listing may already be paid or does not require checkout.',
        });
      }
    } catch (e) {
      const code = e?.data?.code || e?.response?.data?.code;
      if (code === 'TABLE_HOST_FEE_RETIRED') {
        toast.error('This listing checkout is retired. Host from the event or day booking page instead.');
        return;
      }
      toast.error(e?.message || e?.data?.error || 'Could not start checkout');
    }
  };

  const deleteTable = async (tableId) => {
    try {
      await apiDelete(`/api/host/tables/${tableId}`);
      queryClient.invalidateQueries({ queryKey: ['host-tables'] });
      queryClient.invalidateQueries({ queryKey: ['home-table-offerings'] });
      toast.success('Table removed');
    } catch (e) {
      toast.error(e?.message || 'Could not delete table');
      throw e;
    }
  };

  const renderHostedTableCard = (t, { isPast = false } = {}) => {
    const loc =
      t.eventLocation?.displayLabel ||
      [t.venueAddress, t.venueName].filter(Boolean).join(' · ') ||
      t.venueName;
    const hostStatusBadge = TABLE_HOST_STATUS_BADGE[t.status] || TABLE_HOST_STATUS_BADGE.DRAFT;
    return (
      <HostedTableHostCard
        key={t.id}
        table={t}
        isPast={isPast}
        hostStatusBadge={hostStatusBadge}
        loc={loc}
        manageTableId={manageTableId}
        inviteOpenTableId={inviteOpenTableId}
        pendingTableId={pendingTableId}
        rulesForm={rulesForm}
        setRulesForm={setRulesForm}
        savingRules={savingRules}
        photoPreviewUrl={manageTableId === t.id ? rulesPhotoPreview : ''}
        onPayListing={startRetryListingPayment}
        onCopyLink={copyHostedTableLink}
        onBoost={boostTable}
        onDelete={deleteTable}
        onManageToggle={(row) => {
          const opening = manageTableId !== row.id;
          setManageTableId(opening ? row.id : null);
          setRulesPhotoPreview('');
          if (opening) {
            const startYmd = row.eventDate
              ? String(row.eventDate).slice(0, 10)
              : '';
            const endYmd = row.eventEndDate
              ? String(row.eventEndDate).slice(0, 10)
              : startYmd;
            setRulesForm({
              tableName: row.tableName || '',
              isPublic: row.isPublic !== false,
              hasJoiningFee: Boolean(row.hasJoiningFee),
              joiningFee: row.joiningFee ? String(row.joiningFee) : '',
              photo: row.photo || '',
              photoPublicId: row.photoPublicId || '',
              eventDate: startYmd,
              eventTime: row.eventTime || '21:00',
              eventEndDate: endYmd,
              eventEndTime: row.eventEndTime || '23:59',
            });
          }
        }}
        onInviteToggle={(id) => setInviteOpenTableId((cur) => (cur === id ? null : id))}
        onReviewToggle={(id) => setPendingTableId((cur) => (cur === id ? null : id))}
        onPhotoInputChange={manageTablePhotoCrop.handleInputChange}
        onSaveRules={async (row) => {
          setSavingRules(true);
          try {
            const payload = {
              ...(rulesForm.photo ? { photo: rulesForm.photo, photoPublicId: rulesForm.photoPublicId || null } : {}),
              tableName: rulesForm.tableName.trim() || row.tableName,
            };
            if (row.tableType === 'IN_APP_EVENT') {
              Object.assign(payload, {
                isPublic: rulesForm.isPublic,
                hasJoiningFee: rulesForm.hasJoiningFee,
                joiningFee: rulesForm.hasJoiningFee ? Number(rulesForm.joiningFee) || 10 : null,
              });
            } else if (row.tableType === 'EXTERNAL_VENUE' && !row.venueTableId && !row.eventId) {
              Object.assign(payload, {
                eventDate: rulesForm.eventDate ? new Date(rulesForm.eventDate).toISOString() : undefined,
                eventTime: rulesForm.eventTime,
                eventEndDate: rulesForm.eventEndDate
                  ? new Date(rulesForm.eventEndDate).toISOString()
                  : undefined,
                eventEndTime: rulesForm.eventEndTime,
              });
            }
            await apiPatch(`/api/host/tables/${row.id}`, payload);
            toast.success('Listing settings updated');
            setRulesPhotoPreview('');
            queryClient.invalidateQueries({ queryKey: ['host-tables'] });
            queryClient.invalidateQueries({ queryKey: ['home-bootstrap'] });
            queryClient.invalidateQueries({ queryKey: ['home-table-offerings'] });
            queryClient.invalidateQueries({ queryKey: ['home-feed'] });
          } catch (err) {
            toast.error(err?.data?.error || err?.message || 'Could not save settings');
          } finally {
            setSavingRules(false);
          }
        }}
        childrenInvite={
          !isPast && t.status === 'ACTIVE' && inviteOpenTableId === t.id ? (
            <div className="mt-3 rounded-xl border border-[var(--sec-border)] bg-[var(--sec-bg-elevated)] p-3 space-y-2">
              <p className="text-[11px] text-[var(--sec-text-muted)]">
                Search by username or name. Only people with an SEC account receive the in-app invite. Private
                tables: you can invite anyone registered — they do not need to be friends with you.
              </p>
              <Input
                placeholder="Type at least 2 characters…"
                value={inviteSearch}
                onChange={(e) => setInviteSearch(e.target.value)}
                className="bg-[var(--sec-bg-card)] border-[var(--sec-border)]"
              />
              {inviteUserSearchQ.isFetching ? (
                <p className="text-xs text-[var(--sec-text-muted)] flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Searching…
                </p>
              ) : inviteSearch.trim().length >= 2 ? (
                <ul className="max-h-40 overflow-y-auto space-y-1">
                  {(inviteUserSearchQ.data || []).length === 0 ? (
                    <li className="text-xs text-[var(--sec-text-muted)] px-1 py-2">No matches</li>
                  ) : (
                    (inviteUserSearchQ.data || []).map((u) => (
                      <li
                        key={u.id}
                        className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--sec-bg-hover)]"
                      >
                        <div className="min-w-0 text-sm">
                          <span className="font-medium text-white">@{u.username || 'user'}</span>
                          {u.fullName ? (
                            <span className="text-[var(--sec-text-muted)] text-xs ml-1 truncate">{u.fullName}</span>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="text-[10px] sec-btn sec-btn-primary py-1 px-2 rounded-lg shrink-0"
                          onClick={async () => {
                            try {
                              await apiPost(`/api/host/tables/${t.id}/invite`, { inviteeUserId: u.id });
                              toast.success('Invite sent');
                              setInviteOpenTableId(null);
                              setInviteSearch('');
                              queryClient.invalidateQueries({ queryKey: ['host-tables'] });
                            } catch (err) {
                              toast.error(err?.message || 'Could not send invite');
                            }
                          }}
                        >
                          Invite
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              ) : (
                <p className="text-[11px] text-[var(--sec-text-muted)]">Enter 2+ characters to search.</p>
              )}
            </div>
          ) : null
        }
        childrenPending={
          !isPast && pendingTableId === t.id ? (
            <div className="mt-3 space-y-2 border-t border-[var(--sec-border)] pt-3">
              {pendingLoading ? (
                <p className="text-xs text-[var(--sec-text-muted)]">Loading…</p>
              ) : (pendingRequests || []).length === 0 ? (
                <p className="text-xs text-[var(--sec-text-muted)]">No pending requests.</p>
              ) : (
                (pendingRequests || []).map((pr) => (
                  <div
                    key={pr.id}
                    className="flex items-center justify-between gap-2 p-2 rounded-xl bg-[var(--sec-bg-elevated)]"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {pr.user?.avatarUrl ? (
                        <img src={pr.user.avatarUrl} alt="" className="w-9 h-9 rounded-full object-cover" />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-[var(--sec-border)] flex items-center justify-center text-xs">
                          {(pr.user?.username || '?')[0]}
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">@{pr.user?.username}</div>
                        <div className="text-[10px] text-[var(--sec-text-muted)] truncate">{pr.user?.fullName}</div>
                        {pr.user?.gender && (
                          <div className="text-[10px] text-[var(--sec-text-muted)] mt-0.5">Gender: {pr.user.gender}</div>
                        )}
                        {pr.user?.city && (
                          <div className="text-[10px] text-[var(--sec-text-muted)]">City: {pr.user.city}</div>
                        )}
                        {pr.user?.bio && (
                          <div className="text-[10px] text-[var(--sec-text-muted)] line-clamp-2 mt-1">{pr.user.bio}</div>
                        )}
                        {pr.decisionLabel && (
                          <div className="text-[10px] text-[var(--sec-accent)] mt-1">{pr.decisionLabel}</div>
                        )}
                        {(pr.user?.date_of_birth || pr.user?.verification_status) && (
                          <div className="text-[10px] text-[var(--sec-text-muted)] mt-0.5">
                            {pr.user?.date_of_birth ? `DOB: ${String(pr.user.date_of_birth).slice(0, 10)}` : ''}
                            {pr.user?.date_of_birth && pr.user?.verification_status ? ' · ' : ''}
                            {pr.user?.verification_status ? `Verified: ${pr.user.verification_status}` : ''}
                          </div>
                        )}
                        {pr.user?.id && (
                          <Link
                            to={`${createPageUrl('UserProfile')}?id=${encodeURIComponent(pr.user.id)}`}
                            className="text-[10px] text-[var(--sec-accent)] underline mt-1 inline-block"
                          >
                            View profile
                          </Link>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {pr.reviewStatus === 'pending' && (
                        <>
                          <button
                            type="button"
                            className="text-xs px-2 py-1.5 rounded-lg font-semibold text-white disabled:opacity-50"
                            style={{ backgroundColor: 'var(--sec-success)' }}
                            disabled={approvingUserId === pr.userId}
                            onClick={async () => {
                              setApprovingUserId(pr.userId);
                              try {
                                const r = await apiPatch(`/api/host/tables/${t.id}/join-requests/${pr.userId}`, {
                                  action: 'approve',
                                });
                                if (r?.awaitingGuestPayment) {
                                  toast.success('Approved — guest notified to complete payment');
                                } else {
                                  toast.success('Approved');
                                }
                                queryClient.invalidateQueries({ queryKey: ['host-tables'] });
                                refetchPending();
                              } catch (e) {
                                toast.error(e?.data?.error || e?.message || 'Could not approve');
                              } finally {
                                setApprovingUserId(null);
                              }
                            }}
                          >
                            {approvingUserId === pr.userId ? '…' : 'Approve'}
                          </button>
                          <button
                            type="button"
                            className="text-xs px-2 py-1.5 rounded-lg border border-[var(--sec-border)]"
                            onClick={async () => {
                              try {
                                await apiPatch(`/api/host/tables/${t.id}/join-requests/${pr.userId}`, {
                                  action: 'reject',
                                });
                                toast.success('Declined');
                                queryClient.invalidateQueries({ queryKey: ['host-tables'] });
                                refetchPending();
                              } catch (e) {
                                toast.error(e?.data?.error || e?.message || 'Could not decline');
                              }
                            }}
                          >
                            Decline
                          </button>
                        </>
                      )}
                      {pr.reviewStatus === 'awaiting_payment' && (
                        <button
                          type="button"
                          className="text-xs px-2 py-1.5 rounded-lg border border-[var(--sec-border)]"
                          onClick={async () => {
                            try {
                              await apiPatch(`/api/host/tables/${t.id}/join-requests/${pr.userId}`, {
                                action: 'reject',
                              });
                              toast.success('Cancelled');
                              queryClient.invalidateQueries({ queryKey: ['host-tables'] });
                              refetchPending();
                            } catch (e) {
                              toast.error(e?.message || 'Could not cancel');
                            }
                          }}
                        >
                          Cancel approval
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : null
        }
      />
    );
  };

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const joinFeeNum = tableForm.hasJoiningFee ? Number(tableForm.joiningFee) : 0;
  const joinFeeValid = Number.isFinite(joinFeeNum) && joinFeeNum >= 10;
  const hostReceiveZar = joinFeeValid ? Math.round(joinFeeNum * 0.85 * 100) / 100 : 0;
  const secFeeZar = joinFeeValid ? Math.round(joinFeeNum * 0.15 * 100) / 100 : 0;

  const hostedTableCreateFields = (
    <div className="space-y-5 text-sm">
      <p className="text-xs text-[var(--sec-text-muted)] leading-relaxed">
        Host at your own place — house parties, boats, restaurants, tables, and more. Official SEC event tables are booked from the event page.
      </p>

      <div>
        <div className="text-sm font-medium mb-2">List as</div>
        <div
          className="grid grid-cols-2 gap-2 p-1 rounded-xl"
          style={{ background: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)' }}
          role="group"
          aria-label="Listing type"
        >
          {[
            { value: 'TABLE', label: 'Table', hint: 'Shows under Available Tables' },
            { value: 'EVENT', label: 'Event', hint: 'Shows under Events on Home' },
          ].map((opt) => {
            const active = tableForm.listingSurface === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTableForm((f) => ({ ...f, listingSurface: opt.value }))}
                className="rounded-lg px-3 py-2.5 text-left transition-colors"
                style={{
                  background: active ? 'var(--sec-accent-muted)' : 'transparent',
                  border: active ? '1px solid var(--sec-accent-border)' : '1px solid transparent',
                  color: 'var(--sec-text-primary)',
                }}
              >
                <span className="block text-sm font-semibold">{opt.label}</span>
                <span className="block text-[11px] mt-0.5 text-[var(--sec-text-muted)]">{opt.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <label className="block text-sm font-medium">
        Place name
        <input
          placeholder="e.g. Rooftop Lounge"
          className="w-full mt-1.5 px-3 py-2.5 rounded-xl bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] text-[16px]"
          value={tableForm.venueName}
          onChange={(e) => setTableForm((f) => ({ ...f, venueName: e.target.value }))}
        />
      </label>

      <div>
        <div className="text-sm font-medium mb-1">Address</div>
        <p className="text-xs text-[var(--sec-text-muted)] mb-2">Required so guests know exactly where to go.</p>
        <button
          type="button"
          disabled={locatingAddress}
          onClick={async () => {
            setLocatingAddress(true);
            try {
              const { getCurrentLocation, locationErrorMessage } = await import(
                '@/lib/getCurrentLocation'
              );
              const { lat, lng } = await getCurrentLocation();
              try {
                const { reverseGeocodeLatLngStructured } = await import('@/lib/reverseGeocode');
                const structured = await reverseGeocodeLatLngStructured(lat, lng);
                setTableForm((f) => ({
                  ...f,
                  venueAddress: structured.formattedAddress || structured.street || f.venueAddress,
                  suburb: structured.suburb || structured.city || '',
                  province: structured.province || '',
                  latitude: lat,
                  longitude: lng,
                }));
                toast.success(
                  structured.formattedAddress
                    ? `Location set: ${structured.formattedAddress}`
                    : 'Location coordinates saved',
                );
              } catch {
                setTableForm((f) => ({
                  ...f,
                  venueAddress: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
                  latitude: lat,
                  longitude: lng,
                }));
                toast.message('Saved GPS coordinates — refine the address if needed');
              }
            } catch (err) {
              const { locationErrorMessage } = await import('@/lib/getCurrentLocation');
              toast.error(locationErrorMessage(err));
            } finally {
              setLocatingAddress(false);
            }
          }}
          className="mb-2 flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-xl w-full justify-center"
          style={{
            background: 'var(--sec-bg-elevated)',
            border: '1px solid var(--sec-border)',
            color: 'var(--sec-text-primary)',
            opacity: locatingAddress ? 0.7 : 1,
          }}
        >
          <MapPin className="w-4 h-4" />
          {locatingAddress ? 'Getting location…' : 'Use current location'}
        </button>
        <GoogleAddressInput
          value={{
            formattedAddress: tableForm.venueAddress,
            street: tableForm.venueAddress,
            suburb: tableForm.suburb,
            province: tableForm.province,
            city: '',
            country: 'ZA',
            latitude: tableForm.latitude,
            longitude: tableForm.longitude,
          }}
          label="Address"
          placeholder="Start typing an address"
          showSuburbProvince
          onChange={(structured) => {
            if (typeof structured === 'string') {
              setTableForm((f) => ({ ...f, venueAddress: structured }));
              return;
            }
            setTableForm((f) => ({
              ...f,
              venueAddress: structured?.formattedAddress || structured?.street || '',
              suburb: structured?.suburb ?? f.suburb,
              province: structured?.province ?? f.province,
              latitude: structured?.latitude ?? f.latitude,
              longitude: structured?.longitude ?? f.longitude,
            }));
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm font-medium">
          Start date
          <input
            type="date"
            className="w-full mt-1.5 px-3 py-2.5 rounded-xl bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] text-[16px]"
            value={tableForm.eventDate}
            onChange={(e) =>
              setTableForm((f) => ({
                ...f,
                eventDate: e.target.value,
                eventEndDate: f.eventEndDate || e.target.value,
              }))
            }
          />
        </label>
        <label className="block text-sm font-medium">
          Start time
          <input
            type="time"
            className="w-full mt-1.5 px-3 py-2.5 rounded-xl bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] text-[16px]"
            value={tableForm.eventTime}
            onChange={(e) => setTableForm((f) => ({ ...f, eventTime: e.target.value }))}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm font-medium">
          End date
          <input
            type="date"
            className="w-full mt-1.5 px-3 py-2.5 rounded-xl bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] text-[16px]"
            value={tableForm.eventEndDate}
            min={tableForm.eventDate || undefined}
            onChange={(e) => setTableForm((f) => ({ ...f, eventEndDate: e.target.value }))}
          />
        </label>
        <label className="block text-sm font-medium">
          End time
          <input
            type="time"
            className="w-full mt-1.5 px-3 py-2.5 rounded-xl bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] text-[16px]"
            value={tableForm.eventEndTime}
            onChange={(e) => setTableForm((f) => ({ ...f, eventEndTime: e.target.value }))}
          />
        </label>
      </div>
      <p className="text-[11px] text-[var(--sec-text-muted)] -mt-1">
        QR codes and your listing stay live until this end date and time, then move to Past.
      </p>

      <label className="block text-sm font-medium">
        Title / name
        <input
          placeholder="e.g. Sunset rooftop, VIP booth, Boat cruise"
          className="w-full mt-1.5 px-3 py-2.5 rounded-xl bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] text-[16px]"
          value={tableForm.tableName}
          onChange={(e) => setTableForm((f) => ({ ...f, tableName: e.target.value }))}
          maxLength={60}
        />
      </label>

      <label className="block text-sm font-medium">
        Category
        <select
          className="w-full mt-1.5 px-3 py-2.5 rounded-xl bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] text-[16px]"
          value={tableForm.eventType}
          onChange={(e) => setTableForm((f) => ({ ...f, eventType: e.target.value }))}
        >
          <option value="CLUB_TABLE">Table</option>
          <option value="HOUSE_PARTY">House Party</option>
          <option value="BOAT_PARTY">Boat Party</option>
          <option value="RESTAURANT">Restaurant</option>
          <option value="OTHER">Other</option>
        </select>
      </label>

      <label className="block text-sm font-medium">
        Description
        <span className="font-normal text-[var(--sec-text-muted)]"> (optional)</span>
        <textarea
          placeholder="What should guests expect?"
          className="w-full mt-1.5 px-3 py-2.5 rounded-xl bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] text-[16px]"
          rows={3}
          value={tableForm.tableDescription}
          onChange={(e) => setTableForm((f) => ({ ...f, tableDescription: e.target.value }))}
          maxLength={300}
        />
      </label>

      <label className="block text-sm font-medium">
        Guest spots
        <input
          type="number"
          min={1}
          className="w-full mt-1.5 px-3 py-2.5 rounded-xl bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] text-[16px]"
          value={tableForm.guestQuantity}
          onChange={(e) =>
            setTableForm((f) => {
              const raw = parseInt(e.target.value, 10);
              return { ...f, guestQuantity: Number.isFinite(raw) && raw >= 1 ? raw : 1 };
            })
          }
        />
      </label>
      <p className="text-xs text-[var(--sec-text-muted)] -mt-3">How many guests can join your listing.</p>

      <div className="rounded-xl border border-[var(--sec-border)] p-3 space-y-3">
        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-1"
            checked={tableForm.hasJoiningFee}
            onChange={(e) => setTableForm((f) => ({ ...f, hasJoiningFee: e.target.checked }))}
          />
          <span>
            <span className="font-medium">Charge joining fee</span>
            <span className="block text-xs text-[var(--sec-text-muted)] mt-0.5">
              You receive 85% of each payment in your SEC wallet, paid out weekly on Mondays (minimum R50).
              SEC keeps 15%. Guests also pay a R5 SEC service fee at checkout.
            </span>
          </span>
        </label>
        {tableForm.hasJoiningFee ? (
          <div>
            <label className="block text-sm font-medium">
              Joining fee (ZAR)
              <input
                type="number"
                min={10}
                placeholder="e.g. 100"
                className="w-full mt-1.5 px-3 py-2.5 rounded-xl bg-[var(--sec-bg-elevated)] border border-[var(--sec-border)] text-[16px]"
                value={tableForm.joiningFee}
                onChange={(e) => setTableForm((f) => ({ ...f, joiningFee: e.target.value }))}
              />
            </label>
            {joinFeeValid ? (
              <p className="text-xs mt-2 text-[var(--sec-text-muted)]">
                You receive R{hostReceiveZar.toFixed(2)} · SEC fee R{secFeeZar.toFixed(2)}
              </p>
            ) : (
              <p className="text-xs mt-2 text-[var(--sec-text-muted)]">Minimum R10.</p>
            )}
          </div>
        ) : null}
      </div>

      <div>
        <label className="text-sm font-medium block mb-1.5">Cover photo</label>
        <p className="text-xs text-[var(--sec-text-muted)] mb-2">Optional — shown on browse &amp; Home when boosted.</p>
        <input
          type="file"
          accept="image/*"
          className="w-full text-xs sec-input-rect"
          onChange={createTablePhotoCrop.handleInputChange}
        />
        {tableForm.photo ? (
          <img src={tableForm.photo} alt="" className="w-full h-32 object-cover rounded-xl mt-2" />
        ) : null}
      </div>

      <div className="rounded-xl border border-[var(--sec-border)] p-3">
        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-1"
            checked={tableForm.isPublic}
            onChange={(e) => setTableForm((f) => ({ ...f, isPublic: e.target.checked }))}
          />
          <span>
            <span className="font-medium">Public listing (anyone can join without approval)</span>
            <span className="block text-xs text-[var(--sec-text-muted)] mt-0.5">
              Turn off for a private listing: it stays visible on Home, but guests must request approval before joining.
            </span>
          </span>
        </label>
      </div>
    </div>
  );

  const createTableSubmitButton = (
    <button
      type="button"
      disabled={saving}
      className="sec-btn sec-btn-primary w-full disabled:opacity-50 min-h-[48px]"
      onClick={submitTable}
    >
      {saving ? 'Listing…' : 'Publish listing'}
    </button>
  );

  const imageCropDialog = (
    <ImageCropDialog
      open={createTablePhotoCrop.cropOpen || manageTablePhotoCrop.cropOpen}
      onOpenChange={(open) => {
        if (!open) {
          createTablePhotoCrop.onCropOpenChange(false);
          manageTablePhotoCrop.onCropOpenChange(false);
        }
      }}
      imageSrc={createTablePhotoCrop.cropSrc || manageTablePhotoCrop.cropSrc}
      title="Crop cover photo"
      onCropped={(file) => {
        if (createTablePhotoCrop.cropOpen) createTablePhotoCrop.handleCropped(file);
        else manageTablePhotoCrop.handleCropped(file);
      }}
      outputFileName="hosted-table-cover.jpg"
      {...COVER_CROP_DIALOG_PROPS}
    />
  );

  if (isMobile && showTableModal) {
    const mobileSheet =
      typeof document !== 'undefined'
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-[100] flex flex-col bg-[var(--sec-bg-base)]"
                style={{
                  top: 0,
                  right: 0,
                  bottom: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  maxHeight: '100%',
                  overflow: 'hidden',
                  touchAction: 'manipulation',
                  // Pin to layout viewport — do not resize with the soft keyboard.
                  transform: 'translateZ(0)',
                }}
              >
                <header
                  className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--sec-border)] bg-[var(--sec-bg-base)]"
                  style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
                >
                  <h3 className="font-semibold text-base">Your own venue</h3>
                  <button
                    type="button"
                    className="min-h-[44px] min-w-[44px] rounded-full flex items-center justify-center text-sm"
                    style={{ backgroundColor: 'var(--sec-bg-elevated)' }}
                    onClick={closeTableModal}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </header>
                <div
                  ref={createFormScrollRef}
                  data-scroll-lock-scrollable
                  className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4"
                  style={{
                    WebkitOverflowScrolling: 'touch',
                    overscrollBehavior: 'contain',
                  }}
                >
                  {hostedTableCreateFields}
                </div>
                <footer
                  className="shrink-0 border-t border-[var(--sec-border)] bg-[var(--sec-bg-base)] px-4 pt-3"
                  style={{
                    paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
                  }}
                >
                  {createTableSubmitButton}
                </footer>
              </div>
              {imageCropDialog}
            </>,
            document.body,
          )
        : null;

    return mobileSheet;
  }

  const desktopCreateModal =
    showTableModal && !isMobile && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
            style={{ touchAction: 'none' }}
            role="presentation"
          >
            <div
              className="bg-[var(--sec-bg-card)] w-full max-w-md max-h-[90vh] rounded-2xl border border-[var(--sec-border)] flex flex-col min-h-0 overflow-hidden"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-hosted-table-title"
            >
              <div className="shrink-0 flex justify-between items-center p-4 border-b border-[var(--sec-border)]">
                <h3 id="create-hosted-table-title" className="font-semibold">
                  Your own venue
                </h3>
                <button
                  type="button"
                  className="min-h-[44px] min-w-[44px] rounded-full flex items-center justify-center text-sm opacity-70"
                  onClick={closeTableModal}
                >
                  Close
                </button>
              </div>
              <div
                data-scroll-lock-scrollable
                className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-4"
              >
                {hostedTableCreateFields}
                {createTableSubmitButton}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="max-w-[1100px] mx-auto pb-6 lg:pb-10 lg:px-4 lg:py-6">
      {isMobile ? (
        <PageBackHeader title="Host Dashboard" subtitle="Your own place listings" pageName="HostDashboard" />
      ) : (
        <div className="flex items-center gap-2 mb-6 px-4 pt-6">
          <SecLogo size={30} />
          <div>
            <h1 className="text-xl font-bold">Host</h1>
            <p className="text-sm opacity-70">Your own place listings</p>
          </div>
        </div>
      )}

      <div className="px-4">
      <WeeklyPayoutNotice
        className="mb-4"
        nextPayoutDate={walletSummary?.nextPayoutDate}
        payoutMinimumZar={walletSummary?.payoutMinimumZar}
        queuedForNextPayout={walletSummary?.queuedForNextPayout}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-2 mb-4">
          <TabsTrigger value="tables">Tables</TabsTrigger>
          <TabsTrigger value="activity">Stats</TabsTrigger>
        </TabsList>

        <TabsContent value="tables">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-4">
            <div className="min-w-0">
              <h2 className="font-semibold text-lg">My Tables/Events</h2>
              <p className="text-xs text-[var(--sec-text-muted)] mt-0.5">
                Manage your own-place tables and events here after you pay to list them. They show on Home under
                Available Tables or Upcoming Events, depending on what you chose when creating. Listings move to Past
                after the end date and time you set.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowTableModal(true)}
              className="sec-btn sec-btn-primary text-sm py-2.5 px-3 inline-flex items-center gap-1 rounded-xl shrink-0 self-start sm:self-auto"
            >
              <Plus size={16} /> Host table/event
            </button>
          </div>
          {loadT ? <Loader2 className="animate-spin mb-4" /> : null}
          <Tabs value={tablesSubTab} onValueChange={setTablesSubTab} className="w-full">
            <TabsList className="w-full bg-[var(--sec-bg-elevated)] p-1 rounded-lg border border-[var(--sec-border)] mb-4">
              <TabsTrigger
                value="upcoming"
                className="flex-1 rounded-md text-xs data-[state=active]:bg-[var(--sec-bg-card)]"
              >
                Upcoming ({upcomingTables.length})
              </TabsTrigger>
              <TabsTrigger
                value="past"
                className="flex-1 rounded-md text-xs data-[state=active]:bg-[var(--sec-bg-card)]"
              >
                Past ({pastTables.length})
              </TabsTrigger>
            </TabsList>
            <TabsContent value="upcoming">
              <div className="grid gap-4 xl:grid-cols-2">
                {upcomingTables.map((t) => renderHostedTableCard(t))}
                {upcomingTables.length === 0 && !loadT && (
                  <p className="text-sm text-[var(--sec-text-muted)] text-center py-10 col-span-full">
                    No upcoming tables. Host one to start a group chat.
                  </p>
                )}
              </div>
            </TabsContent>
            <TabsContent value="past">
              <div className="grid gap-4 xl:grid-cols-2">
                {pastTables.map((t) => renderHostedTableCard(t, { isPast: true }))}
                {pastTables.length === 0 && !loadT && (
                  <p className="text-sm text-[var(--sec-text-muted)] text-center py-10 col-span-full">
                    No past tables yet. Finished SEC event tables and your own venue tables (after the end date and time you set) appear here.
                  </p>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="activity">
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              {
                icon: Armchair,
                label: 'Tables hosted',
                value: activity?.totalTablesHosted ?? '—',
                hint: 'All-time listings',
              },
              {
                icon: Calendar,
                label: 'Joined events',
                value: activity?.totalJoinedEvents ?? '—',
                hint: "Tables and ticketed events you've attended",
              },
              {
                icon: Users,
                label: 'Table joiners',
                value: activity?.totalTableJoiners ?? '—',
                hint: 'Guests who joined your tables',
              },
              {
                icon: Star,
                label: 'Avg rating',
                value:
                  activity?.averageRatingReceived != null
                    ? activity.averageRatingReceived.toFixed(1)
                    : '—',
                hint:
                  activity?.ratingCount > 0
                    ? `${activity.ratingCount} review${activity.ratingCount === 1 ? '' : 's'}`
                    : 'No reviews yet',
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="sec-card rounded-2xl border border-[var(--sec-border)] p-4 flex items-start gap-3"
                style={{ background: 'var(--sec-bg-card)' }}
              >
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{
                    background: 'var(--sec-accent-muted)',
                    border: '1px solid var(--sec-accent-border)',
                  }}
                >
                  <stat.icon size={18} style={{ color: 'var(--sec-accent-bright)' }} />
                </div>
                <div className="min-w-0">
                  <div
                    className="text-2xl font-bold tabular-nums"
                    style={{ color: 'var(--sec-accent-bright)' }}
                  >
                    {stat.value}
                  </div>
                  <div className="text-sm font-medium text-white mt-0.5">{stat.label}</div>
                  <div className="text-xs text-[var(--sec-text-muted)] mt-1">{stat.hint}</div>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
      </div>

      {imageCropDialog}
      {desktopCreateModal}
      <FeedBoostDialog
        open={Boolean(boostTarget)}
        onOpenChange={(open) => {
          if (!open) setBoostTarget(null);
        }}
        title={boostTarget ? `Boost “${boostTarget.name}”` : 'Boost listing'}
        description="Boosted Your own venue tables and events appear more often under Available Tables and Home Events."
        maxDays={maxBoostDaysUntil(boostTarget?.endAt)}
        busy={boostBusy}
        onConfirm={confirmBoostDays}
      />
    </div>
  );
}
