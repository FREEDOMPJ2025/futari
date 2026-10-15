import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))
import { FeatureOutingCta } from '@/app/[locale]/features/outing/_components/FeatureOutingCta'
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales-meta'
import { safeSameOriginUrl } from '@/lib/auth/nativeRedirect'
import { hasTokenBearingNext } from '@/lib/analytics/tokenBearingUrl'
import { entrySourceFromParam } from '@/lib/analytics/attribution'
import { OUTING_ONBOARDING_NEXT } from '@/lib/onboarding/intent'

const ORIGIN = 'https://futari.example'

// #1633: the feature page's CTA tags the
// sign-up as entry_source feature_outing. #1726: `next` is
// /onboarding?intent=outing (same `next` rule SignedInRedirect and
// /auth/callback use), which forwards someone with a ledger to /outings and
// takes a new sign-up through setup to the new-outing sheet. A drift here is
// silent: the visitor lands on /dashboard, or the sign-up reads back as `direct`.
describe('FeatureOutingCta', () => {
  it.each(SUPPORTED_LOCALES)('%s: next resolves to the outing onboarding intent and from maps to feature_outing', (locale) => {
    render(<FeatureOutingCta locale={locale} label={`cta-${locale}`} location="feature_primary" />)
    const href = screen.getByText(`cta-${locale}`).closest('a')!.getAttribute('href')!
    const url = new URL(href, ORIGIN)
    expect(url.pathname).toBe(locale === 'zh-TW' ? '/sign-in' : `/${locale}/sign-in`)
    const next = url.searchParams.get('next')
    expect(next).toBe(OUTING_ONBOARDING_NEXT)
    expect(next).toBe('/onboarding?intent=outing')
    expect(safeSameOriginUrl(ORIGIN, next!)).toBe(`${ORIGIN}/onboarding?intent=outing`)
    expect(hasTokenBearingNext(url.searchParams.getAll('next'))).toBe(false)
    expect(entrySourceFromParam(url.searchParams.get('from'))).toBe('feature_outing')
  })
})
