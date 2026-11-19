import { APP_URL, SUPPORT_EMAIL } from '../constants'

export default function Footer() {
  return (
    <footer className="border-t border-sec-border bg-black py-16">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <div className="flex flex-col gap-10 md:flex-row md:items-end md:justify-between">
          <div>
            <img src="/Logo/sec-circle-logo.png" alt="SEC" className="h-20 w-20" />
            <p className="mt-4 text-sm uppercase tracking-tagline text-sec-accent">
              Your Night. Simplified.
            </p>
            <p className="mt-4 max-w-sm text-sec-muted">
              SEC Nightlife — discovery, tables, menus, promotions, jobs, hosting, and venue
              operations for South Africa.
            </p>
          </div>

          <div className="flex flex-col gap-3 text-sm">
            <a
              href={APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-silver inline-flex w-fit rounded-xl px-5 py-2.5"
            >
              Open SEC
            </a>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-sec-muted hover:text-sec-text">
              {SUPPORT_EMAIL}
            </a>
            <div className="flex flex-wrap gap-4 text-sec-dim">
              <a
                href={`${APP_URL}/PrivacyPolicy`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-sec-muted"
              >
                Privacy
              </a>
              <a
                href={`${APP_URL}/TermsOfService`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-sec-muted"
              >
                Terms
              </a>
            </div>
          </div>
        </div>

        <p className="mt-12 border-t border-sec-border pt-6 text-xs text-sec-dim">
          © {new Date().getFullYear()} SEC Nightlife. All rights reserved.
        </p>
      </div>
    </footer>
  )
}
