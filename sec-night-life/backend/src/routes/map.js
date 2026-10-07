import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { optionalAuth } from '../middleware/auth.js';
import { parseGeoQuery, distanceKm } from '../lib/geo.js';
import { nominatimFetch, structuredFromNominatim, cityFromNominatim } from '../lib/nominatim.js';
import { normalizeCountryCode } from '../lib/timezone.js';
import { resolveFeedScope, scopeWhere, inLocalScope } from '../lib/feedScope.js';

const router = Router();

function inGeoRange(geo, lat, lng) {
  if (!geo) return true;
  if (lat == null || lng == null) return false;
  return distanceKm(geo.lat, geo.lng, lat, lng) <= geo.radiusKm;
}

function mapVenueRow(v) {
  return {
    id: v.id,
    name: v.name,
    city: v.city,
    suburb: v.suburb,
    country_code: v.countryCode ?? null,
    venue_type: v.venueType,
    address: v.address,
    latitude: v.latitude,
    longitude: v.longitude,
    is_verified: v.isVerified,
    rating: v.rating,
    cover_image_url: v.coverImageUrl,
    logo_url: v.logoUrl,
  };
}

function mapEventRow(e) {
  return {
    id: e.id,
    title: e.title,
    date: e.date,
    ends_at: e.endsAt,
    city: e.city,
    status: e.status,
    venue_id: e.venueId,
    cover_image_url: e.coverImageUrl,
    is_featured: e.isFeatured,
  };
}

function mapTableRow(t) {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    event_id: t.eventId,
    venue_id: t.venueId,
    host_user_id: t.hostUserId,
    members: t.members,
  };
}

/**
 * Reverse-geocode lat/lng for labels when browser Maps auth fails.
 * Uses OpenStreetMap Nominatim (server-side; no Google key required).
 */
router.get('/reverse-geocode', optionalAuth, async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng are required numbers' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'lat/lng out of range' });
    }

    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('format', 'json');
    url.searchParams.set('zoom', '18');
    url.searchParams.set('addressdetails', '1');

    const upstream = await nominatimFetch(url);
    if (!upstream.ok) {
      return res.status(502).json({ error: 'Reverse geocode upstream failed' });
    }
    const data = await upstream.json();
    const addr = data?.address && typeof data.address === 'object' ? data.address : {};
    const street = [addr.house_number, addr.road || addr.pedestrian || addr.path]
      .filter(Boolean)
      .join(' ')
      .trim();
    const suburb =
      addr.suburb ||
      addr.neighbourhood ||
      addr.township ||
      addr.village ||
      addr.suburb ||
      addr.city_district ||
      '';
    const city = addr.city || addr.town || addr.municipality || addr.county || '';
    const province = addr.state || addr.province || addr.region || '';
    const label = typeof data?.display_name === 'string' ? data.display_name.trim() : '';
    const formattedAddress =
      [street || null, suburb || null, city || null, province || null].filter(Boolean).join(', ') ||
      label;
    if (!formattedAddress && !label) {
      return res.status(404).json({ error: 'No address found' });
    }
    return res.json({
      label: formattedAddress || label,
      formattedAddress: formattedAddress || label,
      street: street || formattedAddress || label,
      suburb: suburb || '',
      city: city || '',
      province: province || '',
      country: addr.country_code ? String(addr.country_code).toUpperCase() : null,
      country_name: addr.country || null,
      latitude: lat,
      longitude: lng,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'Reverse geocode timed out' });
    }
    next(err);
  }
});

/**
 * Place search for address autocomplete when Google Maps is unavailable.
 * Uses OpenStreetMap Nominatim; pass `country` (ISO alpha-2) to restrict results.
 */
router.get('/search-places', optionalAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ results: [] });
    }
    if (q.length > 120) {
      return res.status(400).json({ error: 'Query too long' });
    }

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '6');
    const country = normalizeCountryCode(req.query.country);
    if (country) url.searchParams.set('countrycodes', country.toLowerCase());

    const upstream = await nominatimFetch(url);
    if (!upstream.ok) {
      return res.status(502).json({ error: 'Place search upstream failed' });
    }
    const rows = await upstream.json();
    const results = (Array.isArray(rows) ? rows : [])
      .map((item) => structuredFromNominatim(item))
      .filter((r) => r.formattedAddress);

    return res.json({ results });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'Place search timed out' });
    }
    next(err);
  }
});

