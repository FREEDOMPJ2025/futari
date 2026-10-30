'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from '@/lib/i18n/client'
import { PayerDualToggle, SplitDualToggle } from './MemberDualToggle'
import type { DashboardPayer, DashboardSplit } from './useDashboardReducer'

interface DashboardFilterRowProps {
  payerFilter: DashboardPayer
  splitFilter: DashboardSplit
  onPayerChange: (next: DashboardPayer) => void
  onSplitChange: (next: DashboardSplit) => void
  viewerIsA: boolean
  t: ReturnType<typeof useTranslations>
  /** #1851 — set when the row heads the records list: the list's own title
   *  sits left of the chip on one line, and the toggles open below it. */
  title?: ReactNode
}

/**
 * L3 filter row, distilled. At rest it's a single 「篩選」chip, so the feed
 * isn't pushed down by a standing control band. Tapping the chip reveals the
 * payer (誰付) + split (誰負擔) dual-toggles inline; an active filter keeps
 * them revealed and fills the chip with ink + a dot so the state stays visible
 * even when the user hasn't expanded it. Mirrors the /records 篩選 chip's
 * filled-when-active treatment. Caller gates this on `!isSolo && partner`.
 */
export function DashboardFilterRow({
  payerFilter,
  splitFilter,
  onPayerChange,
  onSplitChange,
  viewerIsA,
  t,
  title,
}: DashboardFilterRowProps) {
  const [open, setOpen] = useState(false)
  const hasActiveFilter = payerFilter !== 'all' || splitFilter !== 'all'
  // Active filters force the toggles open so they're always adjustable; an
  // explicit tap opens them when nothing is filtered yet.
  const showToggles = open || hasActiveFilter

  // Visible chip stays 32px; the ::before extends the hit area 6px up and
  // down to 44px (same pattern as SettleButton, #147).
  const chip = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-expanded={showToggles}
      aria-label={t.dashboard.filterAriaLabel}
      className="relative h-8 px-3 rounded-full text-sm flex items-center gap-1.5 shrink-0 whitespace-nowrap cursor-pointer transition-colors duration-150 before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
      style={{
        background: hasActiveFilter ? 'var(--ink)' : 'var(--surface)',
        color: hasActiveFilter ? 'var(--on-fill)' : 'var(--ink-2)',
        border: hasActiveFilter ? 'none' : '1px solid var(--hairline)',
      }}
    >
      {t.dashboard.filterLabel}
      {hasActiveFilter && (
        <span
          aria-hidden
          style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--on-fill)', flexShrink: 0 }}
        />
      )}
    </button>
  )
  const toggles = (
    <>
      <PayerDualToggle value={payerFilter} onChange={onPayerChange} viewerIsA={viewerIsA} t={t} />
      <SplitDualToggle value={splitFilter} onChange={onSplitChange} viewerIsA={viewerIsA} t={t} />
    </>
  )

  // `pt-1.5 -mt-1.5` is layout-neutral on purpose (same fix as the /records L3
  // row, #1169): `overflow-x-auto` also clips overflow-y, and clipping applies
  // to hit-testing. The chip and the dual-toggle segments pad their tap areas
  // to 44px with ::before pseudos that reach ~5px above the row's content box;
  // without top padding that strip is cut off and the real tap area stops
  // short of 44px. The existing pb-2 already covers the bottom edge.
  // Symptom if the padding goes: nothing looks different, taps on the top few
  // px above a chip just stop registering (#1197).
  const scrollRow = 'flex items-center gap-2 pt-1.5 -mt-1.5 pb-2 overflow-x-auto'

  if (title !== undefined) {
    // Heading the records list (#1851): the list's title on the left, the
    // chip on the right, toggles on their own row below. TransactionFeed's
    // label wrapper owns the horizontal padding. The title row does not clip,
    // so the chip keeps its full 44px there.
    return (
      <>
        <div className="flex items-center justify-between gap-3">
          {title}
          {chip}
        </div>
        {showToggles && (
          <div className={`${scrollRow} mt-2`} style={{ scrollbarWidth: 'none' } as React.CSSProperties}>
            {toggles}
          </div>
        )}
      </>
    )
  }

  return (
    <div className={`${scrollRow} px-5`} style={{ scrollbarWidth: 'none' } as React.CSSProperties}>
      {chip}
      {showToggles && toggles}
    </div>
  )
}
