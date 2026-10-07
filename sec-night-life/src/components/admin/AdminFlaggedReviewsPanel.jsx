import React, { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch } from '@/api/client';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import AdminEmptyState from './AdminEmptyState';

function FlaggedReviewCard({ review, reviewType, actionLoading, onDismiss, onRemove }) {
  const renderHeader = () => {
    if (reviewType === 'user') {
      return (
        <p className="text-sm">
          <span className="font-medium">{review.reviewer?.fullName || review.reviewer?.username}</span>
          <span className="text-[var(--sec-text-muted)]"> @{review.reviewer?.username}</span>
          {' → '}
          <span className="font-medium">{review.subject?.fullName || review.subject?.username}</span>
          <span className="text-[var(--sec-text-muted)]"> @{review.subject?.username}</span>
        </p>
      );
    }
    if (reviewType === 'vendor' || reviewType === 'venue_vendor') {
      return (
        <p className="text-sm">
          {reviewType === 'vendor' ? (
            <>
              <span className="font-medium">{review.reviewer?.fullName || review.reviewer?.username}</span>
              <span className="text-[var(--sec-text-muted)]"> @{review.reviewer?.username}</span>
            </>
          ) : (
            <span className="font-medium">{review.venue?.name}</span>
          )}
          {' → '}
          <a
            href={`/VendorDetail?id=${encodeURIComponent(review.vendor?.id || '')}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline"
          >
            {review.vendor?.name || 'Vendor'}
          </a>
          <span className="text-[var(--sec-text-muted)]"> (vendor)</span>
        </p>
      );
    }
    if (reviewType === 'venue') {
      return (
        <p className="text-sm">
          <span className="font-medium">{review.reviewer?.fullName || review.reviewer?.username}</span>
          <span className="text-[var(--sec-text-muted)]"> @{review.reviewer?.username}</span>
          {' → '}
          <span className="font-medium">{review.venue?.name}</span>
        </p>
      );
    }
    return (
      <p className="text-sm">
        <span className="font-medium">{review.venue?.name}</span>
        {' → '}
        <span className="font-medium">{review.subject?.fullName || review.subject?.username}</span>
        <span className="text-[var(--sec-text-muted)]"> @{review.subject?.username}</span>
      </p>
    );
  };

  const apiType = reviewType === 'venue_user' ? 'venue_user' : reviewType;

  return (
    <div className="p-4 rounded-xl bg-[#141416] border border-[#262629] space-y-2">
      {renderHeader()}
      {review.event?.name && (
        <p className="text-xs text-[var(--sec-text-muted)]">Event: {review.event.name}</p>
      )}
      <p className="text-sm">Rating: {review.rating}/5</p>
      <p className="text-sm text-gray-300 whitespace-pre-wrap">{review.comment}</p>
      <p className="text-xs text-amber-500">Flag: {review.flagReason}</p>
      <p className="text-xs text-[var(--sec-text-muted)]">
        {review.flaggedAt ? new Date(review.flaggedAt).toLocaleString() : ''}
      </p>
      <div className="flex gap-2 pt-2">
        <Button
          size="sm"
          variant="outline"
          className="min-h-[44px] flex-1"
          disabled={actionLoading === `dismiss-${review.id}`}
          onClick={() => onDismiss(apiType, review.id)}
        >
          Dismiss Flag
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="min-h-[44px] flex-1 border-red-500/40 text-red-400"
          disabled={actionLoading === `remove-${review.id}`}
          onClick={() => onRemove(apiType, review.id)}
        >
          Remove Review
        </Button>
      </div>
    </div>
  );
}

const EMPTY_FLAGGED = {
  userReviews: [],
  venueReviews: [],
  venueUserReviews: [],
  vendorReviews: [],
  venueVendorReviews: [],
};

export default function AdminFlaggedReviewsPanel({ onFlaggedCountChange }) {
  const [flaggedReviews, setFlaggedReviews] = useState(EMPTY_FLAGGED);
  const [actionLoading, setActionLoading] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadFlaggedReviews = async () => {
    try {
      const res = await apiGet('/api/reviews/admin/flagged');
      const data = {
        userReviews: res?.userReviews || [],
        venueReviews: res?.venueReviews || [],
        venueUserReviews: res?.venueUserReviews || [],
        vendorReviews: res?.vendorReviews || [],
        venueVendorReviews: res?.venueVendorReviews || [],
      };
      setFlaggedReviews(data);
      const count = Object.values(data).reduce((n, list) => n + list.length, 0);
      onFlaggedCountChange?.(count);
    } catch (err) {
      setFlaggedReviews(EMPTY_FLAGGED);
      onFlaggedCountChange?.(0);
      toast.error(`Could not load flagged reviews${err?.message ? `: ${err.message}` : ''}`);
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      await loadFlaggedReviews();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDismissFlagged = async (reviewType, reviewId) => {
    setActionLoading(`dismiss-${reviewId}`);
    try {
      await apiPatch(`/api/reviews/admin/${reviewType}/${reviewId}/dismiss`, {});
      await loadFlaggedReviews();
      toast.success('Flag dismissed');
    } catch (err) {
      toast.error(err?.data?.error || err?.message || 'Failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveFlagged = async (reviewType, reviewId) => {
    const ok = window.confirm('Permanently delete this review? This cannot be undone.');
    if (!ok) return;
    setActionLoading(`remove-${reviewId}`);
    try {
      await apiDelete(`/api/reviews/admin/${reviewType}/${reviewId}/remove`);
      await loadFlaggedReviews();
      toast.success('Review removed');
    } catch (err) {
      toast.error(err?.data?.error || err?.message || 'Failed');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return <AdminEmptyState message="Loading flagged reviews…" />;
  }

  const isEmpty = Object.values(flaggedReviews).every((list) => !list?.length);

  return (
    <div className="space-y-6">
      <h3 className="font-semibold">Flagged reviews</h3>
      {isEmpty ? (
        <AdminEmptyState message="No flagged reviews at this time." />
      ) : (
        <>
          <div>
            <h4 className="text-sm font-medium text-[var(--sec-text-muted)] mb-2">User reviews</h4>
            <div className="space-y-3">
              {(flaggedReviews.userReviews || []).length === 0 ? (
                <p className="text-xs text-[var(--sec-text-muted)]">None</p>
              ) : (
                flaggedReviews.userReviews.map((r) => (
                  <FlaggedReviewCard
                    key={r.id}
                    review={r}
                    reviewType="user"
                    actionLoading={actionLoading}
                    onDismiss={handleDismissFlagged}
                    onRemove={handleRemoveFlagged}
                  />
                ))
              )}
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium text-[var(--sec-text-muted)] mb-2">Venue reviews (user → venue)</h4>
            <div className="space-y-3">
              {(flaggedReviews.venueReviews || []).length === 0 ? (
                <p className="text-xs text-[var(--sec-text-muted)]">None</p>
              ) : (
                flaggedReviews.venueReviews.map((r) => (
                  <FlaggedReviewCard
                    key={r.id}
                    review={r}
                    reviewType="venue"
                    actionLoading={actionLoading}
                    onDismiss={handleDismissFlagged}
                    onRemove={handleRemoveFlagged}
                  />
                ))
              )}
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium text-[var(--sec-text-muted)] mb-2">Venue reviews (venue → user)</h4>
            <div className="space-y-3">
              {(flaggedReviews.venueUserReviews || []).length === 0 ? (
                <p className="text-xs text-[var(--sec-text-muted)]">None</p>
              ) : (
                flaggedReviews.venueUserReviews.map((r) => (
                  <FlaggedReviewCard
                    key={r.id}
                    review={r}
                    reviewType="venue_user"
                    actionLoading={actionLoading}
                    onDismiss={handleDismissFlagged}
                    onRemove={handleRemoveFlagged}
                  />
                ))
              )}
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium text-[var(--sec-text-muted)] mb-2">Vendor reviews (person → vendor)</h4>
            <div className="space-y-3">
              {(flaggedReviews.vendorReviews || []).length === 0 ? (
                <p className="text-xs text-[var(--sec-text-muted)]">None</p>
              ) : (
                flaggedReviews.vendorReviews.map((r) => (
                  <FlaggedReviewCard
                    key={r.id}
                    review={r}
                    reviewType="vendor"
                    actionLoading={actionLoading}
                    onDismiss={handleDismissFlagged}
                    onRemove={handleRemoveFlagged}
                  />
                ))
              )}
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium text-[var(--sec-text-muted)] mb-2">Vendor reviews (venue → vendor)</h4>
            <div className="space-y-3">
              {(flaggedReviews.venueVendorReviews || []).length === 0 ? (
                <p className="text-xs text-[var(--sec-text-muted)]">None</p>
              ) : (
                flaggedReviews.venueVendorReviews.map((r) => (
                  <FlaggedReviewCard
                    key={r.id}
                    review={r}
                    reviewType="venue_vendor"
                    actionLoading={actionLoading}
                    onDismiss={handleDismissFlagged}
                    onRemove={handleRemoveFlagged}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
