/**
 * #1749 — the system share sheet in the Android shell. The shell's WebView has
 * no `navigator.share`, so `lib/shareSheet.ts` routes to `@capacitor/share`
 * there and leaves web and the iOS shell on Web Share.
 *
 * What failure looks like: nothing errors. Share in the Android shell keeps
 * copying instead of opening the sheet, or dismissing the sheet is reported as
 * a failure, or an old shell without the plugin throws instead of copying.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const plugin = vi.hoisted(() => ({ share: vi.fn() }))
vi.mock('@capacitor/share', () => ({ Share: plugin }))

import { hasShareSheet, isShareCancel, openShareSheet, preloadShareSheet } from '@/lib/shareSheet'

type Shell = { platform: 'android' | 'ios'; plugins: string[] }
function setShell(shell: Shell | null) {
  if (shell === null) delete (window as { Capacitor?: unknown }).Capacitor
  else {
    ;(window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => shell.platform,
      isPluginAvailable: (n: string) => shell.plugins.includes(n),
    }
  }
}
function setWebShare(fn: unknown) {
  Object.defineProperty(window.navigator, 'share', { value: fn, configurable: true, writable: true })
}

/** What the Android bridge hands back when the user dismisses the chooser:
 *  `call.reject("Share canceled")` (SharePlugin.java:79) arrives as a
 *  `cap.Exception` (an Error subclass) with that message and no code. */
class CapacitorException extends Error {}
const androidCancel = () => new CapacitorException('Share canceled')

const OPTS = { title: 'T', text: 'X', url: 'https://example.com/u' }

afterEach(() => {
  setShell(null)
  setWebShare(undefined)
  plugin.share.mockReset()
})

describe('web', () => {
  it('uses navigator.share and never the plugin', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    setWebShare(share)
    expect(hasShareSheet()).toBe(true)
    await openShareSheet(OPTS)
    expect(share).toHaveBeenCalledWith(OPTS)
    expect(plugin.share).not.toHaveBeenCalled()
  })

  it('has no sheet without navigator.share', () => {
    expect(hasShareSheet()).toBe(false)
  })

  it('calls navigator.share synchronously, so Safari keeps the tap', () => {
    const share = vi.fn().mockResolvedValue(undefined)
    setWebShare(share)
    void openShareSheet(OPTS)
    expect(share).toHaveBeenCalledTimes(1)
  })
})

describe('iOS shell', () => {
  it('keeps Web Share even if a Share plugin is registered', async () => {
    setShell({ platform: 'ios', plugins: ['Share'] })
    const share = vi.fn().mockResolvedValue(undefined)
    setWebShare(share)
    await openShareSheet(OPTS)
    expect(share).toHaveBeenCalledWith(OPTS)
    expect(plugin.share).not.toHaveBeenCalled()
  })
})

describe('Android shell with the plugin', () => {
  it('reports a sheet and opens it through @capacitor/share', async () => {
    setShell({ platform: 'android', plugins: ['Share'] })
    plugin.share.mockResolvedValue({ activityType: 'jp.naver.line.android' })
    expect(hasShareSheet()).toBe(true) // no navigator.share in this WebView
    await openShareSheet(OPTS)
    expect(plugin.share).toHaveBeenCalledWith(OPTS)
  })

  it('prefers the plugin over a navigator.share that happens to exist', async () => {
    setShell({ platform: 'android', plugins: ['Share'] })
    const share = vi.fn()
    setWebShare(share)
    plugin.share.mockResolvedValue({})
    await openShareSheet(OPTS)
    expect(plugin.share).toHaveBeenCalledTimes(1)
    expect(share).not.toHaveBeenCalled()
  })

  it('preload imports the plugin without opening the sheet', () => {
    setShell({ platform: 'android', plugins: ['Share'] })
    expect(() => preloadShareSheet()).not.toThrow()
    expect(plugin.share).not.toHaveBeenCalled()
  })
})

describe('Android shell built before the plugin existed', () => {
  it('reports no sheet, so callers keep copying', () => {
    setShell({ platform: 'android', plugins: ['PushNotifications'] })
    expect(hasShareSheet()).toBe(false)
    preloadShareSheet()
    expect(plugin.share).not.toHaveBeenCalled()
  })
})

describe('dismissing the sheet', () => {
  it('Android: the plugin rejection "Share canceled" counts as a cancel', async () => {
    setShell({ platform: 'android', plugins: ['Share'] })
    plugin.share.mockRejectedValue(androidCancel())
    const err = await openShareSheet(OPTS).catch((e) => e)
    expect(isShareCancel(err)).toBe(true)
  })

  it('web: AbortError counts as a cancel', () => {
    expect(isShareCancel(new DOMException('x', 'AbortError'))).toBe(true)
    expect(isShareCancel(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
  })

  it('other failures are not a cancel', () => {
    for (const e of [
      new Error('Can\'t share while sharing is in progress'),
      new Error('Unsupported url'),
      Object.assign(new Error('x'), { name: 'NotAllowedError' }),
      'Share canceled',
      null,
      undefined,
    ]) expect(isShareCancel(e)).toBe(false)
  })
})
