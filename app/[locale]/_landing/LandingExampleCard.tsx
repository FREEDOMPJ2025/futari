import type { Translations } from '@/lib/i18n/locales/zh-TW'
import { CategoryChip } from '@/app/(dashboard)/_components/CategoryChip'
import { SplitGlyph } from '@/app/(dashboard)/dashboard/_components/SplitGlyph'

// LandingExampleCard (#1852) — one expense plus how it splits, shown under the
// sign-in link below xl. From xl the desktop hero already has PhonePreview.
// Static markup from the real CategoryChip + SplitGlyph, laid out like a
// CompactRow; the data is demo data. Server component on purpose: no JS, no
// image, no animation, so the mobile LCP element stays the illustration band.
// Classes are ones the global stylesheet already carries — the hero's CSS budget
// is nearly spent, so adding a new utility here costs bytes on every page.

export function LandingExampleCard({ t }: { t: Translations['landing'] }) {
  return (
    // Not aria-hidden: the card explains the product. The figcaption carries the
    // whole sentence for screen readers; the visual copy below is hidden from
    // them so the same numbers aren't read twice.
    <figure className="xl:hidden mt-8 p-4 text-left bg-surface border border-hairline rounded-card">
      <figcaption className="sr-only">{t.exampleCardCaption}</figcaption>
      <div aria-hidden="true">
        <div className="flex items-center gap-3">
          <CategoryChip categoryId="dining" size={32} />
          <div className="flex-1 min-w-0">
            <p className="m-0 text-sm font-medium">{t.exampleCardTitle}</p>
            <p className="m-0 mt-0.5 text-sm text-ink-3">{t.exampleCardSub}</p>
          </div>
          <span className="shrink-0 tnum font-numeric text-sm font-medium tracking-[-0.2px] text-[var(--debit-text)]">
            {t.exampleCardAmount}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-3 pt-3 border-t border-hairline">
          <SplitGlyph kind="half" active />
          <p className="m-0 text-sm font-medium">{t.exampleCardResult}</p>
        </div>
      </div>
    </figure>
  )
}
