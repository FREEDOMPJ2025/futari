import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))

const getSession = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession } }),
}))

// jsdom has no real matchMedia; LandingStandaloneRedirect's isStandalone()
// check (lib/install-guide.ts) needs it to exist at all.
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
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'

const renderLanding = () =>
  render(
    <Landing
      t={zhTW.landing}
      signInHref="/zh-TW/sign-in"
      dashboardHref="/dashboard"
      locale="zh-TW"
      showLaunchBanner
      checkingLabel={zhTW.signIn.signingIn}
      useCaseHrefs={{
        cohabitation: '/zh-TW/use-case/cohabitation',
        newlyweds: '/zh-TW/use-case/newlyweds',
        petOwners: '/zh-TW/use-case/pet-owners',
        hub: '/zh-TW/use-case',
      }}
      migrateHrefs={{
        honeydue: '/zh-TW/migrate/honeydue',
        spendee: '/zh-TW/migrate/spendee',
        cwmoney: '/zh-TW/migrate/cwmoney',
        hub: '/zh-TW/migrate',
      }}
      featureOutingHref="/zh-TW/features/outing"
      legalLinks={{
        termsHref: '/zh-TW/terms',
        termsLabel: '服務條款',
        privacyHref: '/zh-TW/privacy',
        privacyLabel: '隱私權政策',
      }}
    />,
  )

describe('Landing — ctaHint copy + mobile sign-in entry (#1277)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockReturnValue(new Promise(() => {})) // never resolves — stay logged-out
  })

  it('no longer promises registration-free trial in ctaHint', () => {
    renderLanding()
    expect(screen.getByText(zhTW.landing.ctaHint)).toBeInTheDocument()
    expect(screen.queryByText(/不需註冊/)).not.toBeInTheDocument()
  })

  it('renders a mobile-only "already have an account" link below the hint, hidden at md', () => {
    renderLanding()
    const links = screen.getAllByText(zhTW.landing.alreadyHaveAccount)
    // One is the desktop `hidden md:inline-flex` link in the CTA row; the new
    // one is the mobile-only entry below the ctaHint paragraph.
    expect(links).toHaveLength(2)

    const mobileLink = links.find((el) => el.closest('a')!.className.includes('min-h-11'))!
    expect(mobileLink).toBeDefined()
    const anchor = mobileLink.closest('a')!
    expect(anchor.parentElement!.className).toContain('md:hidden')
    expect(anchor.getAttribute('href')).toBe('/zh-TW/sign-in?from=landing')
  })

  it('gives the mobile link a >=44px touch target', () => {
    renderLanding()
    const links = screen.getAllByText(zhTW.landing.alreadyHaveAccount)
    const mobileAnchor = links.map((el) => el.closest('a')!).find((a) => a.className.includes('min-h-11'))!
    expect(mobileAnchor.className).toContain('min-h-11')
  })
})

describe('Landing — device-dependent primary CTA (#1413)', () => {
  const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ data: { session: null } })
  })

  afterEach(() => {
    delete (window as { Capacitor?: unknown }).Capacitor
  })

  it('no longer renders the retired AppStoreNote footnote', () => {
    renderLanding()
    // #1333's note is gone — its info now lives in the primary CTA itself.
    expect(screen.queryByText('iPhone 版已在 App Store')).not.toBeInTheDocument()
  })

  it('swaps the primary CTA and its mobile hint to the App Store variant for an iPhone browser visitor', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(IPHONE_UA)
    renderLanding()
    const links = await screen.findAllByText(zhTW.landing.appStoreCta)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link.closest('a')).toHaveAttribute('href', 'https://apps.apple.com/app/id6779264784?pt=128976951&ct=landing&mt=8')
    }
    expect(screen.getByText(zhTW.landing.appStoreCtaHint)).toBeInTheDocument()
  })

  it('never shows the App Store CTA inside the iOS native shell (Apple 3.1.1)', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(IPHONE_UA)
    ;(window as unknown as { Capacitor: { getPlatform: () => string } }).Capacitor = {
      getPlatform: () => 'ios',
    }
    renderLanding()
    // The pending render already shows `cta` (#1521), so let the resolver
    // effect settle explicitly before asserting no App Store variant appears.
    await act(async () => {})
    expect(screen.queryByText(zhTW.landing.appStoreCta)).not.toBeInTheDocument()
  })
})

