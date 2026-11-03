'use client'

import { useEffect, useRef, useState } from 'react'
import { getCapacitorPlatform } from '@/components/KofiWidget'
import { track } from '@/lib/analytics/track'
import { useTranslations } from '@/lib/i18n/client'
import { hasShareSheet, isShareCancel, openShareSheet } from '@/lib/shareSheet'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'

/**
 * Settings row that shares the Google Play listing with a partner or friend
 * who uses Android (#1901; until then it shared the /android-beta join page,
 * #1648). The shared URL is the plain Play listing, no attribution params.
 *
 * Browser only (any browser or installed PWA): hidden inside both Capacitor
 * shells. iOS: Apple Guideline 2.3.10 bars mentioning other mobile platforms.
 * Android: the app shows no "download the app" link (#1901). An iPhone user in
 * a browser is still the likeliest person to know an Android user, so the row
 * stays for iPhone browsers. The gate is runtime (see KofiWidget): one
 * deployment serves all shells. Failure looks like: the row appearing inside
 * either app, with no error, and surfacing only in App Review or on a device.
 * Nothing renders before mount so SSR and the first client render agree.
 *
 * Share: the system sheet when there is one (`lib/shareSheet.ts`: Web Share),
 * else (or on a failure that isn't a cancel) the clipboard plus an inline
 * confirmation. User cancel does nothing. The event keeps its
 * `android_beta_share_clicked` name so the series continues.
 */
export function AndroidTesterInviteRow() {
  const t = useTranslations()
  const [show, setShow] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Capacitor reports 'web' off-shell; either shell ('ios' or 'android') hides the row.
    setShow(getCapacitorPlatform() === 'web')
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  if (!show) return null

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      return
    }
    track('android_beta_share_clicked', { method: 'copy' })
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }

  const handleClick = async () => {
    const url = PLAY_STORE_URL
    if (hasShareSheet()) {
      try {
        await openShareSheet({ title: t.androidTesterInvite.shareTitle, text: t.androidTesterInvite.shareText, url })
        track('android_beta_share_clicked', { method: 'share' })
        return
      } catch (e) {
        if (isShareCancel(e)) return
      }
    }
    await copy(url)
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={handleClick}
        className="w-full flex items-center justify-between px-5 py-4 rounded-card text-left bg-transparent cursor-pointer"
        style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
      >
        <div className="flex flex-col min-w-0">
          <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
            {t.androidTesterInvite.title}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--ink-3)' }}>
            {copied ? t.androidTesterInvite.copied : t.androidTesterInvite.hint}
          </div>
        </div>
        <div className="text-sm flex items-center gap-2 shrink-0" style={{ color: 'var(--ink-3)' }}>
          <span aria-hidden="true">›</span>
        </div>
      </button>
    </div>
  )
}
