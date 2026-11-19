import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import MigrateSourcePage from '@/app/[locale]/migrate/[source]/page'
import { dictionaries } from '@/lib/i18n/t'

async function html(locale: string, source: string) {
  const el = await MigrateSourcePage({ params: Promise.resolve({ locale, source }) })
  return renderToStaticMarkup(el)
}

// Phrase wraps text in spans, so compare positions on tag-stripped text.
function pos(markup: string, needle: string) {
  return markup.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '').indexOf(needle)
}

function howTo(markup: string) {
  const blocks = [...markup.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1].replace(/&quot;/g, '"')))
  return blocks.find((b) => b['@type'] === 'HowTo')
}

describe('#1926 simple-daily-money first screen', () => {
  const page = dictionaries['zh-TW'].migrate.pages['simple-daily-money']

  it('zh-TW: CTA precedes the intro callout; HowTo keeps the old title/description', async () => {
    const markup = await html('zh-TW', 'simple-daily-money')
    const cta = pos(markup, dictionaries['zh-TW'].migrate.primaryCta.title)
    const intro = pos(markup, page.intro!.slice(0, 12))
    expect(cta).toBeGreaterThan(-1)
    expect(cta).toBeLessThan(intro)
    const ld = howTo(markup)
    expect(ld.name).toBe('你的簡單記帳資料，可以帶走')
    expect(ld.name).toBe(page.howToName)
    expect(ld.description).toBe(page.howToDescription)
    expect(ld.name).not.toBe(page.heroTitle)
  })

  it('other sources and locales keep the old order and HowTo = hero copy', async () => {
    for (const [locale, source] of [['en', 'simple-daily-money'], ['zh-TW', 'manebo']] as const) {
      const markup = await html(locale, source)
      const p = dictionaries[locale].migrate.pages[source]
      expect(pos(markup, dictionaries[locale].migrate.primaryCta.title)).toBeGreaterThan(
        pos(markup, p.intro!.slice(0, 12)),
      )
      const ld = howTo(markup)
      expect(ld.name).toBe(p.heroTitle)
      expect(ld.description).toBe(p.heroSubtitle)
    }
  })
})
