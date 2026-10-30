import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { I18nWrapper } from './_mocks/i18n'
import { zhTW } from '@/lib/i18n/locales/zh-TW'

// #1612 acceptance 8 — in a former member's look-back, every tab or entry that
// does not follow the pin is hidden: Settings (bottom nav), the avatar menu
// (ledger name, ratio, currency, guardian), trips' 出遊 row, the trip button,
// and records' 定期 shortcut. Those act on the viewer's OWN ledger, so showing
// them inside the chapter they left would mix two ledgers on one screen. The
// PastChapterBar's exit goes home (/dashboard → own ledger or /onboarding)
// instead of refreshing a page of the left ledger.
//
// Failure look: nothing errors; tapping Settings inside the old chapter opens
// the viewer's own ledger settings under the old chapter's banner, or renames
// their own ledger from a sheet titled with the old one.

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/dynamic', () => ({ default: () => function Dyn() { return <div data-testid="avatar-sheet" /> } }))
vi.mock('@/app/(dashboard)/dashboard/_components/BrandHeaderHint', () => ({ BrandHeaderHint: () => null }))
vi.mock('@/app/(dashboard)/trips/_components/TripSheet', () => ({ TripSheet: () => null }))
const exitPastEpoch = vi.fn(async () => ({ ok: true as const, data: undefined }))
vi.mock('@/actions/epoch-view', () => ({ exitPastEpoch: () => exitPastEpoch() }))

import { MemberProvider, type MemberContextValue } from '@/app/(dashboard)/_components/MemberContext'
import { BottomNav } from '@/app/(dashboard)/_components/BottomNav'
import { BrandHeader } from '@/app/(dashboard)/dashboard/_components/BrandHeader'
import { AvatarMenuProvider, useAvatarMenu } from '@/app/(dashboard)/_components/AvatarMenuProvider'
import { PastChapterBar } from '@/app/(dashboard)/_components/PastChapterBar'
import { TripList } from '@/app/(dashboard)/trips/_components/TripList'

function member(isFormerMember: boolean): MemberContextValue {
  return {
    group: { id: 'g', name: isFormerMember ? zhTW.postLeave.newLedgerName : '我們家', baseCurrency: 'twd' },
    viewer: { id: 'b', initial: 'B', displayName: 'B', avatarUrl: null, defaultSplitType: 'half', who: 'M' },
    partner: null,
    viewerIsA: false,
    isSolo: false,
    isPast: true,
    isFormerMember,
    chapter: { partner: { id: 'a', displayName: 'A then', initial: 'A', avatarUrl: null }, isSolo: false },
    canAccessGuardian: false,
    epochStartedAt: '2026-03-01T00:00:00.000Z',
    epochEndedAt: '2026-05-01T00:00:00.000Z',
  }
}

const data = {
  viewerEmail: '', groupDefaultRatioA: null, guardianBetaEnabled: false,
  currentLocale: 'zh-TW', avatarHidden: false, hasOpenInvite: false,
}

function Shell({ former, children }: { former: boolean; children: ReactNode }) {
  return (
    <I18nWrapper>
      <MemberProvider value={member(former)}>
        <AvatarMenuProvider data={data} disabled={former}>{children}</AvatarMenuProvider>
      </MemberProvider>
    </I18nWrapper>
  )
}

const hrefs = () => Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'))

beforeEach(() => {
  // jsdom has no matchMedia (HomeIndicator reads display-mode).
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
  }))
  Object.values(router).forEach((f) => f.mockClear())
  exitPastEpoch.mockClear()
})

describe('#1612 — hidden entries in a former member\'s look-back', () => {
  it('BottomNav offers no Settings tab (control: a current member\'s past view does)', () => {
    const { unmount } = render(<Shell former><BottomNav onAddClick={() => {}} hideFab /></Shell>)
    expect(hrefs()).toEqual(['/dashboard', '/records', '/assets'])
    unmount()
    render(<Shell former={false}><BottomNav onAddClick={() => {}} hideFab /></Shell>)
    expect(hrefs()).toContain('/settings')
  })

  it('BrandHeader: no avatar-menu button and no trip button', () => {
    render(<Shell former><BrandHeader /></Shell>)
    expect(screen.queryByRole('button', { name: zhTW.settings.quickAccessRow })).toBeNull()
    expect(screen.queryByRole('button', { name: zhTW.dashboard.activeTripBanner.addAriaLabel })).toBeNull()
    // The chapter's partner is still shown, as the chapter recorded them.
    expect(screen.getAllByText('A').length).toBeGreaterThan(0)
  })

  // #1851: the header trip button is gone for everyone; the trip entry is the
  // dashboard's continuation row.
  it('BrandHeader: no trip button for a current member either', () => {
    render(<Shell former={false}><BrandHeader /></Shell>)
    expect(screen.getByRole('button', { name: zhTW.settings.quickAccessRow })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: zhTW.dashboard.activeTripBanner.addAriaLabel })).toBeNull()
  })

  it('the avatar menu cannot be opened (no sheet mounts)', () => {
    function Opener() {
      const { open } = useAvatarMenu()
      return <button type="button" onClick={open}>open</button>
    }
    render(<Shell former><Opener /></Shell>)
    act(() => { fireEvent.click(screen.getByText('open')) })
    expect(screen.queryByTestId('avatar-sheet')).toBeNull()
  })

  it('/trips has no 出遊 entry', () => {
    render(<Shell former><TripList trips={[]} baseCurrency="twd" /></Shell>)
    expect(hrefs()).not.toContain('/outings')
    expect(hrefs()).not.toContain('/settings')
  })

  it('PastChapterBar exit goes home with replace(/dashboard), not refresh', async () => {
    render(<Shell former><PastChapterBar /></Shell>)
    await act(async () => { fireEvent.click(screen.getByText(zhTW.pastTimes.bannerExitCta)) })
    expect(exitPastEpoch).toHaveBeenCalledOnce()
    expect(router.replace).toHaveBeenCalledWith('/dashboard')
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it('control: a current member\'s exit still refreshes in place', async () => {
    render(<Shell former={false}><PastChapterBar /></Shell>)
    await act(async () => { fireEvent.click(screen.getByText(zhTW.pastTimes.bannerExitCta)) })
    expect(router.refresh).toHaveBeenCalledOnce()
    expect(router.replace).not.toHaveBeenCalled()
  })
})
