import { prisma } from './prisma.js';
import { resolveDailySessionNumber } from './dailyTableSession.js';
import { netOfServiceFee } from './serviceFee.js';

/**
 * Idempotent log for venue dashboard: SEC event hosted table host or paid guest.
 */
export async function recordEventVenueTableBooking({
  venueId,
  eventId,
  hostedTableId = null,
  venueTableId = null,
  tableSessionNumber = 1,
  userId,
  role,
  paystackReference = null,
  amountTotal = null,
  entranceZar = null,
  componentZar = null,
  selectedMenuItems = null,
  hostingTierName = null,
  hostingCategory = null,
  menuTotalZar = null,
  promoterUserId = null,
}) {
  if (!venueId || !eventId || !userId || !role) return null;
  if (!hostedTableId && !venueTableId && role !== 'ENTRANCE') return null;

  let dup = null;
  if (paystackReference) {
    dup = await prisma.eventVenueTableBooking.findFirst({
      where: { paystackReference },
    });
  }
  if (!dup && role === 'ENTRANCE') {
    dup = await prisma.eventVenueTableBooking.findFirst({
      where: { eventId, userId, role: 'ENTRANCE' },
    });
  }
  if (!dup && hostedTableId) {
    dup = await prisma.eventVenueTableBooking.findFirst({
      where: { hostedTableId, userId, role },
    });
  }
  if (!dup && venueTableId) {
    dup = await prisma.eventVenueTableBooking.findFirst({
      where: {
        venueTableId,
        userId,
        role,
        tableSessionNumber: Number(tableSessionNumber) || 1,
      },
    });
  }

  const data = {
    paystackReference,
    amountTotal,
    entranceZar,
    componentZar,
    ...(selectedMenuItems != null ? { selectedMenuItems } : {}),
    ...(hostingTierName != null ? { hostingTierName } : {}),
    ...(hostingCategory != null ? { hostingCategory } : {}),
    ...(menuTotalZar != null ? { menuTotalZar } : {}),
    ...(promoterUserId ? { promoterUserId } : {}),
  };
  if (hostedTableId) data.hostedTableId = hostedTableId;
  if (venueTableId) {
    data.venueTableId = venueTableId;
    data.tableSessionNumber = Number(tableSessionNumber) || 1;
  }

  if (dup) {
    return prisma.eventVenueTableBooking.update({ where: { id: dup.id }, data });
  }
  return prisma.eventVenueTableBooking.create({
    data: {
      venueId,
      eventId,
      userId,
      role,
      hostedTableId: hostedTableId || null,
      venueTableId: venueTableId || null,
      tableSessionNumber: venueTableId ? Number(tableSessionNumber) || 1 : 1,
      ...data,
    },
  });
}

function isVenueHostBookingMode(bookingMode, memberRole) {
  return bookingMode === 'host' || bookingMode === 'custom_host' || memberRole === 'HOST';
}

/**
 * Log a paid guest join on an event-linked venue table (hosted or direct slot).
 */
export async function recordGuestEventVenueTableBookingIfNeeded({
  venueTableId,
  userId,
  paystackReference = null,
  amountTotal = null,
  selectedMenuItems = null,
  bookingMode = null,
  memberRole = null,
  tableSessionNumber = null,
}) {
  if (!venueTableId || !userId) return null;
  if (isVenueHostBookingMode(bookingMode, memberRole)) return null;

  const table = await prisma.venueTable.findUnique({
    where: { id: String(venueTableId) },
    select: {
      id: true,
      venueId: true,
      eventId: true,
      hostedTableId: true,
      tierLabel: true,
      tableName: true,
      tableSessionNumber: true,
      tableSessionDate: true,
    },
  });
  if (!table?.eventId) return null;

  const session = Number(tableSessionNumber ?? resolveDailySessionNumber(table)) || 1;

  if (table.hostedTableId) {
    return recordEventVenueTableBooking({
      venueId: table.venueId,
      eventId: table.eventId,
      hostedTableId: table.hostedTableId,
      venueTableId: table.id,
      tableSessionNumber: session,
      userId: String(userId),
      role: 'GUEST',
      paystackReference,
      amountTotal,
      componentZar: amountTotal,
      selectedMenuItems: selectedMenuItems ?? undefined,
      hostingTierName: table.tierLabel ?? table.tableName ?? null,
    });
  }

  return recordEventVenueTableBooking({
    venueId: table.venueId,
    eventId: table.eventId,
    venueTableId: table.id,
    tableSessionNumber: session,
    userId: String(userId),
    role: 'GUEST',
    paystackReference,
    amountTotal,
    componentZar: amountTotal,
    selectedMenuItems: selectedMenuItems ?? undefined,
    hostingTierName: table.tierLabel ?? table.tableName ?? null,
  });
}

/** Backfill missing guest rows from successful event table payments. */
export async function repairGuestEventVenueTableBookingsForEvents(eventIds = []) {
  const ids = [...new Set(eventIds)].filter(Boolean);
  if (!ids.length) return { repaired: 0 };

  const payments = await prisma.payment.findMany({
    where: { status: 'success' },
    select: { reference: true, amount: true, metadata: true, userId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 3000,
  });

  let repaired = 0;
  for (const pay of payments) {
    const meta = pay.metadata && typeof pay.metadata === 'object' ? pay.metadata : {};
    const nested = meta.metadata && typeof meta.metadata === 'object' ? meta.metadata : {};
    const flat = { ...nested, ...meta };
    const type = flat.type;
    if (type !== 'VENUE_TABLE_JOIN' && type !== 'TABLE_CHECKOUT') continue;

    const eventId = flat.event_id || flat.eventId;
    const venueTableId = flat.venue_table_id || flat.venueTableId;
    const userId = pay.userId || flat.user_id || flat.userId;
    if (!eventId || !venueTableId || !userId) continue;
    if (!ids.includes(String(eventId))) continue;

    const bookingMode = flat.booking_mode || flat.bookingMode;
    const memberRole = flat.member_role || flat.memberRole;
    if (isVenueHostBookingMode(bookingMode, memberRole)) continue;

    const row = await recordGuestEventVenueTableBookingIfNeeded({
      venueTableId: String(venueTableId),
      userId: String(userId),
      paystackReference: pay.reference,
      amountTotal: netOfServiceFee(flat, pay.amount),
      selectedMenuItems: flat.selectedMenuItems || flat.selected_menu_items,
      bookingMode,
      memberRole,
    });
    if (row) repaired += 1;
  }
  return { repaired };
}
