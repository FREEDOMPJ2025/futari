'use client'

// Service Worker 的 opt-in 模型（為什麼不預設開啟）見
// docs/superpowers/specs/offline-browsing-design.md。
//
// Client-only helpers for the opt-in full worker (`/sw.js`) and for wiping the
// ledger data it leaves on the device (#1673). Every helper is a no-op where
// `navigator.serviceWorker` / `caches` / `indexedDB` don't exist (SSR, private
// mode, older browsers), and every off-path step is best-effort: it logs and
// carries on, it never throws to the caller.
//
// Whether offline browsing is ON is the preference (lib/offline/preference.ts),
// never "is there any SW" and never the worker's scriptURL.

import {
  OFFLINE_PREF_KEY,
  bumpOffEpoch,
  getOfflinePref,
  setOfflineOwner,
  setOfflinePref,
} from './preference'
import {
  CONSENT_CACHE,
  CONSENT_KEY,
  DYNAMIC_CACHE,
  EXPIRATION_DB,
} from './swGate'

export const FULL_SW_PATH = '/sw.js'
/** #1674's basic worker. S1 never registers it; the mount sweep keeps it. */
export const BASIC_SW_PATH = '/sw-basic.js'
export const BASIC_CACHE_PREFIX = 'offline-basic-'
export const OFFLINE_CHANNEL = 'futari-offline'
export const OFFLINE_OFF_MESSAGE = 'offline-off'
export const SW_ACTIVATION_TIMEOUT_MS = 15_000
export const IDB_STEP_TIMEOUT_MS = 2_000
export const RELOAD_GUARD_KEY = 'offline-off-reload-at'
export const RELOAD_GUARD_MS = 10_000
export const NO_CHANNEL_RECHECK_MS = 1_000

export function isSWSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
}

function hasCaches(): boolean {
  return typeof caches !== 'undefined'
}

function log(step: string, err?: unknown): void {
  console.warn(`[offline] ${step}`, err ?? '')
}

/** Run one best-effort step: errors are logged, never rethrown. */
async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    log(`${name} failed`, err)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      () => { clearTimeout(timer); resolve('timeout') },
    )
  })
}

export function scriptPath(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    return new URL(url, typeof location === 'undefined' ? 'http://x' : location.href).pathname
  } catch {
    return null
  }
}

function registrationPath(reg: ServiceWorkerRegistration): string | null {
  const w = reg.active ?? reg.waiting ?? reg.installing
  return scriptPath(w?.scriptURL)
}

async function getRegistrations(): Promise<readonly ServiceWorkerRegistration[]> {
  if (!isSWSupported()) return []
  return navigator.serviceWorker.getRegistrations()
}

// ─── Per-tab sequence queue (#1673 S1.7, M3) ────────────────────────────────
//
// Every lifecycle sequence (pref-on mount, pref-off mount sweep, ON handler,
// OFF handler, reload-rule handling) runs through ONE promise chain per tab.
// Each keeps an EXPECTED pref value: the value read when it starts, updated by
// its own `setPref` calls. Before every register, unregister, cache delete and
// full off it re-reads the pref and stops only when the pref differs from what
// it expects — i.e. someone else changed it (another tab, or a newer action in
// this tab). Its own writes never stop it.

export interface OfflineSequence {
  /** The pref value this sequence expects to see. */
  expected: boolean
  /** True while the stored pref still equals `expected`. */
  ok(): boolean
  /** Write the pref AND move `expected` with it. */
  setPref(enabled: boolean): void
}

export function createSequence(): OfflineSequence {
  const seq: OfflineSequence = {
    expected: getOfflinePref(),
    ok: () => getOfflinePref() === seq.expected,
    setPref: (enabled) => {
      setOfflinePref(enabled)
      seq.expected = enabled
    },
  }
  return seq
}

let queueTail: Promise<unknown> = Promise.resolve()

