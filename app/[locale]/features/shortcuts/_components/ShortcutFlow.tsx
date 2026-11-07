'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fs } from './feature-shortcuts-css'

/** 'armed': the first frame, waiting to be seen. 'fading': leaving the rest frame. */
type Phase = 'rest' | 'armed' | 'fading' | 'live' | 'done'

/** A page that opens with this in view holds the finished picture, then fades into the first frame. */
const HOLD_MS = 800
const FADE_MS = 300

/**
 * The opening of /features/shortcuts (#1921): a phone-frame illustration beside
 * three steps. Server HTML (and a visit without JS, or under reduced motion) is
 * the last frame plus the whole step list, so the page reads without this
 * island. The markup stays on the server and arrives as `phone` and `steps`:
 * this component only moves `data-phase`, and the timeline is CSS
 * (feature-shortcuts-css.ts). That is also why leaving the screen can pause it
 * exactly where it is.
 *
 * It plays once, when at least half of the phone is on screen, and stops on the
 * finished picture. Failure looks like nothing breaking: it runs off-screen
 * where nobody sees it, or stays on the rest frame and the desktop visitor
 * never sees it move.
 */
export function ShortcutFlow({ phone, steps, playLabel }: { phone: ReactNode; steps: ReactNode; playLabel: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('rest')
  const [offScreen, setOffScreen] = useState(false)
  const [run, setRun] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timers: ReturnType<typeof setTimeout>[] = []
    let first = true
    const io = new IntersectionObserver(
      ([entry]) => {
        setOffScreen(!entry.isIntersecting)
        if (first) {
          first = false
          if (entry.isIntersecting) {
            timers.push(setTimeout(() => setPhase('fading'), HOLD_MS))
            timers.push(setTimeout(() => setPhase('live'), HOLD_MS + FADE_MS))
          } else {
            setPhase('armed')
          }
        } else if (entry.isIntersecting) {
          setPhase((p) => (p === 'armed' ? 'live' : p))
        }
      },
      { threshold: 0.5 },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      timers.forEach(clearTimeout)
    }
  }, [])

  const dataPhase = phase === 'rest' || phase === 'done' ? undefined : phase

  return (
    <div
      className={`${fs.flow} ${fs.layout}`}
      data-phase={dataPhase}
      data-paused={phase === 'live' && offScreen ? '' : undefined}
    >
      <div className={fs.phoneWrap}>
        <div
          key={run}
          ref={ref}
          className={fs.phone}
          aria-hidden="true"
          onAnimationEnd={(e) => {
            if (e.target instanceof HTMLElement && e.target.classList.contains(fs.ring)) setPhase('done')
          }}
        >
          {phone}
        </div>
        <div className={fs.ctl}>
          {phase === 'done' && (
            <button
              type="button"
              className={`${fs.ctlBtn} text-xs`}
              onClick={() => {
                setRun((r) => r + 1)
                setPhase('live')
              }}
            >
              {playLabel}
            </button>
          )}
        </div>
      </div>
      {steps}
    </div>
  )
}
