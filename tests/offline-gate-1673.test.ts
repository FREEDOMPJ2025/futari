/**
 * #1673 S1.0 — the SW write gate.
 *
 * The full worker may write `dynamic-v1` (and let the ExpirationPlugin write the
 * full URL to `serwist-expiration`) only while the consent marker exists.
 *
 * Failure looks like (without the gate, or with the post-check placed before the
 * ExpirationPlugin): after a turn-off or logout, a tab still controlled by the old
 * worker silently refills `dynamic-v1` and the URL records; nothing errors.
 *
 * `cachePut` below mirrors Serwist 9.5.11 StrategyHandler.cachePut: cacheWillUpdate
 * callbacks in array order (a null stops the chain before the cache is opened),
 * then cache.put, then every cacheDidUpdate in array order.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SerwistPlugin } from 'serwist'
import {
  CONSENT_CACHE,
  CONSENT_KEY,
  DYNAMIC_CACHE,
  buildDynamicCachePlugins,
  createConsentPostCheck,
  createConsentPreCheck,
  onlyCacheSuccessfulHtml,
  type ExpirationLike,
} from '@/lib/offline/swGate'
import { FakeCacheStorage, type Ops } from './helpers/offlineFakes'

let ops: Ops
let storage: FakeCacheStorage
/** Fake `serwist-expiration` cache-entries store: url → cacheName. */
let records: Map<string, string>

function fakeExpiration(): ExpirationLike {
  const seen = new Set<string>()
  return {
    cacheDidUpdate: async ({ cacheName, request }) => {
      seen.add(cacheName)
      ops.push(`expiration.record:${request.url}`)
      records.set(request.url, cacheName)
    },
    deleteCacheAndMetadata: async () => {
      for (const name of seen) {
        await storage.delete(name)
        for (const [url, c] of records) if (c === name) records.delete(url)
      }
      seen.clear()
    },
  }
}

async function cachePut(plugins: SerwistPlugin[], request: Request, response: Response): Promise<boolean> {
  let r: Response | undefined = response
  for (const p of plugins) {
    if (!p.cacheWillUpdate) continue
    r = ((await p.cacheWillUpdate({ request, response: r!, event: EVENT, state: {} })) ?? undefined) as Response | undefined
    if (!r) break
  }
  if (!r) return false
  const cache = await storage.open(DYNAMIC_CACHE)
  await cache.put(request.url, r)
  for (const p of plugins) {
    if (!p.cacheDidUpdate) continue
    await p.cacheDidUpdate({
      cacheName: DYNAMIC_CACHE,
      request,
      newResponse: r,
      oldResponse: null as unknown as Response,
      event: EVENT,
      state: {},
    })
  }
  return true
}

async function putMarker() {
  const c = await storage.open(CONSENT_CACHE)
  await c.put(CONSENT_KEY, new Response('1'))
}

const URL_A = 'http://localhost/dashboard'
const EVENT = {} as Parameters<NonNullable<SerwistPlugin['cacheWillUpdate']>>[0]['event']
const ok = () => new Response('<html>ledger</html>', { status: 200 })

beforeEach(() => {
  ops = []
  storage = new FakeCacheStorage(ops)
  records = new Map()
})

