import { FeatureLinkRow } from './FeatureLinkRow'
import { Phrase } from '../../_components/Phrase'
import { s } from '../../_components/brand-inner'
import { dictionaries } from '@/lib/i18n/t'
import { localizedHref } from '@/lib/i18n/path'
import type { Locale } from '@/lib/i18n/locales-meta'
import type { FeatureOutingLinkSource } from '../../_components/FeatureOutingTextLink'

/**
 * The one-row "outing" cross-link (#1724) shared by /use-case, /use-case/[slug]
 * and /migrate/splitwise.
 *
 * Deliberately not `.bi-band` (#1528 F4): that class is a heading rail + content
 * grid from 1024px, and this section has no <h2>, so its lone <ul> auto-placed
 * into the 240px heading column (240x512, one character per line). Without the
 * class it is a plain child of `.bi-flow` and sits on the content rail like the
 * sections above it. Failure looks like a narrow strip on the left at >=1024px
 * and nothing wrong below it.
 */
export function FeatureLinkSection({ locale, source }: { locale: Locale; source: FeatureOutingLinkSource }) {
  const link = dictionaries[locale].featureOuting.crossLink
  return (
    <section aria-label={link.name}>
      <ul className={s.rows}>
        <FeatureLinkRow
          href={localizedHref('/features/outing', locale)}
          name={link.name}
          description={<Phrase body text={link.description} />}
          cta={link.cta}
          source={source}
        />
      </ul>
    </section>
  )
}
