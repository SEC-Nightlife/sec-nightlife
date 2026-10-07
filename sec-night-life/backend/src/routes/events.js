import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import {
  applyEventVenueIsolation,
  isStaff,
  staffHasVenuePermission,
  resolveAccessibleVenueIds,
  resolveBusinessVenueScope,
  staffCtxFromQuery,
  venueIdFromQuery,
} from '../lib/access.js';
import { ensureGroupChatForEvent } from '../lib/groupChatHelpers.js';
import { logger } from '../lib/logger.js';
import { normalizeHostingConfig, mergeHostingConfigPatch } from '../lib/hostingConfig.js';
import { eventEndsAtFromEvent, eventHasEnded, eventStartsAtFromEvent } from '../lib/ticketHelpers.js';
import { syncEventVenueTables } from '../lib/syncEventVenueTables.js';
import { buildEventTableTiers, statsFromEventTableTiers } from '../lib/eventTableTiers.js';
import { resolveEventSeatingPlans, getVenueDefaultSeatingPlan, attachGuestSeatingPlans } from '../lib/seatingPlanHelpers.js';
import { normalizeTicketTiers } from '../lib/issueEventTickets.js';
import { ticketTiersAllowMenuAddons } from '../lib/ticketCheckout.js';
import { countUserEventTicketsByTier } from '../lib/ticketTierCaps.js';
import {
  assertEventCodeUniqueForVenue,
  normalizeEventCodeInput,
  validateEventCodeFormat,
} from '../lib/eventCode.js';
import { buildPaystackInitializeBody } from '../lib/paystackInitialize.js';
import {
  FEED_BOOST_ZAR_PER_DAY,
  clampBoostDays,
  maxBoostDaysUntil,
} from '../lib/feedBoost.js';
import crypto from 'crypto';

const router = Router();

const timeHHMM = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.union([z.string().regex(/^\d{2}:\d{2}$/), z.null()]).optional()
);
const optionalNonEmptyString = (max = 300) =>
  z.preprocess((v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') return v;
    const t = v.trim();
    return t === '' ? undefined : t;
  }, z.string().min(1).max(max).optional());

const includedItemSchema = z.object({
  menu_item_id: z.string().min(1),
  quantity: z.number().int().min(1).max(99),
});

const tablePricingTierSchema = z.object({
  tier_name: z.string().min(1).max(80).optional(),
  max_guests: z.number().int().min(1).max(500),
  min_spend: z.number().min(0).optional(),
  min_spend_join: z.number().min(0).optional(),
  min_spend_host: z.number().min(0).optional(),
  booking_fee_zar: z.number().min(0).optional(),
  host_table_fee_zar: z.number().min(0).optional(),
  /** Per-tier hosted-table slots; required when tiers exist (enforced in hostingCategorySchema). */
  tier_table_slots: z.number().int().min(1).optional(),
  included_items: z.array(includedItemSchema).optional(),
});

