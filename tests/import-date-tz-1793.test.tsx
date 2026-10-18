/**
 * #1793 — the wizard shows and sends the calendar day written in the file, in
 * whatever zone the browser is in. Drives the real ImportContent (real
 * `processFile`, Honeydue is the default source) and reads two things: the date
 * cells of the confirm step, and the payload handed to `importCsvBatch`.
 *
 * Failure looks like: nothing at all. In UTC+8 the confirm table and the
 * request both said the day before (2026-09-14), and 10-01 said 09-30.
 *
 * Zone selection: see lib/csvImport/__tests__/dateTz.test.ts (assigning
 * process.env.TZ per test; the offset is asserted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { TranslationsProvider } from '@/lib/i18n/client'
import { en } from '@/lib/i18n/locales/en'

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/lib/observability/reportClientError', () => ({ reportClientError: vi.fn() }))

const importCsvBatch = vi.fn()
vi.mock('@/actions/import', () => ({
  importCsvBatch: (...a: unknown[]) => importCsvBatch(...a),
  rollbackImportBatch: vi.fn(),
}))

import { ImportContent } from '@/app/(dashboard)/settings/import/_components/ImportContent'

const ZONES: [string, number][] = [
  ['Asia/Taipei', -480],
  ['Asia/Tokyo', -540],
  ['UTC', 0],
  ['America/Los_Angeles', 420],
]

const CSV = [
  'Date,Name,Category,Amount,Account',
  '09/15/2026,Lunch,Groceries,-100,J',
  '10/01/2026,Rent,Home,-200,J',
].join('\n')

const originalTz = process.env.TZ
afterEach(() => {
  cleanup()
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})
beforeEach(() => {
  importCsvBatch.mockReset().mockResolvedValue({ ok: true, data: { batchId: 'b', importedCount: 2, errorCount: 0 } })
})

function wrapper(children: ReactNode) {
  return <TranslationsProvider value={en} locale="en">{children}</TranslationsProvider>
}

describe.each(ZONES)('import wizard dates in %s (#1793)', (zone, offset) => {
  it('confirm step and submitted payload carry the file calendar day', async () => {
    process.env.TZ = zone
    expect(new Date(2026, 8, 15).getTimezoneOffset()).toBe(offset)

    const { container } = render(wrapper(
      <ImportContent viewer={{ id: 'a', displayName: 'A' }} partner={{ id: 'b', displayName: 'B' }} viewerIsMemberA history={[]} />,
    ))
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File([CSV], 'honeydue.csv', { type: 'text/csv' })] } })
    await waitFor(() => expect(screen.getByRole('heading', { name: en.settings.import.step2.title })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.common.navigation.next }))
    fireEvent.click(screen.getByRole('button', { name: en.common.navigation.next }))

    // StepConfirm: first column of the preview table.
    const shown = Array.from(container.querySelectorAll('tbody tr')).map((tr) => tr.querySelector('td')!.textContent)
    expect(shown).toEqual(['2026-09-15', '2026-10-01'])

    fireEvent.click(screen.getByRole('button', { name: en.settings.import.step4.confirmCta.other.replace('{count}', '2') }))
    await waitFor(() => expect(importCsvBatch).toHaveBeenCalledTimes(1))
    const sent = importCsvBatch.mock.calls[0]![0] as { rows: { date: string }[] }
    expect(sent.rows.map((r) => r.date)).toEqual(['2026-09-15', '2026-10-01'])
  })
})
