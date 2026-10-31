/**
 * #1768 — a request the browser cancels because the page is already navigating
 * away on purpose (iOS Apple sign-in success → window.location) is not an
 * error: global-error stays blank and does not report, unless the page is
 * still here after the grace period. Failure looks like: Sentry PRJ-FUTARI-9
 * (`TypeError: Load failed`) tracking the sign-in success count, and an error
 * page flashing over every successful sign-in.
 *
 * #1845 — when the iOS Apple identity token gets no answer from the auth server
 * (supabase-js AuthRetryableFetchError / status 0), the sign-in page says so
 * instead of silently dropping back to the buttons.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const capture = vi.hoisted(() => vi.fn())
vi.mock('@/lib/observability/sentryClient', () => ({ captureException: capture }))

const track = vi.fn()
vi.mock('@/lib/analytics/track', () => ({
  track: (...a: unknown[]) => track(...a),
  getAnonId: () => 'anon-1',
  analyticsReady: async () => {},
}))
vi.mock('@/actions/auth', () => ({ recordNativeAuthConversion: vi.fn(async () => ({ ok: true })) }))

const signInWithIdToken = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithOAuth: vi.fn(), signInWithIdToken } }),
}))
const addListener = async () => ({ remove: async () => {} })
vi.mock('@capacitor/browser', () => ({ Browser: { addListener, open: async () => {}, close: async () => {} } }))
vi.mock('@capacitor/app', () => ({ App: { addListener } }))
const authorize = vi.fn()
vi.mock('@capacitor-community/apple-sign-in', () => ({ SignInWithApple: { authorize: (...a: unknown[]) => authorize(...a) } }))

import GlobalError from '@/app/global-error'
import { SignInActions } from '@/app/[locale]/sign-in/SignInActions'
import { isCancelledFetchError, isNavigatingAway, markNavigatingAway } from '@/lib/observability/navigatingAway'

const FLAG = '__futariNavigatingAway'
const g = globalThis as Record<string, unknown>
const w = window as unknown as Record<string, unknown>
const ORIGIN = 'https://futari.test'
const UNREACHABLE = 'UNREACHABLE_HINT'
const FALLBACK = 'APPLE_FALLBACK_HINT'
const originalLocation = window.location

beforeEach(() => {
  capture.mockReset()
  track.mockReset()
  signInWithIdToken.mockReset()
  authorize.mockReset()
  delete g[FLAG]
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  delete g[FLAG]
  delete w.Capacitor
  delete w.webkit
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
})

describe('isCancelledFetchError', () => {
  it.each([
    ['Load failed', true],
    ['Failed to fetch', true],
    ['NetworkError when attempting to fetch resource.', true],
    ['Cannot read properties of undefined', false],
    ['boom Load failed', false],
  ])('TypeError(%j) → %s', (message, expected) => {
    expect(isCancelledFetchError(new TypeError(message))).toBe(expected)
  })

  it('needs a TypeError', () => {
    expect(isCancelledFetchError(new Error('Load failed'))).toBe(false)
    expect(isCancelledFetchError('Load failed')).toBe(false)
  })

  it('the flag starts unset and stays set', () => {
    expect(isNavigatingAway()).toBe(false)
    markNavigatingAway()
    expect(isNavigatingAway()).toBe(true)
  })
})

describe('global-error while navigating away (#1768)', () => {
  it('stays blank and quiet for a cancelled fetch after markNavigatingAway', async () => {
    vi.useFakeTimers()
    markNavigatingAway()
    const { container } = render(<GlobalError error={new TypeError('Load failed')} reset={() => {}} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(3900) })
    expect(capture).not.toHaveBeenCalled()
    expect(container.querySelector('h1')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows itself and reports when the page is still here after the grace period', async () => {
    vi.useFakeTimers()
    markNavigatingAway()
    const { container } = render(<GlobalError error={new TypeError('Load failed')} reset={() => {}} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    vi.useRealTimers()
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    expect(container.querySelector('h1')).not.toBeNull()
  })

  it('reports a cancelled fetch when nobody is navigating away', async () => {
    const { container } = render(<GlobalError error={new TypeError('Load failed')} reset={() => {}} />)
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    expect(container.querySelector('h1')).not.toBeNull()
  })

  it('reports any other error even while navigating away', async () => {
    markNavigatingAway()
    render(<GlobalError error={new Error('boom')} reset={() => {}} />)
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
  })
})

function setIos() {
  w.webkit = { messageHandlers: { bridge: { postMessage: () => {} } } }
  w.Capacitor = { getPlatform: () => 'ios' }
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { origin: ORIGIN, search: '', href: `${ORIGIN}/sign-in` },
  })
}

async function tapApple() {
  setIos()
  render(
    <SignInActions googleLabel="Google" appleLabel="Apple" pendingLabel="…" appleFallbackHint={FALLBACK} unreachableHint={UNREACHABLE} />,
  )
  await new Promise((r) => setTimeout(r, 20))
  fireEvent.click(screen.getByRole('button', { name: 'Apple' }))
}

describe('iOS Apple sign-in (#1768 / #1845)', () => {
  it('marks the page as navigating away right before the success redirect', async () => {
    authorize.mockResolvedValue({ response: { identityToken: 'id.token' } })
    signInWithIdToken.mockResolvedValue({ data: {}, error: null })
    await tapApple()
    await waitFor(() => expect(window.location.href).toBe(`${ORIGIN}/dashboard`))
    expect(isNavigatingAway()).toBe(true)
  })

  it.each([
    ['AuthRetryableFetchError', 0],
    ['AuthRetryableFetchError', 503],
    ['AuthUnknownError', 0],
  ])('%s / status %s shows the unreachable hint and drops the curtain', async (name, status) => {
    authorize.mockResolvedValue({ response: { identityToken: 'id.token' } })
    signInWithIdToken.mockResolvedValue({ data: {}, error: Object.assign(new Error('Load failed'), { name, status }) })
    await tapApple()
    await waitFor(() => expect(screen.getByText(UNREACHABLE)).toBeTruthy())
    expect(screen.queryByText(FALLBACK)).toBeNull()
    expect(screen.getByRole('button', { name: 'Apple' }).hasAttribute('disabled')).toBe(false)
    expect(isNavigatingAway()).toBe(false)
  })

  it('a real refusal (AuthApiError 400 / 500) keeps the silent abort', async () => {
    authorize.mockResolvedValue({ response: { identityToken: 'id.token' } })
    signInWithIdToken.mockResolvedValue({
      data: {},
      error: Object.assign(new Error('Database error saving new user'), { name: 'AuthApiError', status: 500 }),
    })
    await tapApple()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apple' }).hasAttribute('disabled')).toBe(false))
    expect(screen.queryByText(UNREACHABLE)).toBeNull()
    expect(screen.queryByText(FALLBACK)).toBeNull()
  })

  it('a new attempt clears the hint', async () => {
    authorize.mockResolvedValue({ response: { identityToken: 'id.token' } })
    signInWithIdToken.mockResolvedValue({ data: {}, error: Object.assign(new Error('x'), { name: 'AuthRetryableFetchError', status: 0 }) })
    await tapApple()
    await waitFor(() => expect(screen.getByText(UNREACHABLE)).toBeTruthy())
    signInWithIdToken.mockReturnValue(new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Apple' }))
    await waitFor(() => expect(screen.queryByText(UNREACHABLE)).toBeNull())
  })
})
