import { prisma } from './prisma.js';
import { buildTableOfferings, buildCommunityHostedEvents } from './tableOfferings.js';
import { parseGeoQuery } from './geo.js';
import { fetchFeaturedEventDetails } from './featuredEvents.js';
import { buildHomeFeedPage } from './homeFeedPage.js';
import { resolveFeedScope, eventScopeWhere } from './feedScope.js';

async function fetchAnnouncements() {
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
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    message: r.message,
    ctaUrl: r.ctaUrl,
    ctaLabel: r.ctaLabel,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function fetchFollowedPromoters(userId) {
  const follows = await prisma.promoterFollow.findMany({
    where: { userId },
    select: { promoterId: true },
  });
  const promoterIds = follows.map((f) => f.promoterId);
  if (!promoterIds.length) return [];

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

  return assignments.map((a) => ({
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
  }));
}

async function fetchPromotionsPage({ userId, city, scopeAll, limit = 12, feed = null }) {
  const now = new Date();
  const promotions = await prisma.promotion.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      startAt: { lte: now },
      endAt: { gt: now },
      ...(feed ? eventScopeWhere(feed) : {}),
      ...(!feed && city && !scopeAll
        ? {
            OR: [
              { targetCity: null },
              { targetCity: { equals: city, mode: 'insensitive' } },
              { venue: { city: { equals: city, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    include: {
      venue: { select: { id: true, name: true, city: true, venueType: true } },
      event: { select: { id: true, title: true, date: true } },
    },
    orderBy: [{ boosted: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(limit, 20),
  });

  const followedVenueIds = userId
    ? new Set(
        (
          await prisma.venueFollow.findMany({
            where: { userId },
            select: { venueId: true },
          })
        ).map((x) => x.venueId),
      )
    : new Set();

  const sorted = [...promotions].sort((a, b) => {
    const aFollow = followedVenueIds.has(a.venueId) ? 1 : 0;
    const bFollow = followedVenueIds.has(b.venueId) ? 1 : 0;
    if (aFollow !== bFollow) return bFollow - aFollow;
    if (a.boosted !== b.boosted) return Number(b.boosted) - Number(a.boosted);
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return sorted.slice(0, limit).map((p) => ({
    id: p.id,
    promotionType: p.type,
    title: p.title,
    body: p.description,
    imageUrl: p.imageUrl,
    targetCity: p.targetCity,
    boosted: p.boosted,
    startsAt: p.startAt,
    endsAt: p.endAt,
    venueId: p.venue.id,
    venueName: p.venue.name,
    venueCity: p.venue.city,
    venueType: p.venue.venueType,
    eventId: p.event?.id || null,
    eventName: p.event?.title || null,
    eventDate: p.event?.date || null,
  }));
}

async function resolveCity({ userId, overrideCity, scopeAll, geo }) {
  if (scopeAll || geo) return '';
  let city = overrideCity;
  if (!city && userId) {
    const profile = await prisma.userProfile.findUnique({
      where: { userId },
      select: { city: true },
    });
    city = (profile?.city || '').trim();
  }
  return city;
}

/**
 * Aggregated Home payload — replaces parallel client requests on first paint.
 */
export async function buildHomeBootstrap(req) {
  const scopeAll = req.query.scope === 'all' || req.query.all === '1' || req.query.all === 'true';
  const geo = parseGeoQuery(req.query);
  const overrideCity = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const sessionId =
    (typeof req.headers['x-session-id'] === 'string' && req.headers['x-session-id'].trim()) ||
    (typeof req.query.sessionId === 'string' && req.query.sessionId.trim()) ||
    'anon-session';
  const tableLimit = Math.min(Math.max(parseInt(req.query.tableLimit, 10) || 24, 1), 60);
  const promoLimit = Math.min(Math.max(parseInt(req.query.promoLimit, 10) || 12, 1), 20);
  const featuredLimit = Math.min(Math.max(parseInt(req.query.featuredLimit, 10) || 5, 1), 12);
  const userId = req.userId || null;
  const feed = await resolveFeedScope(req);
  const city = feed ? '' : await resolveCity({ userId, overrideCity, scopeAll, geo });

  const scopedSections = (scope) =>
    Promise.allSettled([
      buildTableOfferings({
        userId,
        limit: tableLimit,
        sessionSeed: `${sessionId}|${new Date().toISOString().slice(0, 10)}|tables`,
        feed: scope,
      }),
      fetchPromotionsPage({ userId, city, scopeAll: scopeAll || !!geo, limit: promoLimit, feed: scope }),
      buildCommunityHostedEvents({ limit: 12, userId, feed: scope }),
      fetchFeaturedEventDetails({ limit: featuredLimit, feed: scope }),
    ]);

  // Isolate failures so promotions/geo errors cannot wipe Available Tables.
  const [announcementsRes, followedRes, feedRes, sectionsRes] = await Promise.allSettled([
    fetchAnnouncements(),
    userId ? fetchFollowedPromoters(userId) : Promise.resolve([]),
    buildHomeFeedPage(req),
    scopedSections(feed),
  ]);
  let sections = sectionsRes.status === 'fulfilled' ? sectionsRes.value : [];
  const feedValue = feedRes.status === 'fulfilled' ? feedRes.value : null;
  // Keep every Home section on the same scope the feed fell back to (shown to the user as a banner).
  if (feed && feedValue?.widened && feedValue.feedScope && feedValue.feedScope !== feed.scope) {
    const widenedFeed = { ...feed, scope: feedValue.feedScope, geo: null, city: null };
    sections = await scopedSections(widenedFeed);
  }
  const [tableRes, promotionsRes, communityRes, featuredRes] = sections.length
    ? sections
    : Array.from({ length: 4 }, () => ({ status: 'rejected' }));

  return {
    announcements: announcementsRes.status === 'fulfilled' ? announcementsRes.value : [],
    tableOfferings: tableRes.status === 'fulfilled' ? tableRes.value : [],
    promotions: {
      results: promotionsRes.status === 'fulfilled' ? promotionsRes.value : [],
    },
    followedPromoters: {
      items: followedRes.status === 'fulfilled' ? followedRes.value : [],
    },
    communityHostedEvents: communityRes.status === 'fulfilled' ? communityRes.value : [],
    featuredEvents: featuredRes.status === 'fulfilled' ? featuredRes.value : [],
    feed: feedRes.status === 'fulfilled' ? feedRes.value : { items: [], nextCursor: null, total: 0 },
  };
}
