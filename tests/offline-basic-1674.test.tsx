/**
 * #1674 — the web's basic worker on the client: when `/sw-basic.js` is
 * registered, kept, re-checked, replaced and never touched.
 *
 * Failure looks like: a web user who never opted in loses the Futari offline
 * page after a few dashboard loads (the mount sweep unregistered it), a
 * registration churns on every mount, a native shell suddenly gets a service
 * worker, the kill switch leaves the worker installed, or turning offline
 * browsing ON fails because the basic worker was "already active". Nothing
 * errors in any of these.
 *
 * Plan S2 (plan-1673-1674.md, rev 5): repeated mounts, basic → full
 * transition, the step 8 content check, kill mode (P1), native-shell guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  installOfflineEnv,
  uninstallOfflineEnv,
  indexOfOp,
  type OfflineEnv,
  type FakeRegistration,
} from './helpers/offlineFakes'

const h = vi.hoisted(() => ({
  mode: 'basic' as 'basic' | 'kill',
  session: { user: { id: '11111111-2222-3333-4444-555555555555' } } as { user: { id: string } } | null,
}))

vi.mock('@/lib/offline/swBasicMode', () => ({
  get SW_BASIC_MODE() {
    return h.mode
  },
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: () => Promise.resolve({ data: { session: h.session } }) },
  }),
}))

const swc = await import('@/lib/offline/swControl')
const lc = await import('@/lib/offline/lifecycle')
const pref = await import('@/lib/offline/preference')

const BASIC_CACHE = 'offline-basic-5a5ac3e2b4afde95'
const PAGE = '/offline-basic.html'

let env: OfflineEnv
let reload: ReturnType<typeof vi.fn>

function useTimers() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
}
async function until(pred: () => boolean) {
  for (let i = 0; i < 500 && !pred(); i++) {
    await new Promise((r) => setImmediate(r))
    await vi.advanceTimersByTimeAsync(0)
  }
  expect(pred()).toBe(true)
}

function cacheNames() { return [...env.caches.stores.keys()].sort() }
function regPaths() { return env.sw.regs.map((r) => r.path).sort() }
const registers = (path: string) => env.ops.filter((o) => o === `register:${path}`).length

/** What the real basic worker does on install + activate. */
function behaveLikeBasicWorker(opts: { cachesPage?: boolean } = {}) {
  env.sw.onRegister['/sw-basic.js'] = (reg: FakeRegistration) => {
    reg.activate()
    if (opts.cachesPage !== false) env.caches.seed(BASIC_CACHE, [PAGE])
  }
}

/** A device where the basic worker is installed and working. */
function seedBasicInstalled(): FakeRegistration {
  const reg = env.sw.seedActive('/sw-basic.js')
  env.caches.seed(BASIC_CACHE, [PAGE])
  env.ops.length = 0
  return reg
}

function run<T>(fn: (seq: import('@/lib/offline/swControl').OfflineSequence) => Promise<T>) {
  return swc.enqueueOfflineSequence(fn)
}

beforeEach(() => {
  h.mode = 'basic'
  h.session = { user: { id: '11111111-2222-3333-4444-555555555555' } }
  localStorage.clear()
  sessionStorage.clear()
  swc.resetOfflineQueueForTests()
  env = installOfflineEnv()
  reload = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload, replace: vi.fn() },
  })
  delete (window as unknown as Record<string, unknown>).Capacitor
})

afterEach(() => {
  vi.useRealTimers()
  uninstallOfflineEnv()
  delete (window as unknown as Record<string, unknown>).Capacitor
})

