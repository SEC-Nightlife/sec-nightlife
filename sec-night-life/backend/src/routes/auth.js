import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { sendVerificationEmail, sendPasswordResetEmail, sendEmailChangeOtpEmail, sendLoginOtpEmail } from '../lib/email.js';
import { authenticateToken } from '../middleware/auth.js';
import { validateUsernameFormat } from '../lib/username.js';
import { createInAppNotification } from '../lib/inAppNotifications.js';
import { isIdentityVerifiedStatus } from '../middleware/requireIdentityVerified.js';
import { accountSuspendedError } from '../lib/safetyModerationNotify.js';
import {
  createRefreshTokenRow,
  findRefreshTokenRecord,
  findRecentRefreshTokenForUser,
  parseRefreshTokenUserId,
  pruneUserRefreshTokens,
  revokeRefreshToken,
  rotateRefreshToken,
} from '../lib/refreshTokens.js';

const router = Router();
const SALT_ROUNDS = 12;

// STEP 1: Read secrets — validateEnv() already ensured these are set and non-placeholder
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

/** Minimum stay-signed-in window (refresh token sliding expiry). */
const MIN_REFRESH_MS = 120 * 24 * 60 * 60 * 1000; // 4 months
/** Minimum access token lifetime — overrides short values like 15m from deployment env. */
const MIN_ACCESS_MS = 60 * 60 * 1000; // 1 hour

function parseExpiryToMs(expiry) {
  const match = /^(\d+)([smhd])$/.exec(String(expiry || '').trim());
  if (!match) return MIN_REFRESH_MS;
  const n = parseInt(match[1], 10);
  const multipliers = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 86400 * 1000 };
  return n * (multipliers[match[2]] || multipliers.d);
}

function resolveRefreshExpiryMs() {
  const configured = parseExpiryToMs(process.env.JWT_REFRESH_EXPIRY || '120d');
  return Math.max(MIN_REFRESH_MS, configured);
}

function resolveAccessExpirySeconds() {
  const configured = parseExpiryToMs(process.env.JWT_ACCESS_EXPIRY || '24h');
  const ms = Math.max(MIN_ACCESS_MS, configured);
  return Math.max(60, Math.floor(ms / 1000));
}

function accessTokenExpiresInSeconds() {
  return resolveAccessExpirySeconds();
}

function refreshExpiryDate() {
  return new Date(Date.now() + resolveRefreshExpiryMs());
}

// ── Helpers ───────────────────────────────────────────────────────────────

function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || null;
}

