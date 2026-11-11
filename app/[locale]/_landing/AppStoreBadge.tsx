'use client'

import Image from 'next/image'
import type { Locale } from '@/lib/i18n/locales-meta'
import { track } from '@/lib/analytics/track'
import { APP_STORE_BADGE_URL } from '@/lib/visitorPlatform'
import { useMarkNativeShell } from '@/lib/useMarkNativeShell'
import { useMarkVisitorPlatform } from '@/lib/useMarkVisitorPlatform'

/** Apple's official black "Download on the App Store" badge, one per locale,
 *  untouched (40px tall, no padding). Don't recolour, crop or re-export it:
 *  Apple's marketing guidelines forbid altering the artwork. */
export function appStoreBadgeSrc(locale: Locale): string {
  return `/badges/app-store-${locale}.svg`
}

interface Props {
  locale: Locale
  /** The words printed on that locale's badge (`landing.appStoreBadgeAlt`). */
  alt: string
  className?: string
}

/**
 * Official App Store badge in the hero badge row (#1930), left of the Google
 * Play badge, linking to the App Store listing under its own ASC campaign
 * (`APP_STORE_BADGE_URL`). Rendered in the server HTML and hidden before first
 * paint by the landing's pre-paint script (`lib/playLaunch.ts`): inside either
 * native shell (Apple 3.1.1; the Android app shows no download links), and in
 * Android browsers (only the Play badge there).
 *
 * Size: same VISIBLE height as the Google Play badge next to it. Google's en
 * file has ~13px padding all round, so at 80px tall the badge body is ~54px;
 * its ja / zh files are cropped tighter (body 190 of 250px, no side padding),
 * so at 80px the body is ~61px. Apple's badge is therefore 54px (en) / 61px
 * (other locales) tall. Apple's minimum on screen is 40px. Apple's clear space (a quarter of the badge
 * height, ~14px) is met by the row's 12px gap plus the Play badge's own
 * transparent padding. The trademark line is in the landing footer.
 */
export function AppStoreBadge({ locale, alt, className }: Props) {
  useMarkNativeShell()
  useMarkVisitorPlatform()

  return (
    <div
      className={`[html[data-native-shell]_&]:hidden [html[data-visitor-platform=android]_&]:hidden ${className ?? ''}`.trim()}
    >
      <a
        href={APP_STORE_BADGE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block rounded-xl outline-none focus-visible:oik-focus-ring"
        onClick={() => track('landing_cta_clicked', { cta_location: 'app_store_badge', target: 'app_store' })}
      >
        {/* `unoptimized`: serve Apple's file byte-for-byte. width/height only
            give the intrinsic aspect (en badge 120×40, CJK badges 109×40). */}
        <Image
          src={appStoreBadgeSrc(locale)}
          alt={alt}
          width={locale === 'en' ? 120 : 109}
          height={40}
          unoptimized
          className={locale === 'en' ? 'block h-[54px] w-auto' : 'block h-[61px] w-auto'}
        />
      </a>
    </div>
  )
}
