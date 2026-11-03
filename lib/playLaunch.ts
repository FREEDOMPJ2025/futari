/**
 * Google Play launch promotion on the landing page (#1901): the dismissible
 * "the Android app is here" banner and the Play badge.
 *
 * Both must never show inside a Capacitor shell (iOS: Apple 2.3.10 forbids
 * mentioning other mobile platforms, 3.1.1 forbids "download" links; Android:
 * the visitor already has the app). Platform is runtime-only (CLAUDE.md
 * 三平台架構), and both elements sit in the first screen, so hiding them in
 * an effect after hydration would make them flash and then collapse, shifting
 * the page under the reader (CLS). Instead the landing renders them in the
 * server HTML and runs `LANDING_PRE_PAINT_SCRIPT` before they are parsed: it
 * marks `<html>` with `data-native-shell` and/or `data-play-banner-off`, and
 * a Tailwind arbitrary variant on each element hides it before the first
 * paint. A returning visitor who dismissed the banner therefore never sees it
 * or the gap it would leave. `<html>` carries `suppressHydrationWarning`
 * (app/layout.tsx), so these attributes don't trip hydration. The script only
 * runs on a full load, so the components repeat the same checks in a layout
 * effect (`isPlayLaunchBannerOff`, `isInNativeShell`) for client-side
 * navigation back to the landing.
 *
 * Failure looks like: the banner appearing for a split second and the page
 * jumping up when it vanishes (script not running before the banner), or the
 * Play badge showing inside the iOS app (shell signal not detected) — no error
 * anywhere; the second one surfaces only in App Review.
 */

/**
 * Last day (Asia/Taipei) the launch banner is shown: two weeks after the
 * 2026-11-02 Play launch. The PM / Ray may move this date; nothing else needs
 * to change. From the next midnight in Taipei the banner no longer renders.
 */
export const PLAY_LAUNCH_BANNER_LAST_DAY = '2026-11-17'

/** Device-level, one-time: once closed, the banner stays closed on this browser. */
export const PLAY_LAUNCH_BANNER_DISMISS_KEY = 'futari_play_launch_banner_dismissed'

/** `<html>` attribute set when running inside either Capacitor shell. */
export const NATIVE_SHELL_ATTR = 'data-native-shell'
/** `<html>` attribute set when the banner should not show (dismissed or expired). */
export const PLAY_BANNER_OFF_ATTR = 'data-play-banner-off'

const DAY_MS = 24 * 60 * 60 * 1000

/** First instant the banner is over: midnight Taipei after the last day. */
export function playLaunchBannerEndsAt(lastDay: string = PLAY_LAUNCH_BANNER_LAST_DAY): number {
  return Date.parse(`${lastDay}T00:00:00+08:00`) + DAY_MS
}

export function isPlayLaunchBannerActive(now: number = Date.now(), lastDay: string = PLAY_LAUNCH_BANNER_LAST_DAY): boolean {
  return now < playLaunchBannerEndsAt(lastDay)
}

/**
 * Runtime twin of the banner half of `landingPrePaintScript`: dismissed on
 * this browser, or past the end date. The banner calls this itself on every
 * mount, because the inline script only runs on a full page load: React does
 * not execute a `<script>` it inserts during client-side navigation, so coming
 * back to `/` through an in-site link renders the landing without the script.
 * Failure looks like: the banner showing again after "close" when the visitor
 * clicks the logo on another page and lands back on the home page, until a
 * reload; no error anywhere. Keep in step with the script (a parity test in
 * tests/play-launch-1901.test.tsx runs both on the same inputs).
 */
export function isPlayLaunchBannerOff(now: number = Date.now(), endsAt: number = playLaunchBannerEndsAt()): boolean {
  if (now >= endsAt) return true
  try {
    return Boolean(window.localStorage.getItem(PLAY_LAUNCH_BANNER_DISMISS_KEY))
  } catch {
    return false
  }
}

/**
 * Runtime twin of the shell half of `landingPrePaintScript` (same three
 * signals, see below). `Capacitor` alone proves nothing: a web page that
 * imported `@capacitor/core` has it too, reporting 'web' (lib/platform.ts).
 */
export function isInNativeShell(): boolean {
  const w = window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean }
    androidBridge?: unknown
    webkit?: { messageHandlers?: { bridge?: unknown } }
  }
  return Boolean(w.Capacitor?.isNativePlatform?.() || w.androidBridge || w.webkit?.messageHandlers?.bridge)
}

/**
 * Inline, pre-paint. Shell signals, any one is enough:
 * - `Capacitor.isNativePlatform()` — the global the shells inject (a web build
 *   that imports `@capacitor/core` also defines `Capacitor`, reporting 'web').
 * - `androidBridge` — Capacitor Android's JavascriptInterface, present from the
 *   first script on the page, before `Capacitor` itself may be.
 * - `webkit.messageHandlers.bridge` — Capacitor iOS's message handler, likewise
 *   registered natively before any page script runs.
 * Wrapped in try/catch: a throwing script must never break the page.
 */
export function landingPrePaintScript(endsAt: number = playLaunchBannerEndsAt()): string {
  return (
    '(function(){try{var w=window,d=document.documentElement,c=w.Capacitor;' +
    'if((c&&c.isNativePlatform&&c.isNativePlatform())||w.androidBridge||' +
    '(w.webkit&&w.webkit.messageHandlers&&w.webkit.messageHandlers.bridge))' +
    `d.setAttribute('${NATIVE_SHELL_ATTR}','');` +
    `var off=Date.now()>=${endsAt};` +
    `try{if(localStorage.getItem('${PLAY_LAUNCH_BANNER_DISMISS_KEY}'))off=true}catch(e){}` +
    `if(off)d.setAttribute('${PLAY_BANNER_OFF_ATTR}','')}catch(e){}})()`
  )
}
