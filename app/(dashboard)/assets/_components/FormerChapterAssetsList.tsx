'use client'

import { BottomNav } from '@/app/(dashboard)/_components/BottomNav'
import { useTranslations } from '@/lib/i18n/client'
import type { AssetType } from '@/lib/assets'
import { ItemCard } from './AibutsuCard'

/** One asset as a former member's look-back shows it: name and that
 *  chapter's money, nothing else (#1612). */
export interface FormerChapterAsset {
  id: string
  type: AssetType
  name: string
  /** Spending linked to this asset inside the chapter window. */
  totalAmount: number
}

/**
 * #1612 — /assets for a former member looking back at a chapter of a ledger
 * they left. Owner decision (2026-10-13): only each asset's name and that
 * chapter's money. No current field values (age, plate mask, odometer,
 * species, policy terms, holder / insured), no notes, no create sheet, no
 * 愛物 / 守護 tabs (the guardian flag is the ledger's live setting).
 *
 * The server builds the items from assets created before the chapter closed
 * (`nonMemberPinCutoff`), so an asset added after the leave is not here and
 * its detail URL is not found.
 */
export function FormerChapterAssetsList({ items }: { items: FormerChapterAsset[] }) {
  const t = useTranslations()
  return (
    <div className="relative min-h-screen pb-[var(--bottom-nav-offset)]">
      <div className="px-5 pt-[max(var(--safe-top),24px)] pb-3">
        <h1 className="text-page font-medium tracking-tight text-ink">
          {t.assets.title}
        </h1>
      </div>

      {items.length === 0 ? (
        <div className="text-sm leading-relaxed py-10 text-center text-ink-3">
          {t.assets.empty.title}
        </div>
      ) : (
        <div className="px-4 flex flex-col gap-2.5">
          {items.map((a) => (
            <ItemCard
              key={a.id}
              id={a.id}
              type={a.type}
              name={a.name}
              monthAmount={0}
              totalAmount={a.totalAmount}
              isPast
            />
          ))}
        </div>
      )}

      <BottomNav onAddClick={() => {}} hideFab />
    </div>
  )
}
