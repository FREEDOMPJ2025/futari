/**
 * #1724 — /features/outing gets inbound links from the home page (feature
 * list + footer), the /use-case hub and /migrate/splitwise, in every locale,
 * with anchors that carry the outing search phrase (#1725 keywords), and each
 * click is attributed by a fixed `source`.
 *
 * What failure looks like: nothing errors. A dropped link or a generic anchor
 * just means Google keeps reporting the page as unknown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

const track = vi.hoisted(() => vi.fn())
vi.mock('@/lib/analytics/track', () => ({ track, analyticsReady: async () => {}, getAnonId: () => undefined }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } }),
}))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('notFound') },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
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
import UseCaseHubPage from '@/app/[locale]/use-case/page'
import sitemap from '@/app/sitemap'
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'
import { localizedHref } from '@/lib/i18n/path'
import { MIGRATE_SOURCES, type SourceDef } from '@/lib/migrate/sources'
import { USE_CASES } from '@/lib/use-case/cases'

/** The #1725 target phrase each locale's anchors must carry. */
const KEYWORD: Record<Locale, RegExp> = {
  'zh-TW': /出遊分帳/,
  'zh-CN': /出游分账/,
  en: /split trip costs/i,
  ja: /割り勘/,
}

const outingHref = (locale: Locale) => localizedHref('/features/outing', locale)

beforeEach(() => track.mockClear())

describe.each(SUPPORTED_LOCALES)('%s', (locale) => {
  const d = dictionaries[locale]

  it('anchors carry the outing search phrase, not a generic "learn more"', () => {
    expect(d.landing.featuresOutingLink).toMatch(KEYWORD[locale])
    expect(d.landing.footerOutingLink).toMatch(KEYWORD[locale])
    expect(d.featureOuting.crossLink.name).toMatch(KEYWORD[locale])
    for (const s of [d.landing.featuresOutingLink, d.landing.footerOutingLink, d.featureOuting.crossLink.name]) {
      expect(s).not.toMatch(/[!！]/)
    }
  })

  it('home page links to the outing page from the feature list and the footer', () => {
    const { container } = render(
      <Landing
        t={d.landing}
        signInHref={localizedHref('/sign-in', locale)}
        dashboardHref="/dashboard"
        androidBetaHref={localizedHref('/android-beta', locale)}
        checkingLabel={d.signIn.signingIn}
        useCaseHrefs={{ cohabitation: '/a', newlyweds: '/b', petOwners: '/c', hub: '/d' }}
        migrateHrefs={{ honeydue: '/e', spendee: '/f', cwmoney: '/g', hub: '/h' }}
        featureOutingHref={outingHref(locale)}
        legalLinks={{ termsHref: '/t', termsLabel: 't', privacyHref: '/p', privacyLabel: 'p' }}
      />,
    )
    const links = [...container.querySelectorAll(`a[href="${outingHref(locale)}"]`)]
    expect(links).toHaveLength(2)

    const features = links.find((a) => a.textContent?.includes(d.landing.featuresOutingLink))!
    const footer = within(container.querySelector('footer')!).getByText(d.landing.footerOutingLink)
    expect(features).toBeTruthy()
    expect(footer.getAttribute('href')).toBe(outingHref(locale))

    fireEvent.click(features)
    fireEvent.click(footer)
    expect(track.mock.calls).toEqual([
      ['feature_outing_link_clicked', { source: 'landing_features' }],
      ['feature_outing_link_clicked', { source: 'landing_footer' }],
    ])
  })

  it('/use-case hub links to the outing page', async () => {
    render(await UseCaseHubPage({ params: Promise.resolve({ locale }) }))
    const link = screen.getByText(d.featureOuting.crossLink.name).closest('a')!
    expect(link.getAttribute('href')).toBe(outingHref(locale))
    fireEvent.click(link)
    expect(track).toHaveBeenCalledWith('feature_outing_link_clicked', { source: 'use_case_hub' })
  })
})

describe('inbound link count', () => {
  it('splitwise is the migrate source that links to outings', () => {
    const linking = Object.values(MIGRATE_SOURCES as Record<string, SourceDef>)
      .filter((s) => s.featureLinks?.includes('outing'))
      .map((s) => s.slug)
    expect(linking).toEqual(['splitwise'])
  })

  it('the outing page has at least 3 inbound brand-page links in every locale', () => {
    // Every source below renders for all four locales from one registry/page.
    const inbound = [
      'landing_features',
      'landing_footer',
      'use_case_hub',
      ...Object.values(MIGRATE_SOURCES as Record<string, SourceDef>).filter((s) => s.featureLinks?.includes('outing')).map((s) => `migrate_${s.slug}`),
      ...Object.values(USE_CASES).filter((c) => c.featureLinks?.includes('outing')).map((c) => `use_case_${c.slug}`),
    ]
    expect(inbound.length).toBeGreaterThanOrEqual(3)
  })
})

describe('sitemap', () => {
  it('re-dates the pages whose links changed', () => {
    const lastmod = (path: string) =>
      sitemap().find((e) => e.url.endsWith(localizedHref(path, 'en')))?.lastModified
    for (const path of ['/', '/use-case', '/features/outing', '/migrate/splitwise']) {
      expect(String(lastmod(path)) >= '2026-10-15').toBe(true)
    }
  })
})
