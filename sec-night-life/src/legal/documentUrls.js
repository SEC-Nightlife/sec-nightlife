/** Must match backend `LEGAL_DOCS` versions in `backend/src/routes/legal.js` for acceptance POSTs */
export const LEGAL_ACCEPT_VERSION = {
  termsOfService: '1.1',
  privacyPolicy: '1.0',
};

/** In-app routes (pages.config keys) for legal pages */
export const LEGAL_PAGE = {
  termsOfService: 'TermsOfService',
  privacyPolicy: 'PrivacyPolicy',
  cookiePolicy: 'CookiePolicy',
  promoterCodeOfConduct: 'PromoterCodeOfConduct',
  userAgreement: 'UserAgreement',
  communityGuidelines: 'CommunityGuidelines',
  gbvConsequences: 'GbvConsequences',
  refundPolicy: 'RefundPolicy',
  venueComplianceCharter: 'VenueComplianceCharter',
};