/** Generate a cryptographically secure random token */
function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** SHA-256 hash of a token for DB storage (fast, one-way) */
function hashTokenSha256(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Issue a new access + refresh token pair; stores hashed refresh token with fast lookup key */
async function issueTokens(user) {
  const accessToken = jwt.sign(
    { userId: user.id, role: user.role },
    JWT_ACCESS_SECRET,
    { expiresIn: resolveAccessExpirySeconds() }
  );
  const refreshExpiry = refreshExpiryDate();
  await pruneUserRefreshTokens(user.id);
  const rawRefresh = await createRefreshTokenRow(user.id, refreshExpiry);
  return { accessToken, refreshToken: rawRefresh };
}

function userPayload(user, profileExtras = {}) {
  return {
    id: user.id,
    email: user.email,
    full_name: user.fullName,
    role: user.role,
    verified: user.emailVerified,
    ...profileExtras,
  };
}

/** Same shape as GET /api/users/filter for the signed-in user (AuthContext). */
function deriveAgeVerifiedForApi(profile) {
  if (!profile) return false;
  const st = profile.verificationStatus;
  if (st === 'rejected') return false;
  if (isIdentityVerifiedStatus(st)) return true;
  return Boolean(profile.ageVerified);
}

function formatUserProfileForMe(user, p) {
  if (!p) return null;
  return {
    id: p.id,
    user_id: user.id,
    created_by: user.email,
    username: p.username,
    full_name: user.fullName || p.username,
    bio: p.bio,
    city: p.city,
    avatar_url: p.avatarUrl,
    favorite_drink: p.favoriteDrink,
    gender: p.gender ?? null,
    date_of_birth: p.dateOfBirth,
    id_document_url: p.idDocumentUrl,
    age_verified: deriveAgeVerifiedForApi(p),
    verification_status: p.verificationStatus ?? 'pending',
    payment_setup_complete: p.paymentSetupComplete ?? false,
    is_verified_promoter: p.isVerifiedPromoter ?? false,
    interests: p.interests ?? [],
    music_preferences: p.musicPreferences ?? [],
    friends: p.friends ?? [],
    followed_venues: p.followedVenues ?? [],
    interested_events: p.interestedEvents ?? [],
    onboarding_complete: p.onboardingComplete ?? false,
    notification_prefs: p.notificationPrefs ?? null,
    privacy_settings: p.privacySettings ?? null,
    app_preferences: p.appPreferences ?? null,
    latitude: p.latitude ?? null,
    longitude: p.longitude ?? null,
    location_label: p.locationLabel ?? null,
  };
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function isMissingColumnError(err) {
  return err?.code === 'P2022' || String(err?.message || '').includes('column');
}

async function readVerificationStatusCompat(userId) {
  try {
    const profile = await prisma.userProfile.findUnique({
      where: { userId },
      select: { verificationStatus: true },
    });
    return profile?.verificationStatus ?? 'pending';
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT verification_status AS "verificationStatus"
       FROM user_profiles
       WHERE user_id = $1
       LIMIT 1`,
      userId,
    );
    return rows?.[0]?.verificationStatus ?? 'pending';
  }
}

async function canAccessAdminDashboard(user) {
  if (!user) return false;
  if (['ADMIN', 'SUPER_ADMIN'].includes(user.role)) return true;
  const userEmail = normalizeEmail(user.email);
  if (!userEmail) return false;
  try {
    const delegate = await prisma.adminDashboardDelegate.findFirst({
      where: { email: userEmail, isActive: true },
      select: { id: true },
    });
    return Boolean(delegate);
  } catch (err) {
    // Migration not yet deployed in this environment; keep auth functional.
    const msg = String(err?.message || '');
    if (msg.includes('admin_dashboard_delegates') || msg.includes('does not exist')) {
      return false;
    }
    throw err;
  }
}

async function ensureIdentityReminderNotification(userId, verificationStatus) {
  if (!userId || isIdentityVerifiedStatus(verificationStatus)) return;
  // One-time reminder only: if it ever exists in either table, do not create again.
  const [existingInApp, existingLegacy] = await Promise.all([
    prisma.inAppNotification.findFirst({
      where: {
        userId,
        type: 'IDENTITY_VERIFICATION_REMINDER',
      },
      select: { id: true },
    }),
    prisma.notification.findFirst({
      where: {
        userId,
        type: 'IDENTITY_VERIFICATION_REMINDER',
      },
      select: { id: true },
    }),
  ]);
  if (!existingInApp && !existingLegacy) {
    await createInAppNotification({
      userId,
      type: 'IDENTITY_VERIFICATION_REMINDER',
      title: 'Complete age verification',
      body: 'Add your date of birth and accept the Age Verification Declaration in Profile Setup to unlock tables and payments.',
      referenceId: '/ProfileSetup',
      referenceType: 'ROUTE',
    });
  }
}

/** Rows that reference users without Prisma User FK / cascade — must be removed before user.delete */
async function deleteUserOrphans(tx, userId) {
  await tx.accountRole.deleteMany({ where: { userId } });
  await tx.friendRequest.deleteMany({
    where: { OR: [{ fromUserId: userId }, { toUserId: userId }] }
  });
  await tx.hostEvent.deleteMany({ where: { hostUserId: userId } });
  await tx.eventAttendance.deleteMany({ where: { userId } });
  await tx.venueBlockedUser.deleteMany({ where: { userId } });
  await tx.serviceRating.deleteMany({
    where: { OR: [{ raterUserId: userId }, { rateeUserId: userId }] }
  });
  await tx.promotionImpression.deleteMany({ where: { userId } });
  await tx.notification.deleteMany({ where: { userId } });
  await tx.transaction.deleteMany({ where: { userId } });
  // Retain payments for dispute/audit — anonymize PII only
  await tx.payment.updateMany({
    where: { userId },
    data: {
      email: `deleted+${String(userId).slice(0, 8)}@secnightlife.invalid`,
    },
  });
  // Retain refund requests — anonymize and detach user
  await tx.refundRequest.updateMany({
    where: { userId },
    data: {
      userId: null,
      userReason: '[redacted — account deleted]',
      userWalletCode: 'DELETED',
    },
  });
  await tx.message.deleteMany({ where: { senderId: userId } });
  await tx.profileView.deleteMany({
    where: { OR: [{ viewerId: userId }, { viewedId: userId }] }
  });
  await tx.reputationScore.deleteMany({ where: { userId } });
  await tx.analyticsEvent.deleteMany({ where: { userId } });

  const bookings = await tx.tableBooking.findMany({
    where: { organizerUserId: userId },
    select: { id: true }
  });
  for (const b of bookings) {
    // eslint-disable-next-line no-await-in-loop
    await tx.tableBookingSplit.deleteMany({ where: { bookingId: b.id } });
  }
  await tx.tableBooking.deleteMany({ where: { organizerUserId: userId } });
  await tx.tableBookingSplit.deleteMany({ where: { userId } });

  await tx.partyGroup.deleteMany({ where: { createdBy: userId } });
  await tx.partyGroupMember.deleteMany({ where: { userId } });
  await tx.partyGroupInvitation.deleteMany({
    where: { OR: [{ inviterId: userId }, { inviteeId: userId }] }
  });
}

// ── Schemas ───────────────────────────────────────────────────────────────

/** Match login: trim + lowercase so DB email matches lookup (register/login/forgot). */
const emailSchemaField = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.string().email()
);

const registerSchema = z.object({
  email: emailSchemaField,
  password: z.string().min(8).max(128),
  full_name: z.string().min(1).max(200).optional(),
  username: z.union([z.string(), z.null(), z.undefined()]).optional(),
  role: z.enum(['USER', 'VENUE', 'FREELANCER']).default('USER')
});

const loginSchema = z.object({
  email: emailSchemaField,
  password: z.string().min(1).max(256),
  role: z.enum(['USER', 'VENUE', 'FREELANCER', 'ADMIN', 'SUPER_ADMIN', 'MODERATOR']).optional()
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const forgotPasswordSchema = z.object({
  email: emailSchemaField
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(128)
});

const verifyEmailSchema = z.object({
  token: z.string().min(1)
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(128),
  new_password: z.string().min(8).max(128),
});

const changeEmailOtpSchema = z.object({
  otp: z.string().length(6).regex(/^\d{6}$/),
});

const changeEmailConfirmSchema = z.object({
  new_email: emailSchemaField,
  otp: z.string().length(6).regex(/^\d{6}$/).optional(),
});

const loginOtpSchema = z.object({
  loginChallengeToken: z.string().min(1),
  otp: z.string().length(6).regex(/^\d{6}$/),
});

const loginChallengeSchema = z.object({
  loginChallengeToken: z.string().min(1),
});

const LOGIN_OTP_EXPIRY_MS = 10 * 60 * 1000;
const LOGIN_OTP_RESEND_COOLDOWN_MS = 60 * 1000;

function generateOtp6() {
  return String(crypto.randomInt(100000, 1000000));
}

function clearEmailChangeState() {
  return {
    emailChangeCurrentOtpHash: null,
    emailChangeCurrentOtpExpiry: null,
    emailChangeCurrentVerified: false,
    emailChangeNewEmail: null,
    emailChangeNewOtpHash: null,
    emailChangeNewOtpExpiry: null,
  };
}

function clearLoginOtpState() {
  return { loginOtpHash: null, loginOtpExpiry: null };
}

/** App Store review demo accounts — skip email OTP after password (Guideline 2.1(a)). */
function shouldBypassLoginOtp(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const fromEnv = String(process.env.APP_REVIEW_OTP_BYPASS_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const allowlist = new Set(['onyxwebsystems@gmail.com', ...fromEnv]);
  return allowlist.has(normalized);
}

function verifyLoginChallengeToken(rawToken) {
  try {
    const payload = jwt.verify(rawToken, JWT_ACCESS_SECRET);
    if (payload?.purpose !== 'login_otp' || !payload?.userId) return null;
    return payload.userId;
  } catch {
    return null;
  }
}

function signLoginChallengeToken(userId) {
  return jwt.sign({ userId, purpose: 'login_otp' }, JWT_ACCESS_SECRET, { expiresIn: '10m' });
}

async function issueLoginOtpChallenge(user) {
  const otp = generateOtp6();
  const otpHash = hashTokenSha256(otp);
  const expiry = new Date(Date.now() + LOGIN_OTP_EXPIRY_MS);
  await prisma.user.update({
    where: { id: user.id },
    data: { loginOtpHash: otpHash, loginOtpExpiry: expiry },
  });
  try {
    await sendLoginOtpEmail(user.email, otp);
  } catch (err) {
    await prisma.user.update({ where: { id: user.id }, data: clearLoginOtpState() });
    logger.error('Failed to send login OTP email', {
      userId: user.id,
      email: user.email,
      message: err.message,
      code: err.code,
    });
    const sendErr = new Error(
      'We could not send your sign-in code. Check your email address and try again, or use Resend code shortly.'
    );
    sendErr.statusCode = 422;
    sendErr.code = 'EMAIL_SEND_FAILED';
    throw sendErr;
  }
  return {
    loginChallengeToken: signLoginChallengeToken(user.id),
    resendAvailableInSeconds: Math.ceil(LOGIN_OTP_RESEND_COOLDOWN_MS / 1000),
  };
}

function loginOtpResendCooldownSeconds(user) {
  if (!user?.loginOtpExpiry) return 0;
  const sentAt = user.loginOtpExpiry.getTime() - LOGIN_OTP_EXPIRY_MS;
  const remainingMs = LOGIN_OTP_RESEND_COOLDOWN_MS - (Date.now() - sentAt);
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

async function buildLoginSuccessPayload(user) {
  const { accessToken, refreshToken } = await issueTokens(user);
  const vStatus = await readVerificationStatusCompat(user.id);
  const canAdminDashboard = await canAccessAdminDashboard(user);
  await ensureIdentityReminderNotification(user.id, vStatus);
  return {
    user: userPayload(user, {
      verification_status: vStatus,
      identity_verified: isIdentityVerifiedStatus(vStatus),
      can_admin_dashboard: canAdminDashboard,
    }),
    accessToken,
    refreshToken,
    expiresIn: accessTokenExpiresInSeconds(),
  };
}

// ── Register ──────────────────────────────────────────────────────────────

router.post('/register', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const { email, password, full_name, username, role } = parsed.data;
    const normalizedPassword = password.trim();

    const usernameTrimmed =
      username === null || username === undefined ? '' : String(username).trim();
    if (!usernameTrimmed) {
      return res.status(400).json({ field: 'username', message: 'Username is required.' });
    }

    const v = validateUsernameFormat(usernameTrimmed);
    if (!v.ok) {
      return res.status(400).json({ field: 'username', message: v.message });
    }

    const usernameNormalized = v.username;
    const taken = await prisma.user.findFirst({
      where: { username: usernameNormalized, deletedAt: null },
      select: { id: true },
    });
    if (taken) {
      return res.status(409).json({
        field: 'username',
        message: 'This username is already taken. Please choose a different one.',
      });
    }

    const existing = await prisma.user.findFirst({
      where: { email, role, deletedAt: null }
    });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists for this account type. Please sign in.' });
    }

    const passwordHash = await bcrypt.hash(normalizedPassword, SALT_ROUNDS);

    const skipVerification = process.env.SKIP_EMAIL_VERIFICATION === 'true' || process.env.SKIP_EMAIL_VERIFICATION === '1';
    const rawVerificationToken = generateSecureToken();
    const verificationTokenHash = hashTokenSha256(rawVerificationToken);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        fullName: full_name || null,
        username: usernameNormalized,
        role,
        emailVerified: skipVerification,
        verificationTokenHash: skipVerification ? null : verificationTokenHash,
        verificationExpiry: skipVerification ? null : new Date(Date.now() + 24 * 60 * 60 * 1000)
      },
      select: { id: true, email: true, fullName: true, role: true, emailVerified: true }
    });

    let emailSendFailed = false;
    if (!skipVerification) {
      try {
        await sendVerificationEmail(user.email, rawVerificationToken);
      } catch (err) {
        emailSendFailed = true;
        logger.error('Failed to send verification email', {
          userId: user.id,
          email: user.email,
          message: err.message,
          code: err.code,
        });
      }
    }

    await prisma.userProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, username: usernameNormalized },
      update: { username: usernameNormalized },
    }).catch(() => {});

    if (role === 'USER') {
      const { ensureSecWallet } = await import('../lib/secWallet.js');
      ensureSecWallet('USER', user.id).catch(() => {});
    }

    await audit({
      userId: user.id,
      action: 'USER_REGISTERED',
      entityType: 'user',
      entityId: user.id,
      metadata: { email: user.email, role: user.role, emailSendFailed },
      ipAddress: getIp(req)
    });

    const response = {
      user: userPayload(user),
      emailVerificationRequired: !skipVerification,
      emailSendFailed: !skipVerification && emailSendFailed,
    };
    if (skipVerification) {
      const loginPayload = await buildLoginSuccessPayload(user);
      response.user = loginPayload.user;
      response.accessToken = loginPayload.accessToken;
      response.refreshToken = loginPayload.refreshToken;
      response.expiresIn = loginPayload.expiresIn;
    }

    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

// ── Login ─────────────────────────────────────────────────────────────────

router.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    const { email, password, role: loginRole } = parsed.data;

    const normalizedEmail = email;
    let user = null;

    const tryPassword = async (account) => {
      if (!account) return null;
      if (await bcrypt.compare(password, account.passwordHash)) return account;
      const trimmedPassword = password.trim();
      if (trimmedPassword !== password && await bcrypt.compare(trimmedPassword, account.passwordHash)) {
        return account;
      }
      return null;
    };

    // Party Goer / Business Owner: authenticate the selected (email, role) row.
    // If that fails but there is exactly one account for this email, accept it when the
    // password matches (wrong Party/Business toggle should not block single-account users,
    // including staff roles that have only one account row).
    if (loginRole === 'USER' || loginRole === 'VENUE') {
      const row = await prisma.user.findFirst({
        where: { email: normalizedEmail, role: loginRole, deletedAt: null }
      });
      user = await tryPassword(row);
      if (!user) {
        const allForEmail = await prisma.user.findMany({
          where: { email: normalizedEmail, deletedAt: null }
        });
        if (allForEmail.length === 1) {
          user = await tryPassword(allForEmail[0]);
        } else if (allForEmail.length > 1) {
          // Multiple roles on one email (e.g. Party Goer USER + Business VENUE):
          // do not fall back to another role — require the selected Party/Business toggle.
          user = null;
        }
      }
    } else if (loginRole) {
      // Staff / freelancer: try requested role first, then fall back if password matches another row (wrong client role).
      let row = await prisma.user.findFirst({
        where: { email: normalizedEmail, role: loginRole, deletedAt: null }
      });
      user = await tryPassword(row);
      if (!user) {
        const accounts = await prisma.user.findMany({
          where: { email: normalizedEmail, deletedAt: null },
          orderBy: { createdAt: 'asc' }
        });
        const rolePriority = ['SUPER_ADMIN', 'ADMIN', 'MODERATOR', 'VENUE', 'FREELANCER', 'USER'];
        const sorted = [...accounts].sort((a, b) => {
          const ai = rolePriority.indexOf(a.role);
          const bi = rolePriority.indexOf(b.role);
          return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });
        for (const account of sorted) {
          // eslint-disable-next-line no-await-in-loop
          const ok = await tryPassword(account);
          if (ok) {
            user = ok;
            break;
          }
        }
      }
    } else {
      // No role: legacy — single account or first password match (priority order).
      const accounts = await prisma.user.findMany({
        where: { email: normalizedEmail, deletedAt: null },
        orderBy: { createdAt: 'asc' }
      });

      if (accounts.length === 1) {
        user = await tryPassword(accounts[0]);
      } else {
        const rolePriority = ['SUPER_ADMIN', 'ADMIN', 'MODERATOR', 'VENUE', 'FREELANCER', 'USER'];
        const sorted = [...accounts].sort((a, b) => {
          const ai = rolePriority.indexOf(a.role);
          const bi = rolePriority.indexOf(b.role);
          return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });
        for (const account of sorted) {
          // eslint-disable-next-line no-await-in-loop
          const ok = await tryPassword(account);
          if (ok) {
            user = ok;
            break;
          }
        }
      }
    }

    if (!user) {
      const activeAccountsForEmail = await prisma.user.count({
        where: { email: normalizedEmail, deletedAt: null }
      });
      // SECURITY: log failed attempt; same error message for both wrong email and wrong password
      await audit({
        userId: user?.id || null,
        action: 'LOGIN_FAILED',
        entityType: 'user',
        entityId: user?.id || null,
        metadata: {
          email: normalizedEmail,
          roleSupplied: loginRole || null,
          activeAccountsForEmail,
          failureReason: activeAccountsForEmail > 0 ? 'password_mismatch' : 'lookup_missing'
        },
        ipAddress: getIp(req)
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.suspendedAt) {
      return res.status(403).json(accountSuspendedError(user));
    }

    // STEP 5.4: Block login if email not verified (unless ALLOW_UNVERIFIED_LOGIN for preview/dev)
    const allowUnverified = process.env.ALLOW_UNVERIFIED_LOGIN === 'true' || process.env.ALLOW_UNVERIFIED_LOGIN === '1';
    if (!user.emailVerified && !allowUnverified) {
      await audit({
        userId: user.id,
        action: 'LOGIN_BLOCKED_UNVERIFIED',
        entityType: 'user',
        entityId: user.id,
        metadata: { email: user.email },
        ipAddress: getIp(req)
      });
      return res.status(403).json({
        error: 'Email not verified. Please check your inbox and verify your email before signing in.',
        code: 'EMAIL_NOT_VERIFIED'
      });
    }

    // App Review demo: password-only login (no emailed OTP code required).
    if (shouldBypassLoginOtp(user.email)) {
      await prisma.user.update({ where: { id: user.id }, data: clearLoginOtpState() });
      await audit({
        userId: user.id,
        action: 'LOGIN_SUCCESS',
        entityType: 'user',
        entityId: user.id,
        metadata: { email: user.email, viaOtp: false, appReviewOtpBypass: true },
        ipAddress: getIp(req)
      });
      const payload = await buildLoginSuccessPayload(user);
      return res.json(payload);
    }

    const { loginChallengeToken, resendAvailableInSeconds } = await issueLoginOtpChallenge(user);

    await audit({
      userId: user.id,
      action: 'LOGIN_OTP_SENT',
      entityType: 'user',
      entityId: user.id,
      metadata: { email: user.email },
      ipAddress: getIp(req)
    });

    res.json({ requiresOtp: true, loginChallengeToken, resendAvailableInSeconds });
  } catch (err) {
    next(err);
  }
});

// ── Verify Email ──────────────────────────────────────────────────────────

router.post('/verify-email', async (req, res, next) => {
  try {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Verification token required' });
    }
    const { token: rawToken } = parsed.data;

    // STEP 5.3: Hash the incoming token and compare with stored hash
    const tokenHash = hashTokenSha256(rawToken);

    const user = await prisma.user.findFirst({
      where: {
        verificationTokenHash: tokenHash,
        verificationExpiry: { gt: new Date() },
        deletedAt: null
      }
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification link. Request a new one.' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        verificationTokenHash: null,
        verificationExpiry: null
      }
    });

    await audit({
      userId: user.id,
      action: 'EMAIL_VERIFIED',
      entityType: 'user',
      entityId: user.id,
      metadata: { email: user.email },
      ipAddress: getIp(req)
    });

    res.json({ success: true, message: 'Email verified. You can now sign in.' });
  } catch (err) {
    next(err);
  }
});

// ── Resend Verification Email ─────────────────────────────────────────────
// Rate limiting is applied in index.js (resendLimiter)

router.post('/resend-verification', async (req, res, next) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body); // reuse email schema
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const { email } = parsed.data;

    const user = await prisma.user.findFirst({
      where: { email, deletedAt: null }
    });

    // SECURITY: same response whether user exists or not (except real send failures for known unverified)
    if (user && !user.emailVerified) {
      const rawToken = generateSecureToken();
      const tokenHash = hashTokenSha256(rawToken);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          verificationTokenHash: tokenHash,
          verificationExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000)
        }
      });

      try {
        await sendVerificationEmail(user.email, rawToken);
      } catch (err) {
        logger.error('Failed to resend verification email', {
          userId: user.id,
          email: user.email,
          message: err.message,
          code: err.code,
        });
        return res.status(422).json({
          error: 'We could not send the verification email. Please try again in a few minutes.',
          code: 'EMAIL_SEND_FAILED',
        });
      }
    }

    res.json({ message: 'If the email exists and is unverified, a new verification link was sent.' });
  } catch (err) {
    next(err);
  }
});

// ── Login OTP (email 2FA) ─────────────────────────────────────────────────

router.post('/verify-login-otp', async (req, res, next) => {
  try {
    const parsed = loginOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid login challenge and 6-digit code required' });
    }
    const { loginChallengeToken, otp } = parsed.data;
    const userId = verifyLoginChallengeToken(loginChallengeToken);
    if (!userId) {
      return res.status(401).json({ error: 'Login session expired. Please sign in again.' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId, deletedAt: null } });
    if (!user || !user.loginOtpHash || !user.loginOtpExpiry) {
      return res.status(401).json({ error: 'Login session expired. Please sign in again.' });
    }
    if (user.loginOtpExpiry <= new Date()) {
      await prisma.user.update({ where: { id: user.id }, data: clearLoginOtpState() });
      return res.status(401).json({ error: 'Code expired. Please sign in again.' });
    }
    if (user.suspendedAt) {
      return res.status(403).json(accountSuspendedError(user));
    }
    if (hashTokenSha256(otp) !== user.loginOtpHash) {
      await audit({
        userId: user.id,
        action: 'LOGIN_OTP_FAILED',
        entityType: 'user',
        entityId: user.id,
        ipAddress: getIp(req),
      });
      return res.status(401).json({ error: 'Invalid code. Try again or request a new one.' });
    }

    await prisma.user.update({ where: { id: user.id }, data: clearLoginOtpState() });

    await audit({
      userId: user.id,
      action: 'LOGIN_SUCCESS',
      entityType: 'user',
      entityId: user.id,
      metadata: { email: user.email, viaOtp: true },
      ipAddress: getIp(req),
    });

    const payload = await buildLoginSuccessPayload(user);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.post('/resend-login-otp', async (req, res, next) => {
  try {
    const parsed = loginChallengeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Login challenge required' });
    }
    const userId = verifyLoginChallengeToken(parsed.data.loginChallengeToken);
    if (!userId) {
      return res.status(401).json({ error: 'Login session expired. Please sign in again.' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId, deletedAt: null } });
    if (!user) {
      return res.status(401).json({ error: 'Login session expired. Please sign in again.' });
    }
    if (user.loginOtpExpiry) {
      const cooldownSec = loginOtpResendCooldownSeconds(user);
      if (cooldownSec > 0) {
        return res.status(429).json({
          error: `Please wait ${cooldownSec} seconds before requesting a new code.`,
          retryAfterSeconds: cooldownSec,
        });
      }
    }

    const { loginChallengeToken, resendAvailableInSeconds } = await issueLoginOtpChallenge(user);
    res.json({
      loginChallengeToken,
      resendAvailableInSeconds,
      message: 'A new sign-in code was sent to your email.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/cancel-login-otp', async (req, res, next) => {
  try {
    const parsed = loginChallengeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Login challenge required' });
    }
    const userId = verifyLoginChallengeToken(parsed.data.loginChallengeToken);
    if (userId) {
      await prisma.user.update({ where: { id: userId }, data: clearLoginOtpState() });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Refresh Token ─────────────────────────────────────────────────────────

router.post('/refresh', async (req, res, next) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Refresh token required' });
    }
    const { refreshToken: rawToken } = parsed.data;

    let matched = await findRefreshTokenRecord(rawToken);
    if (!matched) {
      // Concurrent tab/app refresh often rotates the token first; heal within grace window.
      const userIdHint = parseRefreshTokenUserId(rawToken);
      matched = userIdHint ? await findRecentRefreshTokenForUser(userIdHint, 45_000) : null;
      if (!matched) {
        return res.status(401).json({ error: 'Invalid or expired refresh token' });
      }
    }

    const user = await prisma.user.findUnique({
      where: { id: matched.userId, deletedAt: null }
    });
    if (!user) {
      await prisma.refreshToken.delete({ where: { id: matched.id } }).catch(() => {});
      return res.status(401).json({ error: 'User not found' });
    }
    if (user.suspendedAt) {
      await prisma.refreshToken.delete({ where: { id: matched.id } }).catch(() => {});
      return res.status(403).json(accountSuspendedError(user));
    }

    // SECURITY: Rotate refresh token and extend sliding expiry (create new before deleting old)
    const refreshExpiry = refreshExpiryDate();
    const newRefreshToken = await rotateRefreshToken(matched, refreshExpiry);
    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      JWT_ACCESS_SECRET,
      { expiresIn: resolveAccessExpirySeconds() }
    );

    const vSt = await readVerificationStatusCompat(user.id);
    const canAdminDashboard = await canAccessAdminDashboard(user);

    res.json({
      user: userPayload(user, {
        verification_status: vSt,
        identity_verified: isIdentityVerifiedStatus(vSt),
        can_admin_dashboard: canAdminDashboard,
      }),
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: accessTokenExpiresInSeconds()
    });
  } catch (err) {
    next(err);
  }
});

// ── Logout ────────────────────────────────────────────────────────────────

router.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken: rawToken } = req.body;
    if (rawToken && typeof rawToken === 'string') {
      await revokeRefreshToken(rawToken);
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Forgot Password ───────────────────────────────────────────────────────

router.post('/forgot-password', async (req, res, next) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const { email } = parsed.data;

    const user = await prisma.user.findFirst({
      where: { email, deletedAt: null }
    });
    if (user) {
      const rawToken = generateSecureToken();
      const tokenHash = hashTokenSha256(rawToken);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          resetTokenHash: tokenHash,
          resetTokenExpiry: new Date(Date.now() + 60 * 60 * 1000)
        }
      });

      try {
        await sendPasswordResetEmail(user.email, rawToken);
      } catch (err) {
        logger.error('Failed to send password reset email', {
          userId: user.id,
          email: user.email,
          message: err.message,
          code: err.code,
        });
        // Still return generic success to avoid email enumeration; email may need retry
      }
    }

    // SECURITY: always return same response to prevent email enumeration
    res.json({ message: 'If the email exists, a reset link was sent' });
  } catch (err) {
    next(err);
  }
});

// ── Reset Password ────────────────────────────────────────────────────────

router.post('/reset-password', async (req, res, next) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input' });
    }
    const { token: rawToken, password } = parsed.data;

    const tokenHash = hashTokenSha256(rawToken);

    const user = await prisma.user.findFirst({
      where: {
        resetTokenHash: tokenHash,
        resetTokenExpiry: { gt: new Date() },
        deletedAt: null
      }
    });
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetTokenHash: null, resetTokenExpiry: null }
    });

    // Invalidate all existing refresh tokens on password reset
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    await audit({
      userId: user.id,
      action: 'PASSWORD_RESET',
      entityType: 'user',
      entityId: user.id,
      ipAddress: getIp(req)
    });

    res.json({ message: 'Password reset successfully. Please sign in.' });
  } catch (err) {
    next(err);
  }
});

// ── Change password (in-session) ──────────────────────────────────────────

router.post('/change-password', authenticateToken, async (req, res, next) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Current and new password required (min 8 characters)' });
    }
    const { current_password, new_password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { id: req.user.id, deletedAt: null } });
    if (!user) return res.status(401).json({ error: 'User not found' });

    const currentOk = await bcrypt.compare(current_password.trim(), user.passwordHash);
    if (!currentOk) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const passwordHash = await bcrypt.hash(new_password.trim(), SALT_ROUNDS);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    await audit({
      userId: user.id,
      action: 'PASSWORD_CHANGED',
      entityType: 'user',
      entityId: user.id,
      ipAddress: getIp(req),
    });

    res.json({ message: 'Password updated successfully. Please sign in again on other devices.' });
  } catch (err) {
    next(err);
  }
});

// ── Change email (OTP) ────────────────────────────────────────────────────

router.post('/change-email/request', authenticateToken, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id, deletedAt: null } });
    if (!user) return res.status(401).json({ error: 'User not found' });

    const otp = generateOtp6();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ...clearEmailChangeState(),
        emailChangeCurrentOtpHash: hashTokenSha256(otp),
        emailChangeCurrentOtpExpiry: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    sendEmailChangeOtpEmail(user.email, otp, { target: 'current' }).catch((err) => {
      logger.error('Failed to send email change OTP', { userId: user.id, message: err.message });
    });

    res.json({ message: 'Verification code sent to your current email' });
  } catch (err) {
    next(err);
  }
});

router.post('/change-email/verify-current', authenticateToken, async (req, res, next) => {
  try {
    const parsed = changeEmailOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid 6-digit code required' });
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.id, deletedAt: null } });
    if (!user?.emailChangeCurrentOtpHash || !user.emailChangeCurrentOtpExpiry) {
      return res.status(400).json({ error: 'Request a new code first' });
    }
    if (user.emailChangeCurrentOtpExpiry < new Date()) {
      return res.status(400).json({ error: 'Code expired — request a new one' });
    }
    if (hashTokenSha256(parsed.data.otp) !== user.emailChangeCurrentOtpHash) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailChangeCurrentVerified: true,
        emailChangeCurrentOtpHash: null,
        emailChangeCurrentOtpExpiry: null,
      },
    });

    res.json({ message: 'Current email verified' });
  } catch (err) {
    next(err);
  }
});

router.post('/change-email/confirm', authenticateToken, async (req, res, next) => {
  try {
    const parsed = changeEmailConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid new email required' });
    }
    const { new_email, otp } = parsed.data;
    const user = await prisma.user.findUnique({ where: { id: req.user.id, deletedAt: null } });
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.emailChangeCurrentVerified) {
      return res.status(400).json({ error: 'Verify your current email first' });
    }
    if (new_email.toLowerCase() === user.email.toLowerCase()) {
      return res.status(400).json({ error: 'New email must differ from your current email' });
    }

    const existing = await prisma.user.findFirst({
      where: { email: new_email, deletedAt: null, NOT: { id: user.id } },
    });
    if (existing) {
      return res.status(400).json({ error: 'That email is already in use' });
    }

    if (!otp) {
      const newOtp = generateOtp6();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          emailChangeNewEmail: new_email,
          emailChangeNewOtpHash: hashTokenSha256(newOtp),
          emailChangeNewOtpExpiry: new Date(Date.now() + 10 * 60 * 1000),
        },
      });
      sendEmailChangeOtpEmail(new_email, newOtp, { target: 'new' }).catch((err) => {
        logger.error('Failed to send new email OTP', { userId: user.id, message: err.message });
      });
      return res.json({ message: 'Verification code sent to your new email' });
    }

    if (!user.emailChangeNewOtpHash || !user.emailChangeNewOtpExpiry || user.emailChangeNewEmail?.toLowerCase() !== new_email.toLowerCase()) {
      return res.status(400).json({ error: 'Send a code to your new email first' });
    }
    if (user.emailChangeNewOtpExpiry < new Date()) {
      return res.status(400).json({ error: 'Code expired — request a new one' });
    }
    if (hashTokenSha256(otp) !== user.emailChangeNewOtpHash) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        email: new_email,
        emailVerified: true,
        ...clearEmailChangeState(),
      },
    });

    await audit({
      userId: user.id,
      action: 'EMAIL_CHANGED',
      entityType: 'user',
      entityId: user.id,
      metadata: { new_email },
      ipAddress: getIp(req),
    });

    res.json({ message: 'Email updated successfully', email: new_email });
  } catch (err) {
    next(err);
  }
});

// ── Get Current User ──────────────────────────────────────────────────────

router.get('/me', async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const payload = jwt.verify(token, JWT_ACCESS_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId, deletedAt: null },
    });
    if (!user) return res.status(401).json({ error: 'User not found' });
    const vStatus = await readVerificationStatusCompat(user.id);
    const canAdminDashboard = await canAccessAdminDashboard(user);
    await ensureIdentityReminderNotification(user.id, vStatus);

    let userProfile = null;
    try {
      const p = await prisma.userProfile.findUnique({ where: { userId: user.id } });
      userProfile = formatUserProfileForMe(user, p);
    } catch {
      userProfile = null;
    }

    res.json(
      userPayload(user, {
        verification_status: vStatus,
        identity_verified: isIdentityVerifiedStatus(vStatus),
        can_admin_dashboard: canAdminDashboard,
        user_profile: userProfile,
      }),
    );
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// ── Account Deletion (App Store requirement — MANDATORY) ─────────────────
// Hard delete removes the user row so (email, role) and username can be re-registered.
// SECURITY: Single transaction — audit row, revoke sessions, clear orphan FK rows, delete user.

router.delete('/account', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.userId;

    const existing = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, role: true }
    });
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.auditLog.create({
          data: {
            userId,
            action: 'ACCOUNT_DELETED',
            resource: 'user',
            resourceId: userId,
            details: { email: existing.email, role: existing.role, hardDelete: true },
            ipAddress: getIp(req)
          }
        });

        await tx.refreshToken.deleteMany({ where: { userId } });
        await deleteUserOrphans(tx, userId);
        await tx.user.delete({ where: { id: userId } });
      },
      { maxWait: 20000, timeout: 120000 }
    );

    res.json({ success: true, message: 'Account deleted. We are sorry to see you go.' });
  } catch (err) {
    next(err);
  }
});

export default router;
