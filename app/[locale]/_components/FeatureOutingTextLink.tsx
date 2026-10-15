'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { track } from '@/lib/analytics/track'

/**
 * Where a `feature_outing_link_clicked` came from: a fixed label, never URL
 * content. The in-app and share-page entries (`outing_share`, `outings_empty`)
 * fire their own calls; this union covers the brand pages' links (#1633, #1724).
 */
export type FeatureOutingLinkSource =
  | 'use_case_travel'
  | 'use_case_aa_split'
  | 'use_case_hub'
  | 'migrate_splitwise'
  | 'landing_features'
  | 'landing_footer'

/** A plain text link to /features/outing that records which entry was used. */
export function FeatureOutingTextLink({
  href,
  source,
  className,
  children,
}: {
  href: string
  source: FeatureOutingLinkSource
  className?: string
  children: ReactNode
}) {
  return (
    <Link href={href} className={className} onClick={() => track('feature_outing_link_clicked', { source })}>
      {children}
    </Link>
  )
}
