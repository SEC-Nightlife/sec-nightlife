import { prisma } from './prisma.js';
import { scopeWhere, hostedTableScopeWhere } from './feedScope.js';
import { logger } from './logger.js';
import { externalListingEndsAt } from './externalListingSchedule.js';
import { getBlockedUserIdsForViewer } from './blockedUsers.js';

/**
 * Batch-compute total open spots per event (replaces N× buildEventTableTiers).
 * Uses venue table capacity + hosted GOING counts in a few queries.
 */
async function batchEventTotalSpots(eventIds) {
  const result = new Map();
  if (!eventIds?.length) return result;

  const [venueTables, hostedTables] = await Promise.all([
    prisma.venueTable.findMany({
      where: {
        eventId: { in: eventIds },
        isActive: true,
        isCustomListing: false,
      },
      select: {
        eventId: true,
        guestCapacity: true,
        currentOccupancy: true,
        hostedTableId: true,
      },
    }),
    prisma.hostedTable.findMany({
      where: {
        eventId: { in: eventIds },
        tableType: 'IN_APP_EVENT',
        status: { in: ['ACTIVE', 'FULL'] },
      },
      select: {
        id: true,
        eventId: true,
        guestQuantity: true,
        spotsRemaining: true,
      },
    }),
  ]);

  const hostedIds = hostedTables.map((h) => h.id);
  const goingByHostedId = new Map();
  if (hostedIds.length > 0) {
    const goingRows = await prisma.hostedTableMember.groupBy({
      by: ['hostedTableId'],
      where: { hostedTableId: { in: hostedIds }, status: 'GOING' },
      _count: { _all: true },
    });
    for (const row of goingRows) {
      goingByHostedId.set(row.hostedTableId, row._count._all);
    }
  }

  const linkedHostedIds = new Set(
    venueTables.map((vt) => vt.hostedTableId).filter(Boolean),
  );

  for (const eventId of eventIds) {
    let total = 0;
    for (const vt of venueTables) {
      if (vt.eventId !== eventId) continue;
      total += Math.max(0, Number(vt.guestCapacity) - Number(vt.currentOccupancy));
    }
    for (const ht of hostedTables) {
      if (ht.eventId !== eventId) continue;
      if (linkedHostedIds.has(ht.id)) continue;
      const going = goingByHostedId.get(ht.id);
      const spots =
        going != null
          ? Math.max(0, Number(ht.guestQuantity) - going)
          : Math.max(0, Number(ht.spotsRemaining) || 0);
      total += spots;
    }
    result.set(eventId, total);
  }
  return result;
}

function isBoostActive(row) {
  if (!row?.boosted) return false;
  if (!row.boostExpiresAt) return true;
  return row.boostExpiresAt instanceof Date
    ? row.boostExpiresAt > new Date()
    : new Date(row.boostExpiresAt) > new Date();
}

function isHostedListingStillLive(t, now = new Date()) {
  if (t.tableType === 'EXTERNAL_VENUE' && !t.venueTableId) {
    const end = externalListingEndsAt(t);
    return end ? end.getTime() > now.getTime() : true;
  }
  return true;
}

async function getFriendIds(userId) {
  const rows = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ requesterId: userId }, { receiverId: userId }],
    },
    select: { requesterId: true, receiverId: true },
  });
  const ids = new Set();
  for (const r of rows) {
    ids.add(r.requesterId === userId ? r.receiverId : r.requesterId);
  }
  return ids;
}

function formatHost(user) {
  if (!user) return { id: null, username: null, fullName: null, avatarUrl: null };
  const profile = user.userProfile;
  return {
    id: user.id,
    username: profile?.username || user.username || null,
    fullName: user.fullName ?? null,
    avatarUrl: profile?.avatarUrl || null,
    averageRating: profile?.serviceRatingAvg != null ? Number(profile.serviceRatingAvg) : null,
  };
}

