'use client'

// Offline-browsing lifecycle sequences (#1673). Each runs inside the per-tab
// queue (`enqueueOfflineSequence`) and receives its sequence, whose expected
// pref value its own writes move (S1.7, rev 3).
//
// User binding (S1.5): the owner is the SHA-256 hex of the session user id from
// the BROWSER Supabase client's `auth.getSession()` — cookie-local, no Auth API
// round-trip unless the access token expired. Never the page payload
// (`ViewerProvider.viewer.id`): a cached page carries the cached user's id.

import { createClient } from '@/lib/supabase/client'
import { nativeShellPlatform } from '@/lib/platform'
import { SW_BASIC_MODE } from './swBasicMode'
import {
  getOffEpoch,
  getOfflineOwner,
  setOfflineOwner,
} from './preference'
import { DYNAMIC_CACHE, STATIC_CACHE } from './swGate'
import {
  type OfflineSequence,
  applyOffReloadRule,
  basicPageCached,
  clearExpirationRecords,
  createConsentMarker,
  createSequence,
  deleteBasicCaches,
  deleteConsentMarker,
  deleteNamedCaches,
  deleteNonBasicCaches,
  findActiveBasicRegistration,
  guardedReload,
  isSWSupported,
  registerBasicSW,
  registerSW,
  sweepOfflineLedgerData,
  turnOfflineBrowsingOff,
  waitForBasicSWActivated,
} from './swControl'

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 hex of the signed-in user's id, or null with no session (or on any error). */
export async function getSessionUserHash(): Promise<string | null> {
  try {
    const { data } = await createClient().auth.getSession()
    const id = data.session?.user?.id
    return id ? await sha256Hex(id) : null
  } catch {
    return null
  }
}

export type PrefOnMountResult =
  | 'no-session'
  | 'user-changed'
  | 'bound'
  | 'registered'
  | 'register-failed'
  | 'aborted'
  | 'off-raced'

/**
 * Dashboard mount with the pref ON.
 *   - no session (e.g. offline with an expired token) → do nothing, leave the
 *     marker as it is; the sign-in sweep covers the next person;
 *   - session hash ≠ stored owner → full off (reason user-changed), then reload;
 *   - no stored owner (opted in before #1673) → clear dynamic-v1, static-v1 and
 *     the expiration records once, store this user as owner, keep the pref on;
 *   - owner matches (or was just bound) → re-create the consent marker — only
 *     now, after the binding check — then register `/sw.js` and wait for it.
 *     A timeout or error changes nothing (no pref write, no full off): a slow
 *     network must not cost the user their setting; the next mount retries.
 */
export async function runPrefOnMount(seq: OfflineSequence): Promise<PrefOnMountResult> {
  const epoch0 = getOffEpoch()
  const writable = () => seq.ok() && getOffEpoch() === epoch0

  const hash = await getSessionUserHash()
  if (!hash) return 'no-session'
  if (!seq.ok()) return 'aborted'

  const owner = getOfflineOwner()
  if (owner && owner !== hash) {
    await turnOfflineBrowsingOff({ reason: 'user-changed', seq })
    guardedReload()
    return 'user-changed'
  }

  let result: PrefOnMountResult = 'registered'
  if (!owner) {
    await deleteNamedCaches([DYNAMIC_CACHE, STATIC_CACHE])
    if (!seq.ok()) return 'aborted'
    await clearExpirationRecords()
    if (!writable()) return getOffEpoch() !== epoch0 ? 'off-raced' : 'aborted'
    setOfflineOwner(hash)
    result = 'bound'
  }

  if (!writable()) return getOffEpoch() !== epoch0 ? 'off-raced' : 'aborted'
  await createConsentMarker()
  if (getOffEpoch() !== epoch0) {
    // An off path started while the marker was being written: take it back.
    await deleteConsentMarker()
    return 'off-raced'
  }

  if (!seq.ok()) return 'aborted'
  try {
    await registerSW()
  } catch (err) {
    console.warn('[offline] pref-on mount: /sw.js did not activate', err)
    return 'register-failed'
  }
  return result
}

// ─── #1674: the web's basic worker ─────────────────────────────────────────
//
// Web users with the pref OFF get `/sw-basic.js`: it answers a navigation that
// fails or stalls (8 s) with a self-contained offline page, and caches nothing
// else (scripts/sw-basic-worker.ts). Never in the native shells — there the
// #1672 watchdog and the bundled `offline.html` do this job, and the iOS shell
// has no service worker. The pref stays the only answer to "is offline
// browsing on" — never the worker's scriptURL.

/** The basic worker applies: basic mode, and a browser that is not a native shell. */
export function basicWorkerApplies(): boolean {
  if (SW_BASIC_MODE !== 'basic') return false
  if (!isSWSupported() || typeof window === 'undefined') return false
  return nativeShellPlatform() === null
}

export type BasicWorkerResult =
  | 'present'
  | 'registered'
  | 'updated'
  | 'failed'
  | 'missing-page'
  | 'aborted'

