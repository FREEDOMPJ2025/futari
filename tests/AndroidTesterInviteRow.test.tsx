import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const track = vi.fn()
vi.mock('@/lib/analytics/track', () => ({ track: (...a: unknown[]) => track(...a) }))
vi.mock('@/lib/i18n/client', () => ({
  useTranslations: () => ({
    androidTesterInvite: { title: 'Invite', hint: 'Hint', shareTitle: 'ST', shareText: 'SX', copied: 'Copied' },
  }),
  useLocale: () => 'zh-TW',
}))

import { AndroidTesterInviteRow } from '@/app/(dashboard)/settings/_components/AndroidTesterInviteRow'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'

function setNative(platform: 'android' | 'ios' | null) {
  if (platform === null) delete (window as { Capacitor?: unknown }).Capacitor
  else {
    ;(window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => platform,
      isPluginAvailable: () => true,
    }
  }
}
function setNav(share: unknown, writeText: unknown) {
  Object.defineProperty(window.navigator, 'share', { value: share, configurable: true })
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
}
const abort = () => Object.assign(new Error('x'), { name: 'AbortError' })

afterEach(() => {
  cleanup()
  setNative(null)
  track.mockClear()
  Object.defineProperty(window.navigator, 'share', { value: undefined, configurable: true })
})

describe('AndroidTesterInviteRow (#1648 → #1901 Google Play)', () => {
  it.each([['iOS shell', 'ios'], ['Android shell', 'android']] as const)(
    'is hidden in the %s (no download link inside either app)',
    (_n, p) => {
      setNative(p)
      expect(render(<AndroidTesterInviteRow />).container.innerHTML).toBe('')
    },
  )

  it('is shown in a browser', () => {
    render(<AndroidTesterInviteRow />)
    expect(screen.getByText('Invite').closest('button')).not.toBeNull()
  })

  it('renders nothing before mount', async () => {
    const { renderToString } = await import('react-dom/server')
    expect(renderToString(<AndroidTesterInviteRow />)).toBe('')
  })

  it('shares the Google Play listing via navigator.share and tracks method=share', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn()
    setNav(share, writeText)
    render(<AndroidTesterInviteRow />)
    fireEvent.click(screen.getByText('Invite'))
    await waitFor(() => expect(track).toHaveBeenCalledWith('android_beta_share_clicked', { method: 'share' }))
    expect(share).toHaveBeenCalledWith({ title: 'ST', text: 'SX', url: PLAY_STORE_URL })
    expect(writeText).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledTimes(1)
  })

  it('falls back to the clipboard when share is missing, shows the confirmation, tracks method=copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setNav(undefined, writeText)
    render(<AndroidTesterInviteRow />)
    fireEvent.click(screen.getByText('Invite'))
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith(PLAY_STORE_URL)
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
})
