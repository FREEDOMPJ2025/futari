import { describe, it, expect, vi, afterEach } from 'vitest'

const plugin = vi.hoisted(() => ({ share: vi.fn() }))
vi.mock('@capacitor/share', () => ({ Share: plugin }))

import { shareInviteLink } from '@/lib/share'

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as { Capacitor?: unknown }).Capacitor
  plugin.share.mockReset()
})

/** The Android shell: no navigator.share, the Share plugin present or not. */
function androidShell(withPlugin: boolean) {
  ;(window as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    isPluginAvailable: (n: string) => withPlugin && n === 'Share',
  }
}

describe('shareInviteLink', () => {
  it('copies first then opens native share when available', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { share, clipboard: { writeText } })

    const result = await shareInviteLink('https://example.com/invite/abc')
    // Both happen — clipboard first as a desktop safety net, share on top.
    expect(writeText).toHaveBeenCalledWith('https://example.com/invite/abc')
    expect(share).toHaveBeenCalledWith({ title: 'Futari 邀請', url: 'https://example.com/invite/abc' })
    expect(result).toBe('shared')
  })

  it('returns "copied" when user aborts the native share sheet', async () => {
    const abort = new Error('user cancelled')
    abort.name = 'AbortError'
    const share = vi.fn().mockRejectedValue(abort)
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { share, clipboard: { writeText } })

    const result = await shareInviteLink('https://example.com/invite/abc')
    // Clipboard succeeded before the cancelled share, so caller can still toast.
    expect(writeText).toHaveBeenCalledWith('https://example.com/invite/abc')
    expect(result).toBe('copied')
  })

  it('returns "copied" when navigator.share is missing entirely', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    const result = await shareInviteLink('https://example.com/invite/abc')
    expect(writeText).toHaveBeenCalledWith('https://example.com/invite/abc')
    expect(result).toBe('copied')
  })

  it('returns "copied" when navigator.share throws a non-AbortError', async () => {
    const share = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { share, clipboard: { writeText } })

    const result = await shareInviteLink('https://example.com/invite/abc')
    expect(share).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith('https://example.com/invite/abc')
    expect(result).toBe('copied')
  })

  it('throws when neither clipboard nor share is available', async () => {
    vi.stubGlobal('navigator', {})
    await expect(shareInviteLink('https://example.com/invite/abc')).rejects.toThrow('連結無法傳送')
  })

  it('still returns "shared" if clipboard is unavailable but share works', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { share })  // no clipboard

    const result = await shareInviteLink('https://example.com/invite/abc')
    expect(share).toHaveBeenCalledOnce()
    expect(result).toBe('shared')
  })

  describe('Android shell (#1749)', () => {
    const URL1 = 'https://example.com/invite/abc'

    it('copies first, then opens the system sheet through @capacitor/share', async () => {
      androidShell(true)
      plugin.share.mockResolvedValue({ activityType: 'x' })
      const writeText = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('navigator', { clipboard: { writeText } })

      const result = await shareInviteLink(URL1, 'Futari 邀請', 'hello')
      expect(writeText).toHaveBeenCalledWith(URL1)
      expect(plugin.share).toHaveBeenCalledWith({ title: 'Futari 邀請', text: 'hello', url: URL1 })
      expect(result).toBe('shared')
    })

    it('returns "copied" when the user dismisses the sheet (plugin rejects "Share canceled")', async () => {
      androidShell(true)
      // SharePlugin.java:79 — call.reject("Share canceled"); an Error with that message.
      plugin.share.mockRejectedValue(new Error('Share canceled'))
      const writeText = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('navigator', { clipboard: { writeText } })

      expect(await shareInviteLink(URL1)).toBe('copied')
      expect(writeText).toHaveBeenCalledWith(URL1)
    })

    it('an old shell without the plugin only copies', async () => {
      androidShell(false)
      const writeText = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('navigator', { clipboard: { writeText } })

      expect(await shareInviteLink(URL1)).toBe('copied')
      expect(plugin.share).not.toHaveBeenCalled()
    })
  })
})
