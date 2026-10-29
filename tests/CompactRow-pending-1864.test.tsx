import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render } from '@testing-library/react'
import { I18nWrapper } from './_mocks/i18n'

// #1864 — a pending row's main amount (and a foreign row's top line) renders in --ink-3; a settled
// row keeps --ink. Rendered, not read from source, so a revert of either call site turns this red.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

import { CompactRow } from '@/app/(dashboard)/dashboard/_components/CompactRow'
import { MemberProvider, type MemberContextValue } from '@/app/(dashboard)/_components/MemberContext'

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterAll(() => { vi.unstubAllGlobals() })

const member: MemberContextValue = {
  group: { id: 'g1', name: 'G', baseCurrency: 'twd' },
  viewer: { id: 'viewer-1', initial: 'V', displayName: 'Viewer', avatarUrl: null, defaultSplitType: 'half', who: 'M' },
  partner: { id: 'partner-1', initial: 'P', displayName: 'Partner', avatarUrl: null, defaultSplitType: 'half', who: 'T' },
  viewerIsA: true, isSolo: false, isPast: false, canAccessGuardian: false,
  epochStartedAt: '2026-01-01', epochEndedAt: null,
}

const base = {
  id: 'tx-1', amount: 1440, splitType: 'half' as const, splitRatioA: null,
  description: 'x', category: 'dining', paidBy: 'viewer-1', transactedAt: '2026-05-01',
  kind: 'transaction' as const,
}

/** The color of the element whose own text is exactly `text`. */
function colorOf(container: HTMLElement, text: string): string {
  const el = [...container.querySelectorAll<HTMLElement>('div,span')].find((e) => e.textContent?.trim() === text)
  if (!el) throw new Error(`no element with text ${text}: ${container.textContent}`)
  return el.style.color
}

function row(tx: Record<string, unknown>) {
  return render(
    <I18nWrapper><MemberProvider value={member}><CompactRow tx={{ ...base, ...tx }} isLast /></MemberProvider></I18nWrapper>,
  ).container
}

describe('CompactRow pending amount color (#1864)', () => {
  it('base-currency amount: --ink-3 when pending, --ink when settled', () => {
    expect(colorOf(row({ status: 'pending' }), 'NT$1,440')).toBe('var(--ink-3)')
    expect(colorOf(row({ status: 'settled' }), 'NT$1,440')).toBe('var(--ink)')
  })

  it('foreign-currency top line: --ink-3 when pending, --ink when settled', () => {
    const foreign = { originalCurrency: 'jpy', originalAmount: 8400 }
    expect(colorOf(row({ ...foreign, status: 'pending' }), '¥8,400')).toBe('var(--ink-3)')
    expect(colorOf(row({ ...foreign, status: 'settled' }), '¥8,400')).toBe('var(--ink)')
  })

  it('no row carries an opacity', () => {
    for (const status of ['pending', 'settled']) {
      const c = row({ status })
      const styled = [...c.querySelectorAll<HTMLElement>('[style]')].filter((e) => e.style.opacity !== '')
      expect(styled, status).toEqual([])
    }
  })
})