/**
 * City autocomplete fallback (Nominatim) when Google Places is unavailable.
 * Returns settlements only, optionally restricted to one country.
 */
router.get('/search-cities', optionalAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    if (q.length > 120) return res.status(400).json({ error: 'Query too long' });

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '10');
    url.searchParams.set('featureType', 'settlement');
    url.searchParams.set('accept-language', 'en');
    const country = normalizeCountryCode(req.query.country);
    if (country) url.searchParams.set('countrycodes', country.toLowerCase());

    const upstream = await nominatimFetch(url);
    if (!upstream.ok) return res.status(502).json({ error: 'City search upstream failed' });
    const rows = await upstream.json();
    const seen = new Set();
    const results = [];
    for (const item of Array.isArray(rows) ? rows : []) {
      const c = cityFromNominatim(item);
      if (!c.city) continue;
      const key = `${c.city.toLowerCase()}|${(c.region || '').toLowerCase()}|${c.country_code || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(c);
      if (results.length >= 8) break;
    }
    return res.json({ results });
  } catch (err) {
    if (err?.name === 'AbortError') return res.status(504).json({ error: 'City search timed out' });
    next(err);
  }
});

/** Geo-filtered map pins for venues, events, and open tables. */
router.get('/pins', optionalAuth, async (req, res, next) => {
  try {
    const geo = parseGeoQuery(req.query);
    const feed = await resolveFeedScope(req);
    const scopeAll = feed ? feed.scope === 'worldwide' : req.query.scope === 'all' || !geo;
    const venueScope = feed ? scopeWhere(feed) : {};
    const eventScope = feed ? scopeWhere(feed, { geoRelation: 'venue' }) : {};
    const now = new Date();
    const cap = 200;

    const [venueRows, eventRows, tableRows] = await Promise.all([
      prisma.venue.findMany({
        where: {
          deletedAt: null,
          latitude: { not: null },
          longitude: { not: null },
          ...venueScope,
        },
        orderBy: { rating: 'desc' },
        take: cap,
      }),
      prisma.event.findMany({
        where: { deletedAt: null, status: 'published', endsAt: { gte: now }, ...eventScope },
        orderBy: { date: 'asc' },
        take: cap,
        include: {
          venue: { select: { id: true, latitude: true, longitude: true, city: true, name: true, countryCode: true } },
        },
      }),
      prisma.table.findMany({
        where: {
          deletedAt: null,
          status: { notIn: ['closed', 'cancelled'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: {
          venue: { select: { latitude: true, longitude: true, city: true, countryCode: true } },
        },
      }),
    ]);

    let venues = venueRows;
    let events = eventRows;
    let tables = tableRows;

    if (feed && feed.scope !== 'worldwide') {
      if (feed.countryCode) {
        tables = tables.filter((t) => !t.venue?.countryCode || t.venue.countryCode === feed.countryCode);
      }
      if (feed.scope === 'local') {
        venues = venues.filter((v) => inLocalScope(feed, v));
        events = events.filter((e) =>
          inLocalScope(feed, { latitude: e.venue?.latitude, longitude: e.venue?.longitude, city: e.city }),
        );
        tables = tables.filter((t) => inLocalScope(feed, t.venue || {}));
      }
    } else if (!feed && !scopeAll && geo) {
      venues = venues.filter((v) => inGeoRange(geo, v.latitude, v.longitude));
      events = events.filter((e) => {
        const lat = e.venue?.latitude;
        const lng = e.venue?.longitude;
        return inGeoRange(geo, lat, lng);
      });
      tables = tables.filter((t) => {
        const lat = t.venue?.latitude;
        const lng = t.venue?.longitude;
        return inGeoRange(geo, lat, lng);
      });
    }

    res.json({
      scope: scopeAll ? 'all' : 'nearby',
      feed_scope: feed?.scope ?? null,
      venues: venues.map(mapVenueRow),
      events: events.map(mapEventRow),
      tables: tables.map(mapTableRow),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
