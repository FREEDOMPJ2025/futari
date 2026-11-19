/**
 * #1908 — the home page and footer link to /features/shortcuts.
 *
 * What failure looks like: nothing errors. The line shows to Android visitors
 * (an iOS-only feature), a footer link is listed twice, or a locale falls
 * back to a missing string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'

const track = vi.fn()
vi.mock('@/lib/analytics/track', () => ({ track: (...a: unknown[]) => track(...a) }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } }),
}))

import { Landing } from '@/app/[locale]/_landing/Landing'
import { landingPrePaintScript } from '@/lib/playLaunch'
import { VISITOR_PLATFORM_ATTR } from '@/lib/visitorPlatform'
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'
import { localizedHref } from '@/lib/i18n/path'

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

/** Strings approved by Ray (issuecomment 6611212786 / 6631784892), verbatim. */
const APPROVED: Record<Locale, { line: string; useCase: string; shortcuts: string }> = {
  'zh-TW': { line: '捷徑記帳：Apple Pay 付完款，金額和商家先幫你填好', useCase: '使用情境', shortcuts: '捷徑記帳' },
  'zh-CN': { line: '快捷指令记账：Apple Pay 付完款，金额和商家先帮你填好', useCase: '使用情境', shortcuts: '快捷指令记账' },
  en: { line: 'Log with Shortcuts — pay with Apple Pay, and the amount and merchant are filled in for you', useCase: 'Situations', shortcuts: 'Log with Shortcuts' },
  ja: { line: 'ショートカットで記録：Apple Pay で払うと、金額と店名が入力済み', useCase: '利用シーン', shortcuts: 'ショートカットで記録' },
}

const html = () => document.documentElement

function renderLanding(locale: Locale) {
  const d = dictionaries[locale]
  return render(
    <Landing
      t={d.landing}
      locale={locale}
      showLaunchBanner={false}
      signInHref="/sign-in"
      dashboardHref="/dashboard"
      checkingLabel={d.signIn.signingIn}
      useCaseHrefs={{
        cohabitation: '/use-case/cohabitation',
        newlyweds: '/use-case/newlyweds',
        petOwners: '/use-case/pet-owners',
        hub: localizedHref('/use-case', locale),
      }}
      migrateHrefs={{ honeydue: '/e', spendee: '/f', cwmoney: '/g', hub: localizedHref('/migrate', locale) }}
      featureOutingHref={localizedHref('/features/outing', locale)}
      legalLinks={{ termsHref: '/t', termsLabel: 't', privacyHref: '/p', privacyLabel: 'p' }}
    />,
  )
}

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

describe.each(SUPPORTED_LOCALES)('%s', (locale) => {
  const shortcutsHref = localizedHref('/features/shortcuts', locale)

  it('has the approved strings, verbatim', () => {
    const l = dictionaries[locale].landing
    expect(l.featuresShortcutsLink).toBe(APPROVED[locale].line)
    expect(l.footerUseCaseLink).toBe(APPROVED[locale].useCase)
    expect(l.footerShortcutsLink).toBe(APPROVED[locale].shortcuts)
  })

  it('reuses the destination pages\' own names for the footer labels', () => {
    const d = dictionaries[locale]
    expect(d.landing.footerShortcutsLink).toBe(d.featureShortcuts.breadcrumbLabel)
    expect(d.landing.footerUseCaseLink).toBe(d.useCase.hub.breadcrumbLabel)
  })

  it('home line links to /features/shortcuts and tracks cta_location=shortcuts_link', () => {
    const { container } = renderLanding(locale)
    const line = [...container.querySelectorAll(`a[href="${shortcutsHref}"]`)].find((a) =>
      a.textContent?.includes(APPROVED[locale].line),
    )!
    expect(line).toBeTruthy()
    fireEvent.click(line)
    expect(track.mock.calls).toEqual([['landing_cta_clicked', { cta_location: 'shortcuts_link', target: 'shortcuts' }]])
  })

  it('home line is CSS-hidden for Android and not for iOS shell / PWA', () => {
    const { container } = renderLanding(locale)
    const wrapper = [...container.querySelectorAll(`a[href="${shortcutsHref}"]`)]
      .find((a) => a.textContent?.includes(APPROVED[locale].line))!.parentElement!
    expect(wrapper.className).toContain('[html[data-visitor-platform=android]_&]:hidden')
    expect(wrapper.className).not.toContain('data-native-shell')
    expect(wrapper.className).not.toContain('data-standalone')
    expect(wrapper.className).not.toContain('data-visitor-platform=ios')
  })

  it('footer: every link once, no duplicate migrate hub, use-case and shortcuts added', () => {
    const { container } = renderLanding(locale)
    const footer = container.querySelector('footer')!
    const hrefs = [...footer.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(new Set(hrefs).size).toBe(hrefs.length)
    const labels = [...footer.querySelectorAll('a')].map((a) => a.textContent)
    expect(new Set(labels).size).toBe(labels.length)
    expect(hrefs).toContain(localizedHref('/use-case', locale))
    expect(hrefs).toContain(shortcutsHref)
    expect(hrefs).not.toContain(localizedHref('/migrate', locale))
    expect(within(footer).queryByText(dictionaries[locale].landing.migrateSection.seeAll)).toBeNull()
    // the page still has the migrate hub link once, in its own section
    expect(container.querySelectorAll(`a[href="${localizedHref('/migrate', locale)}"]`)).toHaveLength(1)
  })

  it('footer shortcuts link tracks shortcuts_link too', () => {
    const { container } = renderLanding(locale)
    fireEvent.click(within(container.querySelector('footer')!).getByText(APPROVED[locale].shortcuts))
    expect(track.mock.calls).toEqual([['landing_cta_clicked', { cta_location: 'shortcuts_link', target: 'shortcuts' }]])
  })
})

describe('Android UA', () => {
  const run = (ua: string) => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua)
    new Function(landingPrePaintScript())()
    return html().getAttribute(VISITOR_PLATFORM_ATTR)
  }
  it('the pre-paint script marks Android, which the home line is hidden under; iPhone is not', () => {
    expect(run(ANDROID_UA)).toBe('android')
    expect(run(IPHONE_UA)).toBe('ios')
  })
})
