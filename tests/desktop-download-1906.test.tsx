/**
 * #1906 — desktop download block (App Store + Google Play badges, QR card)
 * and the "iPhone App" link in the compact trust row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const track = vi.fn()
vi.mock('@/lib/analytics/track', () => ({ track: (...a: unknown[]) => track(...a) }))

import { DesktopDownloadBlock, DOWNLOAD_QR_URL } from '@/app/[locale]/_landing/DesktopDownloadBlock'
import { appStoreBadgeSrc } from '@/app/[locale]/_landing/AppStoreBadge'
import { PlatformLine, TrustSection } from '@/app/[locale]/_landing/TrustSection'
import { PLAY_STORE_URL, appStoreUrl } from '@/lib/visitorPlatform'
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'

const SHELL_HIDDEN = '[html[data-native-shell]_&]:hidden'

// The words on each official Apple badge (PM decision on #1906).
const APP_STORE_ALT: Record<Locale, string> = {
  en: 'Download on the App Store',
  'zh-TW': 'App Store 下載',
  'zh-CN': 'App Store 下载',
  ja: 'App Store からダウンロード',
}

const QR_CAPTION: Record<Locale, string> = {
  'zh-TW': '用手機掃描下載',
  'zh-CN': '用手机扫码下载',
  en: 'Scan with your phone to download',
  ja: 'スマートフォンでスキャンしてダウンロード',
}

beforeEach(() => {
  cleanup()
  track.mockClear()
})

describe('DesktopDownloadBlock (#1906)', () => {
  it.each(SUPPORTED_LOCALES)('%s: both badges with the official alt and the right href', (locale) => {
    const d = dictionaries[locale].landing
    expect(d.appStoreBadgeAlt).toBe(APP_STORE_ALT[locale])
    expect(d.downloadQrCaption).toBe(QR_CAPTION[locale])
    render(<DesktopDownloadBlock t={d} locale={locale} />)

    const apple = screen.getByAltText(d.appStoreBadgeAlt)
    expect(apple.getAttribute('src')).toBe(appStoreBadgeSrc(locale))
    expect(apple.getAttribute('height')).toBe('54')
    expect(apple.closest('a')!.getAttribute('href')).toBe(appStoreUrl('landing-desktop'))
    expect(apple.closest('a')!.getAttribute('href')).toContain('ct=landing-desktop')

    const play = screen.getByAltText(d.playBadgeAlt)
    expect(play.closest('a')!.getAttribute('href')).toBe(PLAY_STORE_URL)

    // App Store first, side by side in one row.
    const row = apple.closest('a')!.parentElement!
    expect(row.className).toContain('flex items-center gap-2')
    expect(row.contains(play)).toBe(true)
    expect(apple.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(screen.getByText(d.downloadQrCaption)).toBeTruthy()
  })

  it.each(SUPPORTED_LOCALES)('%s: the official App Store badge file exists', (locale) => {
    expect(existsSync(join(process.cwd(), 'public', appStoreBadgeSrc(locale)))).toBe(true)
  })

  it('is md-and-up only and hidden in the native shells', () => {
    const d = dictionaries['zh-TW'].landing
    render(<DesktopDownloadBlock t={d} locale="zh-TW" className="mt-5" />)
    const block = screen.getByTestId('desktop-download-block')
    const cls = block.className.split(/\s+/)
    expect(cls).toContain('hidden')
    expect(cls).toContain('md:block')
    expect(cls).toContain(SHELL_HIDDEN)
    expect(cls).toContain('mt-5')
  })

  it('renders a server-side QR SVG, black on white, labelled, not clickable', () => {
    const d = dictionaries.en.landing
    const { container } = render(<DesktopDownloadBlock t={d} locale="en" />)
    const qr = screen.getByRole('img', { name: d.downloadQrAlt })
    expect(qr.className).toContain('size-22') // 88px
    expect(qr.className).toContain('bg-white')
    const svg = qr.querySelector('svg')!
    expect(svg).not.toBeNull()
    expect(svg.querySelector('rect')!.getAttribute('fill')).toBe('white')
    expect(svg.querySelector('path')!.getAttribute('fill')).toBe('black')
    expect(qr.closest('a')).toBeNull()
    // Only the two badges are links.
    expect(container.querySelectorAll('a')).toHaveLength(2)
  })

  it('the QR encodes the absolute /get URL', () => {
    const url = new URL(DOWNLOAD_QR_URL)
    expect(url.pathname).toBe('/get')
    expect(url.protocol).toMatch(/^https?:$/)
  })

  it('App Store badge click tracks app_store_badge / app_store', () => {
    const d = dictionaries.ja.landing
    render(<DesktopDownloadBlock t={d} locale="ja" />)
    fireEvent.click(screen.getByAltText(d.appStoreBadgeAlt))
    expect(track.mock.calls).toEqual([['landing_cta_clicked', { cta_location: 'app_store_badge', target: 'app_store' }]])
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
    // Looks like the surrounding text; underline on hover only.
    expect(link.className).toContain('no-underline')
    expect(link.className).toContain('hover:underline')
    expect(link.className).toContain('text-inherit')
    // Inside the shells: link hidden, same words as plain text instead.
    expect(link.className).toContain(SHELL_HIDDEN)
    const plain = link.nextElementSibling!
    expect(plain.tagName).toBe('SPAN')
    expect(plain.className).toContain('[html[data-native-shell]_&]:inline')
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
