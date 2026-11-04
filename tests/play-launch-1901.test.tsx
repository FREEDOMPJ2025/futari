import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const track = vi.fn()
vi.mock('@/lib/analytics/track', () => ({ track: (...a: unknown[]) => track(...a) }))

const getSession = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession } }),
}))

import { Landing } from '@/app/[locale]/_landing/Landing'
import { PlayLaunchBanner } from '@/app/[locale]/_landing/PlayLaunchBanner'
import { PlayStoreBadge, playBadgeSrc } from '@/app/[locale]/_landing/PlayStoreBadge'
import {
  NATIVE_SHELL_ATTR,
  PLAY_BANNER_OFF_ATTR,
  PLAY_LAUNCH_BANNER_DISMISS_KEY,
  PLAY_LAUNCH_BANNER_LAST_DAY,
  isInNativeShell,
  isPlayLaunchBannerActive,
  isPlayLaunchBannerOff,
  landingPrePaintScript,
  playLaunchBannerEndsAt,
} from '@/lib/playLaunch'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

const html = () => document.documentElement
function resetHtml() {
  html().removeAttribute(NATIVE_SHELL_ATTR)
  html().removeAttribute(PLAY_BANNER_OFF_ATTR)
}
const w = window as unknown as Record<string, unknown>

beforeEach(() => {
  track.mockClear()
  window.localStorage.clear()
  resetHtml()
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})
afterEach(() => {
  cleanup()
  resetHtml()
  delete w.Capacitor
  delete w.androidBridge
  delete w.webkit
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('launch banner end date', () => {
  it('defaults to 2026-11-17, two weeks after the 2026-11-02 Play launch', () => {
    expect(PLAY_LAUNCH_BANNER_LAST_DAY).toBe('2026-11-17')
  })

  it('shows through the last day in Taipei and stops at the next Taipei midnight', () => {
    expect(isPlayLaunchBannerActive(Date.parse('2026-11-03T12:00:00+08:00'))).toBe(true)
    expect(isPlayLaunchBannerActive(Date.parse('2026-11-17T23:59:59+08:00'))).toBe(true)
    expect(isPlayLaunchBannerActive(Date.parse('2026-11-18T00:00:00+08:00'))).toBe(false)
    expect(playLaunchBannerEndsAt('2026-12-01')).toBe(Date.parse('2026-12-02T00:00:00+08:00'))
  })
})

describe('landing pre-paint script', () => {
  const run = (endsAt = Date.now() + 86_400_000) => new Function(landingPrePaintScript(endsAt))()

  it('marks nothing for a fresh browser visitor before the end date', () => {
    run()
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(false)
    expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(false)
  })

  it('turns the banner off once dismissed (persists across reloads)', () => {
    window.localStorage.setItem(PLAY_LAUNCH_BANNER_DISMISS_KEY, '1')
    run()
    expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(true)
  })

  it('turns the banner off after the end date, even in cached HTML', () => {
    run(Date.now() - 1)
    expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(true)
  })

  it.each([
    ['Capacitor.isNativePlatform()', () => { w.Capacitor = { isNativePlatform: () => true } }],
    ['Android bridge', () => { w.androidBridge = {} }],
    ['iOS bridge message handler', () => { w.webkit = { messageHandlers: { bridge: {} } } }],
  ])('flags a native shell via %s', (_n, setup) => {
    setup()
    run()
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(true)
  })

  it('does not flag a web build whose Capacitor global reports web', () => {
    w.Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web' }
    run()
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(false)
  })

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => run()).not.toThrow()
  })
})