describe('Landing — SSR CTAs work without JS (#1521)', () => {
  it('server HTML has labelled, clickable sign-in links for the header, hero and secondary CTAs', async () => {
    const { renderToString } = await import('react-dom/server')
    const html = renderToString(
      <Landing
        t={zhTW.landing}
        signInHref="/zh-TW/sign-in"
        dashboardHref="/dashboard"
        locale="zh-TW"
        showLaunchBanner
        checkingLabel={zhTW.signIn.signingIn}
        useCaseHrefs={{ cohabitation: '/a', newlyweds: '/b', petOwners: '/c', hub: '/d' }}
        migrateHrefs={{ honeydue: '/e', spendee: '/f', cwmoney: '/g', hub: '/h' }}
        featureOutingHref="/i"
        legalLinks={{ termsHref: '/t', termsLabel: 't', privacyHref: '/p', privacyLabel: 'p' }}
      />,
    )
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const anchorsWith = (label: string) =>
      [...doc.querySelectorAll('a')].filter((a) => a.textContent?.trim() === label)

    // Header CTA + hero CTA
    const primary = anchorsWith(zhTW.landing.cta)
    expect(primary.length).toBe(2)
    // Desktop secondary + mobile secondary
    const secondary = anchorsWith(zhTW.landing.alreadyHaveAccount)
    expect(secondary.length).toBe(2)
    for (const a of [...primary, ...secondary]) {
      expect(a.getAttribute('href')).toBe('/zh-TW/sign-in?from=landing')
      expect(a.hasAttribute('aria-hidden')).toBe(false)
      expect(a.hasAttribute('tabindex')).toBe(false)
      expect(a.className).not.toMatch(/pointer-events-none|opacity-0|text-transparent/)
      expect(a.innerHTML).not.toMatch(/text-transparent/)
    }
    expect(html).not.toContain('groups.google.com')
    expect(html).not.toContain('android-beta')
    // #1901: the Play badge and launch banner are server-rendered (no layout
    // shift) but every Play anchor in the SSR HTML sits inside an element the
    // pre-paint shell flag hides, so no shell ever paints one.
    const playAnchors = [...doc.querySelectorAll('a[href*="play.google.com"]')]
    expect(playAnchors.length).toBe(2)
    const hiddenInShell = (el: Element | null): boolean =>
      !!el && (el.className.includes('[html[data-native-shell]_&]:hidden') || hiddenInShell(el.parentElement))
    for (const a of playAnchors) expect(hiddenInShell(a)).toBe(true)
    // #1930: same for the App Store badge, the only apps.apple.com link in the
    // SSR HTML (the main CTA is the sign-in link until the platform resolves).
    const appAnchors = [...doc.querySelectorAll('a[href*="apps.apple.com"]')]
    expect(appAnchors.length).toBe(1)
    expect(appAnchors[0].getAttribute('href')).toContain('ct=landing-badge')
    for (const a of appAnchors) expect(hiddenInShell(a)).toBe(true)
  })
})

describe('Landing — example card (#1852)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockReturnValue(new Promise(() => {}))
  })

  it('is a figure whose caption is the one sentence screen readers get', () => {
    renderLanding()
    const fig = screen.getByRole('figure')
    // The caption is visually hidden, not aria-hidden: that is what VoiceOver reads.
    // (jsdom's accessible-name code does not derive a figure's name from its
    // figcaption, so assert on the figcaption itself rather than getByRole name.)
    const caption = fig.querySelector('figcaption')!
    expect(caption.textContent).toBe(zhTW.landing.exampleCardCaption)
    expect(caption.className).toContain('sr-only')
    expect(caption.closest('[aria-hidden="true"]')).toBeNull()
    // The visual copy sits in one aria-hidden subtree so the numbers are not read twice.
    const visual = fig.querySelector('[aria-hidden="true"]')!
    expect(visual.textContent).toContain(zhTW.landing.exampleCardTitle)
    expect(visual.textContent).toContain(zhTW.landing.exampleCardSub)
    expect(visual.textContent).toContain(zhTW.landing.exampleCardAmount)
    expect(visual.textContent).toContain(zhTW.landing.exampleCardResult)
  })

  // The card stands in for the real app screen, so its numbers have to add up
  // and its result line has to read exactly like the app's own split result.
  it.each([
    ['zh-TW', zhTW],
    ['zh-CN', zhCN],
    ['en', en],
    ['ja', ja],
  ] as const)('%s: the result is half the amount, in the app\'s wording', (_, t) => {
    const amountText = t.landing.exampleCardAmount.match(/[\d,]+/)![0]
    const resultText = t.landing.exampleCardResult.match(/[\d,]+/)![0]
    const toNumber = (s: string) => Number(s.replace(/,/g, ''))
    expect(toNumber(resultText) * 2).toBe(toNumber(amountText))
    const resultMoney = t.landing.exampleCardResult.match(/[^\s\d,]*[\d,]+/)![0]
    expect(t.landing.exampleCardResult).toBe(
      t.splitTypeSelector.partnerOwesYouAmount.replace('{amount}', resultMoney),
    )
    expect(t.landing.exampleCardCaption).toContain(amountText)
    expect(t.landing.exampleCardCaption).toContain(resultText)
  })

  it('hides from xl up and ships no image, script or interactive element', () => {
    renderLanding()
    const fig = screen.getByRole('figure')
    expect(fig.className).toContain('xl:hidden')
    expect(fig.querySelector('img, picture, svg, script, a, button')).toBeNull()
  })

  // #1901: the Google Play badge joins the CTA block (store entries together),
  // so the card now follows the sign-in link and that badge, still below the
  // CTA and above the compact trust row. #1910: on zh-TW the launch film sits
  // between the badge and the card.
  it('sits right after the mobile sign-in link, the Play badge and the zh-TW launch film, before the compact trust row', () => {
    renderLanding()
    const fig = screen.getByRole('figure')
    const mobileSignIn = screen
      .getAllByText(zhTW.landing.alreadyHaveAccount)
      .find((el) => el.closest('a')!.className.includes('min-h-11'))!
      .closest('div')!
    const badge = mobileSignIn.nextElementSibling!
    expect(badge.querySelector(`img[alt="${zhTW.landing.playBadgeAlt}"]`)).not.toBeNull()
    const film = badge.nextElementSibling!
    expect(film.getAttribute('data-testid')).toBe('launch-film')
    expect(film.nextElementSibling).toBe(fig)
  })
})
