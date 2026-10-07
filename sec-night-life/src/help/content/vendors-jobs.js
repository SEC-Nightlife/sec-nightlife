import { HELP_FACTS as F } from '../facts';

export const vendorsOverview = {
  id: 'vendors-overview',
  audience: 'both',
  category: 'jobsVendors',
  title: 'What are Vendors?',
  summary:
    'Vendor listings let party-goers showcase services (food, DJ, decor, and more) that venues can discover.',
  readMinutes: 4,
  keywords: ['vendor', 'DJ', 'food', 'decor', 'hire', 'listing'],
  sections: [
    {
      type: 'p',
      text: 'Vendors on SEC are small service businesses listed by party-goers — for example food & snacks, equipment rental, DJ / AV, décor, photography, or other. Venues (and guests) can browse published listings and contact or hire providers for events.',
    },
    {
      type: 'image',
      src: '/help/screenshots/vendors-browse.svg',
      alt: 'Vendors browse screen',
      caption: 'Browse published vendor listings from the Vendors page.',
      path: 'Home / nav → Vendors',
      illustrative: true,
    },
    {
      type: 'heading',
      text: 'How listings work',
    },
    {
      type: 'p',
      text: 'A listing appears publicly only when it is published and not deleted. Owners can add up to four images, choose a category, and edit details later. Soft-deleted listings leave the public directory.',
    },
    {
      type: 'related',
      ids: ['vendors-become', 'jobs-venue'],
    },
  ],
};