export function enqueueOfflineSequence<T>(
  fn: (seq: OfflineSequence) => Promise<T>,
): Promise<T> {
  const run = queueTail.then(() => fn(createSequence()))
  queueTail = run.catch((err) => log('sequence failed', err))
  return run
}

/** Test hook: start every test with an empty queue. */
export function resetOfflineQueueForTests(): void {
  queueTail = Promise.resolve()
}

// ─── Consent marker (the SW write gate's switch) ────────────────────────────

export async function deleteConsentMarker(): Promise<void> {
  if (!hasCaches()) return
  await step('delete consent marker', () => caches.delete(CONSENT_CACHE))
}

export async function createConsentMarker(): Promise<void> {
  if (!hasCaches()) return
  await step('create consent marker', async () => {
    const cache = await caches.open(CONSENT_CACHE)
    await cache.put(CONSENT_KEY, new Response('1', { headers: { 'content-type': 'text/plain' } }))
  })
}

// ─── Storage clears ─────────────────────────────────────────────────────────

/** Clear every object store of an EXISTING `serwist-expiration`; never create it. */
function clearExpirationStores(): Promise<void> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(EXPIRATION_DB)
    } catch {
      resolve()
      return
    }
    // No such database: abort the version change so opening it doesn't create
    // an empty v1 (which would break Serwist's own upgrade later).
    req.onupgradeneeded = () => {
      try { req.transaction?.abort() } catch { /* already aborting */ }
    }
    req.onerror = (e) => {
      e.preventDefault?.()
      resolve()
    }
    req.onblocked = () => resolve()
    req.onsuccess = () => {
      const db = req.result
      const done = () => {
        try { db.close() } catch { /* ignore */ }
        resolve()
      }
      try {
        const names = Array.from(db.objectStoreNames)
        if (names.length === 0) {
          done()
          return
        }
        const tx = db.transaction(names, 'readwrite')
        for (const n of names) tx.objectStore(n).clear()
        tx.oncomplete = done
        tx.onerror = done
        tx.onabort = done
      } catch {
        done()
      }
    }
  })
}

function deleteExpirationDb(): Promise<void> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.deleteDatabase(EXPIRATION_DB)
    } catch {
      resolve()
      return
    }
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    // `blocked`: a live worker still holds a connection. Don't resolve here —
    // the caller's timeout does; the delete stays queued and completes once
    // that connection closes, and the next mount retries anyway.
  })
}

async function expirationDbMayExist(): Promise<boolean> {
  const idb = indexedDB as IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> }
  if (typeof idb.databases !== 'function') return true
  try {
    const list = await idb.databases()
    return list.some((d) => d.name === EXPIRATION_DB)
  } catch {
    return true
  }
}

/**
 * Remove the `serwist-expiration` URL records (#1673 F2): clear every store,
 * close, then `deleteDatabase`. Each half is raced with a timeout so a
 * `blocked` delete (a live worker holding the database open) never hangs the
 * caller.
 */
export async function clearExpirationRecords(timeoutMs = IDB_STEP_TIMEOUT_MS): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  if (!(await expirationDbMayExist())) return
  if ((await withTimeout(clearExpirationStores(), timeoutMs)) === 'timeout') {
    log('clear serwist-expiration stores timed out')
  }
  if ((await withTimeout(deleteExpirationDb(), timeoutMs)) === 'timeout') {
    log('delete serwist-expiration blocked; next mount retries')
  }
}

async function deleteCaches(filter: (name: string) => boolean): Promise<void> {
  if (!hasCaches()) return
  let names: string[] = []
  try {
    names = await caches.keys()
  } catch (err) {
    log('caches.keys failed', err)
    return
  }
  for (const n of names) {
    if (!filter(n)) continue
    await step(`delete cache ${n}`, () => caches.delete(n))
  }
}

