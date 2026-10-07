import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  isLikelyOffline,
  loadTicketVerifySnapshot,
  saveTicketVerifySnapshot,
} from '@/lib/ticketOfflineCache';
import { useSearchParams, Link } from 'react-router-dom';
import { apiGet, apiPost } from '@/api/client';
import { createPageUrl } from '@/utils';
import { format, parseISO } from 'date-fns';
import { CheckCircle2, XCircle, Loader2, Copy, MapPin, Building2, Users, CalendarDays, UserCheck, Utensils } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';

function formatWhen(iso) {
  if (!iso) return null;
  try {
    return format(parseISO(iso), 'EEE, MMM d, yyyy HH:mm');
  } catch {
    return null;
  }
}

export default function TicketVerify() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const queryKey = useMemo(() => params.toString(), [params]);
  const hintVenue = params.get('vn');
  const hintAt = params.get('at');
  const hintEc = params.get('ec');
  const hintTimeLabel = hintAt ? formatWhen(hintAt) : null;
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const { isAuthenticated } = useAuth();
  const [admitting, setAdmitting] = useState(false);
  const [fulfilling, setFulfilling] = useState(false);
  const [onlineNonce, setOnlineNonce] = useState(0);

  useEffect(() => {
    const onUp = () => setOnlineNonce((n) => n + 1);
    window.addEventListener('online', onUp);
    return () => window.removeEventListener('online', onUp);
  }, []);

  const fetchVerify = useCallback(async () => {
    if (!token) return null;
    const qs = new URLSearchParams();
    qs.set('token', token);
    const search = new URLSearchParams(queryKey);
    const vn = search.get('vn');
    const at = search.get('at');
    const ec = search.get('ec');
    if (ec) qs.set('ec', ec);
    if (vn) qs.set('vn', vn);
    if (at) qs.set('at', at);
    return apiGet(`/api/tickets/qr?${qs.toString()}`, {
      skipAuth: !isAuthenticated,
      timeoutMs: 15000,
    });
  }, [token, queryKey, isAuthenticated]);

  useEffect(() => {
    if (!token) {
      setPayload({ valid: false, reason: 'Missing ticket link. Open the QR from the SEC app again.' });
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;

    if (isLikelyOffline()) {
      const snap = loadTicketVerifySnapshot(token);
      if (snap) {
        const rest = { ...snap };
        delete rest._offline_cached;
        delete rest._verify_refresh_failed;
        if (!cancelled) {
          setPayload({ ...rest, _offline_cached: true });
          setLoading(false);
        }
      } else if (!cancelled) {
        setPayload({
          valid: false,
          reason:
            'You appear to be offline. Open this link once with internet so this device can save your ticket, or show staff the QR image from your confirmation email (it stays available offline in most mail apps).',
          _offline_no_cache: true,
        });
        setLoading(false);
      }
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const res = await fetchVerify();
        if (!cancelled) {
          if (res) {
            setPayload(res);
            saveTicketVerifySnapshot(token, res);
          } else {
            setPayload({
              valid: false,
              reason: 'Could not verify this ticket — empty response from SEC. Try again or open the link from your confirmation email.',
            });
          }
        }
      } catch (e) {
        if (!cancelled) {
          const d = e?.data && typeof e.data === 'object' ? e.data : {};
          const merged = {
            valid: false,
            reason: d.reason || e?.message || 'Could not verify this ticket.',
            ...d,
          };
          if (Object.keys(d).length > 0) saveTicketVerifySnapshot(token, merged);
          const snap = loadTicketVerifySnapshot(token);
          if (snap && Object.keys(d).length === 0) {
            const rest = { ...snap };
            delete rest._offline_cached;
            delete rest._verify_refresh_failed;
            setPayload({ ...rest, _offline_cached: true, _verify_refresh_failed: true });
          } else {
            setPayload(merged);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, queryKey, fetchVerify, onlineNonce]);

  const valid = payload?.valid === true;
  const expired = payload?.valid === false && (payload?.expired || payload?.reason === 'Ticket expired');
  const sessionEnded = payload?.valid === false && payload?.session_ended === true;

  const submitAdmit = async () => {
    if (!token) return;
    if (isLikelyOffline()) {
      toast.error('Recording entry requires an internet connection.');
      return;
    }
    setAdmitting(true);
    try {
      await apiPost('/api/tickets/admit', { qr_token: token });
      toast.success('Entry recorded');
      const res = await fetchVerify();
      if (res) {
        setPayload(res);
        saveTicketVerifySnapshot(token, res);
      }
    } catch (e) {
      toast.error(e?.message || 'Could not record entry');
    } finally {
      setAdmitting(false);
    }
  };

  const submitFulfill = async (undo = false) => {
    if (!token) return;
    if (isLikelyOffline()) {
      toast.error('Marking an order fulfilled requires an internet connection.');
      return;
    }
    setFulfilling(true);
    try {
      await apiPost(undo ? '/api/tickets/unfulfill-order' : '/api/tickets/fulfill-order', { qr_token: token });
      toast.success(undo ? 'Order marked as still needs serving' : 'Order fulfilled');
      const res = await fetchVerify();
      if (res) {
        setPayload(res);
        saveTicketVerifySnapshot(token, res);
      }
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Could not update order');
    } finally {
      setFulfilling(false);
    }
  };

  const copySummary = async () => {
    const line = payload?.door_verify_summary || [
      payload?.holder_display_name,
      payload?.venue_name,
      payload?.event_title || payload?.title,
      payload?.table_allocation_label,
    ].filter(Boolean).join(' · ');
    if (!line) {
      toast.error('Nothing to copy');
      return;
    }
    try {
      await navigator.clipboard.writeText(line);
      toast.success('Copied for staff / radio');
    } catch {
      toast.error('Could not copy');
    }
  };

  return (
    <div
      className="min-h-[100dvh] flex flex-col items-center px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]"
      style={{ backgroundColor: 'var(--sec-bg-base, #050506)', color: 'var(--sec-text-primary, #fafafa)' }}
    >
      <img
        src="/sec-logo.png"
        alt="SEC"
        className="h-12 w-auto mb-6 object-contain"
        onError={(e) => {
          e.currentTarget.src = '/Logo/sec-email-logo-transparent.png';
        }}
      />

      {!loading && payload?._offline_cached && (
        <div
          className="w-full max-w-lg mb-4 rounded-xl border px-4 py-3 text-sm"
          style={{
            borderColor: 'rgba(251,191,36,0.4)',
            backgroundColor: 'rgba(251,191,36,0.08)',
            color: '#fcd34d',
          }}
        >
          {payload._verify_refresh_failed
            ? 'Could not reach SEC — showing the last ticket details saved on this device. Reconnect to refresh.'
            : 'Offline — showing ticket details saved on this device. Reconnect for the latest status.'}
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center gap-4 text-gray-400 my-auto w-full max-w-lg">
          <Loader2 className="w-10 h-10 animate-spin" />
          <p className="text-sm">Verifying ticket with SEC…</p>
          {(hintEc || hintVenue || hintTimeLabel) && (
            <div
              className="w-full rounded-xl border p-4 text-left"
              style={{ borderColor: 'rgba(250,250,250,0.12)', backgroundColor: 'rgba(0,0,0,0.35)' }}
            >
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
                Printed on QR (quick glance)
              </p>
              {hintEc && (
                <p className="text-lg font-bold font-mono tracking-widest text-[var(--sec-accent,#e8c547)] leading-snug">
                  {hintEc}
                </p>
              )}
              {hintVenue && (
                <p className="text-lg font-bold text-white leading-snug">{hintVenue}</p>
              )}
              {hintTimeLabel && (
                <p className="text-sm text-gray-300 mt-1">Event time: {hintTimeLabel}</p>
              )}
              <p className="text-xs text-gray-500 mt-2">Wait for the green check — token is the source of truth.</p>
            </div>
          )}
        </div>
      )}

      {!loading && payload && (
        <div className="w-full max-w-lg space-y-4 my-auto">
          <div
            className="rounded-2xl border-2 p-5 sm:p-6"
            style={{
              backgroundColor: 'var(--sec-bg-elevated, #0f0f12)',
              borderColor: valid
                ? 'rgba(34,197,94,0.45)'
                : sessionEnded
                  ? 'rgba(239,68,68,0.4)'
                  : 'rgba(245,158,11,0.35)',
            }}
          >
            <div className="flex items-start gap-3 mb-5">
              {valid ? (
                <CheckCircle2 className="w-10 h-10 shrink-0 text-emerald-400" strokeWidth={2} />
              ) : (
                <XCircle className="w-10 h-10 shrink-0 text-amber-500" strokeWidth={2} />
              )}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
                  Door check
                </p>
                <h1 className="text-2xl sm:text-3xl font-bold leading-tight">
                  {valid
                    ? 'Admit — ticket valid'
                    : expired
                      ? 'Do not admit — expired'
                      : sessionEnded
                        ? 'Checked out — do not admit'
                        : 'Do not admit'}
                </h1>
                {!valid && payload.reason && (
                  <p className="text-base text-gray-400 mt-2">{payload.reason}</p>
                )}
              </div>
            </div>

            {payload.event_code && (
              <div
                className="rounded-xl border px-4 py-3 mb-4 text-center"
                style={{ borderColor: 'rgba(232,197,71,0.35)', backgroundColor: 'rgba(232,197,71,0.08)' }}
              >
                <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
                  Event door code
                </p>
                <p className="text-2xl sm:text-3xl font-bold font-mono tracking-widest text-[var(--sec-accent,#e8c547)]">
                  {payload.event_code}
                </p>
              </div>
            )}

            {payload.printed_hints_mismatch && (
              <div
                className="rounded-xl border px-4 py-3 mb-4 text-sm"
                style={{
                  borderColor: 'rgba(251,191,36,0.45)',
                  backgroundColor: 'rgba(251,191,36,0.08)',
                  color: '#fcd34d',
                }}
              >
                The event code, venue, or time text in the link does not match this ticket record. Trust only the
                SEC-validated details below (not an edited screenshot or retyped URL).
              </div>
            )}

            {payload.order_only && (
              <div
                className="rounded-xl border px-4 py-3 mb-4 text-center"
                style={{ borderColor: 'rgba(251,191,36,0.6)', backgroundColor: 'rgba(251,191,36,0.12)' }}
              >
                <p className="text-lg font-bold text-amber-200">Add-on order — not an entry pass</p>
                <p className="text-xs text-amber-100/80 mt-1">
                  Hand over the items below, then mark the order fulfilled. Use the guest&apos;s main ticket or table
                  pass for entry.
                </p>
              </div>
            )}

            {payload.host_instructions && (
              <p className="text-sm text-gray-400 leading-relaxed mb-4 border-l-2 border-emerald-500/50 pl-3">
                {payload.host_instructions}
              </p>
            )}

            {payload.event_starts_at && (
              <div
                className="rounded-xl border px-4 py-3 mb-4"
                style={{ borderColor: 'rgba(16,185,129,0.35)', backgroundColor: 'rgba(16,185,129,0.06)' }}
              >
                <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400/90 mb-1">
                  Official event start (from ticket)
                </p>
                <p className="text-xl sm:text-2xl font-bold text-emerald-100">
                  {formatWhen(payload.event_starts_at) || '—'}
                </p>
              </div>
            )}

            {(payload.venue_name || payload.check_location_line) && (
              <div
                className="rounded-xl border p-4 mb-4"
                style={{
                  borderColor: 'rgba(250,250,250,0.12)',
                  backgroundColor: 'rgba(0,0,0,0.35)',
                }}
              >
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-400/90 mb-2">
                  <Building2 className="w-4 h-4" />
                  Match to your venue
                </div>
                <p className="text-xl sm:text-2xl font-bold leading-snug break-words">
                  {payload.venue_name || '—'}
                </p>
                {(payload.check_location_line || payload.venue_city) && (
                  <div className="flex items-start gap-2 mt-2 text-sm text-gray-400">
                    <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
                    <span className="leading-relaxed">
                      {payload.check_location_line || payload.venue_city}
                    </span>
                  </div>
                )}
              </div>
            )}

            {(payload.event_title || payload.title) && (
              <div className="mb-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
                  <CalendarDays className="w-3.5 h-3.5" />
                  Event
                </div>
                <p className="text-lg sm:text-xl font-semibold leading-snug">
                  {payload.event_title || payload.title}
                </p>
                {payload.event_title && payload.title && payload.title !== payload.event_title && (
                  <p className="text-sm text-gray-500 mt-1">{payload.title}</p>
                )}
              </div>
            )}

            {payload.table_allocation_label && (
              <div
                className="rounded-xl border p-4 mb-4"
                style={{ borderColor: 'var(--sec-border, #262629)', backgroundColor: 'rgba(255,255,255,0.03)' }}
              >
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  <Users className="w-4 h-4" />
                  Table / allocation
                </div>
                <p className="text-lg sm:text-xl font-bold text-white leading-snug">
                  {payload.table_allocation_label}
                </p>
              </div>
            )}

            {payload.holder_display_name && (
              <div className="mb-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Guest name</div>
                <p className="text-2xl sm:text-3xl font-bold tracking-tight break-words">
                  {payload.holder_display_name}
                </p>
                {valid && (
                  <p className="text-sm text-gray-500 mt-2">
                    Ask for photo ID and confirm it matches this name before seating.
                  </p>
                )}
              </div>
            )}

            {payload.table_specs_summary && (
              <div className="mb-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Booking details</div>
                <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-line">{payload.table_specs_summary}</p>
              </div>
            )}

            {payload.has_serveable_order ? (
              <div
                className="rounded-xl border p-4 mb-4"
                style={{
                  borderColor: payload.order_fulfilled ? 'rgba(34,197,94,0.45)' : 'rgba(232,197,71,0.35)',
                  backgroundColor: payload.order_fulfilled ? 'rgba(34,197,94,0.08)' : 'rgba(232,197,71,0.08)',
                }}
              >
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: payload.order_fulfilled ? '#86efac' : '#fcd34d' }}>
                  <Utensils className="w-4 h-4" />
                  {payload.order_only ? 'Add-on order' : 'Menu / minimum spend'}
                </div>
                <p className="text-lg font-bold leading-snug mb-2">
                  {payload.order_fulfilled ? 'Order fulfilled' : 'Needs serving'}
                </p>
                {(payload.menu_items || []).length > 0 ? (
                  <ul className="text-sm text-gray-300 space-y-1 mb-2">
                    {payload.menu_items.map((item, i) => {
                      const amount =
                        Number(item.lineTotal) > 0
                          ? Number(item.lineTotal)
                          : (Number(item.unitPrice) || 0) * (Number(item.quantity) || 1);
                      return (
                        <li key={item.menuItemId || i}>
                          {item.quantity}× {item.name || 'Item'}
                          {amount > 0 ? ` · R${amount.toFixed(0)}` : ''}
                        </li>
                      );
                    })}
                  </ul>
                ) : Number(payload.minimum_spend_zar) > 0 ? (
                  <p className="text-sm text-gray-300 mb-2">
                    Prepaid minimum spend R{Number(payload.minimum_spend_zar).toFixed(0)}
                  </p>
                ) : null}
                {payload.order_fulfilled_at ? (
                  <p className="text-xs text-emerald-200/80 mb-2">
                    Served {formatWhen(payload.order_fulfilled_at) || payload.order_fulfilled_at}
                  </p>
                ) : null}
                {payload.can_fulfill_here ? (
                  <Button
                    type="button"
                    className="w-full sm:w-auto gap-2 bg-amber-500 hover:bg-amber-400 text-black"
                    onClick={() => submitFulfill(false)}
                    disabled={fulfilling || isLikelyOffline() || !!payload._offline_cached}
                  >
                    {fulfilling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Utensils className="w-4 h-4" />}
                    Mark order fulfilled
                  </Button>
                ) : null}
                {payload.can_unfulfill_here ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full sm:w-auto gap-2 mt-2"
                    onClick={() => submitFulfill(true)}
                    disabled={fulfilling || isLikelyOffline() || !!payload._offline_cached}
                  >
                    {fulfilling ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    Undo fulfilled
                  </Button>
                ) : null}
                {!payload.can_fulfill_here && !payload.can_unfulfill_here && !payload.order_fulfilled && payload.viewer_authenticated ? (
                  <p className="text-xs text-gray-500 mt-1">{payload.fulfill_denied_reason || 'Sign in with a venue bookings account to mark this order served.'}</p>
                ) : null}
              </div>
            ) : payload.order_only && payload.order_refunded ? (
              <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-4 mb-4 text-sm text-red-300">
                This add-on order was refunded. Do not serve it.
              </div>
            ) : null}

            {Array.isArray(payload.addons) && payload.addons.length > 0 && (
              <div
                className="rounded-xl border p-4 mb-4"
                style={{ borderColor: 'var(--sec-border, #262629)', backgroundColor: 'rgba(255,255,255,0.03)' }}
              >
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  <Utensils className="w-4 h-4" />
                  Add-on orders on this booking ({payload.addons.length})
                </div>
                <ul className="space-y-2 text-sm">
                  {payload.addons.map((a) => (
                    <li key={a.id} className="flex items-start justify-between gap-3">
                      <span className="text-gray-300 break-words">{a.items_summary || 'Menu items'}</span>
                      <span
                        className={`sec-badge text-[10px] shrink-0 ${
                          a.status === 'REFUNDED' ? 'sec-badge-muted' : a.fulfilled ? 'sec-badge-success' : 'sec-badge-gold'
                        }`}
                      >
                        {a.status === 'REFUNDED' ? 'Refunded' : a.fulfilled ? 'Served' : 'Needs serving'}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-gray-500 mt-2">
                  Each add-on has its own QR. Scan the guest&apos;s add-on QR (or use Bookings → Orders) to mark it served.
                </p>
              </div>
            )}

            {(payload.quantity != null && payload.quantity > 1) && valid && (
              <p className="text-base text-amber-200/90 mb-3">
                Party size on this code: <strong>{payload.quantity}</strong> (verify headcount at door).
              </p>
            )}

            {valid && payload.already_admitted && (
              <div
                className="rounded-xl border px-4 py-3 mb-4 text-sm"
                style={{
                  borderColor: 'rgba(59,130,246,0.45)',
                  backgroundColor: 'rgba(59,130,246,0.1)',
                  color: '#93c5fd',
                }}
              >
                Entry already recorded in SEC
                {payload.admitted_at && (
                  <span className="block mt-1 text-xs text-blue-200/80">
                    {formatWhen(payload.admitted_at) || payload.admitted_at}
                  </span>
                )}
              </div>
            )}

            {valid && !payload.already_admitted && payload.can_admit_here && (
              <div className="mb-4 space-y-2">
                <Button
                  type="button"
                  className="w-full sm:w-auto gap-2 bg-emerald-600 hover:bg-emerald-500 text-white"
                  onClick={submitAdmit}
                  disabled={admitting || isLikelyOffline() || !!payload._offline_cached}
                >
                  {admitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <UserCheck className="w-4 h-4" />
                  )}
                  Record entry
                </Button>
                <p className="text-xs text-gray-500 leading-relaxed">
                  Confirms check-in for this guest when the ticket is linked to an event. Use only after ID and
                  headcount checks.
                  {(isLikelyOffline() || payload._offline_cached) && (
                    <span className="block mt-1 text-amber-200/90">
                      Recording entry needs internet — not available while offline or on a saved-only copy.
                    </span>
                  )}
                </p>
              </div>
            )}

            {valid && !payload.already_admitted && !payload.can_admit_here && !payload.order_only && (
              <p className="text-xs text-gray-500 mb-4 leading-relaxed">
                {!payload.viewer_authenticated ? (
                  <>
                    Anyone can view this ticket by scanning the QR — no login required. Venue staff: sign in on this
                    device to record entry at the door.
                  </>
                ) : payload.admit_denied_for_viewer ? (
                  <>{payload.admit_denied_reason || 'This account cannot record entry for this ticket.'}</>
                ) : (
                  <>
                    Entry cannot be recorded from this screen right now. Reload the page to refresh, or confirm this
                    ticket is still valid and not already admitted elsewhere.
                  </>
                )}
              </p>
            )}

            {payload.door_verify_summary && (
              <div className="flex flex-col sm:flex-row gap-2 pt-3 border-t border-[#262629]">
                <button
                  type="button"
                  onClick={copySummary}
                  className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-medium bg-white/10 hover:bg-white/15 border border-white/10"
                >
                  <Copy className="w-4 h-4" />
                  Copy door summary
                </button>
                <p className="text-xs text-gray-500 sm:flex-1 sm:self-center leading-relaxed">
                  Use for WhatsApp / radio handoff. Installed SEC app: same link can open the app when Universal Links are configured.
                </p>
              </div>
            )}

            {(payload.expires_at || payload.event_starts_at) && (
              <div className="text-xs text-gray-500 space-y-1 mt-4 pt-3 border-t border-[#262629]">
                {payload.event_starts_at && <p>Event start: {formatWhen(payload.event_starts_at) || '—'}</p>}
                {payload.expires_at && <p>Ticket valid until: {formatWhen(payload.expires_at) || '—'}</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {!loading && !payload && (
        <div className="w-full max-w-lg my-auto rounded-2xl border border-amber-500/35 bg-amber-500/10 p-5 text-center">
          <p className="text-sm text-amber-100">Could not load ticket details. Check your connection and try again.</p>
        </div>
      )}

      <Link
        to={createPageUrl('Home')}
        className="mt-auto pt-6 text-sm underline text-gray-500 hover:text-gray-300"
      >
        Back to SEC
      </Link>
    </div>
  );
}
