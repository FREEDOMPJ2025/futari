import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { seedAuthUsers, deleteAuthUsers } from './_authUser'

// ─── #1793 — importCsvBatch stores the calendar day the file wrote ────────
//
// The client used to send the UTC day of a local-midnight Date (a day early
// east of UTC); the action then stored `new Date('YYYY-MM-DD')`, i.e. UTC
// midnight, where a manually entered record is UTC noon (ymdToUTCNoon, #453).
//
// Asserts, on a real Postgres:
//   - an imported expense has the SAME transacted_at as a manual expense on
//     that day (so the day reads the same in Taipei, UTC and Los Angeles, and
//     imported rows sort with manual ones);
//   - an income row's occurred_at (a DATE) is the file day;
//   - the server's own TZ is irrelevant;
//   - date strings that are not a plain calendar day are refused.
//
// Run against a local stand-in (see _standinCli.mts), both URLs set:
//   DATABASE_URL=$URL DATABASE_URL_DIRECT=$URL npx vitest run \
//     --no-file-parallelism __tests__/actions/import-date-1793.test.ts
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
const { createTransaction } = await import('@/actions/transaction')
const { eq, sql } = await import('drizzle-orm')
const { unwrapAction } = await import('@/lib/action-errors')

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set.')
})

interface Refs { userId: string; groupId: string }

async function seedSoloGroup(): Promise<Refs> {
  const userId = randomUUID()
  const startedAt = new Date('2026-01-01T00:00:00Z')
  await db.insert(profiles).values({ id: userId, displayName: 'TEST_1793_user' })
  await seedAuthUsers([{ id: userId, displayName: 'TEST_1793_user' }])
  const [group] = await db
    .insert(oikosGroups)
    .values({ name: 'TEST_1793_group', memberA: userId, currentEpochStartedAt: startedAt })
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

const row = (over: Record<string, unknown>) => ({
  type: 'expense' as const, amount: 100, date: '2026-09-15', category: 'dining',
  description: 'x', paidBy: 'a' as const, splitType: 'all_mine' as const, ...over,
})

const originalTz = process.env.TZ

describe.each(['Asia/Taipei', 'UTC', 'America/Los_Angeles'])('importCsvBatch dates, server TZ %s (#1793)', (tz) => {
  let refs: Refs | null = null
  afterEach(async () => {
    process.env.TZ = originalTz
    if (originalTz === undefined) delete process.env.TZ
    if (refs) { try { await cleanup(refs) } catch (e) { console.error('cleanup failed', e) } refs = null }
  })

  it('stores the file day, identical to a manual entry on that day', async () => {
    process.env.TZ = tz
    refs = await seedSoloGroup()
    mockUserId = refs.userId

    unwrapAction(await importCsvBatch({
      source: 'honeydue', fileName: 'a.csv', totalRows: 3, errors: [],
      rows: [
        row({ date: '2026-09-15', description: 'imp0915' }),
        row({ date: '2026-10-01', description: 'imp1001' }),
        row({ type: 'income', date: '2026-10-01', category: 'salary', description: 'inc1001', amount: 5000 }),
      ],
    }))
    for (const d of ['2026-09-15', '2026-10-01']) {
      unwrapAction(await createTransaction({
        amount: 1, description: `man${d}`, category: 'dining', splitType: 'all_mine',
        payerId: refs.userId, transactedAt: d,
      }))
    }

    const cash = await db.execute<{
      description: string; at: string; taipei: string; utc: string; la: string
    }>(sql`
      SELECT description,
             transacted_at::text AS at,
             to_char(transacted_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS taipei,
             to_char(transacted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc,
             to_char(transacted_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS la
      FROM "CashTransactions" WHERE group_id = ${refs.groupId}`)
    const by = Object.fromEntries(Array.from(cash).map((r) => [r.description, r]))
    for (const [imported, manual, day] of [
      ['imp0915', 'man2026-09-15', '2026-09-15'],
      ['imp1001', 'man2026-10-01', '2026-10-01'],
    ] as const) {
      expect(by[imported]).toMatchObject({ taipei: day, utc: day, la: day })
      // Same instant as the manual entry: UTC noon.
      expect(by[imported]!.at).toBe(by[manual]!.at)
    }

    const [inc] = await db
      .select({ occurredAt: incomeTransactions.occurredAt })
      .from(incomeTransactions)
      .where(eq(incomeTransactions.groupId, refs.groupId))
    expect(inc!.occurredAt).toBe('2026-10-01')
  })
})

describe('importCsvBatch date validation (#1793)', () => {
  let refs: Refs | null = null
  afterEach(async () => {
    if (refs) { try { await cleanup(refs) } catch (e) { console.error('cleanup failed', e) } refs = null }
  })

  it.each(['9/15/2026', '2026-09-15T00:00:00Z', '2026-02-30', '2026-9-5', ''])(
    'refuses %j and writes nothing',
    async (bad) => {
      refs = await seedSoloGroup()
      mockUserId = refs.userId
      const res = await importCsvBatch({
        source: 'honeydue', fileName: 'a.csv', totalRows: 1, errors: [], rows: [row({ date: bad })],
      })
      expect(res).toMatchObject({ ok: false, code: 'import_row_invalid_date' })
      const n = await db.execute<{ c: number }>(sql`SELECT count(*)::int AS c FROM "ImportBatches" WHERE group_id = ${refs.groupId}`)
      expect(n[0]!.c).toBe(0)
    },
  )
})
