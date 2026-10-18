/**
 * #1528 F4: the outing cross-link has no <h2>, so it must not be a `.bi-band`
 * (heading rail + content grid from 1024px) or its lone list lands in the 240px
 * heading column. Failure looks like a 240px-wide strip with one character per
 * line on /use-case, /use-case/travel and /migrate/splitwise at >=1024px.
 */
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))

import { FeatureLinkSection } from '@/app/[locale]/use-case/_components/FeatureLinkSection'

describe('FeatureLinkSection (#1528 F4)', () => {
  it.each(['zh-TW', 'en', 'ja'] as const)('is a plain flow child, not a heading band (%s)', (locale) => {
    const { container } = render(<FeatureLinkSection locale={locale} source="use_case_hub" />)
    const section = container.querySelector('section')!
    expect(section.className).not.toContain('bi-band')
    expect(section.querySelector('h2')).toBeNull()
    expect(section.getAttribute('aria-label')).toBeTruthy()
    expect(section.querySelector('a[href*="/features/outing"]')).not.toBeNull()
  })
})
