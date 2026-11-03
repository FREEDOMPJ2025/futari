'use client'

import { track } from '@/lib/analytics/track'
import type { Translations } from '@/lib/i18n/locales/zh-TW'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'
import { useMarkNativeShell } from '@/lib/useMarkNativeShell'

const BUTTON_CLASS =
  'fc-edge inline-flex items-center justify-center h-12 px-6 rounded-xl bg-ink no-underline text-[var(--on-fill)] text-base font-medium'

interface Props {
  t: Translations['androidBeta']
  /** Play button label and the Taiwan-only hint under it (`landing.playStoreCta*`). */
  playStoreCta: string
  playStoreCtaHint: string
  /** Locale-pinned sign-in href, the "use the web version" exit. */
  webHref: string
}

/**
 * Body of /android-beta since #1901: closed testing is over and the app is on
 * Google Play, so the page thanks the testers and offers the Play listing (no
 * group or opt-in steps any more). Kept as a page rather than a redirect so a
 * link shared during the test still explains what happened.
 *
 * The Play click reuses `android_beta_step_clicked` with `step: 'play_store'`
 * (the page's existing event; `join_group` / `open_testing` no longer fire).
 *
 * The Play button hides inside either native shell, like the landing's Play
 * badge (Apple 2.3.10 / 3.1.1 in the iOS app; the Android app is already
 * installed). Nothing in the app links here, so this page has no pre-paint
 * script: in a shell the button may show until hydration.
 */
export function AndroidBetaSteps({ t, playStoreCta, playStoreCtaHint, webHref }: Props) {
  useMarkNativeShell()

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1
          className="text-page leading-tight m-0 mb-3"
          style={{ fontFamily: 'var(--font-fraunces)', color: 'var(--ink)', fontWeight: 500 }}
        >
          {t.title}
        </h1>
        <p className="text-sm leading-relaxed m-0 text-ink-2">{t.body}</p>
      </header>

      <div className="[html[data-native-shell]_&]:hidden flex flex-col gap-2 items-start">
        <a
          href={PLAY_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={BUTTON_CLASS}
          onClick={() => track('android_beta_step_clicked', { step: 'play_store' })}
        >
          {playStoreCta}
        </a>
        <p className="text-xs leading-relaxed m-0 text-ink-2">{playStoreCtaHint}</p>
      </div>

      <a
        href={webHref}
        className="inline-flex items-center min-h-11 text-sm underline underline-offset-4 self-start text-ink"
      >
        {t.useWebVersion}
      </a>
    </div>
  )
}