async function unregisterWhere(filter: (reg: ServiceWorkerRegistration) => boolean): Promise<void> {
  let regs: readonly ServiceWorkerRegistration[] = []
  try {
    regs = await getRegistrations()
  } catch (err) {
    log('getRegistrations failed', err)
    return
  }
  for (const r of regs) {
    if (!filter(r)) continue
    await step('unregister', () => r.unregister())
  }
}

function postOffBroadcast(): void {
  if (typeof BroadcastChannel === 'undefined') return
  try {
    const ch = new BroadcastChannel(OFFLINE_CHANNEL)
    ch.postMessage({ type: OFFLINE_OFF_MESSAGE })
    ch.close()
  } catch (err) {
    log('broadcast failed', err)
  }
}

// ─── Full off (#1673 S1.1) ──────────────────────────────────────────────────

export type OffReason = 'user' | 'logout' | 'account-deletion' | 'user-changed' | 'on-failed'

interface OffOptions {
  reason: OffReason
  /** The sequence this runs in; logout / deletion pass a fresh one (preempt). */
  seq?: OfflineSequence
}

/**
 * Steps 0–2 of the full off. Returns false when the sequence was stopped by an
 * outside pref change before it finished.
 *   (epoch) bump `offline-off-epoch` so any pending ON / pref-on mount skips
 *           its writes;
 *   0. delete the consent marker — every live full worker stops writing;
 *   1. pref off + forget the owner;
 *   2. unregister every registration.
 */
export async function beginOfflineOff({ reason, seq = createSequence() }: OffOptions): Promise<boolean> {
  if (!seq.ok()) {
    log(`off (${reason}) skipped: pref changed elsewhere`)
    return false
  }
  bumpOffEpoch()
  await deleteConsentMarker()
  seq.setPref(false)
  setOfflineOwner(null)
  if (!seq.ok()) return false
  await unregisterWhere(() => true)
  return true
}

/**
 * Steps 3–5 of the full off:
 *   3. broadcast `offline-off` (the `storage` event on the pref is the 2nd signal);
 *   4. delete every Cache Storage key;
 *   5. clear and delete the `serwist-expiration` database.
 */
export async function finishOfflineOff({ seq = createSequence() }: { seq?: OfflineSequence } = {}): Promise<void> {
  postOffBroadcast()
  if (!seq.ok()) return
  await deleteCaches(() => true)
  if (!seq.ok()) return
  await clearExpirationRecords()
}

/**
 * The one full off: explicit turn-off, logout, account deletion, a user change
 * and a failed ON all end here. Never throws.
 */
export async function turnOfflineBrowsingOff(opts: OffOptions): Promise<void> {
  const seq = opts.seq ?? createSequence()
  if (await beginOfflineOff({ ...opts, seq })) {
    await finishOfflineOff({ seq })
  }
}

/**
 * Pref-off mount sweep (#1673 S1.4): narrower than the full off — it keeps
 * #1674's basic worker and its `offline-basic-*` cache, does not broadcast and
 * does not touch the pref. In S1 no basic worker exists, so it removes all.
 */
export async function sweepOfflineLedgerData(seq: OfflineSequence = createSequence()): Promise<void> {
  if (!seq.ok()) return
  await deleteConsentMarker()
  if (!seq.ok()) return
  await unregisterWhere((r) => registrationPath(r) !== BASIC_SW_PATH)
  if (!seq.ok()) return
  await deleteCaches((n) => !n.startsWith(BASIC_CACHE_PREFIX))
  if (!seq.ok()) return
  await clearExpirationRecords()
}

/**
 * Sign-in sweep (#1673 S1.6): whoever reaches sign-in leaves no ledger pages
 * for the next person. Marker first, then `dynamic-v1` and the expiration
 * records. Keeps the precache, the worker and the pref — the binding check
 * after sign-in decides, and only it re-creates the marker.
 */
export async function signInSweep(): Promise<void> {
  if (!hasCaches()) return
  await deleteConsentMarker()
  await step('delete dynamic cache', () => caches.delete(DYNAMIC_CACHE))
  await clearExpirationRecords()
}

