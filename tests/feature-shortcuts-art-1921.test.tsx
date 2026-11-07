/**
 * #1921 - the opening animation and diagram cards on /features/shortcuts.
 *
 * What failure looks like: nothing errors. A diagram that says something the
 * step's text doesn't, or an animation that hides the page without a script,
 * still renders; the page just teaches the wrong thing or shows a blank box.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))

import FeatureShortcutsPage from '@/app/[locale]/features/shortcuts/page'
import { SAMPLE_AMOUNT } from '@/app/[locale]/features/shortcuts/_components/ShortcutPhone'
import { FEATURE_SHORTCUTS_CSS } from '@/app/[locale]/features/shortcuts/_components/feature-shortcuts-css'
import { parseAmount } from '@/lib/quickAdd'
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'
import type { ShortcutArt } from '@/lib/i18n/locales/zh-TW'

async function render(locale: Locale) {
  const html = renderToString(await FeatureShortcutsPage({ params: Promise.resolve({ locale }) }))
  return new DOMParser().parseFromString(html, 'text/html')
}

/** The separate words of a label: whole strings like `金額 → 捷徑輸入 › 交易 › 數量` aren't in the text. */
function words(label: string) {
  return label.split(/→|›|：|:(?=\s)|〔|〕/).map((w) => w.trim()).filter(Boolean)
}

function labels(art: ShortcutArt): string[] {
  switch (art.kind) {
    case 'wallet':
      return [art.path, art.heading, art.option, ...art.toggles]
    case 'action':
      return [art.search, art.action]
    case 'fields':
      return [art.amount, art.note, art.category]
    case 'notify':
      return [...art.rows]
  }
}

describe.each(SUPPORTED_LOCALES)('%s', (locale) => {
  const dict = dictionaries[locale]
  const t = dict.featureShortcuts

  it('every diagram label is a word of its step, so the two cannot drift', () => {
    const steps = [...t.applePay.steps, ...t.linePay.steps]
    for (const step of steps) {
      if (!step.art) continue
      for (const label of labels(step.art)) {
        for (const word of words(label)) expect(step.body, `${step.title}: ${label}`).toContain(word)
      }
    }
  })

  it('sits between the hero and the answer, with a visible step list and a hidden phone', async () => {
    const doc = await render(locale)
    const flow = doc.getElementById('flow')!
    expect(flow.nextElementSibling?.id).toBe('answer')
    const items = [...flow.querySelectorAll('ol > li')].map((li) => li.textContent)
    expect(items).toEqual(t.flow.steps)
    expect(flow.querySelector('.fs-phone')!.getAttribute('aria-hidden')).toBe('true')
    expect(flow.getAttribute('aria-label')).toBe(t.flow.stepsLabel)
  })

  it('serves the finished picture: no phase, no play button, and the sheet in place', async () => {
    const doc = await render(locale)
    const flow = doc.querySelector('.fs-flow')!
    expect(flow.hasAttribute('data-phase')).toBe(false)
    expect(flow.querySelector('button')).toBeNull()
    expect(flow.querySelector('.fs-sheet .fs-ring')).not.toBeNull()
  })

  it('draws the sheet as the app does: save is the text button at the end of the header', async () => {
    const doc = await render(locale)
    const bar = doc.querySelector('.fs-sheetBar')!
    expect([...bar.children].map((c) => c.textContent)).toEqual([dict.common.cancel, dict.addSheet.title, dict.common.save])
    expect(bar.lastElementChild!.classList.contains('fs-save')).toBe(true)
    expect(doc.querySelector('.fs-phone')!.textContent).toContain(t.flow.sampleMerchant)
    const selected = doc.querySelector('.fs-cat[data-on]')!
    expect(selected.textContent).toContain(dict.category.dining)
    expect(doc.querySelectorAll('.fs-cat')).toHaveLength(2)
  })

  it('names the action the iOS app registers in this locale', async () => {
    const strings = JSON.parse(readFileSync('ios/App/App/Localizable.xcstrings', 'utf8')).strings
    const art = t.applePay.steps[1].art
    if (art.kind !== 'action') throw new Error('step 2 is the action')
    const found = Object.values<{ localizations?: Record<string, { stringUnit?: { value?: string } }> }>(strings)
      .some((entry) => Object.values(entry.localizations ?? {}).some((l) => l.stringUnit?.value === art.action))
    const isSource = Object.keys(strings).includes(art.action)
    expect(found || isSource, art.action).toBe(true)
    const doc = await render(locale)
    expect(doc.querySelector('.fs-action')!.textContent).toBe(art.action)
  })

  it('puts a diagram on each Apple Pay step, hidden from assistive tech, and one note after', async () => {
    const doc = await render(locale)
    const cards = doc.querySelectorAll('#apple-pay ol > li .fs-card')
    expect(cards).toHaveLength(3)
    for (const card of cards) expect(card.getAttribute('aria-hidden')).toBe('true')
    expect(doc.getElementById('apple-pay')!.textContent).toContain(t.applePay.artNote)
    expect(doc.querySelectorAll('#apple-pay-url .fs-card')).toHaveLength(0)
  })

  it('shows LINE Pay only where the section exists', async () => {
    const doc = await render(locale)
    if (locale === 'zh-TW') {
      expect(doc.querySelectorAll('#line-pay .fs-card')).toHaveLength(1)
      expect(doc.querySelectorAll('#line-pay ol > li:first-child .fs-card')).toHaveLength(1)
      expect(doc.querySelector('#line-pay .fs-hot')!.textContent).toBe('訊息包含：付款完成')
    } else {
      expect(doc.getElementById('line-pay')).toBeNull()
    }
  })
})

