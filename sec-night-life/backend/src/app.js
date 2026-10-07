import 'dotenv/config';
import { validateEnv } from './lib/env.js';
import { initSentry } from './lib/sentry.js';

// Validate env before anything else
validateEnv();
initSentry();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createRedisRateLimitStore } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { defaultTicketVerifyOrigin } from './lib/ticketVerifyUrl.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import venueRoutes from './routes/venues.js';
import eventRoutes from './routes/events.js';
import tableRoutes from './routes/tables.js';
import jobRoutes from './routes/jobs.js';
import uploadRoutes from './routes/upload.js';
import blockRoutes from './routes/blocks.js';
import reportRoutes from './routes/reports.js';
import notificationRoutes from './routes/notifications.js';
import friendsRoutes from './routes/friends.js';
import groupChatRoutes from './routes/groupChats.js';
import chatRoutes from './routes/chats.js';
import messageRoutes from './routes/messages.js';
import analyticsRoutes from './routes/analytics.js';
import friendRequestRoutes from './routes/friend-requests.js';
import transactionRoutes from './routes/transactions.js';
import reviewRoutes from './routes/reviews.js';
import ratingRoutes from './routes/ratings.js';
import paymentRoutes, { paystackWebhookHandler } from './routes/payments.js';
import promotionRoutes from './routes/promotions.js';
import cronRoutes from './routes/cron.js';
import hostEventRoutes from './routes/host-events.js';
import hostDashboardRoutes from './routes/hostDashboard.js';
import venueTableRoutes from './routes/venueTables.js';
import userRoleRoutes from './routes/user-roles.js';
import adminRoutes from './routes/admin.js';
import legalRoutes from './routes/legal.js';
import complianceDocumentsRoutes from './routes/compliance-documents.js';
import leaderboardRoutes from './routes/leaderboard.js';
import promoterRoutes from './routes/promoters.js';
import ticketRoutes from './routes/tickets.js';
import businessBookingsRoutes from './routes/businessBookings.js';
import businessInboxRoutes from './routes/businessInbox.js';
import venueTableMessageRoutes from './routes/venueTableMessages.js';
import promoterVenueThreadRoutes from './routes/promoterVenueThreads.js';
import businessMenuRoutes from './routes/businessMenu.js';
import venueSeatingPlansRoutes from './routes/venueSeatingPlans.js';
import venueMessageGroupRoutes from './routes/venueMessageGroups.js';
import staffContextGroupRoutes from './routes/staffContextGroups.js';
import staffContextMenuRoutes from './routes/staffContextMenu.js';
import staffContextPromotionRoutes from './routes/staffContextPromotions.js';
import staffContextVenueRoutes from './routes/staffContextVenue.js';
import venueStaffRoutes, { staffVenuesRouter } from './routes/venueStaff.js';
import menuCatalogRoutes from './routes/menuCatalog.js';
import homeFeedRoutes from './routes/homeFeed.js';
import mapRoutes from './routes/map.js';
import celebrationRoutes from './routes/celebrations.js';
import walletRoutes from './routes/wallet.js';
import refundRoutes from './routes/refunds.js';
import vendorRoutes from './routes/vendors.js';
import addonOrderRoutes from './routes/addonOrders.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { authenticateToken, optionalAuth } from './middleware/auth.js';
import { requireAdmin } from './middleware/rbac.js';
import { prisma } from './lib/prisma.js';

const app = express();
const isProd = process.env.NODE_ENV === 'production';

// Trust proxy (required behind Vercel/other proxies for rate limiting and correct IP)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: isProd ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://js.paystack.co'],
      frameSrc: ["'self'", 'https://checkout.paystack.com', 'https://js.paystack.co'],
      connectSrc: ["'self'", 'https://api.paystack.co'],
      imgSrc: ["'self'", 'data:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  } : false,
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false
}));

function addOriginWithWwwAlias(set, raw) {
  const normalized = String(raw || '').trim().replace(/\/+$/, '');
  if (!normalized) return;
  set.add(normalized);
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    const host = url.hostname;
    if (host.startsWith('www.')) {
      set.add(`${url.protocol}//${host.slice(4)}${url.port ? `:${url.port}` : ''}`);
    } else if (!host.includes('localhost') && host.split('.').length >= 2) {
      set.add(`${url.protocol}//www.${host}${url.port ? `:${url.port}` : ''}`);
    }
  } catch {
    // Ignore invalid origin strings.
  }
}

