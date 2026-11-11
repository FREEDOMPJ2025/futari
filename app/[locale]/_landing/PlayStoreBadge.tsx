'use client'

import Image from 'next/image'
import type { Locale } from '@/lib/i18n/locales-meta'
import { track } from '@/lib/analytics/track'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'
import { HIDDEN_IN_APP } from '@/lib/playLaunch'
import { useMarkNativeShell } from '@/lib/useMarkNativeShell'
import { useMarkStandalone } from '@/lib/useMarkStandalone'
import { useMarkVisitorPlatform } from '@/lib/useMarkVisitorPlatform'

/** en file only (ja / zh files have no side padding): cancel Google's
 *  transparent left padding wherever the App Store badge also shows. The en
 *  PNG's first opaque column is x=41 of 250px height, shown at 80px tall:
 *  41 * 80 / 250 = 13.12px. */
const NEXT_TO_APP_STORE_EN = '[html:not([data-visitor-platform=android])_&]:-ml-[13.1px]'

/** Google's official badge files, one per locale, untouched (646×250 incl.
 *  Google's own clear-space padding). Don't crop, recolour or re-export them:
 *  Google's badge guidelines forbid altering the artwork. */
export function playBadgeSrc(locale: Locale): string {
  return `/badges/google-play-${locale}.png`
}

interface Props {
  locale: Locale
  /** The words printed on that locale's badge (`landing.playBadgeAlt`). */
  alt: string
  className?: string
}

/**
 * Official Google Play badge under the hero CTA (#1901), linking to the Play
 * listing. Rendered in the server HTML (no layout shift) and hidden before
 * first paint inside either native shell by the landing's pre-paint script
 * (`lib/playLaunch.ts`): Apple 2.3.10 bars other platforms in the iOS app, and
 * the Android app shows no download links. Since #1930 it sits right of the
 * App Store badge and is also hidden pre-paint in iOS browsers (only the App
 * Store badge there).
 *
 * Size: 80px tall, so the visible badge (Google's padding excluded) is ~54px,
 * the same height as the mobile App Store CTA: Google asks that the badge be
 * no smaller than other stores' badges on the page. The trademark line Google
 * requires is in the landing footer.
 *
 * No "Taiwan only" line under the badge: that hint appears once, under the
 * main CTA (`LandingCtaHint`), per the PM decision on #1905.
 *
 * Wherever the App Store badge also shows (not on Android), the en badge gets
 * a -13.1px left margin that cancels Google's transparent padding on that side,
 * so the visible gap between the two badge bodies is the row's 16px column gap
 * (the ja / zh files have no side padding, so no margin there).
 */
export function PlayStoreBadge({ locale, alt, className }: Props) {
  useMarkNativeShell()
  useMarkStandalone()
  useMarkVisitorPlatform()

  return (
    <div
      className={`${HIDDEN_IN_APP} [html[data-visitor-platform=ios]_&]:hidden ${locale === 'en' ? NEXT_TO_APP_STORE_EN : ''} ${className ?? ''}`.trim()}
    >
      <a
        href={PLAY_STORE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="block w-fit rounded-xl outline-none focus-visible:oik-focus-ring"
        onClick={() => track('landing_cta_clicked', { cta_location: 'play_badge', target: 'play_store' })}
      >
        {/* `unoptimized`: serve Google's file byte-for-byte rather than a
            re-encoded copy from the image optimizer. */}
        <Image
          src={playBadgeSrc(locale)}
          alt={alt}
          width={207}
          height={80}
          unoptimized
          className="block h-20 w-auto"
        />
      </a>
    </div>
  )
}
