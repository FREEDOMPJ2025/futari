'use client'

import { use, useCallback, useMemo, type ReactNode } from 'react'
import { TransactionFeed } from '@/app/(dashboard)/_components/TransactionFeed'
import { EmptyState } from './EmptyState'
import { IncomeEmptyState } from './IncomeEmptyState'
import { toWire, type TxnFilter } from '@/lib/filter'
import type { PagedTxnRow } from '@/actions/transaction'
import { makeIncomeLoader } from '@/lib/incomeFeedRow'
import { renderIncomeFeedRow } from './IncomeFeedRow'
import { useTranslations } from '@/lib/i18n/client'
import type { DashboardFeedData } from './Dashboard'

interface DashboardFeedProps {
  feedDataPromise: Promise<DashboardFeedData>
  mode: 'expense' | 'income'
  pageSize: number
  filter: TxnFilter | null
  onItemClick: (tx: PagedTxnRow) => void
  onAddIncome: () => void
  onAddTx: () => void
  /** #1851 — wraps the list's 「最近紀錄」 title, so the 篩選 row can head the
   *  records it filters. Absent (solo): the title alone, as before. */
  header?: (title: ReactNode) => ReactNode
}

export function DashboardFeed({
  feedDataPromise,
  mode,
  pageSize,
  filter,
  onItemClick,
  onAddIncome,
  onAddTx,
  header,
}: DashboardFeedProps) {
  const { recent, recentIncomeFeed } = use(feedDataPromise)
  const t = useTranslations()
  const title = (
    <span className="text-xs font-medium tracking-[0.5px]" style={{ color: 'var(--ink-2)' }}>
      {t.feed.header}
    </span>
  )

  const incomeRenderRow = useCallback(
    (tx: PagedTxnRow) => renderIncomeFeedRow(tx, onItemClick),
    [onItemClick],
  )

  // Income loader closes over the active filter so the income feed responds
  // to L3 chip changes the same way the cash feed does — TransactionFeed
  // calls loader(null) on filter-prop change. Recreated each filter ref
  // change; stable while filter is null.
  const incomeLoader = useMemo(
    () => makeIncomeLoader(20, undefined, undefined, filter ? toWire(filter) : undefined),
    [filter],
  )

  return (
    <TransactionFeed
      key={mode}
      initial={mode === 'income' ? recentIncomeFeed : recent}
      pageSize={pageSize}
      onItemClick={onItemClick}
      filter={filter ?? undefined}
      loader={mode === 'income' ? incomeLoader : undefined}
      renderRow={mode === 'income' ? incomeRenderRow : undefined}
      denseMonths
      label={header ? header(title) : <div className="flex items-end justify-between">{title}</div>}
      emptyState={
        // A filter that matches nothing is not an empty ledger (#1866): say so, the way the
        // records page does, instead of inviting a first record. The filter row stays above
        // (#1851), so clearing it there brings the usual empty state back.
        filter
          ? <div className="px-6 py-16 text-center text-sm" style={{ color: 'var(--ink-3)' }}>{t.feed.noFiltered}</div>
          : mode === 'income'
            ? <IncomeEmptyState onAdd={onAddIncome} />
            : <EmptyState onAdd={onAddTx} />
      }
    />
  )
}

export function DashboardFeedSkeleton() {
  const t = useTranslations()
  return (
    <>
      <div className="px-6 pt-2 pb-1">
        <span className="text-xs font-medium tracking-[0.5px]" style={{ color: 'var(--ink-2)' }}>
          {t.feed.header}
        </span>
      </div>
      <div className="px-6 pt-2 pb-1">
        <div className="h-4 w-24 rounded animate-pulse" style={{ background: 'var(--surface)', opacity: 0.6 }} />
      </div>
      <div
        className="mx-4 rounded-tile overflow-hidden"
        style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-[68px] animate-pulse"
            style={{
              background: 'var(--surface)',
              opacity: 0.6,
              borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
            }}
          />
        ))}
      </div>
    </>
  )
}
