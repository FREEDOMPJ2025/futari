import { describe, it, expect, vi } from 'vitest'
import { isValidElement, type ComponentProps, type ReactNode } from 'react'
import { render } from '@testing-library/react'

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: vi.fn() } }),
}))
// jsdom has no real matchMedia; LandingStandaloneRedirect needs it to exist.
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}))

import RootPage from '@/app/[locale]/page'
import { Landing } from '@/app/[locale]/_landing/Landing'
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'

// #1907 — the visible FAQ and the FAQPage JSON-LD must be the same strings.
// Both are taken from what RootPage actually returns: the JSON-LD from its
// <script> children, the visible list from rendering the <Landing> element it
// builds, so a page that stops feeding both from one list goes red.
type Faq = { question: string; answer: string }

function walk(node: ReactNode, visit: (el: ReturnType<typeof asEl>) => void) {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit))
  } else if (isValidElement(node)) {
    visit(asEl(node))
    walk(asEl(node).props.children, visit)
  }
}
function asEl(node: unknown) {
  return node as {
    type: unknown
    props: { type?: string; dangerouslySetInnerHTML?: { __html: string }; children?: ReactNode }
  }
}

async function pageParts(locale: (typeof SUPPORTED_LOCALES)[number]) {
  const tree = await RootPage({ params: Promise.resolve({ locale }) })
  const ld: Record<string, unknown>[] = []
  let landing: ComponentProps<typeof Landing> | null = null
  walk(tree, (el) => {
    if (el.type === 'script' && el.props.type === 'application/ld+json' && el.props.dangerouslySetInnerHTML) {
      ld.push(JSON.parse(el.props.dangerouslySetInnerHTML.__html))
    }
    if (el.type === Landing) landing = el.props as unknown as ComponentProps<typeof Landing>
  })
  expect(landing).not.toBeNull()
  return { ld, landing: landing! }
}

describe('landing FAQ: visible text equals FAQPage JSON-LD (#1907)', () => {
  it.each(SUPPORTED_LOCALES)('%s: every question and answer matches, in order', async (locale) => {
    const { ld, landing } = await pageParts(locale)
    const faqLd = ld.find((n) => n['@type'] === 'FAQPage') as {
      mainEntity: { name: string; acceptedAnswer: { text: string } }[]
    }
    expect(faqLd).toBeDefined()

    const { container } = render(<Landing {...landing} languageSwitcher={undefined} />)
    const rows = [...container.querySelectorAll('dl > div')]
    const visible: Faq[] = rows.map((r) => ({
      question: r.querySelector('dt')!.textContent ?? '',
      answer: r.querySelector('dd')!.textContent ?? '',
    }))
    const structured: Faq[] = faqLd.mainEntity.map((q) => ({
      question: q.name,
      answer: q.acceptedAnswer.text,
    }))

    expect(visible).toHaveLength(5)
    expect(structured).toEqual(visible)
  })

  it.each(SUPPORTED_LOCALES)('%s: schema.org FAQPage shape', async (locale) => {
    const { ld } = await pageParts(locale)
    const faqLd = ld.find((n) => n['@type'] === 'FAQPage') as {
      '@context': string
      mainEntity: { '@type': string; name: string; acceptedAnswer: { '@type': string; text: string } }[]
    }
    expect(faqLd['@context']).toBe('https://schema.org')
    expect(faqLd.mainEntity).toHaveLength(5)
    for (const q of faqLd.mainEntity) {
      expect(q['@type']).toBe('Question')
      expect(q.name.trim()).not.toBe('')
      expect(q.acceptedAnswer['@type']).toBe('Answer')
      expect(q.acceptedAnswer.text.trim()).not.toBe('')
    }
  })

  it.each(SUPPORTED_LOCALES)('%s: three steps and the note are on the page', async (locale) => {
    const { landing } = await pageParts(locale)
    const t = dictionaries[locale].landing
    const { container } = render(<Landing {...landing} languageSwitcher={undefined} />)
    const items = [...container.querySelectorAll('ol > li')]
    expect(items.map((li) => li.querySelector('h3')!.textContent)).toEqual(t.steps.map((s) => s.title))
    expect(items.map((li) => li.querySelector('p')!.textContent)).toEqual(t.steps.map((s) => s.body))
    expect(t.steps).toHaveLength(3)
    expect(container.textContent).toContain(t.stepsTitle)
    expect(container.textContent).toContain(t.stepsNote)
  })

  it.each(SUPPORTED_LOCALES)('%s: no PWA / Google-only wording in the steps or FAQ', (locale) => {
    const t = dictionaries[locale].landing
    const all = [
      t.stepsTitle,
      t.stepsNote,
      ...t.steps.flatMap((s) => [s.title, s.body]),
      ...t.faq.flatMap((f) => [f.question, f.answer]),
    ].join('\n')
    expect(all).not.toMatch(/PWA/i)
    expect(all).not.toMatch(/只能(用|使用) Google|Google のみ|only (with|use) Google/i)
  })
})
