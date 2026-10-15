'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { decideOffReload, guardedReload, offReloadMayApply } from '@/lib/offline/swControl'

const VISIBILITY_REFRESH_THRESHOLD_MS = 30_000

/**
 * Force-refreshes the current route when the device comes back online or the
 * PWA is foregrounded after being hidden for a while.
 *
 * Why this exists:
 *   - iOS PWA standalone has no pull-to-refresh and no address bar reload.
 *   - Next.js Router Cache + Serwist `NetworkFirst` can both keep serving stale
 *     RSC payloads after a flaky-network episode. Without an explicit trigger,
 *     users get stuck on the offline snapshot until they kill and reopen the
 *     PWA (issue #126).
 *
 * `router.refresh()` invalidates the Router Cache for the current route and
 * re-fetches its RSC payload while preserving client state — no full reload.
 */
export function ReconnectRefresh() {
  const router = useRouter()
  const lastRefreshAt = useRef(0)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const refresh = () => {
      lastRefreshAt.current = Date.now()
      // #1673 reload rule: offline browsing is off but this tab is still
      // controlled by the full worker → reload (releases control) instead of
      // refreshing through it. While its registration still exists the reload
      // would come back controlled, so skip; the off broadcast follows.
      if (!offReloadMayApply()) {
        router.refresh()
        return
      }
      void decideOffReload().then((decision) => {
        if (decision === 'wait') return
        if (decision === 'reload' && guardedReload()) return
        router.refresh()
      })
    }

    const handleOnline = () => {
      // Coming back from offline almost always means stale data. Refresh
      // unconditionally so the user doesn't have to think about it.
      refresh()
    }

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (!navigator.onLine) return
      // Backgrounded for less than the threshold → trust the Router Cache.
      // Beyond the threshold (e.g. PWA returning from background hours later)
      // we'd rather pay one extra fetch than show day-old numbers.
      if (Date.now() - lastRefreshAt.current < VISIBILITY_REFRESH_THRESHOLD_MS) return
      refresh()
    }

    window.addEventListener('online', handleOnline)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('online', handleOnline)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [router])

  return null
}
