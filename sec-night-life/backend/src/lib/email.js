import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Resend } from 'resend';
import { logger } from './logger.js';
import { SEC_EMAIL_LOGO_PNG_BASE64 } from './secEmailLogoBase64.js';

const SEC_EMAIL_LOGO_PATH = '/Logo/sec-email-logo-transparent.png';
const SEC_EMAIL_LOGO_CID = 'sec-email-logo';
const __emailDir = path.dirname(fileURLToPath(import.meta.url));

function getFromAddress() {
  return process.env.EMAIL_FROM || 'noreply@secnightlife.com';
}

function createResendClient() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  return new Resend(process.env.RESEND_API_KEY);
}

/** Public SPA origin for links/assets. Prefer www — apex redirects break many email clients. */
function getPublicAppBaseUrl() {
  const raw = (
    process.env.PUBLIC_ASSET_URL ||
    process.env.APP_URL ||
    'https://www.secnightlife.com'
  ).trim();
  let url = raw.replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'secnightlife.com') {
      parsed.hostname = 'www.secnightlife.com';
      url = parsed.origin;
    }
  } catch {
    /* keep raw */
  }
  return url;
}

function loadSecEmailLogoBuffer() {
  const candidates = [
    path.resolve(__emailDir, '../../assets/sec-email-logo-transparent.png'),
    path.resolve(process.cwd(), 'assets/sec-email-logo-transparent.png'),
    path.resolve(process.cwd(), '../public/Logo/sec-email-logo-transparent.png'),
    path.resolve(process.cwd(), 'public/Logo/sec-email-logo-transparent.png'),
  ];
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
    } catch {
      /* try next */
    }
  }
  if (SEC_EMAIL_LOGO_PNG_BASE64) {
    return Buffer.from(SEC_EMAIL_LOGO_PNG_BASE64, 'base64');
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTextAsHtml(text = '') {
  return String(text)
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 12px;line-height:1.6;">${escapeHtml(block).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

function withSecEmailBrandingText(innerHtml) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0f1011;color:#e9ecef;border:1px solid #232528;border-radius:16px;overflow:hidden;">
      <div style="padding:20px 20px 14px;border-bottom:1px solid #232528;background:#0b0c0d;">
        <div style="font-size:18px;font-weight:700;line-height:1.2;color:#ffffff;">SEC Nightlife</div>
        <div style="font-size:12px;line-height:1.4;color:#9aa0a6;">Your night. Simplified.</div>
      </div>
      <div style="padding:20px;background:#111315;color:#e9ecef;">
        ${innerHtml}
      </div>
    </div>
  `;
}

function withSecEmailBranding(innerHtml, { logoSrc }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0f1011;color:#e9ecef;border:1px solid #232528;border-radius:16px;overflow:hidden;">
      <div style="padding:20px 20px 14px;border-bottom:1px solid #232528;background:#0b0c0d;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align:middle;padding:0;">
              <img src="${logoSrc}" alt="SEC logo" width="64" height="64" style="display:block;width:64px;height:64px;border:0;outline:0;" />
            </td>
            <td style="vertical-align:middle;padding:0 0 0 12px;">
              <div style="font-size:18px;font-weight:700;line-height:1.2;color:#ffffff;">SEC Nightlife</div>
              <div style="font-size:12px;line-height:1.4;color:#9aa0a6;">Your night. Simplified.</div>
            </td>
          </tr>
        </table>
      </div>
      <div style="padding:20px;background:#111315;color:#e9ecef;">
        ${innerHtml}
      </div>
    </div>
  `;
}

function prepareEmailPayload({ html, text, attachments, skipLogo = false }) {
  const bodyHtml = html || formatTextAsHtml(text || '');
  const logoBuffer = skipLogo ? null : loadSecEmailLogoBuffer();
  const remoteLogoUrl = `${getPublicAppBaseUrl()}${SEC_EMAIL_LOGO_PATH}`;
  const logoSrc = logoBuffer ? `cid:${SEC_EMAIL_LOGO_CID}` : remoteLogoUrl;
  const brandedHtml = bodyHtml
    ? (skipLogo ? withSecEmailBrandingText(bodyHtml) : withSecEmailBranding(bodyHtml, { logoSrc }))
    : undefined;

  const nextAttachments = Array.isArray(attachments) ? [...attachments] : [];
  if (logoBuffer) {
    const alreadyAttached = nextAttachments.some(
      (a) => a?.contentId === SEC_EMAIL_LOGO_CID || a?.inlineContentId === SEC_EMAIL_LOGO_CID,
    );
    if (!alreadyAttached) {
      nextAttachments.unshift({
        filename: 'sec-email-logo-transparent.png',
        content: logoBuffer,
        contentId: SEC_EMAIL_LOGO_CID,
      });
    }
  }

  return {
    html: brandedHtml,
    text,
    attachments: nextAttachments,
  };
}

/**
 * @param {object} params
 * @param {string} params.to
 * @param {string} params.subject
 * @param {string} [params.html]
 * @param {string} [params.text]
 * @param {Array<{ filename: string, content: string | Buffer, contentId?: string }>} [params.attachments] Inline images: set contentId → HTML uses src="cid:contentId" (Resend: inlineContentId)
 * @param {boolean} [params.skipLogo] Omit the inline SEC logo. Verification and sign-in mail keep the logo.
 */
const suppressionCache = { at: 0, emails: new Set() };

/** Hard-bounced addresses are on Resend's suppression list. A later send is accepted and then dropped. */
export async function recipientIsSuppressed(to) {
  const email = String(to || '').trim().toLowerCase();
  if (!email || !process.env.RESEND_API_KEY) return false;
  const now = Date.now();
  if (now - suppressionCache.at > 60_000) {
    try {
      const res = await fetch('https://api.resend.com/suppressions', {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      });
      const body = await res.json().catch(() => ({}));
      const emails = new Set(
        (Array.isArray(body?.data) ? body.data : [])
          .map((row) => String(row?.email || '').trim().toLowerCase())
          .filter(Boolean),
      );
      suppressionCache.at = now;
      suppressionCache.emails = emails;
    } catch (err) {
      logger.warn('suppression lookup failed', { err: err?.message });
      return false;
    }
  }
  return suppressionCache.emails.has(email);
}

function suppressedSendError() {
  const err = new Error(
    'We cannot email this address. A previous message bounced, which usually means the mailbox does not exist or the address was mistyped.',
  );
  err.code = 'EMAIL_SUPPRESSED';
  return err;
}

export async function sendEmail({ to, subject, html, text, attachments, skipLogo = false }) {
  if (await recipientIsSuppressed(to)) {
    logger.warn('Email blocked: address is suppressed after a bounce', { to, subject });
    throw suppressedSendError();
  }
  const resend = createResendClient();
  const from = getFromAddress();
  const prepared = prepareEmailPayload({ html, text, attachments, skipLogo });
  const payload = { from, to, subject, html: prepared.html, text: prepared.text };
  if (prepared.attachments?.length) {
    payload.attachments = prepared.attachments.map((a) => {
      const content =
        typeof a.content === 'string'
          ? a.content
          : Buffer.isBuffer(a.content)
            ? a.content
            : Buffer.from(String(a.content), 'base64');
      const row = { filename: a.filename, content };
      if (a.contentId) row.inlineContentId = a.contentId;
      return row;
    });
  }
  const result = await resend.emails.send(payload);
  if (result?.error) {
    logger.error('Resend API error', { to, subject, error: result.error });
    const err = new Error(result.error.message || 'Email delivery failed');
    err.code = 'EMAIL_SEND_FAILED';
    throw err;
  }
  logger.info('Email sent via Resend', { to, subject, id: result?.data?.id });
}

export async function sendBulkEmails(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  await Promise.all(messages.map((m) => sendEmail(m)));
}

export async function sendVerificationEmail(to, token) {
  const baseUrl = getPublicAppBaseUrl();
  const link = `${baseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const safeLink = escapeHtml(link);
  await sendEmail({
    to,
    subject: 'Verify your SEC Nightlife account',
    text: `Verify your SEC Nightlife account.\n\nOpen this link. It expires in 24 hours:\n${link}\n\nIf you did not create an account, ignore this email.`,
    html: `
      <h2 style="margin:0 0 12px;font-size:20px;color:#ffffff;">Verify your email</h2>
      <p style="margin:0 0 16px;">Open this link to verify your SEC Nightlife account. It expires in 24 hours.</p>
      <p style="margin:0 0 16px;"><a href="${safeLink}" style="color:#8cf;word-break:break-all;">${safeLink}</a></p>
      <p style="margin:0;font-size:12px;color:#9aa0a6;">If you did not create an account, ignore this email.</p>
    `,
  });
}

export async function sendPasswordResetEmail(to, token) {
  const baseUrl = getPublicAppBaseUrl();
  const link = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to,
    subject: 'Reset your SEC Nightlife password',
    text: `Reset your password by clicking the link below:\n${link}\n\nThis link expires in 1 hour.\n\nIf you did not request a password reset, ignore this email.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#fff;background:#111;padding:24px;margin:0;">SEC Nightlife</h2>
        <div style="padding:24px;background:#1a1a1a;color:#e0e0e0;">
          <h3>Reset your password</h3>
          <p>Click the button below to reset your password. This link expires in <strong>1 hour</strong>.</p>
          <a href="${link}" style="display:inline-block;padding:12px 28px;background:#fff;color:#000;font-weight:700;border-radius:6px;text-decoration:none;margin:16px 0;">
            Reset Password
          </a>
          <p style="font-size:12px;color:#888;">Or copy this link: ${link}</p>
          <p style="font-size:12px;color:#666;">If you did not request this, ignore this email.</p>
        </div>
      </div>
    `
  });
}

export async function sendLoginOtpEmail(to, otp) {
  await sendEmail({
    to,
    subject: 'Your SEC Nightlife sign-in code',
    text: `Your SEC Nightlife sign-in code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not try to sign in, ignore this email and consider changing your password.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#fff;background:#111;padding:24px;margin:0;">SEC Nightlife</h2>
        <div style="padding:24px;background:#1a1a1a;color:#e0e0e0;">
          <h3>Sign-in verification code</h3>
          <p>Enter this code to complete signing in:</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:0.2em;color:#fff;">${escapeHtml(otp)}</p>
          <p style="font-size:12px;color:#888;">Expires in 10 minutes.</p>
          <p style="font-size:12px;color:#666;">If you did not try to sign in, ignore this email.</p>
        </div>
      </div>
    `,
  });
}

export async function sendEmailChangeOtpEmail(to, otp, { target = 'current' } = {}) {
  const label = target === 'new' ? 'new email address' : 'current email address';
  await sendEmail({
    to,
    subject: 'SEC email change verification code',
    text: `Your SEC email change verification code is: ${otp}\n\nThis code expires in 10 minutes and was requested for your ${label}.\n\nIf you did not request this, ignore this email.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#fff;background:#111;padding:24px;margin:0;">SEC Nightlife</h2>
        <div style="padding:24px;background:#1a1a1a;color:#e0e0e0;">
          <h3>Email change verification</h3>
          <p>Enter this code in the app to verify your ${label}:</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:0.2em;color:#fff;">${escapeHtml(otp)}</p>
          <p style="font-size:12px;color:#888;">Expires in 10 minutes.</p>
        </div>
      </div>
    `,
  });
}

export async function sendAdminDashboardAlertEmail({
  to,
  subject,
  body,
  ctaLabel = 'Open Admin Dashboard',
  dashboardPath = '/AdminDashboard',
}) {
  const baseUrl = getPublicAppBaseUrl();
  const link = `${baseUrl}${dashboardPath.startsWith('/') ? dashboardPath : `/${dashboardPath}`}`;
  const safeBody = escapeHtml(body);
  await sendEmail({
    to,
    subject,
    text: `${body}\n\n${ctaLabel}: ${link}`,
    html: `
      <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:#ffffff;">${escapeHtml(subject)}</p>
      <p style="margin:0 0 16px;line-height:1.6;color:#e9ecef;white-space:pre-wrap;">${safeBody}</p>
      <a href="${link}" style="display:inline-block;padding:12px 22px;background:linear-gradient(135deg,#A8A8A8 0%,#D8D8D8 40%,#A0A0A0 70%,#C8C8C8 100%);color:#0A0A0B;font-weight:700;border-radius:999px;text-decoration:none;">
        ${escapeHtml(ctaLabel)}
      </a>
      <p style="font-size:12px;color:#9aa0a6;margin:16px 0 0;">${link}</p>
    `,
  });
}

export async function sendIdVerificationApprovedEmail(to, fullName) {
  const baseUrl = process.env.APP_URL || 'http://localhost:5173';
  const link = `${baseUrl}/EditProfile`;
  const name = (fullName || '').trim() || 'there';
  await sendEmail({
    to,
    subject: 'Your SEC ID verification was approved',
    text: `Hi ${name},\n\nGreat news — your ID verification has been approved. You can now access verified-only actions in SEC Nightlife.\n\nOpen your profile settings here: ${link}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#fff;background:#111;padding:24px;margin:0;">SEC Nightlife</h2>
        <div style="padding:24px;background:#1a1a1a;color:#e0e0e0;">
          <h3>ID verification approved</h3>
          <p>Hi <strong>${name}</strong>,</p>
          <p>Your identity document has been approved. You now have access to verified features.</p>
          <a href="${link}" style="display:inline-block;padding:12px 28px;background:#fff;color:#000;font-weight:700;border-radius:6px;text-decoration:none;margin:16px 0;">
            Open Edit Profile
          </a>
          <p style="font-size:12px;color:#888;">Or copy this link: ${link}</p>
        </div>
      </div>
    `
  });
}
