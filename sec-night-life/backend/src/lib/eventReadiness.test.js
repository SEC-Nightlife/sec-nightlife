import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE_FEE_ZAR } from './serviceFee.js';
import { TICKET_PLATFORM_FEE_RATE } from './platformSplit.js';
import { planTierSoldUpdate } from './issueEventTickets.js';
import { admitClaimOutcome, admitTicketTx } from './ticketAdmit.js';
import { venueTicketPayoutReady } from './payoutSchedule.js';

const VAT = 1.15;
const TRANSFER_ZAR = 3;
const LOCAL_CARD = { rate: 0.029, flat: 1 };
const INTERNATIONAL_CARD = { rate: 0.031, flat: 1 };

/** SEC keeps the R5 plus 4% of the ticket, then Paystack (VAT included) and one R3 transfer. */
function secRemainderAfterPaystack(ticketZar, card) {
  const charged = ticketZar + SERVICE_FEE_ZAR;
  const paystack = (card.rate * charged + card.flat) * VAT;
  const sec = SERVICE_FEE_ZAR + TICKET_PLATFORM_FEE_RATE * ticketZar;
  return sec - paystack - TRANSFER_ZAR;
}

test('SEC remainder stays positive after Paystack VAT and one transfer', () => {
  assert.equal(SERVICE_FEE_ZAR, 5);
  assert.equal(TICKET_PLATFORM_FEE_RATE, 0.04);
  for (const ticketZar of [20, 100, 5000]) {
    assert.ok(
      secRemainderAfterPaystack(ticketZar, LOCAL_CARD) > 0,
      `local R${ticketZar}`,
    );
    assert.ok(
      secRemainderAfterPaystack(ticketZar, INTERNATIONAL_CARD) > 0,
      `international R${ticketZar}`,
    );
  }
});

test('ticket issue refuses a quantity that would pass the tier cap', () => {
  const tiers = [{ name: 'General', quantity: 10, sold: 9, price: 100 }];
  const soldOut = planTierSoldUpdate(tiers, 'General', 2);
  assert.equal(soldOut.ok, false);
  assert.equal(soldOut.reason, 'sold_out');
  assert.equal(tiers[0].sold, 9);

  const lastSeat = planTierSoldUpdate(tiers, 'General', 1);
  assert.equal(lastSeat.ok, true);
  assert.equal(lastSeat.tiers[0].sold, 10);
  assert.equal(tiers[0].sold, 9);
});

test('a tier with no quantity stays uncapped', () => {
  const planned = planTierSoldUpdate([{ name: 'Door', sold: 40, price: 20 }], 'Door', 5);
  assert.equal(planned.ok, true);
  assert.equal(planned.tiers[0].sold, 45);
});

test('two issuers reading the same sold count cannot both commit the last ticket', () => {
  let stored = [{ name: 'General', quantity: 10, sold: 9 }];
  const seen = stored;
  const first = planTierSoldUpdate(seen, 'General', 1);
  const second = planTierSoldUpdate(seen, 'General', 1);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  function commitIfUnchanged(planned, snapshot) {
    if (stored !== snapshot) return false;
    stored = planned.tiers;
    return true;
  }

  assert.equal(commitIfUnchanged(first, seen), true);
  assert.equal(commitIfUnchanged(second, seen), false);
  assert.equal(stored[0].sold, 10);
  assert.equal(planTierSoldUpdate(stored, 'General', 1).reason, 'sold_out');
});

test('a lost admit claim is already admitted', () => {
  const won = admitClaimOutcome(1, null);
  assert.equal(won.claimed, true);
  const lost = admitClaimOutcome(0, '2026-11-28T20:00:00.000Z');
  assert.equal(lost.claimed, false);
  assert.equal(lost.status, 409);
  assert.equal(lost.error, 'Already admitted');
});

test('two door scans of the same QR cannot both admit', async () => {
  const ticket = {
    id: 'ticket-1',
    kind: 'EVENT_TICKET',
    admittedAt: null,
    eventId: 'event-1',
    userId: 'guest-1',
    visibleUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    refundedAt: null,
  };
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tx = {
    ticket: {
      findUnique: async (args) => {
        if (args?.select?.admittedAt) return { admittedAt: ticket.admittedAt };
        reads += 1;
        if (reads === 2) release();
        await gate;
        return { ...ticket, admittedAt: null };
      },
      updateMany: async ({ where, data }) => {
        if (where.id !== ticket.id || where.admittedAt !== null || ticket.admittedAt) {
          return { count: 0 };
        }
        ticket.admittedAt = data.admittedAt;
        return { count: 1 };
      },
    },
    event: {
      findFirst: async () => ({ id: 'event-1', title: '28 November' }),
    },
    eventAttendance: { upsert: async () => ({}) },
  };

  const [first, second] = await Promise.all([
    admitTicketTx(tx, { ticketId: ticket.id, staffUserId: 'door-1', staffRole: 'ADMIN' }),
    admitTicketTx(tx, { ticketId: ticket.id, staffUserId: 'door-2', staffRole: 'ADMIN' }),
  ]);
  const results = [first, second];
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 1);
  assert.equal(results.find((result) => result.status === 409).error, 'Already admitted');
  assert.ok(ticket.admittedAt instanceof Date);
});

test('venue ticket payout waits until the event has ended', () => {
  const show = { endsAt: new Date('2026-11-29T02:00:00.000Z') };
  const before = new Date('2026-11-09T07:00:00.000Z');
  const after = new Date('2026-11-30T07:00:00.000Z');
  assert.equal(venueTicketPayoutReady({ type: 'ticket' }, show, before), false);
  assert.equal(venueTicketPayoutReady({ type: 'event' }, show, before), false);
  assert.equal(venueTicketPayoutReady({ type: 'ticket' }, show, after), true);
  assert.equal(venueTicketPayoutReady({ type: 'ticket' }, null, after), false);
  assert.equal(venueTicketPayoutReady({ type: 'promotion' }, null, before), true);
  assert.equal(venueTicketPayoutReady({ type: 'boost' }, show, before), true);
});
