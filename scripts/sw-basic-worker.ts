// #1674 — the web's basic service worker, as source text.
//
// What it is for
// --------------
// A signed-in web user who has NOT turned on offline browsing used to get the
// browser's own "no internet" page (or a blank tab on a stalled network). This
// worker gives them a Futari offline page instead: `/offline-basic.html`, a
// self-contained page rendered by scripts/build-native-offline-page.ts (web
// target). It caches NOTHING else — no ledger HTML, no API responses, no
// assets. The only other entries in its cache are its own anti-loop markers,
// keyed by a SHA-256 of a pathname (never a query string or a full URL).
//
// Why a generated file
// --------------------
// `prebuild` (scripts/build-web-offline-basic.ts) renders the page, hashes it
// and writes `public/sw-basic.js` from `renderBasicWorker()`. The hash goes into
// the script bytes and into the cache name `offline-basic-<hash>`, so any copy
// change ships a new worker the browser installs on its next update check. Both
// files are gitignored, like `public/sw.js`.
//
// Rules the source below keeps (tests: __tests__/swBasicWorker.test.ts):
//   - install: fetch the page with `cache: 'reload'`; cache it ONLY when it is a
//     200 text/html that was not redirected and whose bytes hash to the
//     embedded hash. Otherwise the install fails (a sign-in page or a captive
//     portal can never become "the offline page").
//   - activate: delete every cache except its own (this is how a previous
//     `/sw.js`'s `dynamic-v1`, `static-v1`, precache and consent marker go),
//     delete the `serwist-expiration` IndexedDB, disable navigation preload,
//     then claim clients.
//   - fetch: only same-origin GET navigations are answered. `/auth/*`,
//     `/sign-in`, `/<locale>/sign-in`, every non-GET navigation and every
//     non-navigation request are never passed to `respondWith` — they reach the
//     network untouched. A GET navigation races the network against 8 s and
//     falls back to the offline page on a network error or the timeout.
//   - anti-loop: a navigation that got the page because of the TIMEOUT marks
//     its pathname hash for 2 minutes; the next navigation to it waits for the
//     network with no timeout (the page's own probe reloads it, and a slow but
//     working page must win on the second try). Any network response that is
//     used clears the mark.
//   - it never `cache.put`s a network response, and it never re-creates its
//     cache after something else deleted it.
//
// Kill mode (lib/offline/swBasicMode.ts): the worker deletes its
// `offline-basic-*` caches and unregisters itself on activate. It has no fetch
// handler and never navigates or reloads clients; the next navigation simply
// reaches the network.
//
// The source is ES2017 with no imports: it runs as a classic worker script.

import type { SwBasicMode } from '../lib/offline/swBasicMode.ts'

export const BASIC_PAGE_PATH = '/offline-basic.html'
export const BASIC_CACHE_PREFIX = 'offline-basic-'
/** Same-origin prefix of the anti-loop marker keys. Not a real route. */
export const SLOW_MARKER_PREFIX = '/__offline-basic-slow/'
export const NAV_TIMEOUT_MS = 8_000
export const SLOW_WINDOW_MS = 120_000
export const EXPIRATION_DB = 'serwist-expiration'

/** How many hex chars of the page hash name the cache. */
export const CACHE_HASH_LENGTH = 16

/** Headers copied from the fetched page onto the cached copy (allow-list). */
export const CACHED_PAGE_HEADERS = [
  'content-type',
  'content-security-policy',
  'x-frame-options',
  'referrer-policy',
  'cache-control',
  'x-content-type-options',
] as const

export interface BasicWorkerOptions {
  /** SHA-256 hex of the exact `/offline-basic.html` bytes. */
  pageHash: string
  mode: SwBasicMode
  /** Locale prefixes whose `/sign-in` is never answered. */
  locales: readonly string[]
}

export function basicCacheName(pageHash: string): string {
  return `${BASIC_CACHE_PREFIX}${pageHash.slice(0, CACHE_HASH_LENGTH)}`
}

