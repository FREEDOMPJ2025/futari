import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import FeatureShortcutsPage from '@/app/[locale]/features/shortcuts/page'
import { ShortcutsHashReveal } from '@/app/[locale]/features/shortcuts/_components/ShortcutsHashReveal'
import { dictionaries } from '@/lib/i18n/t'
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales-meta'

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))

describe.each(SUPPORTED_LOCALES)('%s trimmed guide', (locale) => {
  it('keeps the main route, ordered closed references, all anchors and legacy copy', async () => {
    const html = renderToString(await FeatureShortcutsPage({ params: Promise.resolve({ locale }) }))
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const t = dictionaries[locale].featureShortcuts
    const refs = doc.querySelector('[aria-labelledby="reference-heading"]')!
    expect(doc.getElementById('apple-pay')!.nextElementSibling).toBe(refs)
    expect(doc.getElementById('reference-heading')!.textContent).toBe(t.referenceHeading)
    const ids = ['trouble', 'when-not', ...(locale === 'zh-TW' ? ['line-pay'] : []), 'apple-pay-url', 'web', 'params']
    expect([...refs.querySelectorAll(':scope details[id]')].map(el => el.id)).toEqual(ids)
    for (const details of doc.querySelectorAll('details')) {
      expect(details.hasAttribute('open')).toBe(false)
      expect(details.hasAttribute('name')).toBe(false)
    }
    for (const id of ids) expect(doc.querySelector(`#${id} > summary > h3`)).not.toBeNull()
    for (const [prefix, count] of [['step-', 3], ['apple-pay-url-step-', 5], ['line-pay-step-', t.linePay.steps.length]] as const) {
      for (let i = 1; i <= count; i++) expect(doc.getElementById(`${prefix}${i}`)).not.toBeNull()
    }
    const first = doc.getElementById('step-1')!
    expect(first.querySelector('details')!.textContent).toContain(t.applePay.steps[0].legacy!.body)
    expect(first.querySelector('details > summary')!.textContent).toBe(t.applePay.steps[0].legacy!.summary)
    expect(first.querySelector('details')!.previousElementSibling!.querySelector('[aria-hidden]')!.getAttribute('aria-hidden')).toBe('true')
    expect(doc.querySelector('#apple-pay-url-step-1 a')!.getAttribute('href')).toBe('#step-1')
    expect(doc.querySelector('#apple-pay-url-step-1 a')!.textContent).toBe(t.applePayUrl.steps[0].body)
    expect('platformNote' in t.applePay).toBe(false)
    // Approved A: main prose excludes animation, diagrams, headings and legacy.
    const prose = [t.heroSubtitle, t.answer, t.applePay.intro, ...t.applePay.steps.map(step => step.body), t.applePay.foreignNote, t.applePay.artNote].join('')
    const limits = { 'zh-TW': 900, en: 2000, ja: 1050, 'zh-CN': 780 }
    expect(prose.length).toBeLessThanOrEqual(limits[locale])
    const all = doc.body.cloneNode(true) as HTMLElement
    all.querySelectorAll('style, script').forEach(el => el.remove())
    expect(all.textContent!.replace(/\s+/g, ' ').trim().length).toBeLessThanOrEqual({ 'zh-TW': 2938, en: 6450, ja: 3380, 'zh-CN': 2500 }[locale])
    process.stdout.write(`1923 counts ${locale}: prose=${prose.length}; all DOM text normalized=${all.textContent!.replace(/\s+/g, ' ').trim().length}\n`)
    const howTo = JSON.parse(doc.querySelectorAll('script[type="application/ld+json"]')[1].textContent!)
    expect(howTo.step[0].text).toBe(`${t.applePay.steps[0].title}: ${t.applePay.steps[0].body}`)
  })
})

afterEach(() => { document.body.innerHTML = ''; window.history.replaceState(null, '', '/'); vi.restoreAllMocks() })

it('opens nested targets on mount and hashchange, ignores invalid hashes and removes its listener', async () => {
  document.body.innerHTML = '<div id="mount"></div><details id="outer"><summary>Outer</summary><details id="inner"><summary>Inner</summary><p id="target">Target</p></details></details>'
  const scroll = vi.fn()
  document.getElementById('target')!.scrollIntoView = scroll
  window.history.replaceState(null, '', '#target')
  const root = createRoot(document.getElementById('mount')!)
  await act(async () => root.render(<ShortcutsHashReveal />))
  expect([...document.querySelectorAll('details')].every(el => el.open)).toBe(true)
  expect(scroll).toHaveBeenCalledOnce()
  const inner = document.getElementById('inner') as HTMLDetailsElement
  inner.open = false
  inner.scrollIntoView = scroll
  window.history.replaceState(null, '', '#inner')
  window.dispatchEvent(new Event('hashchange'))
  expect(inner.open).toBe(true)
  for (const hash of ['#missing', '#%ZZ', '']) {
    window.history.replaceState(null, '', hash || '/')
    expect(() => window.dispatchEvent(new Event('hashchange'))).not.toThrow()
  }
  const remove = vi.spyOn(window, 'removeEventListener')
  await act(async () => root.unmount())
  expect(remove).toHaveBeenCalledWith('hashchange', expect.any(Function))
})
