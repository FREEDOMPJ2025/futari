'use client'

import { useEffect, useState } from 'react'
import { track } from '@/lib/analytics/track'
import { useTranslations } from '@/lib/i18n/client'
import { getPlatform } from '@/lib/install-guide'
import { getCapacitorPlatform } from '@/components/KofiWidget'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'

/**
 * One quiet line on the public outing page for Android browser visitors,
 * pointing at the Google Play listing (#1901; was the closed-test join page,
 * #1648). Friends who open an outing link are exactly the people who may not
 * have Futari yet.
 *
 * Same privacy rules as FeatureOutingLink: the href is a fixed URL, never the
 * share token, and `rel="noreferrer"` keeps this page's URL (which holds the
 * token on the picker) out of the Referer sent to Google Play. The click event
 * has no properties, so nothing from the URL can reach PostHog. Failure looks
 * like: the outing share token turning up in a referrer or in PostHog, with no
 * error anywhere.
 *
 * Shown only in an Android browser: not iPhone or desktop, and not inside any
 * Capacitor shell (a shell visitor is already in the app). Runtime detection,
 * nothing before mount so SSR and the first client render agree.
 */
export function AndroidBetaOutingLink() {
  const t = useTranslations()
  const [show, setShow] = useState(false)

  useEffect(() => {
    // Capacitor reports 'web' off-shell; either shell ('ios' or 'android') hides the line.
    setShow(getCapacitorPlatform() === 'web' && getPlatform() === 'android')
  }, [])

  if (!show) return null

  return (
    <p className="px-4 pb-8 m-0 -mt-6">
      <a
        href={PLAY_STORE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-ink-3 underline"
        onClick={() => track('android_beta_outing_link_clicked')}
      >
        {t.androidBeta.outingLine}
      </a>
    </p>
  )
}
