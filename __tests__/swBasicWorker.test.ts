// @vitest-environment node
/**
 * #1674 — the basic worker's own rules, run on the exact source that
 * `prebuild` writes to `public/sw-basic.js` (renderBasicWorker), inside a fake
 * service-worker scope.
 *
 * Failure looks like: a sign-in or auth-callback navigation that hangs on the
 * offline page, a slow page that bounces between the offline page and itself,
 * a cache that quietly fills with ledger HTML, or a marker that stores the URL
 * a user visited. None of these error; the page just behaves wrong.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import {
  BASIC_PAGE_PATH,
  NAV_TIMEOUT_MS,
  SLOW_MARKER_PREFIX,
  SLOW_WINDOW_MS,
  basicCacheName,
  renderBasicWorker,
} from '../scripts/sw-basic-worker.ts'
import { SUPPORTED_LOCALES } from '../lib/i18n/locales-meta'

const ORIGIN = 'https://futari.example'
const PAGE_BODY = '<!DOCTYPE html><title>offline</title>'
const PAGE_HASH = createHash('sha256').update(PAGE_BODY, 'utf8').digest('hex')
const CACHE = basicCacheName(PAGE_HASH)
const PAGE_URL = `${ORIGIN}${BASIC_PAGE_PATH}`

const abs = (k: string | Request) => new URL(typeof k === 'string' ? k : k.url, ORIGIN).href

class FakeCaches {
  stores = new Map<string, Map<string, Response>>()
  ops: string[] = []
  async keys() { return [...this.stores.keys()] }
  async has(n: string) { return this.stores.has(n) }
  async delete(n: string) { this.ops.push(`delete:${n}`); return this.stores.delete(n) }
  async open(n: string) {
    this.ops.push(`open:${n}`)
    if (!this.stores.has(n)) this.stores.set(n, new Map())
    const s = this.stores.get(n)!
    const ops = this.ops
    return {
      put: async (k: string | Request, r: Response) => { ops.push(`put:${n}:${abs(k)}`); s.set(abs(k), r) },
      delete: async (k: string | Request) => { ops.push(`entry-delete:${n}:${abs(k)}`); return s.delete(abs(k)) },
      match: async (k: string | Request) => s.get(abs(k))?.clone(),
    }
  }
  async match(k: string | Request, opts?: { cacheName?: string }) {
    const key = abs(k)
    if (opts?.cacheName) return this.stores.get(opts.cacheName)?.get(key)?.clone()
    for (const s of this.stores.values()) if (s.has(key)) return s.get(key)!.clone()
    return undefined
  }
  seed(n: string, keys: string[] = ['/x']) {
    const m = this.stores.get(n) ?? new Map()
    for (const k of keys) m.set(abs(k), new Response('x'))
    this.stores.set(n, m)
  }
}

interface Scope {
  caches: FakeCaches
  fetch: ReturnType<typeof vi.fn>
  listeners: Map<string, (e: unknown) => void>
  skipWaiting: ReturnType<typeof vi.fn>
  claim: ReturnType<typeof vi.fn>
  preloadDisable: ReturnType<typeof vi.fn>
  unregister: ReturnType<typeof vi.fn>
  deleteDatabase: ReturnType<typeof vi.fn>
}

function boot(mode: 'basic' | 'kill' = 'basic'): Scope {
  const src = renderBasicWorker({ pageHash: PAGE_HASH, mode, locales: SUPPORTED_LOCALES })
  const listeners = new Map<string, (e: unknown) => void>()
  const scope: Scope = {
    caches: new FakeCaches(),
    fetch: vi.fn(),
    listeners,
    skipWaiting: vi.fn(async () => {}),
    claim: vi.fn(async () => {}),
    preloadDisable: vi.fn(async () => {}),
    unregister: vi.fn(async () => true),
    deleteDatabase: vi.fn((name: string) => {
      const req: { onsuccess?: () => void } = {}
      void name
      setTimeout(() => req.onsuccess?.(), 0)
      return req
    }),
  }
  const self = {
    location: new URL(`${ORIGIN}/sw-basic.js`),
    addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
    skipWaiting: scope.skipWaiting,
    clients: { claim: scope.claim },
    registration: { navigationPreload: { disable: scope.preloadDisable }, unregister: scope.unregister },
  }
  new Function('self', 'caches', 'indexedDB', 'fetch', src)(
    self,
    scope.caches,
    { deleteDatabase: scope.deleteDatabase },
    scope.fetch,
  )
  return scope
}

async function lifecycle(scope: Scope, type: 'install' | 'activate') {
  let p: Promise<unknown> = Promise.resolve()
  scope.listeners.get(type)!({ waitUntil: (x: Promise<unknown>) => { p = x } })
  return p
}

function navigate(scope: Scope, path: string, init: { method?: string; mode?: string } = {}) {
  const request = {
    url: `${ORIGIN}${path}`,
    method: init.method ?? 'GET',
    mode: init.mode ?? 'navigate',
  }
  let responded: Promise<Response> | null = null
  scope.listeners.get('fetch')!({ request, respondWith: (r: Promise<Response>) => { responded = r } })
  return { request, responded: responded as Promise<Response> | null }
}

function pageResponse(body = PAGE_BODY, init: ResponseInit & { redirected?: boolean } = {}) {
  const res = new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store, max-age=0',
      'set-cookie': 'a=b',
      'content-encoding': 'gzip',
    },
  })
  if (init.redirected) Object.defineProperty(res, 'redirected', { value: true })
  return res
}

/** Install with a good page, then activate. */
async function installed(): Promise<Scope> {
  const s = boot()
  s.fetch.mockResolvedValueOnce(pageResponse())
  await lifecycle(s, 'install')
  await lifecycle(s, 'activate')
  s.caches.ops.length = 0
  s.fetch.mockReset()
  return s
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

/**
 * Waits (in real time) until the worker has called `fetch` `n` times in total.
 * A navigation hashes its pathname with the real crypto.subtle first, and only
 * then calls `fetch` and arms its 8 s timer, both in the same synchronous step.
 * The digest runs on libuv's threadpool, so no fixed number of event-loop turns
 * is enough. Advancing fake time before the timer exists skips it.
 *
 * Failure looks like: on a loaded CI runner, the stall tests hit the 5 s test
 * timeout (the timer was armed after the advance and never fires), or
 * `release is not a function`. Locally everything passes.
 */
async function untilFetched(fetch: Scope['fetch'], n: number) {
  const deadline = performance.now() + 4_000
  while (fetch.mock.calls.length < n) {
    if (performance.now() > deadline) throw new Error(`worker called fetch ${fetch.mock.calls.length} times, expected ${n}`)
    await new Promise((r) => setImmediate(r))
  }
}

const pathKey = (p: string) => createHash('sha256').update(p, 'utf8').digest('hex')

afterEach(() => {
  vi.useRealTimers()
})

describe('install: caches only the real offline page (#1674)', () => {
  it('fetches with cache: reload, caches the page with allow-listed headers, skips waiting', async () => {
    const s = boot()
    s.fetch.mockResolvedValueOnce(pageResponse())
    await lifecycle(s, 'install')
    expect(s.fetch).toHaveBeenCalledWith(BASIC_PAGE_PATH, { cache: 'reload', credentials: 'omit' })
    const cached = await s.caches.match(PAGE_URL, { cacheName: CACHE })
    expect(await cached!.text()).toBe(PAGE_BODY)
    expect(cached!.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(cached!.headers.get('x-frame-options')).toBe('DENY')
    expect(cached!.headers.get('set-cookie')).toBeNull()
    expect(cached!.headers.get('content-encoding')).toBeNull()
    expect(s.skipWaiting).toHaveBeenCalled()
    expect([...s.caches.stores.keys()]).toEqual([CACHE])
  })

  it.each([
    ['a redirect (e.g. to sign-in)', () => pageResponse(PAGE_BODY, { redirected: true })],
    ['a 404', () => pageResponse(PAGE_BODY, { status: 404 })],
    ['a non-HTML body', () => pageResponse(PAGE_BODY, { headers: { 'content-type': 'application/json' } })],
    ['different bytes (a captive portal)', () => pageResponse('<html>Login to Wi-Fi</html>')],
  ])('fails the install on %s and caches nothing', async (_n, res) => {
    const s = boot()
    s.fetch.mockResolvedValueOnce(res())
    await expect(lifecycle(s, 'install')).rejects.toThrow()
    expect(s.caches.stores.size).toBe(0)
    expect(s.skipWaiting).not.toHaveBeenCalled()
  })
})

describe('activate: removes every foreign cache and the expiration records (#1674)', () => {
  it('deletes all other caches, the serwist-expiration DB, disables preload, claims', async () => {
    const s = boot()
    for (const n of ['dynamic-v1', 'static-v1', 'serwist-precache-v2-x', 'offline-consent-v1', 'offline-basic-0000000000000000']) {
      s.caches.seed(n)
    }
    s.fetch.mockResolvedValueOnce(pageResponse())
    await lifecycle(s, 'install')
    await lifecycle(s, 'activate')
    expect([...s.caches.stores.keys()]).toEqual([CACHE])
    expect(s.deleteDatabase).toHaveBeenCalledWith('serwist-expiration')
    expect(s.preloadDisable).toHaveBeenCalled()
    expect(s.claim).toHaveBeenCalled()
  })

  it('a blocked IndexedDB delete does not hold up activation past 2 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = boot()
    s.deleteDatabase.mockImplementation(() => ({}))
    const p = lifecycle(s, 'activate')
    await vi.advanceTimersByTimeAsync(2_000)
    await p
    expect(s.claim).toHaveBeenCalled()
  })
})

describe('fetch: what is never answered (#1674, P2)', () => {
  it.each([
    ['/auth/callback?code=x', {}],
    ['/auth', {}],
    ['/sign-in', {}],
    ['/sign-in?next=%2Fdashboard', {}],
    ['/ja/sign-in', {}],
    ['/zh-TW/sign-in/', {}],
    ['/dashboard', { method: 'POST' }],
    ['/records', { method: 'PUT' }],
    ['/dashboard', { mode: 'cors' }],
    ['/api/ping', { mode: 'cors' }],
    ['/_next/static/chunk.js', { mode: 'no-cors' }],
  ])('%s %j → no respondWith, straight to the network', async (path, init) => {
    const s = await installed()
    const { responded } = navigate(s, path, init)
    expect(responded).toBeNull()
    expect(s.fetch).not.toHaveBeenCalled()
  })

  it('a cross-origin navigation is not answered', async () => {
    const s = await installed()
    let responded = false
    s.listeners.get('fetch')!({
      request: { url: 'https://other.example/x', method: 'GET', mode: 'navigate' },
      respondWith: () => { responded = true },
    })
    expect(responded).toBe(false)
  })

  it.each(['/sign-inx', '/en/sign-inside', '/fr/sign-in'])('%s is an ordinary navigation (answered)', async (path) => {
    const s = await installed()
    s.fetch.mockResolvedValueOnce(new Response('ok'))
    const { responded } = navigate(s, path)
    expect(responded).not.toBeNull()
    expect(await (await responded!).text()).toBe('ok')
  })
})

describe('fetch: GET navigations fall back to the offline page (#1674)', () => {
  it('a network error → the cached offline page', async () => {
    const s = await installed()
    s.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const res = await navigate(s, '/dashboard').responded!
    expect(await res.text()).toBe(PAGE_BODY)
  })

  it('a working network → its response, never cached', async () => {
    const s = await installed()
    s.fetch.mockResolvedValueOnce(new Response('<html>ledger</html>'))
    const res = await navigate(s, '/records?month=2026-10').responded!
    expect(await res.text()).toBe('<html>ledger</html>')
    await settle()
    expect(s.caches.ops.filter((o) => o.startsWith('put:'))).toEqual([])
  })

  it('no cached page (cache deleted) → Response.error(), and the cache is not re-created', async () => {
    const s = await installed()
    s.caches.stores.clear()
    s.fetch.mockRejectedValueOnce(new TypeError('offline'))
    const res = await navigate(s, '/dashboard').responded!
    expect(res.type).toBe('error')
    await settle()
    expect(s.caches.stores.size).toBe(0)
  })

  it('a stall → the offline page at 8 s, with an anti-loop mark keyed by the pathname hash only', async () => {
    const s = await installed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    s.fetch.mockImplementation(() => new Promise(() => {}))
    const { responded } = navigate(s, '/dashboard?month=2026-10&q=secret')
    await untilFetched(s.fetch, 1)
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS - 1)
    let done = false
    void responded!.then(() => { done = true })
    await settle()
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const res = await responded!
    expect(await res.text()).toBe(PAGE_BODY)
    await settle()

    const puts = s.caches.ops.filter((o) => o.startsWith('put:'))
    expect(puts).toEqual([`put:${CACHE}:${ORIGIN}${SLOW_MARKER_PREFIX}${pathKey('/dashboard')}`])
    for (const p of puts) {
      expect(p).not.toContain('?')
      expect(p).not.toContain('month')
      expect(p).not.toContain('secret')
      expect(p).not.toContain('/dashboard')
    }
  })

  it('anti-loop: within 2 min the next navigation waits for the network with no timeout', async () => {
    const s = await installed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    s.fetch.mockImplementationOnce(() => new Promise(() => {}))
    const first = navigate(s, '/dashboard').responded!
    await untilFetched(s.fetch, 1)
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS)
    expect(await (await first).text()).toBe(PAGE_BODY)
    await settle()

    let release!: (r: Response) => void
    s.fetch.mockImplementationOnce(() => new Promise<Response>((r) => { release = r }))
    const second = navigate(s, '/dashboard?other=1').responded!
    await untilFetched(s.fetch, 2)
    await vi.advanceTimersByTimeAsync(12_000)
    let done = false
    void second.then(() => { done = true })
    await settle()
    expect(done).toBe(false)
    release(new Response('<html>real page</html>'))
    expect(await (await second).text()).toBe('<html>real page</html>')
    await settle()
    // The used network response cleared the mark.
    expect(s.caches.ops).toContain(`entry-delete:${CACHE}:${ORIGIN}${SLOW_MARKER_PREFIX}${pathKey('/dashboard')}`)
  })

  it('the mark survives a worker restart (read back from its cache) and expires after 2 min', async () => {
    const s = await installed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    s.fetch.mockImplementationOnce(() => new Promise(() => {}))
    const first = navigate(s, '/assets').responded!
    await untilFetched(s.fetch, 1)
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS)
    await first
    await settle()

    // A restarted worker: fresh memory, same caches.
    const restarted = boot()
    restarted.caches = s.caches
    const src = renderBasicWorker({ pageHash: PAGE_HASH, mode: 'basic', locales: SUPPORTED_LOCALES })
    const listeners = new Map<string, (e: unknown) => void>()
    new Function('self', 'caches', 'indexedDB', 'fetch', src)(
      { location: new URL(`${ORIGIN}/sw-basic.js`), addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn), registration: {}, clients: {} },
      s.caches,
      {},
      restarted.fetch,
    )
    restarted.listeners = listeners
    restarted.fetch.mockImplementationOnce(() => new Promise(() => {}))
    const again = navigate(restarted, '/assets').responded!
    await untilFetched(restarted.fetch, 1)
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS + 5_000)
    let done = false
    void again.then(() => { done = true })
    await settle()
    expect(done).toBe(false) // no timeout: the mark was read from the cache

    // After the window, the timeout applies again.
    await vi.advanceTimersByTimeAsync(SLOW_WINDOW_MS)
    restarted.fetch.mockImplementationOnce(() => new Promise(() => {}))
    const later = navigate(restarted, '/assets').responded!
    await untilFetched(restarted.fetch, 2)
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS)
    expect(await (await later).text()).toBe(PAGE_BODY)
  })

  it('no mark is written once its cache is gone (never re-creates storage)', async () => {
    const s = await installed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const page = s.caches.stores.get(CACHE)!
    s.fetch.mockImplementationOnce(() => new Promise(() => {}))
    const { responded } = navigate(s, '/dashboard')
    await untilFetched(s.fetch, 1)
    s.caches.stores.delete(CACHE) // a full off ran meanwhile
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS)
    await responded
    await settle()
    expect(s.caches.stores.has(CACHE)).toBe(false)
    expect(s.caches.ops.filter((o) => o.startsWith('open:'))).toEqual([])
    void page
  })
})

describe('kill mode (#1674, P1)', () => {
  it('deletes offline-basic-* caches and unregisters itself; no fetch handler', async () => {
    const s = boot('kill')
    s.caches.seed(CACHE)
    s.caches.seed('offline-basic-0000000000000000')
    s.caches.seed('unrelated')
    await lifecycle(s, 'install')
    expect(s.skipWaiting).toHaveBeenCalled()
    await lifecycle(s, 'activate')
    expect([...s.caches.stores.keys()]).toEqual(['unrelated'])
    expect(s.unregister).toHaveBeenCalled()
    expect(s.listeners.has('fetch')).toBe(false)
  })

})

beforeEach(() => {
  vi.restoreAllMocks()
})
