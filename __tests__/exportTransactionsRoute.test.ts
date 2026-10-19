import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LedgerExport } from '@/lib/db/queries/export'

// GET /api/export/transactions — who it exports for, that no ledger is
// required, and the audit event. Everything below the route is mocked: the
// export query, translations and analytics. The scope itself is tested
// against a real database in __tests__/actions/exportChapterScope.test.ts.

const USER_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_1 = '22222222-2222-4222-8222-222222222222'
const GROUP_2 = '33333333-3333-4333-8333-333333333333'

const getCurrentUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  getCurrentUser: () => getCurrentUser(),
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}))

// The route must not need (or consult) an active ledger any more (#1460).
const getActiveGroupForUser = vi.fn()
vi.mock('@/lib/db/queries/group', () => ({
  getActiveGroupForUser: (userId: string) => getActiveGroupForUser(userId),
}))

const getLedgerExportForViewer = vi.fn()
vi.mock('@/lib/db/queries/export', () => ({
  getLedgerExportForViewer: (...args: unknown[]) => getLedgerExportForViewer(...args),
}))

vi.mock('@/lib/i18n/t', async () => {
  const { en } = await import('@/lib/i18n/locales/en')
  return { getTranslations: async () => en }
})

const captureServer = vi.fn()
vi.mock('@/lib/analytics/server', () => ({
  captureServer: (...args: unknown[]) => captureServer(...args),
}))

const { GET } = await import('@/app/api/export/transactions/route')
const { en } = await import('@/lib/i18n/locales/en')

const chapter = { startDate: '2026-01-01', endDate: null, partnerName: 'Pat' }
const base = {
  currency: 'twd', originalAmount: null, originalCurrency: null, toName: undefined,
  shares: null, status: null, notes: null, chapter,
}

const LEDGER: LedgerExport = {
  rows: [
    { ...base, kind: 'expense', date: '2026-05-09', description: 'coffee', amount: 120, category: 'dining',
      personName: 'Ray', shares: { mine: 50, theirs: 50 }, status: 'settled' },
    { ...base, kind: 'expense', date: '2026-05-08', description: '=1+1', amount: 80, category: 'dining',
      personName: 'Pat', shares: { mine: 50, theirs: 50 }, status: 'pending' },
    { ...base, kind: 'income', date: '2026-05-07', description: '+salary', amount: 5000, category: 'salary',
      personName: 'Ray' },
    { ...base, kind: 'settlement', date: '2026-05-06', description: null, amount: 40, category: null,
      personName: 'Pat', toName: 'Ray', notes: '@outing' },
  ],
  dbRows: [],
  chapters: [
    { id: 'c1', groupId: GROUP_1, startDate: '2026-01-01', endDate: '2026-03-01', memberAId: USER_ID, memberBId: 'x',
      memberAName: 'Ray', memberBName: 'Pat', memberASlotNow: 'a', memberBSlotNow: null, baseCurrency: 'twd' },
    { id: 'c2', groupId: GROUP_1, startDate: '2026-03-01', endDate: null, memberAId: USER_ID, memberBId: null,
      memberAName: 'Ray', memberBName: null, memberASlotNow: 'a', memberBSlotNow: null, baseCurrency: 'twd' },
    { id: 'c3', groupId: GROUP_2, startDate: '2025-01-01', endDate: '2025-06-01', memberAId: 'y', memberBId: USER_ID,
      memberAName: 'Kim', memberBName: 'Ray', memberASlotNow: null, memberBSlotNow: null, baseCurrency: 'jpy' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: USER_ID })
  getLedgerExportForViewer.mockResolvedValue(LEDGER)
  captureServer.mockResolvedValue(undefined)
})

describe('GET /api/export/transactions', () => {
  it('exports for the signed-in user id only, without resolving an active ledger', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(getLedgerExportForViewer).toHaveBeenCalledTimes(1)
    // #1782 — the export locale's label (en here) for marked name slots.
    expect(getLedgerExportForViewer).toHaveBeenCalledWith(USER_ID, 'Partner who left')
    expect(getActiveGroupForUser).not.toHaveBeenCalled()
  })

  it('records per-kind, chapter and group counts — and no ids', async () => {
    await GET()
    expect(captureServer).toHaveBeenCalledTimes(1)
    expect(captureServer).toHaveBeenCalledWith(USER_ID, 'transactions_exported', {
      row_count: 4,
      expense_count: 2,
      income_count: 1,
      settlement_count: 1,
      chapter_count: 3,
      group_count: 2,
    })
    const props = captureServer.mock.calls[0][2] as Record<string, unknown>
    expect(JSON.stringify(props)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('returns a spreadsheet-safe CSV attachment, every kind\'s text neutralised', async () => {
    const res = await GET()
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="futari-transactions-\d{4}-\d{2}-\d{2}\.csv"$/)
    const body = await res.text()
    expect(body).toContain(`"'=1+1"`)
    expect(body).toContain(`"'+salary"`)
    expect(body).toContain(`"'@outing"`)
    expect(body).not.toMatch(/,=1\+1,/)
    expect(body).toContain(`"${en.csvExport.types.income}"`)
    expect(body).toContain(`"${en.csvExport.types.settlement}"`)
  })

  it('a user with no ledger and nothing to export: 200 with a header-only CSV', async () => {
    getActiveGroupForUser.mockResolvedValue(null)
    getLedgerExportForViewer.mockResolvedValue({ rows: [], dbRows: [], chapters: [] })
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body.replace(/^﻿/, '').split('\r\n')).toEqual([
      Object.values(en.csvExport.columns).map((c) => `"${c}"`).join(','),
      '',
    ])
    expect(captureServer).toHaveBeenCalledWith(USER_ID, 'transactions_exported', {
      row_count: 0, expense_count: 0, income_count: 0, settlement_count: 0, chapter_count: 0, group_count: 0,
    })
  })

  it('401 without a user, no query and no event', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
    expect(getLedgerExportForViewer).not.toHaveBeenCalled()
    expect(captureServer).not.toHaveBeenCalled()
  })
})
