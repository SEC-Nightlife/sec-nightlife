import { refundsPartygoer, refundsVenue, payouts } from './content/refunds-payouts';
import {
  vendorsOverview,
  vendorsBecome,
  vendorReviewsArticle,
  vendorHiringArticle,
  jobsVenue,
  jobsPartygoer,
} from './content/vendors-jobs';
import {
  minimumSpend,
  automaticGroups,
  customTablesPartygoer,
  customTablesVenue,
  hostJoinTable,
} from './content/tables';
import {
  createEvent,
  tableDayBookings,
  promotions,
  boostTablesEvents,
  removeFromListings,
} from './content/venue-ops';
import {
  hostCreateEvent,
  hostListExternalTable,
  afterPurchase,
  verifiedPromoter,
  partygoerGettingStarted,
  ticketsQr,
  secWalletPartygoer,
  venueGettingStarted,
  venueStaffPermissions,
} from './content/partygoer-host';

/** @type {import('./types').HelpArticle[]} */
export const HELP_ARTICLES = [
  partygoerGettingStarted,
  venueGettingStarted,
  ticketsQr,
  secWalletPartygoer,
  refundsPartygoer,
  refundsVenue,
  payouts,
  afterPurchase,
  minimumSpend,
  automaticGroups,
  hostJoinTable,
  customTablesPartygoer,
  customTablesVenue,
  hostCreateEvent,
  hostListExternalTable,
  createEvent,
  tableDayBookings,
  removeFromListings,
  promotions,
  boostTablesEvents,
  vendorsOverview,
  vendorsBecome,
  vendorHiringArticle,
  vendorReviewsArticle,
  jobsPartygoer,
  jobsVenue,
  verifiedPromoter,
  venueStaffPermissions,
];

const byId = Object.fromEntries(HELP_ARTICLES.map((a) => [a.id, a]));

export function getHelpArticle(id) {
  if (!id) return null;
  return byId[id] || null;
}

/**
 * @param {'partygoer' | 'venue'} audience
 */
export function getArticlesForAudience(audience) {
  return HELP_ARTICLES.filter(
    (a) => a.audience === audience || a.audience === 'both'
  );
}

export function articleMatchesAudience(article, audience) {
  return article.audience === audience || article.audience === 'both';
}
