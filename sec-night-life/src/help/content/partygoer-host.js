import { HELP_FACTS as F } from '../facts';

export const hostCreateEvent = {
  id: 'host-create-event',
  audience: 'partygoer',
  category: 'events',
  title: 'Create your own event (Host Dashboard)',
  summary: `List an event at your own place (or a non-SEC venue) with a R${F.externalListingZar} listing fee.`,
  readMinutes: 6,
  keywords: ['host dashboard', 'own event', 'external venue', 'R200', 'house party'],
  sections: [
    {
      type: 'p',
      text: `Party-goers use Host Dashboard to create EXTERNAL_VENUE listings — your own place or a venue not registered on SEC. Choose List as Event so it appears under Upcoming Events. Pay a one-time R${F.externalListingZar} listing fee to go live. You can optionally charge guests a joining fee.`,
    },
    {
      type: 'steps',
      items: [
        'Open Host Dashboard (create flow / tables tab).',
        'Choose List as Event (not Table).',
        'Enter title, address, start/end date & time, and details.',
        'Set optional joining fee and privacy (public vs approval).',
        'Pay the R200 listing fee — the listing stays draft until payment completes.',
        'Manage guests from Host Dashboard once live.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/host-dashboard-create.svg',
      alt: 'Host Dashboard create event',
      caption: 'Create from Host Dashboard — List as Event.',
      path: 'Host Dashboard → Create',
      illustrative: true,
    },
    {
      type: 'callout',
      title: 'Note',
      text: 'Official venue events are created by the venue on Business Events. This flow is for your own / unregistered place listings.',
    },
    {
      type: 'related',
      ids: ['host-list-external-table', 'after-purchase', 'automatic-groups', 'boost-tables-events'],
    },
  ],
};

export const hostListExternalTable = {
  id: 'host-list-external-table',
  audience: 'partygoer',
  category: 'tables',
  title: 'List a table from a venue not on SEC',
  summary: `Use Host Dashboard → List as Table to publish a table at an unregistered venue for R${F.externalListingZar}.`,
  readMinutes: 5,
  keywords: ['external table', 'unregistered venue', 'list as table', 'host dashboard'],
  sections: [
    {
      type: 'p',
      text: `If the venue is not on SEC, you can still list a table from Host Dashboard as List as Table (Available Tables surface). Provide a full address and end date/time. The listing stays draft until you pay the R${F.externalListingZar} listing fee.`,
    },
    {
      type: 'steps',
      items: [
        'Open Host Dashboard → Create.',
        'Choose List as Table.',
        'Enter location, capacity, times, and optional joining fee.',
        'Pay the listing fee to publish.',
        'Share the listing and manage joiners from Host Dashboard.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/host-list-table.svg',
      alt: 'List external table form',
      caption: 'List as Table for non-SEC venues.',
      path: 'Host Dashboard → Create → List as Table',
      illustrative: true,
    },
    {
      type: 'warning',
      title: 'Not refundable',
      text: 'The external listing fee is a platform fee and is not refundable.',
    },
    {
      type: 'related',
      ids: ['host-create-event', 'host-join-table', 'automatic-groups', 'payouts'],
    },
  ],
};

export const afterPurchase = {
  id: 'after-purchase',
  audience: 'partygoer',
  category: 'payments',
  title: 'After you purchase a ticket or table',
  summary: 'Where to find QRs, Host Dashboard, group chats, and confirmation after Paystack success.',
  readMinutes: 5,
  keywords: ['payment success', 'QR', 'tickets', 'confirmation', 'what next'],
  sections: [
    {
      type: 'p',
      text: 'After Paystack succeeds, SEC fulfills your order: tickets and/or hosted membership, QR codes, and group chat membership where applicable. You land on a success screen, then use Profile → Tickets and Host Dashboard.',
    },
    {
      type: 'heading',
      text: 'Tickets',
    },
    {
      type: 'p',
      text: 'Open Profile → Tickets for QR codes staff can scan. You may also get a confirmation email. Keep the QR ready at the door.',
    },
    {
      type: 'heading',
      text: 'Tables',
    },
    {
      type: 'p',
      text: 'If you hosted or joined a table, Host Dashboard shows your live table. Profile → Tickets holds your QR. An automatic group chat is created/updated so you can coordinate with the crew.',
    },
    {
      type: 'image',
      src: '/help/screenshots/payment-success.svg',
      alt: 'Payment success and tickets',
      caption: 'Success screen points you to Tickets and Host Dashboard.',
      path: 'After checkout → Profile → Tickets',
      illustrative: true,
    },
    {
      type: 'related',
      ids: ['tickets-qr', 'automatic-groups', 'refunds-partygoer', 'host-join-table'],
    },
  ],
};

export const verifiedPromoter = {
  id: 'verified-promoter',
  audience: 'partygoer',
  category: 'promote',
  title: 'Become a verified promoter',
  summary:
    'Get hired on Promoter jobs, accept the Code of Conduct, build ratings, then request admin verification.',
  readMinutes: 6,
  keywords: ['verified promoter', 'code of conduct', 'leaderboard', 'ref link'],
  sections: [
    {
      type: 'p',
      text: `Verified promoters get prominence on leaderboards. Path: apply to a venue Promoter job → get Hired → accept the Promoter Code of Conduct → complete milestones (about ${F.promoterJobsForVerified} accepted promoter jobs, ${F.promoterMinRatings}+ ratings from ${F.promoterMinUniqueRaters}+ unique raters) → SEC admin grants verified status.`,
    },
    {
      type: 'steps',
      items: [
        'Browse Jobs and apply to Promoter roles.',
        'When hired, open Settings / CoC prompt and accept the Promoter Code of Conduct.',
        'Share your attribution links (events with ?ref=) and deliver quality work.',
        'Build accepted jobs and ratings toward the policy milestones.',
        'Request verified status from SEC admin when eligible — admins set isVerifiedPromoter.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/promoter-coc.svg',
      alt: 'Promoter code of conduct and status',
      caption: 'Accept the Code of Conduct after you are hired as a promoter.',
      path: 'Settings / Promoter Code of Conduct',
      illustrative: true,
    },
    {
      type: 'tip',
      title: 'Tip',
      text: 'Hired promoters get venue threads for coordination. Track status from your promoter hub / Settings banners.',
    },
    {
      type: 'related',
      ids: ['jobs-partygoer', 'jobs-venue'],
    },
  ],
};

export const partygoerGettingStarted = {
  id: 'partygoer-getting-started',
  audience: 'partygoer',
  category: 'gettingStarted',
  title: 'Getting started as a party-goer',
  summary: 'Find events and tables, set up your profile, and use Host Dashboard.',
  readMinutes: 4,
  keywords: ['getting started', 'onboarding', 'home', 'profile', 'first steps'],
  sections: [
    {
      type: 'p',
      text: 'SEC Night Life helps you discover events, host or join tables, buy tickets, apply for jobs, and list vendor services. Start from Home for the feed, then explore Events, Tables, Jobs, and Vendors.',
    },
    {
      type: 'steps',
      items: [
        'Complete profile onboarding (photo, basics, optional vendor step).',
        'Browse Home for boosted events, tables, and promotions.',
        'Open an event or table → buy a ticket, host, or join.',
        'Use Host Dashboard when you want to create your own listing.',
        'Set Sec Wallet payout details if you will host or earn joining fees.',
      ],
    },
    {
      type: 'related',
      ids: ['after-purchase', 'host-join-table', 'sec-wallet-partygoer', 'tickets-qr'],
    },
  ],
};

export const ticketsQr = {
  id: 'tickets-qr',
  audience: 'partygoer',
  category: 'gettingStarted',
  title: 'Tickets & QR codes',
  summary: 'Where to find your QRs and how staff verify them at the door.',
  readMinutes: 3,
  keywords: ['QR', 'ticket', 'verify', 'door', 'profile tickets'],
  sections: [
    {
      type: 'p',
      text: 'After purchase, open Profile → Tickets to see QR codes for tickets and table entry. Venue staff scan them with Ticket Verify. If a refund is approved, related QRs are invalidated.',
    },
    {
      type: 'image',
      src: '/help/screenshots/profile-tickets.svg',
      alt: 'Tickets with QR codes',
      caption: 'All active QRs live under Profile → Tickets.',
      path: 'Profile → Tickets',
      illustrative: true,
    },
    {
      type: 'related',
      ids: ['after-purchase', 'refunds-partygoer'],
    },
  ],
};

export const secWalletPartygoer = {
  id: 'sec-wallet-partygoer',
  audience: 'partygoer',
  category: 'payments',
  title: 'Your Sec Wallet',
  summary: `Wallet code for refunds and payout details for weekly earnings payouts (every ${F.payoutDay}, minimum R${F.payoutMinZar}; bank credit may take 1–2 business days).`,
  readMinutes: 3,
  keywords: ['sec wallet', 'wallet code', 'payout', 'refund payment', 'automatic transfer', 'weekly payout', 'pending', 'bank'],
  sections: [
    {
      type: 'p',
      text: 'Your Sec Wallet holds a lookup code venues use when paying approved refunds, plus payout recipient setup for earnings (for example host joining-fee share). Once bank details are set, your earnings are paid out weekly: every Monday SEC sends one combined transfer if your balance is at least R50 (smaller balances roll over). Pending shows money owed in SEC right away; Received means the bank transfer was sent. Your bank may take 1–2 business days to show the credit — match amounts in Sec Wallet with your statement (look for SEC Nightlife when available). After you save payout details, you will see “Sec wallet set” — your full bank number is not shown again.',
    },
    {
      type: 'image',
      src: '/help/screenshots/wallet-payout.svg',
      alt: 'Sec Wallet overview',
      caption: 'Wallet code + payout setup in one place.',
      path: 'Profile → Wallet',
      illustrative: true,
    },
    {
      type: 'tip',
      title: 'Full setup guide',
      text: 'See How to set up your Sec Wallet & receive payouts for step-by-step instructions, Pending vs Received, and bank arrival timing.',
    },
    {
      type: 'related',
      ids: ['payouts', 'refunds-partygoer'],
    },
  ],
};

export const venueGettingStarted = {
  id: 'venue-getting-started',
  audience: 'venue',
  category: 'gettingStarted',
  title: 'Venue dashboard overview',
  summary: 'A map of Business Dashboard: events, tables, bookings, jobs, promotions, and refunds.',
  readMinutes: 5,
  keywords: ['business dashboard', 'venue overview', 'getting started venue'],
  sections: [
    {
      type: 'p',
      text: 'Business Dashboard is your venue home. From here you manage Events, Venue Tables, Bookings, Menu, Jobs, Promotions, Messages, Analytics, Refund requests, and profile/compliance.',
    },
    {
      type: 'steps',
      items: [
        'Finish Venue Onboarding and compliance documents.',
        'Add tables and seating; enable day bookings if needed.',
        'Create your first event (table hosting or ticketed).',
        'Set Venue Sec Wallet payout details.',
        'Post jobs and promotions when you are ready to grow.',
      ],
    },
    {
      type: 'related',
      ids: ['create-event', 'table-day-bookings', 'payouts', 'promotions', 'jobs-venue'],
    },
  ],
};

export const venueStaffPermissions = {
  id: 'venue-staff-permissions',
  audience: 'venue',
  category: 'venueOps',
  title: 'Staff & permissions',
  summary: 'Staff accounts can manage areas of the business dashboard based on permissions.',
  readMinutes: 3,
  keywords: ['staff', 'permissions', 'refund_requests', 'team'],
  sections: [
    {
      type: 'p',
      text: 'Venue owners can grant staff access to business tools. Sensitive areas such as refund requests require the matching permission (for example refund_requests). Hire Venue staff via Jobs, then assign access from your venue/staff settings.',
    },
    {
      type: 'tip',
      title: 'Tip',
      text: 'Only give refund and payout-related permissions to trusted managers.',
    },
    {
      type: 'related',
      ids: ['jobs-venue', 'refunds-venue', 'venue-getting-started'],
    },
  ],
};
