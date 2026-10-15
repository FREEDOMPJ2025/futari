import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'
import { PastTimesExport } from '@/app/onboarding/past-times/_components/PastTimesExport'

// #1460 — the export now holds expenses, income and settlements of every
// chapter the person may look back at. Every in-app string that points at it
// names exactly that, and none claims more ("the whole ledger", "all
// records", messages). Marketing / SEO surfaces are a separate change (S5b).

const dicts = { 'zh-TW': zhTW, 'zh-CN': zhCN, en, ja } as const
const names = {
  'zh-TW': [/支出/, /進帳/, /結算/],
  'zh-CN': [/支出/, /进账/, /结算/],
  en: [/expense/i, /income/i, /settlement/i],
  ja: [/支出/, /収入/, /精算/],
} as const
const overclaim = {
  'zh-TW': /整本|整包|整批|所有紀錄|全部紀錄|留言/,
  'zh-CN': /整本|整包|整批|所有记录|全部记录|留言/,
  en: /everything|all records|whole ledger|take it all|message/i,
  ja: /まるごと|すべて|全部|メッセージ/,
} as const

describe('#1460 export copy, every locale', () => {
  for (const [locale, t] of Object.entries(dicts) as [keyof typeof dicts, typeof zhTW][]) {
    const strings = {
      'trust.portability.heading': t.trust.portability.heading,
      'trust.portability.body': t.trust.portability.body,
      'trust.onboarding.line2': t.trust.onboarding.line2,
      'pastTimes.exportHint': t.pastTimes.exportHint,
      'pastTimes.exportCta': t.pastTimes.exportCta,
    }
    for (const [key, s] of Object.entries(strings)) {
      it(`${locale} ${key} names expenses, income and settlements and claims no more`, () => {
        for (const re of names[locale]) expect(s).toMatch(re)
        expect(s).not.toMatch(overclaim[locale])
        expect(s).not.toMatch(/[!！]/)
        expect(s).not.toMatch(/管理|追蹤|监控|監控|追踪/)
      })
    }

    it(`${locale} CSV type labels exist for the three kinds`, () => {
      expect(Object.keys(t.csvExport.types).sort()).toEqual(['expense', 'income', 'settlement'])
    })
  }
})

describe('PastTimesExport (standalone past-times, a person with no ledger)', () => {
  it('starts the same export as /settings/trust and the leave flow', async () => {
    const fetchMock = vi.fn(async () => new Response('a\r\n', {
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="futari-transactions-2026-10-14.csv"' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const urlStatics = URL as unknown as { createObjectURL: unknown; revokeObjectURL: unknown }
    const saved = { create: urlStatics.createObjectURL, revoke: urlStatics.revokeObjectURL }
    urlStatics.createObjectURL = vi.fn(() => 'blob:x')
    urlStatics.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      render(<PastTimesExport hint={zhTW.pastTimes.exportHint} cta={zhTW.pastTimes.exportCta}
        preparing={zhTW.csvExport.preparing} failed={zhTW.csvExport.failed} />)
      expect(screen.getByText(zhTW.pastTimes.exportHint)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: zhTW.pastTimes.exportCta }))
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
      expect(fetchMock).toHaveBeenCalledWith('/api/export/transactions', { credentials: 'same-origin' })
    } finally {
      click.mockRestore()
      urlStatics.createObjectURL = saved.create
      urlStatics.revokeObjectURL = saved.revoke
      vi.unstubAllGlobals()
    }
  })

  it('a failed export shows the export error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    try {
      render(<PastTimesExport hint="h" cta={zhTW.pastTimes.exportCta}
        preparing={zhTW.csvExport.preparing} failed={zhTW.csvExport.failed} />)
      fireEvent.click(screen.getByRole('button', { name: zhTW.pastTimes.exportCta }))
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(zhTW.csvExport.failed))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
