'use client'

import { useEffect, useState } from 'react'
import { DEFAULT_LOCALE } from '@/lib/i18n/locales-meta'
import { globalErrorCopy, pickGlobalErrorLocale } from '@/lib/i18n/globalErrorCopy'
import { reportClientError } from '@/lib/observability/reportClientError'
import { sanitizeAnalyticsUrl } from '@/lib/analytics/urlSanitizer'
import { isCancelledFetchError, isNavigatingAway } from '@/lib/observability/navigatingAway'
import './globals.css'
// 根 layout 被整個取代，Fraunces 的 @font-face 與 `.font-fraunces`（定義 --font-fraunces）
// 也要自己帶；少了它 `font-serif` 會靜默退回內文字體，不會報錯。
import './fonts/fraunces.css'

/** How long a "navigating away" error page stays blank before it gives up and shows itself (#1768). */
const LEAVING_GRACE_MS = 4000

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  // Starts at DEFAULT_LOCALE (matches what a server pass would produce, since
  // `document`/`navigator` don't exist there) and only switches after mount.
  // Picking the real locale directly in `useState(() => …)` would run during
  // the first client render too, which can disagree with the server-rendered
  // HTML React already sent down for this same paint and trip a hydration
  // mismatch. The trade-off is a one-frame flash of zh-TW copy for non-zh-TW
  // users, which is the right side to take it on: this page exists because
  // something already broke, so a correctness-over-flash choice here is fine.
  const [locale, setLocale] = useState(DEFAULT_LOCALE)
  // #1768 — a request cancelled because this page is already navigating away
  // on purpose (sign-in success → window.location) is not an error. Stay blank
  // and quiet; the next page replaces this one. If it is still here after
  // LEAVING_GRACE_MS the navigation did not happen, so fall through to the
  // normal page and report — the user must never be stuck on a blank screen.
  const [leaving, setLeaving] = useState(() => isNavigatingAway() && isCancelledFetchError(error))

  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => setLeaving(false), LEAVING_GRACE_MS)
    return () => clearTimeout(timer)
  }, [leaving])

  useEffect(() => {
    if (leaving) return
    // reportClientError loads Sentry through a dynamic import (#1520): Next
    // lists this entry in every page's HTML, so a static Sentry import here put
    // the whole SDK back in the public pages' first load. The module is the same
    // one instrumentation-client loads, so it is not initialised twice. If the
    // Sentry chunk is unavailable (the usual reason this page is showing may be
    // a failed chunk load) the report is lost with no other symptom; the error
    // page still renders and stays usable.
    //
    // route (#1768): pathname only, never search or hash, and with invite /
    // outing tokens masked (`/invite/:token`). This page can render on a public
    // token route, and the Sentry scrub does not rewrite a tag named `route`.
    reportClientError(error, {
      area: 'global-error',
      route: sanitizeAnalyticsUrl(window.location.pathname) || undefined,
      digest: error.digest,
    })
    setLocale(pickGlobalErrorLocale())
  }, [error, leaving])

  const t = globalErrorCopy[locale]

  if (leaving) {
    return (
      <html lang={locale} className="font-fraunces" suppressHydrationWarning>
        <body className="min-h-dvh bg-bg" />
      </html>
    )
  }

  return (
    // suppressHydrationWarning: 同 app/layout.tsx（#1424）——Android 殼在 hydrate
    // 前寫入的 --safe-area-inset-* 只影響 <html> 自己的屬性。
    <html lang={locale} className="font-fraunces" suppressHydrationWarning>
      <body>
        <main className="min-h-dvh flex flex-col items-center justify-center px-6 py-16 text-center bg-bg">
          <div className="max-w-md w-full">
            <h1 className="font-serif font-medium text-ink text-page mb-3">
              {t.title}
            </h1>
            <p className="text-sm leading-relaxed mb-8 text-ink-2">
              {t.body}
            </p>

            <button
              type="button"
              onClick={reset}
              className="w-full inline-flex items-center justify-center gap-2 rounded-bubble font-medium oik-btn transition-opacity duration-150 h-12 px-6 text-base bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] border-0 cursor-pointer"
            >
              {t.retry}
            </button>

            {/* Plain <a>, not next/link, on purpose: this page renders when the
                app itself may be broken, so the safest way home is a full
                navigation the router doesn't have to cooperate with. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              className="block mt-6 text-sm underline-offset-4 hover:underline focus-visible:oik-focus-ring outline-none text-ink-2"
            >
              {t.home}
            </a>
          </div>
        </main>
      </body>
    </html>
  )
}
