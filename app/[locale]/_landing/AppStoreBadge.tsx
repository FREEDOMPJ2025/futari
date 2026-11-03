'use client'

import Image from 'next/image'
import type { Locale } from '@/lib/i18n/locales-meta'
import { track } from '@/lib/analytics/track'
import { appStoreUrl } from '@/lib/visitorPlatform'
import { useMarkNativeShell } from '@/lib/useMarkNativeShell'

/** Apple's official black badge files, one per locale, untouched. Don't
 *  recolour, crop or re-export them: Apple's badge guidelines forbid altering
 *  the artwork. */
export function appStoreBadgeSrc(locale: Locale): string {
  return `/badges/app-store-${locale}.svg`
}

/** Intrinsic width at 54px tall, from each SVG's viewBox (40px tall). */
const WIDTH_AT_54: Record<Locale, number> = {
  en: 162, // 119.66 × 54/40
  'zh-TW': 147, // 108.85 × 54/40
  'zh-CN': 147,
  ja: 147,
}

interface Props {
  locale: Locale
  /** The words printed on that locale's badge (`landing.appStoreBadgeAlt`). */
  alt: string
}

/**
 * Official App Store badge in the desktop download block (#1906), linking to
 * the App Store with `ct=landing-desktop` so ASC separates desktop visitors
 * from the phone CTA (`ct=landing`). 54px tall, matching the visible height
 * of the Google Play badge next to it (whose file carries its own padding).
 *
 * Hidden in both native shells by the block's `[html[data-native-shell]_&]`
 * class (Apple 3.1.1: no download links inside the app); this hook marks
 * `<html>` on client navigation where the pre-paint script didn't run.
 */
export function AppStoreBadge({ locale, alt }: Props) {
  useMarkNativeShell()

  return (
    <a
      href={appStoreUrl('landing-desktop')}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block rounded-lg outline-none focus-visible:oik-focus-ring"
      onClick={() => track('landing_cta_clicked', { cta_location: 'app_store_badge', target: 'app_store' })}
    >
      {/* `unoptimized`: serve Apple's file byte-for-byte. */}
      <Image
        src={appStoreBadgeSrc(locale)}
        alt={alt}
        width={WIDTH_AT_54[locale]}
        height={54}
        unoptimized
        className="block h-[54px] w-auto"
      />
    </a>
  )
}
