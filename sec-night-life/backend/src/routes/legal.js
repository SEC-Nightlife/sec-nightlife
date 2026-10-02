import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();
const SUPPORT_CONTACT_EMAIL = process.env.SUPPORT_CONTACT_EMAIL || 'support@secnightlife.com';
const ADMIN_CONTACT_EMAIL = process.env.ADMIN_CONTACT_EMAIL || 'admin@secnightlife.com';
const APP_PUBLIC_URL = String(process.env.APP_URL || 'https://secnightlife.com').replace(/\/+$/, '');

/**
 * Lawyer-reviewed legal copy lives on the frontend pages.
 * This API exposes metadata + canonical public URLs (no stub body text).
 */
const LEGAL_DOCS = {
  privacy_policy: {
    type: 'PRIVACY_POLICY',
    title: 'Privacy Policy',
    version: '1.0',
    effectiveDate: '2026-04-01',
    path: '/PrivacyPolicy',
  },
  terms_of_service: {
    type: 'TERMS_OF_SERVICE',
    title: 'Terms of Service',
    version: '1.1',
    effectiveDate: '2026-10-02',
    path: '/TermsOfService',
  },
  cookie_policy: {
    type: 'COOKIE_POLICY',
    title: 'Cookie Policy',
    version: '1.0',
    effectiveDate: '2026-04-01',
    path: '/CookiePolicy',
  },
  promoter_code_of_conduct: {
    type: 'PROMOTER_CODE_OF_CONDUCT',
    title: 'Promoter Code of Conduct',
    version: '1.1',
    effectiveDate: '2026-06-08',
    path: '/PromoterCodeOfConduct',
  },
  age_verification_declaration: {
    type: 'AGE_VERIFICATION_DECLARATION',
    title: 'Age Verification Declaration',
    version: '1.0',
    effectiveDate: '2026-06-01',
    path: '/AgeVerificationDeclaration',
  },
  user_agreement: {
    type: 'USER_AGREEMENT',
    title: 'User Agreement',
    version: '1.0',
    effectiveDate: '2026-04-01',
    path: '/UserAgreement',
  },
  refund_policy: {
    type: 'REFUND_POLICY',
    title: 'Refund Policy',
    version: '1.1',
    effectiveDate: '2026-10-02',
    path: '/RefundPolicy',
  },
  community_guidelines: {
    type: 'COMMUNITY_GUIDELINES',
    title: 'Community Guidelines',
    version: '1.0',
    effectiveDate: '2026-04-01',
    path: '/CommunityGuidelines',
  },
};

function docPayload(key) {
  const meta = LEGAL_DOCS[key];
  return {
    documentKey: key,
    documentType: meta.type,
    title: meta.title,
    version: meta.version,
    effectiveDate: meta.effectiveDate,
    publicUrl: `${APP_PUBLIC_URL}${meta.path}`,
    sourceOfTruth: 'frontend',
    contact: {
      support: SUPPORT_CONTACT_EMAIL,
      admin: ADMIN_CONTACT_EMAIL,
    },
  };
}

function isMissingAcceptanceSchema(err) {
  return err?.code === 'P2022' || err?.code === 'P2021';
}

router.get('/privacy-policy', (req, res) => {
  res.json(docPayload('privacy_policy'));
});

router.get('/terms-of-service', (req, res) => {
  res.json(docPayload('terms_of_service'));
});

router.get('/cookie-policy', (req, res) => {
  res.json(docPayload('cookie_policy'));
});

router.get('/age-verification-declaration', (req, res) => {
  res.json(docPayload('age_verification_declaration'));
});

router.get('/user-agreement', (req, res) => {
  res.json(docPayload('user_agreement'));
});

router.get('/refund-policy', (req, res) => {
  res.json(docPayload('refund_policy'));
});

router.get('/community-guidelines', (req, res) => {
  res.json(docPayload('community_guidelines'));
});

router.get('/promoter-code-of-conduct', (req, res) => {
  res.json(docPayload('promoter_code_of_conduct'));
});

router.get('/documents', (_req, res) => {
  res.json({
    documents: Object.keys(LEGAL_DOCS).map((key) => docPayload(key)),
  });
});

router.get('/acceptance-status', authenticateToken, async (req, res, next) => {
  try {
    const rows = await prisma.legalDocumentAcceptance.findMany({
      where: { userId: req.userId },
      orderBy: { acceptedAt: 'desc' },
      select: { documentType: true, version: true, acceptedAt: true },
    });
    const latest = {};
    for (const row of rows) {
      if (!latest[row.documentType]) latest[row.documentType] = row;
    }
    res.json({ latest });
  } catch (err) {
    if (isMissingAcceptanceSchema(err)) return res.json({ latest: {}, pendingMigration: true });
    next(err);
  }
});

router.post('/acceptances', authenticateToken, async (req, res, next) => {
  try {
    const schema = z.object({
      document_key: z.enum([
        'privacy_policy',
        'terms_of_service',
        'promoter_code_of_conduct',
        'age_verification_declaration',
        'cookie_policy',
        'user_agreement',
        'refund_policy',
        'community_guidelines',
      ]),
      version: z.string().min(1).max(30),
    });
    const parsed = schema.parse(req.body || {});
    const docMeta = LEGAL_DOCS[parsed.document_key];
    if (!docMeta?.type) {
      return res.status(400).json({ error: 'Unknown document' });
    }
    // Only enum-backed types can be stored; others acknowledge without DB row
    const storable = new Set([
      'PRIVACY_POLICY',
      'TERMS_OF_SERVICE',
      'PROMOTER_CODE_OF_CONDUCT',
      'AGE_VERIFICATION_DECLARATION',
    ]);
    if (!storable.has(docMeta.type)) {
      return res.status(201).json({
        acknowledged: true,
        documentType: docMeta.type,
        version: parsed.version,
        stored: false,
      });
    }
    const created = await prisma.legalDocumentAcceptance.create({
      data: {
        userId: req.userId,
        documentType: docMeta.type,
        version: parsed.version,
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      },
    });
    res.status(201).json({
      id: created.id,
      documentType: created.documentType,
      version: created.version,
      acceptedAt: created.acceptedAt,
      stored: true,
    });
  } catch (err) {
    if (isMissingAcceptanceSchema(err)) {
      return res.status(503).json({ error: 'Legal acceptance storage is temporarily unavailable. Please try again shortly.' });
    }
    next(err);
  }
});

export default router;
