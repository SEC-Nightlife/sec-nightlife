import SectionReveal from './SectionReveal'
import PhoneFrame from './PhoneFrame'

const BENEFITS = [
  {
    title: 'Discover nights & book tables',
    body: 'See venues and events, join a table with friends, and understand minimum spend before you commit — no chasing DMs all week.',
    image: '/media/screenshots/05-guest-home.png',
    alt: 'Guest home on SEC',
  },
  {
    title: 'Browse menus before you go',
    body: 'Check food and drink menus in-app so you know what is on offer — and how it fits your table’s minimum spend.',
    image: '/media/screenshots/04-menu-food.png',
    alt: 'Menus on SEC',
  },
  {
    title: 'Get jobs in nightlife',
    body: 'Browse promoter and staff roles posted by venues. Apply in-app, build ratings, and grow a real nightlife work profile.',
    image: '/media/screenshots/07-jobs.png',
    alt: 'Jobs on SEC',
  },
  {
    title: 'Host your own events & tables',
    body: 'The Host Dashboard lets you list a table or an event — including nights at your own place or a venue not yet on SEC.',
    image: '/media/screenshots/06-host-dashboard.png',
    alt: 'Host dashboard',
  },
  {
    title: 'Earn from hosting',
    body: 'Charge a joining fee when you host. Successful payments flow through Sec Wallet so you can get paid for bringing the night together.',
    image: '/media/illustrations/wallet-payout.svg',
    alt: 'Sec Wallet payouts',
    isSvg: true,
  },
  {
    title: 'Promoters leaderboard',
    body: 'Verified promoters rise on the SEC leaderboard. Consistent accepted jobs, strong ratings, and professionalism unlock status and visibility.',
    image: '/media/illustrations/promoter-coc.svg',
    alt: 'Promoter path on SEC',
    isSvg: true,
  },
]

export default function PartyGoers() {
  return (
    <SectionReveal id="party-goers" className="border-t border-sec-border bg-black py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <p className="section-label mb-4">For party-goers</p>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">
          More than a guest pass — a way into the industry
        </h2>
        <p className="mt-4 max-w-2xl text-sec-muted">
          SEC is for people who go out and for people who want to build around the night: discover,
          browse menus, host, work, earn, and get recognized.
        </p>

        <div className="mt-14 space-y-16 md:space-y-24">
          {BENEFITS.map((item, index) => {
            const reverse = index % 2 === 1
            return (
              <div
                key={item.title}
                className={`grid items-center gap-8 md:grid-cols-2 md:gap-14 ${
                  reverse ? 'md:[&>div:first-child]:order-2' : ''
                }`}
              >
                <div>
                  <span className="text-xs font-medium uppercase tracking-tagline text-sec-dim">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <h3 className="mt-3 text-2xl font-semibold text-sec-text md:text-3xl">{item.title}</h3>
                  <p className="mt-4 text-sec-muted">{item.body}</p>
                </div>
                <PhoneFrame>
                  <img
                    src={item.image}
                    alt={item.alt}
                    loading="lazy"
                    className={`block w-full ${
                      item.isSvg ? 'min-h-[420px] bg-sec-card object-contain p-4' : ''
                    }`}
                  />
                </PhoneFrame>
              </div>
            )
          })}
        </div>
      </div>
    </SectionReveal>
  )
}
