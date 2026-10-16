import type { Locale } from '@/lib/i18n/locales-meta'
import { localizedHref } from '@/lib/i18n/path'
import { APP_URL, SCHEMA_LANG } from '@/lib/i18n/seo'
import type { Translations } from '@/lib/i18n/locales/zh-TW'

const PATH = '/features/shortcuts'

function Ld({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
}

/**
 * JSON-LD of /features/shortcuts (#1750): BreadcrumbList (Home -> this page, as
 * on /features/outing) and a HowTo for the Apple Pay steps, the line every
 * locale has. The zh-TW-only LINE Pay steps are not in the HowTo.
 */
export function FeatureShortcutsJsonLd({
  locale,
  t,
  homeName,
}: {
  locale: Locale
  t: Translations['featureShortcuts']
  homeName: string
}) {
  const pageUrl = `${APP_URL}${localizedHref(PATH, locale)}`

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: homeName, item: `${APP_URL}${localizedHref('/', locale)}` },
      { '@type': 'ListItem', position: 2, name: t.breadcrumbLabel, item: pageUrl },
    ],
  }
  const howTo = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    inLanguage: SCHEMA_LANG[locale],
    name: t.applePay.heading,
    description: t.answer,
    step: t.applePay.steps.map((step, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: t.howToStepName.replace('{n}', String(i + 1)),
      text: `${step.title}: ${step.body}`,
      url: `${pageUrl}#step-${i + 1}`,
    })),
  }

  return (
    <>
      <Ld data={breadcrumb} />
      <Ld data={howTo} />
    </>
  )
}
