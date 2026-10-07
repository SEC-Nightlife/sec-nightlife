/**
 * Compare optional URL hint params to authoritative ticket / door data.
 * Hints are UX only; token is the source of truth.
 */
export function evaluatePrintedHints(query, door, ticket) {
  const rawEc = query.ec != null ? String(query.ec) : '';
  const rawVn = query.vn != null ? String(query.vn) : '';
  const rawAt = query.at != null ? String(query.at) : '';
  let ec = '';
  let vn = '';
  let at = '';
  try {
    ec = rawEc ? decodeURIComponent(rawEc.replace(/\+/g, ' ')).trim().toUpperCase() : '';
  } catch {
    ec = rawEc.trim().toUpperCase();
  }
  try {
    vn = rawVn ? decodeURIComponent(rawVn.replace(/\+/g, ' ')) : '';
  } catch {
    vn = rawVn;
  }
  try {
    at = rawAt ? decodeURIComponent(rawAt.replace(/\+/g, ' ')) : '';
  } catch {
    at = rawAt;
  }

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

  let printed_hint_event_code_ok = null;
  if (ec && door?.event_code) {
    printed_hint_event_code_ok = ec === String(door.event_code).trim().toUpperCase();
  }

  let printed_hint_venue_ok = null;
  if (vn && door?.venue_name) {
    const a = norm(vn);
    const b = norm(door.venue_name);
    printed_hint_venue_ok =
      a === b || b.startsWith(a.slice(0, Math.min(12, a.length))) || a.startsWith(b.slice(0, Math.min(12, b.length)));
  }

  let printed_hint_time_ok = null;
  if (at && ticket?.eventStartsAt) {
    const hintDate = new Date(at);
    const rowDate = ticket.eventStartsAt instanceof Date ? ticket.eventStartsAt : new Date(ticket.eventStartsAt);
    if (Number.isFinite(hintDate.getTime()) && Number.isFinite(rowDate.getTime())) {
      const deltaMs = Math.abs(hintDate.getTime() - rowDate.getTime());
      printed_hint_time_ok = deltaMs < 4 * 60 * 60 * 1000;
    }
  }

  const printed_hints_mismatch = Boolean(
    (ec && door?.event_code && printed_hint_event_code_ok === false) ||
      (vn && door?.venue_name && printed_hint_venue_ok === false) ||
      (at && ticket?.eventStartsAt && printed_hint_time_ok === false),
  );

  return {
    printed_hint_event_code_ok,
    printed_hint_venue_ok,
    printed_hint_time_ok,
    printed_hints_mismatch,
  };
}

export function hostInstructionsForKind(kind) {
  switch (kind) {
    case 'TABLE_JOIN':
    case 'TABLE_HOST_FEE':
    case 'VENUE_TABLE_JOIN':
      return 'Venue / table host: match venue name and time, then seat at the table shown above.';
    case 'HOSTED_TABLE_JOIN':
      return 'Hosted table: confirm with the table host before seating.';
    case 'HOUSE_PARTY':
      return 'House party: confirm with the party host — check address on the ticket.';
    case 'EVENT_TICKET':
      return 'Event door: check event code and tier on ticket; ID must match guest name.';
    case 'EXTERNAL_HOSTED_LISTING':
      return 'External listing: confirm venue name with the host’s published details.';
    case 'MENU_ADDON':
      return 'Add-on order only — this QR does not admit entry. Hand over the items listed, then mark the order fulfilled.';
    default:
      return 'Confirm guest identity and booking details before entry.';
  }
}
