import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { BadgeCheck, Building2, Flag, Loader2 } from 'lucide-react';
import { apiGet, apiPatch, apiPost } from '@/api/client';
import { useAuth } from '@/lib/AuthContext';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { StarRatingDisplay, StarRatingInput } from '@/components/reviews/StarRating';

export function vendorReviewQueryKeys(vendorId) {
  return {
    list: ['vendor-reviews', vendorId],
    eligibility: ['vendor-review-eligibility', vendorId],
    venueEligibility: ['vendor-review-venue-eligibility', vendorId],
  };
}

function VerifiedHireBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
      style={{ color: 'var(--sec-success, #22c55e)', background: 'rgba(34,197,94,0.12)' }}
      title="This reviewer completed a hire request with this vendor on SEC"
    >
      <BadgeCheck className="w-3 h-3" />
      Verified hire
    </span>
  );
}

/**
 * Reviews for a vendor listing. Same rules as profile reviews: one review per person and one per venue,
 * 10–300 characters, the listing owner can flag reviews for admin moderation.
 */
export default function VendorReviewsSection({ vendorId, vendorName, ownerId }) {
  const { user, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const keys = vendorReviewQueryKeys(vendorId);
  const [page, setPage] = useState(1);
  const [accReviews, setAccReviews] = useState([]);
  const [writeOpen, setWriteOpen] = useState(false);
  const [venueWriteOpen, setVenueWriteOpen] = useState(false);
  const [editReview, setEditReview] = useState(null);
  const [flagReview, setFlagReview] = useState(null);
  const [flagReason, setFlagReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formVenueId, setFormVenueId] = useState('');
  const [formRating, setFormRating] = useState(0);
  const [formComment, setFormComment] = useState('');

  const viewerId = user?.id;
  const isOwner = Boolean(viewerId && viewerId === ownerId);
  const canReview = isAuthenticated && viewerId && !isOwner;

  const { data: listData, isLoading, isFetching } = useQuery({
    queryKey: [...keys.list, page],
    queryFn: () => apiGet(`/api/reviews/vendors/${vendorId}?page=${page}`),
    enabled: !!vendorId,
  });

  useEffect(() => {
    setPage(1);
    setAccReviews([]);
  }, [vendorId]);

  useEffect(() => {
    if (!listData?.reviews) return;
    if (page === 1) {
      setAccReviews(listData.reviews);
    } else {
      setAccReviews((prev) => {
        const ids = new Set(prev.map((x) => x.id));
        return [...prev, ...listData.reviews.filter((r) => !ids.has(r.id))];
      });
    }
  }, [listData, page]);

  const { data: eligibility } = useQuery({
    queryKey: keys.eligibility,
    queryFn: () => apiGet(`/api/reviews/vendors/${vendorId}/eligibility`),
    enabled: !!vendorId && !!canReview,
  });

  const { data: venueEligibility } = useQuery({
    queryKey: keys.venueEligibility,
    queryFn: () => apiGet(`/api/reviews/vendors/${vendorId}/venue-eligibility`),
    enabled: !!vendorId && !!canReview,
  });

  const venues = venueEligibility?.venues || [];
  const venuesCanReview = venues.filter((v) => !v.existingReview);
  const venuesWithExisting = venues.filter((v) => v.existingReview);

  const refresh = () => {
    setPage(1);
    queryClient.invalidateQueries({ queryKey: keys.list });
    queryClient.invalidateQueries({ queryKey: keys.eligibility });
    queryClient.invalidateQueries({ queryKey: keys.venueEligibility });
    queryClient.invalidateQueries({ queryKey: ['vendor', vendorId] });
    queryClient.invalidateQueries({ queryKey: ['reviews-me-given'] });
  };

  const openEdit = (rev) => {
    setEditReview(rev);
    setFormRating(rev.rating);
    setFormComment(rev.comment);
    if (rev.reviewSource === 'venue') {
      setFormVenueId(rev.venueId || '');
      setVenueWriteOpen(true);
    } else {
      setWriteOpen(true);
    }
  };

  const openWrite = () => {
    if (eligibility?.existingReview) {
      openEdit({ ...eligibility.existingReview, reviewSource: 'user' });
      return;
    }
    setEditReview(null);
    setFormRating(0);
    setFormComment('');
    setWriteOpen(true);
  };

  const openVenueWrite = () => {
    const existing = venuesWithExisting[0];
    if (existing && venuesCanReview.length === 0) {
      openEdit({ ...existing.existingReview, reviewSource: 'venue', venueId: existing.id });
      return;
    }
    setEditReview(null);
    setFormVenueId(venuesCanReview[0]?.id || '');
    setFormRating(0);
    setFormComment('');
    setVenueWriteOpen(true);
  };

  const validForm = () => {
    if (formRating < 1 || formComment.trim().length < 10) {
      toast.error('Rating and comment (10–300 characters) are required.');
      return false;
    }
    return true;
  };

  const submit = async (asVenue) => {
    if (!validForm()) return;
    if (asVenue && !editReview && !formVenueId) {
      toast.error('Choose which venue this review is from.');
      return;
    }
    setSubmitting(true);
    try {
      const body = { rating: formRating, comment: formComment.trim() };
      if (editReview) {
        const url =
          editReview.reviewSource === 'venue'
            ? `/api/reviews/vendors/venue-review/${editReview.id}`
            : `/api/reviews/vendors/review/${editReview.id}`;
        await apiPatch(url, body);
        toast.success('Review updated');
      } else if (asVenue) {
        await apiPost(`/api/reviews/vendors/${vendorId}/as-venue`, { ...body, venueId: formVenueId });
        toast.success('Venue review posted!');
      } else {
        await apiPost(`/api/reviews/vendors/${vendorId}`, body);
        toast.success('Review posted!');
      }
      setWriteOpen(false);
      setVenueWriteOpen(false);
      setEditReview(null);
      refresh();
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const submitFlag = async () => {
    const reason = flagReason.trim();
    if (!reason || reason.length > 200) {
      toast.error('Reason required (max 200 characters).');
      return;
    }
    if (!flagReview) return;
    setSubmitting(true);
    try {
      const url =
        flagReview.reviewSource === 'venue'
          ? `/api/reviews/vendors/venue-review/${flagReview.id}/flag`
          : `/api/reviews/vendors/review/${flagReview.id}/flag`;
      await apiPost(url, { reason });
      toast.success("Review flagged for admin review. We'll look into this shortly.");
      setFlagReview(null);
      setFlagReason('');
      refresh();
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const avg = listData?.averageRating ?? 0;
  const total = listData?.totalReviews ?? 0;
  const totalPages = listData?.totalPages ?? 1;

  const commentField = (
    <>
      <p className="text-sm mb-1">Rating</p>
      <StarRatingInput value={formRating} onChange={setFormRating} />
      <label className="block text-sm mt-4 mb-1">Comment</label>
      <Textarea
        value={formComment}
        onChange={(e) => setFormComment(e.target.value)}
        minLength={10}
        maxLength={300}
        rows={4}
        placeholder="How was working with this vendor? Quality, reliability, communication…"
        className="min-h-[100px] bg-[#141416] border-[#262629]"
      />
      <p className="text-xs text-gray-500 mt-1">{formComment.length}/300</p>
    </>
  );

  return (
    <div className="mt-8 border-t border-[#262629] pt-6">
      <h3 className="text-sm font-semibold text-gray-500 mb-2">Reviews</h3>
      {total === 0 ? (
        <p className="text-sm text-gray-400 mb-4">No reviews yet</p>
      ) : (
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <StarRatingDisplay value={avg} size={20} />
          <span className="text-lg font-semibold">{avg.toFixed(1)}</span>
          <span className="text-sm text-gray-500">
            ({total} {total === 1 ? 'review' : 'reviews'})
          </span>
        </div>
      )}

      {canReview && (
        <div className="mb-4 flex flex-col sm:flex-row gap-2">
          {eligibility?.eligible && (
            <Button type="button" className="min-h-[44px] w-full sm:w-auto" onClick={openWrite}>
              {eligibility?.existingReview ? 'Edit your review' : 'Write a review'}
            </Button>
          )}
          {venues.length > 0 && (
            <Button type="button" variant="outline" className="min-h-[44px] w-full sm:w-auto" onClick={openVenueWrite}>
              <Building2 className="w-4 h-4 mr-2" />
              {venuesCanReview.length === 0 ? 'Edit venue review' : 'Review as venue'}
            </Button>
          )}
        </div>
      )}

      {isLoading && page === 1 && (
        <div className="flex justify-center py-8">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--sec-accent)]" />
        </div>
      )}

      <ul className="space-y-4">
        {accReviews.map((r) => (
          <li key={r.id} className="rounded-xl border border-[#262629] bg-[#141416] p-4">
            <div className="flex gap-3">
              <div className="w-11 h-11 rounded-full bg-[#262629] overflow-hidden shrink-0 flex items-center justify-center">
                {r.reviewSource === 'venue' ? (
                  r.venue?.logoUrl ? (
                    <img src={r.venue.logoUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Building2 className="w-5 h-5 text-gray-400" />
                  )
                ) : r.reviewer?.avatarUrl ? (
                  <img src={r.reviewer.avatarUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-sm font-bold">
                    {(r.reviewer?.fullName || r.reviewer?.username || '?')[0]?.toUpperCase()}
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {r.reviewSource === 'venue' && r.venue ? (
                      <>
                        <Link
                          to={createPageUrl(`VenueProfile?id=${r.venue.id}`)}
                          className="font-medium truncate hover:text-[var(--sec-accent)]"
                        >
                          {r.venue.name}
                        </Link>
                        <p className="text-xs text-gray-500">Venue review</p>
                      </>
                    ) : (
                      <>
                        <p className="font-medium truncate">{r.reviewer?.fullName || r.reviewer?.username}</p>
                        <p className="text-xs text-gray-500">@{r.reviewer?.username}</p>
                      </>
                    )}
                    {r.verifiedHire && (
                      <div className="mt-1">
                        <VerifiedHireBadge />
                      </div>
                    )}
                  </div>
                  <StarRatingDisplay value={r.rating} size={14} />
                </div>
                <p className="text-sm text-gray-300 mt-2 whitespace-pre-wrap">{r.comment}</p>
                <p className="text-xs text-gray-600 mt-2">
                  {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}
                </p>
                {isOwner && (
                  <button
                    type="button"
                    className="mt-3 min-h-[44px] min-w-[44px] inline-flex items-center gap-1 text-xs text-amber-500"
                    onClick={() => setFlagReview(r)}
                  >
                    <Flag className="w-4 h-4" />
                    Flag
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {totalPages > 1 && page < totalPages && (
        <Button
          type="button"
          variant="outline"
          className="mt-4 w-full min-h-[44px]"
          disabled={isFetching}
          onClick={() => setPage((p) => p + 1)}
        >
          {isFetching ? 'Loading…' : 'Load more'}
        </Button>
      )}

      <Dialog open={writeOpen} onOpenChange={(o) => { if (!o) { setWriteOpen(false); setEditReview(null); } }}>
        <DialogContent className="max-w-app md:max-w-app-md max-h-[90vh] overflow-y-auto bg-[#0A0A0B] border-[#262629]">
          <DialogHeader>
            <DialogTitle>{editReview ? 'Edit review' : `Review ${vendorName || 'vendor'}`}</DialogTitle>
          </DialogHeader>
          {commentField}
          <Button type="button" className="w-full mt-4 min-h-[44px]" disabled={submitting} onClick={() => submit(false)}>
            {editReview ? 'Save' : 'Post review'}
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={venueWriteOpen} onOpenChange={(o) => { if (!o) { setVenueWriteOpen(false); setEditReview(null); } }}>
        <DialogContent className="max-w-app md:max-w-app-md max-h-[90vh] overflow-y-auto bg-[#0A0A0B] border-[#262629]">
          <DialogHeader>
            <DialogTitle>
              {editReview?.reviewSource === 'venue' ? 'Edit venue review' : `Review ${vendorName || 'vendor'} as venue`}
            </DialogTitle>
          </DialogHeader>
          {!editReview && (
            <>
              <label className="block text-sm mb-1">Venue</label>
              <select
                className="w-full min-h-[44px] rounded-lg bg-[#141416] border border-[#262629] px-3 mb-4"
                value={formVenueId}
                onChange={(e) => setFormVenueId(e.target.value)}
              >
                <option value="">Select venue</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id} disabled={!!v.existingReview}>
                    {v.name}
                    {v.existingReview ? ' (already reviewed)' : v.verifiedHire ? ' · verified hire' : ''}
                  </option>
                ))}
              </select>
            </>
          )}
          {commentField}
          <Button type="button" className="w-full mt-4 min-h-[44px]" disabled={submitting} onClick={() => submit(true)}>
            {editReview?.reviewSource === 'venue' ? 'Save' : 'Post venue review'}
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={!!flagReview} onOpenChange={(o) => { if (!o) setFlagReview(null); }}>
        <DialogContent className="max-w-app md:max-w-app-md bg-[#0A0A0B] border-[#262629]">
          <DialogHeader>
            <DialogTitle>Why are you flagging this review?</DialogTitle>
          </DialogHeader>
          <Textarea
            value={flagReason}
            onChange={(e) => setFlagReason(e.target.value)}
            maxLength={200}
            rows={3}
            placeholder="Describe the issue"
            className="bg-[#141416] border-[#262629]"
          />
          <Button type="button" className="w-full min-h-[44px] mt-2" disabled={submitting} onClick={submitFlag}>
            Submit
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
