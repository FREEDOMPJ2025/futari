import { describe, it, expect, vi } from 'vitest'
import { Suspense } from 'react'
import { act, render, screen } from '@testing-library/react'
import { I18nWrapper } from './_mocks/i18n'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { defaultFilter } from '@/lib/filter'

// #1866 — a dashboard filter that matches nothing says 「沒有符合條件的紀錄」 (feed.noFiltered, as
// the records page does) under the still-visible filter row; with no filter, an empty ledger keeps
// its 「記第一筆」 empty state. No separate clear button: the filter row above is the way out.

vi.mock('@/actions/transaction', () => ({ loadMoreTransactions: vi.fn(async () => []) }))
vi.mock('@/app/(dashboard)/_components/RealtimeProvider', () => ({ useRealtimeEvents: () => {} }))
vi.mock('@/lib/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }))
vi.mock('@/app/(dashboard)/_components/MemberContext', () => ({
  useMember: () => ({ viewer: { id: 'u1' }, isPast: false }),
  useViewedPartner: () => ({ partner: { id: 'u2' } }),
}))

import { DashboardFeed } from '@/app/(dashboard)/dashboard/_components/DashboardFeed'

async function feed(filter: ReturnType<typeof defaultFilter> | null) {
  const data = Promise.resolve({ recent: [], recentIncomeFeed: [] })
  await act(async () => {
    render(
      <I18nWrapper>
        <Suspense fallback={null}>
          <DashboardFeed
            feedDataPromise={data} mode="expense" pageSize={20} filter={filter}
            onItemClick={() => {}} onAddIncome={() => {}} onAddTx={() => {}}
            header={(title) => <div>{title}<button>篩選列</button></div>}
          />
        </Suspense>
      </I18nWrapper>,
    )
  })
}

describe('DashboardFeed filtered empty state (#1866)', () => {
  it('a filter with 0 results shows feed.noFiltered under the filter row, and no 記第一筆', async () => {
    await feed({ ...defaultFilter(), payer: 'mine' })
    expect(await screen.findByText(zhTW.feed.noFiltered)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '篩選列' })).toBeInTheDocument()
    expect(screen.queryByText(zhTW.feed.noRecordsTitle)).not.toBeInTheDocument()
  })

  it('no filter and 0 records keeps the 還沒有紀錄／記第一筆 empty state, without the filter row', async () => {
    await feed(null)
    expect(await screen.findByText(zhTW.feed.noRecordsTitle)).toBeInTheDocument()
    expect(screen.queryByText(zhTW.feed.noFiltered)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '篩選列' })).not.toBeInTheDocument()
  })
})
