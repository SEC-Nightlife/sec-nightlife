/**
 * Resolve venue + allocation labels for door staff (QR verify screen).
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {import('@prisma/client').Ticket} ticket
 */
export async function buildTicketDoorContext(prisma, ticket) {
  /** @type {{
   *   venue_id: string | null;
   *   venue_name: string | null;
   *   venue_city: string | null;
   *   venue_timezone: string | null;
   *   event_title: string | null;
   *   event_code: string | null;
   *   table_allocation_label: string | null;
   *   check_location_line: string | null;
   * }} */
  const ctx = {
    venue_id: null,
    venue_name: null,
    venue_city: null,
    venue_timezone: null,
    event_title: null,
    event_code: null,
    table_allocation_label: null,
    check_location_line: null,
  };

  const venueSelect = { id: true, name: true, city: true, address: true, suburb: true, timezone: true };

  const applyVenue = (v) => {
    if (!v) return;
    if (!ctx.venue_id && v.id) ctx.venue_id = v.id;
    if (!ctx.venue_name && v.name) ctx.venue_name = v.name;
    if (!ctx.venue_city && v.city) ctx.venue_city = v.city;
    if (!ctx.venue_timezone && v.timezone) ctx.venue_timezone = v.timezone;
  };

  const applyEventBasics = (ev) => {
    if (!ev) return;
    if (!ctx.event_title && ev.title) ctx.event_title = ev.title;
    if (!ctx.event_code && ev.eventCode) ctx.event_code = ev.eventCode;
    if (!ctx.venue_city && ev.city) ctx.venue_city = ev.city;
    applyVenue(ev.venue);
  };

  const eventSelect = { title: true, city: true, venueId: true, eventCode: true, venue: { select: venueSelect } };

  if (ticket.eventId) {
    const ev = await prisma.event.findFirst({
      where: { id: ticket.eventId, deletedAt: null },
      select: eventSelect,
    });
    applyEventBasics(ev);
  }

  if (ticket.tableId) {
    const table = await prisma.table.findFirst({
      where: { id: ticket.tableId, deletedAt: null },
      select: {
        name: true,
        tableCategory: true,
        event: {
          select: eventSelect,
        },
        venue: { select: venueSelect },
      },
    });
    if (table) {
      const cat = table.tableCategory ? String(table.tableCategory).toUpperCase() : '';
      ctx.table_allocation_label = cat
        ? `${cat} table · ${table.name}`
        : `Table · ${table.name}`;
      applyEventBasics(table.event);
      applyVenue(table.venue);
    }
  }

  if (ticket.venueTableId) {
    const vt = await prisma.venueTable.findUnique({
      where: { id: ticket.venueTableId },
      select: {
        tableName: true,
        event: {
          select: eventSelect,
        },
        venue: { select: venueSelect },
      },
    });
    if (vt) {
      ctx.table_allocation_label = `Venue table · ${vt.tableName}`;
      applyEventBasics(vt.event);
      applyVenue(vt.venue);
    }
  }

  if (ticket.hostedTableId) {
    const ht = await prisma.hostedTable.findUnique({
      where: { id: ticket.hostedTableId },
      select: {
        tableName: true,
        venueName: true,
        venueAddress: true,
        eventId: true,
        event: {
          select: eventSelect,
        },
      },
    });
    if (ht) {
      ctx.table_allocation_label = `Hosted table · ${ht.tableName}`;
      if (ht.event) {
        applyEventBasics(ht.event);
      }
      if (!ctx.venue_name && ht.venueName) {
        ctx.venue_name = ht.venueName;
      }
      if (!ctx.check_location_line && (ht.venueAddress || ht.venueName)) {
        ctx.check_location_line = [ht.venueName, ht.venueAddress].filter(Boolean).join(' · ');
      }
    }
  }

  if (ticket.housePartyId) {
    const hp = await prisma.houseParty.findUnique({
      where: { id: ticket.housePartyId },
      select: { title: true, location: true },
    });
    if (hp) {
      if (!ctx.event_title) ctx.event_title = hp.title;
      ctx.table_allocation_label = 'House party guest';
      if (!ctx.venue_name) ctx.venue_name = hp.location || hp.title;
      if (!ctx.check_location_line && hp.location) ctx.check_location_line = hp.location;
    }
  }

  if (!ctx.table_allocation_label && ticket.subtitle) {
    ctx.table_allocation_label = String(ticket.subtitle).trim().slice(0, 220);
  }

  if (!ctx.check_location_line) {
    const parts = [ctx.venue_name, ctx.venue_city].filter(Boolean);
    if (parts.length) ctx.check_location_line = parts.join(' · ');
  }

  if (!ctx.check_location_line && ctx.venue_id) {
    const v = await prisma.venue.findFirst({
      where: { id: ctx.venue_id, deletedAt: null },
      select: { name: true, address: true, suburb: true, city: true },
    });
    if (v) {
      const addr = [v.address, v.suburb, v.city].filter(Boolean).join(', ');
      ctx.check_location_line = [v.name, addr].filter(Boolean).join(' · ');
      if (!ctx.venue_name) ctx.venue_name = v.name;
      if (!ctx.venue_city && v.city) ctx.venue_city = v.city;
    }
  }

  return ctx;
}
