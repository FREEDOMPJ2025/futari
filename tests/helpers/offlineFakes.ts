/**
 * Fakes for the offline-browsing tests (#1673): Cache Storage, IndexedDB
 * (`serwist-expiration`), `navigator.serviceWorker`, BroadcastChannel and the
 * storage writes — all appending to one shared `ops` log so tests can assert
 * the ORDER of side effects, not just that they happened.
 */
import { vi } from 'vitest'

export type Ops = string[]

// ─── Cache Storage ──────────────────────────────────────────────────────────

export class FakeCacheStorage {
  stores = new Map<string, Map<string, Response>>()
  constructor(private ops: Ops) {}
  async keys() { return [...this.stores.keys()] }
  async has(name: string) { return this.stores.has(name) }
  async delete(name: string) {
    this.ops.push(`caches.delete:${name}`)
    return this.stores.delete(name)
  }
  async open(name: string) {
    this.ops.push(`caches.open:${name}`)
    if (!this.stores.has(name)) this.stores.set(name, new Map())
    const store = this.stores.get(name)!
    const ops = this.ops
    return {
      put: async (key: string | Request, res: Response) => {
        const k = typeof key === 'string' ? key : key.url
        ops.push(`cache.put:${name}:${k}`)
        store.set(k, res)
      },
      match: async (key: string) => store.get(key),
    }
  }
  async match(key: string, opts?: { cacheName?: string }) {
    if (opts?.cacheName) return this.stores.get(opts.cacheName)?.get(key)
    for (const s of this.stores.values()) if (s.has(key)) return s.get(key)
    return undefined
  }
  /** Seed without logging. */
  seed(name: string, keys: string[] = ['/x']) {
    const m = this.stores.get(name) ?? new Map<string, Response>()
    for (const k of keys) m.set(k, new Response('x'))
    this.stores.set(name, m)
  }
}

// ─── IndexedDB (only what swControl uses) ───────────────────────────────────

type Db = { stores: Map<string, Map<string, unknown>> }

export class FakeIDBFactory {
  dbs = new Map<string, Db>()
  /** When true, deleteDatabase never settles (a live worker holds it open). */
  blockDelete = false
  constructor(private ops: Ops) {}

  seedExpiration(records: Array<{ url: string }>) {
    const store = new Map<string, unknown>()
    for (const r of records) store.set(r.url, r)
    this.dbs.set('serwist-expiration', { stores: new Map([['cache-entries', store]]) })
  }
  records(): unknown[] {
    const db = this.dbs.get('serwist-expiration')
    return db ? [...(db.stores.get('cache-entries')?.values() ?? [])] : []
  }

  async databases() {
    return [...this.dbs.keys()].map((name) => ({ name, version: 1 }))
  }

  open(name: string) {
    const req: Record<string, unknown> & {
      result?: unknown
      transaction?: { abort(): void } | null
      onsuccess?: () => void
      onerror?: (e: { preventDefault(): void }) => void
      onupgradeneeded?: () => void
      onblocked?: () => void
    } = {}
    setTimeout(() => {
      const db = this.dbs.get(name)
      if (!db) {
        let aborted = false
        req.transaction = { abort: () => { aborted = true } }
        req.onupgradeneeded?.()
        if (aborted) {
          req.onerror?.({ preventDefault() {} })
          return
        }
        this.dbs.set(name, { stores: new Map() })
      }
      const real = this.dbs.get(name)!
      const ops = this.ops
      req.result = {
        objectStoreNames: [...real.stores.keys()],
        close: () => ops.push(`idb.close:${name}`),
        transaction: (names: string[]) => {
          const tx: Record<string, unknown> & { oncomplete?: () => void } = {
            objectStore: (n: string) => ({
              clear: () => {
                ops.push(`idb.clear:${name}/${n}`)
                real.stores.get(n)?.clear()
              },
            }),
          }
          void names
          setTimeout(() => tx.oncomplete?.(), 0)
          return tx
        },
      }
      req.onsuccess?.()
    }, 0)
    return req
  }

  deleteDatabase(name: string) {
    const req: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {}
    this.ops.push(`idb.deleteDatabase:${name}`)
    setTimeout(() => {
      if (this.blockDelete) {
        req.onblocked?.()
        return
      }
      this.dbs.delete(name)
      req.onsuccess?.()
    }, 0)
    return req
  }
}

// ─── Service workers ────────────────────────────────────────────────────────

