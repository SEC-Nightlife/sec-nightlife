/** Mobile hub pages that keep the floating bottom nav (no drill-down back header from Layout). */
export const MOBILE_NAV_ROOT_PAGES = new Set(['Home', 'BusinessDashboard', 'StaffDashboard']);

/** Pages where the bottom nav must stay hidden (auth, onboarding, heavy forms). */
export const MOBILE_NAV_HIDDEN_PAGES = new Set([
  'Onboarding',
  'ProfileSetup',
  'VenueOnboarding',
  'Welcome',
  'Login',
  'Register',
  'ResetPassword',
  'VerifyEmail',
  'ForgotPassword',
  'PaymentSuccess',
  'TicketSuccess',
  'TicketVerify',
  'TableJoinOnboarding',
  'CreateTable',
  'CreateHostEvent',
  'EditProfile',
]);

/** Pages that already render their own mobile back header (avoid duplicate). */
export const MOBILE_OWN_BACK_HEADER = new Set([
  'Messages',
  'BusinessMessages',
  'EventDetails',
  'TableDetails',
  'JobDetails',
  'ChatRoom',
  'ManageTable',
  'TablePayment',
  'TableJoinOnboarding',
  'Friends',
  'Settings',
  'HelpCenter',
  'HelpGuides',
  'HelpArticle',
  'Privacy',
  'CreateJob',
  'AppPreferences',
  'ChangePassword',
  'ChangeEmail',
  'BusinessEvents',
  'BusinessJobs',
  'BusinessBookings',
  'BusinessRefundRequests',
  'BusinessMenu',
  'BusinessPromotions',
  'BusinessVenueTables',
  'BusinessVenueSeatingPlans',
  'VenueAnalytics',
  'FeedbackInsights',
  'StaffDashboard',
  'HostDashboard',
  'Profile',
  'EditProfile',
  'UserProfile',
  'VenueProfile',
  'MyJobApplications',
  'PromoterCodeOfConduct',
  'EditProfile',
  'VenueOnboarding',
  'ProfileSetup',
  'EventHostTables',
  'VenueBook',
  'CreateTable',
  'CreateHostEvent',
  'HostEventDetails',
  'BusinessPromotionBoost',
  'Payments',
  'CelebrationRequest',
  'AgeVerificationDeclaration',
  'AdminDashboard',
  'Notifications',
  'Events',
  'Jobs',
  'Vendors',
  'VendorDetail',
  'VendorBusinessSettings',
  'Explore',
  'Tables',
  'Map',
  'Leaderboard',
]);

const AUTH_FLOW_PAGES = new Set([
  'Onboarding',
  'ProfileSetup',
  'VenueOnboarding',
  'Welcome',
  'Login',
  'Register',
  'ResetPassword',
  'VerifyEmail',
  'ForgotPassword',
  'PaymentSuccess',
  'TicketSuccess',
  'TicketVerify',
]);

export const MOBILE_PAGE_TITLES = {
  Events: 'Events',
  Jobs: 'Jobs',
  Vendors: 'Vendors',
  VendorDetail: 'Vendor',
  VendorBusinessSettings: 'My vendor businesses',
  Notifications: 'Notifications',
  Leaderboard: 'Leaderboard',
  Explore: 'Explore',
  Map: 'Map',
  Tables: 'Tables',
  AdminDashboard: 'Admin',
  CommunityGuidelines: 'Community Guidelines',
  TermsOfService: 'Terms of Service',
  PrivacyPolicy: 'Privacy Policy',
  UserAgreement: 'User Agreement',
  RefundPolicy: 'Refund Policy',
  GbvConsequences: 'GBV Consequences',
  VenueComplianceCharter: 'Compliance Charter',
};

export function shouldShowMobileBackHeader(pageName) {
  if (!pageName) return false;
  if (MOBILE_NAV_ROOT_PAGES.has(pageName)) return false;
  if (MOBILE_OWN_BACK_HEADER.has(pageName)) return false;
  if (AUTH_FLOW_PAGES.has(pageName)) return false;
  return true;
}

/**
 * Pages that already paint env(safe-area-inset-top) in their own header.
 * The shell must not add a second top inset on these.
 */
const PAGES_WITH_OWN_STATUS_INSET = new Set([
  'Home',
  'Events',
  'Jobs',
  'Explore',
  'Tables',
  'VendorDetail',
  'TableJoinOnboarding',
  'HostDashboard',
  'Login',
  'TicketVerify',
  'Messages',
  'BusinessMessages',
  'Vendors',
  'VendorBusinessSettings',
  'Notifications',
  'JobDetails',
  'ChatRoom',
  'Friends',
  'Settings',
  'HelpCenter',
  'HelpGuides',
  'HelpArticle',
  'Privacy',
  'CreateJob',
  'AppPreferences',
  'ChangePassword',
  'ChangeEmail',
  'BusinessEvents',
  'BusinessJobs',
  'BusinessBookings',
  'BusinessRefundRequests',
  'BusinessMenu',
  'BusinessPromotions',
  'BusinessVenueTables',
  'BusinessVenueSeatingPlans',
  'VenueAnalytics',
  'FeedbackInsights',
  'StaffDashboard',
  'Profile',
  'UserProfile',
  'VenueOnboarding',
  'TicketCheckout',
  'EventEntranceCheckout',
]);

export function pageDrawsOwnStatusBarPadding(pageName, showLayoutBackHeader) {
  if (showLayoutBackHeader) return true;
  return PAGES_WITH_OWN_STATUS_INSET.has(pageName);
}

export function getMobilePageTitle(pageName) {
  if (!pageName) return '';
  return MOBILE_PAGE_TITLES[pageName] || pageName.replace(/([A-Z])/g, ' $1').trim();
}
