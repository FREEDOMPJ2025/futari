/**
 * #1791 — the wizard end to end for the three new sources, with the real
 * `processFile` and the real fixtures (only the server action is mocked), plus
 * the anonymous /migrate preview hook.
 *
 * Failure looks like: pick AndroMoney, upload the file, and the wizard answers
 * "no rows we can import" (banner read as the header), or lists an opening
 * balance and a transfer as expenses on the confirm step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactNode } from 'react'
import { render, screen, fireEvent, waitFor, cleanup, renderHook, act } from '@testing-library/react'
import { TranslationsProvider } from '@/lib/i18n/client'
import { en } from '@/lib/i18n/locales/en'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { ja } from '@/lib/i18n/locales/ja'

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/lib/observability/reportClientError', () => ({ reportClientError: vi.fn() }))

const importCsvBatch = vi.fn()
vi.mock('@/actions/import', () => ({
  importCsvBatch: (...a: unknown[]) => importCsvBatch(...a),
  rollbackImportBatch: vi.fn(),
}))

import { ImportContent } from '@/app/(dashboard)/settings/import/_components/ImportContent'
import { useCsvPreview } from '@/lib/migrate/useCsvPreview'

const FIXTURES = resolve(__dirname, '../lib/csvImport/__tests__/fixtures/1791')
const fixture = (name: string) => new File([readFileSync(resolve(FIXTURES, name))], name, { type: 'text/csv' })

beforeEach(() => {
  importCsvBatch.mockReset().mockResolvedValue({ ok: true, data: { batchId: 'b', importedCount: 3, errorCount: 2 } })
})
afterEach(() => cleanup())

function wrapper(children: ReactNode) {
  return <TranslationsProvider value={en} locale="en">{children}</TranslationsProvider>
}

function mount() {
  return render(wrapper(
    <ImportContent viewer={{ id: 'a', displayName: 'A' }} partner={{ id: 'b', displayName: 'B' }} viewerIsMemberA history={[]} />,
  ))
}

async function upload(container: HTMLElement, label: string, file: File) {
  fireEvent.click(screen.getByRole('button', { name: label }))
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  fireEvent.change(input, { target: { files: [file] } })
}

const S = en.settings.import

describe('import wizard — new source buttons (#1791)', () => {
  it('offers AndroMoney, Manebo and Splitwise next to the existing buttons', () => {
    mount()
    for (const label of ['Honeydue', 'Spendee', 'CWMoney', 'AndroMoney', S.step1.sources.manebo, 'Splitwise', S.step1.sources.generic]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('AndroMoney (Windows Excel / Big5, zh titles): reaches the confirm step with 3 rows and the right types', async () => {
    const { container } = mount()
    await upload(container, 'AndroMoney', fixture('andromoney_winexcel_big5_zh.csv'))
    await waitFor(() => expect(screen.getByRole('heading', { name: S.step2.title })).toBeTruthy())
    // Source summary on step 1 is not shown any more; go on: mapping -> rules -> confirm.
    fireEvent.click(screen.getByRole('button', { name: en.common.navigation.next }))
    fireEvent.click(screen.getByRole('button', { name: en.common.navigation.next }))

    expect(screen.getByRole('heading', { name: S.step4.title })).toBeTruthy()
    const shown = Array.from(container.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
    )
    expect(shown.map((r) => [r[0], r[3], r[4]])).toEqual([
      ['2026-09-15', '120', S.step4.typeExpense],
      ['2026-09-05', '45,000', S.step4.typeIncome],
      ['2026-09-17', '19', S.step4.typeExpense],
    ])
    expect(container.textContent).toContain('2 failed rows are kept in the log')

    fireEvent.click(screen.getByRole('button', { name: S.step4.confirmCta.other.replace('{count}', '3') }))
    await waitFor(() => expect(importCsvBatch).toHaveBeenCalledTimes(1))
    const sent = importCsvBatch.mock.calls[0]![0] as {
      source: string; totalRows: number
      rows: { date: string; amount: number; type: string }[]
      errors: { rowNumber: number; errorDetail: string }[]
    }
    expect(sent.source).toBe('andromoney')
    expect(sent.totalRows).toBe(5)
    expect(sent.rows.map((r) => [r.date, r.amount, r.type])).toEqual([
      ['2026-09-15', 120, 'expense'],
      ['2026-09-05', 45000, 'income'],
      ['2026-09-17', 19, 'expense'],
    ])
    expect(sent.errors.map((e) => [e.rowNumber, e.errorDetail])).toEqual([
      [1, 'row 1: opening balance rows are not imported'],
      [4, 'row 4: transfer rows are not imported'],
    ])
  })

  it('Manebo (Shift_JIS): reaches the confirm step with the two importable rows', async () => {
    const { container } = mount()
    await upload(container, S.step1.sources.manebo, fixture('manebo_ja_sjis.csv'))
    await waitFor(() => expect(screen.getByRole('heading', { name: S.step2.title })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.common.navigation.next }))
    fireEvent.click(screen.getByRole('button', { name: en.common.navigation.next }))
    const shown = Array.from(container.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
    )
    expect(shown.map((r) => [r[0], r[1], r[3]])).toEqual([
      ['2026-09-12', '—', '100,000'],
      ['2026-09-15', 'ランチ', '1,200'],
    ])
  })

  it('Splitwise: settle-up and Total balance are left out, 3 expenses remain', async () => {
    const { container } = mount()
    await upload(container, 'Splitwise', fixture('splitwise_recent_crlf_bom.csv'))
    await waitFor(() => expect(screen.getByRole('heading', { name: S.step2.title })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.common.navigation.next }))
    fireEvent.click(screen.getByRole('button', { name: en.common.navigation.next }))
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3)
  })

  it('a Manebo file whose Type column is gone: names the column instead of "no rows"', async () => {
    const text = readFileSync(resolve(FIXTURES, 'manebo_en_utf8.csv'), 'utf8').replace('Type', 'Kind')
    const { container } = mount()
    await upload(container, S.step1.sources.manebo, new File([text], 'manebo.csv', { type: 'text/csv' }))
    const msg = await screen.findByText(S.errors.missingColumns.replace('{columns}', 'Type'))
    expect(msg).toBeTruthy()
    expect(screen.queryByText(S.errors.noValidRows)).toBeNull()
    expect(screen.queryByRole('heading', { name: S.step2.title })).toBeNull()
  })

  it('the CWMoney button on an AndroMoney file ends in "no rows", imports nothing', async () => {
    const { container } = mount()
    await upload(container, 'CWMoney', fixture('andromoney_googledocs_utf8_zh.csv'))
    expect(await screen.findByText(S.errors.noValidRows)).toBeTruthy()
    expect(importCsvBatch).not.toHaveBeenCalled()
  })
})

describe('missingColumns message exists in all four locales', () => {
  it.each([['zh-TW', zhTW], ['zh-CN', zhCN], ['en', en], ['ja', ja]] as const)('%s', (_n, t) => {
    const m = t.settings.import.errors.missingColumns
    expect(m).toContain('{columns}')
    expect(m).not.toMatch(/[!！]/)
    for (const s of ['andromoney', 'manebo', 'splitwise'] as const) {
      expect(t.settings.import.step1.sources[s].length).toBeGreaterThan(0)
    }
  })
})

describe('useCsvPreview — the /migrate page hint selects the same parse hints (#1791)', () => {
  it('AndroMoney page: the banner line is skipped, the real header is detected as andromoney', async () => {
    const { result } = renderHook(() => useCsvPreview({ hint: 'andromoney' }))
    await act(async () => { await result.current.load(fixture('andromoney_googledocs_utf8_zh.csv')) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.headers[1]).toBe('幣別')
    expect(result.current.detectedSource).toBe('andromoney')
    expect(result.current.rows).toHaveLength(5)
  })

  it('any other page leaves the banner as the header, exactly as before', async () => {
    const { result } = renderHook(() => useCsvPreview({ hint: 'cwmoney' }))
    await act(async () => { await result.current.load(fixture('andromoney_googledocs_utf8_zh.csv')) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.headers).toEqual(['Google Documents', 'AndroMoney', '20261001'])
    expect(result.current.detectedSource).toBe('cwmoney')
  })

  it('Manebo page: a Shift_JIS file is read as Shift_JIS', async () => {
    const { result } = renderHook(() => useCsvPreview({ hint: 'manebo' }))
    await act(async () => { await result.current.load(fixture('manebo_ja_sjis.csv')) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.encoding).toBe('shift_jis')
    expect(result.current.headers[0]).toBe('日付')
    expect(result.current.detectedSource).toBe('manebo')
  })
})
