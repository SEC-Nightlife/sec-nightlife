/** FAQ entries — filtered by audience on the Help Center hub. */
export const HELP_FAQS = [
  // Party-goer
  {
    id: 'faq-pg-refund-when',
    audience: 'partygoer',
    question: 'When can I request a refund?',
    answer:
      'When the payment is eligible (typically tables/tickets with refundable portions) and the venue has not already used or closed the booking outside policy. Open Profile → Tickets and use Request refund on eligible items.',
    articleId: 'refunds-partygoer',
  },
  {
    id: 'faq-pg-join-fee',
    audience: 'partygoer',
    question: 'Why wasn’t my joining fee refunded?',
    answer:
      'Joining fees are generally not refundable. If you prepaid menu items with the host, that menu portion may be eligible — the join fee itself is not.',
    articleId: 'refunds-partygoer',
  },
  {
    id: 'faq-pg-qr',
    audience: 'partygoer',
    question: 'How do I get my table or ticket QR?',
    answer:
      'After a successful payment, open Profile → Tickets. Host Dashboard also shows live tables you host.',
    articleId: 'tickets-qr',
  },
  {
    id: 'faq-pg-r200',
    audience: 'partygoer',
    question: 'What is the R200 listing fee?',
    answer:
      'It is the one-time SEC fee to publish a Host Dashboard listing at your own place or a venue not registered on SEC. It is not refundable.',
    articleId: 'host-list-external-table',
  },
  {
    id: 'faq-pg-auto-group',
    audience: 'partygoer',
    question: 'How do automatic groups work?',
    answer:
      'When you host (and payment succeeds), SEC creates a group chat. Joiners who become Going are added automatically. Find it under Messages.',
    articleId: 'automatic-groups',
  },
  {
    id: 'faq-pg-leave',
    audience: 'partygoer',
    question: 'How do I leave a table?',
    answer:
      'Use leave/manage controls on the hosted table or Host Dashboard where available. Leaving may remove you from the automatic group chat. Refund eligibility depends on payment type and venue policy.',
    articleId: 'host-join-table',
  },
  {
    id: 'faq-pg-promoter-job',
    audience: 'partygoer',
    question: 'How do I apply for a promoter job?',
    answer:
      'Open Jobs, filter or find Promoter roles, and apply with a cover message of at least 50 characters. Track status under My Job Applications.',
    articleId: 'jobs-partygoer',
  },
  {
    id: 'faq-pg-verified',
    audience: 'partygoer',
    question: 'What does verified promoter mean?',
    answer:
      'Admin-granted status after you are hired, accept the Code of Conduct, and meet job/rating milestones. Verified promoters are more prominent on leaderboards.',
    articleId: 'verified-promoter',
  },
  {
    id: 'faq-pg-non-sec',
    audience: 'partygoer',
    question: 'Can I list a table at a venue not on SEC?',
    answer:
      'Yes. Use Host Dashboard → List as Table (or List as Event), enter the address, and pay the R200 listing fee.',
    articleId: 'host-list-external-table',
  },
  {
    id: 'faq-pg-min-spend',
    audience: 'partygoer',
    question: 'What is minimum spend?',
    answer:
      'The amount you must prepay (menu or lump sum) to host or join certain tables. Checkout stays locked until you meet it.',
    articleId: 'minimum-spend',
  },
  {
    id: 'faq-pg-custom',
    audience: 'partygoer',
    question: 'How do custom table requests work?',
    answer:
      'If the venue allows them, submit guests, times, and proposed spend. After the venue approves, you pay and become the host for that session.',
    articleId: 'custom-tables-partygoer',
  },
  {
    id: 'faq-pg-wallet-setup',
    audience: 'partygoer',
    question: 'How do I set up my Sec Wallet for payouts?',
    answer:
      'Open Profile → Wallet, enter your bank details, and save. You will see “Sec wallet set” with a tick — account numbers are not shown again. Once set, your earnings are paid out weekly: every Monday SEC sends one combined transfer if your balance is at least R50 (smaller balances roll over). Pending shows in Sec Wallet right away; Received means the bank transfer was sent. Your bank may take 1–2 business days to show the credit. Tap Update Sec wallet to replace your payout details.',
    articleId: 'payouts',
  },
  {
    id: 'faq-pg-vendor',
    audience: 'partygoer',
    question: 'How do I become a vendor?',
    answer:
      'Create a listing during onboarding or later under Settings → My vendor businesses, then publish it.',
    articleId: 'vendors-become',
  },
  // Venue
  {
    id: 'faq-vn-pay-refund',
    audience: 'venue',
    question: 'How do I pay an approved refund?',
    answer:
      'After you approve, look up the guest by Sec Wallet code and pay their share off-app. Then mark the request as Paid by venue. SEC keeps the platform fee.',
    articleId: 'refunds-venue',
  },
  {
    id: 'faq-vn-remove',
    audience: 'venue',
    question: 'Why can’t I remove this table from listings?',
    answer:
      'Hide only works on empty, non-custom slots that are not in use. Custom-request listings and active hosted sessions cannot be hidden.',
    articleId: 'remove-from-listings',
  },
  {
    id: 'faq-vn-event-types',
    audience: 'venue',
    question: 'What’s the difference between table-hosting and ticketed events?',
    answer:
      'Table hosting sells host/join table tiers at your event. Ticketed only sells ticket tiers (optional menu add-ons) without table hosting.',
    articleId: 'create-event',
  },
  {
    id: 'faq-vn-promo-vs-boost',
    audience: 'venue',
    question: 'How do promotions vs boosts differ?',
    answer:
      'Promotions are creatives you publish (from R50/day). Boosts lift a table, event, or promotion higher in the feed (R150/day). Both are non-refundable platform products.',
    articleId: 'promotions',
  },
  {
    id: 'faq-vn-who-payout',
    audience: 'venue',
    question: 'Who receives payout money?',
    answer:
      'Your venue’s Paystack recipient receives the venue share of eligible bookings (typically 85%, or 96% on ticket tiers), paid out in one combined transfer every Monday once the balance is at least R50. Boosts, promo fees, and the R5 guest service fee stay with SEC.',
    articleId: 'payouts',
  },
  {
    id: 'faq-vn-delete-job',
    audience: 'venue',
    question: 'What happens when I delete a job?',
    answer:
      'The job is soft-closed. Pending and shortlisted applications become Rejected. Hired relationships are managed separately (unhire/release).',
    articleId: 'jobs-venue',
  },
  {
    id: 'faq-vn-custom',
    audience: 'venue',
    question: 'How do custom table requests appear?',
    answer:
      'When custom requests are enabled, guests submit proposals. You review them under bookings/reservations, then approve or decline before they pay.',
    articleId: 'custom-tables-venue',
  },
  {
    id: 'faq-vn-payout-pending',
    audience: 'venue',
    question: 'Why is a payout pending?',
    answer:
      'Payouts are sent weekly, every Monday, once your balance is at least R50 — until then earnings show as Pending (Next payout). Pending can also mean Sec Wallet bank details are missing on Business Dashboard → Sec Wallet — set them so the next weekly payout can be sent. It can also mean the transfer is still waiting to be sent, or it was sent (Received in Sec Wallet) but your bank has not credited you yet (often 1–2 business days). Match amounts in Sec Wallet earnings with your bank statement.',
    articleId: 'payouts',
  },
  {
    id: 'faq-vn-wallet-setup',
    audience: 'venue',
    question: 'How do I set up the venue Sec Wallet?',
    answer:
      'Open Business Dashboard → Sec Wallet, enter account name, account number, and bank code, then save. You will see “Venue Sec wallet set” — bank numbers are not shown again. If you own multiple venues, set Sec Wallet for each venue separately (bank details are not shared). Updating replaces that venue’s payout destination. After setup, Pending shows money owed for the next weekly payout (every Monday, minimum R50); Received means the transfer was sent — bank credit may take 1–2 business days.',
    articleId: 'payouts',
  },
  {
    id: 'faq-vn-day',
    audience: 'venue',
    question: 'What are day bookings?',
    answer:
      'Bookings for a time window on a normal night (not only during a named event), within your opening hours, when day bookings are enabled.',
    articleId: 'table-day-bookings',
  },
  {
    id: 'faq-vn-staff',
    audience: 'venue',
    question: 'Can staff manage refunds?',
    answer:
      'Yes, if they have the refund_requests permission. Only grant this to trusted managers.',
    articleId: 'venue-staff-permissions',
  },
  {
    id: 'faq-service-fee',
    audience: 'both',
    question: 'What is the R5 SEC service fee?',
    answer:
      'A flat R5 fee is added to each paid checkout (tickets, entrance, tables, table joins, and menu orders). It covers payment processing and platform costs, is shown before you pay, and does not reduce the venue’s or host’s share. It is only refunded if the event is cancelled — contact SEC support in that case.',
    articleId: 'payouts',
  },
  {
    id: 'faq-weekly-payouts',
    audience: 'both',
    question: 'When are payouts sent?',
    answer:
      'Every Monday morning SEC sends one combined bank transfer per venue or host for everything owed, once the balance is at least R50. Smaller balances roll over to the next week. Your bank may take 1–2 business days to show the credit.',
    articleId: 'payouts',
  },
];

/**
 * @param {'partygoer' | 'venue'} audience
 */
export function getFaqsForAudience(audience) {
  return HELP_FAQS.filter((f) => f.audience === audience || f.audience === 'both');
}
