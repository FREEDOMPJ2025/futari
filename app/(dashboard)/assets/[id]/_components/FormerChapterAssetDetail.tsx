'use client'

import { useRouter } from 'next/navigation'
import { BottomNav } from '@/app/(dashboard)/_components/BottomNav'
import { SubpageHeader } from '@/app/(dashboard)/_components/SubpageHeader'
import { TransactionFeed } from '@/app/(dashboard)/_components/TransactionFeed'
import { loadMoreTransactionsForAsset, type PagedTxnRow } from '@/actions/transaction'
import { loadMoreInsuranceReturns, type PagedIncomeRow } from '@/actions/income'
import type { TxnCursor } from '@/lib/db/queries/transactions'
import { SAVINGS_RETURN_CATEGORIES } from '@/lib/incomeCategories'
import { incomeToFeedRow } from '@/lib/incomeFeedRow'
import { unwrapAction } from '@/lib/action-errors'
import { useTranslations } from '@/lib/i18n/client'
import { MoneyLine, SectionHeader } from './aibutsu-ui'
import { FuelRow } from './FuelRow'

const RETURN_CATEGORIES: string[] = [...SAVINGS_RETURN_CATEGORIES]

/** A fuel log of the chapter, as FuelRow draws it. */
export interface FormerChapterFuelLog {
  id: string
  liters: string
  odometer: number
  station: string | null
  loggedAt: string
  prevOdometer: number | null
}

interface Props {
  assetId: string
  name: string
  /** Spending linked to this asset inside the chapter window. */
  chapterTotal: number
  /** The asset's expense rows inside the chapter (premiums, for a policy). */
  initialTxns: PagedTxnRow[]
  /** Car only: fuel logs inside the chapter, keyed into the expense rows. */
  fuelLogs: FormerChapterFuelLog[]
  /** Insurance only: returns received inside the chapter; null otherwise. */
  initialReturns: PagedIncomeRow[] | null
  pageSize: number
}

/**
 * #1612 — /assets/[id] for a former member looking back at a chapter of a
 * ledger they left. Owner decision (2026-10-13): the asset's name and that
 * chapter's money — spend, fuel logs, premiums and returns inside the chapter
 * window — and nothing else. No current field values, notes, template fields,
 * PII placeholders or reveal buttons, no policy holder / insured, no edit or
 * add affordance. Every feed's loader is a pin-following read action bounded
 * by the chapter window.
 */
export function FormerChapterAssetDetail({
  assetId, name, chapterTotal, initialTxns, fuelLogs, initialReturns, pageSize,
}: Props) {
  const router = useRouter()
  const t = useTranslations()
  const fuelLogMap = new Map(fuelLogs.map((f) => [f.id, f]))
  const isPolicy = initialReturns !== null

  const returnLoader = async (cursor: TxnCursor | null): Promise<PagedTxnRow[]> => {
    const incomeCursor = cursor
      ? { occurredAt: cursor.transactedAt.substring(0, 10), createdAt: cursor.createdAt }
      : null
    const rows = unwrapAction(await loadMoreInsuranceReturns(assetId, RETURN_CATEGORIES, incomeCursor, pageSize))
    return rows.map(incomeToFeedRow)
  }

  const empty = (
    <div className="text-center py-8 text-sm text-ink-3">
      {t.assetDetail.emptyDefaultLine1}
    </div>
  )

  return (
    <div className="min-h-screen pb-28 bg-bg">
      <SubpageHeader
        title={name}
        backLabel={t.common.back}
        onBack={() => router.push('/assets')}
        titleAs="h1"
      />

      <MoneyLine month={0} total={chapterTotal} isPast />

      <SectionHeader>
        {isPolicy ? t.assetDetail.savings.sectionPremium : t.assetDetail.recentExpenses}
      </SectionHeader>
      <div className="mx-4">
        <TransactionFeed
          initial={initialTxns}
          pageSize={pageSize}
          loader={async (cursor) => unwrapAction(await loadMoreTransactionsForAsset(assetId, cursor, pageSize))}
          acceptInsert={() => false}
          onItemClick={() => {}}
          emptyState={empty}
          renderRow={(tx) => {
            const fuelLog = tx.fuelLogId !== null ? fuelLogMap.get(tx.fuelLogId) : undefined
            return fuelLog ? <FuelRow fuelLog={fuelLog} amount={tx.amount} /> : undefined
          }}
        />
      </div>

      {initialReturns !== null && initialReturns.length > 0 && (
        <>
          <SectionHeader>{t.assetDetail.savings.sectionReturn}</SectionHeader>
          <div className="mx-4">
            <TransactionFeed
              initial={initialReturns.map(incomeToFeedRow)}
              pageSize={pageSize}
              loader={returnLoader}
              acceptInsert={() => false}
              onItemClick={() => {}}
              emptyState={null}
            />
          </div>
        </>
      )}

      <BottomNav onAddClick={() => {}} hideFab />
    </div>
  )
}
