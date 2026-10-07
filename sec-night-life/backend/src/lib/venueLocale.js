import { prisma } from './prisma.js';
import { zoneOf } from './timezone.js';

/** Events inherit country and time zone from their venue; keep them aligned after a venue edit. */
export async function syncVenueLocaleToEvents(venue) {
  if (!venue?.id) return;
  await prisma.event.updateMany({
    where: { venueId: venue.id, deletedAt: null },
    data: {
      ...(venue.countryCode ? { countryCode: venue.countryCode } : {}),
      timezone: zoneOf(venue),
    },
  });
}
