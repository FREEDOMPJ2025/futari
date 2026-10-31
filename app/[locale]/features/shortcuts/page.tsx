import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SUPPORTED_LOCALES, isLocale, type Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'
import { buildAlternates, ogLocale, alternateOgLocales, ogImage } from '@/lib/i18n/seo'
import { localizedHref } from '@/lib/i18n/path'
import { BrandBreadcrumb } from '../../_components/BrandBreadcrumb'
import { Phrase } from '../../_components/Phrase'
import { s } from '../../_components/brand-inner'
import { UseCaseHero } from '../../use-case/_components/UseCaseHero'
import { FeatureShortcutsJsonLd } from './_components/FeatureShortcutsJsonLd'
import { CATEGORY_IDS, appUrl, webUrl } from './_components/urls'

type Params = Promise<{ locale: string }>

const PATH = '/features/shortcuts'
/** Index of the step that builds the URL; the code block sits under it. */
const URL_STEP = 3

export function generateStaticParams() {
  return SUPPORTED_LOCALES.map((locale) => ({ locale }))
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale: rawLocale } = await params
  if (!isLocale(rawLocale)) return {}
  const locale: Locale = rawLocale
  const t = dictionaries[locale].seo.featureShortcuts
  return {
    title: t.title,
    description: t.description,
    alternates: buildAlternates(PATH, locale),
    openGraph: {
      title: t.title,
      description: t.ogDescription,
      url: localizedHref(PATH, locale),
      siteName: dictionaries[locale].landing.jsonLdAppName,
      type: 'website',
      locale: ogLocale(locale),
      alternateLocale: alternateOgLocales(locale),
      images: [{ url: ogImage(locale), width: 1200, height: 630, alt: t.title }],
    },
    twitter: {
      card: 'summary_large_image',
      title: t.title,
      description: t.ogDescription,
      images: [ogImage(locale)],
    },
  }
}

const TH = 'py-2 pr-3 text-left font-normal'
const TD = 'py-2 pr-3 align-top'

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-ink-3">{label}</span>
      <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-tile border border-hairline bg-surface p-4 font-mono text-sm leading-[1.7] text-ink">
        {code}
      </pre>
    </div>
  )
}

function Steps({
  idPrefix,
  steps,
  code,
}: {
  idPrefix: string
  steps: readonly { title: string; body: string }[]
  code?: { label: string; value: string }
}) {
  return (
    <ol className="m-0 p-0 list-none flex flex-col gap-4">
      {steps.map((step, i) => (
        <li
          key={step.title}
          id={`${idPrefix}${i + 1}`}
          className="flex flex-col gap-3 rounded-card border border-hairline bg-surface p-5"
        >
          <h3 className="m-0 flex items-baseline gap-3 text-base font-medium text-ink">
            <span className="text-sm tabular-nums text-ink-3">{i + 1}</span>
            {step.title}
          </h3>
          <p className="m-0 text-sm leading-[1.7] text-ink-2">{step.body}</p>
          {code && i === URL_STEP && <CodeBlock label={code.label} code={code.value} />}
        </li>
      ))}
    </ol>
  )
}

