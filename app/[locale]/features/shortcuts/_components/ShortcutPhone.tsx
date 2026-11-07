import { PICKABLE_CATEGORIES } from '@/lib/categories'
import type { Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'
import { OUTING_MOCK, formatMockAmount } from '../../outing/_components/mock'
import { fs } from './feature-shortcuts-css'

/** The amount in the example. A test holds it to what `parseAmount` accepts. */
export const SAMPLE_AMOUNT = 120
/** What a first-time merchant gets (AddSheet.tsx), and the first chip. */
const SAMPLE_CATEGORY = 'dining'

/**
 * What the phone shows: the payment, the action running, and the sheet, drawn
 * in that order so the last frame is the resting one. The sheet mirrors
 * AddSheet.tsx from the top: cancel, title, save as a text button in the header
 * bar, then amount, description, category. Its words are the app's own
 * (`addSheet`, `common`, `category`). The date's label shows there is more below
 * the frame. Payer and split are left out: solo ledgers have no payer toggle, and
 * split sits below the frame.
 */
export function ShortcutPhone({ locale, action }: { locale: Locale; action: string }) {
  const dict = dictionaries[locale]
  const { flow } = dict.featureShortcuts
  const amount = formatMockAmount(OUTING_MOCK[locale], SAMPLE_AMOUNT)
  const selected = PICKABLE_CATEGORIES.findIndex((c) => c.id === SAMPLE_CATEGORY)
  const shown = PICKABLE_CATEGORIES.slice(selected, selected + 2)

  return (
    <>
      <div className={fs.base}>
        <svg className={fs.check} viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="22" cy="22" r="20" />
          <path d="M13 23l6 6 12-13" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="m-0 text-sm font-medium">{flow.steps[0]}</p>
        <div className={`${fs.row} text-sm`}>
          <span>{flow.sampleMerchant}</span>
          <span className="tabular-nums">{amount}</span>
        </div>
        <div className={`${fs.action} text-sm font-medium`}>{action}</div>
      </div>

      <div className={fs.sheet}>
        <div className={`${fs.sheetBar} text-sm`}>
          <span>{dict.common.cancel}</span>
          <span className="font-medium">{dict.addSheet.title}</span>
          <span className={`${fs.save} font-medium`}>
            {dict.common.save}
            <span className={fs.ring} />
          </span>
        </div>
        <div className={fs.sheetBody}>
          <div className={fs.amount}>
            <p className={`${fs.label} text-xs`}>{dict.addSheet.amount}</p>
            <p className="m-0 mt-1 text-title font-medium tabular-nums">{amount}</p>
          </div>
          <div className={fs.desc}>
            <p className="m-0 text-sm">{flow.sampleMerchant}</p>
          </div>
          <div className={fs.field}>
            <p className={`${fs.label} px-5 pt-5 text-xs`}>{dict.addSheet.category}</p>
            <div className={fs.cats}>
              {shown.map((c) => (
                <span key={c.id} className={`${fs.cat} text-xs font-medium`} data-on={c.id === SAMPLE_CATEGORY ? '' : undefined}>
                  <span className={fs.mono} style={{ background: c.tint, color: c.ink }}>
                    {c.mono}
                  </span>
                  {dict.category[c.id]}
                </span>
              ))}
            </div>
            <p className={`${fs.label} px-5 pt-4 text-xs`}>{dict.addSheet.date}</p>
          </div>
        </div>
      </div>
    </>
  )
}
