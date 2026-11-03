/**
 * Pure resolver for the landing page's device-dependent primary CTA (#1413).
 *
 * Platform can only be known client-side: one prod deployment serves the web
 * site plus both Capacitor native shells (`server.url` points every shell at
 * the same remote page — see CLAUDE.md 三平台架構), so there is no build-time
 * flag and no SSR signal to branch on. Every input here comes from something
 * only readable in the browser at render time; callers collect them (see
 * `lib/useVisitorPlatformTarget.ts`) and this function stays a plain,
 * synchronous, fully-testable mapping from those inputs to a CTA variant.
 */

export type VisitorPlatformTarget = 'dashboard' | 'sign_in' | 'app_store' | 'play_store'

export interface ResolveVisitorPlatformInput {
  /** `navigator.userAgent`. */
  userAgent: string
  /** `navigator.maxTouchPoints` — disambiguates iPadOS from a real Mac (below). */
  maxTouchPoints: number
  /** Running inside a Capacitor native shell (iOS or Android WebView). */
  isCapacitor: boolean
  /** Running as an installed PWA (`display-mode: standalone`), see `lib/install-guide.ts`. */
  isStandalone: boolean
  /** A local Supabase session already exists. */
  hasSession: boolean
}

// #1413 — region-neutral: Apple redirects `/app/id...` to the visitor's own
// storefront, so don't hard-code a locale segment into it (carried over from
// the #1333 note this replaces).
// #1555 — App Store Connect campaign parameters (pt = our provider token,
// public by design; ct = campaign name; mt=8 = App Store). Without them every
// download that starts from the landing CTA is counted under 「網頁推薦」 with
// no campaign, so ASC's 宣傳活動 report can't tell whether the landing drives
// installs. Failure looks like: the landing → App Store share stays an
// unexplained 0 in ASC while PostHog shows CTA clicks. ASC only shows a
// campaign once ≥5 distinct Apple accounts installed through it.
export const APP_STORE_URL = 'https://apps.apple.com/app/id6779264784?pt=128976951&ct=landing&mt=8'

// #1901 — Android 1.9.0 is live on Google Play (production track, Taiwan only,
// since 2026-11-02). It replaces the #1648 closed-test join flow (Google Group
// + Play opt-in page). This is the one URL every Android "download" link uses:
// landing CTA, Play badge, launch banner, dashboard card, settings share row,
// outing line and /android-beta.
// Visitors outside Taiwan who open it get Play's "not available in your
// country" page, which is why the CTA carries the "Taiwan only" hint
// (`landing.playStoreCtaHint`). Failure looks like: a ja/en visitor taps the
// CTA and hits that page with no warning. Remove the hint once more countries
// open, not before.
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=dev.southernlight.futari'

/** Public page (no locale prefix); always build the href with `localizedHref`.
 *  Since #1901 it is the "closed testing is over, the app is on Play" page,
 *  kept (not redirected) so links shared during the test still make sense. */
export const ANDROID_BETA_PATH = '/android-beta'

/**
 * Which primary-CTA variant a visitor should see. Precedence:
 *
 *   1. signed in                              → dashboard
 *   2. Capacitor shell / installed PWA         → sign_in (never a store link —
 *      Apple Guideline 3.1.1, and #1901: no "download the app" link from
 *      inside the app on either shell)
 *   3. iPhone / iPad browser                   → app_store
 *   4. Android browser                         → play_store (#1901)
 *   5. everything else (desktop, etc.)         → sign_in
 */
export function resolveVisitorPlatform({
  userAgent,
  maxTouchPoints,
  isCapacitor,
  isStandalone,
  hasSession,
}: ResolveVisitorPlatformInput): VisitorPlatformTarget {
  if (hasSession) return 'dashboard'
  if (isCapacitor || isStandalone) return 'sign_in'

  const ua = userAgent.toLowerCase()
  // iPadOS 13+ reports as Macintosh in the UA string; touch points disambiguate
  // it from a real Mac (same heuristic as `lib/install-guide.ts#getPlatform`).
  const isIos = /iphone|ipad|ipod/.test(ua) || (/macintosh/.test(ua) && maxTouchPoints > 1)
  if (isIos) return 'app_store'

  if (/android/.test(ua)) return 'play_store'

  return 'sign_in'
}
