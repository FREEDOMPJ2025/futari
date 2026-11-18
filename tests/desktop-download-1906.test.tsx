/**
 * #1906 — desktop QR card, and the "iPhone App" link in the compact trust row.
 * The store badges themselves are #1930's row (tests/app-store-badge-1930.test.tsx);
 * the Landing wiring test below pins that desktop shows exactly one App Store
 * badge, with the QR card under it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const track = vi.fn()
vi.mock('@/lib/analytics/track', () => ({ track: (...a: unknown[]) => track(...a) }))

const getSession = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession } }),
}))

vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}))

import { Landing } from '@/app/[locale]/_landing/Landing'
import { DesktopDownloadBlock, DOWNLOAD_QR_URL } from '@/app/[locale]/_landing/DesktopDownloadBlock'
import { appStoreBadgeSrc } from '@/app/[locale]/_landing/AppStoreBadge'
import { PlatformLine, TrustSection } from '@/app/[locale]/_landing/TrustSection'
import { APP_STORE_BADGE_URL, PLAY_STORE_URL, appStoreUrl } from '@/lib/visitorPlatform'
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'

const SHELL_HIDDEN = '[html[data-native-shell]_&]:hidden'

const QR_CAPTION: Record<Locale, string> = {
  'zh-TW': '用手機掃描下載',
  'zh-CN': '用手机扫码下载',
  en: 'Scan with your phone to download',
  ja: 'スマートフォンでスキャンしてダウンロード',
}

beforeEach(() => {
  cleanup()
  track.mockClear()
  getSession.mockReturnValue(new Promise(() => {}))
})

describe('DesktopDownloadBlock QR card (#1906)', () => {
  it.each(SUPPORTED_LOCALES)('%s: caption and QR label come from the dictionary', (locale) => {
    const d = dictionaries[locale].landing
    expect(d.downloadQrCaption).toBe(QR_CAPTION[locale])
    render(<DesktopDownloadBlock t={d} />)
    expect(screen.getByText(d.downloadQrCaption)).toBeTruthy()
    expect(screen.getByRole('img', { name: d.downloadQrAlt })).toBeTruthy()
  })

  it('is md-and-up only; hidden in shells, installed PWAs and iPhone/iPad/Android browsers', () => {
    render(<DesktopDownloadBlock t={dictionaries['zh-TW'].landing} />)
    const cls = screen.getByTestId('desktop-download-block').className.split(/\s+/)
    expect(cls).toContain('hidden')
    expect(cls).toContain('md:block')
    expect(cls).toContain(SHELL_HIDDEN)
    expect(cls).toContain('[html[data-standalone]_&]:hidden')
    expect(cls).toContain('[html[data-visitor-platform=ios]_&]:hidden')
    expect(cls).toContain('[html[data-visitor-platform=android]_&]:hidden')
  })

  it('renders a server-side QR SVG, black on white, labelled, not clickable, no badges', () => {
    const d = dictionaries.en.landing
    const { container } = render(<DesktopDownloadBlock t={d} />)
    const qr = screen.getByRole('img', { name: d.downloadQrAlt })
    expect(qr.className).toContain('size-22') // 88px
    expect(qr.className).toContain('bg-white')
    const svg = qr.querySelector('svg')!
    expect(svg).not.toBeNull()
    expect(svg.querySelector('rect')!.getAttribute('fill')).toBe('white')
    expect(svg.querySelector('path')!.getAttribute('fill')).toBe('black')
    expect(qr.closest('a')).toBeNull()
    expect(container.querySelectorAll('a, img')).toHaveLength(0)
  })

  it('the QR encodes the absolute /get URL', () => {
    const url = new URL(DOWNLOAD_QR_URL)
    expect(url.pathname).toBe('/get')
    expect(url.protocol).toMatch(/^https?:$/)
  })
})

describe('Landing: one badge row, QR card under it (#1906 on top of #1930)', () => {
  const renderLanding = (locale: Locale) => {
    const d = dictionaries[locale]
    return render(
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
  }

  it.each(SUPPORTED_LOCALES)('%s: exactly one App Store badge and one Play badge, one QR, QR right under the badge row', (locale) => {
    const d = dictionaries[locale].landing
    renderLanding(locale)

    // No second badge pair from the desktop block: #1930's row is the only one.
    const apple = screen.getAllByAltText(d.appStoreBadgeAlt)
    expect(apple).toHaveLength(1)
    expect(apple[0].getAttribute('src')).toBe(appStoreBadgeSrc(locale))
    expect(apple[0].closest('a')!.getAttribute('href')).toBe(APP_STORE_BADGE_URL)
    const play = screen.getAllByAltText(d.playBadgeAlt)
    expect(play).toHaveLength(1)
    expect(play[0].closest('a')!.getAttribute('href')).toBe(PLAY_STORE_URL)

    // One QR card, the very next element after the badge row, so no badge sits below it.
    expect(screen.getAllByRole('img', { name: d.downloadQrAlt })).toHaveLength(1)
    const row = apple[0].closest('a')!.parentElement!.parentElement!
    expect(row.contains(play[0])).toBe(true)
    expect(row.nextElementSibling).toBe(screen.getByTestId('desktop-download-block'))
  })
})

describe('"iPhone App" link in the platform line (#1906)', () => {
  it.each(SUPPORTED_LOCALES)('%s: the first segment links to the App Store, the rest stays text', (locale) => {
    const text = dictionaries[locale].landing.trustPwa
    expect(text).toMatch(/^iPhone [Aa]pp · /)
    const { container } = render(<PlatformLine text={text} />)
    const link = container.querySelector('a')!
    expect(link.textContent).toMatch(/^iPhone [Aa]pp$/)
    expect(link.getAttribute('href')).toBe(appStoreUrl('landing-desktop'))
    // Looks like the surrounding text (a inherits colour in preflight); underline on hover only.
    expect(link.className).toContain('no-underline')
    expect(link.className).toContain('hover:underline')
    // Inside the shells and installed PWAs: link hidden, same words as plain text instead.
    expect(link.className).toContain(SHELL_HIDDEN)
    expect(link.className).toContain('[html[data-standalone]_&]:hidden')
    const plain = link.nextElementSibling!
    expect(plain.tagName).toBe('SPAN')
    expect(plain.className).toContain('[html[data-native-shell]_&]:inline')
    expect(plain.className).toContain('[html[data-standalone]_&]:inline')
    expect(plain.className.split(/\s+/)).toContain('hidden')
    // Whole line still reads the same.
    expect(container.textContent!.replace(link.textContent!, '')).toBe(text)
  })

  it('the compact trust row renders it', () => {
    const d = dictionaries['zh-TW'].landing
    const { container } = render(<TrustSection t={d} variant="compact" />)
    expect(container.querySelector('a[href*="ct=landing-desktop"]')!.textContent).toBe('iPhone App')
  })
})
