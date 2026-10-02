/** Mirrors backend/src/lib/payoutSchedule.js — weekly batched payouts. */
export const PAYOUT_MIN_ZAR = 50;
export const PAYOUT_DAY_LABEL = 'Monday';
const PAYOUT_WEEKDAY = 1;
const PAYOUT_HOUR_UTC = 7;

export function nextPayoutDate(from = new Date()) {
  const base = new Date(from);
  const run = new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    PAYOUT_HOUR_UTC,
  ));
  let daysAhead = (PAYOUT_WEEKDAY - run.getUTCDay() + 7) % 7;
  if (daysAhead === 0 && run.getTime() <= base.getTime()) daysAhead = 7;
  run.setUTCDate(run.getUTCDate() + daysAhead);
  return run;
}