const hostingCategorySchema = z
  .object({
    max_tables: z.number().int().min(1).optional().nullable(),
    tiers: z.array(tablePricingTierSchema).optional().nullable(),
    host_table_fee_zar: z.number().min(0).optional().nullable(),
    allows_custom_requests: z.boolean().optional(),
  })
  .superRefine((cat, ctx) => {
    const tiers = cat.tiers;
    if (!tiers || tiers.length === 0) return;
    if (cat.max_tables == null || !Number.isFinite(Number(cat.max_tables))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Max hosted tables is required when pricing tiers are configured.',
        path: ['max_tables'],
      });
      return;
    }
    const maxT = Number(cat.max_tables);
    let sum = 0;
    for (let i = 0; i < tiers.length; i++) {
      const slots = tiers[i]?.tier_table_slots;
      if (slots == null || !Number.isFinite(Number(slots))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Hosted table slots are required for each tier when tiers are configured.',
          path: ['tiers', i, 'tier_table_slots'],
        });
        continue;
      }
      sum += Number(slots);
    }
    if (sum !== maxT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Tier table counts must add up to max hosted tables (${maxT}). Current sum: ${sum}.`,
        path: ['tiers'],
      });
    }
  });

const hostingConfigSchema = z.object({
  general: hostingCategorySchema.optional(),
  vip: hostingCategorySchema.optional(),
});

/** Full merged hosting_config (e.g. after PATCH merge). Same rules as hostingCategorySchema superRefine. */
function validateMergedHostingConfigTierSlots(raw) {
  const h = normalizeHostingConfig(raw);
  for (const cat of ['general', 'vip']) {
    const sec = h[cat];
    const tiers = Array.isArray(sec?.tiers) ? sec.tiers : [];
    if (tiers.length === 0) continue;
    if (sec.max_tables == null || !Number.isFinite(Number(sec.max_tables))) {
      return {
        error: `Hosting (${cat}): max hosted tables is required when pricing tiers are configured.`,
      };
    }
    const maxT = Number(sec.max_tables);
    let sum = 0;
    for (let i = 0; i < tiers.length; i++) {
      const slots = tiers[i]?.tier_table_slots;
      if (slots == null || !Number.isFinite(Number(slots))) {
        return {
          error: `Hosting (${cat}): hosted table slots are required for each tier when tiers are configured.`,
        };
      }
      sum += Number(slots);
    }
    if (sum !== maxT) {
      return {
        error: `Hosting (${cat}): tier table counts must add up to max hosted tables (${maxT}). Current sum: ${sum}.`,
      };
    }
  }
  return null;
}

async function assertHostingTierSlotsVsUsage(eventId, mergedHostingRaw) {
  const h = normalizeHostingConfig(mergedHostingRaw);
  for (const cat of ['general', 'vip']) {
    const prismaCat = cat === 'vip' ? 'VIP' : 'GENERAL';
    const tiers = Array.isArray(h[cat]?.tiers) ? h[cat].tiers : [];
    for (let i = 0; i < tiers.length; i++) {
      const newSlots = tiers[i]?.tier_table_slots;
      if (newSlots == null || !Number.isFinite(Number(newSlots))) continue;
      const used = await prisma.hostedTable.count({
        where: {
          eventId,
          hostingCategory: prismaCat,
          hostingTierIndex: i,
          status: { not: 'CLOSED' },
        },
      });
      if (Number(newSlots) < used) {
        const label = tiers[i]?.tier_name != null ? String(tiers[i].tier_name) : `tier ${i + 1}`;
        return {
          error: `Hosting (${cat}): "${label}" cannot go below ${used} hosted tables (already listed).`,
        };
      }
    }
  }
  return null;
}

const eventFields = {
  venue_id: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().optional(),
  date: z.string(),
  city: optionalNonEmptyString(120),
  location_address: optionalNonEmptyString(500),
  location_city: optionalNonEmptyString(120),
  location_suburb: optionalNonEmptyString(120),
  location_province: optionalNonEmptyString(120),
  status: z.enum(['draft', 'published']).default('draft'),
  is_featured: z.boolean().optional(),
  cover_image_url: z
    .preprocess((v) => (v === '' || v === undefined ? null : v), z.string().max(4000).nullable().optional()),
  banner_url: z.string().url().optional().nullable(),
  ticket_tiers: z.any().optional(),
  start_time: timeHHMM,
  ends_at: z.preprocess((v) => (v === '' || v === undefined ? undefined : v), z.string().optional()),
  has_entrance_fee: z.boolean().optional(),
  entrance_fee_amount: z.number().min(0).optional().nullable(),
  // Frontend sends null for TICKETING_ONLY (no table hosting). Zod .optional() alone rejects null.
  hosting_config: hostingConfigSchema.nullable().optional(),
  event_format: z.enum(['TABLE_HOSTING', 'TICKETING_ONLY']).optional(),
  allows_ticket_menu_addons: z.boolean().optional(),
  event_code: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().max(32).nullable().optional(),
  ),
  show_seating_plan: z.boolean().optional(),
  seating_plan_id: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().uuid().nullable().optional(),
  ),
};

const eventSchema = z.object(eventFields);
const eventCreateSchema = eventSchema.extend({ venue_id: z.string().uuid().optional() });

async function resolveEventSeatingPlanFields(venueId, showSeatingPlan, seatingPlanId) {
  if (!showSeatingPlan) {
    return { showSeatingPlan: false, seatingPlanId: null };
  }
  if (seatingPlanId) {
    const plan = await prisma.venueSeatingPlan.findFirst({
      where: { id: seatingPlanId, venueId },
    });
    if (!plan) return { error: 'Seating plan not found for this venue' };
    return { showSeatingPlan: true, seatingPlanId: plan.id };
  }
  const defaultPlan = await getVenueDefaultSeatingPlan(venueId);
  if (!defaultPlan) {
    return { error: 'Upload at least one seating plan for this venue before enabling this option.' };
  }
  return { showSeatingPlan: true, seatingPlanId: defaultPlan.id };
}

function mapEventRow(e) {
  const resolvedLocationCity = e.locationCity || e.city;
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    date: e.date.toISOString().slice(0, 10),
    city: e.city,
    location_address: e.locationAddress || null,
    location_city: resolvedLocationCity || null,
    location_suburb: e.locationSuburb || null,
    location_province: e.locationProvince || null,
    venue_id: e.venueId,
    status: e.status,
    is_featured: e.isFeatured,
    boosted: Boolean(e.boosted) && (!e.boostExpiresAt || new Date(e.boostExpiresAt) > new Date()),
    boosted_at: e.boostedAt ? e.boostedAt.toISOString() : null,
    boost_expires_at: e.boostExpiresAt ? e.boostExpiresAt.toISOString() : null,
    cover_image_url: e.coverImageUrl,
    ticket_tiers: e.ticketTiers,
    start_time: e.startTime,
    ends_at: e.endsAt ? e.endsAt.toISOString() : null,
    has_entrance_fee: e.hasEntranceFee,
    entrance_fee_amount: e.entranceFeeAmount,
    hosting_config: normalizeHostingConfig(e.hostingConfig),
    event_format: e.eventFormat || 'TABLE_HOSTING',
    allows_ticket_menu_addons: Boolean(e.allowsTicketMenuAddons),
    event_code: e.eventCode || null,
    show_seating_plan: Boolean(e.showSeatingPlan),
    seating_plan_id: e.seatingPlanId || null,
  };
}

function validateTicketTiersForPublish(ticketTiers) {
  const tiers = Array.isArray(ticketTiers) ? ticketTiers : [];
  if (tiers.length === 0) {
    return { ok: false, error: 'Add at least one ticket tier to publish a ticketed event.' };
  }
  for (const t of tiers) {
    if (!String(t?.name || '').trim()) {
      return { ok: false, error: 'Each ticket tier needs a name.' };
    }
    const price = Number(t?.price);
    const qty = Number(t?.quantity);
    if (!Number.isFinite(price) || price < 0) {
      return { ok: false, error: 'Each ticket tier needs a valid price.' };
    }
    if (!Number.isFinite(qty) || qty < 1) {
      return { ok: false, error: 'Each ticket tier needs available quantity of at least 1.' };
    }
    const rawCap = t?.max_per_user;
    if (rawCap != null && rawCap !== '' && Number(rawCap) !== 0) {
      const cap = Number(rawCap);
      if (!Number.isInteger(cap) || cap < 1) {
        return { ok: false, error: 'Max tickets per guest must be a whole number of at least 1, or left blank.' };
      }
      if (cap > qty) {
        return { ok: false, error: 'Max tickets per guest cannot exceed that tier’s available quantity.' };
      }
    }
  }
  return { ok: true };
}

async function followedVenueIdSet(userId) {
  if (!userId) return new Set();
  const rows = await prisma.venueFollow.findMany({
    where: { userId },
    select: { venueId: true },
  });
  return new Set(rows.map((r) => r.venueId));
}

/** When logged in, followed venues first; within each group order by event date. */
function sortEventsByFollowThenDate(events, followedSet, sortDesc) {
  return [...events].sort((a, b) => {
    const ap = followedSet.has(a.venueId) ? 0 : 1;
    const bp = followedSet.has(b.venueId) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const at = a.date.getTime();
    const bt = b.date.getTime();
    return sortDesc ? bt - at : at - bt;
  });
}

function computeCategoryTableStats(rows, maxTables) {
  const hosted = rows.length;
  const tablesRemaining = maxTables != null ? Math.max(0, maxTables - hosted) : null;

  const isFull = (t) => t.status === 'full' || t.currentGuests >= t.maxGuests;
  const hasJoinSpace = (t) => t.isPublic && !isFull(t);

  let tablesFull = 0;
  let tablesFullPublic = 0;
  let tablesFullPrivate = 0;
  let tablesWithJoinSpace = 0;
  for (const t of rows) {
    const full = isFull(t);
    if (full) {
      tablesFull++;
      if (t.isPublic) tablesFullPublic++;
      else tablesFullPrivate++;
    }
    if (hasJoinSpace(t)) tablesWithJoinSpace++;
  }

  return {
    hosted_tables: hosted,
    tables_remaining: tablesRemaining,
    tables_full: tablesFull,
    tables_full_public: tablesFullPublic,
    tables_full_private: tablesFullPrivate,
    tables_with_join_space: tablesWithJoinSpace,
  };
}

function validateHostingTierSlotsConfig(hostingRaw) {
  const hosting = normalizeHostingConfig(hostingRaw);
  for (const cat of ['general', 'vip']) {
    const slot = hosting?.[cat] || {};
    const tiers = Array.isArray(slot.tiers) ? slot.tiers : [];
    if (tiers.length === 0) continue;
    const maxTables = slot.max_tables != null ? Number(slot.max_tables) : null;
    if (!Number.isFinite(maxTables) || maxTables < 1) {
      return {
        ok: false,
        error: `${cat === 'vip' ? 'VIP' : 'General'} max hosted tables is required when tiers are configured.`,
      };
    }
    let sum = 0;
    for (const t of tiers) {
      const slots = t?.tier_table_slots;
      const n = Number(slots);
      if (!Number.isFinite(n) || n < 1) {
        return {
          ok: false,
          error: `${cat === 'vip' ? 'VIP' : 'General'} tiers must each set hosted table slots (minimum 1).`,
        };
      }
      sum += n;
    }
    if (sum !== maxTables) {
      return {
        ok: false,
        error: `${cat === 'vip' ? 'VIP' : 'General'} tier table counts must add up to max hosted tables (${maxTables}). Current sum: ${sum}.`,
      };
    }
  }
  return { ok: true };
}

async function assertTierSlotsNotBelowCurrentHostedTables(eventId, hostingRaw) {
  const hosting = normalizeHostingConfig(hostingRaw);
  for (const cat of ['general', 'vip']) {
    const tiers = Array.isArray(hosting?.[cat]?.tiers) ? hosting[cat].tiers : [];
    if (tiers.length === 0) continue;
    for (let idx = 0; idx < tiers.length; idx++) {
      const slots = Number(tiers[idx]?.tier_table_slots);
      if (!Number.isFinite(slots) || slots < 1) continue;
      const tierKey = `${cat}:${idx}`;
      const used = await prisma.venueTable.count({
        where: {
          eventId,
          hostingTierKey: { startsWith: `${tierKey}:` },
          isActive: true,
          currentOccupancy: { gt: 0 },
        },
      });
      if (used > slots) {
        return {
          ok: false,
          error: `${cat === 'vip' ? 'VIP' : 'General'} tier ${idx + 1} has ${used} active booking(s), which exceeds new allocation (${slots}).`,
        };
      }
    }
  }
  return { ok: true };
}

async function validateHostingMenuItems(venueId, hostingRaw) {
  const hosting = normalizeHostingConfig(hostingRaw);
  const menuIds = new Set(
    (
      await prisma.venueMenuItem.findMany({
        where: { venueId, isAvailable: true },
        select: { id: true },
      })
    ).map((m) => m.id),
  );
  for (const cat of ['general', 'vip']) {
    const tiers = Array.isArray(hosting?.[cat]?.tiers) ? hosting[cat].tiers : [];
    for (const t of tiers) {
      const items = Array.isArray(t?.included_items) ? t.included_items : [];
      for (const inc of items) {
        const id = inc?.menu_item_id;
        if (id && !menuIds.has(id)) {
          return { ok: false, error: 'Included menu item must belong to your venue menu.' };
        }
      }
    }
  }
  return { ok: true };
}

function mapHostedTableToStatRow(ht) {
  const gq = Math.max(1, Number(ht.guestQuantity) || 1);
  const spots = Number(ht.spotsRemaining);
  const spotsRem = Number.isFinite(spots) ? spots : gq;
  const currentGuests = Math.max(0, gq - spotsRem);
  const isFull = ht.status === 'FULL' || spotsRem <= 0;
  const cat = ht.hostingCategory === 'VIP' ? 'vip' : 'general';
  return {
    status: isFull ? 'full' : 'active',
    maxGuests: gq,
    currentGuests,
    isPublic: ht.isPublic,
    tableCategory: cat,
  };
}

async function computeEventStats(eventId, hostingRaw, opts = {}) {
  const hosting = normalizeHostingConfig(hostingRaw);
  const goingCountPromise =
    opts.goingCount != null
      ? Promise.resolve(opts.goingCount)
      : prisma.eventAttendance.count({ where: { eventId, confirmed: true } });
  const hasVenueTiers =
    (Array.isArray(hosting?.general?.tiers) && hosting.general.tiers.length > 0) ||
    (Array.isArray(hosting?.vip?.tiers) && hosting.vip.tiers.length > 0);

  if (hasVenueTiers) {
    const [goingCount, tierPayload] = await Promise.all([
      goingCountPromise,
      buildEventTableTiers(eventId),
    ]);
    const tiers = tierPayload?.tiers || [];
    const tableStats = statsFromEventTableTiers(tiers);
    return {
      going_count: goingCount,
      hosted_tables: tableStats.hosted_tables,
      general: {
        tables_remaining: tableStats.general.tables_remaining,
        tables_with_join_space: tableStats.general.tables_with_join_space,
        tables_full: tableStats.general.tables_full,
      },
      vip: {
        tables_remaining: tableStats.vip.tables_remaining,
        tables_with_join_space: tableStats.vip.tables_with_join_space,
        tables_full: tableStats.vip.tables_full,
      },
    };
  }

  const [goingCount, tableRows, hostedSecRows] = await Promise.all([
    goingCountPromise,
    prisma.table.findMany({
      where: { eventId, deletedAt: null },
      select: {
        status: true,
        maxGuests: true,
        currentGuests: true,
        isPublic: true,
        tableCategory: true,
      },
    }),
    prisma.hostedTable.findMany({
      where: {
        eventId,
        tableType: 'IN_APP_EVENT',
        status: { in: ['ACTIVE', 'FULL'] },
      },
      select: {
        status: true,
        guestQuantity: true,
        spotsRemaining: true,
        isPublic: true,
        hostingCategory: true,
      },
    }),
  ]);

  const hostedMapped = hostedSecRows.map(mapHostedTableToStatRow);
  const legacyGeneral = tableRows.filter((t) => t.tableCategory === 'general');
  const legacyVip = tableRows.filter((t) => t.tableCategory === 'vip');
  const hostedGeneral = hostedMapped.filter((t) => t.tableCategory === 'general');
  const hostedVip = hostedMapped.filter((t) => t.tableCategory === 'vip');

  const generalRows = [...legacyGeneral, ...hostedGeneral];
  const vipRows = [...legacyVip, ...hostedVip];

  const generalStats = computeCategoryTableStats(generalRows, hosting.general.max_tables);
  const vipStats = computeCategoryTableStats(vipRows, hosting.vip.max_tables);

  return {
    going_count: goingCount,
    hosted_tables: tableRows.length + hostedSecRows.length,
    general: generalStats,
    vip: vipStats,
  };
}

function mapEventDetail(event, stats = null) {
  const v = event.venue;
  const resolvedLocationCity = event.locationCity || event.city || v?.city || null;
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    date: event.date.toISOString().slice(0, 10),
    city: event.city,
    location_address: event.locationAddress || v?.address || null,
    location_city: resolvedLocationCity,
    location_suburb: event.locationSuburb || v?.suburb || null,
    location_province: event.locationProvince || v?.province || null,
    venue_id: event.venueId,
    status: event.status,
    is_featured: event.isFeatured,
    boosted:
      Boolean(event.boosted) &&
      (!event.boostExpiresAt || new Date(event.boostExpiresAt) > new Date()),
    boosted_at: event.boostedAt ? event.boostedAt.toISOString() : null,
    boost_expires_at: event.boostExpiresAt ? event.boostExpiresAt.toISOString() : null,
    cover_image_url: event.coverImageUrl,
    banner_url: event.bannerUrl,
    ticket_tiers: event.ticketTiers,
    start_time: event.startTime,
    ends_at: event.endsAt ? event.endsAt.toISOString() : null,
    has_entrance_fee: event.hasEntranceFee,
    entrance_fee_amount: event.entranceFeeAmount,
    hosting_config: normalizeHostingConfig(event.hostingConfig),
    event_format: event.eventFormat || 'TABLE_HOSTING',
    allows_ticket_menu_addons: Boolean(event.allowsTicketMenuAddons),
    venue_name: v?.name ?? null,
    venue_address: v?.address ?? null,
    venue_city: v?.city ?? null,
    venue_suburb: v?.suburb ?? null,
    venue_province: v?.province ?? null,
    ...(stats ? { stats } : {}),
    total_attending: stats?.going_count ?? 0,
  };
}

function mergePublishedNotEnded(where, now, { includeEnded = false } = {}) {
  if (includeEnded) return where;
  if (where.status === 'published') {
    return { ...where, endsAt: { gte: now } };
  }
  return where;
}

function venueIdFromEventQuery(query = {}) {
  return (
    venueIdFromQuery(query) ||
    (typeof query.venue_id === 'string' && query.venue_id.trim()) ||
    (Array.isArray(query.venue_id) ? String(query.venue_id[0] || '').trim() : '') ||
    ''
  );
}

function includeEndedFromQuery(query = {}) {
  const raw = String(query.include_ended ?? query.includeEnded ?? '').toLowerCase();
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  const eventScope = String(query.event_scope || 'all').toLowerCase();
  if (eventScope === 'past') return true;
  // Venue Profile (and older clients) list published events by venue without include_ended.
  const status = String(query.status || '');
  return Boolean(venueIdFromEventQuery(query)) && status === 'published';
}

/** Public venue catalogs must not use business isolation — owners viewing another venue were getting 404. */
function shouldIsolateEventList(req) {
  if (!req?.userId) return false;
  if (staffCtxFromQuery(req.query)) return true;
  const status = String(req.query?.status || '');
  const venueId = venueIdFromEventQuery(req.query);
  if (venueId && status === 'published') return false;
  return true;
}

async function loadAttendanceCountsByEventIds(eventIds) {
  const ids = [...new Set((eventIds || []).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const [going, tickets, admitted] = await Promise.all([
    prisma.eventAttendance.groupBy({
      by: ['eventId'],
      where: { eventId: { in: ids }, confirmed: true },
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ['eventId'],
      where: {
        eventId: { in: ids },
        kind: { not: 'MENU_ADDON' },
        refundedAt: null,
        hiddenFromHistoryAt: null,
      },
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ['eventId'],
      where: {
        eventId: { in: ids },
        kind: { not: 'MENU_ADDON' },
        refundedAt: null,
        hiddenFromHistoryAt: null,
        admittedAt: { not: null },
      },
      _count: { _all: true },
    }),
  ]);
  const goingMap = new Map(going.map((r) => [r.eventId, r._count._all]));
  const ticketMap = new Map(tickets.map((r) => [r.eventId, r._count._all]));
  const admittedMap = new Map(admitted.map((r) => [r.eventId, r._count._all]));
  for (const id of ids) {
    const goingCount = goingMap.get(id) || 0;
    const ticketsSold = ticketMap.get(id) || 0;
    const admittedCount = admittedMap.get(id) || 0;
    map.set(id, {
      going_count: goingCount,
      tickets_sold: ticketsSold,
      admitted_count: admittedCount,
      attendee_count: admittedCount > 0 ? admittedCount : Math.max(goingCount, ticketsSold),
    });
  }
  return map;
}

function withListAttendance(mapped, counts) {
  const c = counts.get(mapped.id) || {
    going_count: 0,
    tickets_sold: 0,
    admitted_count: 0,
    attendee_count: 0,
  };
  return { ...mapped, ...c };
}

async function mapEventRowsWithOptionalAttendance(events, { withAttendance = false } = {}) {
  const mapped = (events || []).map(mapEventRow);
  if (!withAttendance || !mapped.length) return mapped;
  try {
    const counts = await loadAttendanceCountsByEventIds(mapped.map((e) => e.id));
    return mapped.map((e) => withListAttendance(e, counts));
  } catch (err) {
    logger.warn('event attendance counts failed', { err: err?.message });
    return mapped;
  }
}

async function applyOwnedOrStaffEventIsolation(req, where) {
  if (!req.userId) return;
  const staffCtx = staffCtxFromQuery(req.query);
  if (staffCtx) {
    const scope = await resolveBusinessVenueScope(req.userId, {
      staffCtx,
      permission: 'events',
    });
    if (!scope.ok) {
      const err = new Error(scope.error || 'Forbidden');
      err.status = scope.status || 403;
      throw err;
    }
    if (scope.venueIds[0]) where.venueId = scope.venueIds[0];
    return;
  }
  const accessible = await resolveAccessibleVenueIds(req.userId);
  if (!accessible.length) return;
  if (req.query.venue_id) {
    const scope = await resolveBusinessVenueScope(req.userId, {
      venueIdFilter: venueIdFromQuery(req.query),
      permission: 'events',
    });
    if (!scope.ok) {
      const err = new Error(scope.error || 'Forbidden');
      err.status = scope.status || 403;
      throw err;
    }
    if (scope.venueIds[0]) where.venueId = scope.venueIds[0];
    return;
  }
  await applyEventVenueIsolation(where, req.userId, req.userRole, req.query.venue_id || null);
}

router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const now = new Date();
    const where = { deletedAt: null };
    if (req.query.status) where.status = req.query.status;
    if (req.query.venue_id) {
      const venueIdRaw = venueIdFromQuery(req.query)
        || (Array.isArray(req.query.venue_id) ? req.query.venue_id[0] : req.query.venue_id);
      if (typeof venueIdRaw === 'string' && venueIdRaw.trim()) where.venueId = venueIdRaw.trim();
    }
    if (req.query.city) where.city = String(req.query.city);
    if (req.query.id) where.id = req.query.id;
    const eventFormatQ = String(req.query.event_format || '').trim().toUpperCase();
    if (eventFormatQ === 'TICKETING_ONLY' || eventFormatQ === 'TABLE_HOSTING') {
      where.eventFormat = eventFormatQ;
    }
    const searchQ = String(req.query.q || req.query.search || '').trim();
    if (searchQ) {
      where.title = { contains: searchQ, mode: 'insensitive' };
    }
    const eventScope = String(req.query.event_scope || 'all').toLowerCase();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    if (eventScope === 'active') {
      where.date = { gte: todayStart };
    } else if (eventScope === 'past') {
      where.date = { lt: todayStart };
    }
    if (shouldIsolateEventList(req)) {
      await applyOwnedOrStaffEventIsolation(req, where);
    }
    const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const sortDesc = req.query.sort === '-date';
    const paginated = String(req.query.paginated || '') === '1' || req.query.skip != null;
    const followedSet = await followedVenueIdSet(req.userId);
    const includeEnded = includeEndedFromQuery(req.query);
    const whereMerged = mergePublishedNotEnded(where, now, { includeEnded });

    if (paginated) {
      const [total, events] = await Promise.all([
        prisma.event.count({ where: whereMerged }),
        prisma.event.findMany({
          where: whereMerged,
          orderBy: { date: sortDesc ? 'desc' : 'asc' },
          skip,
          take,
        }),
      ]);
      const items = await mapEventRowsWithOptionalAttendance(events, { withAttendance: includeEnded });
      return res.json({
        items,
        total,
        hasMore: skip + events.length < total,
        skip,
        limit: take,
      });
    }

    const fetchCap = req.userId && followedSet.size > 0 ? Math.min(take * 15, 500) : take;
    const events = await prisma.event.findMany({
      where: whereMerged,
      orderBy: { date: sortDesc ? 'desc' : 'asc' },
      take: fetchCap,
    });
    const ordered =
      req.userId && followedSet.size > 0
        ? sortEventsByFollowThenDate(events, followedSet, sortDesc).slice(0, take)
        : events;
    res.json(await mapEventRowsWithOptionalAttendance(ordered, { withAttendance: includeEnded }));
  } catch (err) {
    next(err);
  }
});

/** Grouped table tiers for Event Details (host/join flows). */
router.get('/:id/table-tiers', optionalAuth, async (req, res, next) => {
  try {
    const result = await buildEventTableTiers(req.params.id);
    if (!result) return res.status(404).json({ error: 'Event not found' });
    const eventRow = await prisma.event.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { date: true, startTime: true, endsAt: true, status: true },
    });
    const ended = eventHasEnded(eventRow);
    const seatingPlans = await resolveEventSeatingPlans(req.params.id);
    res.json({
      ...attachGuestSeatingPlans(result, seatingPlans),
      ended,
    });
  } catch (err) {
    next(err);
  }
});

/** Preview standalone entrance (+ optional menu) checkout for table-hosting events. */
router.post('/:id/entrance-checkout-preview', authenticateToken, async (req, res, next) => {
  try {
    const { computeEventEntranceCheckout } = await import('../lib/issueEventEntrance.js');
    const { userHasPaidEventEntrance } = await import('../lib/entranceCheckout.js');
    const already = await userHasPaidEventEntrance(req.userId, req.params.id);
    if (already) {
      return res.status(400).json({ error: 'You already have an entrance pass for this event.' });
    }
    const selectedMenuItems = Array.isArray(req.body?.selectedMenuItems)
      ? req.body.selectedMenuItems
      : [];
    const computed = await computeEventEntranceCheckout(prisma, {
      eventId: req.params.id,
      selectedMenuItems,
      allowFreeClaim: true,
    });
    if (!computed.ok) return res.status(400).json({ error: computed.error });
    res.json({
      entrance_zar: computed.entranceZar,
      menu_zar: computed.menuZar,
      subtotal: computed.subtotal,
      service_fee: computed.serviceFee,
      total: computed.total,
      platform_fee: computed.platformFee,
      venue_share: computed.venueShare,
      lines: computed.lines,
      menu_items: computed.menuItems,
    });
  } catch (err) {
    next(err);
  }
});

const claimFreeTicketSchema = z.object({
  ticket_tier_name: z.string().min(1).max(120),
  quantity: z.coerce.number().int().min(1).max(10).optional().default(1),
  holder_names: z.union([z.array(z.string().max(120)), z.string().max(2000)]).optional(),
  selected_menu_items: z
    .array(
      z.object({
        menuItemId: z.string().min(1).optional(),
        menu_item_id: z.string().min(1).optional(),
        quantity: z.coerce.number().int().min(0).optional(),
      }),
    )
    .optional()
    .default([]),
  promoter_user_id: z.string().min(1).max(64).optional().nullable(),
});

/** Claim R0 event tickets and issue QR passes (no Paystack). */
router.post('/:id/claim-free-ticket', authenticateToken, async (req, res, next) => {
  try {
    const parsed = claimFreeTicketSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
    const d = parsed.data;
    let holderNames = d.holder_names;
    if (typeof holderNames === 'string') {
      try {
        holderNames = JSON.parse(holderNames);
      } catch {
        holderNames = [];
      }
    }
    const selectedMenuItems = (d.selected_menu_items || []).map((m) => ({
      menuItemId: m.menuItemId || m.menu_item_id,
      quantity: m.quantity,
    }));
    const { claimFreeEventTickets } = await import('../lib/claimFreeEventPass.js');
    const result = await claimFreeEventTickets({
      eventId: req.params.id,
      userId: req.userId,
      email: req.user?.email || null,
      ticketTierName: d.ticket_tier_name,
      quantity: d.quantity,
      holderNames: Array.isArray(holderNames) ? holderNames : [],
      selectedMenuItems,
      promoterUserId: d.promoter_user_id || null,
    });
    if (!result.ok) {
      return res.status(result.status || 400).json({
        error: result.error,
        ...(result.expected_zar != null ? { expected_zar: result.expected_zar } : {}),
      });
    }
    res.json({
      confirmed: true,
      reference: result.reference,
      quantity: result.quantity,
      tickets_issued: result.tickets_issued,
    });
  } catch (err) {
    next(err);
  }
});

const claimFreeEntranceSchema = z.object({
  selected_menu_items: z
    .array(
      z.object({
        menuItemId: z.string().min(1).optional(),
        menu_item_id: z.string().min(1).optional(),
        quantity: z.coerce.number().int().min(0).optional(),
      }),
    )
    .optional()
    .default([]),
  selectedMenuItems: z
    .array(
      z.object({
        menuItemId: z.string().min(1).optional(),
        menu_item_id: z.string().min(1).optional(),
        quantity: z.coerce.number().int().min(0).optional(),
      }),
    )
    .optional(),
  promoter_user_id: z.string().min(1).max(64).optional().nullable(),
});

/** Claim R0 entrance pass and issue QR (no Paystack). */
router.post('/:id/claim-free-entrance', authenticateToken, async (req, res, next) => {
  try {
    const parsed = claimFreeEntranceSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
    const d = parsed.data;
    const rawMenu = d.selected_menu_items?.length ? d.selected_menu_items : d.selectedMenuItems || [];
    const selectedMenuItems = rawMenu.map((m) => ({
      menuItemId: m.menuItemId || m.menu_item_id,
      quantity: m.quantity,
    }));
    const { claimFreeEventEntrance } = await import('../lib/claimFreeEventPass.js');
    const result = await claimFreeEventEntrance({
      eventId: req.params.id,
      userId: req.userId,
      email: req.user?.email || null,
      selectedMenuItems,
      promoterUserId: d.promoter_user_id || null,
    });
    if (!result.ok) {
      return res.status(result.status || 400).json({
        error: result.error,
        ...(result.expected_zar != null ? { expected_zar: result.expected_zar } : {}),
      });
    }
    res.json({
      confirmed: true,
      reference: result.reference,
      tickets_issued: result.tickets_issued,
    });
  } catch (err) {
    next(err);
  }
});

/** Public summary of SEC hosted tables for an event (event details page). */
router.get('/:id/hosted-tables-summary', optionalAuth, async (req, res, next) => {
  try {
    const event = await prisma.event.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true },
    });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const rows = await prisma.hostedTable.findMany({
      where: {
        eventId: req.params.id,
        tableType: 'IN_APP_EVENT',
        status: { in: ['ACTIVE', 'FULL'] },
      },
      include: {
        host: {
          select: {
            username: true,
            fullName: true,
            userProfile: { select: { username: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      items: rows.map((t) => ({
        id: t.id,
        table_name: t.tableName,
        is_public: t.isPublic,
        guest_quantity: t.guestQuantity,
        spots_remaining: t.spotsRemaining,
        status: t.status,
        hosting_category: t.hostingCategory,
        host: {
          username: t.host?.userProfile?.username || t.host?.username,
          full_name: t.host?.fullName,
          avatar_url: t.host?.userProfile?.avatarUrl || null,
        },
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/filter', optionalAuth, async (req, res, next) => {
  try {
    const now = new Date();
    const where = { deletedAt: null };
    if (req.query.id) where.id = req.query.id;
    if (req.query.venue_id) {
      const venueIdRaw = venueIdFromQuery(req.query)
        || (Array.isArray(req.query.venue_id) ? req.query.venue_id[0] : req.query.venue_id);
      if (typeof venueIdRaw === 'string' && venueIdRaw.trim()) where.venueId = venueIdRaw.trim();
    }
    if (req.query.status) where.status = req.query.status;
    const eventFormatQ = String(req.query.event_format || '').trim().toUpperCase();
    if (eventFormatQ === 'TICKETING_ONLY' || eventFormatQ === 'TABLE_HOSTING') {
      where.eventFormat = eventFormatQ;
    }
    const searchQ = String(req.query.q || req.query.search || '').trim();
    if (searchQ) {
      where.title = { contains: searchQ, mode: 'insensitive' };
    }
    const eventScope = String(req.query.event_scope || 'all').toLowerCase();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    if (eventScope === 'active') {
      where.date = { gte: todayStart };
    } else if (eventScope === 'past') {
      where.date = { lt: todayStart };
    }
    if (shouldIsolateEventList(req)) {
      await applyOwnedOrStaffEventIsolation(req, where);
    }
    const sort = String(req.query.sort || 'date');
    const sortDesc = sort === '-date';
    const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 100);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const paginated = String(req.query.paginated || '') === '1' || req.query.skip != null;
    const followedSet = await followedVenueIdSet(req.userId);
    const includeEnded = includeEndedFromQuery(req.query);
    const whereMerged = mergePublishedNotEnded(where, now, { includeEnded });

    if (paginated) {
      const [total, events] = await Promise.all([
        prisma.event.count({ where: whereMerged }),
        prisma.event.findMany({
          where: whereMerged,
          orderBy: { date: sortDesc ? 'desc' : 'asc' },
          skip,
          take,
        }),
      ]);
      const items = await mapEventRowsWithOptionalAttendance(events, { withAttendance: includeEnded });
      return res.json({
        items,
        total,
        hasMore: skip + events.length < total,
        skip,
        limit: take,
      });
    }

    const fetchCap = req.userId && followedSet.size > 0 ? Math.min(take * 15, 500) : take;
    const events = await prisma.event.findMany({
      where: whereMerged,
      orderBy: { date: sortDesc ? 'desc' : 'asc' },
      take: fetchCap,
    });
    const ordered =
      req.userId && followedSet.size > 0
        ? sortEventsByFollowThenDate(events, followedSet, sortDesc).slice(0, take)
        : events;
    res.json(await mapEventRowsWithOptionalAttendance(ordered, { withAttendance: includeEnded }));
  } catch (err) {
    next(err);
  }
});

/** One round-trip for Home featured carousel (replaces N × GET /events/:id). */
router.get('/featured-details', optionalAuth, async (req, res, next) => {
  try {
    const { fetchFeaturedEventDetails } = await import('../lib/featuredEvents.js');
    const raw = String(req.query.ids || '').trim();
    const ids = raw
      ? [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 12)
      : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 12);
    const out = await fetchFeaturedEventDetails({ ids, limit });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

async function getOwnedEventForPromoters(eventId, userId) {
  const event = await prisma.event.findFirst({
    where: { id: eventId, deletedAt: null },
    select: { id: true, venueId: true, title: true },
  });
  if (!event) return null;
  const ok = await staffHasVenuePermission(userId, event.venueId, 'events');
  return ok ? event : null;
}

router.get('/venue/:venueId/promoter/:promoterUserId/assignments', authenticateToken, async (req, res, next) => {
  try {
    const ok = await staffHasVenuePermission(req.userId, req.params.venueId, 'events');
    if (!ok) return res.status(403).json({ error: 'Forbidden' });

    const assignments = await prisma.eventPromoterAssignment.findMany({
      where: {
        venueId: req.params.venueId,
        promoterUserId: req.params.promoterUserId,
        status: 'ACTIVE',
      },
      include: {
        event: {
          select: { id: true, title: true, date: true, status: true, coverImageUrl: true },
        },
      },
      orderBy: { assignedAt: 'desc' },
    });

    const appBase = (process.env.APP_URL || '').replace(/\/+$/, '');
    res.json({
      data: assignments.map((a) => ({
        eventId: a.event.id,
        title: a.event.title,
        date: a.event.date,
        shareUrl: appBase
          ? `${appBase}/EventDetails?id=${encodeURIComponent(a.event.id)}&ref=${encodeURIComponent(req.params.promoterUserId)}`
          : `/EventDetails?id=${a.event.id}&ref=${req.params.promoterUserId}`,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/roster/promoters', authenticateToken, async (req, res, next) => {
  try {
    const staffCtx = staffCtxFromQuery(req.query);
    let venueId = null;
    if (staffCtx) {
      const scope = await resolveBusinessVenueScope(req.userId, {
        staffCtx,
        permission: 'events',
      });
      if (!scope.ok) return res.status(scope.status || 403).json({ error: scope.error || 'Forbidden' });
      venueId = scope.venueIds[0];
    } else if (req.query.venue_id) {
      venueId = String(req.query.venue_id);
      const ok = await staffHasVenuePermission(req.userId, venueId, 'events');
      if (!ok) return res.status(403).json({ error: 'Forbidden' });
    } else {
      return res.status(400).json({ error: 'staff_ctx or venue_id is required' });
    }

    const roster = await prisma.venuePromoter.findMany({
      where: { venueId, status: 'ACTIVE' },
      include: {
        promoter: {
          select: {
            id: true,
            fullName: true,
            username: true,
            userProfile: { select: { avatarUrl: true, username: true } },
          },
        },
      },
      orderBy: { hiredAt: 'desc' },
    });

    res.json({
      data: roster.map((r) => ({
        promoterUserId: r.promoterUserId,
        hiredAt: r.hiredAt,
        username: r.promoter.userProfile?.username || r.promoter.username,
        fullName: r.promoter.fullName,
        avatarUrl: r.promoter.userProfile?.avatarUrl || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/venue/:venueId/promoters', authenticateToken, async (req, res, next) => {
  try {
    const ok = await staffHasVenuePermission(req.userId, req.params.venueId, 'events');
    if (!ok) return res.status(403).json({ error: 'Forbidden' });

    const roster = await prisma.venuePromoter.findMany({
      where: { venueId: req.params.venueId, status: 'ACTIVE' },
      include: {
        promoter: {
          select: {
            id: true,
            fullName: true,
            username: true,
            userProfile: { select: { avatarUrl: true, username: true } },
          },
        },
      },
      orderBy: { hiredAt: 'desc' },
    });

    res.json({
      data: roster.map((r) => ({
        promoterUserId: r.promoterUserId,
        hiredAt: r.hiredAt,
        username: r.promoter.userProfile?.username || r.promoter.username,
        fullName: r.promoter.fullName,
        avatarUrl: r.promoter.userProfile?.avatarUrl || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/promoters', optionalAuth, async (req, res, next) => {
  try {
    const event = await prisma.event.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, venueId: true },
    });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const assignments = await prisma.eventPromoterAssignment.findMany({
      where: { eventId: event.id, status: 'ACTIVE' },
      include: {
        promoter: {
          select: {
            id: true,
            username: true,
            fullName: true,
            userProfile: { select: { avatarUrl: true, username: true, isVerifiedPromoter: true } },
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
    });

    res.json({
      data: assignments.map((a) => ({
        id: a.id,
        promoterUserId: a.promoterUserId,
        assignedAt: a.assignedAt,
        username: a.promoter.userProfile?.username || a.promoter.username,
        fullName: a.promoter.fullName,
        avatarUrl: a.promoter.userProfile?.avatarUrl || null,
        isVerifiedPromoter: !!a.promoter.userProfile?.isVerifiedPromoter,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/promoters', authenticateToken, async (req, res, next) => {
  try {
    const schema = z.object({ promoterUserIds: z.array(z.string().min(1)).max(20) });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

    const event = await getOwnedEventForPromoters(req.params.id, req.userId);
    if (!event) return res.status(403).json({ error: 'Forbidden' });

    const ids = [...new Set(parsed.data.promoterUserIds)];
    const roster = await prisma.venuePromoter.findMany({
      where: {
        venueId: event.venueId,
        promoterUserId: { in: ids },
        status: 'ACTIVE',
      },
      select: { promoterUserId: true },
    });
    const allowed = new Set(roster.map((r) => r.promoterUserId));
    const invalid = ids.filter((id) => !allowed.has(id));
    if (invalid.length) {
      return res.status(400).json({ error: 'Some promoters are not on your active roster.', invalid });
    }

    const existing = await prisma.eventPromoterAssignment.findMany({
      where: { eventId: event.id },
      select: { id: true, promoterUserId: true, status: true },
    });
    const existingMap = new Map(existing.map((e) => [e.promoterUserId, e]));

    const toActivate = [];
    const toRevoke = existing.filter((e) => e.status === 'ACTIVE' && !ids.includes(e.promoterUserId));

    for (const promoterUserId of ids) {
      const row = existingMap.get(promoterUserId);
      if (!row) {
        toActivate.push(promoterUserId);
      } else if (row.status !== 'ACTIVE') {
        await prisma.eventPromoterAssignment.update({
          where: { id: row.id },
          data: { status: 'ACTIVE', assignedAt: new Date(), assignedByUserId: req.userId },
        });
        toActivate.push(promoterUserId);
      }
    }

    if (toRevoke.length) {
      await prisma.eventPromoterAssignment.updateMany({
        where: { id: { in: toRevoke.map((r) => r.id) } },
        data: { status: 'REVOKED' },
      });
    }

    if (toActivate.length) {
      await prisma.eventPromoterAssignment.createMany({
        data: toActivate.map((promoterUserId) => ({
          eventId: event.id,
          promoterUserId,
          venueId: event.venueId,
          assignedByUserId: req.userId,
          status: 'ACTIVE',
        })),
        skipDuplicates: true,
      });
    }

    const { notifyPromoterFollowers } = await import('../lib/promoterAttribution.js');
    const { notifyPromoterEventAssignment } = await import('../lib/promoterVenueThread.js');
    const appBase = (process.env.APP_URL || '').replace(/\/+$/, '');
    for (const promoterUserId of toActivate) {
      await notifyPromoterEventAssignment({
        venueId: event.venueId,
        promoterUserId,
        event: { id: event.id, title: event.title, date: event.date },
      }).catch(() => {});
      await notifyPromoterFollowers({
        promoterUserId,
        title: 'New event from a promoter you follow',
        body: `A promoter you follow was assigned to "${event.title}".`,
        actionUrl: appBase ? `${appBase}/EventDetails?id=${event.id}` : `/EventDetails?id=${event.id}`,
      });
    }

    const updated = await prisma.eventPromoterAssignment.findMany({
      where: { eventId: event.id, status: 'ACTIVE' },
      include: {
        promoter: {
          select: {
            id: true,
            username: true,
            fullName: true,
            userProfile: { select: { avatarUrl: true, username: true } },
          },
        },
      },
    });

    res.json({
      data: updated.map((a) => ({
        promoterUserId: a.promoterUserId,
        username: a.promoter.userProfile?.username || a.promoter.username,
        fullName: a.promoter.fullName,
        avatarUrl: a.promoter.userProfile?.avatarUrl || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const event = await prisma.event.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { venue: true },
    });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const canManageEvents =
      req.userId &&
      (isStaff(req.userRole) ||
        (await staffHasVenuePermission(req.userId, event.venue.id, 'events')));
    if (event.status === 'draft' && req.userId && !canManageEvents) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const ended = eventHasEnded(event);
    if (ended && event.status !== 'published' && !canManageEvents) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const [stats, attendance] = await Promise.all([
      computeEventStats(event.id, event.hostingConfig),
      loadAttendanceCountsByEventIds([event.id]),
    ]);
    const payload = mapEventDetail(event, stats);
    const counts = attendance.get(event.id) || {};
    payload.ended = ended;
    payload.attendee_count = counts.attendee_count ?? stats?.going_count ?? 0;
    payload.tickets_sold = counts.tickets_sold ?? 0;
    payload.admitted_count = counts.admitted_count ?? 0;
    if (req.userId) {
      try {
        payload.my_ticket_counts = await countUserEventTicketsByTier(prisma, {
          userId: req.userId,
          eventId: event.id,
        });
      } catch (countErr) {
        logger.warn('my_ticket_counts failed', { eventId: event.id, err: countErr?.message });
        payload.my_ticket_counts = {};
      }
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const parsed = eventCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error?.issues?.[0]?.message || 'Invalid input';
      const path = parsed.error?.issues?.[0]?.path?.join('.') || '';
      return res.status(400).json({
        error: path ? `${detail} (${path})` : detail,
        details: parsed.error.issues?.slice(0, 5),
      });
    }
    const d = parsed.data;
    const staffCtx = staffCtxFromQuery(req.query);
    let resolvedVenueId = d.venue_id;
    if (staffCtx) {
      const scope = await resolveBusinessVenueScope(req.userId, {
        staffCtx,
        permission: 'events',
      });
      if (!scope.ok) return res.status(scope.status || 403).json({ error: scope.error || 'Forbidden' });
      resolvedVenueId = scope.venueIds[0];
    }
    if (!resolvedVenueId) return res.status(400).json({ error: 'venue_id or staff_ctx is required' });
    const hasFee = d.has_entrance_fee ?? false;
    if (hasFee && (d.entrance_fee_amount == null || Number.isNaN(d.entrance_fee_amount))) {
      return res.status(400).json({ error: 'Invalid input' });
    }
    const venue = await prisma.venue.findFirst({ where: { id: resolvedVenueId, deletedAt: null } });
    const canCreate =
      venue &&
      (isStaff(req.userRole) || (await staffHasVenuePermission(req.userId, venue.id, 'events')));
    if (!canCreate) return res.status(403).json({ error: 'Not authorized' });
    const resolvedLocationCity = d.location_city || d.city || venue.city;
    if (!resolvedLocationCity) return res.status(400).json({ error: 'Invalid input' });

    const rowClock = { date: new Date(d.date), startTime: d.start_time ?? null, endsAt: null, ends_at: d.ends_at };
    const startsAt = eventStartsAtFromEvent(rowClock);
    const endsAtResolved = d.ends_at ? new Date(d.ends_at) : eventEndsAtFromEvent(rowClock);

    if (d.status === 'published') {
      const cover = d.cover_image_url;
      if (cover == null || String(cover).trim() === '') {
        return res.status(400).json({ error: 'Cover image is required to publish.' });
      }
      if (!d.ends_at) {
        return res.status(400).json({ error: 'Event end date and time is required to publish.' });
      }
      if (startsAt && endsAtResolved && endsAtResolved.getTime() < startsAt.getTime()) {
        return res.status(400).json({ error: 'Event end must be after start.' });
      }
    }

    const eventFormat = d.event_format === 'TICKETING_ONLY' ? 'TICKETING_ONLY' : 'TABLE_HOSTING';
    const normalizedHosting = normalizeHostingConfig(d.hosting_config ?? null);
    const hasHostingTiers = ['general', 'vip'].some(
      (cat) => Array.isArray(normalizedHosting[cat]?.tiers) && normalizedHosting[cat].tiers.length > 0,
    );
    if (d.hosting_config && hasHostingTiers) {
      const hostCfgCheck = validateHostingTierSlotsConfig(normalizedHosting);
      if (!hostCfgCheck.ok) return res.status(400).json({ error: hostCfgCheck.error });
      const menuCheck = await validateHostingMenuItems(resolvedVenueId, normalizedHosting);
      if (!menuCheck.ok) return res.status(400).json({ error: menuCheck.error });
    }
    if (d.status === 'published' && eventFormat === 'TICKETING_ONLY') {
      const tierCheck = validateTicketTiersForPublish(d.ticket_tiers);
      if (!tierCheck.ok) return res.status(400).json({ error: tierCheck.error });
    }

    const normalizedEventCode = normalizeEventCodeInput(d.event_code);
    const codeFmt = validateEventCodeFormat(normalizedEventCode);
    if (!codeFmt.ok) return res.status(400).json({ error: codeFmt.error });
    const codeUnique = await assertEventCodeUniqueForVenue(prisma, {
      venueId: resolvedVenueId,
      eventCode: codeFmt.code,
    });
    if (!codeUnique.ok) return res.status(400).json({ error: codeUnique.error });

    let seatingFields = { showSeatingPlan: false, seatingPlanId: null };
    if (d.show_seating_plan && eventFormat === 'TABLE_HOSTING') {
      const resolved = await resolveEventSeatingPlanFields(
        resolvedVenueId,
        true,
        d.seating_plan_id ?? null,
      );
      if (resolved.error) return res.status(400).json({ error: resolved.error });
      seatingFields = resolved;
    }

    const event = await prisma.event.create({
      data: {
        venueId: resolvedVenueId,
        title: d.title,
        description: d.description,
        date: new Date(d.date),
        city: resolvedLocationCity,
        locationAddress: d.location_address || venue.address || null,
        locationCity: resolvedLocationCity,
        locationSuburb: d.location_suburb || venue.suburb || null,
        locationProvince: d.location_province || venue.province || null,
        status: d.status,
        isFeatured: d.is_featured ?? false,
        coverImageUrl: d.cover_image_url,
        bannerUrl: d.banner_url,
        ticketTiers: d.ticket_tiers,
        startTime: d.start_time ?? null,
        endsAt: endsAtResolved,
        hasEntranceFee: eventFormat === 'TICKETING_ONLY' ? false : hasFee,
        entranceFeeAmount: eventFormat === 'TICKETING_ONLY' ? null : hasFee ? d.entrance_fee_amount : null,
        hostingConfig: hasHostingTiers ? normalizedHosting : null,
        eventFormat,
        allowsTicketMenuAddons:
          eventFormat === 'TICKETING_ONLY'
            ? Boolean(d.allows_ticket_menu_addons) || ticketTiersAllowMenuAddons(d.ticket_tiers)
            : false,
        eventCode: codeFmt.code,
        showSeatingPlan: seatingFields.showSeatingPlan,
        seatingPlanId: seatingFields.seatingPlanId,
      },
    });
    if (d.status === 'published' && hasHostingTiers) {
      await syncEventVenueTables(event.id);
    }
    ensureGroupChatForEvent(event.id, event.title).catch((e) => {
      logger.error('Group chat creation after event failed', { eventId: event.id, message: e?.message });
    });
    res.status(201).json({ id: event.id, title: event.title, venue_id: event.venueId });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', authenticateToken, async (req, res, next) => {
  try {
    const event = await prisma.event.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { venue: true },
    });
    if (
      !event ||
      (!isStaff(req.userRole) &&
        !(await staffHasVenuePermission(req.userId, event.venue.id, 'events')))
    ) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const parsed = eventSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error?.issues?.[0]?.message || 'Invalid input';
      const path = parsed.error?.issues?.[0]?.path?.join('.') || '';
      return res.status(400).json({
        error: path ? `${detail} (${path})` : detail,
        details: parsed.error.issues?.slice(0, 5),
      });
    }
    const d = parsed.data;
    const body = req.body || {};
    const hasCityInput = Object.prototype.hasOwnProperty.call(body, 'city');
    const hasLocationAddressInput = Object.prototype.hasOwnProperty.call(body, 'location_address');
    const hasLocationCityInput = Object.prototype.hasOwnProperty.call(body, 'location_city');
    const hasLocationSuburbInput = Object.prototype.hasOwnProperty.call(body, 'location_suburb');
    const hasLocationProvinceInput = Object.prototype.hasOwnProperty.call(body, 'location_province');

    const hasEventCodeInput = Object.prototype.hasOwnProperty.call(body, 'event_code');

    const updates = {};
    if (d.title != null) updates.title = d.title;
    if (d.description != null) updates.description = d.description;
    if (d.date != null) updates.date = new Date(d.date);
    if (hasLocationAddressInput) {
      updates.locationAddress = d.location_address || event.venue.address || null;
    }
    if (hasLocationSuburbInput) {
      updates.locationSuburb = d.location_suburb || event.venue.suburb || null;
    }
    if (hasLocationProvinceInput) {
      updates.locationProvince = d.location_province || event.venue.province || null;
    }
    if (hasCityInput || hasLocationCityInput) {
      const resolvedCity = d.location_city || d.city || event.venue.city;
      if (!resolvedCity) return res.status(400).json({ error: 'Invalid input' });
      updates.city = resolvedCity;
      updates.locationCity = resolvedCity;
    }
    if (d.status != null) updates.status = d.status;
    if (d.cover_image_url !== undefined) updates.coverImageUrl = d.cover_image_url;
    if (d.banner_url !== undefined) updates.bannerUrl = d.banner_url;
    if (d.ticket_tiers != null) {
      const existingTiers = normalizeTicketTiers(event.ticketTiers);
      const incoming = normalizeTicketTiers(d.ticket_tiers);
      updates.ticketTiers = incoming.map((t) => {
        const prev = existingTiers.find((e) => e.name === t.name);
        if (prev != null && prev.sold != null) {
          return { ...t, sold: prev.sold };
        }
        return t;
      });
    }
    if (d.start_time !== undefined) updates.startTime = d.start_time;
    if (d.ends_at !== undefined) updates.endsAt = d.ends_at ? new Date(d.ends_at) : null;
    const nextFormat =
      d.event_format != null ? d.event_format : event.eventFormat || 'TABLE_HOSTING';
    if (d.event_format != null) updates.eventFormat = nextFormat;

    if (nextFormat === 'TICKETING_ONLY') {
      updates.hasEntranceFee = false;
      updates.entranceFeeAmount = null;
    } else if (d.has_entrance_fee !== undefined || d.entrance_fee_amount !== undefined) {
      const nextHasFee = d.has_entrance_fee !== undefined ? d.has_entrance_fee : event.hasEntranceFee;
      let nextAmount =
        d.entrance_fee_amount !== undefined ? d.entrance_fee_amount : event.entranceFeeAmount;
      if (d.has_entrance_fee === false) nextAmount = null;
      if (nextHasFee && (nextAmount == null || Number.isNaN(nextAmount))) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      updates.hasEntranceFee = nextHasFee;
      updates.entranceFeeAmount = nextHasFee ? nextAmount : null;
    }

    if (nextFormat !== 'TICKETING_ONLY') {
      updates.allowsTicketMenuAddons = false;
    } else if (d.ticket_tiers != null || d.allows_ticket_menu_addons !== undefined || d.event_format != null) {
      const tiersForMenuFlag =
        updates.ticketTiers !== undefined ? updates.ticketTiers : event.ticketTiers;
      updates.allowsTicketMenuAddons =
        ticketTiersAllowMenuAddons(tiersForMenuFlag) || Boolean(d.allows_ticket_menu_addons);
    }

    if (d.hosting_config !== undefined) {
      if (d.hosting_config === null || nextFormat === 'TICKETING_ONLY') {
        updates.hostingConfig = null;
      } else {
        const mergedHosting = mergeHostingConfigPatch(event.hostingConfig, d.hosting_config);
        const hasHostingTiers = ['general', 'vip'].some(
          (cat) => Array.isArray(mergedHosting[cat]?.tiers) && mergedHosting[cat].tiers.length > 0,
        );
        if (hasHostingTiers) {
          const hostCfgCheck = validateHostingTierSlotsConfig(mergedHosting);
          if (!hostCfgCheck.ok) return res.status(400).json({ error: hostCfgCheck.error });
          const menuCheck = await validateHostingMenuItems(event.venueId, mergedHosting);
          if (!menuCheck.ok) return res.status(400).json({ error: menuCheck.error });
          const tierSlotsCheck = await assertTierSlotsNotBelowCurrentHostedTables(event.id, mergedHosting);
          if (!tierSlotsCheck.ok) return res.status(400).json({ error: tierSlotsCheck.error });
        }
        updates.hostingConfig = hasHostingTiers ? mergedHosting : null;
      }
    } else if (nextFormat === 'TICKETING_ONLY' && d.event_format != null) {
      updates.hostingConfig = null;
    }

    if (hasEventCodeInput) {
      const normalizedEventCode = normalizeEventCodeInput(d.event_code);
      const codeFmt = validateEventCodeFormat(normalizedEventCode);
      if (!codeFmt.ok) return res.status(400).json({ error: codeFmt.error });
      const codeUnique = await assertEventCodeUniqueForVenue(prisma, {
        venueId: event.venueId,
        eventCode: codeFmt.code,
        excludeEventId: event.id,
      });
      if (!codeUnique.ok) return res.status(400).json({ error: codeUnique.error });
      updates.eventCode = codeFmt.code;
    }

    if (d.show_seating_plan !== undefined || d.seating_plan_id !== undefined) {
      if (nextFormat === 'TICKETING_ONLY') {
        updates.showSeatingPlan = false;
        updates.seatingPlanId = null;
      } else {
        const nextShow = d.show_seating_plan !== undefined ? d.show_seating_plan : event.showSeatingPlan;
        const nextPlanId =
          d.seating_plan_id !== undefined ? d.seating_plan_id : event.seatingPlanId;
        if (nextShow) {
          const resolved = await resolveEventSeatingPlanFields(event.venueId, true, nextPlanId);
          if (resolved.error) return res.status(400).json({ error: resolved.error });
          updates.showSeatingPlan = resolved.showSeatingPlan;
          updates.seatingPlanId = resolved.seatingPlanId;
        } else {
          updates.showSeatingPlan = false;
          updates.seatingPlanId = null;
        }
      }
    } else if (nextFormat === 'TICKETING_ONLY' && d.event_format != null) {
      updates.showSeatingPlan = false;
      updates.seatingPlanId = null;
    }

    const mergedDate = updates.date ?? event.date;
    const mergedStart = updates.startTime !== undefined ? updates.startTime : event.startTime;
    const mergedEnds = updates.endsAt !== undefined ? updates.endsAt : event.endsAt;
    const mergedCover = updates.coverImageUrl !== undefined ? updates.coverImageUrl : event.coverImageUrl;
    const mergedStatus = updates.status !== undefined ? updates.status : event.status;
    if (mergedStatus === 'published') {
      if (!mergedCover || String(mergedCover).trim() === '') {
        return res.status(400).json({ error: 'Cover image is required to publish.' });
      }
      if (!mergedEnds) {
        return res.status(400).json({ error: 'Event end date and time is required to publish.' });
      }
      const st = eventStartsAtFromEvent({ date: mergedDate, startTime: mergedStart });
      const en = mergedEnds instanceof Date ? mergedEnds : new Date(mergedEnds);
      if (st && en && en.getTime() < st.getTime()) {
        return res.status(400).json({ error: 'Event end must be after start.' });
      }
      if (nextFormat === 'TICKETING_ONLY') {
        const mergedTiers = updates.ticketTiers !== undefined ? updates.ticketTiers : event.ticketTiers;
        const tierCheck = validateTicketTiersForPublish(mergedTiers);
        if (!tierCheck.ok) return res.status(400).json({ error: tierCheck.error });
      }
    }

    const updated = await prisma.event.update({ where: { id: event.id }, data: updates });
    if (updated.status === 'published') {
      ensureGroupChatForEvent(updated.id, updated.title).catch((e) => {
        logger.error('Group chat creation on publish failed', { eventId: updated.id, message: e?.message });
      });
    }
    const hostingForSync = updates.hostingConfig !== undefined ? updates.hostingConfig : updated.hostingConfig;
    const hasHostingTiers = ['general', 'vip'].some((cat) => {
      const cfg = hostingForSync && typeof hostingForSync === 'object' ? hostingForSync[cat] : null;
      return Array.isArray(cfg?.tiers) && cfg.tiers.length > 0;
    });
    const shouldSync =
      updated.status === 'published' &&
      hasHostingTiers &&
      (updates.hostingConfig !== undefined || d.status === 'published');
    if (shouldSync) {
      await syncEventVenueTables(updated.id);
    }
    res.json({ id: updated.id, status: updated.status });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticateToken, async (req, res, next) => {
  try {
    const event = await prisma.event.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { venue: true },
    });
    if (
      !event ||
      (!isStaff(req.userRole) &&
        !(await staffHasVenuePermission(req.userId, event.venue.id, 'events')))
    ) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await prisma.event.update({
      where: { id: event.id },
      data: { deletedAt: new Date() },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

const boostBodySchema = z.object({
  days: z.coerce.number().int().min(1).max(30),
});

/** Pay to boost an event in Home / Discover feeds (R150/day). */
router.post('/:id/boost', authenticateToken, async (req, res, next) => {
  try {
    const parsed = boostBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
    }

    const event = await prisma.event.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { venue: { select: { id: true, ownerUserId: true, name: true } } },
    });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const canManage = await staffHasVenuePermission(req.userId, event.venueId, 'events');
    if (!canManage && !isStaff(req.userRole)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (event.status !== 'published') {
      return res.status(400).json({ error: 'Only published events can be boosted' });
    }

    const endAt =
      event.endsAt ||
      (() => {
        const d = event.date instanceof Date ? new Date(event.date) : new Date(event.date);
        d.setHours(23, 59, 59, 999);
        return d;
      })();
    const maxDays = maxBoostDaysUntil(endAt);
    if (maxDays < 1) {
      return res.status(400).json({ error: 'This event has ended and cannot be boosted' });
    }
    const boostDays = clampBoostDays(parsed.data.days, maxDays);
    if (boostDays < 1) {
      return res.status(400).json({ error: `Choose between 1 and ${maxDays} boost days` });
    }

    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) return res.status(500).json({ error: 'Paystack is not configured' });

    const owner = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true },
    });
    const reference = `evtboost_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const amountZar = FEED_BOOST_ZAR_PER_DAY * boostDays;
    const amountInCents = Math.round(amountZar * 100);
    const metadata = {
      type: 'EVENT_BOOST',
      eventId: event.id,
      event_id: event.id,
      venueId: event.venueId,
      boostDays,
      boost_days: boostDays,
      user_id: req.userId,
    };

    await prisma.payment.create({
      data: {
        userId: req.userId,
        email: owner?.email || 'user@secnightlife.app',
        amount: amountZar,
        reference,
        status: 'pending',
        type: 'other',
        metadata,
      },
    });

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        buildPaystackInitializeBody({
          email: owner?.email || 'user@secnightlife.app',
          amountInCents,
          reference,
          metadata,
          userId: req.userId,
        }),
      ),
    });
    const json = await response.json();
    if (!response.ok || !json?.status) {
      return res.status(400).json({ error: json?.message || 'Failed to initialize boost payment' });
    }

    res.json({
      reference,
      authorization_url: json.data.authorization_url,
      access_code: json.data.access_code,
      amount_zar: amountZar,
      boost_days: boostDays,
      max_boost_days: maxDays,
      zar_per_day: FEED_BOOST_ZAR_PER_DAY,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
