import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { dataService } from '@/services/dataService';
import { useQuery } from '@tanstack/react-query';
import { 
  Search,
  MapPin,
  X,
  ChevronRight,
  Star,
  BadgeCheck,
  Calendar,
  Navigation,
  Users,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { format, parseISO } from 'date-fns';
import { useGoogleMaps } from '@/lib/GoogleMapsProvider';
import * as authService from '@/services/authService';
import { apiGet } from '@/api/client';
import { usePreferences } from '@/context/PreferencesContext';
import { getDirectionsActions } from '@/lib/openDirections';
import { toast } from 'sonner';
import { getCurrentLocation, locationErrorMessage } from '@/lib/getCurrentLocation';
import { countryMapCenter, countryName } from '@/lib/countries';

// Last-resort centre when we know nothing about the viewer's location
const DEFAULT_CENTER = { lat: -26.2041, lng: 28.0473 };

const AREA_MODE_BY_SCOPE = { local: 'nearby', national: 'country', worldwide: 'all' };

function parseCoord(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toLatLng(entity) {
  const lat = parseCoord(entity?.latitude);
  const lng = parseCoord(entity?.longitude);
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function distanceKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2) * Math.sin(dLat / 2);
  const s2 = Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(s1 + s2), Math.sqrt(1 - s1 - s2));
  return R * c;
}

