import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { dayEventStartsAtFromMember } from './ticketHelpers.js';

/**
 * Record or refresh a table participation row (awaitable).
 * @param {object} opts
 * @param {string} opts.userId
 * @param {'HOST'|'JOINED'} opts.role
 * @param {string} opts.tableName
 * @param {string} [opts.eventTitle]
 * @param {string} [opts.eventId]
 * @param {string} [opts.tableId]
 * @param {string} [opts.hostedTableId]
 * @param {string} [opts.venueTableId]
 * @param {Date} [opts.occurredAt]
 */
export async function recordTableHistoryAwait(opts) {
  const {
    userId,
    role,
    tableName,
    eventTitle = null,
    eventId = null,
    tableId = null,
    hostedTableId = null,
    venueTableId = null,
    occurredAt = new Date(),
  } = opts;

  if (!userId || !tableName || !role) return;

  const where = {
    userId,
    role,
    hiddenAt: null,
    ...(tableId ? { tableId } : {}),
    ...(hostedTableId ? { hostedTableId } : {}),
    ...(venueTableId ? { venueTableId } : {}),
  };

  const existing = await prisma.userTableHistory.findFirst({
    where,
    orderBy: { occurredAt: 'desc' },
  });

  if (existing) {
    await prisma.userTableHistory.update({
      where: { id: existing.id },
      data: {
        tableName,
        eventTitle,
        eventId,
        occurredAt,
      },
    });
    return;
  }

  await prisma.userTableHistory.create({
    data: {
      userId,
      role,
      tableName,
      eventTitle,
      eventId,
      tableId,
      hostedTableId,
      venueTableId,
      occurredAt,
    },
  });
}

/** Fire-and-forget wrapper for runtime payment/join flows. */
export function recordTableHistory(opts) {
  if (!opts.userId || !opts.tableName || !opts.role) return;
  recordTableHistoryAwait(opts).catch((e) => {
    logger?.warn?.('table history record failed', { err: e?.message, userId: opts.userId, role: opts.role });
  });
}

/** Occurred-at for venue host/join rows — prefer booked window start for day bookings. */
export function hostParticipationOccurredAt(member, venueTable) {
  if (member) {
    const fromWindow = dayEventStartsAtFromMember(member, venueTable || null);
    if (fromWindow && !Number.isNaN(fromWindow.getTime())) return fromWindow;
    if (member.paidAt) return member.paidAt;
    if (member.joinedAt) return member.joinedAt;
  }
  return new Date();
}

/**
 * Record venue-table HOST participation with hostedTableId + booking window occurredAt.
 * @param {{ userId: string, venueTable: object, hostedTableId?: string|null, member?: object|null, eventTitle?: string|null, awaitable?: boolean }} opts
 */
export function recordVenueHostParticipation(opts) {
  const { userId, venueTable, hostedTableId, member, eventTitle, awaitable = false } = opts;
  if (!userId || !venueTable?.tableName) return awaitable ? Promise.resolve() : undefined;

  const payload = {
    userId,
    role: 'HOST',
    venueTableId: venueTable.id ?? null,
    hostedTableId: hostedTableId ?? venueTable.hostedTableId ?? null,
    eventId: venueTable.eventId ?? null,
    tableName: venueTable.tableName,
    eventTitle: eventTitle ?? null,
    occurredAt: hostParticipationOccurredAt(member, venueTable),
  };

  if (awaitable) return recordTableHistoryAwait(payload);
  return recordTableHistory(payload);
}

/** Soft-hide persisted history rows when a refund is approved. */
export async function hideParticipationForRefund(tx, { userId, venueTableId, hostedTableId }) {
  if (!userId) return;
  const or = [];
  if (venueTableId) or.push({ venueTableId });
  if (hostedTableId) or.push({ hostedTableId });
  if (!or.length) return;
  await tx.userTableHistory.updateMany({
    where: { userId, hiddenAt: null, OR: or },
    data: { hiddenAt: new Date() },
  });
}

export function mapTableHistoryRow(row) {
  const role =
    row.role === 'HOST' || row.role === 'host'
      ? 'host'
      : row.role === 'ATTENDED' || row.role === 'attended'
        ? 'attended'
        : 'joined';
  return {
    id: row.id,
    userId: row.userId,
    role,
    tableName: row.tableName,
    eventTitle: row.eventTitle,
    eventId: row.eventId,
    tableId: row.tableId,
    hostedTableId: row.hostedTableId,
    venueTableId: row.venueTableId,
    occurredAt: row.occurredAt,
    ticketId: row.ticketId ?? null,
  };
}

