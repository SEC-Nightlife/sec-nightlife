import React, { useState } from 'react';
import { dataService } from '@/services/dataService';
import { useQuery } from '@tanstack/react-query';
import { 
  Search, 
  Filter, 
  MapPin, 
  BadgeCheck,
  Music,
  Wine,
  Palmtree,
  Building,
  Sparkles,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import VenueCard from '@/components/home/VenueCard';
import FeedScopeToggle from '@/components/location/FeedScopeToggle';
import { useFeedScopeParams } from '@/hooks/useFeedScope';
import { useContentCities, mergeCityLabels } from '@/hooks/useContentCities';

const VENUE_TYPES = [
  { value: 'all', label: 'All', icon: Sparkles },
  { value: 'nightclub', label: 'Nightclubs', icon: Music },
  { value: 'lounge', label: 'Lounges', icon: Wine },
  { value: 'rooftop', label: 'Rooftops', icon: Building },
  { value: 'beach_club', label: 'Beach Clubs', icon: Palmtree },
];


export default function Explore() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState('all');
  const [selectedCity, setSelectedCity] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const scope = useFeedScopeParams();
  const { cities: contentCities } = useContentCities({
    source: 'venues',
    countryCode: scope.feedScope === 'worldwide' ? null : scope.countryCode,
  });

  const { data: venues = [], isLoading } = useQuery({
    queryKey: ['venues', selectedType, selectedCity, scope.key],
    queryFn: async () => {
      const filter = { ...scope.params };
      if (selectedType !== 'all') filter.venue_type = selectedType;
      if (selectedCity) {
        filter.city = selectedCity;
        filter.feed_scope = 'worldwide';
      }
      return dataService.Venue.filter(filter, '-rating', 50);
    },
  });
  const cityOptions = mergeCityLabels(contentCities.slice(0, 24), selectedCity ? [selectedCity] : []);

  const filteredVenues = venues.filter((venue) => {
    const q = searchQuery.toLowerCase();
    return (
      (venue.name ?? '').toLowerCase().includes(q) ||
      (venue.city ?? '').toLowerCase().includes(q)
    );
  });

  const verifiedVenues = filteredVenues.filter(v => v.is_verified);
  const otherVenues = filteredVenues.filter(v => !v.is_verified);

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--sec-bg-base)' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 40, paddingTop: 'env(safe-area-inset-top)', backgroundColor: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(16px)', borderBottom: '1px solid var(--sec-border)' }}>
        <div style={{ padding: 'var(--space-4) var(--space-6)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
            <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--sec-text-primary)' }}>Explore</h1>
            <FeedScopeToggle compact />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Search size={18} strokeWidth={1.5} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--sec-text-muted)' }} />
              <input className="sec-input" placeholder="Search venues, cities..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ paddingLeft: 44, height: 48 }} />
            </div>
            <button onClick={() => setShowFilters(!showFilters)} className="sec-nav-icon" style={{ width: 48, height: 48, borderColor: showFilters ? 'var(--sec-accent)' : undefined, color: showFilters ? 'var(--sec-accent)' : 'var(--sec-text-muted)' }}>
              <Filter size={20} strokeWidth={1.5} />
            </button>
          </div>
        </div>
        <div style={{ padding: '0 var(--space-6) var(--space-4)' }}>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto' }} className="scrollbar-hide">
            {VENUE_TYPES.map((type) => {
              const Icon = type.icon;
              const isSelected = selectedType === type.value;
              return (
                <button key={type.value} onClick={() => setSelectedType(type.value)} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderRadius: 999, whiteSpace: 'nowrap',
                  backgroundColor: isSelected ? 'var(--sec-accent)' : 'var(--sec-bg-card)',
                  color: isSelected ? 'var(--sec-bg-base)' : 'var(--sec-text-secondary)',
                  border: `1px solid ${isSelected ? 'var(--sec-accent)' : 'var(--sec-border)'}`
                }}>
                  <Icon size={16} strokeWidth={1.5} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{type.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <AnimatePresence>
          {showFilters && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ overflow: 'hidden', borderTop: '1px solid var(--sec-border)' }}>
              <div style={{ padding: 'var(--space-4) var(--space-6)' }}>
                <p className="sec-label" style={{ marginBottom: 12 }}>Filter by City</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <button onClick={() => setSelectedCity('')} style={{ padding: '8px 14px', borderRadius: 999, fontSize: 13, backgroundColor: !selectedCity ? 'var(--sec-accent)' : 'var(--sec-bg-card)', color: !selectedCity ? 'var(--sec-bg-base)' : 'var(--sec-text-secondary)', border: `1px solid ${!selectedCity ? 'var(--sec-accent)' : 'var(--sec-border)'}` }}>
                    All Cities
                  </button>
                  {cityOptions.map((city) => (
                    <button key={city} onClick={() => setSelectedCity(city)} style={{ padding: '8px 14px', borderRadius: 999, fontSize: 13, backgroundColor: selectedCity === city ? 'var(--sec-accent)' : 'var(--sec-bg-card)', color: selectedCity === city ? 'var(--sec-bg-base)' : 'var(--sec-text-secondary)', border: `1px solid ${selectedCity === city ? 'var(--sec-accent)' : 'var(--sec-border)'}` }}>
                      {city}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <div className="px-4 lg:px-8 py-6 space-y-8">
        {(selectedCity || selectedType !== 'all') && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {selectedCity && (
              <span className="sec-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <MapPin className="w-3 h-3" />
                {selectedCity}
                <button onClick={() => setSelectedCity('')}>
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}
          </div>
        )}

        {verifiedVenues.length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <BadgeCheck size={20} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />
              <h2 className="text-lg font-bold">Verified Venues</h2>
              <span className="text-sm text-gray-500">({verifiedVenues.length})</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {verifiedVenues.map((venue, index) => (
                <motion.div
                  key={venue.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                >
                  <VenueCard venue={venue} />
                </motion.div>
              ))}
            </div>
          </section>
        )}

        {otherVenues.length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <Building size={20} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)' }} />
              <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--sec-text-primary)' }}>All Venues</h2>
              <span style={{ fontSize: 14, color: 'var(--sec-text-muted)' }}>({otherVenues.length})</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {otherVenues.map((venue, index) => (
                <motion.div
                  key={venue.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                >
                  <VenueCard venue={venue} />
                </motion.div>
              ))}
            </div>
          </section>
        )}

        {/* Empty State */}
        {filteredVenues.length === 0 && !isLoading && (
          <div className="text-center py-20">
            <div className="w-20 h-20 rounded-full bg-[#141416] flex items-center justify-center mx-auto mb-4">
              <Search className="w-8 h-8 text-gray-600" />
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, color: 'var(--sec-text-primary)' }}>No venues found</h3>
            <p style={{ color: 'var(--sec-text-muted)' }}>Try adjusting your search or filters</p>
          </div>
        )}

        {isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="animate-pulse">
                <div className="h-36 rounded-2xl bg-[#141416] mb-3" />
                <div className="h-4 w-24 rounded bg-[#141416] mb-2" />
                <div className="h-3 w-16 rounded bg-[#141416]" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}