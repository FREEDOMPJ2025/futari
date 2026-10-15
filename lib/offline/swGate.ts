// SW write gate for the opt-in full worker (#1673 S1.0, rev 5).
//
// The full worker (`app/sw.ts`) writes ledger HTML to `dynamic-v1`, and lets
// the ExpirationPlugin write each full URL to the `serwist-expiration`
// IndexedDB, ONLY while a consent marker exists: a Cache Storage cache
// `offline-consent-v1` with one tiny entry (no PII). Every off path deletes the
// marker FIRST, so from that moment every live full worker — in every tab, and
// in the Android shell's single long-lived WebView — stops writing, however
// late the reload that releases it arrives.
//
// Failure looked like (before the gate): a device whose owner had turned
// offline browsing off, or logged out, silently refilled `dynamic-v1` and the
// expiration records from a tab still controlled by the old worker.
//
// The gate is TWO plugins, because Serwist runs plugin callbacks in array order
// and ignores `cacheDidUpdate` return values
// (node_modules/serwist/src/lib/strategies/StrategyHandler.ts, cachePut):
//   - pre-check, FIRST: `cacheWillUpdate` returns null when the marker is
//     absent, so `cachePut` returns before it ever opens the cache;
//   - post-check, LAST (after the ExpirationPlugin, whose `cacheDidUpdate`
//     writes the full-URL record): re-checks the marker and, when it is gone,
//     undoes the write with `ExpirationPlugin.deleteCacheAndMetadata()`, which
//     deletes `dynamic-v1` and expires every record for it through Serwist's own
//     IndexedDB connection.
// The post-check never calls `caches.open` and never opens the IndexedDB
// itself, so it can never recreate storage.
//
// This module is imported by the worker and by unit tests; it must stay free
// of DOM-only and worker-only globals at import time.

import type { SerwistPlugin } from 'serwist'

export const CONSENT_CACHE = 'offline-consent-v1'
/** Same-origin key of the marker's single entry. Not a real route. */
export const CONSENT_KEY = '/__offline-consent'
export const DYNAMIC_CACHE = 'dynamic-v1'
export const STATIC_CACHE = 'static-v1'
export const EXPIRATION_DB = 'serwist-expiration'

type CacheStorageGetter = () => CacheStorage | undefined

const defaultStorage: CacheStorageGetter = () =>
  typeof caches === 'undefined' ? undefined : caches

/**
 * True when the consent marker exists. `CacheStorage.match` with `cacheName`
 * resolves `undefined` for a missing cache and — unlike `caches.open` — never
 * creates one. Any error counts as "no marker" (fail closed).
 */
export async function hasConsentMarker(
  getStorage: CacheStorageGetter = defaultStorage,
): Promise<boolean> {
  const storage = getStorage()
  if (!storage) return false
  try {
    const hit = await storage.match(CONSENT_KEY, { cacheName: CONSENT_CACHE })
    return hit !== undefined
  } catch {
    return false
  }
}

/** Cache only successful, non-redirected, authenticated responses. Next.js
 *  `redirect()` from a server component or proxy lands here as a followed
 *  3xx → response.redirected = true; this keeps a /sign-in body from being
 *  stored under /dashboard. */
export const onlyCacheSuccessfulHtml: SerwistPlugin = {
  cacheWillUpdate: async ({ response }) => {
    if (
      response.status === 200 &&
      !response.redirected &&
      !response.url.includes('/sign-in') &&
      !response.url.includes('/setup') &&
      !response.url.includes('/onboarding')
    ) {
      return response
    }
    return null
  },
}

export function createConsentPreCheck(
  getStorage: CacheStorageGetter = defaultStorage,
): SerwistPlugin {
  return {
    cacheWillUpdate: async ({ response }) =>
      (await hasConsentMarker(getStorage)) ? response : null,
  }
}

/** The part of Serwist's ExpirationPlugin the post-check relies on. */
export type ExpirationLike = SerwistPlugin & {
  deleteCacheAndMetadata(): Promise<void>
}

export function createConsentPostCheck(
  expiration: ExpirationLike,
  getStorage: CacheStorageGetter = defaultStorage,
): SerwistPlugin {
  return {
    cacheDidUpdate: async ({ cacheName }) => {
      if (await hasConsentMarker(getStorage)) return
      // The marker went away after the pre-check passed: undo this write,
      // its expiration record included.
      try {
        await expiration.deleteCacheAndMetadata()
      } catch {
        // fall through to the plain delete below
      }
      // `deleteCacheAndMetadata` only walks caches it has seen; a plain delete
      // of this cache is a harmless second pass (delete never creates).
      try {
        await getStorage()?.delete(cacheName)
      } catch {
        // best effort; the next pref-off mount sweep removes leftovers
      }
    },
  }
}

/**
 * The plugin array of the gated `dynamic-v1` route, in production order:
 * pre-check, onlyCacheSuccessfulHtml, the ExpirationPlugin, post-check.
 * `app/sw.ts` passes exactly this array; a static test asserts the order.
 */
export function buildDynamicCachePlugins(
  expiration: ExpirationLike,
  getStorage: CacheStorageGetter = defaultStorage,
): SerwistPlugin[] {
  return [
    createConsentPreCheck(getStorage),
    onlyCacheSuccessfulHtml,
    expiration,
    createConsentPostCheck(expiration, getStorage),
  ]
}
