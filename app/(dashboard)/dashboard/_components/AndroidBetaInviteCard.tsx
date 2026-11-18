'use client'

import { useEffect, useState } from 'react'
import { track } from '@/lib/analytics/track'
import { useTranslations } from '@/lib/i18n/client'
import { getPlatform } from '@/lib/install-guide'
import { detectPlatform } from '@/lib/platform'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'

/** Global, one-time: the card is about the device, not about a ledger or chapter.
 *  A new key for #1901 on purpose: people who closed the old closed-test invite
 *  (`futari_android_beta_invite_dismissed`) haven't seen the Play launch yet. */
const DISMISS_KEY = 'futari_android_play_card_dismissed'

/**
 * One-time card for Android *web* users (browser or installed PWA): the app is
 * on Google Play now (#1901; until then this invited them to the closed test,
 * #1553/#1648). Never on iOS, desktop or inside the Capacitor shell: the shell
 * user already has the app, and the app shows no "download the app" link.
 *
 * Hidden on first render and decided in an effect, so server HTML and the
 * first client render agree. A failing `localStorage` (private mode) reads as
 * "not dismissed": the worst case is the card showing again next visit.
 *
 * Events keep their `android_beta_invite_*` names so the series continues;
 * since #1901 `clicked` means "opened the Play listing" (observability-design.md).
 */
export function AndroidBetaInviteCard() {
  const t = useTranslations()
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (getPlatform() !== 'android') return
    if (detectPlatform() === 'android_native') return
    try {
      if (window.localStorage.getItem(DISMISS_KEY)) return
    } catch {
      // unreadable storage: fall through and show
    }
    setShow(true)
    track('android_beta_invite_shown')
  }, [])

  if (!show) return null

  const markDismissed = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // private-mode storage failure: the card may show again next time.
    }
    setShow(false)
  }

  const handleDismiss = () => {
    track('android_beta_invite_dismissed')
    markDismissed()
  }

  // Opening the listing is the answer to the card, so a click retires it too.
  const handleCta = () => {
    track('android_beta_invite_clicked')
    markDismissed()
  }

  return (
    <div className="px-5 pt-4">
      <div
        className="rounded-card px-5 py-4 flex items-start gap-3"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--hairline)',
        }}
        role="status"
      >
        <div className="flex-1">
          <div
            className="cjk-h text-base leading-tight"
            style={{ fontFamily: 'var(--font-fraunces)', color: 'var(--ink)', fontWeight: 500 }}
          >
            {t.androidBetaInvite.heading}
          </div>
          <p className="text-sm mt-1.5 leading-relaxed" style={{ color: 'var(--ink-2)' }}>
            {t.androidBetaInvite.body}
          </p>
          <a
            href={PLAY_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleCta}
            className="inline-block text-sm mt-2 underline underline-offset-4"
            style={{ color: 'var(--ink)' }}
          >
            {t.androidBetaInvite.cta}
          </a>
          <p className="text-xs mt-1" style={{ color: 'var(--ink-3)' }}>
            {t.landing.playStoreCtaHint}
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t.postLeave.dismissAria}
          // Bare ✕ glyph, ~14px; ::before pads the hit area to ~46px (#1197).
          className="relative text-sm leading-none cursor-pointer self-start before:absolute before:-inset-4 before:content-['']"
          style={{ background: 'transparent', border: 'none', color: 'var(--ink-3)' }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
