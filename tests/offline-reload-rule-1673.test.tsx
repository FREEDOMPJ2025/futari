/**
 * #1673 S1.3 — the reload rule.
 *
 * After offline browsing goes off, a tab still controlled by the full worker
 * (`/sw.js`) reloads once, which releases control. While a `/sw.js`
 * registration still exists the reload would come back controlled, so the tab
 * skips the signal WITHOUT spending its loop guard; the broadcast sent after
 * the unregister triggers it.
 *
 * Failure looks like: the other tab (or the Android shell's single WebView)
 * stays controlled by the old worker after a turn-off — or, with the guard
 * spent on a too-early signal, never reloads at all. Nothing errors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import {
  installOfflineEnv,
  uninstallOfflineEnv,
  flush,
  FakeWorker,
  makeBroadcastChannelClass,
  type OfflineEnv,
} from './helpers/offlineFakes'

const refreshSpy = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}))

const swc = await import('@/lib/offline/swControl')
const pref = await import('@/lib/offline/preference')
const { OfflineLifecycle } = await import('@/app/(dashboard)/_components/OfflineLifecycle')
const { ReconnectRefresh } = await import('@/app/(dashboard)/_components/ReconnectRefresh')

const PREF = pref.OFFLINE_PREF_KEY
let env: OfflineEnv
let reload: ReturnType<typeof vi.fn>

function setController(path: string | null) {
  env.sw.controller = path ? new FakeWorker(`http://localhost${path}`, 'activated') : null
}
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
}

function install(opts: { broadcast?: boolean } = {}) {
  env = installOfflineEnv(opts)
  reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, href: 'http://localhost/dashboard', reload, replace: vi.fn() })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  swc.resetOfflineQueueForTests()
  refreshSpy.mockClear()
  setVisibility('visible')
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
})
afterEach(() => {
  vi.useRealTimers()
  uninstallOfflineEnv()
})

const signals: Array<[string, () => void]> = [
  ['storage', () => window.dispatchEvent(new StorageEvent('storage', { key: PREF }))],
  ['broadcast', () => {
    const ch = new BroadcastChannel(swc.OFFLINE_CHANNEL)
    ch.postMessage({ type: swc.OFFLINE_OFF_MESSAGE })
    ch.close()
  }],
  ['pageshow (persisted)', () => {
    const e = new Event('pageshow') as Event & { persisted: boolean }
    Object.defineProperty(e, 'persisted', { value: true })
    window.dispatchEvent(e)
  }],
  ['visibilitychange → visible', () => {
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
  }],
]

async function mountLifecycle() {
  render(<OfflineLifecycle />)
  // Let the pref-off mount sweep finish before signalling.
  await waitFor(() => expect(env.ops).toContain(`caches.delete:offline-consent-v1`))
  await flush()
}

describe('unit 3 — reload rule in OfflineLifecycle', () => {
  it.each(signals)('reloads on %s when the pref is off and the controller is /sw.js', async (_name, fire) => {
    install()
    setController('/sw.js')
    await mountLifecycle()
    act(() => fire())
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it.each([
    ['no controller', null],
    ['another script', '/sw-basic.js'],
  ])('never reloads with %s', async (_label, path) => {
    install()
    setController(path)
    await mountLifecycle()
    for (const [, fire] of signals) act(() => fire())
    await flush(20)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload while the pref is on', async () => {
    install()
    localStorage.setItem(PREF, 'true')
    setController('/sw.js')
    render(<OfflineLifecycle />)
    await flush()
    for (const [, fire] of signals) act(() => fire())
    await flush(20)
    expect(reload).not.toHaveBeenCalled()
  })

  it('loop guard: at most one reload per 10 s', async () => {
    install()
    setController('/sw.js')
    await mountLifecycle()
    act(() => signals[0][1]())
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    act(() => signals[3][1]())
    await flush(20)
    expect(reload).toHaveBeenCalledTimes(1)
    // 11 s later the guard has expired.
    const at = Number(sessionStorage.getItem(swc.RELOAD_GUARD_KEY))
    vi.spyOn(Date, 'now').mockReturnValue(at + 11_000)
    act(() => signals[3][1]())
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
  })

  it('rev 4: storage signal while /sw.js is still registered → skip without spending the guard; the broadcast after the unregister reloads once', async () => {
    install()
    setController('/sw.js')
    const reg = env.sw.seedActive('/sw.js')
    // Mount sweep would unregister it; keep the registration for this case by
    // starting with the pref off but mounting the signal listener only.
    const unsub = swc.subscribeOffSignals(() => { void swc.enqueueOfflineSequence(() => swc.applyOffReloadRule()) })
    act(() => signals[0][1]())
    await flush(20)
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(swc.RELOAD_GUARD_KEY)).toBeNull()
    // The other context finishes its off: unregister, then broadcast.
    await reg.unregister()
    const ch = new BroadcastChannel(swc.OFFLINE_CHANNEL)
    ch.postMessage({ type: swc.OFFLINE_OFF_MESSAGE })
    ch.close()
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    await flush(20)
    expect(reload).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('rev 4, logout order: storage signal during steps 0–2, broadcast after signOut → exactly one reload', async () => {
    install()
    setController('/sw.js')
    env.sw.seedActive('/sw.js')
    localStorage.setItem(PREF, 'true')
    const unsub = swc.subscribeOffSignals(() => { void swc.enqueueOfflineSequence(() => swc.applyOffReloadRule()) })
    // "Tab A" logs out. Its pref removal reaches this tab as a storage event
    // while the registration still exists.
    const seq = swc.createSequence()
    const begin = swc.beginOfflineOff({ reason: 'logout', seq })
    act(() => signals[0][1]())
    await begin
    await flush(20)
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(swc.RELOAD_GUARD_KEY)).toBeNull()
    // signOut… then steps 3–5 (broadcast first).
    await swc.finishOfflineOff({ seq })
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    await flush(20)
    expect(reload).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('without BroadcastChannel, the 1 s re-check reloads once', async () => {
    install({ broadcast: false })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    setController('/sw.js')
    const reg = env.sw.seedActive('/sw.js')
    const unsub = swc.subscribeOffSignals(() => { void swc.applyOffReloadRule() })
    window.dispatchEvent(new StorageEvent('storage', { key: PREF }))
    await vi.advanceTimersByTimeAsync(0)
    expect(reload).not.toHaveBeenCalled()
    await reg.unregister()
    await vi.advanceTimersByTimeAsync(swc.NO_CHANNEL_RECHECK_MS + 10)
    expect(reload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reload).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('the tab that turned it off runs the rule inline after the full off', async () => {
    install()
    setController('/sw.js')
    env.sw.seedActive('/sw.js')
    localStorage.setItem(PREF, 'true')
    const { runTurnOff } = await import('@/lib/offline/lifecycle')
    await swc.enqueueOfflineSequence((seq) => runTurnOff(seq))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('unit 3 — ReconnectRefresh', () => {
  it('reloads instead of refreshing when the rule holds', async () => {
    install()
    setController('/sw.js')
    render(<ReconnectRefresh />)
    act(() => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('refreshes when the controller is not /sw.js', async () => {
    install()
    setController('/sw-basic.js')
    render(<ReconnectRefresh />)
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })

  it('refreshes when the pref is on', async () => {
    install()
    localStorage.setItem(PREF, 'true')
    setController('/sw.js')
    render(<ReconnectRefresh />)
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })
})

// ─── Harness: two simulated contexts (plan "S1 proving acceptance", real-browser
// substitute for the dashboard-only reload hook) ────────────────────────────

describe('harness — two contexts sharing storage events and a BroadcastChannel', () => {
  type Ctx = {
    name: string
    win: EventTarget
    doc: EventTarget & { visibilityState: DocumentVisibilityState }
    reloads: number
    env: import('@/lib/offline/swControl').OffReloadEnv
    unsub: () => void
  }

  function setup() {
    const ops: string[] = []
    const Channel = makeBroadcastChannelClass(ops) as unknown as typeof BroadcastChannel
    const shared = { pref: true, regs: ['/sw.js'] as string[] }
    const contexts: Ctx[] = []
    function makeContext(name: string, controller: string | null): Ctx {
      const session = new Map<string, string>()
      const win = new EventTarget()
      const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
      const ctx = { name, win, doc, reloads: 0 } as Ctx
      ctx.env = {
        pref: () => shared.pref,
        supported: () => true,
        controllerScript: () => (controller ? `http://localhost${controller}` : null),
        hasFullRegistration: async () => shared.regs.includes('/sw.js'),
        guardStore: () => ({
          getItem: (k: string) => session.get(k) ?? null,
          setItem: (k: string, v: string) => { session.set(k, v) },
        }),
        reload: () => { ctx.reloads++ },
        broadcastAvailable: () => true,
      }
      ctx.unsub = swc.subscribeOffSignals(
        () => { void swc.applyOffReloadRule({ env: ctx.env }) },
        { win, doc, Channel },
      )
      contexts.push(ctx)
      return ctx
    }
    /** Context `from` turns offline browsing off (the full-off order). */
    async function turnOff(from: Ctx) {
      shared.pref = false
      // localStorage write → a `storage` event in every OTHER context, while
      // the registration still exists.
      for (const c of contexts) {
        if (c !== from) {
          const e = new Event('storage') as Event & { key: string }
          Object.defineProperty(e, 'key', { value: PREF })
          c.win.dispatchEvent(e)
        }
      }
      await flush(5)
      shared.regs = [] // unregister
      const ch = new Channel(swc.OFFLINE_CHANNEL)
      ch.postMessage({ type: swc.OFFLINE_OFF_MESSAGE })
      ch.close()
      await flush(10)
    }
    return { makeContext, turnOff, contexts }
  }

  it('the other /sw.js context reloads exactly once; the guard blocks a second within 10 s; null and /sw-basic.js never reload', async () => {
    const { makeContext, turnOff, contexts } = setup()
    const a = makeContext('A (turning off)', '/sw.js')
    const b = makeContext('B', '/sw.js')
    const c = makeContext('C (uncontrolled)', null)
    const d = makeContext('D (basic)', '/sw-basic.js')

    await turnOff(a)
    expect(b.reloads).toBe(1)
    // BroadcastChannel also delivers to the sender's own listener (a different
    // instance), so A applies the rule too — the same rule it runs inline
    // after its full off (S1.3). The guard keeps it to one.
    expect(a.reloads).toBe(1)
    expect(c.reloads).toBe(0)
    expect(d.reloads).toBe(0)

    // B's (simulated) reload did not release control: a later signal within
    // 10 s must not reload again.
    b.doc.dispatchEvent(new Event('visibilitychange'))
    await flush(10)
    expect(b.reloads).toBe(1)

    for (const x of contexts) x.unsub()
  })
})
