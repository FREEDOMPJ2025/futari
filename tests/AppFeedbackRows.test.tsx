import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppFeedbackRows } from '@/app/(dashboard)/settings/_components/AppFeedbackRows'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'

vi.mock('@/lib/i18n/client', () => ({
  useTranslations: () => ({
    appFeedback: {
      feedbackTitle: 'Send feedback and wishes',
      rateAppStore: 'Rate on the App Store',
      ratePlay: 'Rate on Google Play',
      noMailHint: 'No mail app is set up. Copy this address, then send the message yourself.',
      copy: 'Copy',
    },
  }),
}))

const EMAIL = 'support@southern-light.dev'
const APP_STORE_URL = 'https://apps.apple.com/app/id6779264784?action=write-review'
const HINT = 'No mail app is set up. Copy this address, then send the message yourself.'
const props = { appVersion: '1.10.0', locale: 'zh-TW' }

const shellWindow = window as Window & { Capacitor?: unknown }

function setNative(platform: 'android' | 'ios') {
  shellWindow.Capacitor = { isNativePlatform: () => true, getPlatform: () => platform }
}

function stubMedia(standalone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: standalone && query.includes('standalone'),
    media: query,
  }))
}

function clickFeedback() {
  const link = screen.getByRole('link', { name: 'Send feedback and wishes' })
  // Intercept at the document boundary to keep jsdom from attempting navigation.
  document.addEventListener('click', event => {
    expect(event.defaultPrevented).toBe(false)
    event.preventDefault()
  }, { once: true })
  fireEvent.click(link)
}

beforeEach(() => {
  stubMedia(false)
})

afterEach(() => {
  cleanup()
  delete shellWindow.Capacitor
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('AppFeedbackRows (#1956)', () => {
  it.each([false, true])('renders nothing in a browser (standalone: %s)', standalone => {
    stubMedia(standalone)
    shellWindow.Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web' }
    const { container } = render(<AppFeedbackRows {...props} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing on the server', async () => {
    setNative('ios')
    const { renderToString } = await import('react-dom/server')
    expect(renderToString(<AppFeedbackRows {...props} />)).toBe('')
  })

  it.each([
    { platform: 'ios', platformName: 'iOS', storeLabel: 'Rate on the App Store', storeUrl: APP_STORE_URL },
    { platform: 'android', platformName: 'Android', storeLabel: 'Rate on Google Play', storeUrl: PLAY_STORE_URL },
  ] as const)('renders only feedback and the matching store link on $platformName', ({
    platform, platformName, storeLabel, storeUrl,
  }) => {
    setNative(platform)
    render(<AppFeedbackRows {...props} />)

    expect(screen.getAllByRole('link')).toHaveLength(2)
    const feedback = screen.getByRole('link', { name: 'Send feedback and wishes' })
    const mailto = new URL(feedback.getAttribute('href')!)
    expect(mailto.protocol).toBe('mailto:')
    expect(mailto.pathname).toBe(EMAIL)
    expect(Array.from(mailto.searchParams.entries())).toEqual([
      ['subject', 'Futari feedback'],
      ['body', `App version: 1.10.0\nPlatform: ${platformName}\nLanguage: zh-TW`],
    ])

    const rating = screen.getByRole('link', { name: storeLabel })
    expect(rating.getAttribute('href')).toBe(storeUrl)
    expect(rating.getAttribute('target')).toBe('_blank')
    expect(rating.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('offers a separate address and copy button after 1500 ms on a visible page', () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.create(window.navigator, { clipboard: { value: { writeText } } }))
    setNative('ios')
    render(<AppFeedbackRows {...props} />)

    expect(screen.queryByText(HINT)).toBeNull()
    clickFeedback()
    act(() => vi.advanceTimersByTime(1499))
    expect(screen.queryByText(HINT)).toBeNull()
    act(() => vi.advanceTimersByTime(1))

    expect(screen.getByText(HINT).textContent).not.toContain(EMAIL)
    expect(screen.getByText(EMAIL).textContent).toBe(EMAIL)
    const copy = screen.getByRole('button', { name: 'Copy' })
    expect(copy.getAttribute('type')).toBe('button')
    fireEvent.click(copy)
    expect(writeText).toHaveBeenCalledExactlyOnceWith(EMAIL)
  })

  it.each(['visibilitychange', 'pagehide', 'blur'])('cancels the fallback on %s', event => {
    vi.useFakeTimers()
    const visibilityState = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    setNative('android')
    render(<AppFeedbackRows {...props} />)

    clickFeedback()
    if (event === 'visibilitychange') {
      visibilityState.mockReturnValue('hidden')
      fireEvent(document, new Event(event))
      visibilityState.mockReturnValue('visible')
    } else {
      fireEvent(window, new Event(event))
    }
    act(() => vi.advanceTimersByTime(1500))
    expect(screen.queryByText(HINT)).toBeNull()
  })
})
