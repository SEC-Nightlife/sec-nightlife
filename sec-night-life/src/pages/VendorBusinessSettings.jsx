import React, { useEffect, useState } from 'react';
import { DEFAULT_COUNTRY_CODE } from '@/lib/countries';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/api/client';
import PageBackHeader from '@/components/layout/PageBackHeader';
import VendorListingForm, { isVendorListingValid } from '@/components/vendors/VendorListingForm';
import { createPageUrl } from '@/utils';
import { toast } from 'sonner';
import { useAuth } from '@/lib/AuthContext';
import { vendorCategoryLabel } from '@/lib/vendorCategories';
import { Plus, Star } from 'lucide-react';
import VendorInquiriesList from '@/components/vendors/VendorInquiriesList';

const EMPTY_DRAFT = {
  name: '',
  category: '',
  description: '',
  website: '',
  phone: '',
  whatsapp: '',
  email: '',
  instagram: '',
  price_from_zar: '',
  price_unit: 'per_event',
  quote_on_request: false,
  service_area: '',
  city: '',
  country: '',
  images: [],
  is_published: true,
};

function draftFromVendor(vendor) {
  return {
    name: vendor.name || '',
    category: vendor.category || '',
    description: vendor.description || '',
    website: vendor.website || '',
    phone: vendor.phone || '',
    whatsapp: vendor.whatsapp || '',
    email: vendor.email || '',
    instagram: vendor.instagram || '',
    price_from_zar: vendor.price_from_zar ?? '',
    price_unit: vendor.price_unit || 'per_event',
    quote_on_request: Boolean(vendor.quote_on_request),
    service_area: vendor.service_area || '',
    city: vendor.city || '',
    country: vendor.country || '',
    images: (vendor.images || []).map((i) => i.url),
    is_published: vendor.is_published !== false,
  };
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 min-h-[40px] rounded-lg text-sm font-semibold"
      style={{
        background: active ? 'var(--sec-accent-muted)' : 'transparent',
        color: active ? 'var(--sec-text-primary)' : 'var(--sec-text-muted)',
        border: `1px solid ${active ? 'var(--sec-accent-border)' : 'transparent'}`,
      }}
    >
      {children}
    </button>
  );
}

