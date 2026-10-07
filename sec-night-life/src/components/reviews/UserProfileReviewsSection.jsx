import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Flag, Loader2, Building2 } from 'lucide-react';
import { apiGet, apiPatch, apiPost, apiDelete } from '@/api/client';
import { useAuth } from '@/lib/AuthContext';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { StarRatingDisplay, StarRatingInput } from './StarRating';

const GIVEN_REVIEW_DELETE_URL = {
  user: (id) => `/api/reviews/users/review/${id}`,
  venue: (id) => `/api/reviews/venues/users/review/${id}`,
  vendor: (id) => `/api/reviews/vendors/review/${id}`,
  venue_vendor: (id) => `/api/reviews/vendors/venue-review/${id}`,
};

function isVendorReview(r) {
  return r.reviewSource === 'vendor' || r.reviewSource === 'venue_vendor';
}

function ReviewsIGave({ onEdit }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['reviews-me-given'],
    queryFn: () => apiGet('/api/reviews/me/given'),
  });
  const rows = data?.reviews ?? [];

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const toUrl = GIVEN_REVIEW_DELETE_URL[deleteTarget.reviewSource] || GIVEN_REVIEW_DELETE_URL.user;
      await apiDelete(toUrl(deleteTarget.id));
      toast.success('Review deleted');
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ['reviews-me-given'] });
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  if (isLoading) {
    return <p className="text-sm text-gray-500 py-4">Loading…</p>;
  }
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="mt-8">
      <h4 className="text-sm font-semibold text-gray-500 mb-3">Reviews I&apos;ve given</h4>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.id} className="rounded-xl border border-[#262629] bg-[#141416] p-4 flex justify-between gap-2 items-start">
            <div className="min-w-0">
              {isVendorReview(r) ? (
                <>
                  <p className="text-sm font-medium truncate">{r.vendor?.name || 'Vendor'}</p>
                  <p className="text-xs text-gray-500">Vendor review</p>
                </>
              ) : (
                <p className="text-sm font-medium truncate">@{r.subject?.username}</p>
              )}
              {(r.reviewSource === 'venue' || r.reviewSource === 'venue_vendor') && r.venue?.name && (
                <p className="text-xs text-gray-500">As {r.venue.name}</p>
              )}
              {r.event?.name && <p className="text-xs text-gray-500">From {r.event.name}</p>}
              <StarRatingDisplay value={r.rating} size={14} className="mt-1" />
              <p className="text-sm text-gray-300 mt-2 whitespace-pre-wrap">{r.comment}</p>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              <Button
                type="button"
                variant="outline"
                className="min-h-[44px]"
                onClick={() =>
                  isVendorReview(r) && r.vendor?.id
                    ? navigate(`${createPageUrl('VendorDetail')}?id=${encodeURIComponent(r.vendor.id)}#reviews`)
                    : onEdit(r)
                }
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-[44px] text-red-400 border-red-900/50"
                onClick={() => setDeleteTarget(r)}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent className="bg-[#0A0A0B] border-[#262629]">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete review?</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-400">
              Are you sure you want to delete this review? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-transparent border-[#262629]">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function UserProfileReviewsSection({ profileUserId, profileUsername, showReviewsIGave = false }) {
  const { user, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
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
  const isOwnProfile = viewerId && viewerId === profileUserId;

  const { data: listData, isLoading, isFetching } = useQuery({
    queryKey: ['user-reviews', profileUserId, page],
    queryFn: () => apiGet(`/api/reviews/users/${profileUserId}?page=${page}`),
    enabled: !!profileUserId,
  });

  useEffect(() => {
    setPage(1);
    setAccReviews([]);
  }, [profileUserId]);

  useEffect(() => {
    if (!listData?.reviews) return;
    if (page === 1) {
      setAccReviews(listData.reviews);
    } else {
      setAccReviews((prev) => {
        const ids = new Set(prev.map((x) => x.id));
        const add = listData.reviews.filter((r) => !ids.has(r.id));
        return [...prev, ...add];
      });
    }
  }, [listData, page]);

  const { data: eligibility } = useQuery({
    queryKey: ['user-review-eligibility', profileUserId],
    queryFn: () => apiGet(`/api/reviews/users/${profileUserId}/eligibility`),
    enabled: !!profileUserId && isAuthenticated && !!viewerId && viewerId !== profileUserId,
  });

  const { data: venueEligibility } = useQuery({
    queryKey: ['user-review-venue-eligibility', profileUserId],
    queryFn: () => apiGet(`/api/reviews/users/${profileUserId}/venue-eligibility`),
    enabled: !!profileUserId && isAuthenticated && !!viewerId && viewerId !== profileUserId,
  });

  const venuesCanReview = (venueEligibility?.venues || []).filter((v) => !v.existingReview);
  const venuesWithExisting = (venueEligibility?.venues || []).filter((v) => v.existingReview);
  const hasVenueReviewOption = venuesCanReview.length > 0 || venuesWithExisting.length > 0;

  const resetWriteForm = () => {
    setFormRating(0);
    setFormComment('');
    setEditReview(null);
  };

  const openWrite = () => {
    if (eligibility?.existingReview) {
      openEdit({ ...eligibility.existingReview, reviewSource: 'user' });
      return;
    }
    resetWriteForm();
    setWriteOpen(true);
  };

  const openVenueWrite = () => {
    const existingVenue = venuesWithExisting[0];
    if (existingVenue?.existingReview && venuesCanReview.length === 0) {
      openEdit({
        ...existingVenue.existingReview,
        reviewSource: 'venue',
        venueId: existingVenue.id,
        venue: { id: existingVenue.id, name: existingVenue.name },
      });
      return;
    }
    const first = venuesCanReview[0]?.id || '';
    setFormVenueId(first);
    setFormRating(0);
    setFormComment('');
    setVenueWriteOpen(true);
  };

  const openEdit = (rev) => {
    setEditReview(rev);
    setFormRating(rev.rating);
    setFormComment(rev.comment);
    if (rev.reviewSource === 'venue') {
      setFormVenueId(rev.venueId || rev.venue?.id || '');
      setVenueWriteOpen(true);
    } else {
      setWriteOpen(true);
    }
  };

  const submitWrite = async () => {
    if (editReview) {
      if (formRating < 1 || formComment.trim().length < 10) {
        toast.error('Rating and comment (10–300 characters) are required.');
        return;
      }
      setSubmitting(true);
      try {
        const url =
          editReview.reviewSource === 'venue'
            ? `/api/reviews/venues/users/review/${editReview.id}`
            : `/api/reviews/users/review/${editReview.id}`;
        await apiPatch(url, {
          rating: formRating,
          comment: formComment.trim(),
        });
        toast.success('Review updated');
        setWriteOpen(false);
        setVenueWriteOpen(false);
        setEditReview(null);
        setPage(1);
        queryClient.invalidateQueries({ queryKey: ['user-reviews', profileUserId] });
        queryClient.invalidateQueries({ queryKey: ['reviews-me-given'] });
        queryClient.invalidateQueries({ queryKey: ['user-review-eligibility', profileUserId] });
        queryClient.invalidateQueries({ queryKey: ['user-review-venue-eligibility', profileUserId] });
      } catch (e) {
        toast.error(e?.data?.error || e?.message || 'Failed');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (formRating < 1 || formComment.trim().length < 10) {
      toast.error('Rating and comment (10–300 characters) are required.');
      return;
    }
    setSubmitting(true);
    try {
      await apiPost(`/api/reviews/users/${profileUserId}`, {
        rating: formRating,
        comment: formComment.trim(),
      });
      toast.success('Review posted!');
      setWriteOpen(false);
      setPage(1);
      queryClient.invalidateQueries({ queryKey: ['user-reviews', profileUserId] });
      queryClient.invalidateQueries({ queryKey: ['user-review-eligibility', profileUserId] });
      queryClient.invalidateQueries({ queryKey: ['public-profile', profileUserId] });
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const submitVenueWrite = async () => {
    const existingVenueReview = (venueEligibility?.venues || []).find(
      (v) => v.id === formVenueId
    )?.existingReview;

    if (editReview?.reviewSource === 'venue') {
      if (formRating < 1 || formComment.trim().length < 10) {
        toast.error('Rating and comment (10–300 characters) are required.');
        return;
      }
      setSubmitting(true);
      try {
        await apiPatch(`/api/reviews/venues/users/review/${editReview.id}`, {
          rating: formRating,
          comment: formComment.trim(),
        });
        toast.success('Review updated');
        setVenueWriteOpen(false);
        setEditReview(null);
        setPage(1);
        queryClient.invalidateQueries({ queryKey: ['user-reviews', profileUserId] });
        queryClient.invalidateQueries({ queryKey: ['reviews-me-given'] });
        queryClient.invalidateQueries({ queryKey: ['user-review-venue-eligibility', profileUserId] });
      } catch (e) {
        toast.error(e?.data?.error || e?.message || 'Failed');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (existingVenueReview) {
      openEdit({ ...existingVenueReview, reviewSource: 'venue', venueId: formVenueId });
      return;
    }

    if (formRating < 1 || !formVenueId || formComment.trim().length < 10) {
      toast.error('Choose a venue, rating, and comment (10–300 characters).');
      return;
    }
    setSubmitting(true);
    try {
      await apiPost(`/api/reviews/users/${profileUserId}/as-venue`, {
        venueId: formVenueId,
        rating: formRating,
        comment: formComment.trim(),
      });
      toast.success('Venue review posted!');
      setVenueWriteOpen(false);
      setPage(1);
      queryClient.invalidateQueries({ queryKey: ['user-reviews', profileUserId] });
      queryClient.invalidateQueries({ queryKey: ['user-review-venue-eligibility', profileUserId] });
      queryClient.invalidateQueries({ queryKey: ['public-profile', profileUserId] });
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const submitFlag = async () => {
    const r = flagReason.trim();
    if (r.length < 1 || r.length > 200) {
      toast.error('Reason required (max 200 characters).');
      return;
    }
    if (!flagReview) return;
    setSubmitting(true);
    try {
      const url =
        flagReview.reviewSource === 'venue'
          ? `/api/reviews/venues/users/review/${flagReview.id}/flag`
          : `/api/reviews/users/review/${flagReview.id}/flag`;
      await apiPost(url, { reason: r });
      toast.success("Review flagged for admin review. We'll look into this shortly.");
      setFlagReview(null);
      setFlagReason('');
      setPage(1);
      queryClient.invalidateQueries({ queryKey: ['user-reviews', profileUserId] });
    } catch (e) {
      toast.error(e?.data?.error || e?.message || 'Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const avg = listData?.averageRating ?? 0;
  const total = listData?.totalReviews ?? 0;
  const reviews = accReviews;
  const totalPages = listData?.totalPages ?? 1;

  return (
    <div className="mt-10 border-t border-[#262629] pt-6">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-500 mb-2">Reviews</h3>
          {total === 0 ? (
            <p className="text-sm text-gray-400">No reviews yet</p>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <StarRatingDisplay value={avg} size={20} />
              <span className="text-lg font-semibold">{avg.toFixed(1)}</span>
              <span className="text-sm text-gray-500">({total} reviews)</span>
            </div>
          )}
        </div>
      </div>

      {!isOwnProfile && isAuthenticated && viewerId && (
        <div className="mb-4 flex flex-col sm:flex-row gap-2">
          {eligibility?.eligible && (
            <Button type="button" className="min-h-[44px] w-full sm:w-auto" onClick={openWrite}>
              {eligibility?.existingReview ? 'Edit your review' : 'Write a Review'}
            </Button>
          )}
          {hasVenueReviewOption && (
            <Button type="button" variant="outline" className="min-h-[44px] w-full sm:w-auto" onClick={openVenueWrite}>
              <Building2 className="w-4 h-4 mr-2" />
              {venuesCanReview.length === 0 ? 'Edit venue review' : 'Review as venue'}
            </Button>
          )}
        </div>
      )}

      {(isLoading && page === 1) && (
        <div className="flex justify-center py-8">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--sec-accent)]" />
        </div>
      )}

      <ul className="space-y-4">
        {reviews.map((r) => (
          <li key={r.id} className="rounded-xl border border-[#262629] bg-[#141416] p-4">
            <div className="flex gap-3">
              <div className="w-11 h-11 rounded-full bg-[#262629] overflow-hidden shrink-0 flex items-center justify-center">
                {r.reviewSource === 'venue' ? (
                  <Building2 className="w-5 h-5 text-gray-400" />
                ) : r.reviewer?.avatarUrl ? (
                  <img src={r.reviewer.avatarUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-sm font-bold">
                    {(r.reviewer?.fullName || r.reviewer?.username || '?')[0]?.toUpperCase()}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
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
                  </div>
                  <StarRatingDisplay value={r.rating} size={14} />
                </div>
                <p className="text-sm text-gray-300 mt-2 whitespace-pre-wrap">{r.comment}</p>
                {r.event?.name && (
                  <p className="text-xs text-gray-500 mt-1">From {r.event.name}</p>
                )}
                <p className="text-xs text-gray-600 mt-2">
                  {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}
                </p>
                {viewerId === profileUserId && (
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

      {showReviewsIGave && isOwnProfile && <ReviewsIGave onEdit={openEdit} />}

      <Dialog open={writeOpen} onOpenChange={(o) => { if (!o) { setWriteOpen(false); setEditReview(null); } }}>
        <DialogContent className="max-w-app md:max-w-app-md max-h-[90vh] overflow-y-auto bg-[#0A0A0B] border-[#262629]">
          <DialogHeader>
            <DialogTitle>
              {editReview ? 'Edit review' : `Review @${profileUsername || 'user'}`}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm mb-1">Rating</p>
          <StarRatingInput value={formRating} onChange={setFormRating} />
          <label className="block text-sm mt-4 mb-1">Comment</label>
          <Textarea
            value={formComment}
            onChange={(e) => setFormComment(e.target.value)}
            minLength={10}
            maxLength={300}
            rows={4}
            className="min-h-[100px] bg-[#141416] border-[#262629]"
          />
          <p className="text-xs text-gray-500 mt-1">{formComment.length}/300</p>
          <Button type="button" className="w-full mt-4 min-h-[44px]" disabled={submitting} onClick={submitWrite}>
            {editReview ? 'Save' : 'Post Review'}
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={venueWriteOpen} onOpenChange={(o) => { if (!o) { setVenueWriteOpen(false); setEditReview(null); } }}>
        <DialogContent className="max-w-app md:max-w-app-md max-h-[90vh] overflow-y-auto bg-[#0A0A0B] border-[#262629]">
          <DialogHeader>
            <DialogTitle>
              {editReview?.reviewSource === 'venue' ? 'Edit venue review' : `Review @${profileUsername || 'user'} as venue`}
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
                {(venueEligibility?.venues || []).map((v) => (
                  <option key={v.id} value={v.id} disabled={!!v.existingReview}>
                    {v.name}{v.existingReview ? ' (already reviewed)' : ''}
                  </option>
                ))}
              </select>
            </>
          )}
          <p className="text-sm mb-1">Rating</p>
          <StarRatingInput value={formRating} onChange={setFormRating} />
          <label className="block text-sm mt-4 mb-1">Comment</label>
          <Textarea
            value={formComment}
            onChange={(e) => setFormComment(e.target.value)}
            minLength={10}
            maxLength={300}
            rows={4}
            className="min-h-[100px] bg-[#141416] border-[#262629]"
          />
          <p className="text-xs text-gray-500 mt-1">{formComment.length}/300</p>
          <Button type="button" className="w-full mt-4 min-h-[44px]" disabled={submitting} onClick={submitVenueWrite}>
            {editReview?.reviewSource === 'venue' ? 'Save' : 'Post Venue Review'}
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
