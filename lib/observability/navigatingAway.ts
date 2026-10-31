/**
 * #1768 — "this page is already leaving" flag, for errors that only mean the
 * browser cancelled a request because a full navigation started.
 *
 * Sentry PRJ-FUTARI-9 (`TypeError: Load failed`, ~75% of successful iOS-native
 * Apple sign-ins): `window.location.href = …` starts the page swap, WebKit
 * cancels a request that is still in flight, the rejection surfaces as a
 * render error and `app/global-error.tsx` reports it and paints the error
 * page for a moment before the next page lands. Nothing failed — the sign-in
 * had already succeeded. Failure looks like: an error issue that tracks the
 * success count, and a one-frame "出了點問題" flash for the user.
 *
 * Callers set the flag right before they navigate away on purpose; global-error
 * reads it. Kept on `globalThis` so both sides see the same value whichever
 * chunk loaded this module.
 */
const KEY = '__futariNavigatingAway'

export function markNavigatingAway(): void {
  ;(globalThis as Record<string, unknown>)[KEY] = true
}

export function isNavigatingAway(): boolean {
  return (globalThis as Record<string, unknown>)[KEY] === true
}

/**
 * The message a cancelled fetch rejects with, per engine: WebKit `Load failed`,
 * Chromium `Failed to fetch`, Firefox `NetworkError when attempting to fetch
 * resource.` Anything else is a real error and is never treated as one of these.
 */
export function isCancelledFetchError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /^(Load failed|Failed to fetch|NetworkError when attempting to fetch resource)/.test(error.message)
  )
}
