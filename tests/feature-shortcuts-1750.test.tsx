/**
 * #1750 - /features/shortcuts, the public iPhone Shortcuts guide.
 *
 * What failure looks like: nothing errors. A guide whose example URL the parser
 * no longer accepts still renders and sends people to a blank "記一筆"; a LINE
 * Pay block leaking into en/ja/zh-CN just reads as a stray section.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))

import FeatureShortcutsPage from '@/app/[locale]/features/shortcuts/page'
import { appUrl, webUrl, CATEGORY_IDS } from '@/app/[locale]/features/shortcuts/_components/urls'
import sitemap from '@/app/sitemap'
import { parseQuickAddSchemeUrl, parseQuickAddHash } from '@/lib/quickAdd'
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'
import { localizedHref } from '@/lib/i18n/path'
import { PICKABLE_CATEGORIES } from '@/lib/categories'

async function renderPage(locale: Locale) {
  const html = renderToString(await FeatureShortcutsPage({ params: Promise.resolve({ locale }) }))
  return { html, doc: new DOMParser().parseFromString(html, 'text/html') }
}

describe.each(SUPPORTED_LOCALES)('%s', (locale) => {
  const t = dictionaries[locale].featureShortcuts

  it('renders the answer, Apple Pay steps, params, when-not and troubleshooting', async () => {
    const { doc } = await renderPage(locale)
    for (const id of ['answer', 'apple-pay', 'apple-pay-url', 'web', 'params', 'when-not', 'trouble']) {
      expect(doc.getElementById(id), id).not.toBeNull()
    }
    expect(doc.querySelectorAll('#apple-pay ol > li')).toHaveLength(3)
    expect(doc.querySelector('#apple-pay pre')).toBeNull()
    expect(doc.getElementById('apple-pay')!.textContent).toContain('iOS 17')
    expect(t.applePay.intro).not.toContain('16')
    expect(t.applePayUrl.intro).not.toContain('16')
    expect(t.applePayUrl.intro).toContain('iOS 17')
    expect(doc.getElementById('apple-pay-url')!.textContent).toContain('iOS 17')
    expect(doc.getElementById('apple-pay-url')!.textContent).not.toContain('16')
    // #1872: iOS 27 has no separate "new automation" entry; Quella's iOS 27.2 screenshots
    // (6572104529) show new shortcut → Edit → Automation → Wallet, with the trigger card's
    // Automation switch on and Notify off. The iOS 26 and earlier path stays as one sentence after it.
    const ui = {
      'zh-TW': { category: '自動化操作', wallet: '錢包', notify: '通知', runImmediately: '立即執行', newBlank: '新增空白自動化', action: 'Futari 記一筆', fields: ['金額', '備註', '分類'], input: '捷徑輸入', type: '類型', transaction: '交易', amount: '數量', merchant: '商家' },
      'zh-CN': { category: '自动化', wallet: '钱包', notify: '通知', runImmediately: '立即运行', newBlank: '新建空白自动化', action: 'Futari 记一笔', fields: ['金额', '备注', '分类'], input: '输入快捷指令的信息', type: '类型', transaction: '交易', amount: '数量', merchant: '商家' },
      en: { category: 'Automation', wallet: 'Wallet', notify: 'Notify', runImmediately: 'Run Immediately', newBlank: 'New Blank Automation', action: 'Add Entry to Futari', fields: ['Amount', 'Note', 'Category'], input: 'Shortcut Input', type: 'Type', transaction: 'Transaction', amount: 'Amount', merchant: 'Merchant' },
      ja: { category: 'オートメーション', wallet: 'ウォレット', notify: '通知', runImmediately: 'すぐに実行', newBlank: '新規の空のオートメーション', action: 'Futari に記録する', fields: ['金額', 'メモ', 'カテゴリー'], input: 'ショートカットの入力', type: '種類', transaction: '取引', amount: '金額', merchant: '店舗' },
    }[locale]
    for (const id of ['apple-pay']) {
      const stepOne = doc.querySelector(`#${id} ol > li`)!.textContent ?? ''
      for (const term of [ui.category, ui.wallet, ui.notify, ui.runImmediately, ui.newBlank]) {
        expect(stepOne, `${id}: ${term}`).toContain(term)
      }
      // The iOS 27 path comes first; the older Run Immediately → New Blank Automation path after it.
      expect(stepOne.indexOf(ui.notify)).toBeLessThan(stepOne.indexOf(ui.runImmediately))
      expect(stepOne.indexOf(ui.runImmediately)).toBeLessThan(stepOne.indexOf(ui.newBlank))
    }
    expect(doc.getElementById('apple-pay')!.textContent).toContain('1.9.0')
    const applePaySteps = doc.querySelector('#apple-pay ol')!.textContent ?? ''
    // #1878: the action, its fields and Shortcut Input read in the phone's language.
    for (const term of [ui.action, ...ui.fields, ui.input, ui.type, ui.transaction, ui.amount, ui.merchant]) {
      expect(applePaySteps, term).toContain(term)
    }
    // Shortcut Input arrives as Text; every link fallback step that reads it says to switch it to
    // Transaction, including step 4's "skipped step 2" clause (#1872 round 5, 6572551967).
    const urlSteps = [...doc.querySelectorAll('#apple-pay-url ol > li')].map((li) => li.textContent ?? '')
    for (const i of [1, 2]) {
      expect(urlSteps[i]).toContain(ui.input)
      expect(urlSteps[i]).toContain(ui.transaction)
    }
    const skipped = urlSteps[3].slice(urlSteps[3].indexOf(ui.input))
    expect(urlSteps[3]).toContain(ui.input)
    expect(skipped.indexOf(ui.transaction), 'step 4: Type → Transaction after Shortcut Input').toBeGreaterThan(0)
    expect(skipped.indexOf(ui.transaction)).toBeLessThan(skipped.indexOf(ui.amount, ui.input.length))
    expect(t.trouble.rows[0].symptom).toContain(ui.action)
    expect(doc.querySelectorAll('#apple-pay-url ol > li')).toHaveLength(5)
    expect(doc.querySelector('[aria-labelledby="reference-heading"] #apple-pay-url')).not.toBeNull()
    expect(doc.querySelector('#apple-pay-url pre')!.textContent).toBe(appUrl(t.vars.amount, t.vars.merchant))
    expect(doc.querySelectorAll('#line-pay pre')).toHaveLength(locale === 'zh-TW' ? 1 : 0)
    expect(doc.getElementById('answer')!.textContent).toContain(t.answer)
  })

  it('labels the link fallback troubleshooting symptoms consistently', async () => {
    const { doc } = await renderPage(locale)
    const label = {
      'zh-TW': '網址備用做法：',
      'zh-CN': '网址备用做法：',
      en: 'Link fallback: ',
      ja: 'リンクを使う方法：',
    }[locale]
    for (const row of t.trouble.rows.slice(1, 4)) {
      expect(row.symptom.startsWith(label)).toBe(true)
    }
    const fourthRow = doc.querySelectorAll('#trouble tbody tr')[3]
    expect(fourthRow.textContent!.startsWith(label)).toBe(true)
  })

  it('shows the LINE Pay section only in zh-TW', async () => {
    const { doc } = await renderPage(locale)
    expect(doc.getElementById('line-pay') !== null).toBe(locale === 'zh-TW')
    expect(t.linePay.heading !== '').toBe(locale === 'zh-TW')
  })

  it('the example URLs on the page parse to the expected prefill', async () => {
    const { doc } = await renderPage(locale)
    const codes = [...doc.querySelectorAll('pre')].map((el) => el.textContent ?? '')
    const app = appUrl(t.vars.amount, t.vars.merchant)
    const web = webUrl(t.vars.amount, t.vars.merchant)
    expect(codes).toContain(app)
    expect(codes).toContain(web)
    // Fill the variable markers the way the Shortcut would.
    const fill = (u: string) => u.replace(`[${t.vars.amount}]`, '120').replace(`[${t.vars.merchant}]`, 'Cafe')
    // #1822 — removed `category` from the examples; merchant memory takes over.
    // When no category is passed, the parser returns only amount + description.
    expect(parseQuickAddSchemeUrl(fill(app))).toEqual({ amount: 120, description: 'Cafe' })
    const hash = fill(web).slice(fill(web).indexOf('#'))
    expect(parseQuickAddHash(hash)).toEqual({ amount: 120, description: 'Cafe' })
  })

  it('lists exactly the categories the parser accepts, with the app\'s own names', async () => {
    expect([...CATEGORY_IDS].sort()).toEqual(PICKABLE_CATEGORIES.map((c) => c.id).sort())
    const { doc } = await renderPage(locale)
    const rows = [...doc.querySelectorAll('#params tbody tr')].map((tr) => tr.textContent ?? '')
    for (const id of CATEGORY_IDS) {
      expect(rows.some((r) => r.startsWith(id) && r.includes(dictionaries[locale].category[id]))).toBe(true)
    }
  })

  it('keeps the trust claim: no auto-logging / binding wording, no exclamation marks', () => {
    // #1751: the SEO strings and the settings row are user-facing copy of the same page.
    const all = JSON.stringify([t, dictionaries[locale].seo.featureShortcuts, dictionaries[locale].settings.shortcutsGuide])
    expect(all).not.toMatch(/自動記帳|自动记账|綁定|绑定|串接|[!！]|加密|encrypt|暗号化/i)
    expect(all).not.toMatch(/管理|追蹤|追踪|監控|监控/)
    // The iOS shell opens this page (Apple 2.3.10): never name another platform.
    expect(all).not.toMatch(/android/i)
  })

  it('emits breadcrumb and HowTo JSON-LD for the Apple Pay steps', async () => {
    const { doc } = await renderPage(locale)
    const blocks = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((el) =>
      JSON.parse(el.textContent ?? '{}'),
    )
    expect(blocks.map((b) => b['@type'])).toEqual(['BreadcrumbList', 'HowTo'])
    expect(blocks[1].step).toHaveLength(3)
    expect(blocks[1].step).toEqual(t.applePay.steps.map((step, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: t.howToStepName.replace('{n}', String(i + 1)),
      text: `${step.title}: ${step.body}`,
      url: expect.stringContaining(`#step-${i + 1}`),
    })))
  })
})

it('keeps the llms Shortcuts section aligned with the Apple Pay guide', () => {
  const body = readFileSync(path.join(process.cwd(), 'public', 'llms-full.txt'), 'utf8')
  // Up to the next ## or ### heading, so terms from a later section can't satisfy (or fail) it.
  const section = body.match(/^### 16\. Shortcuts[^\n]*\n[\s\S]*?(?=^#{2,3} |$(?![\s\S]))/m)?.[0]
  expect(section).toBeDefined()
  for (const term of [
    'iOS 17', '1.9.0', 'Add Entry to Futari', 'Futari 記一筆',
    'Edit → Automation → Wallet', 'Notify off', 'Run Immediately',
    'Shortcut Input (Type: Transaction) → Amount', 'Shortcut Input (Type: Transaction) → Merchant',
    'when the rounding step is skipped) needs Type: Transaction',
  ]) {
    expect(section).toContain(term)
  }
  expect(section).not.toContain('iOS 16')
})

describe('sitemap', () => {
  it('lists /features/shortcuts in all four locales', () => {
    const urls = new Set(sitemap().map((e) => e.url))
    for (const locale of SUPPORTED_LOCALES) {
      expect(urls.has(`http://localhost:3000${localizedHref('/features/shortcuts', locale)}`)).toBe(true)
    }
  })
})
