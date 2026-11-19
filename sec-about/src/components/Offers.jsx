import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import SectionReveal from './SectionReveal'
import PhoneFrame from './PhoneFrame'

/** Keep: menus, jobs, business dashboard. Other visuals from launch-resources play-store / help. */
const OFFERS = [
  {
    id: 'discover',
    title: 'Discover & book',
    body: 'Browse venues and events near you. See what is on tonight and lock in your night without the back-and-forth.',
    image: '/media/screenshots/05-guest-home.png',
    alt: 'SEC guest home and discovery',
  },
  {
    id: 'tables',
    title: 'Tables & minimum spend',
    body: 'Book or join a table with clear minimum spend. Hosts and venues set the bar; guests know exactly what the night costs before they commit.',
    image: '/media/screenshots/02-manage-tables.png',
    alt: 'SEC manage tables',
  },
  {
    id: 'menus',
    title: 'Menus',
    body: 'Venues build food and drink menus in-app. Guests browse before they arrive — and can use menu totals toward table minimum spend.',
    image: '/media/screenshots/04-menu-food.png',
    alt: 'SEC menu maker',
  },
  {
    id: 'promos',
    title: 'Promotions & boosts',
    body: 'Venues push promotions into the guest feed and boost events or tables so the right nights show up first.',
    image: '/media/illustrations/promotions.svg',
    alt: 'SEC promotions illustration',
  },
  {
    id: 'tickets',
    title: 'Tickets & QR',
    body: 'Buy tickets in-app and arrive with QR access on your phone — clear for guests and simple for door staff.',
    image: '/media/screenshots/profile-tickets-qr.png',
    alt: 'SEC event ticket with QR code',
  },
  {
    id: 'jobs',
    title: 'Jobs & promoters',
    body: 'Venues post promoter and staff roles. Party-goers apply, build a track record, and climb the promoters leaderboard.',
    image: '/media/screenshots/07-jobs.png',
    alt: 'SEC jobs',
  },
  {
    id: 'host',
    title: 'Host & earn',
    body: 'Use the Host Dashboard to list tables and external events. Charge a joining fee and receive payouts via Sec Wallet.',
    image: '/media/screenshots/06-host-dashboard.png',
    alt: 'SEC host dashboard',
  },
  {
    id: 'ops',
    title: 'Venue ops & analytics',
    body: 'Business owners manage bookings, menus, promotions, and performance insights from a dedicated dashboard.',
    image: '/media/screenshots/01-dashboard.png',
    alt: 'SEC business dashboard',
  },
]

export default function Offers() {
  const [active, setActive] = useState(OFFERS[0].id)
  const current = OFFERS.find((o) => o.id === active) || OFFERS[0]
  const activeIndex = OFFERS.findIndex((o) => o.id === active)

  return (
    <SectionReveal id="offers" className="border-t border-sec-border bg-black py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <p className="section-label mb-4">What SEC offers</p>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">
          Everything the night needs, in one app
        </h2>
        <p className="mt-4 max-w-xl text-sec-muted">
          From discovery to door entry — tables with minimum spend, menus, promotions, hosting,
          hiring, and payouts.
        </p>

        <div className="mt-12 grid items-start gap-10 lg:grid-cols-[1fr_minmax(260px,320px)]">
          <div className="flex flex-col">
            {OFFERS.map((offer, i) => {
              const isActive = offer.id === active
              return (
                <button
                  key={offer.id}
                  type="button"
                  onClick={() => setActive(offer.id)}
                  onMouseEnter={() => setActive(offer.id)}
                  className={`border-l-2 px-5 py-4 text-left transition ${
                    isActive
                      ? 'border-sec-accent bg-white/[0.04]'
                      : 'border-sec-border hover:border-[#2E2E2E] hover:bg-sec-hover/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className={`text-lg font-semibold ${isActive ? 'text-sec-text' : 'text-sec-muted'}`}>
                      {offer.title}
                    </h3>
                    <span className="text-[11px] tabular-nums text-sec-dim">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                  </div>
                  <p className={`mt-2 text-sm leading-relaxed ${isActive ? 'text-sec-muted' : 'text-sec-dim'}`}>
                    {offer.body}
                  </p>
                </button>
              )
            })}
            <div className="mt-4 h-1 overflow-hidden rounded-full bg-sec-border">
              <motion.div
                className="h-full bg-sec-silver"
                initial={false}
                animate={{ width: `${((activeIndex + 1) / OFFERS.length) * 100}%` }}
                transition={{ duration: 0.35 }}
              />
            </div>
          </div>

          <div className="lg:sticky lg:top-28">
            <PhoneFrame>
              <AnimatePresence mode="wait">
                <motion.img
                  key={current.id}
                  src={current.image}
                  alt={current.alt}
                  loading="lazy"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.35 }}
                  className={`block w-full ${
                    current.image.endsWith('.svg') ? 'bg-sec-card object-contain p-4 min-h-[420px]' : ''
                  }`}
                />
              </AnimatePresence>
            </PhoneFrame>
          </div>
        </div>
      </div>
    </SectionReveal>
  )
}
