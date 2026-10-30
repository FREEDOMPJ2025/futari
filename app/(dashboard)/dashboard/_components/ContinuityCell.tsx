import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * One entry of the dashboard ContinuityRow (#1364): a text button, icon + name
 * + chevron, `text-sm` in ink-2 with no fill or border (#1851) — list weight,
 * quieter than the hero and the records, so the first record clears the fold
 * on a 375×667 screen. The visible row is 36px; the ::before reaches 4px up and
 * down so the tap area is still 44px. The state the old card spelled out
 * (「8月的回顧 · 看一看」) lives on in the aria-label.
 */
export function ContinuityCell({ href, title, ariaLabel, icon }: {
  href: string
  title: string
  ariaLabel: string
  icon: ReactNode
}) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className="relative h-9 inline-flex items-center gap-1.5 text-sm text-ink-2 no-underline before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']"
    >
      <span aria-hidden="true" className="inline-flex shrink-0">{icon}</span>
      <span className="whitespace-nowrap">{title}</span>
      <svg width="7" height="12" viewBox="0 0 7 12" fill="none" aria-hidden="true" className="shrink-0 text-ink-3">
        <path d="M1 1l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  )
}

/** 月回顧's mark: a calendar page. */
export function ReviewIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="16" height="14" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 9h16" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 3v4M15 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
