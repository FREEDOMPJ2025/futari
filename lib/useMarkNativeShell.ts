'use client'

import { useLayoutEffect } from 'react'
import { NATIVE_SHELL_ATTR, isInNativeShell } from '@/lib/playLaunch'

/**
 * Marks `<html>` with `data-native-shell` when running inside either
 * Capacitor shell, so elements carrying `[html[data-native-shell]_&]:hidden`
 * (the Play badge, the launch banner, the /android-beta Play button) hide.
 *
 * The landing's pre-paint script (`lib/playLaunch.ts`) does this on a full
 * load; this hook covers what the script can't: a shell global that appears
 * after the script ran, client-side navigation (React doesn't run an inserted
 * `<script>`), and pages without the script. A layout effect, so on client
 * navigation the element is hidden before the browser paints it.
 */
export function useMarkNativeShell(): void {
  useLayoutEffect(() => {
    if (isInNativeShell()) document.documentElement.setAttribute(NATIVE_SHELL_ATTR, '')
  }, [])
}
