'use client'

import type { CSSProperties, ReactNode } from 'react'
import { useVisitorPlatformTarget } from '@/lib/useVisitorPlatformTarget'
import { LandingCtaLink } from './LandingCtaLink'

interface Props {
  /** Sign-in href — this link always goes there (#1413), whichever label it wears. */
  signInHref: string
  className?: string
  style?: CSSProperties
  /** Default label ("已經有帳號 · 登入") for every variant except play_store. */
  children: ReactNode
  /** Android browser label ("先用網頁版") — Google Play is the primary CTA
   *  there (#1901), so this link needs to read as an alternative, not a
   *  returning-user sign-in (#1413). */
  androidLabel: ReactNode
}

/**
 * Secondary sign-in link next to/under the landing's primary CTA. Same
 * platform resolution as `LandingPrimaryCta` (independent instance): every
 * variant keeps the "already have an account" label except `play_store`,
 * whose primary CTA is the Play listing, so this reads "use the web
 * version instead" (#1413, #1901).
 *
 * #1521: while the platform is pending it renders the default label as a real,
 * clickable sign-in link (also with JS off). Only the label text can change on
 * Android after hydration. A pre-hydration tap is a plain navigation and fires
 * no `landing_cta_clicked`; see `LandingPrimaryCta`.
 */
export function LandingSecondaryCta({ signInHref, className, style, children, androidLabel }: Props) {
  const target = useVisitorPlatformTarget()

  return (
    <LandingCtaLink
      href={signInHref}
      ctaLocation="secondary"
      target="sign_in"
      className={className}
      style={style}
    >
      {target === 'play_store' ? androidLabel : children}
    </LandingCtaLink>
  )
}