export default async function FeatureShortcutsPage({ params }: { params: Params }) {
  const { locale: rawLocale } = await params
  if (!isLocale(rawLocale)) notFound()
  const locale = rawLocale as Locale
  const dict = dictionaries[locale]
  const t = dict.featureShortcuts
  const h2 = `${s.h2} m-0 text-xl md:text-title font-medium`
  const { applePay, applePayUrl, linePay, web, params: p, whenNot, trouble } = t

  return (
    <div className={s.flow}>
      <FeatureShortcutsJsonLd locale={locale} t={t} homeName="Futari" />

      <div className={s.hero}>
        <BrandBreadcrumb
          label={dict.brand.breadcrumbLabel}
          crumbs={[
            { label: 'Futari', href: localizedHref('/', locale) },
            { label: t.breadcrumbLabel },
          ]}
        />
        <UseCaseHero kicker={t.heroKicker} title={t.heroTitle} subtitle={t.heroSubtitle} />
      </div>

      <section id="answer" className={s.band}>
        <h2 className={h2}>
          <Phrase text={t.answerQuestion} />
        </h2>
        <p className="m-0 text-base leading-[1.7] text-ink-2">{t.answer}</p>
      </section>

      <section id="apple-pay" className={s.band}>
        <h2 className={h2}>
          <Phrase text={applePay.heading} />
        </h2>
        <div className="flex flex-col gap-6">
          <p className="m-0 text-base leading-[1.7] text-ink-2">{applePay.intro}</p>
          <Steps
            idPrefix="step-"
            steps={applePay.steps}
          />
          <p className="m-0 text-sm leading-[1.7] text-ink-2">{applePay.foreignNote}</p>
          <p className="m-0 text-sm leading-[1.7] text-ink-2">{applePay.platformNote}</p>
        </div>
      </section>

      <section id="apple-pay-url" className={s.band}>
        <h2 className={h2}>
          <Phrase text={applePayUrl.heading} />
        </h2>
        <div className="flex flex-col gap-6">
          <p className="m-0 text-base leading-[1.7] text-ink-2">{applePayUrl.intro}</p>
          <Steps
            idPrefix="apple-pay-url-step-"
            steps={applePayUrl.steps}
            code={{ label: applePayUrl.urlLabel, value: appUrl(t.vars.amount, t.vars.merchant) }}
          />
        </div>
      </section>

      {linePay.heading && (
        <section id="line-pay" className={s.band}>
          <h2 className={h2}>
            <Phrase text={linePay.heading} />
          </h2>
          <div className="flex flex-col gap-6">
            <p className="m-0 text-base leading-[1.7] text-ink-2">{linePay.intro}</p>
            <Steps
              idPrefix="line-pay-step-"
              steps={linePay.steps}
              code={{ label: applePayUrl.urlLabel, value: appUrl(t.vars.amount, linePay.noteVar) }}
            />
          </div>
        </section>
      )}

      <section id="web" className={s.band}>
        <h2 className={h2}>
          <Phrase text={web.heading} />
        </h2>
        <div className="flex flex-col gap-4">
          <p className="m-0 text-base leading-[1.7] text-ink-2">{web.body}</p>
          <CodeBlock label={web.urlLabel} code={webUrl(t.vars.amount, t.vars.merchant)} />
        </div>
      </section>

      <section id="params" className={s.band}>
        <h2 className={h2}>
          <Phrase text={p.heading} />
        </h2>
        <div className="flex flex-col gap-6 text-base leading-[1.7] text-ink-2">
          <p className="m-0">{p.intro}</p>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-ink-3">
                <th scope="col" className={TH}>{p.cols.param}</th>
                <th scope="col" className={TH}>{p.cols.rule}</th>
                <th scope="col" className={TH}>{p.cols.fallback}</th>
              </tr>
            </thead>
            <tbody>
              {p.rows.map((row) => (
                <tr key={row.param} className="border-b border-hairline">
                  <th scope="row" className={`${TD} text-left font-mono font-normal text-ink`}>{row.param}</th>
                  <td className={TD}>{row.rule}</td>
                  <td className={TD}>{row.fallback}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="m-0 text-base font-medium text-ink">{p.categoriesHeading}</h3>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-ink-3">
                <th scope="col" className={TH}>{p.catCols.id}</th>
                <th scope="col" className={TH}>{p.catCols.name}</th>
              </tr>
            </thead>
            <tbody>
              {CATEGORY_IDS.map((id) => (
                <tr key={id} className="border-b border-hairline">
                  <th scope="row" className={`${TD} text-left font-mono font-normal text-ink`}>{id}</th>
                  <td className={TD}>{dict.category[id]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="m-0 text-sm">{p.fixedNote}</p>
        </div>
      </section>

      <section id="when-not" className={s.band}>
        <h2 className={h2}>
          <Phrase text={whenNot.heading} />
        </h2>
        <div className="flex flex-col gap-4 text-base leading-[1.7] text-ink-2">
          <p className="m-0">{whenNot.intro}</p>
          <ul className="m-0 pl-5 flex flex-col gap-2 text-sm">
            {whenNot.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      <section id="trouble" className={s.band}>
        <h2 className={h2}>
          <Phrase text={trouble.heading} />
        </h2>
        <table className="w-full border-collapse text-sm text-ink-2">
          <thead>
            <tr className="border-b border-hairline text-ink-3">
              <th scope="col" className={TH}>{trouble.cols.symptom}</th>
              <th scope="col" className={TH}>{trouble.cols.cause}</th>
            </tr>
          </thead>
          <tbody>
            {trouble.rows.map((row) => (
              <tr key={row.symptom} className="border-b border-hairline">
                <th scope="row" className={`${TD} text-left font-normal text-ink`}>{row.symptom}</th>
                <td className={TD}>{row.cause}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
