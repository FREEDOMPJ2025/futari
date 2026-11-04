import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const track = vi.fn()
vi.mock('@/lib/analytics/track', () => ({ track: (...a: unknown[]) => track(...a) }))

vi.mock('@/lib/i18n/client', () => ({
  useLocale: () => 'zh-TW',
  useTranslations: () => ({
    androidBetaInvite: { heading: 'H', body: 'B', cta: 'Get it' },
    landing: { playStoreCtaHint: 'Taiwan only' },
    postLeave: { dismissAria: 'Dismiss' },
  }),
}))

import { AndroidBetaInviteCard } from '@/app/(dashboard)/dashboard/_components/AndroidBetaInviteCard'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'

const KEY = 'futari_android_play_card_dismissed'
const OLD_BETA_KEY = 'futari_android_beta_invite_dismissed'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36'
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1'
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36'

function setUA(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
}
function setNative(platform: 'android' | 'ios' | null) {
  if (platform === null) delete (window as { Capacitor?: unknown }).Capacitor
  else {
    ;(window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => platform,
    }
  }
}

beforeEach(() => {
  track.mockClear()
  window.localStorage.clear()
  setUA(ANDROID_UA)
  // jsdom has no matchMedia; a plain browser tab is "not standalone".
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setNative(null)
  vi.restoreAllMocks()
})

describe('AndroidBetaInviteCard — Google Play card (#1553 → #1901)', () => {
  it('renders for an Android browser and fires shown once', () => {
    render(<AndroidBetaInviteCard />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText('Taiwan only')).toBeTruthy()
    expect(track.mock.calls).toEqual([['android_beta_invite_shown']])
  })

  it('renders in an Android PWA (standalone, no Capacitor)', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('standalone'), media: q }))
    render(<AndroidBetaInviteCard />)
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it.each([
    ['iOS', IOS_UA],
    ['desktop', DESKTOP_UA],
  ])('does not render on %s', (_n, ua) => {
    setUA(ua)
    const { container } = render(<AndroidBetaInviteCard />)
    expect(container.innerHTML).toBe('')
    expect(track).not.toHaveBeenCalled()
  })

  it('does not render inside the Capacitor Android shell (no download link in the app)', () => {
    setNative('android')
    const { container } = render(<AndroidBetaInviteCard />)
    expect(container.innerHTML).toBe('')
    expect(track).not.toHaveBeenCalled()
  })

  it('does not render once dismissed before', () => {
    window.localStorage.setItem(KEY, '1')
    const { container } = render(<AndroidBetaInviteCard />)
    expect(container.innerHTML).toBe('')
    expect(track).not.toHaveBeenCalled()
  })

  it('still shows to someone who closed the old closed-test invite', () => {
    window.localStorage.setItem(OLD_BETA_KEY, '1')
    render(<AndroidBetaInviteCard />)
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('dismiss hides the card, persists, and fires dismissed', () => {
    render(<AndroidBetaInviteCard />)
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByRole('status')).toBeNull()
    expect(window.localStorage.getItem(KEY)).toBe('1')
    expect(track.mock.calls).toEqual([['android_beta_invite_shown'], ['android_beta_invite_dismissed']])
  })

  it('CTA opens the Google Play listing in a new tab', () => {
    render(<AndroidBetaInviteCard />)
    const a = screen.getByText('Get it').closest('a')!
    expect(a.getAttribute('href')).toBe(PLAY_STORE_URL)
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('CTA click retires the card', () => {
    render(<AndroidBetaInviteCard />)
    fireEvent.click(screen.getByText('Get it').closest('a')!)
    expect(screen.queryByRole('status')).toBeNull()
    expect(window.localStorage.getItem(KEY)).toBe('1')
    expect(track.mock.calls).toEqual([['android_beta_invite_shown'], ['android_beta_invite_clicked']])
  })

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<AndroidBetaInviteCard />)
    expect(screen.getByRole('status')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
