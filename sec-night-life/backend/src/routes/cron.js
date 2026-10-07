import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { sendEmail } from '../lib/email.js';
import { logger } from '../lib/logger.js';
import { clearExpiredMenuSpecials } from '../lib/menuSpecials.js';
import { zoneOf, zonedDateTimeToUtc } from '../lib/timezone.js';

const router = Router();

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; local/scripts may use `x-cron-secret`. */
function isCronAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const x = req.headers['x-cron-secret'];
  if (x === expected) return true;
  const auth = req.headers.authorization || req.headers.Authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7) === expected;
  }
  return false;
}

/** Calendar day + optional HH:mm as venue wall time (event time zone, default SAST). */
function eventStartDateTime(event) {
  const t =
    event.startTime && /^\d{2}:\d{2}$/.test(String(event.startTime)) ? String(event.startTime) : '18:00';
  return zonedDateTimeToUtc(event.date, t, zoneOf(event)) || new Date(event.date);
}

router.get('/expire-promotions', async (req, res, next) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const now = new Date();
    const expiredPromotions = await prisma.promotion.updateMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        endAt: { lt: now },
      },
      data: { status: 'ENDED' },
    });

    const expiredBoosts = await prisma.promotion.updateMany({
      where: {
        deletedAt: null,
        boosted: true,
        boostExpiresAt: { lt: now },
      },
      data: { boosted: false },
    });

    const menuSpecials = await clearExpiredMenuSpecials();

    res.json({
      expired: expiredPromotions.count,
      boostsExpired: expiredBoosts.count,
      menuSpecialsCleared: menuSpecials.cleared,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/expire-menu-specials', async (req, res, next) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const result = await clearExpiredMenuSpecials();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/complete-parties', async (req, res, next) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const now = new Date();
    const r = await prisma.houseParty.updateMany({
      where: { status: 'PUBLISHED', endTime: { lt: now } },
      data: { status: 'COMPLETED' },
    });
    res.json({ completed: r.count });
  } catch (err) {
    next(err);
  }
});

router.get('/expire-table-boosts', async (req, res, next) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const now = new Date();
    const hosted = await prisma.hostedTable.updateMany({
      where: { boosted: true, boostExpiresAt: { lt: now } },
      data: { boosted: false },
    });
    const events = await prisma.event.updateMany({
      where: { boosted: true, boostExpiresAt: { lt: now } },
      data: { boosted: false },
    });
    const venueTables = await prisma.venueTable.updateMany({
      where: { boosted: true, boostExpiresAt: { lt: now } },
      data: { boosted: false },
    });
    res.json({
      expired: hosted.count,
      eventsExpired: events.count,
      venueTablesExpired: venueTables.count,
    });
  } catch (err) {
    next(err);
  }
});

/** Release expired day-booking table sessions and free venue slots. */
router.get('/expire-day-table-sessions', async (req, res, next) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { expireDayTableSessions } = await import('../lib/releaseDayTableSession.js');
    const result = await expireDayTableSessions();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Close own-place external listings after their user-set end datetime; reopen premature CLOSED. */
router.get('/expire-external-listings', async (req, res, next) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { reopenPrematurelyClosedExternalListings } = await import('../lib/eventWallClock.js');
    const reopened = await reopenPrematurelyClosedExternalListings({ limit: 200 });
    const now = new Date();
    const result = await prisma.hostedTable.updateMany({
      where: {
        status: { in: ['ACTIVE', 'FULL'] },
        tableType: 'EXTERNAL_VENUE',
        venueTableId: null,
        windowEndsAt: { lte: now },
      },
      data: { status: 'CLOSED' },
    });
    res.json({ expired: result.count, reopened: reopened.reopened });
  } catch (err) {
    next(err);
  }
});

/** T-3h reminders for users who saved venue events as interested (deduped per user+event). */
router.get('/event-interest-reminders', async (req, res, next) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const now = new Date();
    const winStart = new Date(now.getTime() + 2.5 * 60 * 60 * 1000);
    const winEnd = new Date(now.getTime() + 3.5 * 60 * 60 * 1000);

    const published = await prisma.event.findMany({
      where: {
        status: 'published',
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        date: true,
        startTime: true,
        timezone: true,
        city: true,
      },
    });

    const inWindow = published.filter((e) => {
      const start = eventStartDateTime(e);
      return start >= winStart && start <= winEnd;
    });

    let notified = 0;
    const baseUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');

    for (const event of inWindow) {
      const profiles = await prisma.userProfile.findMany({
        where: {
          interestedEvents: { has: event.id },
        },
        select: { userId: true },
      });
      if (profiles.length === 0) continue;

      for (const { userId } of profiles) {
        const existing = await prisma.eventInterestReminderSent.findUnique({
          where: {
            userId_eventId: { userId, eventId: event.id },
          },
        });
        if (existing) continue;

        const eventUrl = `${baseUrl}/EventDetails?id=${encodeURIComponent(event.id)}`;
        const reminderBody = `${event.title} starts in about 3 hours — host a table or join one while spots last.`;

        try {
          await prisma.$transaction([
            prisma.inAppNotification.create({
              data: {
                userId,
                type: 'EVENT_INTEREST_REMINDER',
                title: 'Event starting soon',
                body: reminderBody,
                referenceId: event.id,
                referenceType: 'EVENT',
              },
            }),
            prisma.eventInterestReminderSent.create({
              data: { userId, eventId: event.id },
            }),
          ]);
        } catch (e) {
          if (e?.code === 'P2002') continue;
          logger.warn('event-interest-reminder tx failed', { userId, eventId: event.id, err: e?.message });
          continue;
        }

        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { email: true, deletedAt: true },
        });
        if (user?.email && !user.deletedAt) {
          try {
            await sendEmail({
              to: user.email,
              subject: `Reminder: ${event.title} starts soon`,
              text:
                `Hi — your saved event "${event.title}" (${event.city || 'Event'}) starts in about 3 hours.\n\n` +
                `Host a table or join one before the night kicks off.\n\n` +
                `Open in the app: ${eventUrl}\n`,
              html:
                `<p>Your saved event <strong>${event.title}</strong> starts in about 3 hours.</p>` +
                `<p>Host a table or join one while there is still space.</p>` +
                `<p><a href="${eventUrl}">View event and tables</a></p>`,
            });
          } catch (mailErr) {
            logger.warn('event-interest-reminder email failed', { userId, eventId: event.id, err: mailErr?.message });
          }
        }
        notified += 1;
      }
    }

    res.json({ eventsInWindow: inWindow.length, notificationsSent: notified });
  } catch (err) {
    next(err);
  }
});

