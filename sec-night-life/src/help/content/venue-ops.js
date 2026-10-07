import { HELP_FACTS as F } from '../facts';

export const createEvent = {
  id: 'create-event',
  audience: 'venue',
  category: 'events',
  title: 'How to create an event',
  summary:
    'Publish table-hosting or ticketed events from Business Events, with tiers and optional extras.',
  readMinutes: 8,
  keywords: ['create event', 'table hosting', 'ticketing', 'tiers', 'BusinessEvents'],
  sections: [
    {
      type: 'p',
      text: 'Venues create events in Business Events. Choose a format: Table hosting (guests host/join tables at your event) or Ticketed only (ticket tiers, optional menu add-ons). Publishing also ensures an event group chat for attendees where applicable.',
    },
    {
      type: 'heading',
      text: 'Event types',
    },
    {
      type: 'p',
      text: 'Table hosting (TABLE_HOSTING): define general/VIP (and similar) hosting tiers with host fees, minimum spend, and optional custom requests. Optional entrance fee can apply. SEC syncs venue table slots from your tiers.',
    },
    {
      type: 'p',
      text: 'Ticketed only (TICKETING_ONLY): sell ticket tiers. No table-hosting entrance path. You can optionally allow ticket menu add-ons.',
    },
    {
      type: 'steps',
      items: [
        'Open Business Dashboard → Events.',
        'Create a new event: title, date/time, cover, description.',
        'Select Table hosting or Ticketed only.',
        'Configure tiers (host fees / ticket prices, min spend, capacity).',
        'Enable custom requests or ticket menu add-ons if needed.',
        'Publish when ready — listings appear on Home / Events for party-goers.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/create-event.svg',
      alt: 'Create event with format toggle',
      caption: 'Choose Table hosting or Ticketed only when creating.',
      path: 'Business Dashboard → Events',
      illustrative: true,
    },
    {
      type: 'related',
      ids: ['table-day-bookings', 'boost-tables-events', 'promotions', 'custom-tables-venue'],
    },
  ],
};

export const tableDayBookings = {
  id: 'table-day-bookings',
  audience: 'venue',
  category: 'events',
  title: 'Table & day bookings',
  summary:
    'Event table slots vs day bookings within your opening hours, and how you manage them.',
  readMinutes: 7,
  keywords: ['day booking', 'event table', 'hours', 'BusinessBookings', 'sessions'],
  sections: [
    {
      type: 'heading',
      text: 'Event tables',
    },
    {
      type: 'p',
      text: 'Slots tied to a published table-hosting event. Guests host or join via Event / Table details. You track SEC hosted sessions under Business Bookings (event side).',
    },
    {
      type: 'heading',
      text: 'Day bookings',
    },
    {
      type: 'p',
      text: `Enable accepts day bookings so guests can book a table for a time window on a normal night (not only during a named event). Windows respect venue hours in the venue's local time zone (overnight-aware). Minimum booking length is ${F.dayBookingMinMinutes} minutes; slot steps are typically 30 minutes. Overlaps are blocked by session occupancy.`,
    },
    {
      type: 'steps',
      items: [
        'Configure tables and day-booking settings under Business Venue Tables.',
        'Set opening hours so day windows are valid.',
        'Review bookings in Business Bookings (Event vs Day tabs).',
        'Use Remove from listings on empty slots you need offline for private use or custom compensation.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/day-bookings.svg',
      alt: 'Day booking and venue tables',
      caption: 'Business Venue Tables and Bookings cover event and day sessions.',
      path: 'Business Dashboard → Tables / Bookings',
      illustrative: true,
    },
    {
      type: 'related',
      ids: ['create-event', 'remove-from-listings', 'custom-tables-venue', 'minimum-spend'],
    },
  ],
};

export const promotions = {
  id: 'promotions',
  audience: 'venue',
  category: 'promote',
  title: 'Advertise through the Promotions page',
  summary: `Create venue or event promotions — publish from R${F.promotionPublishPerDayZar}/day and optionally boost.`,
  readMinutes: 5,
  keywords: ['promotion', 'advertise', 'sponsored', 'R50', 'BusinessPromotions'],
  sections: [
    {
      type: 'p',
      text: `Promotions put your venue or event in the Home feed. Publish pricing is R${F.promotionPublishPerDayZar} per day (1–${F.maxBoostDays} days). You can add a promotion boost at R${F.boostPerDayZar}/day so sponsored creatives rank higher. These fees are platform products and are not refundable.`,
    },
    {
      type: 'steps',
      items: [
        'Open Business Dashboard → Promotions.',
        'Create a promotion linked to your venue or a specific event.',
        'Choose duration and pay to publish.',
        'Optionally open Boost to add extra sponsored days.',
        'Confirm the promo appears on Home (boosted items first / Sponsored).',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/promotions.svg',
      alt: 'Business promotions page',
      caption: 'Publish and boost promotions from the business Promotions page.',
      path: 'Business Dashboard → Promotions',
      illustrative: true,
    },
    {
      type: 'related',
      ids: ['boost-tables-events', 'create-event', 'venue-getting-started'],
    },
  ],
};

export const boostTablesEvents = {
  id: 'boost-tables-events',
  audience: 'venue',
  category: 'promote',
  title: 'Boost tables and events',
  summary: `Pay R${F.boostPerDayZar}/day to lift tables and events higher in the feed.`,
  readMinutes: 4,
  keywords: ['boost', 'sponsored', 'promoted', 'R150', 'feed'],
  sections: [
    {
      type: 'p',
      text: `Feed boosts apply to venue tables, hosted tables, events, and house parties. Pricing is R${F.boostPerDayZar} per day (clamped 1–${F.maxBoostDays}, and may end with the listing). Boosted items sort higher and may show Sponsored / Promoted. Boosts are not refundable and are 100% SEC platform revenue.`,
    },
    {
      type: 'steps',
      items: [
        'From Business Events, Business Venue Tables, or related host tools, open Boost.',
        'Choose number of days and confirm Paystack checkout.',
        'Check Home / Tables feeds for higher placement while the boost is active.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/feed-boost.svg',
      alt: 'Feed boost dialog',
      caption: 'Boost dialog from events or tables management.',
      path: 'Events / Tables → Boost',
      illustrative: true,
    },
    {
      type: 'related',
      ids: ['promotions', 'create-event', 'table-day-bookings'],
    },
  ],
};

export const removeFromListings = {
  id: 'remove-from-listings',
  audience: 'venue',
  category: 'venueOps',
  title: 'Remove from listings explained',
  summary:
    'Soft-hide an empty table so guests cannot book it — for owner use or to free a slot for a custom table.',
  readMinutes: 5,
  keywords: ['remove from listings', 'hide table', 'restore', 'custom compensation', 'owner use'],
  sections: [
    {
      type: 'p',
      text: 'Remove from listings soft-hides a venue table slot (isActive false) so it no longer appears publicly for booking. Restore puts it back. Use this when the owner needs the table, or when a custom table booking will occupy that physical space and you do not want double bookings.',
    },
    {
      type: 'image',
      src: '/help/diagrams/remove-listings.svg',
      alt: 'Remove from listings use cases',
      caption: 'Hide empty standard slots for owner use or custom-table compensation.',
    },
    {
      type: 'heading',
      text: 'Rules',
    },
    {
      type: 'steps',
      items: [
        'Only empty (not in-use) standard slots can be hidden.',
        'Custom-request listings cannot be removed this way.',
        'If a table is already hosted / in session, hide is blocked until free.',
        'Hidden slots show status Hidden; restore only if still not in use.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/remove-listings.svg',
      alt: 'Remove from listings button on venue tables',
      caption: 'Per-slot action on Business Venue Tables / event table management.',
      path: 'Business Dashboard → Venue Tables',
      illustrative: true,
    },
    {
      type: 'related',
      ids: ['custom-tables-venue', 'table-day-bookings', 'create-event'],
    },
  ],
};
