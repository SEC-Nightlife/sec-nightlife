/** Screenshot routes for App Store / Play Store launch capture. */

export const VIEWPORT = { width: 390, height: 844 };
export const DEVICE_SCALE_FACTOR = 3;

export const PRODUCTION_URL = 'https://secnightlife.com';
export const PRODUCTION_API_URL = 'https://api.secnightlife.com';

/** Business owner — store submission screenshots */
export const BUSINESS_SCREENSHOTS = [
  { file: '01-dashboard.png', path: '/BusinessDashboard', label: 'Business dashboard', waitForSelector: 'h1, h2' },
  { file: '02-analytics.png', path: '/VenueAnalytics', label: 'Analytics', waitForSelector: 'h1, h2' },
  { file: '03-bookings.png', path: '/BusinessBookings', label: 'Bookings', waitForSelector: 'h1, h2' },
  {
    file: '04-menu-food.png',
    path: '/BusinessMenu',
    label: 'Menu — Food tab',
    waitForSelector: 'h1, h2',
    beforeScreenshot: async (page) => {
      const foodTab = page.getByRole('button', { name: 'Food' });
      await foodTab.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await foodTab.click().catch(() => {});
      await page.waitForTimeout(800);
    },
  },
  { file: '05-promotions.png', path: '/BusinessPromotions', label: 'Promotions', waitForSelector: 'h1, h2' },
  { file: '06-venue-tables.png', path: '/BusinessVenueTables', label: 'Venue tables', waitForSelector: 'h1, h2' },
  { file: '07-jobs.png', path: '/BusinessJobs', label: 'Business jobs', waitForSelector: 'h1, h2' },
];

/** Party-goer — authenticated store submission screenshots */
export const PARTY_AUTH_SCREENSHOTS = [
  { file: '01-home.png', path: '/Home', label: 'Home', waitForSelector: 'nav.lg\\:hidden' },
  { file: '02-profile.png', path: '/Profile', label: 'Profile', waitForSelector: 'h1, h2, [role="tablist"]' },
  { file: '03-messages.png', path: '/Messages', label: 'Messages', waitForSelector: 'h1, h2' },
  { file: '04-notifications.png', path: '/Notifications', label: 'Notifications', waitForSelector: 'h1, h2' },
  { file: '05-friends.png', path: '/Friends', label: 'Friends', waitForSelector: 'h1, h2' },
  { file: '06-host-dashboard.png', path: '/HostDashboard', label: 'Host dashboard', waitForSelector: 'h1, h2' },
  { file: '07-jobs.png', path: '/Jobs', label: 'Jobs browse', waitForSelector: 'h1, h2' },
  { file: '08-leaderboard.png', path: '/Leaderboard', label: 'Promoters leaderboard', waitForSelector: 'h1, h2' },
];

/** Legal pages exported for store submission (Settings → Support) */
export const LEGAL_PAGES = [
  { slug: 'UserAgreement', file: 'user-agreement', title: 'User Agreement' },
  { slug: 'TermsOfService', file: 'terms-of-service', title: 'Terms of Service' },
  { slug: 'PrivacyPolicy', file: 'privacy-policy', title: 'Privacy Policy' },
  { slug: 'CommunityGuidelines', file: 'community-guidelines', title: 'Community Guidelines' },
  { slug: 'GbvConsequences', file: 'gbv-consequences', title: 'GBV Consequences' },
  { slug: 'RefundPolicy', file: 'refund-policy', title: 'Refund Policy' },
  { slug: 'VenueComplianceCharter', file: 'venue-compliance-charter', title: 'Venue Compliance Charter' },
  { slug: 'PromoterCodeOfConduct', file: 'promoter-code-of-conduct', title: 'Promoter Code of Conduct' },
  { slug: 'AgeVerificationDeclaration', file: 'age-verification-declaration', title: 'Age Verification Declaration' },
];
