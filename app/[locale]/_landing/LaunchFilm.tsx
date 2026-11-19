'use client'

import { useEffect, useRef, useState } from 'react'
import { isInNativeShell } from '@/lib/playLaunch'
import { useMarkNativeShell } from '@/lib/useMarkNativeShell'
import { LAUNCH_FILM, LAUNCH_FILM_NAME, PHONE_QUERY, pickLaunchFilmSrc } from '@/lib/launchFilm'

/**
 * Launch film under the hero CTA (#1910). Rendered by Landing only when
 * `showsLaunchFilm(locale)`.
 *
 * Never the LCP element and no bytes before the visitor asks: the SSR box is an
 * empty 16:9 surface (reserves space, no layout shift); the `<video>` (and so
 * its poster) mounts only once the box nears the viewport, with
 * `preload="none"` and no autoplay. Hidden in both Capacitor shells the same
 * way as the Play badge (pre-paint `data-native-shell` + this hook), and the
 * `<video>` is never mounted there.
 */
export function LaunchFilm({ className }: { className?: string }) {
  useMarkNativeShell()
  const boxRef = useRef<HTMLDivElement>(null)
  // The one file to play, picked with matchMedia when the <video> mounts
  // (client only), so each device fetches exactly one file whatever a browser
  // does with `media` on a video's <source>.
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    if (isInNativeShell()) return
    const mount = () => setSrc(pickLaunchFilmSrc(window.matchMedia?.(PHONE_QUERY).matches ?? false))
    const box = boxRef.current
    if (!box || typeof IntersectionObserver === 'undefined') {
      mount()
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          mount()
          io.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(box)
    return () => io.disconnect()
  }, [])

  return (
    <div
      ref={boxRef}
      data-testid="launch-film"
      className={`[html[data-native-shell]_&]:hidden w-full aspect-video overflow-hidden rounded-card bg-surface-alt ${className ?? ''}`.trim()}
    >
      {src && (
        <video
          className="block w-full h-full"
          poster={LAUNCH_FILM.poster}
          aria-label={LAUNCH_FILM_NAME}
          muted
          playsInline
          controls
          preload="none"
        >
          <source src={src} type="video/mp4" />
          <track kind="subtitles" srcLang="zh-Hant" label="中文（繁體）" src={LAUNCH_FILM.captions} />
        </video>
      )}
    </div>
  )
}
