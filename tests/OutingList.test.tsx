import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nWrapper } from './_mocks/i18n'

const replace = vi.hoisted(() => vi.fn())
const isPast = vi.hoisted(() => ({ value: false }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn(), replace }),
  usePathname: () => '/outings',
}))
vi.mock('@/app/(dashboard)/_components/MemberContext', () => ({
  useMember: () => ({ isPast: isPast.value }),
}))
// Stub BottomNav — its FAB/nav pulls in matchMedia + prefetch wiring out of
// scope for a list-shape test.
vi.mock('@/app/(dashboard)/_components/BottomNav', () => ({
  BottomNav: () => <div data-testid="bottom-nav" />,
}))
// Stub OutingSheet — it pulls in the createOuting server action, out of scope
// for a list-shape unit test.
vi.mock('@/app/(dashboard)/outings/_components/OutingSheet', () => ({
  OutingSheet: ({ open }: { open: boolean }) => (open ? <div data-testid="outing-sheet" /> : null),
}))

import { OutingList } from '@/app/(dashboard)/outings/_components/OutingList'
import type { OutingListRow } from '@/lib/db/queries/outing'

const wrap = (ui: React.ReactElement) => render(<I18nWrapper>{ui}</I18nWrapper>)

const row = (over: Partial<OutingListRow>): OutingListRow => ({
  id: 'o1', name: '九份兩日', status: 'active', currency: 'twd',
  createdAt: new Date('2026-06-01'), participantCount: 4, ...over,
})

describe('OutingList', () => {
  it('renders the empty state when there are no outings', () => {
    wrap(<OutingList outings={[]} />)
    expect(screen.getByText('還沒有出遊')).toBeTruthy()
  })

  it('renders an active outing row with its participant count', () => {
    wrap(<OutingList outings={[row({})]} />)
    expect(screen.getByText('九份兩日')).toBeTruthy()
    expect(screen.getByText('4 人')).toBeTruthy()
  })

  it('separates past outings under the past section with an ended tag', () => {
    wrap(<OutingList outings={[row({ id: 'o2', name: '宜蘭', status: 'ended', participantCount: 3 })]} />)
    expect(screen.getByText('宜蘭')).toBeTruthy()
    expect(screen.getByText('已結束')).toBeTruthy()
  })
})

// #1726 — end of setup for someone who came to split a trip lands on
// /outings?create=1: the new-outing sheet is already open, and the param is
// dropped so a refresh doesn't reopen it. Never in a past chapter.
describe('OutingList openCreate (#1726)', () => {
  it('opens the new-outing sheet on arrival and drops ?create=1', () => {
    replace.mockClear()
    wrap(<OutingList outings={[]} openCreate />)
    expect(screen.getByTestId('outing-sheet')).toBeTruthy()
    expect(replace).toHaveBeenCalledWith('/outings')
  })

  it('stays closed without the flag, and in a past chapter', () => {
    replace.mockClear()
    const { unmount } = wrap(<OutingList outings={[]} />)
    expect(screen.queryByTestId('outing-sheet')).toBeNull()
    expect(replace).not.toHaveBeenCalled()
    unmount()
    isPast.value = true
    wrap(<OutingList outings={[]} openCreate />)
    expect(screen.queryByTestId('outing-sheet')).toBeNull()
    isPast.value = false
  })
})
