/**
 * #1948 — one silent reload for a render that died on a cancelled fetch.
 *
 * Sentry PRJ-FUTARI-9 (`TypeError: Load failed`, iOS shell, /dashboard and
 * /settings, `area=global-error`): the app-router RSC response (router.refresh()
 * from ReconnectRefresh when the shell comes back to the foreground, or a
 * navigation) loses its connection while the stream is still open. The
 * (dashboard) layout's chunk is the slow one (it awaits the DB), so when the
 * stream dies before it lands the rejection is thrown by the router while
 * rendering that segment. Only the root boundary sits above it, so the user gets
 * app/global-error.tsx, not the page's error.tsx. Reproduced in WebKit on Next
 * 16.2.4 with an RSC stream cut after the first bytes; a cut after the layout
 * chunk landed gives the page-level boundary instead. `reset()` does not help:
 * it re-renders the same rejected payload. A full reload does.
 *
 * Failure looks like: the user lands on "出了點問題" after returning to the app,
 * with a working network a second later.
 *
 * Safety rails, so a reload can never trap anyone:
 * - once per RELOAD_GUARD_MS (sessionStorage survives the reload, so a page that
 *   fails again right after is shown, not reloaded in a loop);
 * - only when a same-origin static asset answers (a reload with no network ends
 *   on the WebView's own failure page, worse than ours);
 * - the caller falls back to the normal error page when either check says no.
 */
const GUARD_KEY = 'futari_global_error_reload_at'
export const RELOAD_GUARD_MS = 60_000
const PROBE_TIMEOUT_MS = 3000
// Excluded from proxy.ts's matcher: no auth, no DB, no redirect.
const PROBE_PATH = '/favicon.ico'

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

export function canAutoReload(now = Date.now()): boolean {
  try {
    const at = Number(store()?.getItem(GUARD_KEY) ?? '0')
    return !(Number.isFinite(at) && at > 0 && now >= at && now - at < RELOAD_GUARD_MS)
  } catch {
    return true
  }
}

export function markAutoReload(now = Date.now()): void {
  try {
    store()?.setItem(GUARD_KEY, String(now))
  } catch {
    // no sessionStorage: the reload still happens, just without the loop guard
  }
}

export async function networkReachable(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(PROBE_PATH, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