export default function Map() {
  const { location: locPrefs, geoCoords, requestGeoCoords, feedScope, viewerCountryCode } = usePreferences();
  const nearbyRadiusKm = Number(locPrefs?.radiusKm) > 0 ? Number(locPrefs.radiusKm) : 25;
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedItem, setSelectedItem] = useState(null);
  const [viewMode, setViewMode] = useState('venues'); // 'venues' | 'events' | 'tables'
  const [areaMode, setAreaMode] = useState(() => AREA_MODE_BY_SCOPE[feedScope] || 'nearby'); // 'nearby' | 'country' | 'all'
  const [userLocation, setUserLocation] = useState(null);
  const [map, setMap] = useState(null);
  const [mapError, setMapError] = useState(null);
  const mapRef = React.useRef(null);
  const { status: mapsStatus, error: mapsError } = useGoogleMaps();

  const mapPinsScope = areaMode === 'all'
    ? 'all'
    : areaMode === 'country'
      ? `country:${viewerCountryCode || ''}`
      : `${userLocation?.lat ?? geoCoords?.lat ?? ''},${userLocation?.lng ?? geoCoords?.lng ?? ''},${nearbyRadiusKm}`;

  const { data: mapPins } = useQuery({
    queryKey: ['map-pins', mapPinsScope],
    queryFn: () => {
      const params = new URLSearchParams();
      if (areaMode === 'all') {
        params.set('feed_scope', 'worldwide');
      } else if (areaMode === 'country') {
        params.set('feed_scope', 'national');
        if (viewerCountryCode) params.set('country_code', viewerCountryCode);
      } else {
        const lat = userLocation?.lat ?? geoCoords?.lat;
        const lng = userLocation?.lng ?? geoCoords?.lng;
        if (lat != null && lng != null) {
          params.set('lat', String(lat));
          params.set('lng', String(lng));
          params.set('radius_km', String(nearbyRadiusKm));
        } else {
          params.set('scope', 'all');
        }
      }
      return apiGet(`/api/map/pins?${params.toString()}`);
    },
    staleTime: 120_000,
  });

  const venues = mapPins?.venues || [];
  const events = mapPins?.events || [];
  const tables = mapPins?.tables || [];

  const { data: myVenues = [] } = useQuery({
    queryKey: ['map-my-venues'],
    queryFn: () => dataService.Venue.mine(),
  });

  const { data: userProfile } = useQuery({
    queryKey: ['map-user-profile'],
    queryFn: async () => {
      try {
        const user = await authService.getCurrentUser();
        try {
          const rows = await apiGet('/api/users/profile');
          const p = Array.isArray(rows) ? rows[0] : rows;
          if (p) return p;
        } catch {
          // fallback below
        }
        const profiles = await dataService.User.filter({ created_by: user.email });
        return profiles?.[0] ?? null;
      } catch {
        return null;
      }
    },
  });

  const allVenues = useMemo(() => {
    const map = new globalThis.Map();
    [...venues, ...myVenues].forEach((v) => {
      if (v?.id) map.set(v.id, v);
    });
    return [...map.values()];
  }, [venues, myVenues]);

  const myVenueIds = useMemo(
    () => myVenues.map((v) => v?.id).filter(Boolean),
    [myVenues]
  );
  const myVenueIdsKey = useMemo(
    () => [...myVenueIds].sort().join('|'),
    [myVenueIds]
  );
  const { data: myVenueEvents = [] } = useQuery({
    queryKey: ['map-my-venue-events', myVenueIdsKey],
    queryFn: async () => {
      if (myVenueIds.length === 0) return [];
      const rows = await Promise.all(myVenueIds.map((id) => dataService.Event.filter({ venue_id: id }, 'date', 200)));
      return rows.flat().filter(Boolean);
    },
    enabled: myVenueIds.length > 0,
  });

  const allEvents = useMemo(() => {
    const map = new globalThis.Map();
    [...events, ...myVenueEvents].forEach((e) => {
      if (e?.id) map.set(e.id, e);
    });
    return [...map.values()];
  }, [events, myVenueEvents]);

  const venuesMap = useMemo(
    () => allVenues.reduce((acc, v) => {
      acc[v.id] = v;
      return acc;
    }, {}),
    [allVenues]
  );

  const eventsMap = useMemo(
    () => allEvents.reduce((acc, e) => {
      acc[e.id] = e;
      return acc;
    }, {}),
    [allEvents]
  );

  const normalizedVenues = useMemo(
    () => allVenues.map((venue) => ({ ...venue, _mapPos: toLatLng(venue) })),
    [allVenues]
  );

  const normalizedEvents = useMemo(
    () => allEvents
      .filter((event) => event?.status !== 'cancelled')
      .map((event) => {
        const venue = venuesMap[event.venue_id];
        const eventPos = toLatLng(event);
        const venuePos = toLatLng(venue);
        return { ...event, _mapPos: eventPos || venuePos || null };
      }),
    [allEvents, venuesMap]
  );

  const normalizedTables = useMemo(
    () => tables
      .filter((table) => table?.status !== 'closed' && table?.status !== 'cancelled')
      .map((table) => {
        const event = eventsMap[table.event_id];
        const venue = venuesMap[table.venue_id];
        const tablePos = toLatLng(table);
        const eventPos = toLatLng(event);
        const venuePos = toLatLng(venue);
        return { ...table, _mapPos: tablePos || eventPos || venuePos || null };
      }),
    [tables, eventsMap, venuesMap]
  );

  const searchTerm = searchQuery.trim().toLowerCase();
  const profileCity = (userProfile?.city || '').trim().toLowerCase();

  const isInUserArea = (mapPos, cityCandidates = []) => {
    if (areaMode !== 'nearby') return true;
    if (userLocation?.lat != null && userLocation?.lng != null && mapPos) {
      return distanceKm(userLocation, mapPos) <= nearbyRadiusKm;
    }
    if (!profileCity) return true;
    return cityCandidates.some((v) => String(v || '').trim().toLowerCase() === profileCity);
  };

  const filteredVenues = useMemo(
    () => normalizedVenues.filter((venue) => {
      const matchesSearch = !searchTerm || [
        venue.name,
        venue.city,
        venue.suburb,
        venue.venue_type,
        venue.address,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(searchTerm);

      const inArea = isInUserArea(venue._mapPos, [venue.city, venue.suburb]);
      return matchesSearch && inArea;
    }),
    [normalizedVenues, searchTerm, userLocation, profileCity, areaMode]
  );

  const filteredEvents = useMemo(
    () => normalizedEvents.filter((event) => {
      const venue = venuesMap[event.venue_id];
      const matchesSearch = !searchTerm || [
        event.title,
        event.city,
        event.address,
        venue?.name,
        venue?.city,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(searchTerm);

      const inArea = isInUserArea(event._mapPos, [event.city, venue?.city, venue?.suburb]);
      return matchesSearch && inArea;
    }),
    [normalizedEvents, venuesMap, searchTerm, userLocation, profileCity, areaMode]
  );

  const filteredTables = useMemo(
    () => normalizedTables.filter((table) => {
      const event = eventsMap[table.event_id];
      const venue = venuesMap[table.venue_id];
      const matchesSearch = !searchTerm || [
        table.name,
        event?.title,
        venue?.name,
        event?.city,
        venue?.city,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(searchTerm);

      const inArea = isInUserArea(table._mapPos, [event?.city, venue?.city, venue?.suburb]);
      return matchesSearch && inArea;
    }),
    [normalizedTables, eventsMap, venuesMap, searchTerm, userLocation, profileCity, areaMode]
  );

  const modeItems = useMemo(() => {
    if (viewMode === 'events') return filteredEvents;
    if (viewMode === 'tables') return filteredTables;
    return filteredVenues;
  }, [viewMode, filteredVenues, filteredEvents, filteredTables]);

  const modeMarkerItems = useMemo(
    () => modeItems.filter((item) => !!item?._mapPos),
    [modeItems]
  );

  const modes = [
    { value: 'venues', label: 'Venues' },
    { value: 'events', label: 'Events' },
    { value: 'tables', label: 'Tables' },
  ];

  // Initialize Google Map
  useEffect(() => {
    if (mapsStatus === 'error') {
      setMapError('Map unavailable. Please check your deployment Google Maps configuration.');
      return;
    }

    if (mapsStatus !== 'ready') return;

    const initMap = async () => {
      if (!mapRef.current) {
        console.warn('Map container ref not available');
        return;
      }
      if (map) return;
      setMapError(null);

      if (!window.google?.maps?.Map) {
        setMapError('Unable to load map. Please check that VITE_GOOGLE_MAPS_API_KEY is set in your deployment.');
        return;
      }

      try {
        const countryCenter = countryMapCenter(viewerCountryCode);
        const initialCenter = geoCoords?.lat != null && geoCoords?.lng != null
          ? { lat: geoCoords.lat, lng: geoCoords.lng }
          : countryCenter
            ? { lat: countryCenter.lat, lng: countryCenter.lng }
            : DEFAULT_CENTER;
        const googleMap = new window.google.maps.Map(mapRef.current, {
          zoom: geoCoords?.lat != null ? 12 : countryCenter?.zoom ?? 12,
          center: initialCenter,
          mapTypeControl: false,
          fullscreenControl: false,
          streetViewControl: false,
          zoomControl: true,
          gestureHandling: 'greedy',
          styles: [
            {
              elementType: 'geometry',
              stylers: [{ color: '#141416' }],
            },
            {
              elementType: 'labels.text.stroke',
              stylers: [{ color: '#141416' }],
            },
            {
              elementType: 'labels.text.fill',
              stylers: [{ color: '#ffffff' }],
            },
            {
              featureType: 'water',
              elementType: 'geometry',
              stylers: [{ color: '#0a0a0b' }],
            },
          ],
        });

        setMap(googleMap);

        // Prefer live GPS when available (no silent failure)
        void (async () => {
          try {
            const coords = await getCurrentLocation({ maximumAge: 60000 });
            setUserLocation({ lat: coords.lat, lng: coords.lng });
          } catch {
            /* keep map usable without user location */
          }
        })();
      } catch (err) {
        console.error('Failed to initialize map:', err);
        setMapError('Unable to load map. Please try again.');
      }
    };

    initMap();
  }, [mapsStatus, map]);

  // Without GPS, centre on the viewer's profile city once the map is up
  const profileCityLabel = (userProfile?.city || '').trim();
  useEffect(() => {
    if (!map || userLocation || geoCoords?.lat != null || !profileCityLabel) return;
    if (!window.google?.maps?.Geocoder) return;
    const geocoder = new window.google.maps.Geocoder();
    const request = { address: profileCityLabel };
    if (viewerCountryCode) request.componentRestrictions = { country: viewerCountryCode };
    geocoder.geocode(request, (results, status) => {
      const loc = status === 'OK' ? results?.[0]?.geometry?.location : null;
      if (!loc) return;
      map.setCenter(loc);
      map.setZoom(11);
    });
  }, [map, userLocation, geoCoords?.lat, profileCityLabel, viewerCountryCode]);

  // Update markers when filtered items change
  useEffect(() => {
    if (!map) return;

    // Clear existing markers
    map.markers?.forEach(marker => marker.setMap(null));
    map.markers = [];

    // Add new markers
    modeMarkerItems.forEach((item) => {
      const marker = new window.google.maps.Marker({
        position: { lat: item._mapPos.lat, lng: item._mapPos.lng },
        map: map,
        title: item.name || item.title || 'Location',
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: '#B8B8B8',
          fillOpacity: 1,
          strokeColor: '#FAFAFA',
          strokeWeight: 2,
        },
      });

      marker.addListener('click', () => setSelectedItem(item));
      map.markers.push(marker);
    });
  }, [map, modeMarkerItems]);

  const mapLoaded = !!map;
  const hasNoItemsWithCoords = modeMarkerItems.length === 0;

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--sec-bg-base)', display: 'flex', flexDirection: 'column' }}>
      {/* Map section - fixed height */}
      <div style={{ position: 'relative', height: 280, flexShrink: 0, backgroundColor: 'var(--sec-bg-elevated)' }}>
        <div
          ref={mapRef}
          style={{
            position: 'absolute',
            inset: 0,
            opacity: mapLoaded && !mapError ? 1 : 0,
          }}
        />
        {mapError && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'var(--sec-bg-elevated)',
              padding: 24,
              textAlign: 'center',
            }}
          >
            <MapPin size={36} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)', marginBottom: 12 }} />
            <p style={{ color: 'var(--sec-text-primary)', fontWeight: 500, marginBottom: 6 }}>Map unavailable</p>
            <p style={{ color: 'var(--sec-text-muted)', fontSize: 13 }}>Browse venues in the list below.</p>
          </div>
        )}

        {/* Search bar - compact overlay */}
        <div style={{ position: 'absolute', top: 12, left: 16, right: 56, zIndex: 10 }}>
          <div style={{ position: 'relative' }}>
            <Search size={18} strokeWidth={1.5} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--sec-text-muted)' }} />
            <input
              placeholder={`Search ${viewMode}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                paddingLeft: 42,
                height: 44,
                borderRadius: 12,
                border: '1px solid var(--sec-border)',
                backgroundColor: 'var(--sec-bg-card)',
                color: 'var(--sec-text-primary)',
                fontSize: 15,
              }}
            />
          </div>
        </div>

        {/* Current Location - top right */}
        <button
          type="button"
          onClick={async () => {
            try {
              const coords = await getCurrentLocation({ maximumAge: 60000 });
              const userLoc = { lat: coords.lat, lng: coords.lng };
              setUserLocation(userLoc);
              if (map) {
                map.panTo(userLoc);
                map.setZoom(15);
              }
            } catch (err) {
              toast.error(locationErrorMessage(err));
            }
          }}
          className="sec-btn sec-btn-ghost"
          style={{
            position: 'absolute',
            top: 12,
            right: 16,
            zIndex: 10,
            width: 44,
            height: 44,
            borderRadius: 12,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'var(--sec-bg-card)',
            border: '1px solid var(--sec-border)',
          }}
        >
          <Navigation size={20} strokeWidth={1.5} />
        </button>
      </div>

      {/* Selected Venue Card - show in list area when venue selected (cleaner) */}
      {selectedItem && (
        <div style={{ padding: '0 16px 16px' }}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="sec-card"
            style={{ borderRadius: 16, padding: 16, position: 'relative' }}
          >
              <button
                onClick={() => setSelectedItem(null)}
                className="sec-nav-icon"
                style={{ position: 'absolute', top: 12, right: 12, width: 32, height: 32, borderRadius: '50%', padding: 0 }}
              >
                <X size={16} strokeWidth={1.5} />
              </button>

              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ width: 64, height: 64, borderRadius: 12, backgroundColor: 'var(--sec-bg-elevated)', flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {selectedItem.cover_image_url ? (
                    <img src={selectedItem.cover_image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <MapPin size={24} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />
                  )}
                </div>

                <div style={{ flex: 1, minWidth: 0, paddingRight: 40 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h3 style={{ fontWeight: 600, color: 'var(--sec-text-primary)' }}>
                      {selectedItem.name || selectedItem.title || 'Untitled'}
                    </h3>
                    {selectedItem.is_verified && <BadgeCheck size={16} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />}
                  </div>
                  <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                    {selectedItem.address || selectedItem.city || 'Location available on map'}
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontSize: 13 }}>
                    {selectedItem.rating > 0 && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--sec-accent)' }}>
                        <Star size={14} strokeWidth={1.5} fill="currentColor" />
                        {selectedItem.rating.toFixed(1)}
                      </span>
                    )}
                    {selectedItem.venue_type && (
                      <span style={{ color: 'var(--sec-text-muted)', textTransform: 'capitalize' }}>{selectedItem.venue_type.replace('_', ' ')}</span>
                    )}
                  </div>
                </div>
              </div>

              {(() => {
                const dirs = getDirectionsActions({
                  lat: selectedItem._mapPos?.lat ?? DEFAULT_CENTER.lat,
                  lng: selectedItem._mapPos?.lng ?? DEFAULT_CENTER.lng,
                });
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <Link
                        to={
                          viewMode === 'venues'
                            ? createPageUrl(`VenueProfile?id=${selectedItem.id}`)
                            : viewMode === 'events'
                              ? createPageUrl(`EventDetails?id=${selectedItem.id}`)
                              : createPageUrl(`TableDetails?id=${selectedItem.id}`)
                        }
                        className="sec-btn sec-btn-primary"
                        style={{ flex: 1, padding: '10px 16px', textAlign: 'center', textDecoration: 'none' }}
                      >
                        View Details
                      </Link>
                      <a
                        href={dirs.primary.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="sec-btn sec-btn-secondary"
                        style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
                      >
                        <Navigation size={16} strokeWidth={1.5} />
                        {dirs.primary.label.replace('Open in ', '')}
                      </a>
                    </div>
                    <a
                      href={dirs.secondary.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 12, color: 'var(--sec-accent)', textAlign: 'center' }}
                    >
                      {dirs.secondary.label}
                    </a>
                  </div>
                );
              })()}
          </motion.div>
        </div>
      )}

      {/* Main content - venues/events list */}
      <div style={{ flex: 1, padding: '20px 16px 100px', overflowY: 'auto' }}>
        {/* Mode tabs - moved here for cleaner layout */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {modes.map((mode) => (
            <button
              key={mode.value}
              onClick={() => setViewMode(mode.value)}
              style={{
                padding: '10px 18px',
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 500,
                backgroundColor: viewMode === mode.value ? 'var(--sec-accent)' : 'var(--sec-bg-card)',
                color: viewMode === mode.value ? 'var(--sec-bg-base)' : 'var(--sec-text-secondary)',
                border: `1px solid ${viewMode === mode.value ? 'var(--sec-accent)' : 'var(--sec-border)'}`,
                transition: 'all 0.15s ease',
              }}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <button
            onClick={() => setAreaMode('nearby')}
            style={{
              padding: '8px 14px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              backgroundColor: areaMode === 'nearby' ? 'var(--sec-accent)' : 'var(--sec-bg-card)',
              color: areaMode === 'nearby' ? 'var(--sec-bg-base)' : 'var(--sec-text-secondary)',
              border: `1px solid ${areaMode === 'nearby' ? 'var(--sec-accent)' : 'var(--sec-border)'}`,
            }}
          >
            Nearby
          </button>
          {viewerCountryCode ? (
            <button
              onClick={() => setAreaMode('country')}
              style={{
                padding: '8px 14px',
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                backgroundColor: areaMode === 'country' ? 'var(--sec-accent)' : 'var(--sec-bg-card)',
                color: areaMode === 'country' ? 'var(--sec-bg-base)' : 'var(--sec-text-secondary)',
                border: `1px solid ${areaMode === 'country' ? 'var(--sec-accent)' : 'var(--sec-border)'}`,
              }}
            >
              {countryName(viewerCountryCode)}
            </button>
          ) : null}
          <button
            onClick={() => setAreaMode('all')}
            style={{
              padding: '8px 14px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              backgroundColor: areaMode === 'all' ? 'var(--sec-accent)' : 'var(--sec-bg-card)',
              color: areaMode === 'all' ? 'var(--sec-bg-base)' : 'var(--sec-text-secondary)',
              border: `1px solid ${areaMode === 'all' ? 'var(--sec-accent)' : 'var(--sec-border)'}`,
            }}
          >
            All Areas
          </button>
        </div>

        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, color: 'var(--sec-text-primary)' }}>
          {viewMode === 'venues' ? 'Nightlife Venues' : viewMode === 'events' ? 'Upcoming Events' : 'Tables'}
        </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {viewMode === 'venues' && filteredVenues.map((venue) => (
              <Link
                key={venue.id}
                to={createPageUrl(`VenueProfile?id=${venue.id}`)}
                className="sec-card"
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16, borderRadius: 12, textDecoration: 'none' }}
              >
                <div style={{ width: 48, height: 48, borderRadius: 12, backgroundColor: 'var(--sec-bg-elevated)', flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {venue.cover_image_url ? (
                    <img src={venue.cover_image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <MapPin size={20} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h4 style={{ fontWeight: 500, color: 'var(--sec-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.name}</h4>
                  <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.city} · {venue.venue_type?.replace('_', ' ')}</p>
                </div>
                <ChevronRight size={20} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)' }} />
              </Link>
            ))}
            {viewMode === 'events' && filteredEvents.slice(0, 50).map((ev) => (
              <Link
                key={ev.id}
                to={createPageUrl(`EventDetails?id=${ev.id}`)}
                className="sec-card"
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16, borderRadius: 12, textDecoration: 'none' }}
              >
                <div style={{ width: 48, height: 48, borderRadius: 12, backgroundColor: 'var(--sec-bg-elevated)', flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {ev.cover_image_url ? (
                    <img src={ev.cover_image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <Calendar size={20} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h4 style={{ fontWeight: 500, color: 'var(--sec-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</h4>
                  <p style={{ fontSize: 13, color: 'var(--sec-text-muted)' }}>{ev.city} · {ev.date && format(parseISO(ev.date), 'EEE, MMM d')}</p>
                </div>
                <ChevronRight size={20} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)' }} />
              </Link>
            ))}
            {viewMode === 'tables' && filteredTables.slice(0, 50).map((table) => {
              const event = eventsMap[table.event_id];
              const venue = venuesMap[table.venue_id];
              return (
                <Link
                  key={table.id}
                  to={createPageUrl(`TableDetails?id=${table.id}`)}
                  className="sec-card"
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16, borderRadius: 12, textDecoration: 'none' }}
                >
                  <div style={{ width: 48, height: 48, borderRadius: 12, backgroundColor: 'var(--sec-bg-elevated)', flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Users size={20} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h4 style={{ fontWeight: 500, color: 'var(--sec-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{table.name || 'Open Table'}</h4>
                    <p style={{ fontSize: 13, color: 'var(--sec-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {venue?.name || 'Venue'}{event?.title ? ` · ${event.title}` : ''}
                    </p>
                  </div>
                  <ChevronRight size={20} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)' }} />
                </Link>
              );
            })}
            {viewMode === 'venues' && filteredVenues.length === 0 && (
              <div style={{ padding: 32, textAlign: 'center', backgroundColor: 'var(--sec-bg-elevated)', borderRadius: 16, border: '1px solid var(--sec-border)' }}>
                <MapPin size={32} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)', marginBottom: 12 }} />
                <p style={{ color: 'var(--sec-text-primary)', fontWeight: 500, marginBottom: 4 }}>
                  {areaMode !== 'nearby'
                    ? (hasNoItemsWithCoords ? 'No venues with map locations yet' : 'No venues match your search')
                    : (hasNoItemsWithCoords ? 'No venues in your area yet' : 'No venues match your search')}
                </p>
                <p style={{ color: 'var(--sec-text-muted)', fontSize: 13 }}>
                  {hasNoItemsWithCoords
                    ? (areaMode !== 'nearby'
                      ? 'Venues will appear here once they have location coordinates.'
                      : 'Switch to All Areas to browse beyond your nearby area.')
                    : 'Try a different search term.'}
                </p>
              </div>
            )}
            {viewMode === 'events' && filteredEvents.length === 0 && (
              <div style={{ padding: 32, textAlign: 'center', backgroundColor: 'var(--sec-bg-elevated)', borderRadius: 16, border: '1px solid var(--sec-border)' }}>
                <Calendar size={32} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)', marginBottom: 12 }} />
                <p style={{ color: 'var(--sec-text-primary)', fontWeight: 500 }}>
                  {areaMode !== 'nearby' ? 'No events found' : 'No events in your area'}
                </p>
                <p style={{ color: 'var(--sec-text-muted)', fontSize: 13, marginTop: 6 }}>
                  {searchTerm ? 'Try a different search term.' : 'Create or publish an event to see it here.'}
                </p>
              </div>
            )}
            {viewMode === 'tables' && filteredTables.length === 0 && (
              <div style={{ padding: 32, textAlign: 'center', backgroundColor: 'var(--sec-bg-elevated)', borderRadius: 16, border: '1px solid var(--sec-border)' }}>
                <p style={{ color: 'var(--sec-text-muted)' }}>
                  {areaMode !== 'nearby' ? 'No open tables found right now.' : 'No open tables in your area right now.'}
                </p>
              </div>
            )}
            {modeItems.length > 0 && modeMarkerItems.length === 0 && (
              <div style={{ padding: 14, borderRadius: 12, backgroundColor: 'var(--sec-bg-elevated)', border: '1px solid var(--sec-border)' }}>
                <p style={{ color: 'var(--sec-text-muted)', fontSize: 12 }}>
                  Results found, but none have map coordinates yet, so map markers are hidden.
                </p>
              </div>
            )}
          </div>
        </div>

    </div>
  );
}