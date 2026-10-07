import { Router } from 'express';
import { resolveFeedScope, feedScopeCacheKey } from '../lib/feedScope.js';
import { parseGeoQuery } from '../lib/geo.js';
import { prisma } from '../lib/prisma.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { buildTableOfferings, buildCommunityHostedEvents } from '../lib/tableOfferings.js';
import { buildHomeBootstrap } from '../lib/homeBootstrap.js';
import { buildHomeFeedPage } from '../lib/homeFeedPage.js';
import { cacheGetJson, cacheSetJson } from '../lib/redis.js';

const router = Router();

router.get('/feed', optionalAuth, async (req, res, next) => {
  try {
    const payload = await buildHomeFeedPage(req);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/** Grouped venue-event and per-host table cards for Home carousel. */
router.get('/table-offerings', optionalAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 60);
    const sessionSeed =
      req.headers['x-session-id'] || req.query.sessionId || req.query.session_id || 'anon-session';
    const dayKey = new Date().toISOString().slice(0, 10);
    const feed = await resolveFeedScope(req);
    const cacheKey = `home:table-offerings:v4:${req.userId || 'anon'}:${feedScopeCacheKey(feed)}:${limit}:${String(sessionSeed).slice(0, 24)}:${dayKey}`;
    if (cacheKey) {
      const cached = await cacheGetJson(cacheKey);
      if (cached) return res.json(cached);
    }
    const items = await buildTableOfferings({
      userId: req.userId || null,
      limit,
      sessionSeed: `${sessionSeed}|${dayKey}|tables`,
      feed,
    });
    const payload = { items };
    await cacheSetJson(cacheKey, payload, req.userId ? 25 : 30);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/** Paid “Your own venue” listings marked as Events — Home / Events browse. */
router.get('/community-hosted-events', optionalAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 30);
    const feed = await resolveFeedScope(req);
    const cacheKey = `home:community-events:v3:${req.userId || 'anon'}:${feedScopeCacheKey(feed)}:${limit}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);
    const items = await buildCommunityHostedEvents({ limit, userId: req.userId || null, feed });
    const payload = { items };
    await cacheSetJson(cacheKey, payload, 20);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.get('/followed-promoters', authenticateToken, async (req, res, next) => {
  try {
    const follows = await prisma.promoterFollow.findMany({
      where: { userId: req.userId },
      select: { promoterId: true },
    });
    const promoterIds = follows.map((f) => f.promoterId);
    if (!promoterIds.length) return res.json({ items: [] });

    const now = new Date();
    const assignments = await prisma.eventPromoterAssignment.findMany({
      where: {
        promoterUserId: { in: promoterIds },
        status: 'ACTIVE',
        event: {
          deletedAt: null,
          status: 'published',
          OR: [{ endsAt: { gt: now } }, { endsAt: null, date: { gte: now } }],
        },
      },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            date: true,
            endsAt: true,
            coverImageUrl: true,
            city: true,
            eventFormat: true,
            venue: { select: { name: true } },
          },
        },
        promoter: {
          select: {
            id: true,
            username: true,
            userProfile: { select: { username: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
      take: 20,
    });

    res.json({
      items: assignments.map((a) => ({
        kind: 'followed_promoter_event',
        promoterId: a.promoterUserId,
        promoterUsername: a.promoter.userProfile?.username || a.promoter.username,
        promoterAvatarUrl: a.promoter.userProfile?.avatarUrl || null,
        event: {
          id: a.event.id,
          title: a.event.title,
          date: a.event.date,
          endsAt: a.event.endsAt,
          coverImageUrl: a.event.coverImageUrl,
          city: a.event.city,
          eventFormat: a.event.eventFormat,
          venueName: a.event.venue?.name,
        },
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Active platform announcements for every user's home feed */
router.get('/announcements', optionalAuth, async (req, res, next) => {
  try {
    const rows = await prisma.platformAnnouncement.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        title: true,
        message: true,
        ctaUrl: true,
        ctaLabel: true,
        createdAt: true,
      },
    });
    res.json({
      announcements: rows.map((r) => ({
        id: r.id,
        title: r.title,
        message: r.message,
        ctaUrl: r.ctaUrl,
        ctaLabel: r.ctaLabel,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Single round-trip payload for authenticated Home (announcements, tables, promos, followed promoters). */
router.get('/bootstrap', optionalAuth, async (req, res, next) => {
  try {
    const scopeAll = req.query.scope === 'all' || req.query.all === '1' || req.query.all === 'true';
    const overrideCity = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const tableLimit = Math.min(Math.max(parseInt(req.query.tableLimit, 10) || 24, 1), 60);
    const promoLimit = Math.min(Math.max(parseInt(req.query.promoLimit, 10) || 12, 1), 20);
    const userPart = req.userId || 'anon';
    const feed = await resolveFeedScope(req);
    const geo = parseGeoQuery(req.query);
    const legacyGeoPart = geo ? `${geo.lat.toFixed(2)},${geo.lng.toFixed(2)},${geo.radiusKm}` : '-';
    const scopePart = feed
      ? feedScopeCacheKey(feed)
      : `${scopeAll ? 'all' : overrideCity || 'default'}:${legacyGeoPart}`;
    const cacheKey = `home:bootstrap:v4:${userPart}:${scopePart}:${tableLimit}:${promoLimit}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    const payload = await buildHomeBootstrap(req);
    await cacheSetJson(cacheKey, payload, req.userId ? 30 : 45);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

export default router;
