import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { optionalAuth } from '../middleware/auth.js';
import { normalizeCountryCode } from '../lib/timezone.js';

const router = Router();

const SOURCES = ['events', 'venues', 'vendors', 'jobs', 'promotions', 'tables'];
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

function addCity(counts, city, n = 1) {
  const name = String(city || '').trim();
  if (!name) return;
  const key = name.toLowerCase();
  const cur = counts.get(key);
  if (cur) cur.count += n;
  else counts.set(key, { city: name, count: n });
}

async function citiesForSource(source, countryCode, now) {
  switch (source) {
    case 'events': {
      const rows = await prisma.event.groupBy({
        by: ['city'],
        where: {
          deletedAt: null,
          status: 'published',
          OR: [{ endsAt: null }, { endsAt: { gte: now } }],
          ...(countryCode ? { countryCode } : {}),
        },
        _count: { _all: true },
      });
      return rows.map((r) => [r.city, r._count._all]);
    }
    case 'venues': {
      const rows = await prisma.venue.groupBy({
        by: ['city'],
        where: { deletedAt: null, ...(countryCode ? { countryCode } : {}) },
        _count: { _all: true },
      });
      return rows.map((r) => [r.city, r._count._all]);
    }
    case 'vendors': {
      const rows = await prisma.vendorBusiness.groupBy({
        by: ['city'],
        where: {
          isPublished: true,
          unpublishedByAdminAt: null,
          city: { not: null },
          ...(countryCode ? { country: countryCode } : {}),
        },
        _count: { _all: true },
      });
      return rows.map((r) => [r.city, r._count._all]);
    }
    case 'jobs': {
      const rows = await prisma.jobPosting.findMany({
        where: {
          status: 'OPEN',
          deletedAt: null,
          venue: { deletedAt: null, ...(countryCode ? { countryCode } : {}) },
        },
        select: { venue: { select: { city: true } } },
        take: 2000,
      });
      return rows.map((r) => [r.venue?.city, 1]);
    }
    case 'promotions': {
      const rows = await prisma.promotion.groupBy({
        by: ['targetCity'],
        where: {
          status: 'ACTIVE',
          deletedAt: null,
          targetCity: { not: null },
          ...(countryCode ? { targetCountryCode: countryCode } : {}),
        },
        _count: { _all: true },
      });
      return rows.map((r) => [r.targetCity, r._count._all]);
    }
    case 'tables': {
      const rows = await prisma.hostedTable.groupBy({
        by: ['city'],
        where: {
          status: 'ACTIVE',
          city: { not: null },
          ...(countryCode ? { countryCode } : {}),
        },
        _count: { _all: true },
      });
      return rows.map((r) => [r.city, r._count._all]);
    }
    default:
      return [];
  }
}

/**
 * Cities that actually have content, for filter chips.
 * Query: country_code (ISO alpha-2), source = events|venues|vendors|jobs|promotions|tables|all.
 */
router.get('/cities', optionalAuth, async (req, res, next) => {
  try {
    const countryCode = normalizeCountryCode(req.query.country_code || req.query.country);
    const rawSource = String(req.query.source || 'all').toLowerCase();
    const sources = rawSource === 'all' ? SOURCES : SOURCES.filter((s) => s === rawSource);
    if (!sources.length) return res.status(400).json({ error: 'Unknown source' });

    const cacheKey = `${countryCode || '*'}:${sources.join(',')}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return res.json(hit.body);

    const now = new Date();
    const counts = new Map();
    const results = await Promise.all(
      sources.map((s) =>
        citiesForSource(s, countryCode, now).catch(() => []),
      ),
    );
    for (const pairs of results) {
      for (const [city, n] of pairs) addCity(counts, city, n);
    }
    const cities = [...counts.values()]
      .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city))
      .slice(0, 60);
    const body = { country_code: countryCode, cities };
    cache.set(cacheKey, { body, expires: Date.now() + CACHE_MS });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/** Countries that have at least one venue (for worldwide browse / filters). */
router.get('/countries', optionalAuth, async (_req, res, next) => {
  try {
    const hit = cache.get('countries');
    if (hit && hit.expires > Date.now()) return res.json(hit.body);
    const rows = await prisma.venue.groupBy({
      by: ['countryCode'],
      where: { deletedAt: null, countryCode: { not: null } },
      _count: { _all: true },
    });
    const body = {
      countries: rows
        .map((r) => ({ country_code: r.countryCode, venue_count: r._count._all }))
        .sort((a, b) => b.venue_count - a.venue_count),
    };
    cache.set('countries', { body, expires: Date.now() + CACHE_MS });
    res.json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