/** Stable dedupe key for a table participation entry. */
export function participationKey(role, ids = {}) {
  const r = role === 'HOST' || role === 'host' ? 'HOST' : 'JOINED';
  return `${r}:${ids.tableId || ''}:${ids.hostedTableId || ''}:${ids.venueTableId || ''}`;
}

/** Collapse linked venue/host sessions to one HOST participation key. */
export function canonicalHostSessionKey(row, hostedToVenue = null) {
  const isHost = row.role === 'HOST' || row.role === 'host';
  if (!isHost) return null;
  if (row.hostedTableId) return `HOST:hosted:${row.hostedTableId}`;
  const venueTableId = row.venueTableId || (row.hostedTableId && hostedToVenue?.get(row.hostedTableId)) || null;
  if (venueTableId) return `HOST:venue-session:${venueTableId}`;
  if (row.tableId) return `HOST:legacy:${row.tableId}`;
  return null;
}

async function buildHostSessionContext(rows) {
  const hostedIds = new Set();
  const venueIds = new Set();
  for (const row of rows) {
    if (row.hostedTableId) hostedIds.add(row.hostedTableId);
    if (row.venueTableId) venueIds.add(row.venueTableId);
  }
  const hostedToVenue = new Map();
  const venueSlotNames = new Map();

  if (hostedIds.size) {
    const hostedRows = await prisma.hostedTable.findMany({
      where: { id: { in: [...hostedIds] } },
      select: { id: true, venueTableId: true },
    });
    for (const h of hostedRows) {
      if (h.venueTableId) hostedToVenue.set(h.id, h.venueTableId);
    }
  }

  const allVenueIds = new Set([...venueIds, ...hostedToVenue.values()]);
  if (allVenueIds.size) {
    const venueRows = await prisma.venueTable.findMany({
      where: { id: { in: [...allVenueIds] } },
      select: { id: true, tableName: true, hostedTableId: true },
    });
    for (const vt of venueRows) {
      venueSlotNames.set(vt.id, vt.tableName);
      if (vt.hostedTableId) hostedToVenue.set(vt.hostedTableId, vt.id);
    }
  }

  return { hostedToVenue, venueSlotNames };
}

function resolveVenueSlotNameForHistory(row, hostedToVenue, venueSlotNames) {
  const venueTableId =
    row.venueTableId || (row.hostedTableId && hostedToVenue.get(row.hostedTableId)) || null;
  if (venueTableId && venueSlotNames.has(venueTableId)) {
    return venueSlotNames.get(venueTableId);
  }
  const raw = row.tableName || '';
  const hostPassIdx = raw.indexOf(' — Host pass');
  if (hostPassIdx > 0) return raw.slice(0, hostPassIdx);
  return row.tableName;
}

/** Secondary dedupe key when the same participation appears with different ID fields. */
export function canonicalHistoryKey(row) {
  const role =
    row.role === 'HOST' || row.role === 'host'
      ? 'host'
      : row.role === 'ATTENDED' || row.role === 'attended'
        ? 'attended'
        : 'joined';
  const title = (row.tableName || row.eventTitle || '').toLowerCase().trim();
  const eventId = row.eventId || '';
  return `${role}:${eventId}:${title}`;
}

function rowParticipationKey(row, hostedToVenue = null) {
  if ((row.role === 'ATTENDED' || row.role === 'attended') && row.eventId) {
    return `ATTENDED:${row.eventId}`;
  }
  const hostKey = canonicalHostSessionKey(row, hostedToVenue);
  if (hostKey) return hostKey;
  return participationKey(row.role, row);
}

function tryAddHistoryRow(byKey, byCanonical, hiddenKeys, row, hostedToVenue = null) {
  const canon = canonicalHistoryKey(row);
  const key = rowParticipationKey(row, hostedToVenue);
  if (hiddenKeys.has(key)) return false;

  const roleNorm =
    row.role === 'HOST' || row.role === 'host'
      ? 'host'
      : row.role === 'ATTENDED' || row.role === 'attended'
        ? 'attended'
        : 'joined';

  if (roleNorm === 'joined') {
    const hostKey = canonicalHostSessionKey(
      { ...row, role: 'HOST' },
      hostedToVenue,
    ) || participationKey('HOST', row);
    if (byKey.has(hostKey)) return false;
  }

  if (roleNorm === 'host') {
    const joinedKey = participationKey('JOINED', row);
    if (byKey.has(joinedKey)) {
      byKey.delete(joinedKey);
      for (const c of [...byCanonical]) {
        if (c.startsWith('joined:')) byCanonical.delete(c);
      }
    }
  }

  if (byCanonical.has(canon)) return false;

  if (byKey.has(key)) return false;

  byKey.set(key, row);
  byCanonical.add(canon);
  return true;
}