/** Friday 12:00 SAST (10:00 UTC) — weekly weekend reminder for party goers. */
router.get('/weekend-reminder', async (req, res, next) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const now = new Date();
    const sast = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }));
    const weekKey = `${sast.getFullYear()}-W${String(getIsoWeek(sast)).padStart(2, '0')}`;
    const baseUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');

    const partyGoerRoles = await prisma.accountRole.findMany({
      where: { roleType: 'partygoer' },
      select: { userId: true },
    });
    const partyGoerIds = new Set(partyGoerRoles.map((r) => r.userId));

    const users = await prisma.user.findMany({
      where: {
        deletedAt: null,
        suspendedAt: null,
        emailVerified: true,
        email: { not: null },
        OR: [
          { role: { in: ['USER', 'FREELANCER'] } },
          { id: { in: [...partyGoerIds] } },
        ],
      },
      select: { id: true, email: true, fullName: true },
    });

    let sent = 0;
    let skipped = 0;

    for (const user of users) {
      const existing = await prisma.weekendReminderSent.findUnique({
        where: { userId_weekKey: { userId: user.id, weekKey } },
      });
      if (existing) {
        skipped += 1;
        continue;
      }

      const firstName = (user.fullName || 'there').split(' ')[0];
      const subject = 'The weekend is here — book your night out on SEC';
      const text =
        `Hi ${firstName},\n\n` +
        `It's Friday — the weekend is here! Open SEC to book a table or grab tickets to an event near you.\n\n` +
        `Browse events: ${baseUrl}/Home\n\n` +
        `See you out there,\nThe SEC team`;
      const html =
        `<p>Hi ${firstName},</p>` +
        `<p><strong>The weekend is here!</strong> Open SEC to book a table or buy tickets to an event near you.</p>` +
        `<p><a href="${baseUrl}/Home">Browse events on SEC</a></p>` +
        `<p>See you out there,<br/>The SEC team</p>`;

      try {
        await sendEmail({ to: user.email, subject, text, html });
        await prisma.weekendReminderSent.create({ data: { userId: user.id, weekKey } });
        sent += 1;
      } catch (mailErr) {
        logger.warn('weekend-reminder email failed', { userId: user.id, err: mailErr?.message });
      }
    }

    res.json({ weekKey, sent, skipped, eligible: users.length });
  } catch (err) {
    next(err);
  }
});

function getIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** Re-apply domain fulfillment for Paystack-success payments that never finished (joins, tickets, listings, etc.). */
router.get('/repair-payment-fulfillment', async (req, res, next) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { repairStuckSuccessPayments } = await import('./payments.js');
    const limit = Math.min(80, Math.max(1, parseInt(String(req.query.limit || '40'), 10) || 40));
    const sinceDays = Math.min(60, Math.max(1, parseInt(String(req.query.sinceDays || '14'), 10) || 14));
    const result = await repairStuckSuccessPayments({ limit, sinceDays });
    logger.info('repair-payment-fulfillment cron', {
      scanned: result.scanned,
      attempted: result.attempted,
      repaired: result.repaired,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/retry-payouts', async (req, res, next) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const {
      retryStuckPayouts,
      syncProcessingPayoutTransfers,
      retryFailedPayoutBatches,
    } = await import('../lib/paystackPayout.js');
    const sync = await syncProcessingPayoutTransfers({ limit: 50 });
    const batchRetry = await retryFailedPayoutBatches({ limit: 50 });
    const result = await retryStuckPayouts({ limit: 50 });
    res.json({ sync, batchRetry, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/weekly-payouts', async (req, res, next) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { runWeeklyPayoutBatches, syncProcessingPayoutTransfers } = await import('../lib/paystackPayout.js');
    const sync = await syncProcessingPayoutTransfers({ limit: 50 });
    const result = await runWeeklyPayoutBatches();
    res.json({ sync, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