export const vendorsBecome = {
  id: 'vendors-become',
  audience: 'partygoer',
  category: 'jobsVendors',
  title: 'How to become a vendor',
  summary: 'List your service business during onboarding or later from Settings.',
  readMinutes: 4,
  keywords: ['become vendor', 'list business', 'vendor settings', 'onboarding'],
  sections: [
    {
      type: 'p',
      text: 'Any party-goer can create a vendor listing. You can do it during profile onboarding (or defer it) and manage listings anytime from Settings → My vendor businesses.',
    },
    {
      type: 'steps',
      items: [
        'Open Settings → My vendor businesses (or complete the vendor step in onboarding).',
        'Create a listing: name, category, description, and optional photos (up to 4).',
        'Publish the listing so venues can find you on the Vendors page.',
        'Add a starting price or Quote on request, the areas you serve, and contact details.',
        'Venues send hire requests — manage them under Settings → My vendor businesses → Hire requests.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/vendor-settings.svg',
      alt: 'Vendor business settings form',
      caption: 'Manage listings under Settings → My vendor businesses.',
      path: 'Settings → My vendor businesses',
      illustrative: true,
    },
    {
      type: 'tip',
      title: 'Tip',
      text: 'Clear photos and a specific category help venues shortlist the right provider faster.',
    },
    {
      type: 'related',
      ids: ['vendors-overview', 'partygoer-getting-started'],
    },
  ],
};

export const vendorReviewsArticle = {
  id: 'vendors-reviews',
  audience: 'both',
  category: 'jobsVendors',
  title: 'Rating and reviewing vendors',
  summary:
    'Leave a star rating and comment on a vendor listing — as yourself or on behalf of your venue — so other venues can hire with confidence.',
  readMinutes: 3,
  keywords: ['vendor review', 'rate vendor', 'stars', 'verified hire', 'flag review'],
  sections: [
    {
      type: 'p',
      text: 'Vendor reviews work like profile reviews. Open a vendor listing, scroll to Reviews and tap Write a review. Pick 1–5 stars and write 10–300 characters about quality, reliability and communication.',
    },
    {
      type: 'steps',
      items: [
        'Open Vendors and tap the listing.',
        'Scroll to Reviews → Write a review (or Review as venue if you own a venue).',
        'Choose a star rating and add your comment.',
        'Post. You can edit or delete it later from the listing or Profile → Reviews I’ve given.',
      ],
    },
    {
      type: 'heading',
      text: 'Verified hire badge',
    },
    {
      type: 'p',
      text: 'When a venue sends a hire request through SEC and it is marked completed, reviews from that venue (and the person who sent the request) show a “Verified hire” badge.',
    },
    {
      type: 'heading',
      text: 'Rules',
    },
    {
      type: 'p',
      text: 'One review per person and one per venue for each listing. You can’t review your own listing. Everyone shares a limit of 5 new reviews per hour. Listing owners can flag a review they believe breaks the rules; SEC admins then keep or remove it. Flagged reviews don’t count toward the rating while they are being checked.',
    },
    {
      type: 'related',
      ids: ['vendors-hiring', 'vendors-overview'],
    },
  ],
};

export const vendorHiringArticle = {
  id: 'vendors-hiring',
  audience: 'both',
  category: 'jobsVendors',
  title: 'Hiring a vendor (hire requests)',
  summary: 'Venues send hire requests from a vendor listing; vendors accept, decline and mark jobs completed.',
  readMinutes: 4,
  keywords: ['hire vendor', 'hire request', 'request to hire', 'vendor inquiry', 'contact vendor'],
  sections: [
    {
      type: 'p',
      text: 'Venue owners can contact vendors without sending a friend request. On a vendor listing tap Request to hire, choose your venue, add an optional event date and describe what you need.',
    },
    {
      type: 'heading',
      text: 'For venues',
    },
    {
      type: 'steps',
      items: [
        'Open the vendor listing → Request to hire.',
        'Pick the venue, optional date, and write your message (at least 10 characters).',
        'Track the status under Vendors → My hire requests. You can message the vendor directly once the request is sent.',
        'After the job, tap Mark as completed and leave a review — it will carry the Verified hire badge.',
      ],
    },
    {
      type: 'heading',
      text: 'For vendors',
    },
    {
      type: 'steps',
      items: [
        'Open Settings → My vendor businesses → Hire requests.',
        'Accept or decline new requests (you can add a short note).',
        'Use Message to plan details with the venue.',
        'Mark the request completed after the event.',
      ],
    },
    {
      type: 'tip',
      title: 'Tip',
      text: 'Add a starting price (or choose Quote on request), the areas you serve, and contact details to your listing so venues can shortlist you quickly. Phone, WhatsApp and email are only visible to signed-in members.',
    },
    {
      type: 'p',
      text: 'Payments for vendor work are arranged directly between the venue and the vendor — SEC does not process them. Use Report listing on the vendor page if something looks wrong.',
    },
    {
      type: 'related',
      ids: ['vendors-reviews', 'vendors-become'],
    },
  ],
};

export const jobsVenue = {
  id: 'jobs-venue',
  audience: 'venue',
  category: 'jobsVendors',
  title: 'Jobs for venues',
  summary:
    'Post promoter or staff jobs, then shortlist, reject, hire, or close applications.',
  readMinutes: 7,
  keywords: ['job', 'hire', 'shortlist', 'reject', 'promoter', 'staff', 'delete job'],
  sections: [
    {
      type: 'p',
      text: 'Venues post jobs for Promoters or Venue staff. Applicants send a cover message (and optional CV/portfolio). You shortlist, reject, or hire. Messaging unlocks when someone is shortlisted or hired.',
    },
    {
      type: 'heading',
      text: 'List a job',
    },
    {
      type: 'steps',
      items: [
        'Open Business Dashboard → Jobs (or Create Job).',
        'Choose job type: Promoter or Venue staff.',
        'Fill title, description, spots, and requirements.',
        'Publish so party-goers can apply from the Jobs feed.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/create-job.svg',
      alt: 'Create job form',
      caption: 'Create Job from the business Jobs area.',
      path: 'Business Dashboard → Jobs → Create',
      illustrative: true,
    },
    {
      type: 'heading',
      text: 'Application actions',
    },
    {
      type: 'p',
      text: 'Applications move through: Pending → Shortlisted, Rejected, or Hired (and Released if you unhire). When filled spots reach total spots, the job becomes Filled.',
    },
    {
      type: 'steps',
      items: [
        'Shortlist: keep strong candidates and unlock messaging.',
        'Reject: decline applicants you will not proceed with.',
        'Hire: confirm the person for the role. Hiring a Promoter starts the venue–promoter relationship and prompts the Promoter Code of Conduct.',
        'Unhire / release: end an active hire when needed.',
        'Delete job: soft-closes the job (Closed), and pending/shortlisted apps become Rejected.',
      ],
    },
    {
      type: 'callout',
      title: 'Important',
      text: 'Deleting a job cannot be undone for open applications — they are rejected automatically. Hire carefully before filling all spots.',
    },
    {
      type: 'related',
      ids: ['jobs-partygoer', 'verified-promoter', 'venue-staff-permissions'],
    },
  ],
};

export const jobsPartygoer = {
  id: 'jobs-partygoer',
  audience: 'partygoer',
  category: 'jobsVendors',
  title: 'Jobs for party-goers',
  summary: 'Browse venue jobs, apply with a cover message, and track your applications.',
  readMinutes: 5,
  keywords: ['apply', 'job', 'promoter', 'staff', 'applications', 'cover letter'],
  sections: [
    {
      type: 'p',
      text: `Venues post Promoter and Venue staff roles. You browse Jobs, open a listing, and apply with a cover message (at least ${F.coverMessageMinChars} characters). Optional CV or portfolio links help your application stand out.`,
    },
    {
      type: 'steps',
      items: [
        'Open Jobs from the main navigation.',
        'Tap a role that matches your skills.',
        'Write a cover message (min. 50 characters) and submit.',
        'Track status under My Job Applications (Pending, Shortlisted, Rejected, Hired).',
        'If shortlisted or hired, you can message the venue about next steps.',
      ],
    },
    {
      type: 'image',
      src: '/help/screenshots/jobs-browse.svg',
      alt: 'Jobs browse and apply',
      caption: 'Apply from Job details; track progress in My Job Applications.',
      path: 'Jobs → Job details → Apply',
      illustrative: true,
    },
    {
      type: 'tip',
      title: 'Promoter path',
      text: 'Getting hired on a Promoter job is the first step toward verified promoter status. See Become a verified promoter.',
    },
    {
      type: 'related',
      ids: ['verified-promoter', 'jobs-venue', 'vendors-become'],
    },
  ],
};
