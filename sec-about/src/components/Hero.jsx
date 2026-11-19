import { motion } from 'framer-motion'
import { APP_URL } from '../constants'
import VideoPlayer from './VideoPlayer'

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: (i) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.15 + i * 0.12, duration: 0.7, ease: [0.22, 1, 0.36, 1] },
  }),
}

export default function Hero() {
  return (
    <section id="top" className="relative min-h-[100svh] overflow-hidden bg-black">
      <div className="absolute inset-0">
        <VideoPlayer autoPlay loop muted showControls={false} className="h-full w-full" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black via-black/80 to-black/40" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black via-transparent to-black/50" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-[100svh] max-w-6xl flex-col justify-end px-5 pb-16 pt-28 md:justify-center md:px-8 md:pb-24 md:pt-32">
        <div className="max-w-xl">
          <motion.img
            src="/Logo/sec-circle-logo.png"
            alt="SEC — Your Night. Simplified."
            className="mb-7 h-24 w-24 md:h-28 md:w-28"
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={0}
          />
          <motion.p
            className="mb-4 text-xs font-medium uppercase tracking-tagline text-sec-accent"
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={1}
          >
            Your Night. Simplified.
          </motion.p>
          <motion.h1
            className="mb-5 text-4xl font-semibold tracking-tight text-sec-text md:text-5xl lg:text-[3.4rem] lg:leading-[1.1]"
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={2}
          >
            The nightlife platform for South Africa
          </motion.h1>
          <motion.p
            className="mb-8 max-w-md text-base text-sec-muted md:text-lg"
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={3}
          >
            Discover events, book tables with minimum spend, browse menus, host nights, find jobs,
            and run venues — all in one place.
          </motion.p>
          <motion.div
            className="flex flex-wrap items-center gap-3"
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={4}
          >
            <a
              href={APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-silver rounded-xl px-6 py-3 text-sm shadow-[0_0_28px_rgba(192,192,192,0.2)] md:text-base"
            >
              Open SEC
            </a>
            <a href="#purpose" className="btn-ghost rounded-xl px-6 py-3 text-sm md:text-base">
              Explore
            </a>
            <a
              href="#watch"
              className="text-sm text-sec-accent underline-offset-4 transition hover:text-sec-accent-bright hover:underline md:ml-2"
            >
              Watch the story
            </a>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