describe('copy that looks like a mistake and isn’t', () => {
  it('names the action differently in each locale', () => {
    const names = SUPPORTED_LOCALES.map((l) => {
      const art = dictionaries[l].featureShortcuts.applePay.steps[1].art
      return art.kind === 'action' ? art.action : ''
    })
    expect(new Set(names).size).toBe(SUPPORTED_LOCALES.length)
  })

  it('keeps ja’s Futari spelling: カテゴリー on the action, not the カテゴリ of iOS Shortcuts', () => {
    const fields = dictionaries.ja.featureShortcuts.applePay.steps[2].art
    if (fields.kind !== 'fields') throw new Error('step 3 is the fields')
    expect(fields.category).toBe('カテゴリー')
  })

  it('leaves Categories and Merchants off the wallet card: there is nothing to change there (#1923)', async () => {
    for (const locale of SUPPORTED_LOCALES) {
      const card = (await render(locale)).querySelector('#step-1 .fs-card')!
      expect(card.querySelectorAll('.fs-cardRow'), locale).toHaveLength(3)
    }
  })
})

describe('the example and the styles', () => {
  it('uses an amount the app accepts', () => {
    expect(parseAmount(String(SAMPLE_AMOUNT))).toBe(SAMPLE_AMOUNT)
  })

  it('writes no colour literal, so diagrams follow dark mode and #1669', () => {
    expect(FEATURE_SHORTCUTS_CSS).not.toMatch(/#[0-9a-f]{3,8}\b(?!\w)/i)
    expect(FEATURE_SHORTCUTS_CSS).not.toMatch(/\brgba?\(/)
  })

  it('moves only opacity and transform', () => {
    const frames = FEATURE_SHORTCUTS_CSS.match(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g)!
    expect(frames.length).toBeGreaterThan(3)
    for (const block of frames) {
      for (const [, prop] of block.matchAll(/([a-z-]+):/g)) expect(['opacity', 'transform']).toContain(prop)
    }
  })

  it('has no infinite loop, and the timeline ends inside 5 s', () => {
    expect(FEATURE_SHORTCUTS_CSS).not.toContain('infinite')
    expect(FEATURE_SHORTCUTS_CSS).toContain('300ms cubic-bezier(0.22, 1, 0.36, 1) 4100ms')
    expect(FEATURE_SHORTCUTS_CSS.match(/fs-mark\d 4600ms/g)).toHaveLength(3)
  })

  it('pauses over the animation shorthands, which reset play-state and outrank a plain rule', () => {
    expect(FEATURE_SHORTCUTS_CSS).toContain('animation-play-state: paused !important')
  })

  it('keeps the action a label, not a button: sized to its words, on a light ground', () => {
    const rule = FEATURE_SHORTCUTS_CSS.match(/\.fs-action \{[^}]*\}/)![0]
    expect(rule).toContain('background: var(--surface)')
    expect(rule).toContain('width: max-content')
    const rise = FEATURE_SHORTCUTS_CSS.match(/@keyframes fs-rise \{[\s\S]*?\n\}/)![0]
    expect(rise.match(/-50%/g)).toHaveLength(2)
  })

  it('ends with the reduced-motion block, which undoes every phase', () => {
    const at = FEATURE_SHORTCUTS_CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)')
    expect(at).toBeGreaterThan(0)
    const block = FEATURE_SHORTCUTS_CSS.slice(at)
    expect(block).toContain('animation: none')
    expect(block).toContain('.fs-flow[data-phase] .fs-sheet')
    expect(block).toContain(".fs-reveal[data-reveal='armed'] .fs-hot::after")
  })
})
