import Link from 'next/link'

/**
 * One cell of the dashboard ContinuityRow (#1364): the whole cell is a single
 * link, ≥44px tall. Sans title (no serif — this is a list-weight entry, not a
 * moment), one truncated line of status, a chevron. Visually quieter than the
 * hero on purpose: no Ember, no amount — and, since #1851, no card either:
 * title and status share one line, so the row is one tap target tall and the
 * first record still clears the fold on a 375×667 screen.
 */
export function ContinuityCell({ href, title, subtitle, ariaLabel }: {
  href: string
  title: string
  subtitle: string
  ariaLabel: string
}) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className="flex-1 min-w-0 min-h-11 flex items-center gap-1.5 px-1 no-underline text-ink"
    >
      <span className="text-sm font-medium shrink-0">{title}</span>
      <span className="flex-1 min-w-0 text-xs truncate text-ink-3">{subtitle}</span>
      <svg width="8" height="13" viewBox="0 0 8 13" fill="none" aria-hidden="true" className="shrink-0 text-ink-3">
        <path d="M1.5 1.5L6.5 6.5L1.5 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  )
}
