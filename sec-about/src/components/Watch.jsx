import SectionReveal from './SectionReveal'
import VideoPlayer from './VideoPlayer'
import Honeycomb from './Honeycomb'

export default function Watch() {
  return (
    <SectionReveal id="watch" className="relative border-t border-sec-border bg-sec-elevated py-20 md:py-28">
      <Honeycomb />
      <div className="relative mx-auto max-w-6xl px-5 md:px-8">
        <p className="section-label mb-4">Watch</p>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">
          See SEC in action
        </h2>
        <p className="mt-4 max-w-xl text-sec-muted">
          A short look at the product — the brand, the night, and the platform that simplifies it.
        </p>

        <div className="mt-10 overflow-hidden rounded-2xl border border-sec-border bg-black shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
          <VideoPlayer
            className="aspect-video w-full"
            showControls
            muted={false}
            onWatchWithSound={(el) => {
              el.requestFullscreen?.().catch(() => {})
            }}
          />
        </div>
      </div>
    </SectionReveal>
  )
}
