import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import SectionReveal from './SectionReveal'
import PhoneFrame from './PhoneFrame'
import Honeycomb from './Honeycomb'

const VENUE_TYPES = [
  {
    id: 'clubs',
    label: 'Clubs',
    headline: 'Fill the floor with guests who already want the night',
    body: 'Publish club nights, set table tiers with minimum spend, sell tickets, boost peak events, run promotions, and hire promoters who show up ready to work.',
    points: [
      'Event creation with ticketing and QR entry',
      'Table plans with host fees and minimum spend',
      'Menus guests can browse before they arrive',
      'Promotions and boosts to stand out in the feed',
      'Job posts for promoters and door staff',
      'Sec Wallet payouts for eligible bookings',
    ],
    image: '/media/screenshots/01-dashboard.png',
    alt: 'SEC business dashboard for clubs',
  },
  {
    id: 'lounges',
    label: 'Lounges',
    headline: 'Turn bottle service and soft nights into booked demand',
    body: 'Lounges use SEC to showcase atmosphere, control table inventory with clear min spend, keep menus current, and run midweek promotions.',
    points: [
      'Curated venue presence that matches your brand',
      'Table hosting with minimum spend tiers',
      'Menu maker for food and drinks',
      'Promotions that reach party-goers in-feed',
      'Guest messaging tied to hosted nights',
      'Analytics to see what actually converts',
    ],
    image: '/media/screenshots/03-bookings.png',
    alt: 'SEC bookings management',
  },
  {
    id: 'restaurants',
    label: 'Restaurants',
    headline: 'Extend dinner into the night without losing control',
    body: 'Restaurants and late kitchens list evening experiences, keep menus updated, take table bookings, and promote special evenings to party-goers.',
    points: [
      'Venue listing with clear location and vibe',
      'Digital menus for food and drinks',
      'Table and day booking tools',
      'Promotions for special evenings',
      'Minimum spend options where it fits your model',
      'Staff permissions for your ops team',
    ],
    image: '/media/screenshots/04-menu-food.png',
    alt: 'SEC menu maker',
  },
  {
    id: 'events',
    label: 'Event companies',
    headline: 'Produce nights that sell before doors open',
    body: 'Event companies publish ticketed experiences, coordinate tables, run promotions, hire on-ground promoters, and track performance across every activation.',
    points: [
      'Event pages with ticketing built in',
      'Reach party-goers already browsing the night',
      'Promotions and boosts for peak activations',
      'Promoter jobs with applications in-app',
      'Booking and seating workflows',
      'Wallet-ready payout rails',
    ],
    image: '/media/screenshots/03-day-listings.png',
    alt: 'SEC day listings and events',
  },
]

export default function Venues() {
  const [active, setActive] = useState(VENUE_TYPES[0].id)
  const current = VENUE_TYPES.find((v) => v.id === active) || VENUE_TYPES[0]

  return (
    <SectionReveal
      id="venues"
      className="relative overflow-hidden border-t border-sec-border bg-sec-elevated py-20 md:py-28"
    >
      <Honeycomb />
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(0,0,0,0.35), rgba(0,0,0,0.9)), url(/media/screenshots/04-hero-brand.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
      <div className="relative mx-auto max-w-6xl px-5 md:px-8">
        <p className="section-label mb-4">For venues</p>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">
          Built for every kind of night
        </h2>
        <p className="mt-4 max-w-2xl text-sec-muted">
          Clubs, lounges, restaurants, event companies — plus bars, rooftops, and beach clubs — all
          run on the same toolkit: listings, events, tables with minimum spend, menus, promotions,
          jobs, and payouts.
        </p>

        <div className="mt-10 flex flex-wrap gap-2">
          {VENUE_TYPES.map((type) => (
            <button
              key={type.id}
              type="button"
              onClick={() => setActive(type.id)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                active === type.id
                  ? 'bg-sec-silver text-black shadow-[0_0_20px_rgba(192,192,192,0.25)]'
                  : 'border border-sec-border bg-black/40 text-sec-muted hover:border-sec-accent/40 hover:text-sec-text'
              }`}
            >
              {type.label}
            </button>
          ))}
        </div>

        <div className="mt-10 grid items-center gap-10 lg:grid-cols-2">
          <AnimatePresence mode="wait">
            <motion.div
              key={current.id}
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ duration: 0.35 }}
            >
              <h3 className="text-2xl font-semibold text-sec-text md:text-3xl">{current.headline}</h3>
              <p className="mt-4 text-sec-muted">{current.body}</p>
              <ul className="mt-8 space-y-3">
                {current.points.map((point) => (
                  <li key={point} className="flex gap-3 text-sm text-sec-muted md:text-base">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sec-accent" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          </AnimatePresence>

          <AnimatePresence mode="wait">
            <motion.div
              key={`${current.id}-img`}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35 }}
            >
              <PhoneFrame>
                <img src={current.image} alt={current.alt} loading="lazy" className="block w-full" />
              </PhoneFrame>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </SectionReveal>
  )
}
