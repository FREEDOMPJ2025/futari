'use client'

import { useLayoutEffect, useState } from 'react'
import type { Translations } from '@/lib/i18n/locales/zh-TW'
import { track } from '@/lib/analytics/track'
import {
  PLAY_BANNER_OFF_ATTR,
  PLAY_LAUNCH_BANNER_DISMISS_KEY,
  isPlayLaunchBannerOff,
} from '@/lib/playLaunch'
import { useMarkNativeShell } from '@/lib/useMarkNativeShell'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'

const markBannerOff = () => document.documentElement.setAttribute(PLAY_BANNER_OFF_ATTR, '')

interface Props {
  t: Translations['landing']['launchBanner']
}

/**
 * Dismissible "the Android app is on Google Play" bar at the top of the
 * landing (#1901). Rendered in the server HTML only while
 * `isPlayLaunchBannerActive()`; hidden before first paint by the landing's
 * pre-paint script when dismissed, expired or inside a native shell (see
 * `lib/playLaunch.ts` for why it isn't decided in an effect). Closing it
 * stores `PLAY_LAUNCH_BANNER_DISMISS_KEY`, so it doesn't come back after a
 * reload. A failing `localStorage` (private mode) only means it shows again
 * on the next visit.
 *
 * The script only runs on a full load, so the banner also checks for itself
 * (`isPlayLaunchBannerOff`, the script's runtime twin) in a layout effect:
 * coming back to `/` by client-side navigation, the attribute is set before
 * the browser paints. It checks again when the tab regains visibility or
 * focus, so a page left open past the last day hides it then.
 */
export function PlayLaunchBanner({ t }: Props) {
  const [closed, setClosed] = useState(false)
  useMarkNativeShell()

  useLayoutEffect(() => {
    const check = () => {
      if (isPlayLaunchBannerOff()) markBannerOff()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    check()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', check)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', check)
    }
  }, [])

  if (closed) return null

  const close = () => {
    try {
      window.localStorage.setItem(PLAY_LAUNCH_BANNER_DISMISS_KEY, '1')
    } catch {
      // private-mode storage failure: the banner may show again next visit.
    }
    markBannerOff()
    setClosed(true)
  }

  return (
    <aside
      aria-label={t.text}
      className="[html[data-native-shell]_&]:hidden [html[data-play-banner-off]_&]:hidden relative z-20 flex items-center gap-3 px-6 md:px-12 py-2 border-b border-hairline bg-surface-alt text-ink"
    >
      <p className="m-0 flex-1 flex flex-wrap items-center justify-center gap-x-1.5 text-sm text-center">
        <span>{t.text}</span>
        <a
          href={PLAY_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center min-h-11 underline underline-offset-4 font-medium text-ink"
          onClick={() => track('landing_cta_clicked', { cta_location: 'launch_banner', target: 'play_store' })}
        >
          {t.link}
        </a>
      </p>
      <button
        type="button"
        onClick={close}
        aria-label={t.closeAria}
        className="shrink-0 inline-flex items-center justify-center size-11 -mr-3 text-sm leading-none cursor-pointer bg-transparent border-0 text-ink-3"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </aside>
  )
}