describe('pref-off mount on the web registers the basic worker (S2.9)', () => {
  it('nothing installed → register /sw-basic.js, wait for activated, page check passes', async () => {
    behaveLikeBasicWorker()
    const result = await run((seq) => lc.runPrefOffMount(seq).then(() => 'done'))
    expect(result).toBe('done')
    expect(registers('/sw-basic.js')).toBe(1)
    expect(regPaths()).toEqual(['/sw-basic.js'])
    expect(cacheNames()).toEqual([BASIC_CACHE])
    expect(env.ops).not.toContain('ls.set:offline-off-epoch=1')
  })

  it('the full worker and its ledger data are swept first; the basic worker is kept', async () => {
    localStorage.setItem('offline-browsing-enabled', 'true')
    localStorage.removeItem('offline-browsing-enabled') // pref off, but leftovers remain
    env.sw.seedActive('/sw.js')
    env.caches.seed('dynamic-v1', ['http://localhost/dashboard'])
    env.caches.seed('offline-consent-v1', ['/__offline-consent'])
    env.idb.seedExpiration([{ url: 'http://localhost/dashboard?month=2026-10' }])
    behaveLikeBasicWorker()
    env.ops.length = 0
    await run((seq) => lc.runPrefOffMount(seq))
    expect(indexOfOp(env.ops, 'caches.delete:offline-consent-v1')).toBe(0)
    expect(indexOfOp(env.ops, 'unregister:/sw.js')).toBeLessThan(indexOfOp(env.ops, 'register:/sw-basic.js'))
    expect(regPaths()).toEqual(['/sw-basic.js'])
    expect(cacheNames()).toEqual([BASIC_CACHE])
    expect(env.idb.records()).toEqual([])
  })

  it('repeated mounts never unregister, never re-register, and keep exactly the basic cache', async () => {
    seedBasicInstalled()
    env.caches.seed('dynamic-v1', ['http://localhost/dashboard']) // e.g. written by an old tab
    for (let i = 0; i < 3; i++) {
      await run((seq) => lc.runPrefOffMount(seq))
      expect(regPaths()).toEqual(['/sw-basic.js'])
      expect(cacheNames()).toEqual([BASIC_CACHE])
    }
    expect(env.ops.some((o) => o.startsWith('unregister:'))).toBe(false)
    expect(env.ops.some((o) => o.startsWith('register:'))).toBe(false)
    expect(env.ops.some((o) => o === `caches.delete:${BASIC_CACHE}`)).toBe(false)
  })

  it('register rejects → the full off: no registration, no cache', async () => {
    vi.spyOn(env.sw, 'register').mockRejectedValue(new Error('SecurityError'))
    env.caches.seed('static-v1')
    await run((seq) => lc.runPrefOffMount(seq))
    expect(regPaths()).toEqual([])
    expect(cacheNames()).toEqual([])
    expect(localStorage.getItem('offline-browsing-enabled')).toBeNull()
  })

  it('no activation within 10 s → the full off', async () => {
    useTimers()
    const done = run((seq) => lc.runPrefOffMount(seq))
    await until(() => registers('/sw-basic.js') === 1)
    await vi.advanceTimersByTimeAsync(swc.BASIC_SW_ACTIVATION_TIMEOUT_MS)
    await done
    expect(regPaths()).toEqual([])
    expect(cacheNames()).toEqual([])
  })

  it('activated but no page cached → update() once; still missing → the full off', async () => {
    behaveLikeBasicWorker({ cachesPage: false })
    await run((seq) => lc.runPrefOffMount(seq))
    expect(env.ops.filter((o) => o === 'update:/sw-basic.js')).toHaveLength(1)
    expect(indexOfOp(env.ops, 'update:/sw-basic.js')).toBeLessThan(indexOfOp(env.ops, 'unregister:/sw-basic.js'))
    expect(regPaths()).toEqual([])
    expect(cacheNames()).toEqual([])
  })

  it('page missing but update() brings it back → kept, no full off', async () => {
    const reg = env.sw.seedActive('/sw-basic.js')
    reg.onUpdate = () => env.caches.seed(BASIC_CACHE, [PAGE])
    env.ops.length = 0
    let result: string | undefined
    await run(async (seq) => { result = await lc.ensureBasicWorker(seq) })
    expect(result).toBe('updated')
    expect(regPaths()).toEqual(['/sw-basic.js'])
    expect(env.ops.some((o) => o.startsWith('unregister:'))).toBe(false)
  })

  it('the pref turns on during the mount sweep → no register(/sw-basic.js), no full off', async () => {
    env.sw.seedActive('/sw.js')
    env.caches.seed('dynamic-v1')
    behaveLikeBasicWorker()
    env.ops.length = 0
    const origDelete = env.caches.delete.bind(env.caches)
    vi.spyOn(env.caches, 'delete').mockImplementation(async (name: string) => {
      const r = await origDelete(name)
      localStorage.setItem('offline-browsing-enabled', 'true') // the user's ON, from another tab
      return r
    })
    await run((seq) => lc.runPrefOffMount(seq))
    expect(registers('/sw-basic.js')).toBe(0)
    expect(env.ops.some((o) => o.startsWith('ls.set:offline-off-epoch'))).toBe(false)
    expect(localStorage.getItem('offline-browsing-enabled')).toBe('true')
  })
})

