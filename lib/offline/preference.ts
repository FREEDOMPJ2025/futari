// localStorage keys for offline browsing (#1673). None of them holds PII:
//   - the preference is 'true' or absent;
//   - the owner is a SHA-256 hex of the signed-in user id, never the id itself;
//   - the off epoch is a counter.
export const OFFLINE_PREF_KEY = 'offline-browsing-enabled'
export const OFFLINE_OWNER_KEY = 'offline-browsing-owner'
export const OFFLINE_OFF_EPOCH_KEY = 'offline-off-epoch'

const STORAGE_KEY = OFFLINE_PREF_KEY

export function getOfflinePref(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * Only the user's ON handler in Settings may pass `true` (#1673 F4): calibration
 * and error paths only ever lower the preference. A device that turned itself
 * back on is how a "turned-off" device silently refilled its ledger cache.
 */
export function setOfflinePref(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (enabled) {
      window.localStorage.setItem(STORAGE_KEY, 'true')
    } else {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // ignore storage errors (quota, private mode)
  }
}

export function getOfflineOwner(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(OFFLINE_OWNER_KEY)
  } catch {
    return null
  }
}

export function setOfflineOwner(hash: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (hash) window.localStorage.setItem(OFFLINE_OWNER_KEY, hash)
    else window.localStorage.removeItem(OFFLINE_OWNER_KEY)
  } catch {
    // ignore storage errors
  }
}

/**
 * The off epoch (#1673, rev 5). Every full off bumps it before anything else.
 * A pending ON handler or pref-on mount re-reads it right before it writes the
 * pref, the owner or the consent marker, and skips those writes when it moved —
 * so a logout that started while an ON was pending can never leave it on. Kept
 * in localStorage so a bump in one tab is seen by every tab.
 */
export function getOffEpoch(): string {
  if (typeof window === 'undefined') return '0'
  try {
    return window.localStorage.getItem(OFFLINE_OFF_EPOCH_KEY) ?? '0'
  } catch {
    return '0'
  }
}

export function bumpOffEpoch(): void {
  if (typeof window === 'undefined') return
  try {
    const n = Number.parseInt(window.localStorage.getItem(OFFLINE_OFF_EPOCH_KEY) ?? '0', 10)
    const next = Number.isFinite(n) ? n + 1 : 1
    window.localStorage.setItem(OFFLINE_OFF_EPOCH_KEY, String(next))
  } catch {
    // ignore storage errors
  }
}
