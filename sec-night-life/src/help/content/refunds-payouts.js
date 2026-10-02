import { HELP_FACTS as F } from '../facts';

export const refundsPartygoer = {
  id: 'refunds-partygoer',
  audience: 'partygoer',
  category: 'payments',
  title: 'How refunds work for party-goers',
  summary:
    'When you can request a refund, what gets paid back, and how venues process your request.',
  readMinutes: 6,
  keywords: ['refund', 'money back', 'tickets', 'table', 'cancel', 'eligible'],
  sections: [
    {
      type: 'p',
      text: `SEC does not pay refunds out of platform funds. When a refund is approved, the venue pays you directly (usually via your Sec Wallet details). SEC keeps the platform fee (${F.platformFeePercent}% on most bookings; ${F.ticketFeePercent}% on ticket tiers).`,
    },
    {
      type: 'image',
      src: '/help/diagrams/refund-flow.svg',
      alt: 'Diagram of refund money flow between guest, venue, and SEC',
      caption: 'Approved refunds: venue pays your share; SEC keeps the platform fee.',
    },
    {
      type: 'heading',
      text: 'What can be refunded',
    },
    {
      type: 'p',
      text: 'Eligible payments typically include table checkout (hosting a venue table), joining a venue table with a menu/prepaid portion, and event tickets (including ticket + menu add-ons when stored). For hosted tables, the menu/prepaid portion may be refundable — the joining fee itself is not.',
    },
    {
      type: 'warning',
      title: 'Never refundable',
      text: `Host listing fees, feed boosts, promotions, house-party publish/boost fees, external listing fees (R200), and joining fees without a refundable menu portion cannot be refunded. The R${F.serviceFeeZar} SEC service fee added at checkout is only refunded if the event is cancelled — contact SEC support in that case.`,
    },
    {
      type: 'heading',
      text: 'How to request a refund',
    },
    {
      type: 'steps',
      items: [
        'Open Profile and go to the Tickets tab.',
        'Find the payment or booking that is eligible for a refund.',
        'Tap Request refund and choose a reason.',
        'Submit the request and wait for the venue to approve or decline.',
        'If approved, the venue pays you off-app using your Sec Wallet code. Keep your payout details up to date.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/profile-tickets.svg',
      alt: 'Profile Tickets tab with refund entry',
      caption: 'Request refunds from Profile → Tickets.',
      path: 'Profile → Tickets',
      illustrative: true,
    },
    {
      type: 'heading',
      text: 'What happens after approval',
    },
    {
      type: 'p',
      text: 'When a venue approves: your QR codes / tickets for that booking are invalidated, capacity is restored on the listing, and the venue marks the refund as paid once they have transferred your share. Status moves from Pending → Approved → Paid by venue (or Rejected if declined).',
    },
    {
      type: 'tip',
      title: 'Tip',
      text: 'Have your Sec Wallet payout details set before you need a refund — venues look up your wallet code to pay you.',
    },
    {
      type: 'related',
      ids: ['sec-wallet-partygoer', 'payouts', 'tickets-qr', 'after-purchase'],
    },
  ],
};

export const refundsVenue = {
  id: 'refunds-venue',
  audience: 'venue',
  category: 'payments',
  title: 'How refunds work for venues',
  summary:
    'Review guest refund requests, approve or decline, and pay guests using Sec Wallet lookup.',
  readMinutes: 7,
  keywords: ['refund', 'approve', 'decline', 'wallet lookup', 'BusinessRefundRequests'],
  sections: [
    {
      type: 'p',
      text: `Guests request refunds for eligible table and ticket payments. You review them in Refund requests. SEC does not fund refunds — when you approve, you pay the guest’s share (${F.recipientSharePercent}%) off-app. SEC keeps the platform fee (${F.platformFeePercent}% on most bookings; ticket tiers use ${F.ticketFeePercent}%).`,
    },
    {
      type: 'image',
      src: '/help/diagrams/refund-flow.svg',
      alt: 'Refund money flow diagram',
      caption: 'You pay the guest share; platform fee stays with SEC.',
    },
    {
      type: 'heading',
      text: 'Where to manage requests',
    },
    {
      type: 'steps',
      items: [
        'Open Business Dashboard → Refund requests (staff need the refund_requests permission).',
        'Open a pending request to see the booking, amount, and guest reason.',
        'Approve to invalidate QR/tickets and restore capacity, or decline with a template reason (outside policy, no-show, QR already used, etc.).',
        'After approving, look up the guest by Sec Wallet code and pay them off-app.',
        'Mark the request as Paid by venue when the transfer is done.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/venue-refunds.svg',
      alt: 'Venue refund requests list',
      caption: 'Business Dashboard → Refund requests.',
      path: 'Business Dashboard → Refund requests',
      illustrative: true,
    },
    {
      type: 'callout',
      title: 'Important',
      text: 'Boosts, promotions, listing fees, and similar platform products are not refundable to guests through this flow.',
    },
    {
      type: 'related',
      ids: ['payouts', 'tickets-qr', 'venue-staff-permissions'],
    },
  ],
};

export const payouts = {
  id: 'payouts',
  audience: 'both',
  category: 'payments',
  title: 'How to set up your Sec Wallet & receive payouts',
  summary:
    `Add bank details to your Sec Wallet. Earnings are paid out weekly every ${F.payoutDay} once your balance is at least R${F.payoutMinZar}; bank credit may take 1–2 business days after Received.`,
  readMinutes: 6,
  keywords: [
    'payout',
    'paystack',
    'bank',
    'wallet',
    'sec wallet',
    'automatic transfer',
    'weekly payout',
    'monday',
    'service fee',
    'pending',
    '85%',
    '96%',
  ],
  sections: [
    {
      type: 'p',
      text: `Your Sec Wallet is how SEC pays you. After a successful payment, SEC records the split and adds your share to your Sec Wallet. Every ${F.payoutDay}, SEC combines everything you are owed into one bank transfer, as long as your balance is at least R${F.payoutMinZar} and payout details are set. Smaller balances roll over to the next week — nothing is lost. Default split: ${F.platformFeePercent}% SEC / ${F.recipientSharePercent}% recipient. Ticket tiers: ${F.ticketFeePercent}% SEC / ${F.ticketVenueSharePercent}% venue. Boosts, promotions, and listing fees are 100% platform revenue (no recipient transfer). Guests also pay a flat R${F.serviceFeeZar} SEC service fee per checkout; it is not part of your earnings and does not reduce your share.`,
    },
    {
      type: 'heading',
      text: 'How weekly payouts work',
    },
    {
      type: 'steps',
      items: [
        'A guest pays successfully in the app (table, tickets, or other eligible checkout).',
        'SEC keeps the platform fee and records your recipient share on the payout ledger. Sec Wallet Pending (Next payout) updates right away.',
        `Every ${F.payoutDay} morning, if your balance is at least R${F.payoutMinZar} and your Sec Wallet bank details are set, Paystack sends one combined transfer to your bank account. Received means the transfer was sent.`,
        `If your balance is below R${F.payoutMinZar}, it rolls over and is paid with the next week’s earnings.`,
        'Your bank may take 1–2 business days to show the credit (longer on weekends or public holidays). Match the amount and “SEC Nightlife” description on your statement with Sec Wallet earnings.',
        'If bank details are missing, earnings stay pending until you complete Sec Wallet setup — they are then included in the next weekly payout.',
      ],
    },
    {
      type: 'callout',
      title: 'Why set this up early',
      text: 'Pending payouts are not sent until your Sec Wallet is set. Add your bank details once so future weekly payouts happen without follow-up. Pending in the app can show immediately; bank arrival is separate and may take 1–2 business days after Received.',
    },
    {
      type: 'heading',
      text: 'Set up Sec Wallet (party-goers)',
    },
    {
      type: 'steps',
      items: [
        'Open Profile → Wallet (Sec Wallet tab).',
        'Under payout setup, enter account holder name, account number, and bank code.',
        'Tap Save payout details. You should see “Sec wallet set” with a tick — your full bank number is not shown again.',
        'Eligible earnings (for example host joining-fee share) are then included in the weekly Monday payout.',
      ],
    },
    {
      type: 'heading',
      text: 'Set up Sec Wallet (venues)',
    },
    {
      type: 'steps',
      items: [
        'Open Business Dashboard and scroll to Sec Wallet (venue owners only).',
        'If you own more than one venue, select each venue in turn — every venue needs its own bank details (they are not shared).',
        'Enter that venue’s account holder name, account number, and bank code.',
        'Save. You should see “Venue Sec wallet set” with a tick for that venue.',
        'Table and ticket venue shares are then included in the weekly Monday payout.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/wallet-payout.svg',
      alt: 'Wallet payout setup screen',
      caption: 'Connect a bank recipient so your pending earnings are included in the weekly payout.',
      path: 'Profile → Wallet / Business Dashboard → Sec Wallet',
      illustrative: true,
    },
    {
      type: 'heading',
      text: 'Updating your Sec Wallet',
    },
    {
      type: 'p',
      text: 'Tap Update Sec wallet, enter the new bank details, and save. SEC replaces your previous payout destination with the new one. For your privacy, saved account numbers are never shown again on screen after save — only the “Sec wallet set” status.',
    },
    {
      type: 'warning',
      title: 'Pending payouts',
      text: 'If payout details are missing or invalid, earnings stay pending until you complete Sec Wallet setup. Fix this before Monday so your weekly payout is not delayed. After a transfer is marked Received in Sec Wallet, allow 1–2 business days for the credit to appear on your bank statement.',
    },
    {
      type: 'related',
      ids: ['sec-wallet-partygoer', 'refunds-partygoer', 'refunds-venue'],
    },
  ],
};