function lit(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function renderBasicWorker(opts: BasicWorkerOptions): string {
  if (!/^[0-9a-f]{64}$/.test(opts.pageHash)) throw new Error('pageHash must be SHA-256 hex')
  const header = `// 自動產生，請勿手動編輯 — 來源：scripts/sw-basic-worker.ts（#1674）
// mode: ${opts.mode} · page: ${opts.pageHash}
'use strict';
`
  if (opts.mode === 'kill') return header + killWorkerSource()
  return header + basicWorkerSource(opts)
}

function killWorkerSource(): string {
  return `var CACHE_PREFIX = ${lit(BASIC_CACHE_PREFIX)};
function noop() {}

self.addEventListener('install', function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names
          .filter(function (n) { return n.indexOf(CACHE_PREFIX) === 0; })
          .map(function (n) { return caches.delete(n); }));
      })
      .catch(noop)
      .then(function () { return self.registration.unregister(); })
      .catch(noop)
  );
});
`
}

function basicWorkerSource(opts: BasicWorkerOptions): string {
  const signIn = `^(?:\\/(?:${opts.locales.map(escapeRegExp).join('|')}))?\\/sign-in(?:\\/|$)`
  return `var PAGE_HASH = ${lit(opts.pageHash)};
var CACHE = ${lit(basicCacheName(opts.pageHash))};
var PAGE = ${lit(BASIC_PAGE_PATH)};
var SLOW_PREFIX = ${lit(SLOW_MARKER_PREFIX)};
var NAV_TIMEOUT_MS = ${NAV_TIMEOUT_MS};
var SLOW_WINDOW_MS = ${SLOW_WINDOW_MS};
var EXPIRATION_DB = ${lit(EXPIRATION_DB)};
var KEEP_HEADERS = ${lit(CACHED_PAGE_HEADERS)};
var SIGN_IN = new RegExp(${lit(signIn)});
// pathname hash -> time the timeout fallback was served (this worker's lifetime).
var slow = new Map();

function noop() {}

function toHex(buf) {
  var bytes = new Uint8Array(buf);
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
}

function sha256Hex(data) {
  var bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return crypto.subtle.digest('SHA-256', bytes).then(toHex);
}

// Never answered: they reach the network untouched (no respondWith at all).
function bypass(request, url) {
  if (request.mode !== 'navigate') return true;
  if (request.method !== 'GET') return true;
  if (url.origin !== self.location.origin) return true;
  var p = url.pathname;
  if (p === '/auth' || p.indexOf('/auth/') === 0) return true;
  if (SIGN_IN.test(p)) return true;
  return false;
}

function keepHeaders(from) {
  var h = new Headers();
  for (var i = 0; i < KEEP_HEADERS.length; i++) {
    var v = from.get(KEEP_HEADERS[i]);
    if (v !== null) h.set(KEEP_HEADERS[i], v);
  }
  return h;
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    fetch(PAGE, { cache: 'reload', credentials: 'omit' })
      .then(function (res) {
        var type = res.headers.get('content-type') || '';
        if (res.status !== 200 || res.redirected || type.indexOf('text/html') !== 0) {
          throw new Error('offline page unavailable');
        }
        return res.arrayBuffer().then(function (buf) {
          return sha256Hex(buf).then(function (hash) {
            if (hash !== PAGE_HASH) throw new Error('offline page hash mismatch');
            return caches.open(CACHE).then(function (cache) {
              return cache.put(PAGE, new Response(buf, { status: 200, headers: keepHeaders(res.headers) }));
            });
          });
        });
      })
      .then(function () { return self.skipWaiting(); })
  );
});

function deleteExpirationDb() {
  return new Promise(function (resolve) {
    // A live connection (an old worker) blocks the delete; don't hold up
    // activation for it. The page side clears it again after activation.
    var timer = setTimeout(resolve, 2000);
    function done() { clearTimeout(timer); resolve(); }
    try {
      var req = indexedDB.deleteDatabase(EXPIRATION_DB);
      req.onsuccess = done;
      req.onerror = done;
    } catch (e) {
      done();
    }
  });
}

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names
          .filter(function (n) { return n !== CACHE; })
          .map(function (n) { return caches.delete(n); }));
      })
      .catch(noop)
      .then(deleteExpirationDb)
      .then(function () {
        var np = self.registration.navigationPreload;
        if (np && typeof np.disable === 'function') return np.disable().catch(noop);
      })
      .then(function () { return self.clients.claim(); })
  );
});

function offlinePage() {
  return caches.match(PAGE, { cacheName: CACHE }).then(function (res) {
    return res || Response.error();
  }, function () {
    return Response.error();
  });
}

function markerUrl(key) {
  return self.location.origin + SLOW_PREFIX + key;
}

// Marker writes never re-create the cache: if it is gone, the device was
// turned off or swept, and only memory remembers.
function markSlow(key) {
  var now = Date.now();
  slow.set(key, now);
  return caches.has(CACHE).then(function (has) {
    if (!has) return;
    return caches.open(CACHE).then(function (cache) {
      return cache.put(markerUrl(key), new Response(String(now), { headers: { 'content-type': 'text/plain' } }));
    });
  }).catch(noop);
}

function clearSlow(key) {
  slow.delete(key);
  return caches.has(CACHE).then(function (has) {
    if (!has) return;
    return caches.open(CACHE).then(function (cache) { return cache.delete(markerUrl(key)); });
  }).catch(noop);
}

function isSlow(key) {
  var now = Date.now();
  var at = slow.get(key);
  if (at !== undefined) return Promise.resolve(now - at >= 0 && now - at < SLOW_WINDOW_MS);
  return caches.match(markerUrl(key), { cacheName: CACHE })
    .then(function (res) { return res ? res.text() : null; })
    .then(function (text) {
      var t = Number(text);
      return text !== null && Number.isFinite(t) && now - t >= 0 && now - t < SLOW_WINDOW_MS;
    })
    .catch(function () { return false; });
}

function handleNavigation(request, pathname) {
  return sha256Hex(pathname).then(function (key) {
    return isSlow(key).then(function (wasSlow) {
      var network = fetch(request);
      if (wasSlow) {
        return network.then(function (res) {
          clearSlow(key);
          return res;
        }, offlinePage);
      }
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          markSlow(key);
          resolve(offlinePage());
        }, NAV_TIMEOUT_MS);
        network.then(function (res) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearSlow(key);
          resolve(res);
        }, function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(offlinePage());
        });
      });
    });
  }, function () {
    return fetch(request);
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (bypass(request, url)) return;
  event.respondWith(handleNavigation(request, url.pathname));
});
`
}
