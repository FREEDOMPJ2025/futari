'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from '@/lib/i18n/client'
import { nativeShellPlatform } from '@/lib/platform'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'

const SUPPORT_EMAIL = 'support@southern-light.dev'
const FEEDBACK_SUBJECT = 'Futari feedback'
const APP_STORE_REVIEW_URL = 'https://apps.apple.com/app/id6779264784?action=write-review'

const rowClassName = 'w-full flex items-center justify-between px-5 py-4 rounded-card text-left bg-transparent cursor-pointer'
const rowStyle = { background: 'var(--surface)', border: '1px solid var(--hairline)' }

/**
 * Settings > App: a feedback row (mailto) and a store-rating row (#1956).
 * Only inside the iOS / Android shells; web and PWA render nothing, and nothing
 * renders until mounted so SSR and hydration agree (same pattern as SupportRow).
 *
 * Both links leave the WebView: Capacitor hands any URL off the `server.url`
 * host to the OS (Android `Bridge.launchIntent`, iOS `WebViewDelegationHandler`
 * decidePolicyFor / createWebViewWith -> `UIApplication.shared.open`).
 * Deliberately no system review prompt (`requestReview`, In-App Review) and no
 * analytics event. The mailto carries only version, platform and locale.
 */
export function AppFeedbackRows({ appVersion, locale }: { appVersion: string; locale: string }) {
  const t = useTranslations()
  const [platform, setPlatform] = useState<ReturnType<typeof nativeShellPlatform>>(null)
  const [showFallback, setShowFallback] = useState(false)
  const cancelFallback = useRef<(() => void) | null>(null)

  useEffect(() => {
    setPlatform(nativeShellPlatform())
    return () => cancelFallback.current?.()
  }, [])

  function startFallbackTimer() {
    cancelFallback.current?.()
    setShowFallback(false)

    // The shells give the page no failure signal, so staying visible and focused is a heuristic.
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') cancel()
    }

    const timer = window.setTimeout(() => {
      cancel()
      if (document.visibilityState === 'visible') setShowFallback(true)
    }, 1500)

    function cancel() {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', cancel)
      window.removeEventListener('blur', cancel)
      cancelFallback.current = null
    }

    cancelFallback.current = cancel
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', cancel)
    window.addEventListener('blur', cancel)
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL)
    } catch {
      // The address remains selectable if clipboard access fails.
    }
  }

  if (!platform) return null

  const isIOS = platform === 'ios'
  const body = [
    `App version: ${appVersion}`,
    `Platform: ${isIOS ? 'iOS' : 'Android'}`,
    `Language: ${locale}`,
  ].join('\n')
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(FEEDBACK_SUBJECT)}&body=${encodeURIComponent(body)}`

  return (
    <>
      <div className="mt-3">
        <a href={mailto} onClick={startFallbackTimer} className={rowClassName} style={rowStyle}>
          <span className="text-sm font-medium" style={{ color: 'var(--ink)' }}>{t.appFeedback.feedbackTitle}</span>
          <span className="text-sm shrink-0" style={{ color: 'var(--ink-3)' }} aria-hidden="true">›</span>
        </a>
        {showFallback && (
          <div className="mt-2 px-5 text-sm" style={{ color: 'var(--ink)' }}>
            <p>{t.appFeedback.noMailHint}</p>
            <p className="select-text">{SUPPORT_EMAIL}</p>
            <button type="button" onClick={copyAddress} className="font-medium underline">{t.appFeedback.copy}</button>
          </div>
        )}
      </div>
      <div className="mt-3">
        <a
          href={isIOS ? APP_STORE_REVIEW_URL : PLAY_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={rowClassName}
          style={rowStyle}
        >
          <span className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
            {isIOS ? t.appFeedback.rateAppStore : t.appFeedback.ratePlay}
          </span>
          <span className="text-sm shrink-0" style={{ color: 'var(--ink-3)' }} aria-hidden="true">›</span>
        </a>
      </div>
    </>
  )
}
