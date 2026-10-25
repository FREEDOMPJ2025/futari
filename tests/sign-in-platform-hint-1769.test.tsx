import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// #1769 — `signed_in` / `signed_up` could not tell an Android-shell sign-in from
// a browser one: both land on /auth/callback. The shells' in-app browser flow
// now tags `redirectTo` with `p`, taken from the runtime platform:
//   Android                       → p=android_native
//   iOS Google, iOS Apple fallback → p=ios_browser
//   web                           → no p
// SignInButton is a native contract surface: a malformed `redirectTo` breaks
// sign-in in every installed shell at once, with no error. So the full shape is
// pinned here, not just "contains p".

const h = vi.hoisted(() => ({ opened: 0 }))

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn(), getAnonId: () => 'anon-1', analyticsReady: async () => {} }))
vi.mock('@/lib/observability/sentryClient', () => ({ captureException: vi.fn() }))
vi.mock('@/actions/auth', () => ({ recordNativeAuthConversion: vi.fn(async () => ({ ok: true })) }))

const signInWithOAuth = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithOAuth, signInWithIdToken: vi.fn() } }),
}))

const addListener = async () => ({ remove: async () => {} })
vi.mock('@capacitor/browser', () => ({
  Browser: { addListener, open: async () => { h.opened++ }, close: async () => {} },
}))
vi.mock('@capacitor/app', () => ({ App: { addListener } }))
const authorize = vi.fn()
vi.mock('@capacitor-community/apple-sign-in', () => ({ SignInWithApple: { authorize: (...a: unknown[]) => authorize(...a) } }))

import { SignInButton } from '@/app/[locale]/sign-in/SignInButton'

const ORIGIN = 'https://futari.test'
const NATIVE_BASE = 'dev.southernlight.futari://login-callback/auth/callback'
// The shape the plugin rejects with when the sheet cannot present (#935, #1552).
const APPLE_1000 = new Error('The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1000.)')

const w = window as unknown as Record<string, unknown>
const originalLocation = window.location

beforeEach(() => {
  vi.clearAllMocks()
  h.opened = 0
  signInWithOAuth.mockResolvedValue({ data: { url: 'https://idp.test/authorize' }, error: null })
  authorize.mockRejectedValue(APPLE_1000)
})

afterEach(() => {
  cleanup()
  delete w.Capacitor
  delete w.webkit
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
})

function setPage(search: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { origin: ORIGIN, search, href: `${ORIGIN}/sign-in${search}` },
  })
}

function setPlatform(platform: 'ios' | 'android' | 'web') {
  if (platform === 'web') return
  // Same as the #1314 / #1552 tests: real @capacitor/core can get loaded along
  // the way and re-detect the platform from the native bridge, so provide it.
  if (platform === 'ios') w.webkit = { messageHandlers: { bridge: { postMessage: () => {} } } }
  w.Capacitor = { getPlatform: () => platform }
}

/** Tap the button and return the `redirectTo` handed to Supabase. */
async function redirectToFor(platform: 'ios' | 'android' | 'web', provider: 'google' | 'apple', search = '?from=landing') {
  setPage(search)
  setPlatform(platform)
  const label = provider === 'google' ? 'Google' : 'Apple'
  render(<SignInButton provider={provider} label={label} pending={false} onStart={() => {}} onAbort={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: label }))
  await vi.waitFor(() => expect(signInWithOAuth).toHaveBeenCalledTimes(1))
  return (signInWithOAuth.mock.calls[0][0] as { options: { redirectTo: string } }).options.redirectTo
}

describe('redirectTo carries the shell platform (#1769)', () => {
  it('Android → p=android_native on the custom-scheme callback', async () => {
    const redirectTo = await redirectToFor('android', 'google')

    expect(redirectTo).toBe(`${NATIVE_BASE}?next=%2Fdashboard&from=landing&aid=anon-1&p=android_native`)
    await vi.waitFor(() => expect(h.opened).toBe(1))
  })

  it('Android Apple (browser flow) → p=android_native', async () => {
    const redirectTo = await redirectToFor('android', 'apple')

    expect(redirectTo).toBe(`${NATIVE_BASE}?next=%2Fdashboard&from=landing&aid=anon-1&p=android_native`)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('iOS Google → p=ios_browser', async () => {
    const redirectTo = await redirectToFor('ios', 'google')

    expect(redirectTo).toBe(`${NATIVE_BASE}?next=%2Fdashboard&from=landing&aid=anon-1&p=ios_browser`)
  })

  it('iOS Apple fallback (native sheet failed) → p=ios_browser', async () => {
    const redirectTo = await redirectToFor('ios', 'apple')

    expect(authorize).toHaveBeenCalledTimes(1)
    expect(redirectTo).toBe(`${NATIVE_BASE}?next=%2Fdashboard&from=landing&aid=anon-1&p=ios_browser`)
  })

  it('web → no p', async () => {
    signInWithOAuth.mockResolvedValue({ data: {}, error: null })
    const redirectTo = await redirectToFor('web', 'google')

    expect(redirectTo).toBe(`${ORIGIN}/auth/callback?next=%2Fdashboard&from=landing&aid=anon-1`)
  })

  // F3: the hint comes from the runtime platform only. A crafted sign-in link
  // carrying `?p=` must not mislabel a web sign-up, nor relabel a shell one.
  it('web page loaded with ?p=android_native → still no p', async () => {
    signInWithOAuth.mockResolvedValue({ data: {}, error: null })
    const redirectTo = await redirectToFor('web', 'google', '?from=landing&p=android_native')

    expect(new URL(redirectTo).searchParams.has('p')).toBe(false)
    expect(redirectTo).toBe(`${ORIGIN}/auth/callback?next=%2Fdashboard&from=landing&aid=anon-1`)
  })

  it('Android page loaded with ?p=ios_browser → still exactly one p=android_native', async () => {
    const redirectTo = await redirectToFor('android', 'google', '?next=%2Frecords&p=ios_browser')

    expect(redirectTo).toBe(`${NATIVE_BASE}?next=%2Frecords&aid=anon-1&p=android_native`)
  })
})
