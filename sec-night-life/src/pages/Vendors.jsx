import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search, MapPin, Store, Star, Briefcase } from 'lucide-react';
import { motion } from 'framer-motion';
import { apiGet } from '@/api/client';
import { createPageUrl } from '@/utils';
import { useAuth } from '@/lib/AuthContext';
import PageBackHeader from '@/components/layout/PageBackHeader';
import { VENDOR_CATEGORIES, vendorCategoryLabel, vendorPriceText } from '@/lib/vendorCategories';
import { formatZar } from '@/lib/money';
import VendorInquiriesList from '@/components/vendors/VendorInquiriesList';

const PAGE_SIZE = 24;
const MIN_RATING_OPTIONS = [
  { value: 0, label: 'Any rating' },
  { value: 4, label: '4★ & up' },
  { value: 4.5, label: '4.5★ & up' },
];

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function Vendors() {
  const { user } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedCity, setSelectedCity] = useState('');
  const [sort, setSort] = useState('newest');
  const [minRating, setMinRating] = useState(0);
  const [showRequests, setShowRequests] = useState(false);
  const search = useDebounced(searchQuery.trim(), 300);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['vendors', { search, selectedCategory, selectedCity, sort, minRating }],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(pageParam), sort });
      if (selectedCategory && selectedCategory !== 'all') params.set('category', selectedCategory);
      if (selectedCity) params.set('city', selectedCity);
      if (search) params.set('search', search);
      if (minRating > 0) params.set('min_rating', String(minRating));
      return apiGet(`/api/vendors?${params.toString()}`);
    },
    getNextPageParam: (last) => (last?.hasMore ? (last.page || 1) + 1 : undefined),
  });

  const { data: sentData } = useQuery({
    queryKey: ['vendor-inquiries-sent'],
    queryFn: () => apiGet('/api/vendors/inquiries/sent'),
    enabled: Boolean(user?.id),
  });
  const sentCount = sentData?.inquiries?.length || 0;

  const pages = data?.pages || [];
  const vendors = pages.flatMap((p) => p?.vendors || []);
  const cities = pages[0]?.cities || [];
  const total = pages[0]?.total ?? vendors.length;
  const filtersActive = Boolean(search || selectedCity || minRating || selectedCategory !== 'all');

  return (
    <div className="min-h-screen pb-10" style={{ backgroundColor: 'var(--sec-bg-base)' }}>
      <PageBackHeader title="Vendors" pageName="Vendors" />

      <div className="px-4 lg:px-8 pt-4 max-w-5xl mx-auto">
        <p style={{ color: 'var(--sec-text-muted)', fontSize: 14, margin: '0 0 16px', lineHeight: 1.45 }}>
          Find food stalls, equipment rentals, DJs, and more — read reviews from venues, then send a hire request.
        </p>

        {sentCount > 0 ? (
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setShowRequests((v) => !v)}
              className="w-full flex items-center justify-between rounded-xl px-4 min-h-[48px]"
              style={{ background: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)', color: 'var(--sec-text-primary)' }}
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Briefcase size={16} /> My hire requests ({sentCount})
              </span>
              <span className="text-xs" style={{ color: 'var(--sec-text-muted)' }}>
                {showRequests ? 'Hide' : 'Show'}
              </span>
            </button>
            {showRequests ? (
              <div className="mt-3">
                <VendorInquiriesList mode="sent" />
              </div>
            ) : null}
          </div>
        ) : null}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 14px',
            height: 46,
            borderRadius: 'var(--radius-lg)',
            backgroundColor: 'var(--sec-bg-elevated)',
            border: '1px solid var(--sec-border)',
            marginBottom: 14,
          }}
        >
          <Search size={18} style={{ color: 'var(--sec-text-muted)', flexShrink: 0 }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search services, areas…"
            style={{
              flex: 1,
              height: '100%',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--sec-text-primary)',
              fontSize: 16,
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 10 }}>
          <FilterChip active={selectedCategory === 'all'} onClick={() => setSelectedCategory('all')} label="All" />
          {VENDOR_CATEGORIES.map((c) => (
            <FilterChip
              key={c.value}
              active={selectedCategory === c.value}
              onClick={() => setSelectedCategory(c.value)}
              label={c.label}
            />
          ))}
        </div>

        {cities.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 10 }}>
            <FilterChip active={!selectedCity} onClick={() => setSelectedCity('')} label="Any city" />
            {cities.map((city) => (
              <FilterChip
                key={city}
                active={selectedCity.toLowerCase() === city.toLowerCase()}
                onClick={() => setSelectedCity(city)}
                label={city}
              />
            ))}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 12, marginBottom: 8, alignItems: 'center' }}>
          <FilterChip active={sort === 'newest'} onClick={() => setSort('newest')} label="Newest" />
          <FilterChip active={sort === 'top_rated'} onClick={() => setSort('top_rated')} label="Top rated" />
          <span style={{ width: 1, height: 20, background: 'var(--sec-border)', flexShrink: 0 }} />
          {MIN_RATING_OPTIONS.map((o) => (
            <FilterChip key={o.value} active={minRating === o.value} onClick={() => setMinRating(o.value)} label={o.label} />
          ))}
        </div>

        {!isLoading && vendors.length > 0 ? (
          <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--sec-text-muted)' }}>
            {total} {total === 1 ? 'vendor' : 'vendors'}
          </p>
        ) : null}

        {isLoading ? (
          <div className="flex justify-center py-16">
            <div className="sec-spinner" />
          </div>
        ) : vendors.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--sec-text-muted)' }}>
            <Store size={36} strokeWidth={1.25} style={{ margin: '0 auto 12px', opacity: 0.7 }} />
            <p style={{ margin: 0, fontSize: 15 }}>{filtersActive ? 'No vendors match these filters' : 'No vendor listings yet'}</p>
            <p style={{ margin: '8px 0 0', fontSize: 13 }}>
              {filtersActive ? 'Try another category, city or rating.' : 'List your services in Settings → My vendor business.'}
            </p>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
              {vendors.map((vendor, i) => (
                <motion.div
                  key={vendor.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min((i % PAGE_SIZE) * 0.04, 0.3) }}
                >
                  <VendorCard vendor={vendor} />
                </motion.div>
              ))}
            </div>
            {hasNextPage ? (
              <button
                type="button"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="w-full mt-5 min-h-[44px] rounded-xl text-sm font-semibold"
                style={{ background: 'var(--sec-bg-card)', border: '1px solid var(--sec-border)', color: 'var(--sec-text-primary)' }}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function VendorCard({ vendor }) {
  const rating = vendor.rating || { average: 0, count: 0 };
  const priceText = vendorPriceText(vendor, formatZar);
  return (
    <Link
      to={`${createPageUrl('VendorDetail')}?id=${encodeURIComponent(vendor.id)}`}
      style={{ textDecoration: 'none', display: 'block' }}
    >
      <div
        style={{
          borderRadius: 'var(--radius-xl)',
          overflow: 'hidden',
          backgroundColor: 'var(--sec-bg-card)',
          border: '1px solid var(--sec-border)',
        }}
      >
        <div style={{ aspectRatio: '4/3', backgroundColor: 'var(--sec-bg-elevated)', position: 'relative' }}>
          {vendor.cover_url ? (
            <img src={vendor.cover_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--sec-text-muted)',
              }}
            >
              <Store size={28} strokeWidth={1.25} />
            </div>
          )}
        </div>
        <div style={{ padding: '10px 12px 12px' }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 650, color: 'var(--sec-text-primary)', lineHeight: 1.25 }}>
            {vendor.name}
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--sec-accent)', fontWeight: 560 }}>
            {vendorCategoryLabel(vendor.category)}
          </p>
          <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--sec-text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Star size={11} className={rating.count ? 'fill-amber-400 text-amber-400' : ''} />
            {rating.count ? `${rating.average.toFixed(1)} (${rating.count})` : 'New'}
          </p>
          {priceText ? (
            <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--sec-text-secondary)' }}>{priceText}</p>
          ) : null}
          {vendor.city ? (
            <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--sec-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <MapPin size={11} /> {vendor.city}
            </p>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

function FilterChip({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flexShrink: 0,
        padding: '7px 12px',
        borderRadius: 999,
        border: `1px solid ${active ? 'var(--sec-accent-border)' : 'var(--sec-border)'}`,
        backgroundColor: active ? 'var(--sec-accent-muted)' : 'var(--sec-bg-card)',
        color: active ? 'var(--sec-text-primary)' : 'var(--sec-text-secondary)',
        fontSize: 12,
        fontWeight: 560,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