export class FakeWorker {
  listeners = new Set<() => void>()
  constructor(public scriptURL: string, public state: string) {}
  addEventListener(_: string, fn: () => void) { this.listeners.add(fn) }
  removeEventListener(_: string, fn: () => void) { this.listeners.delete(fn) }
  setState(s: string) {
    this.state = s
    for (const fn of [...this.listeners]) fn()
  }
}

export class FakeRegistration {
  active: FakeWorker | null = null
  waiting: FakeWorker | null = null
  installing: FakeWorker | null = null
  constructor(private container: FakeSWContainer, public path: string) {}
  addEventListener() {}
  removeEventListener() {}
  async unregister() {
    this.container.ops.push(`unregister:${this.path}`)
    this.container.regs = this.container.regs.filter((r) => r !== this)
    return true
  }
  /** Promote to an activated worker with this registration's script. */
  activate(path = this.path) {
    const w = new FakeWorker(`http://localhost${path}`, 'activated')
    this.installing = null
    this.active = w
    w.setState('activated')
  }
}

export class FakeSWContainer {
  regs: FakeRegistration[] = []
  controller: FakeWorker | null = null
  /** register() leaves the worker installing unless autoActivate is set. */
  autoActivate = false
  constructor(public ops: Ops) {}
  async getRegistrations() { return [...this.regs] }
  async register(url: string) {
    this.ops.push(`register:${url}`)
    let reg = this.regs.find((r) => r.path === url)
    if (!reg) {
      reg = new FakeRegistration(this, url)
      reg.installing = new FakeWorker(`http://localhost${url}`, 'installing')
      this.regs.push(reg)
    }
    if (this.autoActivate) reg.activate()
    return reg
  }
  get ready() { return Promise.resolve(this.regs[0]) }
  /** Seed an already-active registration without logging. */
  seedActive(path: string): FakeRegistration {
    const reg = new FakeRegistration(this, path)
    reg.active = new FakeWorker(`http://localhost${path}`, 'activated')
    this.regs.push(reg)
    return reg
  }
}

// ─── BroadcastChannel ───────────────────────────────────────────────────────

export function makeBroadcastChannelClass(ops: Ops) {
  const bus = new Map<string, Set<FakeChannel>>()
  class FakeChannel {
    onmessage: ((e: { data: unknown }) => void) | null = null
    constructor(public name: string) {
      if (!bus.has(name)) bus.set(name, new Set())
      bus.get(name)!.add(this)
    }
    postMessage(data: unknown) {
      ops.push(`broadcast:${(data as { type?: string }).type}`)
      for (const ch of bus.get(this.name) ?? []) {
        if (ch !== this) setTimeout(() => ch.onmessage?.({ data }), 0)
      }
    }
    close() { bus.get(this.name)?.delete(this) }
  }
  return FakeChannel
}

// ─── Install ────────────────────────────────────────────────────────────────

export interface OfflineEnv {
  ops: Ops
  caches: FakeCacheStorage
  idb: FakeIDBFactory
  sw: FakeSWContainer
}

/** Install the fakes on globalThis / navigator and log localStorage writes. */
export function installOfflineEnv(opts: { broadcast?: boolean } = {}): OfflineEnv {
  const ops: Ops = []
  const env: OfflineEnv = {
    ops,
    caches: new FakeCacheStorage(ops),
    idb: new FakeIDBFactory(ops),
    sw: new FakeSWContainer(ops),
  }
  vi.stubGlobal('caches', env.caches)
  vi.stubGlobal('indexedDB', env.idb)
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: env.sw,
  })
  if (opts.broadcast !== false) vi.stubGlobal('BroadcastChannel', makeBroadcastChannelClass(ops))
  else vi.stubGlobal('BroadcastChannel', undefined)

  const proto = Object.getPrototypeOf(window.localStorage) as Storage
  const origSet = proto.setItem
  const origRemove = proto.removeItem
  vi.spyOn(proto, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
    if (this === window.localStorage) ops.push(`ls.set:${k}=${v}`)
    return origSet.call(this, k, v)
  })
  vi.spyOn(proto, 'removeItem').mockImplementation(function (this: Storage, k: string) {
    if (this === window.localStorage) ops.push(`ls.remove:${k}`)
    return origRemove.call(this, k)
  })
  return env
}

export function uninstallOfflineEnv(): void {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // jsdom has no serviceWorker; remove ours.
  delete (navigator as unknown as Record<string, unknown>).serviceWorker
}

/** Let fake timers-free async chains settle. */
export async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

export function indexOfOp(ops: Ops, pred: string | RegExp): number {
  return ops.findIndex((o) => (typeof pred === 'string' ? o === pred : pred.test(o)))
}