// Strict CORS (normalize origins: trim trailing slashes for comparison)
const allowedOrigins = new Set();
for (const origin of (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:4173').split(',')) {
  addOriginWithWwwAlias(allowedOrigins, origin);
}

// Ensure frontend origin from APP_URL is accepted as well (common in production deployments).
if (process.env.APP_URL) {
  try {
    addOriginWithWwwAlias(allowedOrigins, new URL(process.env.APP_URL).origin);
  } catch {
    // APP_URL format is validated at startup; ignore here as a defense-in-depth guard.
  }
}

// Capacitor / Ionic WebView origins (iOS iosScheme=https → https://localhost).
for (const nativeOrigin of [
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'ionic://localhost',
]) {
  allowedOrigins.add(nativeOrigin);
}

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) {
      if (isProd) return cb(new Error('CORS: requests without Origin are not allowed in production'), false);
      return cb(null, true);
    }
    const normalizedOrigin = origin.replace(/\/+$/, '');
    if (allowedOrigins.has(normalizedOrigin)) return cb(null, true);
    // Preview deployments only when explicitly enabled (never open *.vercel.app in production by default)
    const allowVercelPreview =
      process.env.CORS_ALLOW_VERCEL_PREVIEW === 'true' ||
      (!isProd && process.env.CORS_ALLOW_VERCEL_PREVIEW !== 'false');
    if (allowVercelPreview && normalizedOrigin.endsWith('.vercel.app')) return cb(null, true);
    cb(new Error('CORS: origin not allowed'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Home promotions feed sends x-session-id; preflight fails if not listed (feed appeared empty on Vercel).
  allowedHeaders: ['Content-Type', 'Authorization', 'x-session-id'],
}));

// Paystack webhooks — raw body required for HMAC signature verification
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), paystackWebhookHandler);
app.post('/api/payments/paystack/webhook', express.raw({ type: 'application/json' }), paystackWebhookHandler);

// Body size limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting (Redis-backed when UPSTASH_* env is set)
const rateLimitStore = createRedisRateLimitStore({ prefix: 'sec-rl' });

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 100 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  store: rateLimitStore,
  message: { error: 'Too many requests. Try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 20 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisRateLimitStore({ prefix: 'sec-rl-auth' }),
  message: { error: 'Too many requests. Try again in a few minutes.' },
  // Session keep-alive must not share the login brute-force budget.
  skip: (req) => {
    const url = String(req.originalUrl || req.url || '');
    return (
      url.includes('/api/auth/refresh') ||
      url.includes('/api/auth/me') ||
      url.includes('/api/auth/logout')
    );
  },
});

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isProd ? 3 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisRateLimitStore({ prefix: 'sec-rl-resend' }),
  message: { error: 'Too many verification email requests. Try again in an hour.' }
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 20 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisRateLimitStore({ prefix: 'sec-rl-pay' }),
  message: { error: 'Too many payment requests. Try again later.' }
});