/** Whether an event has finished for home/table listings (mirrors frontend eventLifecycle). */
function isEventEndedForListing(event) {
  if (!event) return true;
  if (event.status && event.status !== 'published') return true;
  const endsAtRaw = event.endsAt;
  if (endsAtRaw) {
    const t = endsAtRaw instanceof Date ? endsAtRaw : new Date(endsAtRaw);
    if (!Number.isNaN(t.getTime())) return t.getTime() < Date.now();
  }
  const dateStr = event.date;
  if (dateStr) {
    const d = dateStr instanceof Date
      ? new Date(dateStr)
      : new Date(`${String(dateStr).slice(0, 10)}T23:59:59.999Z`);
    if (!Number.isNaN(d.getTime())) return d.getTime() < Date.now();
  }
  return false;
}

function hashString(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Weighted shuffle: boosted items get more weight but every item still rotates
 * per session via a per-item seed (not a shared PRNG stream).
 */
function sortOfferings(list, friendIds, sessionSeed = 'default') {
  const BOOSTED_WEIGHT = 8;
  const ORGANIC_WEIGHT = 1;

  const prepared = list.map((item) => {
    const aFriend = item.hostUserId && friendIds.has(item.hostUserId);
    const weight = item.boosted ? BOOSTED_WEIGHT : ORGANIC_WEIGHT;
    const rand = seededRandom(hashString(`${sessionSeed}|${item.id}`));
    const u = Math.max(rand(), Number.EPSILON);
    const key = Math.pow(u, 1 / weight) + (aFriend ? 0.002 : 0);
    return { item, key };
  });

  prepared.sort((a, b) => {
    if (a.key !== b.key) return b.key - a.key;
    const ad = a.item.eventDate ? new Date(a.item.eventDate).getTime() : 0;
    const bd = b.item.eventDate ? new Date(b.item.eventDate).getTime() : 0;
    if (ad !== bd) return ad - bd;
    return String(a.item.id).localeCompare(String(b.item.id));
  });

  return prepared.map((x) => x.item);
}

/**
 * Round-robin across kinds; within each kind alternate boosted/organic so
 * boosted get more play without locking the carousel.
 */
function interleaveByType(sortedList, limit) {
  const buckets = {
    venue_event: { boosted: [], organic: [] },
    venue_day: { boosted: [], organic: [] },
    hosted: { boosted: [], organic: [] },
  };
  for (const item of sortedList) {
    const kind =
      item.type === 'venue_event' ? 'venue_event' : item.type === 'venue_day' ? 'venue_day' : 'hosted';
    if (item.boosted) buckets[kind].boosted.push(item);
    else buckets[kind].organic.push(item);
  }

  const pattern = ['venue_event', 'hosted', 'venue_day', 'hosted', 'venue_event', 'venue_day'];
  const out = [];
  let pi = 0;
  let pickCount = 0;
  const takeFromKind = (kind) => {
    const b = buckets[kind];
    if (!b) return null;
    // Prefer boosted ~2 of every 3 picks from a kind, but always leave room for organic.
    const preferBoosted = pickCount % 3 !== 2;
    if (preferBoosted && b.boosted.length) return b.boosted.shift();
    if (b.organic.length) return b.organic.shift();
    if (b.boosted.length) return b.boosted.shift();
    return null;
  };

  while (out.length < limit) {
    let progressed = false;
    for (let attempt = 0; attempt < pattern.length; attempt += 1) {
      const kind = pattern[(pi + attempt) % pattern.length];
      const next = takeFromKind(kind);
      if (next) {
        out.push(next);
        pickCount += 1;
        pi = (pi + attempt + 1) % pattern.length;
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * Grouped table offerings for Home / Tables browse.
 */
export async function buildTableOfferings({ userId, limit = 40, sessionSeed = 'default', feed = null } = {}) {
  const cappedLimit = Math.min(Math.max(limit, 1), 60);
  const rowCap = Math.min(cappedLimit * 12, 360);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let friendIds = new Set();
  let blockedUserIds = new Set();
  if (userId) {
    try {
      friendIds = await getFriendIds(userId);
    } catch (e) {
      logger.warn('getFriendIds failed in buildTableOfferings', { err: e?.message });
    }
    try {
      blockedUserIds = await getBlockedUserIdsForViewer(userId);
    } catch (e) {
      logger.warn('getBlockedUserIdsForViewer failed in buildTableOfferings', { err: e?.message });
    }
  }

  const venueScope = scopeWhere(feed);
  const venueWhere = {
    isActive: true,
    status: { in: ['AVAILABLE', 'PARTIALLY_FILLED'] },
    ...(Object.keys(venueScope).length ? { venue: venueScope } : {}),
  };
  const venueInclude = {
    venue: { select: { id: true, name: true, city: true, coverImageUrl: true } },
    event: {
      select: {
        id: true,
        title: true,
        date: true,
        startTime: true,
        endsAt: true,
        city: true,
        coverImageUrl: true,
        status: true,
      },
    },
  };
  // Merge boosted + recently updated so open tables are not starved by rowCap sampling.
  const [boostedVenueRows, recentVenueRows] = await Promise.all([
    prisma.venueTable.findMany({
      where: { ...venueWhere, boosted: true },
      take: 120,
      orderBy: [{ boostExpiresAt: 'desc' }, { updatedAt: 'desc' }],
      include: venueInclude,
    }),
    prisma.venueTable.findMany({
      where: venueWhere,
      take: rowCap,
      orderBy: { updatedAt: 'desc' },
      include: venueInclude,
    }),
  ]);
  const venueById = new Map();
  for (const row of [...boostedVenueRows, ...recentVenueRows]) {
    if (!venueById.has(row.id)) venueById.set(row.id, row);
  }
  const venueRows = [...venueById.values()];
  const openVenueRows = venueRows.filter((t) => {
    if (t.currentOccupancy >= t.guestCapacity) return false;
    // Day listings: only current/upcoming service windows (not every active row forever).
    if (!t.eventId) {
      const end =
        t.serviceEndDate ||
        t.serviceDate ||
        null;
      if (end) {
        const endDate = end instanceof Date ? new Date(end) : new Date(end);
        endDate.setHours(23, 59, 59, 999);
        if (endDate < today) return false;
      }
    }
    return true;
  });

  const now = new Date();
  const hostedScope = hostedTableScopeWhere(feed);
  const hostedWhere = {
    status: 'ACTIVE',
    spotsRemaining: { gt: 0 },
    OR: [
      { windowEndsAt: { gt: now } },
      { windowEndsAt: null, eventDate: { gte: today } },
    ],
    ...(hostedScope ? { AND: [hostedScope] } : {}),
  };

  const hostedRowsRaw = await prisma.hostedTable.findMany({
    where: hostedWhere,
    take: rowCap,
    orderBy: { eventDate: 'asc' },
    include: {
      host: {
        select: {
          id: true,
          username: true,
          fullName: true,
          userProfile: { select: { username: true, avatarUrl: true, serviceRatingAvg: true } },
        },
      },
      event: {
        select: {
          id: true,
          title: true,
          date: true,
          startTime: true,
          city: true,
          coverImageUrl: true,
        },
      },
    },
  });
  const hostedRows = hostedRowsRaw.filter((t) => isHostedListingStillLive(t, now));

  const linkedVenueTableIds = [
    ...new Set(hostedRows.map((t) => t.venueTableId).filter(Boolean)),
  ];
  const linkedVenueById = new Map();
  if (linkedVenueTableIds.length) {
    const linkedVenueRows = await prisma.venueTable.findMany({
      where: { id: { in: linkedVenueTableIds } },
      select: {
        id: true,
        tableName: true,
        venueId: true,
        startTime: true,
        endTime: true,
        venue: { select: { id: true, name: true, city: true, coverImageUrl: true } },
      },
    });
    for (const vt of linkedVenueRows) linkedVenueById.set(vt.id, vt);
  }

  const offerings = [];
  const venueEventMap = new Map();
  const venueDayMap = new Map();
  const hostedHostMap = new Map();

  for (const t of openVenueRows) {
    if (t.isCustomListing && !t.allowsCustomRequests) continue;
    const spots = Math.max(0, t.guestCapacity - t.currentOccupancy);
    const tierLabel = t.tierLabel || t.tableName;
    const isVip =
      t.tableCategory === 'vip' || /vip/i.test(String(tierLabel || t.tableName || ''));
    const tier = {
      tableId: t.id,
      label: tierLabel,
      tableName: t.tableName,
      minSpend: t.minimumSpend,
      bookingFeeZar: t.bookingFeeZar,
      spotsRemaining: spots,
      isCustomListing: t.isCustomListing,
      allowsCustomRequests: t.allowsCustomRequests,
      tableCategory: t.tableCategory,
      isVip,
    };

    if (t.eventId && t.event) {
      if (isEventEndedForListing(t.event)) continue;
      const key = t.eventId;
      if (!venueEventMap.has(key)) {
        venueEventMap.set(key, {
          type: 'venue_event',
          id: `venue-event-${key}`,
          eventId: key,
          venueId: t.venueId,
          title: t.event.title,
          subtitle: t.venue?.name || 'Venue',
          imageUrl: t.event.coverImageUrl || t.venue?.coverImageUrl || null,
          city: t.event.city || t.venue?.city || null,
          eventDate: t.event.date,
          eventEndsAt: t.event.endsAt,
          startTime: t.event.startTime,
          tiers: [],
          totalSpots: 0,
          minBookingFeeZar: null,
          boosted: isBoostActive(t),
          hostUserId: null,
          tableCount: 0,
        });
      }
      const g = venueEventMap.get(key);
      g.tiers.push(tier);
      if (isBoostActive(t)) g.boosted = true;
      if (!t.isCustomListing) {
        g.totalSpots += spots;
      }
      g.tableCount += 1;
      if (isVip) g.hasVip = true;
      const bf = Number(t.bookingFeeZar || 0);
      if (bf > 0 && (g.minBookingFeeZar == null || bf < g.minBookingFeeZar)) {
        g.minBookingFeeZar = bf;
      }
    } else {
      const key = t.venueId;
      if (!venueDayMap.has(key)) {
        venueDayMap.set(key, {
          type: 'venue_day',
          id: `venue-day-${key}`,
          eventId: null,
          venueId: key,
          title: t.venue?.name || 'Venue',
          subtitle: 'Book on SEC',
          imageUrl: t.venue?.coverImageUrl || null,
          city: t.venue?.city || null,
          eventDate: t.serviceDate,
          startTime: t.startTime,
          tiers: [],
          totalSpots: 0,
          minBookingFeeZar: null,
          boosted: isBoostActive(t),
          hostUserId: null,
          tableCount: 0,
        });
      }
      const g = venueDayMap.get(key);
      g.tiers.push(tier);
      if (isBoostActive(t)) g.boosted = true;
      if (!t.isCustomListing) {
        g.totalSpots += spots;
      }
      g.tableCount += 1;
      if (isVip) g.hasVip = true;
      const bf = Number(t.bookingFeeZar || 0);
      if (bf > 0 && (g.minBookingFeeZar == null || bf < g.minBookingFeeZar)) {
        g.minBookingFeeZar = bf;
      }
    }
  }

  for (const g of venueEventMap.values()) offerings.push(g);
  for (const g of venueDayMap.values()) offerings.push(g);

  const venueEventIds = [...venueEventMap.keys()];
  if (venueEventIds.length > 0) {
    try {
      const spotsByEvent = await batchEventTotalSpots(venueEventIds);
      for (const [eventId, totalSpots] of spotsByEvent) {
        const g = venueEventMap.get(eventId);
        if (g) g.totalSpots = totalSpots;
      }
    } catch (e) {
      logger.warn('batchEventTotalSpots failed in buildTableOfferings', { err: e?.message });
    }
  }

  for (const t of hostedRows) {
    if (blockedUserIds.has(t.hostUserId)) continue;
    // Community "list as event" listings appear under Home Events, not Available Tables.
    if (t.tableType === 'EXTERNAL_VENUE' && t.listingSurface === 'EVENT' && !t.venueTableId) {
      continue;
    }
    const spots = t.spotsRemaining;
    const isVipHosted = t.hostingCategory === 'VIP';
    const tableSummary = {
      id: t.id,
      tableName: t.tableName,
      spotsRemaining: spots,
      guestQuantity: t.guestQuantity,
      hasJoiningFee: t.hasJoiningFee,
      joiningFee: t.joiningFee,
      isPublic: t.isPublic,
      hostingCategory: t.hostingCategory,
      isVip: isVipHosted,
      photo: t.photo,
    };
    const boosted = isBoostActive(t);
    const host = formatHost(t.host);

    if (t.eventId && t.event) {
      const key = `${t.eventId}:${t.hostUserId}`;
      if (!hostedHostMap.has(key)) {
        hostedHostMap.set(key, {
          type: 'hosted_host',
          id: `hosted-host-${t.eventId}-${t.hostUserId}`,
          eventId: t.eventId,
          hostUserId: t.hostUserId,
          venueId: null,
          title: host.username ? `@${host.username}` : host.fullName || 'Host',
          subtitle: t.event.title,
          imageUrl: t.photo || t.event.coverImageUrl || null,
          city: t.event.city || null,
          eventDate: t.eventDate,
          startTime: t.eventTime,
          host,
          hostName: host.username || host.fullName || null,
          hostAvatarUrl: host.avatarUrl || null,
          tables: [],
          totalSpots: 0,
          minJoinFeeZar: null,
          maxJoinFeeZar: null,
          boosted: false,
          isPublic: t.isPublic !== false,
          tableCount: 0,
        });
      }
      const g = hostedHostMap.get(key);
      g.tables.push(tableSummary);
      if (t.isPublic === false) g.isPublic = false;
      g.totalSpots += spots;
      g.tableCount += 1;
      if (isVipHosted) g.hasVip = true;
      if (boosted) {
        g.boosted = true;
        if (t.photo) g.imageUrl = t.photo;
      }
      const jf = t.hasJoiningFee ? Number(t.joiningFee || 0) : 0;
      if (t.hasJoiningFee && jf > 0) {
        if (g.minJoinFeeZar == null || jf < g.minJoinFeeZar) g.minJoinFeeZar = jf;
        if (g.maxJoinFeeZar == null || jf > g.maxJoinFeeZar) g.maxJoinFeeZar = jf;
      }
    } else {
      const linkedVt = t.venueTableId ? linkedVenueById.get(t.venueTableId) : null;
      const isVenueDay = Boolean(linkedVt);
      const slotName = linkedVt?.tableName || t.tableName;
      const jf = t.hasJoiningFee ? Number(t.joiningFee || 0) : 0;
      const externalTitle =
        t.tableName ||
        (host.username ? `@${host.username}` : host.fullName || 'Host');
      offerings.push({
        type: isVenueDay ? 'hosted_venue_day' : 'hosted_external',
        id: isVenueDay ? `hosted-venue-day-${t.id}` : `hosted-ext-${t.id}`,
        eventId: null,
        hostUserId: t.hostUserId,
        hostedTableId: t.id,
        venueId: linkedVt?.venueId || null,
        venueTableId: t.venueTableId || null,
        title: isVenueDay ? slotName : externalTitle,
        subtitle: isVenueDay
          ? linkedVt?.venue?.name || t.venueName || 'Venue'
          : t.venueName || (host.username ? `@${host.username}` : 'Your own place'),
        imageUrl: t.photo || linkedVt?.venue?.coverImageUrl || null,
        city: linkedVt?.venue?.city || null,
        listingSurface: t.listingSurface || 'TABLE',
        eventDate: t.eventDate,
        startTime: t.eventTime || linkedVt?.startTime || null,
        windowEndsAt: t.windowEndsAt || null,
        host,
        hostName: host.username || host.fullName || null,
        hostAvatarUrl: host.avatarUrl || null,
        tables: [tableSummary],
        totalSpots: spots,
        minJoinFeeZar: t.hasJoiningFee && jf > 0 ? jf : null,
        maxJoinFeeZar: t.hasJoiningFee && jf > 0 ? jf : null,
        isPublic: t.isPublic,
        tableName: slotName,
        boosted,
        tableCount: 1,
        hasVip: isVipHosted,
      });
    }
  }

  for (const g of hostedHostMap.values()) offerings.push(g);

  const sorted = sortOfferings(offerings, friendIds, sessionSeed);
  return interleaveByType(sorted, cappedLimit);
}

/**
 * External hosted listings marked as EVENT surface — shown in Home Events section.
 */
export async function buildCommunityHostedEvents({ limit = 12, userId = null, feed = null } = {}) {
  const cappedLimit = Math.min(Math.max(limit, 1), 30);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const now = new Date();
  const blockedUserIds = await getBlockedUserIdsForViewer(userId);
  const ownScope = scopeWhere(feed);

  const rowsRaw = await prisma.hostedTable.findMany({
    where: {
      status: 'ACTIVE',
      spotsRemaining: { gt: 0 },
      tableType: 'EXTERNAL_VENUE',
      listingSurface: 'EVENT',
      venueTableId: null,
      OR: [
        { windowEndsAt: { gt: now } },
        { windowEndsAt: null, eventDate: { gte: today } },
      ],
      ...ownScope,
    },
    take: Math.min(cappedLimit * 3, 60),
    orderBy: [{ boosted: 'desc' }, { eventDate: 'asc' }],
    include: {
      host: {
        select: {
          id: true,
          username: true,
          fullName: true,
          userProfile: { select: { username: true, avatarUrl: true } },
        },
      },
    },
  });
  const rows = rowsRaw
    .filter((t) => !blockedUserIds.has(t.hostUserId))
    .filter((t) => isHostedListingStillLive(t, now))
    .slice(0, cappedLimit);

  return rows.map((t) => {
    const host = formatHost(t.host);
    const addressBits = String(t.venueAddress || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const cityGuess =
      addressBits.length >= 2 ? addressBits[addressBits.length - 2] : addressBits[0] || null;
    const boosted = isBoostActive(t);
    return {
      id: t.id,
      hostedTableId: t.id,
      source: 'hosted',
      title: t.tableName,
      description: t.tableDescription || null,
      date: t.eventDate,
      startTime: t.eventTime,
      endTime: t.eventEndTime || null,
      endsAt: t.windowEndsAt || externalListingEndsAt(t),
      city: cityGuess,
      venueName: t.venueName,
      cover_image_url: t.photo || null,
      coverImageUrl: t.photo || null,
      eventType: t.eventType,
      spotsRemaining: t.spotsRemaining,
      guestQuantity: t.guestQuantity,
      hasJoiningFee: t.hasJoiningFee,
      joiningFee: t.joiningFee,
      isPublic: t.isPublic,
      hostName: host.username || host.fullName || null,
      hostAvatarUrl: host.avatarUrl || null,
      listingSurface: 'EVENT',
      isCommunityHosted: true,
      boosted,
    };
  });
}