describe('PlayLaunchBanner', () => {
  const t = dictionaries['zh-TW'].landing.launchBanner

  it('announces the launch with a Google Play link and tracks launch_banner / play_store', () => {
    render(<PlayLaunchBanner t={t} />)
    expect(screen.getByText(t.text)).toBeTruthy()
    const a = screen.getByText(t.link).closest('a')!
    expect(a.getAttribute('href')).toBe(PLAY_STORE_URL)
    expect(a.getAttribute('target')).toBe('_blank')
    fireEvent.click(a)
    expect(track.mock.calls).toEqual([['landing_cta_clicked', { cta_location: 'launch_banner', target: 'play_store' }]])
  })

  it('closes, remembers it, and the pre-paint script keeps it closed after a reload', () => {
    render(<PlayLaunchBanner t={t} />)
    fireEvent.click(screen.getByRole('button', { name: t.closeAria }))
    expect(screen.queryByText(t.text)).toBeNull()
    expect(window.localStorage.getItem(PLAY_LAUNCH_BANNER_DISMISS_KEY)).toBe('1')
    expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(true)

    // "Reload": fresh <html>, fresh render, script runs again.
    cleanup()
    resetHtml()
    new Function(landingPrePaintScript())()
    expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(true)
  })

  it('is CSS-hidden by the shell and banner-off flags', () => {
    const { container } = render(<PlayLaunchBanner t={t} />)
    const cls = container.firstElementChild!.className
    expect(cls).toContain('[html[data-native-shell]_&]:hidden')
    expect(cls).toContain('[html[data-play-banner-off]_&]:hidden')
  })

  it('flags <html> after hydration when the shell global appears late', () => {
    w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' }
    render(<PlayLaunchBanner t={t} />)
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(true)
  })

  // Client-side navigation back to `/` (e.g. the logo on /sign-in): React does
  // not run the inline script, so <html> has no flag and the banner must decide
  // on its own. jsdom applies no Tailwind, so "hidden" = the flag its
  // `[html[data-play-banner-off]_&]:hidden` variant keys on.
  describe('without the pre-paint script (client-side navigation)', () => {
    const LAST_DAY_NOON = Date.parse(`${PLAY_LAUNCH_BANNER_LAST_DAY}T12:00:00+08:00`)

    it('stays hidden when it was dismissed earlier', () => {
      window.localStorage.setItem(PLAY_LAUNCH_BANNER_DISMISS_KEY, '1')
      vi.spyOn(Date, 'now').mockReturnValue(LAST_DAY_NOON)
      expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(false)
      render(<PlayLaunchBanner t={t} />)
      expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(true)
    })

    it('stays hidden after the end date (Taipei midnight after the last day)', () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(`${PLAY_LAUNCH_BANNER_LAST_DAY}T23:59:59+08:00`) + 1000)
      render(<PlayLaunchBanner t={t} />)
      expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(true)
    })

    it('still shows for a fresh visitor before the end date', () => {
      vi.spyOn(Date, 'now').mockReturnValue(LAST_DAY_NOON)
      render(<PlayLaunchBanner t={t} />)
      expect(screen.getByText(t.text)).toBeTruthy()
      expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(false)
    })

    it('hides when the tab comes back after the last day passed while it was open', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(LAST_DAY_NOON)
      render(<PlayLaunchBanner t={t} />)
      expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(false)
      now.mockReturnValue(playLaunchBannerEndsAt())
      act(() => {
        window.dispatchEvent(new Event('focus'))
      })
      expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(true)
    })

    it.each([
      ['Capacitor.isNativePlatform()', () => { w.Capacitor = { isNativePlatform: () => true } }],
      ['Android bridge', () => { w.androidBridge = {} }],
      ['iOS bridge message handler', () => { w.webkit = { messageHandlers: { bridge: {} } } }],
    ])('flags a native shell via %s, for the banner and the badge', (_n, setup) => {
      setup()
      render(<PlayLaunchBanner t={t} />)
      expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(true)
      cleanup()
      resetHtml()
      render(<PlayStoreBadge locale="en" alt="x" />)
      expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(true)
    })

    it('does not flag a web page whose Capacitor global reports web', () => {
      w.Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web' }
      render(<PlayLaunchBanner t={t} />)
      render(<PlayStoreBadge locale="en" alt="x" />)
      expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(false)
    })
  })

  it('the component check and the pre-paint script agree on every input', () => {
    const endsAt = playLaunchBannerEndsAt()
    const shells: Array<[string, () => void]> = [
      ['none', () => {}],
      ['web Capacitor', () => { w.Capacitor = { isNativePlatform: () => false } }],
      ['native Capacitor', () => { w.Capacitor = { isNativePlatform: () => true } }],
      ['androidBridge', () => { w.androidBridge = {} }],
      ['iOS bridge', () => { w.webkit = { messageHandlers: { bridge: {} } } }],
    ]
    for (const dismissed of [false, true]) {
      for (const now of [endsAt - 1, endsAt]) {
        for (const [, setup] of shells) {
          window.localStorage.clear()
          if (dismissed) window.localStorage.setItem(PLAY_LAUNCH_BANNER_DISMISS_KEY, '1')
          delete w.Capacitor
          delete w.androidBridge
          delete w.webkit
          setup()
          vi.spyOn(Date, 'now').mockReturnValue(now)
          resetHtml()
          new Function(landingPrePaintScript(endsAt))()
          expect(html().hasAttribute(PLAY_BANNER_OFF_ATTR)).toBe(isPlayLaunchBannerOff(now, endsAt))
          expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(isInNativeShell())
        }
      }
    }
  })

  it('survives storage that throws on close', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<PlayLaunchBanner t={t} />)
    fireEvent.click(screen.getByRole('button', { name: t.closeAria }))
    expect(screen.queryByText(t.text)).toBeNull()
  })
})

