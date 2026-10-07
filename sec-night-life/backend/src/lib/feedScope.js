import { prisma } from './prisma.js';
import { parseGeoQuery, distanceKm } from './geo.js';
import { normalizeCountryCode } from './timezone.js';

/** What a viewer sees: near them, their whole country, or everywhere. */
export const FEED_SCOPES = ['local', 'national', 'worldwide'];
export const DEFAULT_FEED_SCOPE = 'local';

export function normalizeFeedScope(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'nationwide') return 'national';
  if (raw === 'all' || raw === 'global') return 'worldwide';
  return FEED_SCOPES.includes(raw) ? raw : null;
}

/**
 * Parse `feed_scope`, `country_code`, `city` and geo params. Missing country/city fall back to the
 * signed-in viewer's profile. Returns null when the client did not ask for a feed scope (legacy callers).
 */
export async function resolveFeedScope(req) {
  const q = req.query || {};
  const scope = normalizeFeedScope(q.feed_scope);
  if (!scope) return null;
  let countryCode = normalizeCountryCode(q.country_code || q.country);
  let city = typeof q.city === 'string' && q.city.trim() ? q.city.trim().slice(0, 120) : null;
  const geo = scope === 'local' ? parseGeoQuery(q) : null;
  // With geo, the profile city is still loaded: it scopes rows that have no coordinates (e.g. vendors).
  if ((!countryCode || (scope === 'local' && !city)) && req.userId) {
    const profile = await prisma.userProfile.findUnique({
      where: { userId: req.userId },
      select: { countryCode: true, city: true },
    });
    if (!countryCode) countryCode = normalizeCountryCode(profile?.countryCode);
    if (scope === 'local' && !city && profile?.city) city = String(profile.city).trim() || null;
  }
  return { scope, countryCode, city, geo };
}

/** Lat/lng bounding box around a geo point (pre-filter; refine with {@link inLocalScope}). */
export function geoBox(geo) {
  const dLat = geo.radiusKm / 111;
  const dLng = geo.radiusKm / (111 * Math.max(0.1, Math.cos((geo.lat * Math.PI) / 180)));
  return {
    latitude: { gte: geo.lat - dLat, lte: geo.lat + dLat },
    longitude: { gte: geo.lng - dLng, lte: geo.lng + dLng },
  };
}

/**
 * Prisma `where` fragment for scope.
 * - national: country column
 * - local + geo: lat/lng box on the row (or on `geoRelation`, e.g. the event's venue)
 * - local without geo: country + city (case-insensitive)
 */
export function scopeWhere(
  feed,
  { countryField = 'countryCode', cityField = 'city', geoRelation = null, supportsGeo = true } = {},
) {
  if (!feed || feed.scope === 'worldwide') return {};
  if (feed.scope === 'national') {
    return feed.countryCode ? { [countryField]: feed.countryCode } : {};
  }
  if (feed.geo && supportsGeo) {
    const box = geoBox(feed.geo);
    return geoRelation ? { [geoRelation]: box } : box;
  }
  const where = {};
  if (feed.countryCode) where[countryField] = feed.countryCode;
  if (feed.city) where[cityField] = { equals: feed.city, mode: 'insensitive' };
  return where;
}

/**
 * Hosted tables carry their own location (own-place listings) or inherit it from the event venue.
 * Returned as `{ AND: [...] }`-safe fragment so it can be combined with existing `OR` filters.
 */
export function hostedTableScopeWhere(feed) {
  const own = scopeWhere(feed);
  if (!Object.keys(own).length) return null;
  return { OR: [own, { event: { venue: scopeWhere(feed) } }] };
}

/** Event rows scoped through their venue (country, city, coordinates). */
export function eventScopeWhere(feed) {
  const venue = scopeWhere(feed);
  return Object.keys(venue).length ? { venue } : {};
}

/** In-memory geo radius check for local scope; rows without coordinates fall back to city match. */
export function inLocalScope(feed, { latitude, longitude, city } = {}) {
  if (!feed || feed.scope !== 'local') return true;
  if (feed.geo) {
    if (latitude != null && longitude != null) {
      return distanceKm(feed.geo.lat, feed.geo.lng, latitude, longitude) <= feed.geo.radiusKm;
    }
    return Boolean(feed.city && city && String(city).toLowerCase() === feed.city.toLowerCase());
  }
  if (!feed.city) return true;
  return Boolean(city && String(city).toLowerCase() === feed.city.toLowerCase());
}

/** Cache-key fragment so scope / country / location changes never reuse another viewer's page. */
export function feedScopeCacheKey(feed) {
  if (!feed) return 'legacy';
  const g = feed.geo ? `${feed.geo.lat.toFixed(2)},${feed.geo.lng.toFixed(2)},${feed.geo.radiusKm}` : '-';
  return `${feed.scope}:${feed.countryCode || '-'}:${(feed.city || '-').toLowerCase()}:${g}`;
}

/** Next wider scope when the current one is empty (local → national → worldwide). */
export function widerScope(feed) {
  if (!feed) return null;
  if (feed.scope === 'local') return { ...feed, scope: 'national', geo: null, city: null };
  if (feed.scope === 'national') return { ...feed, scope: 'worldwide', geo: null, city: null };
  return null;
}
