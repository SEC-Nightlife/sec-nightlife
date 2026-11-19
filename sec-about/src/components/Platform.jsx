import SectionReveal from './SectionReveal'

const CAPABILITIES = [
  {
    title: 'Minimum spend',
    body: 'Table nights can require a clear minimum spend so guests, hosts, and venues align before anyone pays.',
  },
  {
    title: 'Menus',
    body: 'Venues publish food and drink menus. Guests browse ahead of time and can build toward min spend with menu totals.',
  },
  {
    title: 'Promotions & boosts',
    body: 'Put your night in front of more party-goers with in-app promotions and feed boosts designed for nightlife.',
  },
  {
    title: 'Tickets & QR',
    body: 'Guests buy tickets in-app and present QR codes at the door — fewer lists, clearer entry.',
  },
  {
    title: 'Host group chat',
    body: 'When a listing goes live, SEC creates a group chat so hosts and going guests stay coordinated.',
  },
  {
    title: 'Sec Wallet',
    body: 'Hosts and venues set payout details and receive their share of eligible payments through Sec Wallet.',
  },
]

export default function Platform() {
  return (
    <SectionReveal id="platform" className="border-t border-sec-border bg-black py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <p className="section-label mb-4">Platform</p>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">
          Complete from feed to payout
        </h2>
        <p className="mt-4 max-w-2xl text-sec-muted">
          SEC is the operating layer for discovery, tables, menus, promotions, access, hiring, and
          money movement around the night.
        </p>

        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-sec-border bg-sec-border sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((item) => (
            <div
              key={item.title}
              className="bg-sec-elevated p-6 transition hover:bg-sec-hover md:p-8"
            >
              <h3 className="text-lg font-semibold text-sec-text">{item.title}</h3>
              <p className="mt-3 text-sm text-sec-muted md:text-base">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </SectionReveal>
  )
}
