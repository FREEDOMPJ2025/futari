/**
 * #1617 — LogoutButton calls exactly ONE server action.
 *
 * Next.js runs server actions one at a time per client. With the #1605 shape
 * (await `unregisterThisDevice`, then `signOut`) the client-side 2 s race was
 * not a bound: `signOut` queued behind the delete. Now the stored token is
 * handed to `signOut(token)`, which bounds the delete server-side.
 *
 * Failure looks like (if a second action comes back in front of signOut):
 * tapping 登出 hangs on a slow network for as long as that action takes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  calls: [] as string[],
  signOut: vi.fn(async (_token?: string) => {}),
  // #1673: the old `clearDynamicCache` mock became the full-off steps. They
  // record into `order` (not `calls`, which holds server actions only).
  order: [] as string[],
  beginOfflineOff: vi.fn(async (_opts: unknown) => true),
  finishOfflineOff: vi.fn(async (_opts: unknown) => {}),
  createSequence: vi.fn(() => ({ expected: false, ok: () => true, setPref: () => {} })),
  replace: vi.fn(),
}))

// Every export of the actions module is a spy that records its name, so a
// second server action called from the handler would show up in `calls`.
vi.mock('@/actions/auth', () => ({
  signOut: (...args: [string?]) => { h.calls.push('signOut'); h.order.push('signOut'); return h.signOut(...args) },
  recordNativeAuthConversion: () => { h.calls.push('recordNativeAuthConversion') },
}))
vi.mock('@/lib/offline/swControl', () => ({
  beginOfflineOff: (opts: unknown) => { h.order.push('beginOfflineOff'); return h.beginOfflineOff(opts) },
  finishOfflineOff: (opts: unknown) => { h.order.push('finishOfflineOff'); return h.finishOfflineOff(opts) },
  createSequence: h.createSequence,
}))
vi.mock('@/lib/i18n/client', () => ({
  useTranslations: () => ({
    logoutButton: { label: 'Log out', pending: 'Logging out', title: 'Log out?', description: 'desc' },
  }),
}))
vi.mock('@/app/(dashboard)/_components/ConfirmModal', () => ({
  ConfirmModal: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? <button type="button" onClick={onConfirm}>confirm-logout</button> : null,
}))

const { LogoutButton } = await import('@/app/(dashboard)/settings/_components/LogoutButton')
const { PUSH_TOKEN_STORAGE_KEY, storePushToken } = await import('@/lib/pushTokenStorage')

beforeEach(() => {
  h.calls.length = 0
  h.order.length = 0
  vi.clearAllMocks()
  h.signOut.mockImplementation(async () => {})
  localStorage.clear()
  h.replace.mockImplementation(() => { h.order.push('navigate') })
  vi.stubGlobal('location', { ...window.location, replace: h.replace })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function confirmLogout() {
  render(<LogoutButton />)
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
  fireEvent.click(screen.getByRole('button', { name: 'confirm-logout' }))
  await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/'))
}

describe('LogoutButton (#1617)', () => {
  it('calls exactly one server action — signOut with this device\'s stored token — then forgets the token', async () => {
    storePushToken('T1')
    const seenAtCall: Array<string | null> = []
    h.signOut.mockImplementation(async () => { seenAtCall.push(localStorage.getItem(PUSH_TOKEN_STORAGE_KEY)) })

    await confirmLogout()

    expect(h.calls).toEqual(['signOut'])
    expect(h.signOut).toHaveBeenCalledExactlyOnceWith('T1')
    // #1673: marker/pref/unregister before the action, clears after it.
    expect(h.beginOfflineOff).toHaveBeenCalledOnce()
    expect(h.finishOfflineOff).toHaveBeenCalledOnce()
    expect(h.order).toEqual(['beginOfflineOff', 'signOut', 'finishOfflineOff', 'navigate'])
    // Still stored while the action runs; forgotten after it.
    expect(seenAtCall).toEqual(['T1'])
    expect(localStorage.getItem(PUSH_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('with nothing stored, signs out with no token (the server skips the delete)', async () => {
    await confirmLogout()
    expect(h.calls).toEqual(['signOut'])
    expect(h.signOut).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('a failing signOut (NEXT_REDIRECT or network) still reaches the hard navigation', async () => {
    storePushToken('T1')
    h.signOut.mockImplementation(async () => { throw new Error('NEXT_REDIRECT') })
    await confirmLogout()
    expect(h.calls).toEqual(['signOut'])
    expect(localStorage.getItem(PUSH_TOKEN_STORAGE_KEY)).toBeNull()
    // The device is still cleared before the hard navigation.
    expect(h.order).toEqual(['beginOfflineOff', 'signOut', 'finishOfflineOff', 'navigate'])
  })
})
