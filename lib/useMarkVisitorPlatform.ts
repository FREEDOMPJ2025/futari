'use client'

import { useLayoutEffect } from 'react'
import { VISITOR_PLATFORM_ATTR, classifyBrowserPlatform } from '@/lib/visitorPlatform'

/**
 * Marks `<html>` with `data-visitor-platform` (ios / android / other), so the
 * hero store badges can hide the one that doesn't fit this device (#1930):
 * `[html[data-visitor-platform=android]_&]:hidden` on the App Store badge,
 * `[html[data-visitor-platform=ios]_&]:hidden` on the Play badge.
 *
 * The landing's pre-paint script (`lib/playLaunch.ts`) does this on a full
 * load; this hook covers client-side navigation back to the landing, where
 * React doesn't run the inserted `<script>`. A layout effect, so the wrong
 * badge is hidden before the browser paints it.
 */
export function useMarkVisitorPlatform(): void {
  useLayoutEffect(() => {
    document.documentElement.setAttribute(
      VISITOR_PLATFORM_ATTR,
      classifyBrowserPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    )
  }, [])
}
