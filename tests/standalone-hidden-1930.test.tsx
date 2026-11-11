import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } }),
}))

import { Landing } from '@/app/[locale]/_landing/Landing'
import { AppStoreBadge } from '@/app/[locale]/_landing/AppStoreBadge'
import { NATIVE_SHELL_ATTR, STANDALONE_ATTR, landingPrePaintScript } from '@/lib/playLaunch'
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'

// #1930 (Daphne's spec, Dev A P2-1): no store badge and no store trademark
// line inside the iOS app, the Android app, or an installed PWA. The PWA case
// uses its own `<html data-standalone>` so `data-native-shell` (which also
// drives the Play banner and /android-beta) keeps its meaning.

const STANDALONE_HIDDEN = '[html[data-standalone]_&]:hidden'
const SHELL_HIDDEN = '[html[data-native-shell]_&]:hidden'

const html = () => document.documentElement
const w = window as unknown as Record<string, unknown>

const stubMatchMedia = (standalone: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: standalone && q === '(display-mode: standalone)',
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))

const setNavStandalone = (v: boolean | undefined) =>
  Object.defineProperty(window.navigator, 'standalone', { value: v, configurable: true })

const reset = () => {
  for (const a of [NATIVE_SHELL_ATTR, STANDALONE_ATTR]) html().removeAttribute(a)
  delete w.androidBridge
  setNavStandalone(undefined)
}

beforeEach(() => {
  reset()
  stubMatchMedia(false)
})
afterEach(() => {
  cleanup()
  reset()
  vi.unstubAllGlobals()
})

const runScript = () => new Function(landingPrePaintScript())()

describe('pre-paint script writes data-standalone (#1930)', () => {
  it('display-mode: standalone -> data-standalone, not data-native-shell', () => {
    stubMatchMedia(true)
    runScript()
    expect(html().hasAttribute(STANDALONE_ATTR)).toBe(true)
    expect(html().getAttribute(STANDALONE_ATTR)).toBe('')
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(false)
  })

  it('navigator.standalone === true (iOS legacy) with matchMedia false -> data-standalone', () => {
    setNavStandalone(true)
    runScript()
    expect(html().hasAttribute(STANDALONE_ATTR)).toBe(true)
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(false)
  })

  it('a browser tab -> no data-standalone', () => {
    runScript()
    expect(html().hasAttribute(STANDALONE_ATTR)).toBe(false)
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(false)
  })

  it('native shell signal -> data-native-shell only (shell behaviour unchanged)', () => {
    w.androidBridge = {}
    runScript()
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(true)
    expect(html().hasAttribute(STANDALONE_ATTR)).toBe(false)
  })

  it('a throwing matchMedia does not make the script throw, and the rest still runs', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('boom')
    })
    w.androidBridge = {}
    expect(runScript).not.toThrow()
    expect(html().hasAttribute(STANDALONE_ATTR)).toBe(false)
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(true)
    expect(html().getAttribute('data-visitor-platform')).not.toBeNull()
  })
})

describe('useMarkStandalone (client-side navigation, #1930)', () => {
  it('badge mount marks <html> in an installed PWA', () => {
    stubMatchMedia(true)
    render(<AppStoreBadge locale="en" alt="x" />)
    expect(html().hasAttribute(STANDALONE_ATTR)).toBe(true)
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(false)
  })

  it('badge mount leaves a browser tab unmarked, and survives a missing matchMedia', () => {
    render(<AppStoreBadge locale="en" alt="x" />)
    expect(html().hasAttribute(STANDALONE_ATTR)).toBe(false)
    cleanup()
    vi.stubGlobal('matchMedia', undefined)
    expect(() => render(<AppStoreBadge locale="en" alt="x" />)).not.toThrow()
    expect(html().hasAttribute(STANDALONE_ATTR)).toBe(false)
  })
})

describe('Landing hides badges and trademark lines in an installed PWA (#1930)', () => {
  it.each(SUPPORTED_LOCALES)('%s', (locale) => {
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
    const classes = (el: Element) => el.className.split(/\s+/)
    const appWrapper = screen.getByAltText(d.landing.appStoreBadgeAlt).closest('a')!.parentElement!
    const playWrapper = screen.getByAltText(d.landing.playBadgeAlt).closest('a')!.parentElement!
    const row = appWrapper.parentElement!
    expect(row.contains(playWrapper)).toBe(true)
    const footer = container.querySelector('footer')!
    const lines = [...footer.querySelectorAll('p[lang="en"]')]
    const trademark = [d.landing.playTrademark, d.landing.appStoreTrademark].map(
      (text) => lines.find((el) => el.textContent === text)!,
    )
    expect(trademark.every(Boolean)).toBe(true)

    // Each element carries the variant itself (wrappers, row) or sits in the
    // element that does (trademark <p>s inside their hidden group).
    for (const el of [row, appWrapper, playWrapper]) {
      expect(classes(el)).toContain(STANDALONE_HIDDEN)
      expect(classes(el)).toContain(SHELL_HIDDEN)
    }
    for (const p of trademark) {
      const group = p.parentElement!
      expect(classes(group)).toContain(STANDALONE_HIDDEN)
      expect(classes(group)).toContain(SHELL_HIDDEN)
    }
    // Nothing on the page names apps.apple.com / play.google.com outside an
    // element hidden in PWAs (the trademark lines carry no link).
    const hiddenInPwa = (el: Element | null): boolean =>
      !!el && (classes(el).includes(STANDALONE_HIDDEN) || hiddenInPwa(el.parentElement))
    for (const a of container.querySelectorAll('a[href*="apps.apple.com"], a[href*="play.google.com"]')) {
      // The Play launch banner is out of scope (showLaunchBanner=false here).
      expect(hiddenInPwa(a)).toBe(true)
    }
  })
})
