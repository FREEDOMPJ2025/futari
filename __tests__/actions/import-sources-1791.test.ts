import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { seedAuthUsers, deleteAuthUsers } from './_authUser'

// ─── #1791 — an AndroMoney file, through the real parser/mapper and then the
// real importCsvBatch, lands as the right records ───────────────────────────
//
// processFile (banner skip, Big5 decode, AndroMoney mapper) -> the payload the
// wizard builds (same shape as ImportContent.buildBatchInput: local-day date
// string, payer, split) -> importCsvBatch -> Postgres. Asserts what is STORED:
//   - the expense is a CashTransaction on the file's day (UTC noon, like a
//     manual entry), amount 120;
//   - the salary is an IncomeTransaction on 2026-09-05, amount 45000;
//   - the opening balance and the transfer wrote nothing, and sit in
//     ImportErrors with their reasons.
//
// Run against a local stand-in (see _standinCli.mts), both URLs set:
//   DATABASE_URL=$URL DATABASE_URL_DIRECT=$URL npx vitest run \
//     --no-file-parallelism __tests__/actions/import-sources-1791.test.ts
// ──────────────────────────────────────────────────────────────────────────

function loadEnvLocal() {
  const envPath = resolve(__dirname, '../../.env.local')
  if (!existsSync(envPath)) return
  for (const raw of readFileSync(envPath, 'utf-8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnvLocal()
vi.setConfig({ testTimeout: 60_000 })

let mockUserId = ''
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: mockUserId } }, error: null }) },
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => null, getAll: () => [], has: () => false, set: () => {}, delete: () => {},
  }),
  headers: async () => new Headers(),
}))

const { db } = await import('@/lib/db/client')
const {
  profiles, oikosGroups, groupBalance, groupEpochs,
  cashTransactions, incomeTransactions, importBatches, importErrors,
} = await import('@/lib/db/schema')
const { importCsvBatch } = await import('@/actions/import')
const { processFile } = await import('@/lib/csvImport')
const { localYmd } = await import('@/lib/local-date')
const { eq, sql } = await import('drizzle-orm')
const { unwrapAction } = await import('@/lib/action-errors')

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set.')
})

interface Refs { userId: string; groupId: string }

async function seedSoloGroup(): Promise<Refs> {
  const userId = randomUUID()
  const startedAt = new Date('2026-01-01T00:00:00Z')
  await db.insert(profiles).values({ id: userId, displayName: 'TEST_1791_user' })
  await seedAuthUsers([{ id: userId, displayName: 'TEST_1791_user' }])
  const [group] = await db
    .insert(oikosGroups)
    .values({ name: 'TEST_1791_group', memberA: userId, currentEpochStartedAt: startedAt })
    .returning({ id: oikosGroups.id })
  await db.insert(groupBalance).values({ groupId: group.id, balance: 0, version: 0 })
  await db.insert(groupEpochs).values({ groupId: group.id, startedAt, memberAId: userId })
  return { userId, groupId: group.id }
}

async function cleanup(refs: Refs) {
  const batches = await db.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.groupId, refs.groupId))
  await db.delete(cashTransactions).where(eq(cashTransactions.groupId, refs.groupId))
  await db.delete(incomeTransactions).where(eq(incomeTransactions.groupId, refs.groupId))
  for (const b of batches) await db.delete(importErrors).where(eq(importErrors.batchId, b.id))
  await db.delete(importBatches).where(eq(importBatches.groupId, refs.groupId))
  await db.delete(groupEpochs).where(eq(groupEpochs.groupId, refs.groupId))
  await db.delete(groupBalance).where(eq(groupBalance.groupId, refs.groupId))
  await db.delete(oikosGroups).where(eq(oikosGroups.id, refs.groupId))
  await deleteAuthUsers([refs.userId])
  await db.delete(profiles).where(eq(profiles.id, refs.userId))
}

const FIXTURE = resolve(__dirname, '../../lib/csvImport/__tests__/fixtures/1791/andromoney_winexcel_big5_zh.csv')

describe('AndroMoney file -> processFile -> importCsvBatch (#1791)', () => {
  let refs: Refs | null = null
  afterEach(async () => {
    if (refs) { try { await cleanup(refs) } catch (e) { console.error('cleanup failed', e) } refs = null }
  })

  it('stores the dates, amounts and expense/income split the file means', async () => {
    refs = await seedSoloGroup()
    mockUserId = refs.userId

    const result = await processFile(
      new File([readFileSync(FIXTURE)], 'andromoney.csv', { type: 'text/csv' }),
      { source: 'andromoney' },
    )
    expect(result.stats).toMatchObject({ total: 5, valid: 3, invalid: 2 })

    // The wizard's own payload shape (ImportContent.buildBatchInput).
    const res = unwrapAction(await importCsvBatch({
      source: result.source,
      fileName: 'andromoney.csv',
      totalRows: result.stats.total,
      rows: result.rows.map((r) => ({
        type: r.type,
        amount: r.amount,
        date: localYmd(r.date),
        category: r.category,
        description: r.description,
        paidBy: 'a' as const,
        splitType: 'all_mine' as const,
        originalCurrency: r.originalCurrency ?? null,
        originalAmount: r.originalAmount ?? null,
      })),
      errors: result.errors.map((e) => ({
        rowNumber: e.rowIndex + 1,
        rawRow: {},
        errorType: 'parse_error' as const,
        errorDetail: e.errors.join('; '),
      })),
    }))
    expect(res).toMatchObject({ importedCount: 3, errorCount: 2 })

    const cash = await db.execute<{ description: string; amount: number; day: string }>(sql`
      SELECT description, amount, to_char(transacted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
      FROM "CashTransactions" WHERE group_id = ${refs.groupId} ORDER BY description`)
    expect(Array.from(cash).map((r) => [r.description, r.amount, r.day])).toEqual([
      ['Pasta', 19, '2026-09-17'],
      ['便當，加蛋', 120, '2026-09-15'],
    ])

    const income = await db
      .select({ amount: incomeTransactions.amount, occurredAt: incomeTransactions.occurredAt, source: incomeTransactions.source })
      .from(incomeTransactions)
      .where(eq(incomeTransactions.groupId, refs.groupId))
    expect(income).toEqual([{ amount: 45000, occurredAt: '2026-09-05', source: '薪水' }])

    const errs = await db
      .select({ rowNumber: importErrors.rowNumber, errorDetail: importErrors.errorDetail })
      .from(importErrors)
      .innerJoin(importBatches, eq(importBatches.id, importErrors.batchId))
      .where(eq(importBatches.groupId, refs.groupId))
      .orderBy(importErrors.rowNumber)
    expect(errs).toEqual([
      { rowNumber: 1, errorDetail: 'row 1: opening balance rows are not imported' },
      { rowNumber: 4, errorDetail: 'row 4: transfer rows are not imported' },
    ])

    const [batch] = await db
      .select({ source: importBatches.source, imported: importBatches.importedCount })
      .from(importBatches)
      .where(eq(importBatches.groupId, refs.groupId))
    expect(batch).toEqual({ source: 'andromoney', imported: 3 })
  })
})
