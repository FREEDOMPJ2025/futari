/**
 * #1767 — CSV import: only UNEXPECTED failures go to Sentry.
 *
 * Failure looks like: a failed import leaves Sentry Issues empty (capture
 * dropped), or the opposite — every "wrong file" / expected `{ ok:false, code }`
 * outcome floods Issues. Neither shows an error to the user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TranslationsProvider } from '@/lib/i18n/client'
import { en } from '@/lib/i18n/locales/en'
import type { ProcessResult } from '@/lib/csvImport'

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

const report = vi.hoisted(() => vi.fn())
vi.mock('@/lib/observability/reportClientError', () => ({ reportClientError: report }))

const importCsvBatch = vi.fn()
vi.mock('@/actions/import', () => ({
  importCsvBatch: (...a: unknown[]) => importCsvBatch(...a),
  rollbackImportBatch: vi.fn(),
}))
const processFile = vi.fn()
vi.mock('@/lib/csvImport', async (orig) => {
  const actual = await orig<typeof import('@/lib/csvImport')>()
  return { ...actual, processFile: (...a: unknown[]) => processFile(...a) }
})

import { ImportContent } from '@/app/(dashboard)/settings/import/_components/ImportContent'

const row = {
  date: new Date('2026-09-01T00:00:00Z'), amount: 1, type: 'expense',
  category: 'dining', description: 'x', paidBy: 'a', splitType: 'half',
}
const PROCESSED = {
  source: 'honeydue', rows: [row], errors: [], warnings: [],
  stats: { total: 1, valid: 1, invalid: 0 },
} as unknown as ProcessResult

function wrapper(children: ReactNode) {
  return <TranslationsProvider value={en} locale="en">{children}</TranslationsProvider>
}
function renderWizard() {
  return render(wrapper(
    <ImportContent viewer={{ id: 'a', displayName: 'A' }} partner={{ id: 'b', displayName: 'B' }} viewerIsMemberA history={[]} />,
  ))
}
async function upload(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  fireEvent.change(input, { target: { files: [new File(['x'], 'a.csv', { type: 'text/csv' })] } })
}
async function submit(container: HTMLElement) {
  await upload(container)
  await waitFor(() => expect(screen.getByRole('heading', { name: en.settings.import.step2.title })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: en.common.navigation.next }))
  fireEvent.click(screen.getByRole('button', { name: en.common.navigation.next }))
  fireEvent.click(screen.getByRole('button', { name: en.settings.import.step4.confirmCta.one.replace('{count}', '1') }))
}

beforeEach(() => {
  report.mockReset()
  processFile.mockReset().mockResolvedValue(PROCESSED)
  importCsvBatch.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('import Sentry capture (#1767)', () => {
  it('reports an unexpected parse throw (op=parse)', async () => {
    processFile.mockRejectedValue(new Error('papaparse exploded'))
    const { container } = renderWizard()
    await upload(container)
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1))
    expect(report.mock.calls[0][1]).toEqual({ area: 'import', op: 'parse' })
  })

  it('does not report a file with no valid rows (normal validation outcome)', async () => {
    processFile.mockResolvedValue({ ...PROCESSED, rows: [] })
    const { container } = renderWizard()
    await upload(container)
    await waitFor(() => expect(screen.getByText(en.settings.import.errors.noValidRows)).toBeTruthy())
    expect(report).not.toHaveBeenCalled()
  })

  it('reports an unexpected submit throw (op=submit)', async () => {
    importCsvBatch.mockRejectedValue(new Error('network down'))
    const { container } = renderWizard()
    await submit(container)
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1))
    expect(report.mock.calls[0][1]).toEqual({ area: 'import', op: 'submit' })
  })

  it('does not report an expected action failure ({ ok:false, code })', async () => {
    importCsvBatch.mockResolvedValue({ ok: false, code: 'import_batch_not_found' })
    const { container } = renderWizard()
    await submit(container)
    await waitFor(() => expect(screen.getByText(en.settings.import.errors.submitFailed)).toBeTruthy())
    expect(report).not.toHaveBeenCalled()
  })
})