describe('explicit turn-off from Settings (S2.9)', () => {
  it('the full off removes everything, then the basic worker is registered fresh', async () => {
    localStorage.setItem('offline-browsing-enabled', 'true')
    env.sw.seedActive('/sw.js')
    env.caches.seed('dynamic-v1')
    env.caches.seed('offline-consent-v1')
    behaveLikeBasicWorker()
    env.ops.length = 0
    await run((seq) => lc.runTurnOff(seq))
    expect(indexOfOp(env.ops, 'caches.delete:offline-consent-v1')).toBeLessThan(indexOfOp(env.ops, 'unregister:/sw.js'))
    expect(indexOfOp(env.ops, 'unregister:/sw.js')).toBeLessThan(indexOfOp(env.ops, 'register:/sw-basic.js'))
    expect(localStorage.getItem('offline-browsing-enabled')).toBeNull()
    expect(regPaths()).toEqual(['/sw-basic.js'])
    expect(cacheNames()).toEqual([BASIC_CACHE])
  })

  it('a basic-controlled tab is never reloaded by the off signals', async () => {
    seedBasicInstalled()
    env.sw.controller = env.sw.regs[0].active
    const decision = await swc.applyOffReloadRule()
    expect(decision).toBe('none')
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('basic → full transition (S2, plan-verifier blocker rev 2)', () => {
  it('with the basic worker active, ON ends with the pref on, no full off, no basic cache', async () => {
    useTimers()
    seedBasicInstalled()
    const done = run((seq) => lc.runTurnOn(seq))
    await until(() => registers('/sw.js') === 1)
    // `ready` would resolve at once (the basic worker is active); it must not count.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(localStorage.getItem('offline-browsing-enabled')).toBeNull()
    env.sw.regs.find((r) => r.path === '/sw.js')!.activate()
    await vi.advanceTimersByTimeAsync(300)
    expect(await done).toBe('on')
    expect(localStorage.getItem('offline-browsing-enabled')).toBe('true')
    expect(env.ops.some((o) => o.startsWith('unregister:'))).toBe(false)
    expect(env.ops.some((o) => o.startsWith('ls.set:offline-off-epoch'))).toBe(false)
    expect(cacheNames().filter((n) => n.startsWith('offline-basic-'))).toEqual([])
    expect(cacheNames()).toContain('offline-consent-v1')
  })

  it('/sw.js not activated within 15 s → the full off and the error result', async () => {
    useTimers()
    seedBasicInstalled()
    const done = run((seq) => lc.runTurnOn(seq))
    await until(() => registers('/sw.js') === 1)
    await vi.advanceTimersByTimeAsync(swc.SW_ACTIVATION_TIMEOUT_MS)
    expect(await done).toBe('error')
    expect(localStorage.getItem('offline-browsing-enabled')).toBeNull()
    expect(regPaths()).toEqual([])
    expect(cacheNames()).toEqual([])
  })
})

describe('kill mode (P1)', () => {
  beforeEach(() => { h.mode = 'kill' })

  it('pref-off mount runs the full off and never registers /sw-basic.js', async () => {
    seedBasicInstalled()
    env.caches.seed('dynamic-v1')
    await run((seq) => lc.runPrefOffMount(seq))
    expect(registers('/sw-basic.js')).toBe(0)
    expect(regPaths()).toEqual([])
    expect(cacheNames()).toEqual([])
    expect(reload).not.toHaveBeenCalled()
  })

  it('turn-off from Settings never registers /sw-basic.js', async () => {
    localStorage.setItem('offline-browsing-enabled', 'true')
    env.sw.seedActive('/sw.js')
    env.ops.length = 0
    await run((seq) => lc.runTurnOff(seq))
    expect(registers('/sw-basic.js')).toBe(0)
    expect(regPaths()).toEqual([])
  })

  it('basicWorkerApplies() is false', () => {
    expect(lc.basicWorkerApplies()).toBe(false)
  })
})

describe('native shells never get the basic worker (S2.9)', () => {
  it.each(['android', 'ios'])('%s: pref-off mount never registers /sw-basic.js', async (platform) => {
    ;(window as unknown as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => platform,
    }
    behaveLikeBasicWorker()
    env.sw.seedActive('/sw.js')
    env.caches.seed('dynamic-v1')
    env.ops.length = 0
    await run((seq) => lc.runPrefOffMount(seq))
    expect(registers('/sw-basic.js')).toBe(0)
    expect(regPaths()).toEqual([])
    expect(cacheNames()).toEqual([])
    expect(lc.basicWorkerApplies()).toBe(false)
  })

  it('the web Capacitor global (isNativePlatform false) still counts as web', () => {
    ;(window as unknown as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => false,
      getPlatform: () => 'web',
    }
    expect(lc.basicWorkerApplies()).toBe(true)
  })
})

describe('the pref stays the only answer to "is it on" (S1 unchanged)', () => {
  it('an active basic worker never makes the pref or the owner appear', async () => {
    seedBasicInstalled()
    await run((seq) => lc.runPrefOffMount(seq))
    expect(pref.getOfflinePref()).toBe(false)
    expect(pref.getOfflineOwner()).toBeNull()
  })
})
