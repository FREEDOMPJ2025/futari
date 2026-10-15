import { notFound, redirect } from 'next/navigation'
import { requireViewerOrRedirect } from '@/lib/auth/viewer'
import { getEpochMembers, resolveViewerEpochContext } from '@/lib/db/queries/epoch'
import { getTripInChapter } from '@/lib/db/queries/trips'
import { listTripExpenses, countTripExpensesByCurrency } from '@/lib/db/queries/tripExpense'
import { listRatesForGroup } from '@/lib/db/queries/currencyRates'
import { parseTripCurrencySnapshot } from '@/lib/trip-currency'
import { isUuid } from '@/lib/outing/validate'
import type { CurrencyCode } from '@/lib/currency'
import type { TripOption } from '@/app/(dashboard)/dashboard/_components/TripSelector'
import type { RateEntry } from '@/app/(dashboard)/dashboard/_components/AddSheet'
import { TripDetailClient, type TripDetailRecord } from './_components/TripDetailClient'

export default async function TripDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const { user } = await requireViewerOrRedirect()

  // #1614 — a trip is readable only inside the chapter being viewed: the open
  // chapter, or a pinned one (same rule as the monthly review). The group
  // follows the pin too, so it matches the layout's chapter identity that
  // TripDetailClient labels payers with.
  const context = await resolveViewerEpochContext(user.id)
  if (!context) redirect('/onboarding')
  const { group, window: epochWindow } = context
  if (!epochWindow.epochId || !isUuid(id)) notFound()

  // The chapter check runs before any expense or rate query: a trip of
  // another chapter is not found, and nothing of it is loaded or serialised.
  const trip = await getTripInChapter(id, group.id, epochWindow.epochId)
  if (!trip) notFound()

  // #1612 — a former member looking back at a chapter of a ledger they left:
  // no live ledger state (rates, default ratio), and the A/B frame is the
  // chapter row's, not the group row's today (getEpochMembers' caller
  // contract holds: the epoch id came from resolveViewerEpochContext).
  const formerChapter = context.isFormerMemberView ? await getEpochMembers(epochWindow.epochId) : null
  const frameMemberA = context.isFormerMemberView ? (formerChapter?.memberAId ?? null) : group.memberA

  const [rawExpenses, rawRates, usedCurrencyCounts] = await Promise.all([
    listTripExpenses(trip.id),
    context.isFormerMemberView ? Promise.resolve([]) : listRatesForGroup(group.id),
    countTripExpensesByCurrency(trip.id),
  ])

  const rateSnapshot = parseTripCurrencySnapshot(
    trip.rateSnapshot,
    trip.defaultCurrency ?? group.baseCurrency,
  )

  // TripExpenses store `splitRatio` as the payer's share %. The shared
  // CompactRow component expects `splitRatioA` (member A's share %), so we
  // re-frame here against the group's members.
  const records: TripDetailRecord[] = rawExpenses.map((r) => {
    const splitRatioA = r.splitRatio == null
      ? null
      : r.paidBy === frameMemberA
        ? r.splitRatio
        : 100 - r.splitRatio
    return {
      id: r.id,
      amount: r.amount,
      splitType: r.splitType,
      splitRatioA,
      description: r.description ?? '',
      category: r.category,
      paidBy: r.paidBy,
      transactedAt: r.transactedAt.toISOString(),
      originalCurrency: r.originalCurrency,
      originalAmount: r.originalAmount,
    }
  })

  // Trip-detail FAB only needs this trip itself in the selector pool — the
  // record is locked to this trip via prefilledTripId. We still pass the row
  // so AddSheet can cascade defaultCurrency on open.
  const activeTrips: TripOption[] = [{
    id: trip.id,
    name: trip.name,
    defaultCurrency: trip.defaultCurrency,
    startDate: trip.startDate,
    endDate: trip.endDate ?? null,
    currencies: rateSnapshot,
  }]

  const rates: RateEntry[] = rawRates.map((r) => ({
    fromCurrency: r.fromCurrency,
    toCurrency: r.toCurrency,
    rate: r.rate,
  }))

  return (
    <TripDetailClient
      trip={{
        id: trip.id,
        name: trip.name,
        startDate: trip.startDate,
        endDate: trip.endDate,
        defaultCurrency: trip.defaultCurrency,
        rateSnapshot,
        usedCurrencyCounts,
        status: trip.status,
      }}
      records={records}
      baseCurrency={group.baseCurrency}
      groupDefaultRatioA={context.isFormerMemberView ? null : (group.defaultSplitRatioA ?? null)}
      activeTrips={activeTrips}
      rates={rates}
    />
  )
}
