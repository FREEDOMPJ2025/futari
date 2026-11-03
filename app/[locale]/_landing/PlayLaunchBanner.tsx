'use client'

import { useEffect, useState } from 'react'
import type { Translations } from '@/lib/i18n/locales/zh-TW'
import { track } from '@/lib/analytics/track'
import { nativeShellPlatform } from '@/lib/platform'
import {
  NATIVE_SHELL_ATTR,
  PLAY_BANNER_OFF_ATTR,
  PLAY_LAUNCH_BANNER_DISMISS_KEY,
} from '@/lib/playLaunch'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'

/**
 * Late fallback for the pre-paint shell check (`lib/playLaunch.ts`): if the
 * shell's `Capacitor` global only appears after that script ran and neither
 * bridge object was there either, mark `<html>` once React is up. Used by the
 * banner and the Play badge.
 */
export function useMarkNativeShell(): void {
  useEffect(() => {
    if (nativeShellPlatform()) document.documentElement.setAttribute(NATIVE_SHELL_ATTR, '')
  }, [])
}

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
 */
export function PlayLaunchBanner({ t }: Props) {
  const [closed, setClosed] = useState(false)
  useMarkNativeShell()

  if (closed) return null

  const close = () => {
    try {
      window.localStorage.setItem(PLAY_LAUNCH_BANNER_DISMISS_KEY, '1')
    } catch {
      // private-mode storage failure: the banner may show again next visit.
    }
    document.documentElement.setAttribute(PLAY_BANNER_OFF_ATTR, '')
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
