'use client'

import { useLayoutEffect } from 'react'
import { STANDALONE_ATTR } from '@/lib/playLaunch'
import { isStandalone } from '@/lib/install-guide'

/**
 * Marks `<html>` with `data-standalone` in an installed PWA, so elements
 * carrying `HIDDEN_IN_APP` (lib/playLaunch.ts: the store badges and their
 * trademark lines, #1930) hide. Twin of `useMarkNativeShell`: the landing's
 * pre-paint script does this on a full load; this covers client-side
 * navigation back to the landing, where React doesn't run the inserted
 * `<script>`. try/catch: `matchMedia` may be missing (old WebViews, jsdom).
 */
export function useMarkStandalone(): void {
  useLayoutEffect(() => {
    try {
      if (isStandalone()) document.documentElement.setAttribute(STANDALONE_ATTR, '')
    } catch {
      // no matchMedia: treat as a browser tab
    }
  }, [])
}
