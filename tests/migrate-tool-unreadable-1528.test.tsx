/**
 * #1528 A6 + F1, on the /migrate upload surface.
 *
 * A6: a file with no usable record shows the in-world error and no import
 * button. Failure looks like a preview card reading "1 筆紀錄 · 約 0 筆支出" and a
 * sign-up CTA that would import nothing; nothing throws.
 * F1: the dropzone label gets a keyboard focus ring on the brand variant only.
 * Failure looks like tabbing onto the dropzone and nothing visibly changing.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { zhTW } from '@/lib/i18n/locales/zh-TW'

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))

import { track } from '@/lib/analytics/track'
import { CsvFileUploadWidget } from '@/components/CsvFileUploadWidget'
import { MigrateTool } from '@/app/[locale]/migrate/_components/MigrateTool'

function upload(container: HTMLElement, text: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  const file = new File([text], 'x.csv', { type: 'text/csv' })
  // jsdom's File has no arrayBuffer in some versions; the hook calls it.
  if (!file.arrayBuffer) {
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => new Response(text).arrayBuffer(),
    })
  }
  fireEvent.change(input, { target: { files: [file] } })
}

describe('unreadable file on the /migrate dropzone (#1528 A6)', () => {
  it('shows the error in a live region and no import button', async () => {
    const { container } = render(
      <MigrateTool t={zhTW.migrate} locale="zh-TW" signInHref="/sign-in" hint="honeydue" />,
    )
    upload(container, 'hello there\nthis is not a ledger')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(zhTW.migrate.upload.error)
    expect(screen.queryByText(zhTW.migrate.cta.button)).toBeNull()
    expect(container.textContent).not.toContain('約 0')
    await waitFor(() =>
      expect(track).toHaveBeenCalledWith('migrate_preview_failed', {
        migrate_source: 'honeydue',
        reason: 'no_usable_rows',
      }),
    )
  })

  it('a valid Honeydue file still previews with the import button', async () => {
    const { container } = render(
      <MigrateTool t={zhTW.migrate} locale="zh-TW" signInHref="/sign-in" hint="honeydue" />,
    )
    upload(container, ['Date,Name,Category,Amount,Account', '2026-01-15,Coffee,Food,-4.5,Cash'].join('\n'))
    expect(await screen.findByText(zhTW.migrate.cta.button)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('dropzone keyboard focus ring (#1528 F1)', () => {
  const props = { onFile: vi.fn(), promptText: 'p', buttonText: 'b', retryText: 'r' }
  const labelOf = (c: HTMLElement) => c.querySelector('label')!.className

  it('the brand (md) variant rings the label when its input has focus-visible', () => {
    const { container } = render(<CsvFileUploadWidget {...props} size="md" />)
    expect(labelOf(container)).toContain('has-[:focus-visible]:outline-2')
    expect(labelOf(container)).toContain('has-[:focus-visible]:outline-ink')
  })

  it('the dashboard (sm) variant is unchanged', () => {
    const { container } = render(<CsvFileUploadWidget {...props} size="sm" />)
    expect(labelOf(container)).not.toContain('focus')
    expect(labelOf(container)).toBe('block cursor-pointer rounded-2xl px-6 py-9 text-center transition-colors')
  })
})
