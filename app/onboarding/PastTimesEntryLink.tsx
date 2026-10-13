import Link from 'next/link'

/**
 * #1612 — the way back into 過去的時光 for a signed-in person with no ledger
 * of their own (a removed partner), shown only when they have a closed
 * chapter they can open read-only (`hasClosedChapterForViewer`). It leads to
 * the standalone list at /onboarding/past-times, outside the dashboard layout.
 *
 * Fixed in a top corner, clear of each page's own controls: top-left on
 * /onboarding (the cards' 跳過 is top-right), top-right on /setup (its steps'
 * back button is top-left). Both pages are outside the dashboard layout and
 * pay `--safe-top` themselves.
 *
 * Failure without it: nothing errors; a removed person signs in, lands on
 * /onboarding → /setup, and has no way to reach the chapters they were in.
 */
const CORNER = {
  left: 'left-5',
  right: 'right-5',
} as const

export function PastTimesEntryLink({ label, corner }: { label: string; corner: keyof typeof CORNER }) {
  return (
    <Link
      href="/onboarding/past-times"
      className={`fixed ${CORNER[corner]} top-[calc(var(--safe-top)+16px)] z-20 inline-flex h-8 items-center gap-1 rounded-lg px-3 text-xs text-ink-2 no-underline`}
    >
      {label}
      <span aria-hidden="true">›</span>
    </Link>
  )
}
