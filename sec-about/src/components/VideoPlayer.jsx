import { useEffect, useRef, useState } from 'react'

export default function VideoPlayer({
  src = '/media/sec-promo.mp4',
  poster = '/media/sec-promo-poster.jpg',
  autoPlay = false,
  loop = false,
  muted = true,
  className = '',
  showControls = true,
  onWatchWithSound,
}) {
  const videoRef = useRef(null)
  const [failedAutoplay, setFailedAutoplay] = useState(false)
  const [playing, setPlaying] = useState(autoPlay)

  useEffect(() => {
    if (!autoPlay || !videoRef.current) return
    const el = videoRef.current
    el.muted = true
    const playPromise = el.play()
    if (playPromise?.then) {
      playPromise
        .then(() => setPlaying(true))
        .catch(() => {
          setFailedAutoplay(true)
          setPlaying(false)
        })
    }
  }, [autoPlay])

  const handlePlayClick = async () => {
    const el = videoRef.current
    if (!el) return
    try {
      el.muted = onWatchWithSound ? false : muted
      await el.play()
      setPlaying(true)
      setFailedAutoplay(false)
      onWatchWithSound?.(el)
    } catch (err) {
      // Retry muted if unmuted playback is blocked
      try {
        el.muted = true
        await el.play()
        setPlaying(true)
        setFailedAutoplay(false)
      } catch {
        console.warn('Video play blocked', err)
        setFailedAutoplay(true)
      }
    }
  }

  return (
    <div className={`relative overflow-hidden bg-black ${className}`}>
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        className="h-full w-full object-cover"
        playsInline
        muted={muted}
        loop={loop}
        controls={showControls && playing}
        preload="metadata"
      />
      {(!playing || failedAutoplay) && (
        <button
          type="button"
          onClick={handlePlayClick}
          className="absolute inset-0 flex items-center justify-center bg-black/45 transition hover:bg-black/35"
          aria-label="Play video"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-sec-silver text-black shadow-lg md:h-20 md:w-20">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </button>
      )}
    </div>
  )
}
