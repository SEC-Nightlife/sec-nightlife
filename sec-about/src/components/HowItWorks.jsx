import SectionReveal from './SectionReveal'

const FLOWS = [
  {
    label: 'Party-goer',
    steps: [
      { title: 'Create your profile', body: 'Join as a party-goer and set up how you show up in the scene.' },
      { title: 'Discover & commit', body: 'Find an event or table, book or join, and keep tickets ready on your phone.' },
      { title: 'Host, work, earn', body: 'List your own night, apply for jobs, and climb the promoters leaderboard.' },
    ],
  },
  {
    label: 'Venue',
    steps: [
      { title: 'List your venue', body: 'Register as a business owner and put your club, lounge, restaurant, or event company on SEC.' },
      { title: 'Publish the night', body: 'Create events, open tables with minimum spend, update menus, and run promotions from one dashboard.' },
      { title: 'Operate & grow', body: 'Manage bookings, boost visibility, hire promoters, track analytics, and receive payouts through Sec Wallet.' },
    ],
  },
]

export default function HowItWorks() {
  return (
    <SectionReveal id="how" className="border-t border-sec-border bg-sec-elevated py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <p className="section-label mb-4">How it works</p>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">
          Simple paths for guests and venues
        </h2>

        <div className="mt-12 grid gap-10 lg:grid-cols-2">
          {FLOWS.map((flow) => (
            <div key={flow.label} className="rounded-2xl border border-sec-border bg-black/50 p-6 md:p-8">
              <p className="text-sm font-medium uppercase tracking-tagline text-sec-accent">{flow.label}</p>
              <ol className="mt-8 space-y-8">
                {flow.steps.map((step, i) => (
                  <li key={step.title} className="flex gap-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sec-silver text-sm font-semibold text-black">
                      {i + 1}
                    </span>
                    <div>
                      <h3 className="text-lg font-semibold text-sec-text">{step.title}</h3>
                      <p className="mt-2 text-sm text-sec-muted md:text-base">{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>
    </SectionReveal>
  )
}
