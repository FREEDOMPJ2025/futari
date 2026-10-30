import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nWrapper } from './_mocks/i18n'
import { defaultFilter } from '@/lib/filter'
import { TransactionFeed } from '@/app/(dashboard)/_components/TransactionFeed'
import { PendingSummary } from '@/app/(dashboard)/dashboard/_components/PendingSummary'

vi.mock('@/actions/transaction', () => ({ loadMoreTransactions: vi.fn() }))
vi.mock('@/app/(dashboard)/_components/RealtimeProvider', () => ({ useRealtimeEvents: () => {} }))
vi.mock('@/lib/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }))
vi.mock('@/app/(dashboard)/_components/MemberContext', () => ({
  useMember: () => ({ viewer: { id: 'u1' }, isPast: false }),
  useViewedPartner: () => ({ partner: { id: 'u2' } }),
}))
vi.mock('@/app/(dashboard)/dashboard/_components/CompactRow', () => ({ CompactRow: () => null }))
vi.mock('@/app/(dashboard)/records/_components/MonthSection', () => ({ MonthSection: () => null }))

describe('TransactionFeed empty filtered results (#1851)', () => {
  it('keeps the label usable and removes it after clearing the filter', async () => {
    const loader = vi.fn(async () => [])
    const filter = { ...defaultFilter(), payer: 'mine' as const }
    const { rerender } = render(
      <I18nWrapper>
        <TransactionFeed
          initial={[]}
          pageSize={20}
          emptyState={<p>No matching records</p>}
          onItemClick={() => {}}
          label={<button onClick={() => clearFilter()}>Clear active filter</button>}
          filter={filter}
          loader={loader}
        />
      </I18nWrapper>,
    )
    function clearFilter() {
      rerender(
        <I18nWrapper>
          <TransactionFeed
            initial={[]}
            pageSize={20}
            emptyState={<p>No matching records</p>}
            onItemClick={() => {}}
            label={<button>Clear active filter</button>}
          />
        </I18nWrapper>,
      )
    }
    await waitFor(() => expect(loader).toHaveBeenCalledWith(null))
    const label = screen.getByRole('button', { name: 'Clear active filter' })
    expect(label).toBeInTheDocument()
    expect(label.parentElement).toHaveAttribute('class', 'px-6 pt-2 pb-1')
    expect(screen.getByText('No matching records')).toBeInTheDocument()
    fireEvent.click(label)
    expect(screen.queryByRole('button', { name: 'Clear active filter' })).not.toBeInTheDocument()
    expect(screen.getByText('No matching records')).toBeInTheDocument()
  })

  it('omits the label on an initially empty feed without a filter', () => {
    render(
      <I18nWrapper>
        <TransactionFeed initial={[]} pageSize={20} onItemClick={() => {}}
          label={<span>Feed label</span>} emptyState={<p>Empty feed</p>} />
      </I18nWrapper>,
    )
    expect(screen.queryByText('Feed label')).not.toBeInTheDocument()
    expect(screen.getByText('Empty feed')).toBeInTheDocument()
  })
})

describe('PendingSummary disclosure relationship (#1851)', () => {
  it('controls the expanded container with a stable id', () => {
    render(<I18nWrapper><PendingSummary count={2}><p>Pending stack</p></PendingSummary></I18nWrapper>)
    const toggle = screen.getByRole('button', { name: '2 筆待確認' })
    const id = toggle.getAttribute('aria-controls')
    expect(id).toBeTruthy()
    expect(document.getElementById(id!)).toBeNull()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Pending stack').parentElement).toHaveAttribute('id', id)
    fireEvent.click(toggle)
    expect(document.getElementById(id!)).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('Pending stack').parentElement).toHaveAttribute('id', id)
    fireEvent.click(toggle)
  })
})