function ticketRoleFromKind(kind, ticket = null) {
  if (kind === 'EVENT_TICKET' || kind === 'EVENT_ENTRANCE') return 'ATTENDED';
  if (kind === 'TABLE_HOST_FEE') return 'HOST';
  if (kind === 'VENUE_TABLE_JOIN') {
    const title = String(ticket?.title || '');
    if (title.includes('Host pass')) return 'HOST';
  }
  return 'JOINED';
}

function ticketHistoryKey(ticket, hostedToVenue = null) {
  if ((ticket.kind === 'EVENT_TICKET' || ticket.kind === 'EVENT_ENTRANCE') && ticket.eventId) {
    return `ATTENDED:${ticket.eventId}`;
  }
  const role = ticketRoleFromKind(ticket.kind, ticket);
  const row = {
    role,
    tableId: ticket.tableId,
    hostedTableId: ticket.hostedTableId,
    venueTableId: ticket.venueTableId,
  };
  const hostKey = canonicalHostSessionKey(row, hostedToVenue);
  if (hostKey && (role === 'HOST' || role === 'host')) return hostKey;
  return participationKey(role, row);
}

function ticketToHistoryRow(ticket, userId) {
  const role = ticketRoleFromKind(ticket.kind, ticket);
  const isEventTicket = ticket.kind === 'EVENT_TICKET' || ticket.kind === 'EVENT_ENTRANCE';
  return {
    id: `ticket-${ticket.id}`,
    userId,
    role,
    tableName: isEventTicket ? null : ticket.title,
    eventTitle: isEventTicket ? ticket.title : (ticket.subtitle || ticket.title),
    eventId: ticket.eventId,
    tableId: ticket.tableId,
    hostedTableId: ticket.hostedTableId,
    venueTableId: ticket.venueTableId,
    occurredAt: ticket.eventStartsAt || ticket.createdAt,
    ticketId: ticket.id,
  };
}

/**
 * Build event history items from issued tickets (QR-backed participation).
 * @param {string} userId
 */
export async function gatherTicketEventHistory(userId, hostedToVenue = null) {
  const tickets = await prisma.ticket.findMany({
    where: {
      userId,
      kind: { not: 'MENU_ADDON' },
      hiddenFromHistoryAt: null,
      refundedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      kind: true,
      title: true,
      subtitle: true,
      eventId: true,
      tableId: true,
      hostedTableId: true,
      venueTableId: true,
      createdAt: true,
      eventStartsAt: true,
    },
  });

  const byKey = new Map();
  for (const ticket of tickets) {
    const key = ticketHistoryKey(ticket, hostedToVenue);
    if (!byKey.has(key)) {
      byKey.set(key, ticketToHistoryRow(ticket, userId));
    }
  }
  return [...byKey.values()];
}

function synthRow(role, data) {
  return {
    id: null,
    userId: data.userId,
    role: role === 'HOST' ? 'HOST' : 'JOINED',
    tableName: data.tableName,
    eventTitle: data.eventTitle ?? null,
    eventId: data.eventId ?? null,
    tableId: data.tableId ?? null,
    hostedTableId: data.hostedTableId ?? null,
    venueTableId: data.venueTableId ?? null,
    occurredAt: data.occurredAt ?? new Date(),
  };
}

async function fetchLegacyJoinRows(userId) {
  try {
    return await prisma.$queryRaw`
      SELECT DISTINCT t.id, t.name, t.event_id AS "eventId", t.created_at AS "createdAt", e.title AS "eventTitle"
      FROM tables t
      INNER JOIN events e ON e.id = t.event_id
      WHERE t.deleted_at IS NULL
        AND t.host_user_id::text != ${userId}
        AND e.deleted_at IS NULL
        AND e.status = 'published'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(t.members::jsonb) = 'array' THEN t.members::jsonb
              ELSE '[]'::jsonb
            END
          ) AS elem
          WHERE elem #>> '{}' = ${userId}
             OR elem->>'user_id' = ${userId}
             OR elem->>'userId' = ${userId}
        )
    `;
  } catch (e) {
    logger?.warn?.('legacy table join history failed', { err: e?.message, userId });
    return [];
  }
}

/**
 * Build table history items from live DB participation (fills gaps in user_table_history).
 * @param {string} userId
 */
