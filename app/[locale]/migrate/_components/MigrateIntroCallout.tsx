import { Phrase } from '../../_components/Phrase'
import { Ember } from '../../_components/Ember'
import { s } from '../../_components/brand-inner'

/**
 * Quiet aside for source-specific background prose — Honeydue is the only
 * page using it today (#580). One hairline-bound row with an ember marker, the
 * same shape as the "why Futari" rows beneath it (#1528), and italic Fraunces
 * keeps the "objective, never aggressive" framing called out in the i18n
 * schema. No card: it sits straight on --bg-committed.
 */
export function MigrateIntroCallout({ text }: { text: string }) {
  return (
    <aside className={`${s.row} border-t border-b border-hairline`}>
      <Ember />
      <p className="m-0 text-sm md:text-base leading-[1.85] font-serif italic text-ink-2">
        <Phrase text={text} />
      </p>
    </aside>
  )
}
