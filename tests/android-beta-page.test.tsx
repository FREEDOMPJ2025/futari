import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const track = vi.fn()
vi.mock('@/lib/analytics/track', () => ({ track: (...a: unknown[]) => track(...a) }))

import { AndroidBetaSteps } from '@/app/[locale]/android-beta/_components/AndroidBetaSteps'
import AndroidBetaPage, { generateMetadata } from '@/app/[locale]/android-beta/page'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { isPublicLocalizedPath } from '@/lib/i18n/path'
import { PLAY_STORE_URL } from '@/lib/visitorPlatform'
import { NATIVE_SHELL_ATTR } from '@/lib/playLaunch'

afterEach(() => {
  cleanup()
  track.mockClear()
})

const renderSteps = () =>
  render(
    <AndroidBetaSteps
      t={zhTW.androidBeta}
      playStoreCta={zhTW.landing.playStoreCta}
      playStoreCtaHint={zhTW.landing.playStoreCtaHint}
      webHref="/sign-in"
    />,
  )

describe('AndroidBetaSteps — "launched" page (#1901)', () => {
  it('thanks the testers and links to Google Play in a new tab, tracking the click', () => {
    const { container } = renderSteps()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(zhTW.androidBeta.title)
    expect(screen.getByText(zhTW.androidBeta.body)).toBeTruthy()
    expect(screen.getByText(zhTW.landing.playStoreCtaHint)).toBeTruthy()

    const play = screen.getByText(zhTW.landing.playStoreCta).closest('a')!
    expect(play.getAttribute('href')).toBe(PLAY_STORE_URL)
    expect(play.getAttribute('target')).toBe('_blank')
    expect(play.getAttribute('rel')).toBe('noopener noreferrer')
    fireEvent.click(play)
    expect(track.mock.calls).toEqual([['android_beta_step_clicked', { step: 'play_store' }]])

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual([PLAY_STORE_URL, '/sign-in'])
  })

  it('has no test-group or opt-in steps any more', () => {
    const { container } = renderSteps()
    expect(container.innerHTML).not.toContain('groups.google.com')
    expect(container.innerHTML).not.toContain('play.google.com/apps/testing')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('hides the Play button inside a native shell (flags <html>, CSS variant on the block)', () => {
    const w = window as unknown as { Capacitor?: unknown }
    w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
    try {
      renderSteps()
      expect(document.documentElement.hasAttribute(NATIVE_SHELL_ATTR)).toBe(true)
      const block = screen.getByText(zhTW.landing.playStoreCta).closest('a')!.parentElement!
      expect(block.className).toContain('[html[data-native-shell]_&]:hidden')
      // The "use the web version" link stays visible.
      expect(screen.getByText(zhTW.androidBeta.useWebVersion).closest('a')!.className).not.toContain('data-native-shell')
    } finally {
      delete w.Capacitor
      document.documentElement.removeAttribute(NATIVE_SHELL_ATTR)
    }
  })

  it('does not flag a regular browser', () => {
    renderSteps()
    expect(document.documentElement.hasAttribute(NATIVE_SHELL_ATTR)).toBe(false)
  })

  it('renders the en page with en copy and the locale-pinned web link', async () => {
    render(await AndroidBetaPage({ params: Promise.resolve({ locale: 'en' }) }))
    expect(screen.getByText(en.androidBeta.title)).toBeTruthy()
    expect(screen.getByText(en.landing.playStoreCta).closest('a')!.getAttribute('href')).toBe(PLAY_STORE_URL)
    expect(screen.getByText(en.androidBeta.useWebVersion).closest('a')!.getAttribute('href')).toBe('/en/sign-in')
  })
})

describe('/android-beta page wiring', () => {
  it('is noindex in every locale', async () => {
    for (const locale of ['zh-TW', 'zh-CN', 'en', 'ja']) {
      const meta = await generateMetadata({ params: Promise.resolve({ locale }) })
      expect(meta.robots).toEqual({ index: false })
    }
  })

  it('is a public localized path, with and without a locale prefix', () => {
    expect(isPublicLocalizedPath('/android-beta')).toBe(true)
    expect(isPublicLocalizedPath('/en/android-beta')).toBe(true)
  })
})

describe('retired closed-test copy (#1648, #1901)', () => {
  it('no locale still promises to delete sign-up data after adding, or mentions the form', () => {
    const all = JSON.stringify([zhTW, zhCN, en, ja])
    for (const gone of ['加入名單後', '加入名单后', 'deleted once', 'リストに追加したあと']) {
      expect(all).not.toContain(gone)
    }
  })

  it('no locale still recruits for the closed test', () => {
    const all = JSON.stringify([zhTW, zhCN, en, ja])
    for (const gone of ['測試群組', '测试群组', 'test group', 'テストグループ', '加入 Android 測試版', 'Join the Android beta']) {
      expect(all).not.toContain(gone)
    }
  })
})
