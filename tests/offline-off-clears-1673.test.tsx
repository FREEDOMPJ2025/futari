/**
 * #1673 — turning offline browsing off (explicitly, by logout, by account
 * deletion, or by a user change) leaves no ledger data on the device, and the
 * preference is never switched on except by the user.
 *
 * Failure looks like: a turned-off or logged-out device still holds
 * `dynamic-v1` pages and `serwist-expiration` URL records, or the Settings
 * toggle shows ON again by itself; nothing errors, the UI looks normal.
 *
 * Plan units 1, 2, 4, 5, 6, 7, 7b, 7c, 7d (plan-1673-1674.md, Revision 5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import {
  installOfflineEnv,
  uninstallOfflineEnv,
  flush,
  indexOfOp,
  type OfflineEnv,
  type FakeRegistration,
} from './helpers/offlineFakes'

const h = vi.hoisted(() => ({
  session: { user: { id: '11111111-2222-3333-4444-555555555555' } } as { user: { id: string } } | null,
  getSession: null as null | (() => Promise<unknown>),
  signOut: null as null | (() => Promise<unknown>),
  requestAccountDeletion: null as null | (() => Promise<unknown>),
  ops: null as null | string[],
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: () =>
        h.getSession ? h.getSession() : Promise.resolve({ data: { session: h.session } }),
    },
  }),
}))
vi.mock('@/actions/auth', () => ({
  signOut: async () => {
    h.ops?.push('signOut')
    if (h.signOut) return h.signOut()
  },
}))
vi.mock('@/actions/account', () => ({
  requestAccountDeletion: async () => {
    h.ops?.push('requestAccountDeletion')
    if (h.requestAccountDeletion) return h.requestAccountDeletion()
    return { ok: true }
  },
}))
vi.mock('@/lib/i18n/client', () => ({
  useTranslations: () => ({
    logoutButton: { label: 'Log out', pending: 'Logging out', title: 't', description: 'd' },
    deleteAccountButton: { label: 'Delete', pending: 'Deleting', title: 't', description: 'd' },
    settings: {
      offlineBrowsing: 'Offline browsing',
      offlineUnsupported: 'unsupported',
      offlineToggling: '處理中',
      offlineHintOn: 'on-hint',
      offlineHintOff: 'off-hint',
      offlineToggleError: 'toggle-error',
    },
  }),
}))
vi.mock('@/app/(dashboard)/_components/ConfirmModal', () => ({
  ConfirmModal: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? <button type="button" onClick={onConfirm}>confirm</button> : null,
}))

const swc = await import('@/lib/offline/swControl')
const lc = await import('@/lib/offline/lifecycle')
const pref = await import('@/lib/offline/preference')
const { LogoutButton } = await import('@/app/(dashboard)/settings/_components/LogoutButton')
const { DeleteAccountButton } = await import('@/app/(dashboard)/settings/_components/DeleteAccountButton')
const { OfflineBrowsingToggle } = await import('@/app/(dashboard)/settings/_components/OfflineBrowsingToggle')
const { OfflineLifecycle } = await import('@/app/(dashboard)/_components/OfflineLifecycle')
const { OfflineSignInSweep } = await import('@/app/[locale]/sign-in/OfflineSignInSweep')

const PREF = pref.OFFLINE_PREF_KEY
const OWNER = pref.OFFLINE_OWNER_KEY
const MARKER = 'offline-consent-v1'
const PRECACHE = 'serwist-precache-v2-http://localhost/'

let env: OfflineEnv
let replace: ReturnType<typeof vi.fn>
let reload: ReturnType<typeof vi.fn>

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

async function ownerHash(id = h.session!.user.id) {
  return lc.sha256Hex(id)
}

/** Opted-in device: pref on, owner bound, marker, full worker, caches, records. */
async function seedOptedIn(opts: { owner?: string | null } = {}) {
  localStorage.setItem(PREF, 'true')
  const owner = opts.owner === undefined ? await ownerHash() : opts.owner
  if (owner) localStorage.setItem(OWNER, owner)
  env.caches.seed(MARKER, ['/__offline-consent'])
  env.caches.seed('dynamic-v1', ['http://localhost/dashboard'])
  env.caches.seed('static-v1', ['http://localhost/icons/a.png'])
  env.caches.seed(PRECACHE, ['http://localhost/offline'])
  env.idb.seedExpiration([{ url: 'http://localhost/dashboard?month=2026-10' }])
  env.sw.seedActive('/sw.js')
  env.ops.length = 0
}

