import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { APP_URL, NAV_LINKS } from '../constants'

const SECTION_IDS = NAV_LINKS.map((l) => l.href.replace('#', ''))

export default function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState('')

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const els = SECTION_IDS.map((id) => document.getElementById(id)).filter(Boolean)
    if (!els.length) return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)
        if (visible[0]?.target?.id) setActive(visible[0].target.id)
      },
      { rootMargin: '-30% 0px -55% 0px', threshold: [0.1, 0.35, 0.6] },
    )
    els.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <header className="fixed inset-x-0 top-0 z-50">
      <div
        className={`transition-all duration-300 ${
          scrolled || open
            ? 'border-b border-white/10 bg-black/80 shadow-[0_1px_0_rgba(192,192,192,0.18)] backdrop-blur-xl'
            : 'border-b border-transparent bg-gradient-to-b from-black/70 to-transparent'
        }`}
      >
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 md:h-[72px] md:px-8">
          <a href="#top" className="group flex items-center" onClick={() => setOpen(false)}>
            <motion.img
              src="/Logo/sec-email-logo-transparent.png"
              alt="SEC"
              className="h-9 w-auto object-contain md:h-10"
              animate={{ scale: scrolled ? 0.96 : 1 }}
              transition={{ duration: 0.25 }}
            />
          </a>

          <nav className="hidden items-center gap-1 lg:flex">
            {NAV_LINKS.map((link) => {
              const id = link.href.replace('#', '')
              const isActive = active === id
              return (
                <a
                  key={link.href}
                  href={link.href}
                  className={`relative rounded-lg px-3 py-2 text-sm transition ${
                    isActive ? 'text-sec-text' : 'text-sec-muted hover:text-sec-text'
                  }`}
                >
                  {link.label}
                  {isActive && (
                    <motion.span
                      layoutId="nav-underline"
                      className="absolute inset-x-3 -bottom-0.5 h-px bg-sec-silver"
                      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                    />
                  )}
                </a>
              )
            })}
          </nav>

          <div className="flex items-center gap-3">
            <a
              href={APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-silver relative overflow-hidden rounded-xl px-4 py-2 text-sm shadow-[0_0_24px_rgba(192,192,192,0.18)]"
            >
              Open SEC
            </a>
            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-white/[0.03] text-sec-text lg:hidden"
              aria-label="Menu"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
              </svg>
            </button>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="border-b border-white/10 bg-black/95 px-5 py-4 backdrop-blur-xl lg:hidden"
          >
            <div className="flex flex-col gap-1">
              {NAV_LINKS.map((link) => {
                const id = link.href.replace('#', '')
                const isActive = active === id
                return (
                  <a
                    key={link.href}
                    href={link.href}
                    className={`rounded-lg px-3 py-3 text-sm ${
                      isActive ? 'bg-white/[0.06] text-sec-text' : 'text-sec-muted'
                    }`}
                    onClick={() => setOpen(false)}
                  >
                    {link.label}
                  </a>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}