export async function gatherLiveTableParticipation(userId) {
  const [
    legacyHosted,
    hostedTables,
    venueHosted,
    hostedJoins,
    venueJoins,
    venueHostMembers,
    refundedHostMembers,
    legacyJoinRows,
  ] = await Promise.all([
    prisma.table.findMany({
      where: {
        hostUserId: userId,
        deletedAt: null,
        event: { deletedAt: null, status: 'published' },
      },
      select: { id: true, name: true, eventId: true, createdAt: true, event: { select: { title: true } } },
    }),
    prisma.hostedTable.findMany({
      where: { hostUserId: userId, status: { not: 'DRAFT' } },
      select: {
        id: true,
        tableName: true,
        venueTableId: true,
        eventId: true,
        createdAt: true,
        event: { select: { title: true } },
      },
    }),
    prisma.venueTable.findMany({
      where: { hostUserId: userId },
      select: {
        id: true,
        tableName: true,
        hostedTableId: true,
        eventId: true,
        createdAt: true,
        event: { select: { title: true } },
      },
    }),
    prisma.hostedTableMember.findMany({
      where: {
        userId,
        status: 'GOING',
        hostedTable: { NOT: { hostUserId: userId } },
      },
      select: {
        joinedAt: true,
        hostedTable: {
          select: { id: true, tableName: true, eventId: true, event: { select: { title: true } } },
        },
      },
    }),
    prisma.venueTableMember.findMany({
      where: {
        userId,
        status: { in: ['CONFIRMED', 'LEFT'] },
        venueTable: { NOT: { hostUserId: userId } },
      },
      select: {
        joinedAt: true,
        paidAt: true,
        venueTable: {
          select: { id: true, tableName: true, eventId: true, event: { select: { title: true } } },
        },
      },
    }),
    prisma.venueTableMember.findMany({
      where: {
        userId,
        memberRole: 'HOST',
        status: { in: ['CONFIRMED', 'LEFT'] },
      },
      select: {
        joinedAt: true,
        paidAt: true,
        bookingDate: true,
        windowStartTime: true,
        venueTable: {
          select: {
            id: true,
            tableName: true,
            eventId: true,
            hostedTableId: true,
            event: { select: { title: true } },
          },
        },
      },
    }),
    prisma.venueTableMember.findMany({
      where: { userId, memberRole: 'HOST', status: 'REFUNDED' },
      select: { venueTableId: true },
    }),
    fetchLegacyJoinRows(userId),
  ]);

  const refundedVenueIds = new Set(refundedHostMembers.map((m) => m.venueTableId).filter(Boolean));
  const items = [];

  for (const t of legacyHosted) {
    items.push(synthRow('HOST', {
      userId,
      tableId: t.id,
      eventId: t.eventId,
      tableName: t.name,
      eventTitle: t.event?.title || null,
      occurredAt: t.createdAt,
    }));
  }
  for (const ht of hostedTables) {
    if (ht.status === 'CLOSED' && ht.venueTableId && refundedVenueIds.has(ht.venueTableId)) {
      continue;
    }
    items.push(synthRow('HOST', {
      userId,
      hostedTableId: ht.id,
      venueTableId: ht.venueTableId || null,
      eventId: ht.eventId,
      tableName: ht.tableName,
      eventTitle: ht.event?.title || null,
      occurredAt: ht.createdAt,
    }));
  }
  for (const vt of venueHosted) {
    if (vt.hostedTableId) continue;
    items.push(synthRow('HOST', {
      userId,
      venueTableId: vt.id,
      eventId: vt.eventId,
      tableName: vt.tableName,
      eventTitle: vt.event?.title || null,
      occurredAt: vt.createdAt,
    }));
  }
  for (const m of hostedJoins) {
    const ht = m.hostedTable;
    items.push(synthRow('JOINED', {
      userId,
      hostedTableId: ht.id,
      eventId: ht.eventId,
      tableName: ht.tableName,
      eventTitle: ht.event?.title || null,
      occurredAt: m.joinedAt,
    }));
  }
  for (const m of venueJoins) {
    const vt = m.venueTable;
    items.push(synthRow('JOINED', {
      userId,
      venueTableId: vt.id,
      eventId: vt.eventId,
      tableName: vt.tableName,
      eventTitle: vt.event?.title || null,
      occurredAt: m.paidAt || m.joinedAt,
    }));
  }
  for (const m of venueHostMembers) {
    const vt = m.venueTable;
    if (!vt) continue;
    items.push(synthRow('HOST', {
      userId,
      venueTableId: vt.id,
      hostedTableId: vt.hostedTableId || null,
      eventId: vt.eventId,
      tableName: vt.tableName,
      eventTitle: vt.event?.title || null,
      occurredAt: hostParticipationOccurredAt(m, vt),
    }));
  }
  for (const row of legacyJoinRows || []) {
    items.push(synthRow('JOINED', {
      userId,
      tableId: row.id,
      eventId: row.eventId,
      tableName: row.name,
      eventTitle: row.eventTitle || null,
      occurredAt: row.createdAt,
    }));
  }

  return items;
}