/** Delete just these caches (pre-release owner bind). */
export async function deleteNamedCaches(names: readonly string[]): Promise<void> {
  await deleteCaches((n) => names.includes(n))
}

// ─── Registration (#1673 S1.7, rev 2) ───────────────────────────────────────

function fullSWActivated(reg: ServiceWorkerRegistration): boolean {
  const a = reg.active
  return !!a && scriptPath(a.scriptURL) === FULL_SW_PATH && a.state === 'activated'
}

/**
 * Resolve once the registration's ACTIVE worker is `/sw.js` in state
 * `activated`. `navigator.serviceWorker.ready` is not enough: it resolves as
 * soon as ANY worker is active at scope `/` (e.g. #1674's basic worker).
 */
export function waitForFullSWActivated(
  reg: ServiceWorkerRegistration,
  timeoutMs = SW_ACTIVATION_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (fullSWActivated(reg)) {
      resolve()
      return
    }
    const watched = new Set<ServiceWorker>()
    let settled = false
    const cleanup = () => {
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      reg.removeEventListener?.('updatefound', check)
      for (const w of watched) w.removeEventListener?.('statechange', check)
    }
    const watch = () => {
      for (const w of [reg.installing, reg.waiting, reg.active]) {
        if (w && !watched.has(w)) {
          watched.add(w)
          w.addEventListener?.('statechange', check)
        }
      }
    }
    function check() {
      if (settled) return
      watch()
      if (fullSWActivated(reg)) {
        cleanup()
        resolve()
      }
    }
    const timer = setTimeout(() => {
      if (settled) return
      cleanup()
      reject(new Error('sw-activation-timeout'))
    }, timeoutMs)
    // statechange is the signal; the poll only covers a missed event.
    const poll = setInterval(check, 250)
    reg.addEventListener?.('updatefound', check)
    watch()
  })
}

export async function registerSW(timeoutMs = SW_ACTIVATION_TIMEOUT_MS): Promise<ServiceWorkerRegistration | null> {
  if (!isSWSupported()) return null
  const reg = await navigator.serviceWorker.register(FULL_SW_PATH, { scope: '/' })
  await waitForFullSWActivated(reg, timeoutMs)
  return reg
}

export async function hasFullSWRegistration(): Promise<boolean> {
  try {
    return (await getRegistrations()).some((r) => registrationPath(r) === FULL_SW_PATH)
  } catch {
    return false
  }
}

// ─── Reload rule (#1673 S1.3) ───────────────────────────────────────────────
//
// A tab still controlled by the full worker after offline browsing went off
// reloads once, which releases control. Privacy does not depend on when that
// happens — the write gate already stopped every write — the reload only ends
// the worker's control. While a `/sw.js` registration still exists, a reload
// would come back controlled, so the tab skips the signal WITHOUT spending its
// loop guard; the broadcast sent after the unregister triggers it again.


export type OffReloadDecision = 'reload' | 'wait' | 'none'

/**
 * What the reload rule reads and does, so the rule can be driven for two
 * simulated contexts in one test. `browserOffReloadEnv` is the real one.
 */
export interface OffReloadEnv {
  pref(): boolean
  supported(): boolean
  controllerScript(): string | null | undefined
  hasFullRegistration(): Promise<boolean>
  /** Per-tab storage for the loop guard (sessionStorage). */
  guardStore(): Pick<Storage, 'getItem' | 'setItem'> | null
  reload(): void
  broadcastAvailable(): boolean
}

export const browserOffReloadEnv: OffReloadEnv = {
  pref: () => getOfflinePref(),
  supported: () => isSWSupported(),
  controllerScript: () => (isSWSupported() ? navigator.serviceWorker.controller?.scriptURL : null),
  hasFullRegistration: () => hasFullSWRegistration(),
  guardStore: () => {
    try {
      return window.sessionStorage
    } catch {
      return null
    }
  },
  reload: () => window.location.reload(),
  broadcastAvailable: () => typeof BroadcastChannel !== 'undefined',
}

