/**
 * #1948 — Sentry PRJ-FUTARI-9 on /dashboard and /settings in the iOS shell: an
 * RSC stream (router.refresh() after the app returns to the foreground) dies
 * while the (dashboard) layout chunk is still pending, the router throws
 * `TypeError: Load failed` for a segment only the root boundary sits above, and
 * app/global-error.tsx paints "出了點問題". Its reset() re-renders the same
 * rejected payload, so only a full reload recovers.
 *
 * Failure looks like: the user returns to the app, sees the error page, and the
 * network works again a second later; or a reload loop / a reload into a dead
 * network (WebView's own failure page) if the guards are dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

const capture = vi.hoisted(() => vi.fn())
vi.mock('@/lib/observability/sentryClient', () => ({ captureException: capture }))

import GlobalError from '@/app/global-error'
import {
  RELOAD_GUARD_MS,
  canAutoReload,
  markAutoReload,
  networkReachable,
} from '@/lib/observability/autoReload'

const originalLocation = window.location
const reload = vi.fn()
const reset = vi.fn()
const fetchMock = vi.fn()

function probeOk() {
  fetchMock.mockResolvedValue({ ok: true })
}
function probeDown() {
  fetchMock.mockRejectedValue(new TypeError('Load failed'))
}
async function settle(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
async function flushReport() {
  vi.useRealTimers()
  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
}

beforeEach(() => {
  capture.mockReset()
  reload.mockReset()
  reset.mockReset()
  fetchMock.mockReset()
  window.sessionStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, pathname: '/dashboard', reload },
  })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
})

describe('global-error auto-reload for a cancelled fetch (#1948)', () => {
  it('stays blank, probes a static asset, then reloads once and reports with op=auto-reload', async () => {
    probeOk()
    const { container } = render(<GlobalError error={new TypeError('Load failed')} reset={reset} />)
    await settle(900)
    expect(reload).not.toHaveBeenCalled()
    expect(container.querySelector('h1')).toBeNull()
    expect(capture).not.toHaveBeenCalled()

    await settle(200)
    expect(fetchMock).toHaveBeenCalledWith('/favicon.ico', expect.objectContaining({ method: 'HEAD', cache: 'no-store' }))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()
    expect(canAutoReload()).toBe(false)
    await flushReport()
    expect(capture.mock.calls[0][1]).toEqual({
      tags: { area: 'global-error', route: '/dashboard', op: 'auto-reload' },
    })
  })

  it('shows the normal page and reports plainly when the network is still down', async () => {
    probeDown()
    const { container } = render(<GlobalError error={new TypeError('Load failed')} reset={reset} />)
    await settle(1100)
    expect(reload).not.toHaveBeenCalled()
    expect(canAutoReload()).toBe(true)
    expect(container.querySelector('h1')).not.toBeNull()
    await flushReport()
    expect(capture.mock.calls[0][1]).toEqual({ tags: { area: 'global-error', route: '/dashboard' } })
  })

  it('shows the normal page when the probe answers with an error status', async () => {
    fetchMock.mockResolvedValue({ ok: false })
    const { container } = render(<GlobalError error={new TypeError('Load failed')} reset={reset} />)
    await settle(1100)
    expect(reload).not.toHaveBeenCalled()
    expect(container.querySelector('h1')).not.toBeNull()
  })

  it('never reloads twice within the guard window (a page that fails again after the reload is shown)', async () => {
    probeOk()
    markAutoReload()
    const { container } = render(<GlobalError error={new TypeError('Load failed')} reset={reset} />)
    expect(container.querySelector('h1')).not.toBeNull()
    await settle(2000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    await flushReport()
  })

  it('does not reload for any other error', async () => {
    probeOk()
    const { container } = render(<GlobalError error={new Error('boom')} reset={reset} />)
    await settle(2000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(container.querySelector('h1')).not.toBeNull()
    await flushReport()
  })
})

describe('autoReload guard', () => {
  it('opens again after RELOAD_GUARD_MS', () => {
    markAutoReload(1_000)
    expect(canAutoReload(1_000 + RELOAD_GUARD_MS - 1)).toBe(false)
    expect(canAutoReload(1_000 + RELOAD_GUARD_MS)).toBe(true)
  })

  it('treats an offline device as unreachable without probing', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(await networkReachable()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