describe('SW write gate (#1673 S1.0)', () => {
  it('marker absent → cacheWillUpdate returns null; nothing cached, no expiration record', async () => {
    const exp = fakeExpiration()
    const plugins = buildDynamicCachePlugins(exp, () => storage as unknown as CacheStorage)

    const pre = await plugins[0].cacheWillUpdate!({ request: new Request(URL_A), response: ok(), event: EVENT, state: {} })
    expect(pre).toBeNull()

    const stored = await cachePut(plugins, new Request(URL_A), ok())
    expect(stored).toBe(false)
    expect(ops).not.toContain(`caches.open:${DYNAMIC_CACHE}`)
    expect(storage.stores.has(DYNAMIC_CACHE)).toBe(false)
    expect(records.size).toBe(0)
  })

  it('marker present → the response is cached with its record', async () => {
    await putMarker()
    const plugins = buildDynamicCachePlugins(fakeExpiration(), () => storage as unknown as CacheStorage)
    expect(await cachePut(plugins, new Request(URL_A), ok())).toBe(true)
    expect(storage.stores.get(DYNAMIC_CACHE)?.has(URL_A)).toBe(true)
    expect(records.has(URL_A)).toBe(true)
  })

  it('marker removed between the first check and the put → the post-check deletes the entry and its record', async () => {
    await putMarker()
    const exp = fakeExpiration()
    const prod = buildDynamicCachePlugins(exp, () => storage as unknown as CacheStorage)
    // Test-only racer right after the pre-check: the off path deletes the marker.
    const racer: SerwistPlugin = {
      cacheWillUpdate: async ({ response }) => {
        await storage.delete(CONSENT_CACHE)
        return response
      },
    }
    const plugins = [prod[0], racer, ...prod.slice(1)]
    expect(await cachePut(plugins, new Request(URL_A), ok())).toBe(true)
    // The write happened, the ExpirationPlugin recorded it, then the post-check undid both.
    expect(ops).toContain(`expiration.record:${URL_A}`)
    expect(storage.stores.get(DYNAMIC_CACHE)?.has(URL_A)).toBeFalsy()
    expect(records.has(URL_A)).toBe(false)
  })

  it('the post-check never opens a cache (it cannot recreate storage)', async () => {
    const post = createConsentPostCheck(fakeExpiration(), () => storage as unknown as CacheStorage)
    await post.cacheDidUpdate!({
      cacheName: DYNAMIC_CACHE,
      request: new Request(URL_A),
      newResponse: ok(),
      oldResponse: null as unknown as Response,
      event: EVENT,
      state: {},
    })
    expect(ops.filter((o) => o.startsWith('caches.open'))).toEqual([])
  })

  it('the pre-check fails closed when Cache Storage is unavailable', async () => {
    const pre = createConsentPreCheck(() => undefined)
    expect(await pre.cacheWillUpdate!({ request: new Request(URL_A), response: ok(), event: EVENT, state: {} })).toBeNull()
  })
})

describe('plugin order used by app/sw.ts (static)', () => {
  it('pre-check first, onlyCacheSuccessfulHtml, the ExpirationPlugin, post-check last', () => {
    const exp = fakeExpiration()
    const plugins = buildDynamicCachePlugins(exp)
    expect(plugins).toHaveLength(4)
    expect(plugins[0].cacheWillUpdate).toBeTypeOf('function')
    expect(plugins[0].cacheDidUpdate).toBeUndefined()
    expect(plugins[1]).toBe(onlyCacheSuccessfulHtml)
    expect(plugins[2]).toBe(exp)
    expect(plugins[3].cacheDidUpdate).toBeTypeOf('function')
    expect(plugins[3].cacheWillUpdate).toBeUndefined()
    expect(plugins.indexOf(exp)).toBeLessThan(3)
  })

  it('app/sw.ts passes exactly that array to the dynamic-v1 route, sharing the ExpirationPlugin', () => {
    const src = readFileSync(resolve(__dirname, '../app/sw.ts'), 'utf8')
    expect(src).toMatch(/const dynamicExpiration = new ExpirationPlugin\(/)
    expect(src).toMatch(/const dynamicPlugins = buildDynamicCachePlugins\(dynamicExpiration\)/)
    const route = src.slice(src.indexOf('cacheName: DYNAMIC_CACHE'), src.indexOf('cacheName: STATIC_CACHE'))
    expect(route).toMatch(/plugins: dynamicPlugins,/)
    // No inline plugin array on the gated route.
    expect(route).not.toMatch(/plugins: \[/)
    expect(route).not.toMatch(/onlyCacheSuccessfulHtml/)
  })
})
