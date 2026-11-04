import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockDb, mockBuilder, queueDbResult, resetDbMocks } from './_mocks/db'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'
import { buildTripSettlementDescription } from '@/lib/trip/settlementDescription'
import { foldTripIntoLedger } from '@/lib/trip/endTripInTx'
import { cashTransactions } from '@/lib/db/schema'

vi.mock('@/lib/db/queries/balance', () => ({ recalcGroupBalance: vi.fn() }))

describe('trip settlement description', () => {
  describe.each([
    ['zh-TW', zhTW, '京都 結算', '旅行結算'],
    ['zh-CN', zhCN, '京都 结算', '旅行结算'],
    ['en', en, '京都 settlement', 'Trip settlement'],
    ['ja', ja, '京都の精算', '旅行の精算'],
  ] as const)('%s', (_locale, t, named, unnamed) => {
    it('uses the translated template and trims the trip name', () => {
      expect(buildTripSettlementDescription(t, '  京都  ')).toBe(named)
    })
    it('keeps $ patterns in the trip name literally', () => {
      expect(buildTripSettlementDescription(t, "$& $' 旅")).toBe(named.replace('京都', () => "$& $' 旅"))
    })
    it('uses the unnamed copy for empty and whitespace names', () => {
      expect(buildTripSettlementDescription(t, '')).toBe(unnamed)
      expect(buildTripSettlementDescription(t, ' \t\n　')).toBe(unnamed)
    })
  })
})

describe('foldTripIntoLedger description', () => {
  beforeEach(resetDbMocks)

  it('writes the supplied description to every summary row', async () => {
    queueDbResult([
      { amount: 100, paidBy: 'a', splitType: 'half', splitRatio: null },
      { amount: 200, paidBy: 'b', splitType: 'half', splitRatio: null },
    ])
    const description = 'Kyoto settlement'
    const result = await foldTripIntoLedger(mockDb as unknown as Parameters<typeof foldTripIntoLedger>[0], {
      trip: { id: 'trip-1', name: '京都', groupId: 'group-1' },
      members: { memberA: 'a', memberB: 'b' },
      description,
      transactedAt: new Date('2026-11-04T00:00:00Z'),
    })
    expect(result).toEqual({ expenseCount: 2, summaryCount: 2 })
    expect(mockDb.insert).toHaveBeenCalledWith(cashTransactions)
    expect(mockBuilder.values).toHaveBeenCalledWith([
      expect.objectContaining({ paidBy: 'a', description }),
      expect.objectContaining({ paidBy: 'b', description }),
    ])
  })
})