/**
 * Merge persisted history with live participation; respect soft-deleted keys.
 * @param {object[]} persistedRows - user_table_history rows (visible only)
 * @param {Set<string>} hiddenKeys - participation keys user removed
 * @param {number} limit
 */
export async function mergeTableHistoryForUser(userId, persistedRows, hiddenKeys, limit = 20) {
  const allSeedRows = [...persistedRows];
  const { hostedToVenue, venueSlotNames } = await buildHostSessionContext(allSeedRows);

  const [liveResult, ticketResult] = await Promise.allSettled([
    gatherLiveTableParticipation(userId),
    gatherTicketEventHistory(userId, hostedToVenue),
  ]);

  const live = liveResult.status === 'fulfilled' ? liveResult.value : [];
  const ticketRows = ticketResult.status === 'fulfilled' ? ticketResult.value : [];
  const mergedContext = await buildHostSessionContext([...allSeedRows, ...live, ...ticketRows]);
  const ctxHostedToVenue = mergedContext.hostedToVenue;
  const ctxVenueSlotNames = mergedContext.venueSlotNames;

  if (liveResult.status === 'rejected') {
    logger?.warn?.('gatherLiveTableParticipation failed', {
      err: liveResult.reason?.message,
      userId,
    });
  }
  if (ticketResult.status === 'rejected') {
    logger?.warn?.('gatherTicketEventHistory failed', {
      err: ticketResult.reason?.message,
      userId,
    });
  }

  const byKey = new Map();
  const byCanonical = new Set();
  const coveredEventIds = new Set();

  const rememberEvent = (row) => {
    if (row.eventId) coveredEventIds.add(row.eventId);
  };

  for (const row of persistedRows) {
    if (tryAddHistoryRow(byKey, byCanonical, hiddenKeys, row, ctxHostedToVenue)) {
      rememberEvent(row);
    }
  }

  for (const row of live) {
    if (tryAddHistoryRow(byKey, byCanonical, hiddenKeys, row, ctxHostedToVenue)) {
      rememberEvent(row);
    }
  }

  for (const row of ticketRows) {
    if (row.role === 'ATTENDED' && row.eventId && coveredEventIds.has(row.eventId)) {
      continue;
    }
    if (tryAddHistoryRow(byKey, byCanonical, hiddenKeys, row, ctxHostedToVenue)) {
      rememberEvent(row);
    }
  }

  const merged = [...byKey.values()].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  );

  return merged.slice(0, limit).map((row) => {
    const tableName = resolveVenueSlotNameForHistory(row, ctxHostedToVenue, ctxVenueSlotNames);
    const normalized = { ...row, tableName };
    if (row.id) return { ...mapTableHistoryRow(normalized), tableName };
    return {
      ...mapTableHistoryRow(normalized),
      id: `synth-${rowParticipationKey(normalized, ctxHostedToVenue)}`,
      tableName,
    };
  });
}

const STATS_MERGE_LIMIT = 500;

/**
 * Distinct hosted/joined table counts aligned with Activity event history sources.
 * @param {string} userId
 */
export async function countParticipationStats(userId) {
  const [persistedRows, hiddenRows] = await Promise.all([
    prisma.userTableHistory.findMany({
      where: { userId, hiddenAt: null },
    }),
    prisma.userTableHistory.findMany({
      where: { userId, hiddenAt: { not: null } },
      select: { role: true, tableId: true, hostedTableId: true, venueTableId: true },
    }),
  ]);

  const hiddenKeys = new Set(hiddenRows.map((r) => participationKey(r.role, r)));
  const items = await mergeTableHistoryForUser(userId, persistedRows, hiddenKeys, STATS_MERGE_LIMIT);

  const hostKeys = new Set();
  const joinedKeys = new Set();

  for (const item of items) {
    if (item.role === 'host') {
      hostKeys.add(participationKey('HOST', item));
    } else if (item.role === 'joined') {
      joinedKeys.add(participationKey('JOINED', item));
    }
  }

  return {
    tablesHosted: hostKeys.size,
    tablesJoined: joinedKeys.size,
  };
}
