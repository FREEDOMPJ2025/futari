/**
 * #1619 — 「我在已離開帳本裡的名字」 entry and its confirm dialog.
 *
 * The dialog is the only thing between a tap and a write that cannot be
 * undone, so its copy is held to the scope the action really has (#1191's
 * lesson: a trust sentence that says more than the code does spreads):
 * the scope sentence, 「這個改動無法還原。」, and the count — never 「移除」
 * 「徹底」「所有地方」, never the viewer's own name.
 *
 * Failure looks like: nothing errors. The row shows with nothing to change
 * (0 / 0), the dialog loses its "cannot be undone" line, or the count shows the
 * raw `{chapters}` placeholder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TranslationsProvider } from '@/lib/i18n/client'
import { ToastProvider } from '@/components/Toast'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'

const h = vi.hoisted(() => ({
  action: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, data: { chapters: 3, outings: 2 } })),
  refresh: vi.fn(),
}))
vi.mock('@/actions/profile', () => ({ hideMyNameInLeftLedgers: (...args: unknown[]) => h.action(...args) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }))

const { HideNameInLeftLedgers } = await import('@/app/(dashboard)/settings/past-times/_components/HideNameInLeftLedgers')

const copy = zhTW.pastTimes.hideName

function wrap(ui: ReactNode) {
  return render(
    <TranslationsProvider value={zhTW} locale="zh-TW">
      <ToastProvider>{ui}</ToastProvider>
    </TranslationsProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  h.action.mockImplementation(async () => ({ ok: true, data: { chapters: 3, outings: 2 } }))
})

describe('HideNameInLeftLedgers (#1619)', () => {
  it('renders nothing when nothing would change (0 / 0)', () => {
    const { container } = wrap(<HideNameInLeftLedgers chapters={0} outings={0} />)
    expect(container.textContent).toBe('')
  })

  it('confirm dialog: scope sentence + cannot-be-undone + the count; no overclaiming words', () => {
    wrap(<HideNameInLeftLedgers chapters={3} outings={2} />)
    expect(screen.getByRole('heading', { name: copy.title })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: copy.cta }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(copy.confirmTitle)).toBeTruthy()
    expect(within(dialog).getByText(copy.confirmBody)).toBeTruthy()
    expect(copy.confirmBody).toBe(
      '已離開的帳本裡，已結束的那幾段時光與出遊名單上，你的名字會顯示為「已離開的夥伴」。這個改動無法還原。',
    )
    expect(within(dialog).getByText('這次會改到 3 段時光、2 份出遊名單。')).toBeTruthy()
    expect(dialog.textContent).not.toMatch(/[{}]/)
    expect(dialog.textContent).not.toMatch(/移除|徹底|所有地方/)
    expect(h.action).not.toHaveBeenCalled()
  })

  it('confirm → the action (no arguments), a toast, and a refresh that hides the row', async () => {
    wrap(<HideNameInLeftLedgers chapters={3} outings={2} />)
    fireEvent.click(screen.getByRole('button', { name: copy.cta }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: copy.confirmLabel }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(copy.done))
    expect(h.action).toHaveBeenCalledExactlyOnceWith()
    expect(h.refresh).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('an expected failure shows its localized message, not the code', async () => {
    h.action.mockImplementation(async () => ({ ok: false, code: 'profile_not_found' }))
    wrap(<HideNameInLeftLedgers chapters={1} outings={0} />)
    fireEvent.click(screen.getByRole('button', { name: copy.cta }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: copy.confirmLabel }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zhTW.errors.actions.profile_not_found))
    expect(h.refresh).not.toHaveBeenCalled()
  })
})

describe('hideName copy, all four locales (#1619)', () => {
  const locales = { 'zh-TW': zhTW, 'zh-CN': zhCN, en, ja } as const
  const undo: Record<keyof typeof locales, string> = {
    'zh-TW': '這個改動無法還原。',
    'zh-CN': '这个改动无法还原。',
    en: 'This change can’t be undone.',
    ja: 'この変更は元に戻せません。',
  }
  for (const [name, dict] of Object.entries(locales) as [keyof typeof locales, typeof zhTW][]) {
    it(`${name}: says it cannot be undone, keeps both placeholders, no banned or overclaiming words`, () => {
      const c = dict.pastTimes.hideName
      expect(c.confirmBody.endsWith(undo[name])).toBe(true)
      expect(c.confirmCount).toContain('{chapters}')
      expect(c.confirmCount).toContain('{outings}')
      const all = Object.values(c).join('\n')
      expect(all).not.toMatch(/[！!]/)
      expect(all).not.toMatch(/管理|追蹤|監控|追踪|监控|移除|徹底|彻底|所有地方/)
      expect(all).not.toMatch(/\b(remove|removed|erase|everywhere|permanently delete)\b/i)
    })
  }
})
