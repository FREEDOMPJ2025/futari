import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor, act, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'

// ─── #1536 S2 — the plaintext shortcut key never reaches the page payload ───
//
// The settings page is a Server Component: whatever it passes to
// ShortcutKeyContent is serialised into the RSC payload and the HTML, which
// the browser history, the router cache and (on /dashboard-like routes) the
// service worker can keep. The key may only come from the generate action's
// response, into client state. Failure looks like: nothing errors; the
// plaintext key (or its hash) is just in every render of the page.
// ──────────────────────────────────────────────────────────────────────────────

const KEY = 'fts_sk_' + 'A'.repeat(39) + 'wxyz'
const HASH = 'f'.repeat(64)

const generateMock = vi.fn()
const revokeMock = vi.fn()
const refreshMock = vi.fn()

vi.mock('@/actions/shortcutKey', () => ({
  generateShortcutKey: (...a: unknown[]) => generateMock(...a),
  revokeShortcutKey: (...a: unknown[]) => revokeMock(...a),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, back: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/shortcut-key',
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))
vi.mock('@/lib/auth/viewer', () => ({
  requireViewerOrRedirect: async () => ({ user: { id: 'u1' } }),
}))
// The query the page uses. If it ever returned more than the summary (a hash,
// a key), the payload assertions below would catch it reaching the client.
vi.mock('@/lib/db/queries/shortcutKey', () => ({
  getActiveShortcutKeySummary: async () => ({
    hint: 'wxyz',
    createdAt: new Date('2026-10-16T16:30:00Z'),
    lastUsedAt: null,
    // Deliberately extra, to prove the page maps fields instead of spreading.
    keyHash: HASH,
    key: KEY,
  }),
}))
vi.mock('@/lib/i18n/t', () => ({ getLocale: async () => 'zh-TW' }))

import ShortcutKeyPage from '@/app/(dashboard)/settings/shortcut-key/page'
import { ShortcutKeyContent } from '@/app/(dashboard)/settings/shortcut-key/_components/ShortcutKeyContent'
import { TranslationsProvider } from '@/lib/i18n/client'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import type { ReactElement } from 'react'

const tk = zhTW.settings.shortcutKey

function wrap(node: ReactElement) {
  return <TranslationsProvider value={zhTW} locale="zh-TW">{node}</TranslationsProvider>
}

/** The props the server page hands its client child: what the RSC payload carries. */
function contentProps(tree: ReactElement): unknown {
  const kids = (tree.props as { children: ReactElement[] }).children
  const content = kids.find((k) => k.type === ShortcutKeyContent)
  expect(content).toBeDefined()
  return content!.props
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('settings/shortcut-key page payload', () => {
  it('passes only hint and formatted times — no key, no hash', async () => {
    const tree = (await ShortcutKeyPage()) as ReactElement
    const props = contentProps(tree)
    expect(props).toEqual({
      current: {
        hint: 'wxyz',
        // 16:30 UTC is 00:30 the next day in Taipei.
        createdLabel: expect.stringContaining('17'),
        lastUsedLabel: null,
      },
    })
    const json = JSON.stringify(props)
    expect(json).not.toContain('fts_sk_')
    expect(json).not.toContain(HASH)
  })

  it('server HTML contains no fts_sk_ for a user with an active key', async () => {
    const tree = (await ShortcutKeyPage()) as ReactElement
    const html = renderToString(wrap(tree))
    expect(html).toContain('wxyz')
    expect(html).not.toContain('fts_sk_')
    expect(html).not.toContain(HASH)
  })
})

describe('ShortcutKeyContent', () => {
  beforeEach(() => {
    generateMock.mockResolvedValue({ ok: true, data: { key: KEY, hint: 'wxyz', createdAt: '2026-10-17T00:00:00.000Z' } })
    revokeMock.mockResolvedValue({ ok: true, data: { revoked: true } })
  })

  it('shows the key only after generate, then drops it on pagehide', async () => {
    render(wrap(<ShortcutKeyContent current={null} />))
    expect(document.body.innerHTML).not.toContain('fts_sk_')

    fireEvent.click(screen.getByRole('button', { name: tk.generate }))
    const input = await screen.findByLabelText(tk.fresh.inputLabel)
    expect((input as HTMLInputElement).value).toBe(KEY)
    expect((input as HTMLInputElement).readOnly).toBe(true)
    expect(generateMock).toHaveBeenCalledWith()
    expect(refreshMock).toHaveBeenCalled()

    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(screen.queryByLabelText(tk.fresh.inputLabel)).toBeNull()
    expect(document.body.innerHTML).not.toContain('fts_sk_')
  })

  it('regenerate asks first; revoke clears a shown key', async () => {
    const current = { hint: 'abcd', createdLabel: 'x', lastUsedLabel: null }
    render(wrap(<ShortcutKeyContent current={current} />))

    fireEvent.click(screen.getByRole('button', { name: tk.regenerate.cta }))
    expect(generateMock).not.toHaveBeenCalled()
    expect(await screen.findByText(tk.regenerate.confirmBody)).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: tk.regenerate.confirmLabel }))
    await screen.findByLabelText(tk.fresh.inputLabel)
    expect(generateMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: tk.revoke.cta }))
    expect(await screen.findByText(tk.revoke.confirmBody)).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: tk.revoke.confirmLabel }))
    await waitFor(() => expect(revokeMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByLabelText(tk.fresh.inputLabel)).toBeNull())
  })

  it('a failed generate shows an error and no key', async () => {
    generateMock.mockResolvedValue({ ok: false, code: 'profile_not_found' })
    render(wrap(<ShortcutKeyContent current={null} />))
    fireEvent.click(screen.getByRole('button', { name: tk.generate }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(document.body.innerHTML).not.toContain('fts_sk_')
  })
})
