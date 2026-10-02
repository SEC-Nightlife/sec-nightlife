import { line, sumCheckoutLines } from './checkoutLines.js';
import { splitPlatformGross } from './platformSplit.js';
import { getEventEntranceZar } from './hostedTableSecFees.js';
import { prisma } from './prisma.js';
import { withServiceFee } from './serviceFee.js';

/**
 * Whether the user already paid standalone entrance (or has an entrance booking) for this event.
 */
export async function userHasPaidEventEntrance(userId, eventId, db = prisma) {
  if (!userId || !eventId) return false;
  const ticket = await db.ticket.findFirst({
    where: {
      userId,
      eventId,
      kind: 'EVENT_ENTRANCE',
      refundedAt: null,
      hiddenFromHistoryAt: null,
    },
    select: { id: true },
  });
  if (ticket) return true;
  const booking = await db.eventVenueTableBooking.findFirst({
    where: {
      userId,
      eventId,
      role: 'ENTRANCE',
    },
    select: { id: true },
  });
  return Boolean(booking);
}

/**
 * Build checkout lines for standalone event entrance (+ optional menu).
 * SEC 15% / venue 85% on the subtotal; the flat SEC service fee is added on top.
 */
export function computeEntranceCheckout({
  entranceZar = 0,
  menuTotal = 0,
  menuLabel = 'Menu pre-order',
  allowZeroEntrance = false,
} = {}) {
  const lines = [];
  const entrance = Number(entranceZar) || 0;
  const menu = Number(menuTotal) || 0;
  if (entrance < 0 || menu < 0) {
    return { error: 'Invalid checkout amounts.' };
  }
  // Paid path: require a positive entrance, or menu-only when entrance is free.
  // Free-claim path: allow entrance + menu both R0 when allowZeroEntrance is set.
  if (entrance <= 0 && menu <= 0 && !allowZeroEntrance) {
    return { error: 'This event does not have an entrance fee.' };
  }
  if (entrance > 0) {
    lines.push(line('entrance', 'Entrance fee', entrance));
  } else if (allowZeroEntrance) {
    lines.push(line('entrance', 'Entrance (free)', 0));
  }
  if (menu > 0) {
    lines.push(line('menu', menuLabel, menu));
  }
  const chargeable = lines.filter((l) => Number(l.amount_zar) > 0);
  const subtotal = sumCheckoutLines(chargeable);
  const { secAmount: platformFee, recipientAmount: venueShare } =
    subtotal > 0 ? splitPlatformGross(subtotal) : { secAmount: 0, recipientAmount: 0 };
  const withFee = withServiceFee(chargeable.length ? chargeable : lines, subtotal);
  return {
    lines: withFee.lines,
    displayLines: withFee.serviceFee > 0 ? [...lines, ...withFee.lines.slice(-1)] : lines,
    entranceZar: entrance,
    menuZar: menu,
    subtotal,
    serviceFee: withFee.serviceFee,
    platformFee,
    venueShare,
    total: withFee.total,
  };
}

/**
 * Resolve entrance ZAR to charge at table checkout given event, table flags, and prior credit.
 */
export function resolveTableEntranceZar(event, table, { userHasEntranceCredit = false } = {}) {
  if (userHasEntranceCredit) return 0;
  if (table?.includeEntranceFee === false) return 0;
  return getEventEntranceZar(event);
}

/**
 * Entrance for hosted-table join: respect linked venue table includeEntranceFee + prior credit.
 */
export async function resolveHostedJoinEntranceZar({
  event,
  userId,
  hostedTableId = null,
  db = prisma,
} = {}) {
  if (!event?.id) return 0;
  const credit = userId ? await userHasPaidEventEntrance(userId, event.id, db) : false;
  if (credit) return 0;

  let includeEntranceFee = true;
  if (hostedTableId) {
    const vt = await db.venueTable.findFirst({
      where: { hostedTableId },
      select: { includeEntranceFee: true },
    });
    if (vt && vt.includeEntranceFee === false) includeEntranceFee = false;
  }
  if (!includeEntranceFee) return 0;
  return getEventEntranceZar(event);
}