/**
 * Make sure the basic worker is the active worker and really holds the offline
 * page (plan S2.8–9). Registers `/sw-basic.js` only when no registration's
 * ACTIVE worker already is it (re-registering on every mount would churn the
 * update check), then waits for `activated` (10 s cap). It does not trust
 * activation alone: it deletes every cache that isn't `offline-basic-*`, clears
 * the `serwist-expiration` records, and checks the page is cached. A missing
 * page gets one `registration.update()`; still missing → the full off, so the
 * user is no worse off than before #1674. A failed register / activation →
 * the full off as well. Every step re-reads the pref first (S1.7): a user's ON
 * that lands meanwhile stops this, and nothing here undoes it.
 */
export async function ensureBasicWorker(seq: OfflineSequence): Promise<BasicWorkerResult> {
  if (!seq.ok()) return 'aborted'
  let reg = await findActiveBasicRegistration()
  let result: BasicWorkerResult = 'present'
  if (!reg) {
    if (!seq.ok()) return 'aborted'
    try {
      reg = await registerBasicSW()
      result = 'registered'
    } catch (err) {
      console.warn('[offline] basic worker did not activate', err)
      if (!seq.ok()) return 'aborted'
      await turnOfflineBrowsingOff({ reason: 'basic-failed', seq })
      return 'failed'
    }
    if (!reg) return 'aborted'
  }

  if (!seq.ok()) return 'aborted'
  await deleteNonBasicCaches()
  if (!seq.ok()) return 'aborted'
  await clearExpirationRecords()
  if (await basicPageCached()) return result

  if (!seq.ok()) return 'aborted'
  try {
    await reg.update()
    await waitForBasicSWActivated(reg)
  } catch (err) {
    console.warn('[offline] basic worker update failed', err)
  }
  if (await basicPageCached()) return 'updated'

  if (!seq.ok()) return 'aborted'
  await turnOfflineBrowsingOff({ reason: 'basic-failed', seq })
  return 'missing-page'
}

/**
 * Dashboard mount with the pref OFF: the narrow sweep (S1.4), which keeps the
 * basic worker and its cache, then (web, basic mode) the basic worker. In kill
 * mode every off path is the full off and `/sw-basic.js` is never registered.
 */
export async function runPrefOffMount(seq: OfflineSequence): Promise<void> {
  if (SW_BASIC_MODE === 'kill') {
    await turnOfflineBrowsingOff({ reason: 'basic-kill', seq })
    return
  }
  await sweepOfflineLedgerData(seq)
  if (basicWorkerApplies()) await ensureBasicWorker(seq)
}

export type TurnOnResult = 'on' | 'error' | 'aborted' | 'cancelled'

/**
 * The user's ON handler — the ONLY place the pref is ever set to true (F4).
 * Waits for `/sw.js` to be the active, activated worker (15 s cap). On success
 * it writes the pref, the owner and the consent marker, re-reading the pref and
 * the off epoch right before each; if an off path started meanwhile (epoch
 * moved) it skips them and ends as a full off. On timeout or error: full off.
 */
export async function runTurnOn(seq: OfflineSequence): Promise<TurnOnResult> {
  const epoch0 = getOffEpoch()
  const epochMoved = () => getOffEpoch() !== epoch0
  const failClosed = async (): Promise<TurnOnResult> => {
    await turnOfflineBrowsingOff({ reason: 'on-failed', seq })
    return 'error'
  }
  // An off path (logout, deletion, another tab's OFF) moved the epoch and may
  // already have written the pref off itself, which this sequence's expected
  // value would read as an outside change. The full off that ends the ON runs
  // on a fresh sequence so that write can't stop it.
  const cancel = async (): Promise<TurnOnResult> => {
    await turnOfflineBrowsingOff({ reason: 'on-failed', seq: createSequence() })
    return 'cancelled'
  }

  const hash = await getSessionUserHash()
  if (!hash) return failClosed()
  if (!seq.ok()) return 'aborted'

  try {
    await registerSW()
  } catch (err) {
    console.warn('[offline] turn on: /sw.js did not activate', err)
    if (!seq.ok()) return 'aborted'
    return failClosed()
  }
  // #1674: `/sw.js` replaced the basic worker; its offline page cache goes too.
  await deleteBasicCaches()

  if (epochMoved()) return cancel()
  if (!seq.ok()) return 'aborted'
  seq.setPref(true)

  if (epochMoved()) return cancel()
  if (!seq.ok()) return 'aborted'
  setOfflineOwner(hash)

  if (epochMoved()) return cancel()
  if (!seq.ok()) return 'aborted'
  await createConsentMarker()
  if (epochMoved()) return cancel()
  return 'on'
}

/**
 * The user's OFF handler: full off, then the reload rule inline (never
 * enqueued). On the web in basic mode the basic worker is then registered fresh
 * (#1674): the full off removed everything, including any earlier basic worker.
 */
export async function runTurnOff(seq: OfflineSequence): Promise<void> {
  await turnOfflineBrowsingOff({ reason: 'user', seq })
  await applyOffReloadRule()
  if (basicWorkerApplies()) await ensureBasicWorker(seq)
}
