import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setMockUser } from './_mocks/supabase'
import { queueDbResult, resetDbMocks } from './_mocks/db'

// #1764 — every path that writes a user-made CashTransaction sends
// `record_created` with a `via` naming the path, and the server events that
// join the funnel carry `group_id`.
//
// What it looks like when this regresses: nothing errors. The activation
// metric (`record_created >= 1`, see observability-design.md) quietly drops
// the people who only use recurring confirms, fuel logs, imports or trip
// summaries, and the curve stays smooth.

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() })),
}))
vi.mock('@/lib/analytics/server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/analytics/server')>('@/lib/analytics/server')
  return { ...actual, captureServer: vi.fn(async () => {}) }
})
// The fold itself is covered elsewhere; here it only has to report how many
// summary rows it wrote.
const fold = vi.hoisted(() => ({ summaryCount: 1 }))
vi.mock('@/lib/trip/endTripInTx', () => ({
  foldTripIntoLedger: vi.fn(async () => ({ expenseCount: 3, summaryCount: fold.summaryCount })),
}))

import { captureServer } from '@/lib/analytics/server'
import { createTransaction } from '@/actions/transaction'
import { createIncome } from '@/actions/income'
import { createGroup } from '@/actions/group'
import { createFuelLog } from '@/actions/fuelLog'
import { confirmPending, editAndConfirmPending } from '@/actions/recurringExpense'
import { createCar, createHouse, createLifeEntity } from '@/actions/asset'
import { importCsvBatch } from '@/actions/import'
import { endTrip } from '@/actions/trip'

const VIEWER = { id: 'user-a', email: 'a@example.com' }
const GROUP = { id: 'grp-1', memberA: 'user-a', memberB: 'user-b', name: '我們家', baseCurrency: 'TWD', currentEpochStartedAt: new Date('2026-01-01T00:00:00Z') }
const OPEN_EPOCH = { id: 'epoch-current', groupId: 'grp-1', startedAt: '2026-01-01', endedAt: null, memberAId: 'user-a', memberBId: 'user-b' }

const capture = vi.mocked(captureServer)
const eventsNamed = (name: string) => capture.mock.calls.filter((c) => c[1] === name)

beforeEach(() => {
  resetDbMocks()
  capture.mockClear()
  fold.summaryCount = 1
  setMockUser(VIEWER)
})