describe('Google Play badge', () => {
  const ALT: Record<Locale, string> = {
    en: 'Get it on Google Play',
    'zh-TW': 'Google Play 立即下載',
    'zh-CN': '去商店下载 Google Play',
    ja: 'Google Play で手に入れよう',
  }

  it.each(SUPPORTED_LOCALES)('%s: uses that locale\'s official badge and the words on it as alt', (locale) => {
    const d = dictionaries[locale].landing
    expect(d.playBadgeAlt).toBe(ALT[locale])
    render(<PlayStoreBadge locale={locale} alt={d.playBadgeAlt} />)
    const img = screen.getByAltText(ALT[locale]) as HTMLImageElement
    expect(img.getAttribute('src')).toBe(`/badges/google-play-${locale}.png`)
    // Google's files are 646x250 incl. padding; 80px tall keeps the visible badge ~54px.
    expect(img.getAttribute('height')).toBe('80')
    expect(img.closest('a')!.getAttribute('href')).toBe(PLAY_STORE_URL)
    // The Taiwan-only hint sits under the main CTA only, not the badge (#1905).
    expect(screen.queryByText(d.playStoreCtaHint)).toBeNull()
  })

  it.each(SUPPORTED_LOCALES)('%s: badge file is committed under public/', (locale) => {
    expect(existsSync(join(process.cwd(), 'public', playBadgeSrc(locale)))).toBe(true)
  })

  it('tracks play_badge / play_store and is CSS-hidden in shells', () => {
    const d = dictionaries.en.landing
    const { container } = render(<PlayStoreBadge locale="en" alt={d.playBadgeAlt} />)
    fireEvent.click(screen.getByAltText(d.playBadgeAlt))
    expect(track.mock.calls).toEqual([['landing_cta_clicked', { cta_location: 'play_badge', target: 'play_store' }]])
    expect(container.firstElementChild!.className).toContain('[html[data-native-shell]_&]:hidden')
  })

  it('trademark line is Google\'s English wording in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(dictionaries[locale].landing.playTrademark).toBe(
        'Google Play and the Google Play logo are trademarks of Google LLC.',
      )
    }
  })
})

describe('Landing wiring (#1901)', () => {
  const renderLanding = (locale: Locale, showLaunchBanner: boolean) => {
    const d = dictionaries[locale]
    return render(
      <Landing
        t={d.landing}
        locale={locale}
        showLaunchBanner={showLaunchBanner}
        signInHref="/sign-in"
        dashboardHref="/dashboard"
        checkingLabel={d.signIn.signingIn}
        useCaseHrefs={{ cohabitation: '/a', newlyweds: '/b', petOwners: '/c', hub: '/d' }}
        migrateHrefs={{ honeydue: '/e', spendee: '/f', cwmoney: '/g', hub: '/h' }}
        featureOutingHref="/i"
        legalLinks={{ termsHref: '/t', termsLabel: 't', privacyHref: '/p', privacyLabel: 'p' }}
      />,
    )
  }

  beforeEach(() => {
    getSession.mockResolvedValue({ data: { session: null } })
  })

  it('renders the banner, badge and footer trademark, with the pre-paint script before the banner', () => {
    const { container } = renderLanding('ja', true)
    const d = dictionaries.ja.landing
    expect(screen.getByText(d.launchBanner.text)).toBeTruthy()
    // Two Play badges since #1906: mobile (md:hidden) + desktop download block.
    expect(screen.getAllByAltText(d.playBadgeAlt)).toHaveLength(2)
    expect(container.querySelector('footer')!.textContent).toContain(d.playTrademark)
    const script = container.querySelector('script')!
    const banner = screen.getByText(d.launchBanner.text).closest('aside')!
    expect(script.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('omits the banner once the end date has passed', () => {
    renderLanding('zh-TW', false)
    expect(screen.queryByText(dictionaries['zh-TW'].landing.launchBanner.text)).toBeNull()
  })

  it('lists Android in the platform line', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(dictionaries[locale].landing.trustPwa).toMatch(/Android/)
    }
  })

  it('an Android browser visitor gets the Play CTA with the Taiwan-only hint', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ANDROID_UA)
    renderLanding('zh-TW', false)
    await act(async () => {})
    const d = dictionaries['zh-TW'].landing
    const ctas = screen.getAllByText(d.playStoreCta)
    expect(ctas.length).toBe(2) // header + hero
    for (const c of ctas) expect(c.closest('a')!.getAttribute('href')).toBe(PLAY_STORE_URL)
    // Only under the hero CTA (mobile hint); none under the Play badge (#1905).
    expect(screen.getAllByText(d.playStoreCtaHint).length).toBe(1)
    expect(document.body.innerHTML).not.toContain('android-beta')
  })
})
