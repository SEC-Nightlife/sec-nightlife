import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Building2, CalendarDays, MessageCircle, Store } from 'lucide-react';
import { apiGet, apiPatch, apiPost } from '@/api/client';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { VENDOR_INQUIRY_STATUS_LABELS, vendorCategoryLabel } from '@/lib/vendorCategories';

const STATUS_COLORS = {
  REQUESTED: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  ACCEPTED: { color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
  COMPLETED: { color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
  DECLINED: { color: '#9ca3af', bg: 'rgba(156,163,175,0.12)' },
  CANCELLED: { color: '#9ca3af', bg: 'rgba(156,163,175,0.12)' },
};

export function vendorInquiriesQueryKey(mode) {
  return mode === 'received' ? ['vendor-inquiries-received'] : ['vendor-inquiries-sent'];
}

export async function openDirectMessage(navigate, participantId) {
  const conv = await apiPost('/api/messages/conversations/find-or-create', { participantId });
  const cid = conv?.id || conv?.conversationId;
  if (!cid) throw new Error('Could not open conversation');
  navigate(`${createPageUrl('Messages')}?dm=${encodeURIComponent(cid)}`);
}

/**
 * Hire requests list.
 * mode="received": vendor owner manages incoming requests.
 * mode="sent": venue owner tracks requests they sent.
 */
export default function VendorInquiriesList({ mode, emptyText }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState(null);
  const queryKey = vendorInquiriesQueryKey(mode);

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => apiGet(`/api/vendors/inquiries/${mode}`),
  });
  const inquiries = data?.inquiries || [];

  const act = async (inq, action) => {
    let response;
    if (mode === 'received' && (action === 'accept' || action === 'decline')) {
      response = window.prompt(
        action === 'accept' ? 'Optional note for the venue (e.g. next steps):' : 'Optional reason for declining:',
        ''
      );
      if (response === null) return;
    }
    if (action === 'cancel' && !window.confirm('Cancel this hire request?')) return;
    setBusyId(inq.id);
    try {
      await apiPatch(`/api/vendors/inquiries/${inq.id}`, { action, response: response?.trim() || null });
      toast.success('Request updated');
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ['vendor-hire-status', inq.vendor_id] });
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Could not update request');
    } finally {
      setBusyId(null);
    }
  };

  const message = async (inq) => {
    const other = mode === 'received' ? inq.requester_user_id : inq.vendor?.owner_user_id;
    if (!other) return;
    try {
      await openDirectMessage(navigate, other);
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Could not open conversation');
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <div className="sec-spinner" />
      </div>
    );
  }

  if (!inquiries.length) {
    return <p className="text-sm py-4" style={{ color: 'var(--sec-text-muted)' }}>{emptyText || 'No hire requests yet.'}</p>;
  }

  return (
    <ul className="space-y-3">
      {inquiries.map((inq) => {
        const colors = STATUS_COLORS[inq.status] || STATUS_COLORS.CANCELLED;
        const busy = busyId === inq.id;
        const open = inq.status === 'REQUESTED' || inq.status === 'ACCEPTED';
        return (
          <li
            key={inq.id}
            className="rounded-xl p-4"
            style={{ background: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)' }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                {mode === 'received' ? (
                  <p className="font-semibold flex items-center gap-2 truncate" style={{ color: 'var(--sec-text-primary)' }}>
                    <Building2 className="w-4 h-4 shrink-0" />
                    {inq.venue?.name || 'Venue'}
                  </p>
                ) : (
                  <Link
                    to={`${createPageUrl('VendorDetail')}?id=${encodeURIComponent(inq.vendor_id)}`}
                    className="font-semibold flex items-center gap-2 truncate"
                    style={{ color: 'var(--sec-text-primary)' }}
                  >
                    <Store className="w-4 h-4 shrink-0" />
                    {inq.vendor?.name || 'Vendor'}
                  </Link>
                )}
                <p className="text-xs mt-0.5" style={{ color: 'var(--sec-text-muted)' }}>
                  {mode === 'received'
                    ? `For ${inq.vendor?.name || 'your listing'}${inq.requester?.username ? ` · @${inq.requester.username}` : ''}`
                    : `${vendorCategoryLabel(inq.vendor?.category)} · from ${inq.venue?.name || 'your venue'}`}
                </p>
              </div>
              <span
                className="text-[11px] font-semibold px-2 py-0.5 rounded shrink-0"
                style={{ color: colors.color, background: colors.bg }}
              >
                {VENDOR_INQUIRY_STATUS_LABELS[inq.status] || inq.status}
              </span>
            </div>

            {inq.event_date && (
              <p className="text-xs mt-2 flex items-center gap-1.5" style={{ color: 'var(--sec-text-secondary)' }}>
                <CalendarDays className="w-3.5 h-3.5" />
                {format(new Date(inq.event_date), 'EEE d MMM yyyy')}
              </p>
            )}
            <p className="text-sm mt-2 whitespace-pre-wrap" style={{ color: 'var(--sec-text-secondary)' }}>
              {inq.message}
            </p>
            {inq.vendor_response && (
              <p className="text-xs mt-2 p-2 rounded-lg whitespace-pre-wrap" style={{ background: 'var(--sec-bg-elevated)', color: 'var(--sec-text-secondary)' }}>
                <span className="font-semibold">Vendor note:</span> {inq.vendor_response}
              </p>
            )}
            <p className="text-[11px] mt-2" style={{ color: 'var(--sec-text-muted)' }}>
              Sent {format(new Date(inq.created_at), 'd MMM yyyy')}
            </p>

            <div className="flex flex-wrap gap-2 mt-3">
              {mode === 'received' && inq.status === 'REQUESTED' && (
                <>
                  <Button size="sm" className="min-h-[40px]" disabled={busy} onClick={() => act(inq, 'accept')}>
                    Accept
                  </Button>
                  <Button size="sm" variant="outline" className="min-h-[40px]" disabled={busy} onClick={() => act(inq, 'decline')}>
                    Decline
                  </Button>
                </>
              )}
              {inq.status === 'ACCEPTED' && (
                <Button size="sm" className="min-h-[40px]" disabled={busy} onClick={() => act(inq, 'complete')}>
                  Mark as completed
                </Button>
              )}
              {mode === 'received' && inq.status === 'ACCEPTED' && (
                <Button size="sm" variant="outline" className="min-h-[40px]" disabled={busy} onClick={() => act(inq, 'decline')}>
                  Decline
                </Button>
              )}
              {mode === 'sent' && open && (
                <Button size="sm" variant="outline" className="min-h-[40px]" disabled={busy} onClick={() => act(inq, 'cancel')}>
                  Cancel request
                </Button>
              )}
              {(open || inq.status === 'COMPLETED') && (
                <Button size="sm" variant="outline" className="min-h-[40px]" onClick={() => void message(inq)}>
                  <MessageCircle className="w-4 h-4 mr-1" />
                  Message
                </Button>
              )}
              {mode === 'sent' && inq.status === 'COMPLETED' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-[40px]"
                  onClick={() => navigate(`${createPageUrl('VendorDetail')}?id=${encodeURIComponent(inq.vendor_id)}#reviews`)}
                >
                  Leave a review
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
