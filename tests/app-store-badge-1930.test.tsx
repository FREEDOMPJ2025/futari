import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const track = vi.fn()
vi.mock('@/lib/analytics/track', () => ({ track: (...a: unknown[]) => track(...a) }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } }),
}))

import { Landing } from '@/app/[locale]/_landing/Landing'
import { AppStoreBadge, appStoreBadgeSrc } from '@/app/[locale]/_landing/AppStoreBadge'
import { PlayStoreBadge } from '@/app/[locale]/_landing/PlayStoreBadge'
import { landingPrePaintScript } from '@/lib/playLaunch'
import {
  APP_STORE_BADGE_URL,
  APP_STORE_URL,
  VISITOR_PLATFORM_ATTR,
  classifyBrowserPlatform,
} from '@/lib/visitorPlatform'
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const html = () => document.documentElement

beforeEach(() => {
  track.mockClear()
  html().removeAttribute(VISITOR_PLATFORM_ATTR)
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }))
})
afterEach(() => {
  cleanup()
  html().removeAttribute(VISITOR_PLATFORM_ATTR)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('classifyBrowserPlatform', () => {
  it.each([
    [IPHONE_UA, 5, 'ios'],
    [MAC_UA, 5, 'ios'], // iPad reporting Macintosh, touch points > 1
    [MAC_UA, 0, 'other'], // a real Mac
    [ANDROID_UA, 5, 'android'],
    [WIN_UA, 0, 'other'],
  ])('%s / %i -> %s', (ua, touch, expected) => {
    expect(classifyBrowserPlatform(ua, touch)).toBe(expected)
  })
})

describe('pre-paint script writes data-visitor-platform', () => {
  const run = (ua: string, touch: number) => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua)
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: touch, configurable: true })
    new Function(landingPrePaintScript())()
    return html().getAttribute(VISITOR_PLATFORM_ATTR)
  }

  it.each([
    [IPHONE_UA, 5],
    [MAC_UA, 5],
    [MAC_UA, 0],
    [ANDROID_UA, 5],
    [WIN_UA, 0],
    ['', 0],
  ])('matches classifyBrowserPlatform for %s / %i', (ua, touch) => {
    expect(run(ua, touch)).toBe(classifyBrowserPlatform(ua, touch))
  })
})

describe('App Store badge', () => {
  it('links with ct=landing-badge while the main CTA keeps ct=landing', () => {
    expect(APP_STORE_URL).toContain('ct=landing&')
    expect(APP_STORE_BADGE_URL).toBe(APP_STORE_URL.replace('ct=landing&', 'ct=landing-badge&'))
    expect(APP_STORE_BADGE_URL).toContain('ct=landing-badge&')
    expect(APP_STORE_BADGE_URL).toContain('pt=128976951')
  })

  const ALT: Record<Locale, string> = {
    en: 'Download on the App Store',
    ja: 'App Store からダウンロード',
    'zh-CN': 'App Store 下载',
    'zh-TW': 'App Store 下載',
  }

  it.each(SUPPORTED_LOCALES)('%s: official black badge file and alt', (locale) => {
    const d = dictionaries[locale].landing
    expect(d.appStoreBadgeAlt).toBe(ALT[locale])
    render(<AppStoreBadge locale={locale} alt={d.appStoreBadgeAlt} />)
    const img = screen.getByAltText(ALT[locale])
    expect(img.getAttribute('src')).toBe(`/badges/app-store-${locale}.svg`)
    expect(img.closest('a')!.getAttribute('href')).toBe(APP_STORE_BADGE_URL)
    const file = join(process.cwd(), 'public', appStoreBadgeSrc(locale))
    expect(existsSync(file)).toBe(true)
    const svg = readFileSync(file, 'utf8')
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
    expect(svg).toContain('height="40"')
  })

  it('tracks app_store_badge / app_store and is CSS-hidden in shells and on Android', () => {
    const d = dictionaries.en.landing
    const { container } = render(<AppStoreBadge locale="en" alt={d.appStoreBadgeAlt} />)
    fireEvent.click(screen.getByAltText(d.appStoreBadgeAlt))
    expect(track.mock.calls).toEqual([['landing_cta_clicked', { cta_location: 'app_store_badge', target: 'app_store' }]])
    const cls = container.firstElementChild!.className
    expect(cls).toContain('[html[data-native-shell]_&]:hidden')
    expect(cls).toContain('[html[data-visitor-platform=android]_&]:hidden')
  })

  it('Play badge is additionally hidden on iOS', () => {
    const { container } = render(<PlayStoreBadge locale="en" alt="x" />)
    expect(container.firstElementChild!.className).toContain('[html[data-visitor-platform=ios]_&]:hidden')
  })

  it('layout effect marks <html> for client-side navigation', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ANDROID_UA)
    render(<AppStoreBadge locale="en" alt="x" />)
    expect(html().getAttribute(VISITOR_PLATFORM_ATTR)).toBe('android')
  })

  it('trademark line is English in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(dictionaries[locale].landing.appStoreTrademark).toBe('App Store is a service mark of Apple Inc.')
    }
  })
})

describe('Landing wiring (#1930)', () => {
  it.each(SUPPORTED_LOCALES)('%s: App Store badge before Play badge, both trademark lines in the footer', (locale) => {
    const d = dictionaries[locale]
    const { container } = render(
      <Landing
        t={d.landing}
        locale={locale}
        showLaunchBanner={false}
        signInHref="/sign-in"
        dashboardHref="/dashboard"
        checkingLabel={d.signIn.signingIn}
        useCaseHrefs={{ cohabitation: '/a', newlyweds: '/b', petOwners: '/c', hub: '/d' }}
        migrateHrefs={{ honeydue: '/e', spendee: '/f', cwmoney: '/g', hub: '/h' }}
        featureOutingHref="/i"
        legalLinks={{ termsHref: '/t', termsLabel: 't', privacyHref: '/p', privacyLabel: 'p' }}
      />,
    )
    const app = screen.getByAltText(d.landing.appStoreBadgeAlt)
    const play = screen.getByAltText(d.landing.playBadgeAlt)
    expect(app.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const row = app.closest('div')!.parentElement!
    expect(row.contains(play)).toBe(true)
    expect(row.className).toContain('[html[data-native-shell]_&]:hidden')
    const footer = container.querySelector('footer')!
    expect(footer.textContent).toContain(d.landing.playTrademark)
    expect(footer.textContent).toContain(d.landing.appStoreTrademark)
    const lines = [...footer.querySelectorAll('p[lang="en"]')]
    for (const text of [d.landing.playTrademark, d.landing.appStoreTrademark]) {
      const p = lines.find((el) => el.textContent === text)!
      expect(p.closest('[class*="data-native-shell"]')).not.toBeNull()
    }
  })
})