export default function VendorBusinessSettings() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { userProfile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'requests' ? 'requests' : 'listings';
  const setTab = (next) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'requests') params.set('tab', 'requests');
    else params.delete('tab');
    setSearchParams(params, { replace: true });
  };
  const [mode, setMode] = useState('list'); // list | create | edit
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const { data, isLoading } = useQuery({
    queryKey: ['vendor-mine'],
    queryFn: () => apiGet('/api/vendors/mine'),
  });

  const vendors = Array.isArray(data?.vendors)
    ? data.vendors
    : data?.vendor
      ? [data.vendor]
      : [];

  const editing = editingId ? vendors.find((v) => v.id === editingId) : null;

  useEffect(() => {
    if (mode === 'edit' && editing) {
      setDraft(draftFromVendor(editing));
    }
  }, [mode, editing]);

  const startCreate = () => {
    setEditingId(null);
    setDraft({
      ...EMPTY_DRAFT,
      city: userProfile?.city || '',
      country: userProfile?.country_code || DEFAULT_COUNTRY_CODE,
    });
    setMode('create');
  };

  const startEdit = (vendor) => {
    setEditingId(vendor.id);
    setDraft(draftFromVendor(vendor));
    setMode('edit');
  };

  const backToList = () => {
    setMode('list');
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!isVendorListingValid(draft)) {
        throw new Error('Name, category, and description are required');
      }
      const price = Number(draft.price_from_zar);
      const city = draft.city?.trim() || null;
      const payload = {
        name: draft.name.trim(),
        category: draft.category,
        description: draft.description.trim(),
        website: draft.website?.trim() || null,
        phone: draft.phone?.trim() || null,
        whatsapp: draft.whatsapp?.trim() || null,
        email: draft.email?.trim() || null,
        instagram: draft.instagram?.trim() || null,
        quote_on_request: Boolean(draft.quote_on_request),
        price_from_zar: !draft.quote_on_request && Number.isFinite(price) && price > 0 ? price : null,
        price_unit: !draft.quote_on_request && Number.isFinite(price) && price > 0 ? draft.price_unit || 'per_event' : null,
        service_area: draft.service_area?.trim() || null,
        city,
        country: draft.country || null,
        is_published: draft.is_published !== false,
        images: (draft.images || []).map((url, i) => ({ url, sort_order: i })),
      };
      // Coordinates follow the city: reuse the profile pin only when the listing is in the same city.
      const originalCity = mode === 'edit' ? editing?.city || null : null;
      if (mode !== 'edit' || (city || '').toLowerCase() !== (originalCity || '').toLowerCase()) {
        const sameAsProfile = city && userProfile?.city && city.toLowerCase() === userProfile.city.toLowerCase();
        payload.latitude = sameAsProfile ? userProfile?.latitude ?? null : null;
        payload.longitude = sameAsProfile ? userProfile?.longitude ?? null : null;
      }
      if (mode === 'edit' && editingId) {
        return apiPatch(`/api/vendors/${editingId}`, payload);
      }
      return apiPost('/api/vendors', payload);
    },
    onSuccess: () => {
      toast.success(mode === 'edit' ? 'Listing updated' : 'Listing published');
      queryClient.invalidateQueries({ queryKey: ['vendor-mine'] });
      queryClient.invalidateQueries({ queryKey: ['vendors'] });
      backToList();
    },
    onError: (err) => toast.error(err?.data?.error || err?.message || 'Could not save listing'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => apiDelete(`/api/vendors/${id}`),
    onSuccess: () => {
      toast.success('Listing removed');
      queryClient.invalidateQueries({ queryKey: ['vendor-mine'] });
      queryClient.invalidateQueries({ queryKey: ['vendors'] });
      backToList();
    },
    onError: (err) => toast.error(err?.message || 'Could not remove listing'),
  });

  const headerTitle =
    mode === 'create' ? 'Add vendor business' : mode === 'edit' ? 'Edit vendor business' : 'My vendor businesses';

  return (
    <div className="min-h-screen pb-10" style={{ backgroundColor: 'var(--sec-bg-base)' }}>
      <PageBackHeader
        title={headerTitle}
        pageName="VendorBusinessSettings"
        onBack={mode !== 'list' ? backToList : undefined}
      />

      <div className="px-5 max-w-md mx-auto pt-4 space-y-5">
        {mode === 'list' ? (
          <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)' }}>
            <TabButton active={tab === 'listings'} onClick={() => setTab('listings')}>
              Listings
            </TabButton>
            <TabButton active={tab === 'requests'} onClick={() => setTab('requests')}>
              Hire requests
            </TabButton>
          </div>
        ) : null}

        {mode === 'list' && tab === 'requests' ? (
          <>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--sec-text-muted)', lineHeight: 1.5 }}>
              Venues send hire requests from your listing. Accept to start planning, then mark the job completed —
              completed hires show a “Verified hire” badge on that venue’s review.
            </p>
            <VendorInquiriesList mode="received" emptyText="No hire requests yet. Venues can request you from your listing page." />
          </>
        ) : mode === 'list' ? (
          <>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--sec-text-muted)', lineHeight: 1.5 }}>
              List one or more services venues can hire — chip & dip, AV gear, DJ sets, decor, and more.
              Venues can send you hire requests and message you directly from your listing.
            </p>

            {isLoading ? (
              <div className="flex justify-center py-12">
                <div className="sec-spinner" />
              </div>
            ) : (
              <>
                {vendors.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 14, color: 'var(--sec-text-secondary)' }}>
                    You have not listed a vendor business yet.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {vendors.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => startEdit(v)}
                        className="w-full text-left rounded-xl p-4 transition-colors"
                        style={{
                          background: 'var(--sec-bg-card)',
                          border: '1px solid var(--sec-border)',
                        }}
                      >
                        <div className="flex gap-3 items-start">
                          {v.cover_url ? (
                            <img
                              src={v.cover_url}
                              alt=""
                              className="w-14 h-14 rounded-lg object-cover shrink-0"
                            />
                          ) : (
                            <div
                              className="w-14 h-14 rounded-lg shrink-0"
                              style={{ background: 'var(--sec-bg-elevated)' }}
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div
                              className="font-semibold truncate"
                              style={{ color: 'var(--sec-text-primary)', fontSize: 15 }}
                            >
                              {v.name}
                            </div>
                            <div className="text-xs mt-0.5" style={{ color: 'var(--sec-text-muted)' }}>
                              {vendorCategoryLabel(v.category)}
                              {v.unpublished_by_admin
                                ? ' · Unpublished by SEC'
                                : v.is_published === false
                                  ? ' · Draft'
                                  : ' · Published'}
                            </div>
                            <div className="text-xs mt-1 flex items-center gap-1" style={{ color: 'var(--sec-text-secondary)' }}>
                              <Star className="w-3 h-3" />
                              {v.rating?.count
                                ? `${v.rating.average.toFixed(1)} · ${v.rating.count} ${v.rating.count === 1 ? 'review' : 'reviews'}`
                                : 'No reviews yet'}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {vendors.length >= (data?.max_listings || 10) ? (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--sec-text-muted)' }}>
                    You have reached the maximum of {data?.max_listings || 10} listings.
                  </p>
                ) : null}
                <button
                  type="button"
                  disabled={vendors.length >= (data?.max_listings || 10)}
                  onClick={startCreate}
                  className="w-full flex items-center justify-center gap-2 min-h-[48px] rounded-xl font-semibold"
                  style={{
                    background: 'var(--sec-accent)',
                    color: '#000',
                    border: 'none',
                    fontSize: 15,
                  }}
                >
                  <Plus className="w-4 h-4" />
                  Add business
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--sec-text-muted)', lineHeight: 1.5 }}>
              {mode === 'create'
                ? 'Create another listing. Each business appears separately on Vendors.'
                : 'Update this listing. Changes go live when published.'}
            </p>

            {mode === 'edit' && editing?.unpublished_by_admin ? (
              <div className="p-3 rounded-xl text-sm" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#fca5a5' }}>
                SEC moderation unpublished this listing{editing.unpublished_reason ? `: ${editing.unpublished_reason}` : '.'} You can
                still edit it, but contact support to have it published again.
              </div>
            ) : null}

            <VendorListingForm value={draft} onChange={setDraft} cityHint={userProfile?.city} showExtendedFields />

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 14,
                color: 'var(--sec-text-secondary)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={draft.is_published !== false}
                onChange={(e) => setDraft((p) => ({ ...p, is_published: e.target.checked }))}
              />
              Publish listing (visible on Vendors)
            </label>

            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !isVendorListingValid(draft)}
              style={{
                width: '100%',
                height: 48,
                borderRadius: 'var(--radius-lg)',
                border: 'none',
                backgroundColor: 'var(--sec-accent)',
                color: '#000',
                fontWeight: 650,
                fontSize: 15,
                cursor: saveMutation.isPending ? 'wait' : 'pointer',
                opacity: !isVendorListingValid(draft) ? 0.5 : 1,
              }}
            >
              {saveMutation.isPending ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Publish listing'}
            </button>

            {mode === 'edit' && editingId ? (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() =>
                    navigate(`${createPageUrl('VendorDetail')}?id=${encodeURIComponent(editingId)}`)
                  }
                  style={{
                    width: '100%',
                    height: 44,
                    borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--sec-border)',
                    backgroundColor: 'var(--sec-bg-card)',
                    color: 'var(--sec-text-primary)',
                    fontWeight: 560,
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  Preview listing
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm('Remove this vendor listing?')) {
                      deleteMutation.mutate(editingId);
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  style={{
                    width: '100%',
                    height: 44,
                    borderRadius: 'var(--radius-lg)',
                    border: '1px solid rgba(239,68,68,0.35)',
                    backgroundColor: 'transparent',
                    color: '#ef4444',
                    fontWeight: 560,
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  {deleteMutation.isPending ? 'Removing…' : 'Remove listing'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
