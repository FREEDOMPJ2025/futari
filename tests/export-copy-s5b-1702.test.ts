import { describe, it, expect } from 'vitest'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'

// #1702 S5b — the marketing / SEO surfaces that describe Futari's export
// name what it holds (expenses, income, settlements) and claim no more. Same
// rules as the in-app strings (tests/export-copy-1460.test.tsx). The migrate
// strings also feed the comparison table and pages that strangers land on.
//
// Failure looks like: nothing breaks; a landing or migrate page promises the
// whole ledger, and a stranger who exports later finds no messages or outings.

const dicts = { 'zh-TW': zhTW, 'zh-CN': zhCN, en, ja } as const
const names = {
  'zh-TW': [/支出/, /進帳/, /結算/],
  'zh-CN': [/支出/, /进账/, /结算/],
  en: [/expense/i, /income/i, /settlement/i],
  ja: [/支出/, /収入/, /精算/],
} as const
const overclaim = {
  'zh-TW': /整本|整包|整批|所有紀錄|所有記錄|全部紀錄|留言|資料永遠|資料是你/,
  'zh-CN': /整本|整包|整批|所有记录|全部记录|留言|数据永远|数据是你/,
  en: /everything|all records|whole ledger|take it all|message|your data is/i,
  ja: /まるごと|すべて|全部|メッセージ|データはずっと/,
} as const
const exportWord = /匯出|导出|export|書き出|エクスポート/i
// Read and judged: not a claim about what the export holds.
const notACoverageClaim = new Set([
  // ja 「…CSV の書き出しと取り込みはすべて追加課金なしで」: every feature is free.
  'ja:migrate.pages.simple-daily-money.faq.4.answer',
])

type Dict = typeof zhTW
const claims = (t: Dict) => ({
  'landing.trust.portability.body': t.landing.trust.portability.body,
  'signIn.about.s6Body[2]': t.signIn.about.s6Body[2],
  'migrate.trust.items[1].body': t.migrate.trust.items[1].body,
  'migrate.comparisonText.verdictCsvExport': t.migrate.comparisonText.verdictCsvExport,
  'migrate.pages.manebo.differentiators[0].body': t.migrate.pages.manebo.differentiators[0].body,
  'migrate.pages.simple-daily-money.differentiators[2].body': t.migrate.pages['simple-daily-money'].differentiators[2].body,
  'migrate.pages.fortune-city.differentiators[2].body': t.migrate.pages['fortune-city'].differentiators[2].body,
  'migrate.pages.cashman.differentiators[2].body': t.migrate.pages.cashman.differentiators[2].body,
})

function strings(o: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof o === 'string') out.push([path, o])
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) strings(v, `${path}.${k}`, out)
  return out
}

describe('#1702 S5b export copy on marketing / SEO surfaces', () => {
  for (const [locale, t] of Object.entries(dicts) as [keyof typeof dicts, Dict][]) {
    for (const [key, s] of Object.entries(claims(t))) {
      it(`${locale} ${key} names expenses, income and settlements and claims no more`, () => {
        for (const re of names[locale]) expect(s).toMatch(re)
        expect(s).not.toMatch(overclaim[locale])
        expect(s).not.toMatch(/[!！]/)
      })
    }

    it(`${locale}: no landing / about / migrate / seo string about export overclaims`, () => {
      const all = [
        ...strings(t.landing, 'landing'),
        ...strings(t.signIn.about, 'signIn.about'),
        ...strings(t.migrate, 'migrate'),
        ...strings(t.seo, 'seo'),
      ]
      const bad = all
        .filter(([p, s]) => exportWord.test(s) && overclaim[locale].test(s) && !notACoverageClaim.has(`${locale}:${p}`))
        .map(([p]) => p)
      expect(bad).toEqual([])
    })
  }
})
