/**
 * Weekly batched payout schedule for venue/host Sec Wallet earnings.
 * Cron: backend/vercel.json `/api/cron/weekly-payouts` at 07:00 UTC Monday (09:00 SAST).
 */
import { eventHasEnded } from './ticketHelpers.js';
export const PAYOUT_MIN_ZAR = 50;
/** 0 = Sunday … 1 = Monday (UTC). */
export const PAYOUT_WEEKDAY = 1;
export const PAYOUT_HOUR_UTC = 7;
export const PAYOUT_SCHEDULE = 'weekly_monday';

/**
 * Venue ticket share waits until the event has ended.
 * Promotions, boosts, tables, and any non-ticket row stay on the weekly schedule.
 * A ticket row with no event record stays held so money is not sent before the show.
 */
export function venueTicketPayoutReady(meta, event, now = new Date()) {
  const type = String(meta?.type || '');
  if (type !== 'ticket' && type !== 'event') return true;
  if (!event) return false;
  return eventHasEnded(event, now);
}

/** Next payout run at or after `from` (returns `from`'s run if it hasn't happened yet). */
export function nextPayoutDate(from = new Date()) {
  const base = new Date(from);
  const run = new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    PAYOUT_HOUR_UTC,
    0,
    0,
    0,
  ));
  let daysAhead = (PAYOUT_WEEKDAY - run.getUTCDay() + 7) % 7;
  if (daysAhead === 0 && run.getTime() <= base.getTime()) daysAhead = 7;
  run.setUTCDate(run.getUTCDate() + daysAhead);
  return run;
}

/**
 * Group ledger rows by recipient and decide which groups meet the minimum.
 * Pure helper — rows need { id, recipientType, recipientVenueId, recipientUserId, recipientAmount }.
 */
export function groupPayoutRowsByRecipient(rows, minZar = PAYOUT_MIN_ZAR) {
  const groups = new Map();
  for (const row of rows || []) {
    const amount = Number(row.recipientAmount) || 0;
    if (amount <= 0) continue;
    const key = row.recipientVenueId
      ? `VENUE:${row.recipientVenueId}`
      : row.recipientUserId
        ? `USER:${row.recipientUserId}`
        : null;
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        recipientType: row.recipientVenueId ? 'VENUE' : 'USER',
        recipientVenueId: row.recipientVenueId || null,
        recipientUserId: row.recipientVenueId ? null : row.recipientUserId || null,
        rowIds: [],
        total: 0,
      });
    }
    const g = groups.get(key);
    g.rowIds.push(row.id);
    g.total = Math.round((g.total + amount) * 100) / 100;
  }
  const all = [...groups.values()];
  return {
    eligible: all.filter((g) => g.total >= minZar),
    carriedOver: all.filter((g) => g.total < minZar),
  };
}
