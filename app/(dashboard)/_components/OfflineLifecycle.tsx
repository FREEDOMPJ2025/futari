'use client'

import { useEffect } from 'react'
import {
  applyOffReloadRule,
  enqueueOfflineSequence,
  isSWSupported,
  subscribeOffSignals,
} from '@/lib/offline/swControl'
import { runPrefOffMount, runPrefOnMount } from '@/lib/offline/lifecycle'

/**
 * Reconciles this device with the offline-browsing preference (#1673). Mounted
 * inside the dashboard layout, so it only runs in signed-in views.
 *   - pref ON  → user binding check, then the consent marker, then `/sw.js`;
 *   - pref OFF → the narrow mount sweep (no SW, no ledger caches, no records).
 * It also listens for the off signals (storage / broadcast / pageshow /
 * visible) and applies the reload rule: a tab still controlled by `/sw.js`
 * after the pref went off reloads once to release it.
 * Every sequence runs through the per-tab queue.
 */
export function OfflineLifecycle() {
  useEffect(() => {
    if (!isSWSupported()) return
    void enqueueOfflineSequence<unknown>((seq) =>
      seq.expected ? runPrefOnMount(seq) : runPrefOffMount(seq),
    ).catch(() => {})
    return subscribeOffSignals(() => {
      void enqueueOfflineSequence(() => applyOffReloadRule()).catch(() => {})
    })
  }, [])

  return null
}
