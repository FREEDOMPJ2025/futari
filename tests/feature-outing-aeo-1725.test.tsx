/**
 * #1725 — /features/outing answers the searcher's question up front, shows a
 * worked example with real numbers, and declares a WebApplication; llms.txt and
 * llms-full.txt describe outings and link all four locale pages.
 *
 * What failure looks like: nothing errors. A drifted number still renders and
 * teaches a sum the app would never produce; a dropped section just means the
 * page stays thin and unindexed.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))

import FeatureOutingPage from '@/app/[locale]/features/outing/page'
import { OUTING_MOCK, deriveOutingMock, formatMockAmount } from '@/app/[locale]/features/outing/_components/mock'
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'
import { localizedHref } from '@/lib/i18n/path'

const KEYWORD: Record<Locale, RegExp> = {
  'zh-TW': /出遊分帳/,
  'zh-CN': /出游分账/,
  en: /split trip costs/i,
  ja: /割り勘/,
}

async function renderPage(locale: Locale) {
  const html = renderToString(await FeatureOutingPage({ params: Promise.resolve({ locale }) }))
  return new DOMParser().parseFromString(html, 'text/html')
}

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

describe.each(SUPPORTED_LOCALES)('%s', (locale) => {
  const t = dictionaries[locale].featureOuting
  const def = OUTING_MOCK[locale]
  const { expenses, transfers } = deriveOutingMock(def)
  const money = (n: number) => formatMockAmount(def, n)

  it('opens with a direct answer right after the hero, before the walkthrough', async () => {
    const doc = await renderPage(locale)
    const answer = doc.getElementById('answer')!
    expect(text(answer.querySelector('h2'))).toBe(t.answerQuestion)
    expect(text(answer)).toContain(t.answer)
    expect(answer.compareDocumentPosition(doc.getElementById('how')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The question or the answer carries the locale's search phrase.
    expect(`${t.answerQuestion} ${t.answer}`).toMatch(KEYWORD[locale])
    // Fact limits of the page (#1633): no claims about price, realtime or custom splits.
    expect(t.answer).not.toMatch(/免費|免费|free|無料|即時|实时|real-?time|リアルタイム|比例|ratio|[!！]/i)
  })

  it('every participant owes the same share, so a single per-person figure is true', () => {
    const shareOf = (id: string) =>
      expenses.reduce((a, e) => a + (e.shares.find((s) => s.participantId === id)?.shareAmount ?? 0), 0)
    const shares = def.participantIds.map(shareOf)
    expect(new Set(shares).size).toBe(1)
    expect(shares[0] * def.participantIds.length).toBe(def.expenses.reduce((a, e) => a + e.amount, 0))
  })

  it('worked example shows the expenses, total, per-person share and the product transfers', async () => {
    const doc = await renderPage(locale)
    const ex = doc.getElementById('example')!
    const total = def.expenses.reduce((a, e) => a + e.amount, 0)
    const share = total / def.participantIds.length

    const rows = [...ex.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map(text))
    expect(rows).toEqual(def.expenses.map((e) => [e.label, def.names[e.paidBy], money(e.amount)]))

    const body = text(ex)
    expect(body).toContain(def.outingName)
    expect(body).toContain(money(total))
    expect(body).toContain(money(share))
    expect(body).not.toMatch(/\{\w+\}/) // every placeholder filled

    const listed = [...ex.querySelectorAll('li')].map(text)
    expect(listed).toEqual(
      transfers.map((tr) => `${def.names[tr.from]} → ${def.names[tr.to]}${money(tr.amount)}`),
    )
  })

  it('declares a free, install-free WebApplication alongside the existing blocks', async () => {
    const doc = await renderPage(locale)
    const blocks = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent!))
    expect(blocks.map((b) => b['@type'])).toEqual(['BreadcrumbList', 'HowTo', 'WebApplication', 'FAQPage'])
    const app = blocks.find((b) => b['@type'] === 'WebApplication')
    expect(app).toMatchObject({
      '@context': 'https://schema.org',
      description: t.answer,
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0' },
      operatingSystem: 'Any',
    })
    expect(app.url.endsWith(localizedHref('/features/outing', locale))).toBe(true)
    expect(app.featureList).toEqual(t.steps.map((s) => s.title))
  })
})

describe('llms files', () => {
  const read = (f: string) => readFileSync(path.join(process.cwd(), 'public', f), 'utf8')
  it.each(['llms.txt', 'llms-full.txt'])('%s describes outings and links all four locale pages with utm', (f) => {
    const body = read(f)
    expect(body).toMatch(/outing/i)
    for (const locale of SUPPORTED_LOCALES) {
      const url = `https://futari.southern-light.dev${localizedHref('/features/outing', locale)}?utm_source=llms_txt&utm_medium=ai_agent`
      expect(body).toContain(url)
    }
  })

  it('the llms worked example matches the zh-TW page example', () => {
    const def = OUTING_MOCK['zh-TW']
    const { transfers } = deriveOutingMock(def)
    for (const f of ['llms.txt', 'llms-full.txt']) {
      const body = read(f)
      for (const e of def.expenses) expect(body).toContain(formatMockAmount(def, e.amount))
      for (const tr of transfers) expect(body).toContain(formatMockAmount(def, tr.amount))
      expect(body).toContain('NT$12,800')
      expect(body).toContain('NT$3,200 each')
    }
  })
})