// Request logging
app.use(requestLogger);

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/auth/resend-verification', resendLimiter);
app.use('/api/users', generalLimiter, userRoutes);
app.use('/api/venues', generalLimiter, venueRoutes);
app.use('/api/events', generalLimiter, eventRoutes);
app.use('/api/tables', generalLimiter, tableRoutes);
app.use('/api/jobs', generalLimiter, jobRoutes);
app.use('/api/upload', generalLimiter, uploadRoutes);
app.use('/api/blocks', generalLimiter, blockRoutes);
app.use('/api/reports', generalLimiter, reportRoutes);
app.use('/api/notifications', generalLimiter, notificationRoutes);
app.use('/api/friends', generalLimiter, friendsRoutes);
app.use('/api/group-chats', generalLimiter, groupChatRoutes);
app.use('/api/chats', generalLimiter, chatRoutes);
app.use('/api/messages', generalLimiter, messageRoutes);
app.use('/api/analytics', generalLimiter, analyticsRoutes);
app.use('/api/friend-requests', generalLimiter, friendRequestRoutes);
app.use('/api/transactions', generalLimiter, transactionRoutes);
app.use('/api/reviews', generalLimiter, optionalAuth, reviewRoutes);
app.use('/api/ratings', generalLimiter, ratingRoutes);
app.use('/api/payments', paymentLimiter, paymentRoutes);
app.use('/api/wallet', paymentLimiter, walletRoutes);
app.use('/api/refunds', generalLimiter, refundRoutes);
app.use('/api/promotions', generalLimiter, promotionRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/host', generalLimiter, hostDashboardRoutes);
app.use('/api/venue-tables', generalLimiter, venueTableRoutes);
app.use('/api/venue-table-threads', generalLimiter, venueTableMessageRoutes);
app.use('/api/promoter-venue-threads', generalLimiter, promoterVenueThreadRoutes);
app.use('/api/host-events', generalLimiter, hostEventRoutes);
app.use('/api/user-roles', generalLimiter, userRoleRoutes);
app.use('/api/admin', generalLimiter, adminRoutes);
app.use('/api/legal', legalRoutes);
app.use('/api/compliance-documents', generalLimiter, complianceDocumentsRoutes);
app.use('/api/leaderboard', generalLimiter, leaderboardRoutes);
app.use('/api/promoters', generalLimiter, promoterRoutes);
app.use('/api/tickets', generalLimiter, ticketRoutes);
app.use('/api/business', generalLimiter, businessBookingsRoutes);
app.use('/api/business', generalLimiter, venueSeatingPlansRoutes);
app.use('/api/business/inbox', generalLimiter, businessInboxRoutes);
app.use('/api/business/venues/:venueId/groups', generalLimiter, venueMessageGroupRoutes);
app.use('/api/staff/context/:accessToken/groups', generalLimiter, staffContextGroupRoutes);
app.use('/api/staff/context/:accessToken/menu', generalLimiter, staffContextMenuRoutes);
app.use('/api/staff/context/:accessToken/promotions', generalLimiter, staffContextPromotionRoutes);
app.use('/api/staff/context/:accessToken/venue', generalLimiter, staffContextVenueRoutes);
app.use('/api/business/venues/:venueId/staff', generalLimiter, venueStaffRoutes);
app.use('/api/staff', generalLimiter, staffVenuesRouter);
app.use('/api/business', generalLimiter, businessMenuRoutes);
app.use('/api/menu-catalog', generalLimiter, menuCatalogRoutes);
app.use('/api/home', generalLimiter, homeFeedRoutes);
app.use('/api/map', generalLimiter, mapRoutes);
app.use('/api/vendors', generalLimiter, vendorRoutes);
app.use('/api/orders/addons', paymentLimiter, addonOrderRoutes);
app.use('/api/celebrations', generalLimiter, celebrationRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/** Legacy / misconfigured QR links that hit the API host — redirect to the public SPA. */
app.get('/TicketVerify', (req, res) => {
  const base = defaultTicketVerifyOrigin();
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, `${base}/TicketVerify${qs}`);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/** Public readiness probe — verifies DB connectivity for deploy monitors. */
app.get('/api/health/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ready', db: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'not_ready', db: 'error', timestamp: new Date().toISOString() });
  }
});

/** Compare venue counts with Neon SQL without Prisma CLI. Dev: open. Production: admin JWT only. */
async function healthDbHandler(req, res, next) {
  try {
    const [venueCountAll, venueCountActive] = await Promise.all([
      prisma.venue.count(),
      prisma.venue.count({ where: { deletedAt: null } }),
    ]);
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      venueCountAll,
      venueCountActive,
      ...(req.userId ? { authenticatedUserId: req.userId } : {}),
    });
  } catch (err) {
    next(err);
  }
}

if (isProd) {
  app.get('/api/health/db', authenticateToken, requireAdmin, healthDbHandler);
} else {
  app.get('/api/health/db', optionalAuth, healthDbHandler);
}

// Always JSON 404s — never Express HTML error pages (SPA/client expects JSON).
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.originalUrl || req.url,
  });
});

// Error handler
app.use(errorHandler);

export { app, logger };
export default app;

