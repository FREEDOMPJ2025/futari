import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const track = vi.fn()
let groupUrl = 'https://groups.google.com/g/test'
let locale = 'zh-TW'
vi.mock('@/lib/analytics/track', () => ({ track: (...a: unknown[]) => track(...a) }))
vi.mock('@/lib/i18n/client', () => ({
  useTranslations: () => ({
    androidTesterInvite: { title: 'Invite', hint: 'Hint', shareTitle: 'ST', shareText: 'SX', copied: 'Copied' },
  }),
  useLocale: () => locale,
}))
vi.mock('@/lib/visitorPlatform', async (orig) => ({
  ...(await orig<typeof import('@/lib/visitorPlatform')>()),
  get ANDROID_TEST_GROUP_URL() {
    return groupUrl
  },
}))

const plugin = vi.hoisted(() => ({ share: vi.fn() }))
vi.mock('@capacitor/share', () => ({ Share: plugin }))

import { AndroidTesterInviteRow } from '@/app/(dashboard)/settings/_components/AndroidTesterInviteRow'
import { APP_URL } from '@/lib/i18n/seo'

function setNative(platform: 'android' | 'ios' | null, plugins: string[] = []) {
  if (platform === null) delete (window as { Capacitor?: unknown }).Capacitor
  else {
    ;(window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => platform,
      isPluginAvailable: (n: string) => plugins.includes(n),
    }
  }
}
function setNav(share: unknown, writeText: unknown) {
  Object.defineProperty(window.navigator, 'share', { value: share, configurable: true })
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
}
const abort = () => Object.assign(new Error('x'), { name: 'AbortError' })

beforeEach(() => {
  groupUrl = 'https://groups.google.com/g/test'
  locale = 'zh-TW'
})
afterEach(() => {
  cleanup()
  setNative(null)
  track.mockClear()
  plugin.share.mockReset()
  Object.defineProperty(window.navigator, 'share', { value: undefined, configurable: true })
})

describe('AndroidTesterInviteRow (#1648)', () => {
  it('is hidden in the iOS shell and with an empty group URL', () => {
    setNative('ios')
    expect(render(<AndroidTesterInviteRow />).container.innerHTML).toBe('')
    cleanup()
    setNative(null)
    groupUrl = ''
    expect(render(<AndroidTesterInviteRow />).container.innerHTML).toBe('')
  })

  it.each([['web', null], ['Android shell', 'android']] as const)('is shown on %s', (_n, p) => {
    setNative(p)
    render(<AndroidTesterInviteRow />)
    expect(screen.getByText('Invite').closest('button')).not.toBeNull()
  })

  it('renders nothing before mount', async () => {
    const { renderToString } = await import('react-dom/server')
    expect(renderToString(<AndroidTesterInviteRow />)).toBe('')
  })

  it('uses navigator.share with the absolute localized URL and tracks method=share', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn()
    setNav(share, writeText)
    locale = 'en'
    render(<AndroidTesterInviteRow />)
    fireEvent.click(screen.getByText('Invite'))
    await waitFor(() => expect(track).toHaveBeenCalledWith('android_beta_share_clicked', { method: 'share' }))
    expect(share).toHaveBeenCalledWith({ title: 'ST', text: 'SX', url: `${APP_URL}/en/android-beta` })
    expect(writeText).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledTimes(1)
  })

  it('uses the unprefixed path for zh-TW', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    setNav(share, vi.fn())
    render(<AndroidTesterInviteRow />)
    fireEvent.click(screen.getByText('Invite'))
    await waitFor(() => expect(share).toHaveBeenCalled())
    expect(share.mock.calls[0][0].url).toBe(`${APP_URL}/android-beta`)
  })

  it('falls back to the clipboard when share is missing, shows the confirmation, tracks method=copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setNav(undefined, writeText)
    render(<AndroidTesterInviteRow />)
    fireEvent.click(screen.getByText('Invite'))
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith(`${APP_URL}/android-beta`)
    expect(track.mock.calls).toEqual([['android_beta_share_clicked', { method: 'copy' }]])
  })

  it('falls back to the clipboard when share rejects with a non-Abort error', async () => {
    const share = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    setNav(share, writeText)
    render(<AndroidTesterInviteRow />)
    fireEvent.click(screen.getByText('Invite'))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(track.mock.calls).toEqual([['android_beta_share_clicked', { method: 'copy' }]])
  })

  it('does nothing when the user cancels the share sheet', async () => {
    const share = vi.fn().mockRejectedValue(abort())
    const writeText = vi.fn()
    setNav(share, writeText)
    render(<AndroidTesterInviteRow />)
    fireEvent.click(screen.getByText('Invite'))
    await waitFor(() => expect(share).toHaveBeenCalled())
    await Promise.resolve()
    expect(writeText).not.toHaveBeenCalled()
    expect(track).not.toHaveBeenCalled()
    expect(screen.queryByText('Copied')).toBeNull()
  })

  describe('Android shell with @capacitor/share (#1749)', () => {
    it('opens the system sheet through the plugin and tracks method=share', async () => {
      setNative('android', ['Share'])
      plugin.share.mockResolvedValue({ activityType: 'x' })
      const writeText = vi.fn()
      setNav(undefined, writeText) // the shell WebView has no navigator.share
      render(<AndroidTesterInviteRow />)
      fireEvent.click(screen.getByText('Invite'))
      await waitFor(() => expect(track).toHaveBeenCalledWith('android_beta_share_clicked', { method: 'share' }))
      expect(plugin.share).toHaveBeenCalledWith({ title: 'ST', text: 'SX', url: `${APP_URL}/android-beta` })
      expect(writeText).not.toHaveBeenCalled()
    })

    it('does nothing when the user dismisses the sheet ("Share canceled")', async () => {
      setNative('android', ['Share'])
      plugin.share.mockRejectedValue(new Error('Share canceled')) // SharePlugin.java:79
      const writeText = vi.fn()
      setNav(undefined, writeText)
      render(<AndroidTesterInviteRow />)
      fireEvent.click(screen.getByText('Invite'))
      await waitFor(() => expect(plugin.share).toHaveBeenCalled())
      await Promise.resolve()
      expect(writeText).not.toHaveBeenCalled()
      expect(track).not.toHaveBeenCalled()
      expect(screen.queryByText('Copied')).toBeNull()
    })

    it('copies in a shell built without the plugin', async () => {
      setNative('android', [])
      const writeText = vi.fn().mockResolvedValue(undefined)
      setNav(undefined, writeText)
      render(<AndroidTesterInviteRow />)
      fireEvent.click(screen.getByText('Invite'))
      await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy())
      expect(plugin.share).not.toHaveBeenCalled()
      expect(track.mock.calls).toEqual([['android_beta_share_clicked', { method: 'copy' }]])
    })
  })
})
