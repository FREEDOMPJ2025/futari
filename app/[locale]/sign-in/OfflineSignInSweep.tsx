'use client'

import { useEffect } from 'react'
import { signInSweep } from '@/lib/offline/swControl'

/**
 * Sign-in sweep (#1673 S1.6, M1). Whoever reaches sign-in — including a session
 * that ended without logout — leaves no ledger pages for the next person:
 * delete the consent marker first (a live full worker stops writing), then
 * `dynamic-v1` and the `serwist-expiration` records. The precache, the worker
 * and the pref stay; after sign-in the dashboard's binding check decides, and
 * only it re-creates the marker.
 *
 * A still-signed-in, opted-in user who opens /sign-in loses their `dynamic-v1`
 * too; it refills on the next dashboard visits (accepted, see the spec).
 *
 * Lives in its own component so SignInButton.tsx (a native-contract file) is
 * untouched. Imports only swControl — no Supabase SDK on this public page.
 */
export function OfflineSignInSweep() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('caches' in window)) return
    void signInSweep()
  }, [])
  return null
}
