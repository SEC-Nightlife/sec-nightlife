import SectionReveal from './SectionReveal'
import Honeycomb from './Honeycomb'

export default function Purpose() {
  return (
    <SectionReveal id="purpose" className="relative border-t border-sec-border bg-sec-elevated py-20 md:py-28">
      <Honeycomb />
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 20% 0%, rgba(192,192,192,0.08), transparent 55%), radial-gradient(ellipse 60% 40% at 90% 100%, rgba(201,169,98,0.06), transparent 50%)',
        }}
      />
      <div className="relative mx-auto max-w-6xl px-5 md:px-8">
        <p className="section-label mb-4">Purpose</p>
        <h2 className="max-w-3xl text-3xl font-semibold tracking-tight text-sec-text md:text-4xl">
          One platform that connects the night
        </h2>
        <p className="mt-6 max-w-2xl text-lg text-sec-muted">
          SEC Nightlife brings party-goers and venues together. Guests discover what is happening,
          book and join tables (including minimum spend), browse menus, buy tickets, host their own
          nights, and apply for nightlife jobs. Venues list themselves, publish events, manage
          bookings, run promotions, hire staff, and get paid through Sec Wallet.
        </p>
        <div className="mt-12 grid gap-8 border-t border-sec-border pt-10 md:grid-cols-3">
          {[
            {
              title: 'For the night out',
              body: 'Find events and venues, secure a table, browse the menu, and walk in with tickets ready on your phone.',
            },
            {
              title: 'For the host',
              body: 'List a table or an event from the Host Dashboard — including nights at your own place — and earn when guests join.',
            },
            {
              title: 'For the venue',
              body: 'Run events, tables with min spend, menus, promotions, jobs, and analytics from one business dashboard.',
            },
          ].map((item) => (
            <div key={item.title}>
              <h3 className="text-lg font-semibold text-sec-text">{item.title}</h3>
              <p className="mt-3 text-sec-muted">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </SectionReveal>
  )
}