/** Cheap synchronous pre-check: could the reload rule apply at all? */
export function offReloadMayApply(env: OffReloadEnv = browserOffReloadEnv): boolean {
  if (!env.supported()) return false
  if (env.pref()) return false
  return scriptPath(env.controllerScript()) === FULL_SW_PATH
}

export async function decideOffReload(env: OffReloadEnv = browserOffReloadEnv): Promise<OffReloadDecision> {
  if (!offReloadMayApply(env)) return 'none'
  if (await env.hasFullRegistration()) return 'wait'
  return 'reload'
}

/**
 * Reload at most once per RELOAD_GUARD_MS (sessionStorage timestamp, no URL).
 * Only an actual reload sets the guard.
 */
export function guardedReload(env: OffReloadEnv = browserOffReloadEnv): boolean {
  const now = Date.now()
  const store = env.guardStore()
  try {
    const at = Number(store?.getItem(RELOAD_GUARD_KEY) ?? '0')
    if (Number.isFinite(at) && at > 0 && now >= at && now - at < RELOAD_GUARD_MS) return false
  } catch {
    // unreadable guard: fall through and reload
  }
  try {
    store?.setItem(RELOAD_GUARD_KEY, String(now))
  } catch {
    // no sessionStorage: still reload; the controller is gone after it
  }
  env.reload()
  return true
}

export async function applyOffReloadRule(
  opts: { recheck?: boolean; env?: OffReloadEnv } = {},
): Promise<OffReloadDecision> {
  const env = opts.env ?? browserOffReloadEnv
  const recheck = opts.recheck ?? true
  const decision = await decideOffReload(env)
  if (decision === 'reload') {
    guardedReload(env)
  } else if (decision === 'wait' && recheck && !env.broadcastAvailable()) {
    // No broadcast will arrive: look once more after the unregister had time.
    setTimeout(() => {
      void applyOffReloadRule({ recheck: false, env })
    }, NO_CHANNEL_RECHECK_MS)
  }
  return decision
}

export interface OffSignalSources {
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
  Channel: typeof BroadcastChannel | undefined
}

/**
 * Listen for the four off signals: the `storage` event on the pref key, the
 * `futari-offline` broadcast, `pageshow` from the bfcache, and the tab becoming
 * visible. Returns an unsubscribe function.
 */
export function subscribeOffSignals(onSignal: () => void, sources?: OffSignalSources): () => void {
  if (!sources && typeof window === 'undefined') return () => {}
  const { win, doc, Channel } = sources ?? {
    win: window,
    doc: document,
    Channel: typeof BroadcastChannel === 'undefined' ? undefined : BroadcastChannel,
  }
  const onStorage = (e: Event) => {
    const key = (e as StorageEvent).key
    if (key === OFFLINE_PREF_KEY || key === null) onSignal()
  }
  const onPageShow = (e: Event) => {
    if ((e as PageTransitionEvent).persisted) onSignal()
  }
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') onSignal()
  }
  win.addEventListener('storage', onStorage)
  win.addEventListener('pageshow', onPageShow)
  doc.addEventListener('visibilitychange', onVisibility)
  let channel: BroadcastChannel | null = null
  if (Channel) {
    try {
      channel = new Channel(OFFLINE_CHANNEL)
      channel.onmessage = (e: MessageEvent) => {
        if ((e.data as { type?: string } | null)?.type === OFFLINE_OFF_MESSAGE) onSignal()
      }
    } catch {
      channel = null
    }
  }
  return () => {
    win.removeEventListener('storage', onStorage)
    win.removeEventListener('pageshow', onPageShow)
    doc.removeEventListener('visibilitychange', onVisibility)
    channel?.close()
  }
}
