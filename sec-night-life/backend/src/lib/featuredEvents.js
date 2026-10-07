import { prisma } from './prisma.js';
import { normalizeHostingConfig } from './hostingConfig.js';
import { eventScopeWhere } from './feedScope.js';

/**
 * Lightweight featured carousel payload (no per-event buildEventTableTiers).
 */
export async function fetchFeaturedEventDetails({ ids = null, limit = 5, feed = null } = {}) {
  let resolvedIds = Array.isArray(ids) ? ids.filter(Boolean).slice(0, 12) : [];
  const now = new Date();

  if (resolvedIds.length === 0) {
    const featured = await prisma.event.findMany({
      where: {
        deletedAt: null,
        status: 'published',
        endsAt: { gte: now },
        OR: [{ isFeatured: true }, { boosted: true }],
        ...eventScopeWhere(feed),
      },
      orderBy: [{ boosted: 'desc' }, { date: 'asc' }],
      take: Math.min(Math.max(limit, 1), 12),
      select: { id: true },
    });
    resolvedIds = featured.map((e) => e.id);
  }
  if (resolvedIds.length === 0) return [];

  const events = await prisma.event.findMany({
    where: {
      id: { in: resolvedIds },
      deletedAt: null,
      status: 'published',
      endsAt: { gte: now },
    },
    include: { venue: true },
  });
  const byId = new Map(events.map((e) => [e.id, e]));

  const goingRows = await prisma.eventAttendance.groupBy({
    by: ['eventId'],
    where: { eventId: { in: resolvedIds }, confirmed: true },
    _count: { _all: true },
  });
  const goingByEvent = new Map(goingRows.map((r) => [r.eventId, r._count._all]));

  // One batched venue-table spots query instead of N× buildEventTableTiers.
  const venueTables = await prisma.venueTable.findMany({
    where: {
      eventId: { in: resolvedIds },
      isActive: true,
      isCustomListing: false,
    },
    select: {
      eventId: true,
      guestCapacity: true,
      currentOccupancy: true,
      tableCategory: true,
    },
  });
  const spotsByEvent = new Map();
  for (const vt of venueTables) {
    const spots = Math.max(0, Number(vt.guestCapacity) - Number(vt.currentOccupancy));
    const cur = spotsByEvent.get(vt.eventId) || { general: 0, vip: 0 };
    if (String(vt.tableCategory || '').toLowerCase() === 'vip') cur.vip += spots;
    else cur.general += spots;
    spotsByEvent.set(vt.eventId, cur);
  }

  return resolvedIds
    .map((id) => {
      const event = byId.get(id);
      if (!event) return null;
      const going = goingByEvent.get(id) || 0;
      const spots = spotsByEvent.get(id) || { general: 0, vip: 0 };
      const stats = {
        going_count: going,
        hosted_tables: 0,
        general: {
          tables_remaining: spots.general,
          tables_with_join_space: spots.general > 0 ? 1 : 0,
          tables_full: 0,
        },
        vip: {
          tables_remaining: spots.vip,
          tables_with_join_space: spots.vip > 0 ? 1 : 0,
          tables_full: 0,
        },
      };
      const v = event.venue;
      return {
        id: event.id,
        title: event.title,
        description: event.description,
        date: event.date.toISOString().slice(0, 10),
        city: event.city,
        location_address: event.locationAddress || v?.address || null,
        location_city: event.locationCity || event.city || v?.city || null,
        location_suburb: event.locationSuburb || v?.suburb || null,
        location_province: event.locationProvince || v?.province || null,
        venue_id: event.venueId,
        status: event.status,
        is_featured: event.isFeatured,
        boosted:
          Boolean(event.boosted) &&
          (!event.boostExpiresAt || new Date(event.boostExpiresAt) > now),
        cover_image_url: event.coverImageUrl,
        banner_url: event.bannerUrl,
        start_time: event.startTime,
        ends_at: event.endsAt ? event.endsAt.toISOString() : null,
        has_entrance_fee: event.hasEntranceFee,
        entrance_fee_amount: event.entranceFeeAmount,
        hosting_config: normalizeHostingConfig(event.hostingConfig),
        event_format: event.eventFormat || 'TABLE_HOSTING',
        venue_name: v?.name ?? null,
        stats,
        total_attending: going,
      };
    })
    .filter(Boolean);
}