/**
 * Fake only the timers: `crypto.subtle.digest` resolves on a real macrotask, so
 * wait for it with setImmediate (not faked) before jumping fake time.
 */
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

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  swc.resetOfflineQueueForTests()
  h.session = { user: { id: '11111111-2222-3333-4444-555555555555' } }
  h.getSession = null
  h.signOut = null
  h.requestAccountDeletion = null
  env = installOfflineEnv()
  h.ops = env.ops
  replace = vi.fn(() => { env.ops.push('navigate') })
  reload = vi.fn(() => { env.ops.push('reload') })
  vi.stubGlobal('location', { ...window.location, href: 'http://localhost/settings', replace, reload })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  uninstallOfflineEnv()
})

// ─── Unit 1: the full off ───────────────────────────────────────────────────

describe('unit 1 — turnOfflineBrowsingOff', () => {
  it('runs marker → pref/owner → unregister → broadcast → caches → IndexedDB, and leaves nothing', async () => {
    await seedOptedIn()
    await swc.turnOfflineBrowsingOff({ reason: 'user' })
    const o = env.ops
    const iEpoch = indexOfOp(o, /^ls\.set:offline-off-epoch=/)
    const iMarker = indexOfOp(o, `caches.delete:${MARKER}`)
    const iPref = indexOfOp(o, `ls.remove:${PREF}`)
    const iOwner = indexOfOp(o, `ls.remove:${OWNER}`)
    const iUnreg = indexOfOp(o, 'unregister:/sw.js')
    const iCast = indexOfOp(o, 'broadcast:offline-off')
    const iDyn = indexOfOp(o, 'caches.delete:dynamic-v1')
    const iClear = indexOfOp(o, /^idb\.clear:serwist-expiration\//)
    const iDel = indexOfOp(o, 'idb.deleteDatabase:serwist-expiration')
    expect(iEpoch).toBeGreaterThanOrEqual(0)
    expect(iEpoch).toBeLessThan(iMarker)
    // The marker goes before anything that touches data.
    expect(o.slice(0, iMarker).every((x) => x.startsWith('ls.set:offline-off-epoch'))).toBe(true)
    expect(iMarker).toBeLessThan(iPref)
    expect(iPref).toBeLessThan(iUnreg)
    expect(iOwner).toBeLessThan(iUnreg)
    expect(iUnreg).toBeLessThan(iCast)
    expect(iCast).toBeLessThan(iDyn)
    expect(iDyn).toBeLessThan(iClear)
    expect(iClear).toBeLessThan(iDel)

    expect(cacheNames()).toEqual([])
    expect(env.idb.records()).toEqual([])
    expect(env.sw.regs).toEqual([])
    expect(localStorage.getItem(PREF)).toBeNull()
    expect(localStorage.getItem(OWNER)).toBeNull()
  })

  it('a blocked IndexedDB delete resolves the caller within the timeout', async () => {
    await seedOptedIn()
    useTimers()
    env.idb.blockDelete = true
    let done = false
    void swc.turnOfflineBrowsingOff({ reason: 'user' }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(swc.IDB_STEP_TIMEOUT_MS + 100)
    expect(done).toBe(true)
    // Records were still cleared before the (blocked) delete.
    expect(env.idb.records()).toEqual([])
  })

  it('a throwing step does not stop the later steps', async () => {
    await seedOptedIn()
    env.sw.regs[0].unregister = async () => { throw new Error('boom') }
    const realDelete = env.caches.delete.bind(env.caches)
    env.caches.delete = async (name: string) => {
      if (name === 'static-v1') throw new Error('quota')
      return realDelete(name)
    }
    await expect(swc.turnOfflineBrowsingOff({ reason: 'user' })).resolves.toBeUndefined()
    expect(env.caches.stores.has('dynamic-v1')).toBe(false)
    expect(env.caches.stores.has(PRECACHE)).toBe(false)
    expect(env.idb.records()).toEqual([])
    expect(localStorage.getItem(PREF)).toBeNull()
  })

  it('clearDynamicCache and hasActiveSW are gone: no caller can do a partial clear', () => {
    expect((swc as Record<string, unknown>).clearDynamicCache).toBeUndefined()
    expect((swc as Record<string, unknown>).hasActiveSW).toBeUndefined()
  })
})

// ─── Unit 2: logout and account deletion ────────────────────────────────────

async function clickLogout() {
  render(<LogoutButton />)
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
  fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
}
async function clickDelete() {
  render(<DeleteAccountButton />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
}

function assertOffOrder(action: string) {
  const o = env.ops
  const iMarker = indexOfOp(o, `caches.delete:${MARKER}`)
  const iPref = indexOfOp(o, `ls.remove:${PREF}`)
  const iUnreg = indexOfOp(o, 'unregister:/sw.js')
  const iAction = indexOfOp(o, action)
  const iDyn = indexOfOp(o, 'caches.delete:dynamic-v1')
  const iIdb = indexOfOp(o, /^idb\.clear:/)
  const iNav = indexOfOp(o, 'navigate')
  expect(iMarker).toBeGreaterThanOrEqual(0)
  expect(iMarker).toBeLessThan(iPref)
  expect(iPref).toBeLessThan(iUnreg)
  expect(iUnreg).toBeLessThan(iAction)
  expect(iAction).toBeLessThan(iDyn)
  expect(iDyn).toBeLessThan(iIdb)
  expect(iIdb).toBeLessThan(iNav)
  expect(cacheNames()).toEqual([])
  expect(env.idb.records()).toEqual([])
  expect(env.sw.regs).toEqual([])
}

describe('unit 2 — logout and account deletion', () => {
  it('logout: marker < pref/unregister < signOut < caches/IDB < navigate', async () => {
    await seedOptedIn()
    await clickLogout()
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    assertOffOrder('signOut')
  })

  it('logout: a failed signOut still clears and navigates', async () => {
    await seedOptedIn()
    h.signOut = async () => { throw new Error('NEXT_REDIRECT') }
    await clickLogout()
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    assertOffOrder('signOut')
  })

  it('account deletion: same order', async () => {
    await seedOptedIn()
    await clickDelete()
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    assertOffOrder('requestAccountDeletion')
  })

  it.each([
    ['{ok:false}', async () => ({ ok: false, code: 'x' })],
    ['a throw', async () => { throw new Error('net') }],
  ])('account deletion that fails (%s) still clears and navigates', async (_label, impl) => {
    await seedOptedIn()
    h.requestAccountDeletion = impl
    await clickDelete()
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    assertOffOrder('requestAccountDeletion')
  })

  it('logout started during a pending pref-on wait does not wait for it', async () => {
    await seedOptedIn()
    env.sw.regs = [] // the mount will register and wait (never activates)
    const mount = swc.enqueueOfflineSequence((seq) => lc.runPrefOnMount(seq))
    await flush()
    expect(env.ops).toContain('register:/sw.js')
    await clickLogout()
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    // The mount is still waiting on /sw.js; logout did not queue behind it.
    let mountDone = false
    void mount.then(() => { mountDone = true })
    await flush()
    expect(mountDone).toBe(false)
    expect(localStorage.getItem(PREF)).toBeNull()
    expect(env.caches.stores.has(MARKER)).toBe(false)
  })

  describe('off epoch (rev 5)', () => {
    async function onPendingThenOff(off: 'logout' | 'delete') {
      // Pref off; the user taps ON; /sw.js is installing (pending wait).
      const gate = deferred()
      const action = off === 'logout' ? 'signOut' : 'requestAccountDeletion'
      if (off === 'logout') h.signOut = () => gate.promise
      else h.requestAccountDeletion = async () => { await gate.promise; return { ok: true } }
      const on = swc.enqueueOfflineSequence((seq) => lc.runTurnOn(seq))
      await flush()
      const reg = env.sw.regs.find((r) => r.path === '/sw.js') as FakeRegistration
      expect(reg).toBeDefined()
      if (off === 'logout') await clickLogout()
      else await clickDelete()
      // After logout step 1 (unregister), before the action resolves: activate.
      await waitFor(() => expect(env.ops).toContain(action))
      expect(env.ops).toContain('unregister:/sw.js')
      act(() => reg.activate())
      await flush()
      gate.resolve()
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
      await on
      await flush()
      expect(localStorage.getItem(PREF)).not.toBe('true')
      expect(localStorage.getItem(OWNER)).toBeNull()
      expect(env.caches.stores.has(MARKER)).toBe(false)
    }

    it('logout during a pending ON leaves the pref off, no owner, no marker', async () => {
      await onPendingThenOff('logout')
    })

    it('account deletion during a pending ON: same', async () => {
      await onPendingThenOff('delete')
    })

    it('logout during a pending pref-on mount leaves no marker (logout lands before the binding check)', async () => {
      await seedOptedIn()
      env.caches.stores.delete(MARKER)
      const session = deferred<unknown>()
      h.getSession = () => session.promise
      const mount = swc.enqueueOfflineSequence((seq) => lc.runPrefOnMount(seq))
      await flush()
      await clickLogout()
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
      session.resolve({ data: { session: h.session } })
      await mount
      await flush()
      expect(env.caches.stores.has(MARKER)).toBe(false)
      expect(localStorage.getItem(PREF)).toBeNull()
      expect(env.ops).not.toContain(`caches.open:${MARKER}`)
    })

    it('logout during a pending pref-on mount (marker already re-created) leaves no marker', async () => {
      await seedOptedIn()
      env.sw.regs = []
      const mount = swc.enqueueOfflineSequence((seq) => lc.runPrefOnMount(seq))
      await flush()
      expect(env.caches.stores.has(MARKER)).toBe(true)
      const reg = env.sw.regs.find((r) => r.path === '/sw.js') as FakeRegistration
      expect(reg).toBeDefined()
      await clickLogout()
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
      // The mount is still waiting on /sw.js; when it activates late it must
      // not bring the marker back.
      act(() => reg.activate())
      await mount
      await flush()
      expect(env.caches.stores.has(MARKER)).toBe(false)
      expect(localStorage.getItem(PREF)).toBeNull()
    })

    it('two tabs: an epoch bump in tab A blocks the writes of tab B’s pending ON', async () => {
      const on = swc.enqueueOfflineSequence((seq) => lc.runTurnOn(seq))
      await flush()
      const reg = env.sw.regs.find((r) => r.path === '/sw.js') as FakeRegistration
      // Tab A (shares localStorage) runs an off path: epoch first.
      pref.bumpOffEpoch()
      reg.activate()
      await expect(on).resolves.toBe('cancelled')
      expect(localStorage.getItem(PREF)).not.toBe('true')
      expect(localStorage.getItem(OWNER)).toBeNull()
      expect(env.caches.stores.has(MARKER)).toBe(false)
    })
  })
})

// ─── Unit 4: pref-off mount sweep ───────────────────────────────────────────

describe('unit 4 — pref-off mount sweep', () => {
  it('deletes the marker first, removes the full SW, caches and records; keeps the basic worker and offline-basic-*', async () => {
    env.caches.seed(MARKER, ['/__offline-consent'])
    env.caches.seed('dynamic-v1')
    env.caches.seed('static-v1')
    env.caches.seed(PRECACHE)
    env.caches.seed('offline-basic-abc123', ['/offline-basic.html'])
    env.idb.seedExpiration([{ url: 'http://localhost/records?q=x' }])
    env.sw.seedActive('/sw.js')
    env.sw.seedActive('/sw-basic.js')
    env.ops.length = 0

    render(<OfflineLifecycle />)
    await waitFor(() => expect(env.ops).toContain('idb.deleteDatabase:serwist-expiration'))

    const o = env.ops
    expect(o[0]).toBe(`caches.delete:${MARKER}`)
    expect(o).toContain('unregister:/sw.js')
    expect(o).not.toContain('unregister:/sw-basic.js')
    expect(o).not.toContain('caches.delete:offline-basic-abc123')
    expect(cacheNames()).toEqual(['offline-basic-abc123'])
    expect(env.sw.regs.map((r) => r.path)).toEqual(['/sw-basic.js'])
    expect(env.idb.records()).toEqual([])
    // No pref change, no broadcast.
    expect(o.filter((x) => x.startsWith('ls.'))).toEqual([])
    expect(o).not.toContain('broadcast:offline-off')
  })
})

// ─── Unit 5: user binding ───────────────────────────────────────────────────

describe('unit 5 — user binding', () => {
  it('owner mismatch → full off, then reload', async () => {
    await seedOptedIn({ owner: await lc.sha256Hex('someone-else') })
    const r = await swc.enqueueOfflineSequence((seq) => lc.runPrefOnMount(seq))
    expect(r).toBe('user-changed')
    expect(cacheNames()).toEqual([])
    expect(env.idb.records()).toEqual([])
    expect(env.sw.regs).toEqual([])
    expect(localStorage.getItem(PREF)).toBeNull()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('no stored owner (opted in before #1673) → one clear, bind, pref stays on, marker after the bind', async () => {
    await seedOptedIn({ owner: null })
    env.caches.stores.delete(MARKER)
    env.sw.autoActivate = true
    const r = await swc.enqueueOfflineSequence((seq) => lc.runPrefOnMount(seq))
    expect(r).toBe('bound')
    expect(env.caches.stores.has('dynamic-v1')).toBe(false)
    expect(env.caches.stores.has('static-v1')).toBe(false)
    expect(env.caches.stores.has(PRECACHE)).toBe(true)
    expect(env.idb.records()).toEqual([])
    expect(localStorage.getItem(PREF)).toBe('true')
    const stored = localStorage.getItem(OWNER)!
    expect(stored).toMatch(/^[0-9a-f]{64}$/)
    expect(stored).not.toContain(h.session!.user.id)
    expect(stored).toBe(await ownerHash())
    expect(indexOfOp(env.ops, `ls.set:${OWNER}=${stored}`)).toBeLessThan(indexOfOp(env.ops, `caches.open:${MARKER}`))
  })

  it('no session (offline, expired token) → does nothing, leaves the marker as it is', async () => {
    await seedOptedIn()
    h.session = null
    const r = await swc.enqueueOfflineSequence((seq) => lc.runPrefOnMount(seq))
    expect(r).toBe('no-session')
    expect(env.ops).toEqual([])
    expect(env.caches.stores.has(MARKER)).toBe(true)
  })

  it('owner matches → marker re-created, then /sw.js registered', async () => {
    await seedOptedIn()
    env.caches.stores.delete(MARKER)
    env.sw.autoActivate = true
    const r = await swc.enqueueOfflineSequence((seq) => lc.runPrefOnMount(seq))
    expect(r).toBe('registered')
    expect(indexOfOp(env.ops, `caches.open:${MARKER}`)).toBeLessThan(indexOfOp(env.ops, 'register:/sw.js'))
    expect(env.caches.stores.has(MARKER)).toBe(true)
  })
})

// ─── Unit 6: sign-in sweep ──────────────────────────────────────────────────

describe('unit 6 — sign-in sweep', () => {
  it('deletes the marker first, then dynamic-v1 and the records, and nothing else', async () => {
    await seedOptedIn()
    render(<OfflineSignInSweep />)
    await waitFor(() => expect(env.ops).toContain('idb.deleteDatabase:serwist-expiration'))
    expect(env.ops[0]).toBe(`caches.delete:${MARKER}`)
    expect(env.ops[1]).toBe('caches.delete:dynamic-v1')
    expect(cacheNames()).toEqual([PRECACHE, 'static-v1'].sort())
    expect(env.idb.records()).toEqual([])
    expect(env.sw.regs.map((r) => r.path)).toEqual(['/sw.js'])
    expect(localStorage.getItem(PREF)).toBe('true')
    expect(env.ops.filter((x) => x.startsWith('ls.') || x.startsWith('unregister'))).toEqual([])
  })
})

// ─── Unit 7: calibration and errors ─────────────────────────────────────────

function toggleSwitch() { return screen.getByRole('switch') }

describe('unit 7 — calibration never writes true', () => {
  it('pref off with an active /sw.js → stays off and the off path runs', async () => {
    env.sw.seedActive('/sw.js')
    env.caches.seed('dynamic-v1')
    env.ops.length = 0
    render(<OfflineBrowsingToggle />)
    await waitFor(() => expect(env.ops).toContain('unregister:/sw.js'))
    await flush()
    expect(toggleSwitch()).toHaveAttribute('aria-checked', 'false')
    expect(localStorage.getItem(PREF)).toBeNull()
    expect(env.ops.filter((x) => x.startsWith(`ls.set:${PREF}`))).toEqual([])
  })

  it('error path (no session to bind) → never true, error shown', async () => {
    h.session = null
    render(<OfflineBrowsingToggle />)
    await flush()
    fireEvent.click(toggleSwitch())
    await waitFor(() => expect(screen.getByText('toggle-error')).toBeInTheDocument())
    expect(env.ops.filter((x) => x.startsWith(`ls.set:${PREF}`))).toEqual([])
    expect(toggleSwitch()).toHaveAttribute('aria-checked', 'false')
  })

  it('an ON timeout → full off + error text', async () => {
    useTimers()
    env.caches.seed('static-v1')
    render(<OfflineBrowsingToggle />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    fireEvent.click(toggleSwitch())
    await act(async () => { await until(() => env.ops.includes('register:/sw.js')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(swc.SW_ACTIVATION_TIMEOUT_MS + 3_000) })
    await act(async () => { await until(() => screen.queryByText('toggle-error') !== null) })
    expect(env.ops).toContain('unregister:/sw.js')
    expect(cacheNames()).toEqual([])
    expect(localStorage.getItem(PREF)).toBeNull()
    expect(env.ops.filter((x) => x.startsWith(`ls.set:${PREF}`))).toEqual([])
  })
})

describe('unit 7b — registerSW waits for an activated /sw.js', () => {
  it('another script already active at scope / does not count; ON ends on once /sw.js activates', async () => {
    const reg = env.sw.seedActive('/sw-basic.js')
    // Same scope → same registration: /sw.js installs into it.
    env.sw.register = async (url: string) => {
      env.ops.push(`register:${url}`)
      reg.installing = new (reg.active!.constructor as new (u: string, s: string) => NonNullable<FakeRegistration['active']>)(`http://localhost${url}`, 'installing')
      return reg
    }
    let resolved = false
    const on = swc.enqueueOfflineSequence((seq) => lc.runTurnOn(seq)).then((r) => { resolved = true; return r })
    await flush()
    // `ready` would already resolve (basic is active) — registerSW must not.
    await expect(navigator.serviceWorker.ready).resolves.toBe(reg)
    expect(resolved).toBe(false)
    expect(localStorage.getItem(PREF)).toBeNull()
    act(() => {
      reg.installing = null
      reg.activate('/sw.js')
    })
    await expect(on).resolves.toBe('on')
    expect(localStorage.getItem(PREF)).toBe('true')
    expect(localStorage.getItem(OWNER)).toBe(await ownerHash())
    expect(env.caches.stores.has(MARKER)).toBe(true)
    expect(env.ops).not.toContain('broadcast:offline-off')
    // Order: pref, owner, marker — all after activation.
    expect(indexOfOp(env.ops, `ls.set:${PREF}=true`)).toBeLessThan(indexOfOp(env.ops, `ls.set:${OWNER}=`.concat(await ownerHash())))
    expect(indexOfOp(env.ops, `ls.set:${OWNER}=`.concat(await ownerHash()))).toBeLessThan(indexOfOp(env.ops, `caches.open:${MARKER}`))
  })

  it('no /sw.js within 15 s → full off + error', async () => {
    useTimers()
    const on = swc.enqueueOfflineSequence((seq) => lc.runTurnOn(seq))
    await until(() => env.ops.includes('register:/sw.js'))
    await vi.advanceTimersByTimeAsync(swc.SW_ACTIVATION_TIMEOUT_MS + 3_000)
    await expect(on).resolves.toBe('error')
    expect(env.ops).toContain('unregister:/sw.js')
    expect(env.ops).toContain('broadcast:offline-off')
    expect(localStorage.getItem(PREF)).toBeNull()
  })

  it('pref-on mount timeout → no pref write and no full off', async () => {
    await seedOptedIn()
    useTimers()
    env.sw.regs = []
    const mount = swc.enqueueOfflineSequence((seq) => lc.runPrefOnMount(seq))
    await until(() => env.ops.includes('register:/sw.js'))
    await vi.advanceTimersByTimeAsync(swc.SW_ACTIVATION_TIMEOUT_MS + 1_000)
    await expect(mount).resolves.toBe('register-failed')
    expect(env.ops.filter((x) => x.startsWith(`ls.`) && x.includes(PREF))).toEqual([])
    expect(env.ops).not.toContain('broadcast:offline-off')
    expect(env.ops.filter((x) => x.startsWith('unregister'))).toEqual([])
    expect(localStorage.getItem(PREF)).toBe('true')
  })
})

describe('unit 7c — queue and re-read', () => {
  it('pref turns on during a pref-off mount sweep → no unregister of the new /sw.js, no further cache delete, no full off', async () => {
    env.caches.seed(MARKER)
    env.caches.seed('dynamic-v1')
    env.idb.seedExpiration([{ url: 'http://localhost/dashboard' }])
    const realDelete = env.caches.delete.bind(env.caches)
    env.caches.delete = async (name: string) => {
      const r = await realDelete(name)
      if (name === MARKER) {
        // The user turned it on (another tab / newer action): pref on, new /sw.js.
        localStorage.setItem(PREF, 'true')
        env.sw.seedActive('/sw.js')
      }
      return r
    }
    env.ops.length = 0
    await swc.enqueueOfflineSequence((seq) => lc.runPrefOffMount(seq))
    const afterChange = env.ops.slice(indexOfOp(env.ops, `ls.set:${PREF}=true`) + 1)
    expect(afterChange.filter((x) => x.startsWith('unregister'))).toEqual([])
    expect(afterChange.filter((x) => x.startsWith('caches.delete'))).toEqual([])
    expect(afterChange).not.toContain('broadcast:offline-off')
    expect(env.sw.regs.map((r) => r.path)).toEqual(['/sw.js'])
    expect(localStorage.getItem(PREF)).toBe('true')
  })

  it('pref turns off during a pref-on mount → no register(/sw.js) after the change', async () => {
    await seedOptedIn()
    env.sw.regs = []
    h.getSession = async () => {
      localStorage.removeItem(PREF)
      return { data: { session: h.session } }
    }
    const r = await swc.enqueueOfflineSequence((seq) => lc.runPrefOnMount(seq))
    expect(r).toBe('aborted')
    expect(env.ops).not.toContain('register:/sw.js')
  })

  it('sequences run one at a time in the tab queue', async () => {
    const order: string[] = []
    const gate = deferred()
    const a = swc.enqueueOfflineSequence(async () => { order.push('a-start'); await gate.promise; order.push('a-end') })
    const b = swc.enqueueOfflineSequence(async () => { order.push('b') })
    await flush()
    expect(order).toEqual(['a-start'])
    gate.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a-start', 'a-end', 'b'])
  })
})

describe('unit 7d — self-writes never abort', () => {
  function assertAllGone() {
    expect(env.sw.regs).toEqual([])
    expect(cacheNames()).toEqual([])
    expect(env.idb.records()).toEqual([])
  }

  it('the user OFF handler, through the queue, with the pref starting on', async () => {
    await seedOptedIn()
    await swc.enqueueOfflineSequence((seq) => lc.runTurnOff(seq))
    assertAllGone()
    expect(localStorage.getItem(PREF)).toBeNull()
  })

  it('logout, with the pref starting on', async () => {
    await seedOptedIn()
    await clickLogout()
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    assertAllGone()
  })

  it('account deletion, with the pref starting on', async () => {
    await seedOptedIn()
    await clickDelete()
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    assertAllGone()
  })

  it('the user-changed path, with the pref starting on', async () => {
    await seedOptedIn({ owner: await lc.sha256Hex('previous-user') })
    await swc.enqueueOfflineSequence((seq) => lc.runPrefOnMount(seq))
    assertAllGone()
  })
})