describe('record_created — one emit per record path', () => {
  it('manual: createTransaction', async () => {
    queueDbResult([GROUP]); queueDbResult([OPEN_EPOCH])
    queueDbResult([{ id: 'tx-1' }]); queueDbResult([]); queueDbResult([{ count: 1 }])
    await createTransaction({ amount: 100, description: '午餐', category: 'dining', splitType: 'half', payerId: 'user-a', transactedAt: '2026-05-03' })
    const rc = eventsNamed('record_created')
    expect(rc).toHaveLength(1)
    expect(rc[0][0]).toBe('user-a')
    expect(rc[0][2]).toMatchObject({ via: 'manual', group_id: 'grp-1' })
  })

  it('recurring_confirm: confirmPending, also when it is not the first record', async () => {
    queueDbResult([GROUP]); queueDbResult([OPEN_EPOCH])
    queueDbResult([{
      id: 'pend-1', groupId: GROUP.id, proposedAmount: 25000, proposedDate: '2026-06-01',
      proposedDescription: '房租', proposedPaidBy: 'user-a', proposedSplitType: 'half',
      category: 'housing', assetId: null,
    }])
    queueDbResult([{ id: 'tx-1' }]); queueDbResult([{ id: 'pend-1' }]); queueDbResult([]); queueDbResult([{ count: 5 }])
    await confirmPending('pend-1')
    expect(eventsNamed('first_record_created')).toHaveLength(0)
    const rc = eventsNamed('record_created')
    expect(rc).toHaveLength(1)
    expect(rc[0][2]).toEqual({ via: 'recurring_confirm', group_id: 'grp-1' })
  })

  it('recurring_confirm: editAndConfirmPending', async () => {
    queueDbResult([GROUP]); queueDbResult([OPEN_EPOCH])
    queueDbResult([{
      id: 'pend-1', groupId: GROUP.id, proposedAmount: 25000, proposedDate: '2026-06-01',
      proposedDescription: '房租', proposedPaidBy: 'user-a', proposedSplitType: 'half',
      ruleCategory: 'housing', ruleAssetId: null,
    }])
    queueDbResult([{ id: 'tx-2' }]); queueDbResult([{ id: 'pend-1' }]); queueDbResult([]); queueDbResult([{ count: 5 }])
    await editAndConfirmPending({ pendingId: 'pend-1', overrides: { amount: 26000 } })
    const rc = eventsNamed('record_created')
    expect(rc).toHaveLength(1)
    expect(rc[0][2]).toEqual({ via: 'recurring_confirm', group_id: 'grp-1' })
  })

  it('fuel_log: createFuelLog', async () => {
    queueDbResult([GROUP]); queueDbResult([OPEN_EPOCH])
    queueDbResult([{ id: 'asset-1', deletedAt: null }])
    queueDbResult([{ id: 'fuel-log-id' }]); queueDbResult([{ id: 'txn-id' }]); queueDbResult([]); queueDbResult([{ count: 5 }])
    await createFuelLog({ assetId: 'asset-1', liters: 36.2, odometer: 86420, cost: 1340, fuelType: '95', loggedAt: '2026-05-05', station: '中油', paidBy: 'user-a', splitType: 'all_mine' })
    const rc = eventsNamed('record_created')
    expect(rc).toHaveLength(1)
    expect(rc[0][2]).toEqual({ via: 'fuel_log', group_id: 'grp-1' })
  })

  it('asset_purchase: createCar with a price; asset_created carries group_id', async () => {
    queueDbResult([GROUP]); queueDbResult([OPEN_EPOCH])
    queueDbResult([{ id: 'asset-1' }]); queueDbResult([]); queueDbResult([]); queueDbResult([]); queueDbResult([{ count: 5 }])
    await createCar({ name: '車', plate: 'ABC-1234', purchasePrice: 800000 })
    expect(eventsNamed('record_created').map((c) => c[2])).toEqual([{ via: 'asset_purchase', group_id: 'grp-1' }])
    expect(eventsNamed('asset_created')[0][2]).toEqual({ asset_type: 'car', group_id: 'grp-1' })
  })

  it('asset_purchase: createCar without a price writes no record', async () => {
    queueDbResult([GROUP]); queueDbResult([OPEN_EPOCH])
    queueDbResult([{ id: 'asset-1' }])
    await createCar({ name: '車', plate: 'ABC-1234' })
    expect(eventsNamed('record_created')).toHaveLength(0)
    expect(eventsNamed('asset_created')[0][2]).toEqual({ asset_type: 'car', group_id: 'grp-1' })
  })

  it('asset_purchase: createHouse with a price', async () => {
    queueDbResult([GROUP]); queueDbResult([OPEN_EPOCH])
    queueDbResult([{ id: 'asset-1' }]); queueDbResult([]); queueDbResult([]); queueDbResult([]); queueDbResult([{ count: 5 }])
    await createHouse({ name: '家', purchasePrice: 10000000 })
    expect(eventsNamed('record_created').map((c) => c[2])).toEqual([{ via: 'asset_purchase', group_id: 'grp-1' }])
    expect(eventsNamed('asset_created')[0][2]).toEqual({ asset_type: 'house', group_id: 'grp-1' })
  })

  it('asset_created carries group_id on the other create paths (createLifeEntity)', async () => {
    queueDbResult([GROUP]); queueDbResult([{ id: 'asset-1' }])
    await createLifeEntity({ type: 'pet', name: '豆豆' } as never)
    expect(eventsNamed('asset_created')[0][2]).toMatchObject({ group_id: 'grp-1' })
  })

  it('import: ONE event per import with count, not one per row', async () => {
    queueDbResult([GROUP]); queueDbResult([OPEN_EPOCH])
    queueDbResult([{ id: 'batch-1' }])
    const row = { type: 'expense' as const, amount: 100, date: '2026-01-15', category: 'dining', description: '便利商店', paidBy: 'a' as const, splitType: 'all_mine' as const }
    await importCsvBatch({
      source: 'futari_generic' as never, fileName: 'a.csv', totalRows: 3,
      rows: [row, row, { ...row, type: 'income' as const }], errors: [],
    })
    const rc = eventsNamed('record_created')
    expect(rc).toHaveLength(1)
    expect(rc[0][2]).toEqual({ via: 'import', count: 2, group_id: 'grp-1' })
    expect(eventsNamed('import_completed')[0][2]).toMatchObject({ group_id: 'grp-1' })
  })

  it('import: an income-only import is not a record', async () => {
    queueDbResult([GROUP]); queueDbResult([OPEN_EPOCH]); queueDbResult([{ id: 'batch-1' }])
    await importCsvBatch({
      source: 'futari_generic' as never, fileName: 'a.csv', totalRows: 1,
      rows: [{ type: 'income', amount: 100, date: '2026-01-15', category: 'salary', description: '薪水', paidBy: 'a', splitType: 'all_mine' }], errors: [],
    })
    expect(eventsNamed('record_created')).toHaveLength(0)
    expect(eventsNamed('import_completed')).toHaveLength(1)
  })

  it('trip_summary: endTrip fires once when the fold wrote rows, not when it wrote none', async () => {
    const run = async () => {
      capture.mockClear()
      queueDbResult([GROUP]); queueDbResult([OPEN_EPOCH])
      queueDbResult([{ id: 'trip-1', epochId: 'epoch-current', name: '京都', startDate: '2026-03-01', defaultCurrency: 'TWD', endedAt: new Date() }])
      queueDbResult([{ id: 'epoch-current' }])  // lockOpenEpochForWrite
      queueDbResult([GROUP])                     // members
      queueDbResult([{ count: 1 }])
      await endTrip({ tripId: 'trip-1', endDate: '2026-03-05' })
    }
    await run()
    expect(eventsNamed('record_created').map((c) => c[2])).toEqual([{ via: 'trip_summary', group_id: 'grp-1' }])
    fold.summaryCount = 0
    await run()
    expect(eventsNamed('record_created')).toHaveLength(0)
  })
})

describe('group_id on the other server events', () => {
  it('income_created', async () => {
    queueDbResult([GROUP]); queueDbResult([OPEN_EPOCH]); queueDbResult([{ id: 'inc-1' }])
    await createIncome({ amount: 30000, category: 'salary', recipientId: 'user-a', occurredAt: '2026-05-01', source: '薪水', assetId: null })
    expect(eventsNamed('income_created')[0][2]).toMatchObject({ group_id: 'grp-1' })
    expect(eventsNamed('record_created')).toHaveLength(0)
  })

  it('setup_completed', async () => {
    queueDbResult([]); queueDbResult([{ id: 'user-a' }]); queueDbResult([{ live: true }]); queueDbResult([])
    queueDbResult([{ id: 'grp-new', name: '我們家', memberA: 'user-a', memberB: null, baseCurrency: 'TWD' }])
    await createGroup('我們家')
    expect(eventsNamed('setup_completed')[0][2]).toMatchObject({ solo: true, group_id: 'grp-new' })
  })
})

