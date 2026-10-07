import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MapPin,
  MessageCircle,
  UserPlus,
  Store,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Phone,
  Mail,
  Instagram,
  Briefcase,
  CheckCircle2,
  Pencil,
  Tag,
  Navigation,
} from 'lucide-react';
import { apiGet, apiPost } from '@/api/client';
import { createPageUrl } from '@/utils';
import { useAuth } from '@/lib/AuthContext';
import * as authService from '@/services/authService';
import { vendorCategoryLabel, vendorPriceText, VENDOR_INQUIRY_STATUS_LABELS } from '@/lib/vendorCategories';
import { formatZar } from '@/lib/money';
import { StarRatingDisplay } from '@/components/reviews/StarRating';
import VendorReviewsSection from '@/components/vendors/VendorReviewsSection';
import HireRequestDialog from '@/components/vendors/HireRequestDialog';
import { openDirectMessage } from '@/components/vendors/VendorInquiriesList';
import ReportDialog from '@/components/moderation/ReportDialog';
import { toast } from 'sonner';

function whatsappHref(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  return digits ? `https://wa.me/${digits}` : null;
}

export default function VendorDetail() {
  const [searchParams] = useSearchParams();
  const id = searchParams.get('id');
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [hireOpen, setHireOpen] = useState(false);
  const [friendRequested, setFriendRequested] = useState(false);

  const { data: vendor, isLoading } = useQuery({
    queryKey: ['vendor', id],
    queryFn: () => apiGet(`/api/vendors/${encodeURIComponent(id)}`),
    enabled: Boolean(id),
  });

  const ownerId = vendor?.owner?.user_id || vendor?.user_id;
  const isOwn = Boolean(user?.id && ownerId && user.id === ownerId);

  const { data: friends = [] } = useQuery({
    queryKey: ['friends-list'],
    queryFn: () => apiGet('/api/friends'),
    enabled: Boolean(user?.id) && !isOwn,
  });

  const { data: hireStatus } = useQuery({
    queryKey: ['vendor-hire-status', id],
    queryFn: () => apiGet(`/api/vendors/${encodeURIComponent(id)}/hire-status`),
    enabled: Boolean(id && user?.id && vendor && !isOwn && vendor.is_published),
  });

  const friendEntry = useMemo(() => {
    if (!ownerId || !Array.isArray(friends)) return null;
    return friends.find((f) => f.id === ownerId) || null;
  }, [friends, ownerId]);
  const isFriend = Boolean(friendEntry);
  const myVenues = hireStatus?.venues || [];
  const openInquiry = hireStatus?.open_inquiry || null;
  const hasInquiryLink = Boolean(openInquiry || hireStatus?.completed_hire);
  const canMessage = isFriend || hasInquiryLink;

  useEffect(() => {
    if (window.location.hash === '#reviews') {
      const t = setTimeout(() => document.getElementById('reviews')?.scrollIntoView({ behavior: 'smooth' }), 400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [vendor?.id]);

  const friendRequestMutation = useMutation({
    mutationFn: () => apiPost('/api/friends/request', { receiverId: ownerId }),
    onSuccess: () => {
      setFriendRequested(true);
      toast.success('Friend request sent');
      queryClient.invalidateQueries({ queryKey: ['friends-list'] });
    },
    onError: (err) => toast.error(err?.data?.error || err?.message || 'Could not send friend request'),
  });

  const openMessage = async () => {
    try {
      if (friendEntry?.conversationId) {
        navigate(`${createPageUrl('Messages')}?dm=${encodeURIComponent(friendEntry.conversationId)}`);
        return;
      }
      await openDirectMessage(navigate, ownerId);
    } catch (err) {
      toast.error(err?.data?.error || err?.message || 'Could not open conversation');
    }
  };

  const images = vendor?.images?.length
    ? vendor.images.map((i) => i.url)
    : vendor?.cover_url
      ? [vendor.cover_url]
      : [];

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--sec-bg-base)' }}>
        <div className="sec-spinner" />
      </div>
    );
  }

  if (!vendor) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 px-6" style={{ backgroundColor: 'var(--sec-bg-base)' }}>
        <p style={{ color: 'var(--sec-text-muted)' }}>Vendor not found</p>
        <button type="button" onClick={() => navigate(createPageUrl('Vendors'))} className="sec-btn sec-btn-primary">
          Back to Vendors
        </button>
      </div>
    );
  }

  const rating = vendor.rating || { average: 0, count: 0 };
  const priceText = vendorPriceText(vendor, formatZar);
  const wa = whatsappHref(vendor.whatsapp);
  const location = [vendor.city, vendor.country].filter(Boolean).join(', ');

  const renderCta = () => {
    if (isOwn) {
      return (
        <button type="button" onClick={() => navigate(createPageUrl('VendorBusinessSettings'))} style={primaryCtaStyle}>
          <Pencil size={18} /> Edit your listing
        </button>
      );
    }
    if (!isAuthenticated || !user?.id) {
      return (
        <button
          type="button"
          onClick={() => authService.redirectToLogin(window.location.href)}
          style={primaryCtaStyle}
        >
          Sign in to contact this vendor
        </button>
      );
    }
    const primary =
      myVenues.length > 0 ? (
        openInquiry ? (
          <button type="button" disabled style={{ ...primaryCtaStyle, opacity: 0.85, cursor: 'default' }}>
            <CheckCircle2 size={18} />
            Request {VENDOR_INQUIRY_STATUS_LABELS[openInquiry.status]?.toLowerCase() || 'sent'}
          </button>
        ) : (
          <button type="button" onClick={() => setHireOpen(true)} style={primaryCtaStyle}>
            <Briefcase size={18} /> Request to hire
          </button>
        )
      ) : canMessage ? (
        <button type="button" onClick={() => void openMessage()} style={primaryCtaStyle}>
          <MessageCircle size={18} /> Message owner
        </button>
      ) : (
        <button
          type="button"
          onClick={() => friendRequestMutation.mutate()}
          disabled={friendRequestMutation.isPending || friendRequested}
          style={friendRequested ? { ...primaryCtaStyle, opacity: 0.85, cursor: 'default' } : primaryCtaStyle}
        >
          {friendRequested ? <CheckCircle2 size={18} /> : <UserPlus size={18} />}
          {friendRequestMutation.isPending ? 'Sending…' : friendRequested ? 'Friend request sent' : 'Send friend request'}
        </button>
      );
    const showSecondaryMessage = myVenues.length > 0 && canMessage;
    return (
      <div className="flex gap-2">
        <div className="flex-1">{primary}</div>
        {showSecondaryMessage ? (
          <button type="button" onClick={() => void openMessage()} style={secondaryCtaStyle} aria-label="Message owner">
            <MessageCircle size={18} />
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="min-h-screen pb-28" style={{ backgroundColor: 'var(--sec-bg-base)' }}>
      <div style={{ position: 'relative', aspectRatio: '16/11', backgroundColor: 'var(--sec-bg-elevated)' }}>
        {images.length ? (
          <img
            src={images[galleryIndex] || images[0]}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--sec-text-muted)' }}>
            <Store size={48} strokeWidth={1.2} />
          </div>
        )}
        <button
          type="button"
          onClick={() => navigate(-1)}
          style={{
            position: 'absolute',
            top: 'max(12px, env(safe-area-inset-top))',
            left: 12,
            width: 40,
            height: 40,
            borderRadius: '50%',
            border: '1px solid var(--sec-border)',
            backgroundColor: 'rgba(0,0,0,0.55)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ChevronLeft size={20} />
        </button>
        {images.length > 1 ? (
          <>
            <button
              type="button"
              onClick={() => setGalleryIndex((i) => (i - 1 + images.length) % images.length)}
              style={galleryNavStyle('left')}
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={() => setGalleryIndex((i) => (i + 1) % images.length)}
              style={galleryNavStyle('right')}
            >
              <ChevronRight size={18} />
            </button>
          </>
        ) : null}
      </div>

      {images.length > 1 ? (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', padding: '10px 16px 0' }}>
          {images.map((url, i) => (
            <button
              key={url + i}
              type="button"
              onClick={() => setGalleryIndex(i)}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                border: 'none',
                padding: 0,
                backgroundColor: i === galleryIndex ? 'var(--sec-accent)' : 'var(--sec-border)',
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      ) : null}

      <div className="px-5 pt-5 max-w-lg mx-auto">
        {isOwn && vendor.unpublished_by_admin ? (
          <div className="mb-4 p-3 rounded-xl text-sm" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#fca5a5' }}>
            SEC moderation unpublished this listing{vendor.unpublished_reason ? `: ${vendor.unpublished_reason}` : '.'} Contact
            support to have it reviewed.
          </div>
        ) : isOwn && !vendor.is_published ? (
          <div className="mb-4 p-3 rounded-xl text-sm" style={{ background: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)', color: 'var(--sec-text-muted)' }}>
            This listing is a draft — only you can see it.
          </div>
        ) : null}

        <p style={{ margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sec-accent)' }}>
          {vendorCategoryLabel(vendor.category)}
        </p>
        <h1 style={{ margin: '8px 0 0', fontSize: 26, fontWeight: 700, color: 'var(--sec-text-primary)', letterSpacing: '-0.02em' }}>
          {vendor.name}
        </h1>

        <a href="#reviews" className="flex items-center gap-2 mt-2" style={{ textDecoration: 'none' }}>
          <StarRatingDisplay value={rating.average} size={16} />
          <span style={{ fontSize: 13, color: 'var(--sec-text-secondary)' }}>
            {rating.count > 0
              ? `${rating.average.toFixed(1)} · ${rating.count} ${rating.count === 1 ? 'review' : 'reviews'}`
              : 'No reviews yet'}
          </span>
        </a>

        {location ? (
          <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--sec-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <MapPin size={14} /> {location}
          </p>
        ) : null}
        {vendor.service_area ? (
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--sec-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Navigation size={14} /> Serves {vendor.service_area}
          </p>
        ) : null}
        {priceText ? (
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--sec-text-secondary)', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <Tag size={14} /> {priceText}
          </p>
        ) : null}

        <p style={{ margin: '18px 0 0', fontSize: 15, lineHeight: 1.55, color: 'var(--sec-text-secondary)', whiteSpace: 'pre-wrap' }}>
          {vendor.description}
        </p>

        <div className="flex flex-col gap-2 mt-4">
          {vendor.website ? (
            <a href={vendor.website} target="_blank" rel="noopener noreferrer" style={contactLinkStyle}>
              <ExternalLink size={16} /> Visit website
            </a>
          ) : null}
          {vendor.instagram ? (
            <a
              href={`https://instagram.com/${encodeURIComponent(vendor.instagram)}`}
              target="_blank"
              rel="noopener noreferrer"
              style={contactLinkStyle}
            >
              <Instagram size={16} /> @{vendor.instagram}
            </a>
          ) : null}
          {vendor.phone ? (
            <a href={`tel:${vendor.phone.replace(/\s+/g, '')}`} style={contactLinkStyle}>
              <Phone size={16} /> {vendor.phone}
            </a>
          ) : null}
          {wa ? (
            <a href={wa} target="_blank" rel="noopener noreferrer" style={contactLinkStyle}>
              <MessageCircle size={16} /> WhatsApp
            </a>
          ) : null}
          {vendor.email ? (
            <a href={`mailto:${vendor.email}`} style={contactLinkStyle}>
              <Mail size={16} /> {vendor.email}
            </a>
          ) : null}
          {!user?.id && vendor.has_private_contact ? (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--sec-text-muted)' }}>Sign in to see phone, WhatsApp and email.</p>
          ) : null}
        </div>

        {vendor.owner ? (
          <Link
            to={`${createPageUrl('UserProfile')}?id=${encodeURIComponent(ownerId)}`}
            style={{
              marginTop: 24,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              textDecoration: 'none',
              padding: 12,
              borderRadius: 'var(--radius-lg)',
              backgroundColor: 'var(--sec-bg-card)',
              border: '1px solid var(--sec-border)',
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                overflow: 'hidden',
                backgroundColor: 'var(--sec-bg-elevated)',
                flexShrink: 0,
              }}
            >
              {vendor.owner.avatar_url ? (
                <img src={vendor.owner.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--sec-text-muted)' }}>
                  <Store size={18} />
                </div>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)' }}>
                @{vendor.owner.username || 'owner'}
              </p>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--sec-text-muted)' }}>Business owner</p>
            </div>
          </Link>
        ) : null}

        {user?.id && !isOwn ? (
          <div className="mt-4">
            <ReportDialog
              targetType="vendor"
              targetId={vendor.id}
              targetLabel="vendor listing"
              triggerLabel="Report listing"
              triggerClassName="min-h-[40px] text-xs"
            />
          </div>
        ) : null}

        <div id="reviews">
          <VendorReviewsSection vendorId={vendor.id} vendorName={vendor.name} ownerId={ownerId} />
        </div>
      </div>

      {ownerId ? (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            padding: '12px 20px max(16px, env(safe-area-inset-bottom))',
            background: 'linear-gradient(to top, var(--sec-bg-base) 70%, transparent)',
          }}
        >
          <div className="max-w-lg mx-auto">{renderCta()}</div>
        </div>
      ) : null}

      {myVenues.length > 0 ? (
        <HireRequestDialog open={hireOpen} onOpenChange={setHireOpen} vendor={vendor} venues={myVenues} />
      ) : null}
    </div>
  );
}

const primaryCtaStyle = {
  width: '100%',
  height: 50,
  borderRadius: 'var(--radius-lg)',
  border: 'none',
  backgroundColor: 'var(--sec-accent)',
  color: '#000',
  fontWeight: 650,
  fontSize: 15,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  cursor: 'pointer',
};

const secondaryCtaStyle = {
  width: 50,
  height: 50,
  borderRadius: 'var(--radius-lg)',
  border: '1px solid var(--sec-border)',
  backgroundColor: 'var(--sec-bg-card)',
  color: 'var(--sec-text-primary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};

const contactLinkStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--sec-accent)',
  textDecoration: 'none',
};

function galleryNavStyle(side) {
  return {
    position: 'absolute',
    top: '50%',
    [side]: 10,
    transform: 'translateY(-50%)',
    width: 36,
    height: 36,
    borderRadius: '50%',
    border: '1px solid var(--sec-border)',
    backgroundColor: 'rgba(0,0,0,0.45)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  };
}
