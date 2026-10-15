import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── #1611 — a voluntary leave keeps the chapter whole ─────────────────────
//
// A chapter belongs to the relationship, not to either person. Before #1611
// leaveGroup moved the leaver's CashTransactions / IncomeTransactions /
// Settlements / MonthlyReviewMessages into the leaver's new solo ledger: the
// stayer's past chapter silently lost that half (no error — the totals just
// stopped matching what both people remember), and the moved rows fell into
// no chapter of the new ledger.
//
// Now records stay; live items (owned cars / houses / policies, rules and
// their unprocessed or skipped occurrences, invoice credentials, push tokens)
// still go with their owner. Resolved occurrences of the leaver's rules are
// deleted at leave time: their transaction stays behind, so moving them would
// leave a cross-ledger resolved_tx_id (the stayer's later account deletion
// then fails in _delete_group_cascade, #1377 symptom: a daily WARNING and the
// account never goes), and keeping them behind would let card 3 of the
// stayer's monthly review — which joins the rule by id with no ledger filter
// (0089) — show rule text the leaver edits after leaving.
//
// One fixture per describe, run through the real leaveGroup action:
//   1. record counts in the closed chapter are identical before and after;
//   2. zero cross-ledger references in both ledgers, every reference column;
//      resolved occurrences of the leaver's rules are gone, the stayer's kept;
//   2b. the leaver renames a moved rule / deletes their account → the
//      stayer's snapshot for the leave month has no leaver rule text and still
//      lists the stayer's own resolved events;
//   3. process_account_deletions completes for the stayer and, in a separate
//      run, for the leaver. Since #1701 the stayer's deletion keeps the closed
//      chapter for the leaver (alive: an auth.users row): the ledger stays as
//      an orphan holding exactly that chapter; once the leaver is gone too,
//      the stayer's deletion cascades the whole ledger as before.
//
// Needs the SQL functions (compute_monthly_review_snapshot,
// process_account_deletions), so the database must be MIGRATED (drizzle's
// migrator over drizzle/, e.g. a Supabase stand-in from
// __tests__/actions/_supabaseStandIn.ts), not `drizzle-kit push`. Local
// throwaway database only; refuses to run against anything that is not
// localhost. Integration folder — excluded from CI.
// ──────────────────────────────────────────────────────────────────────────

function loadEnvLocal() {
  const envPath = resolve(__dirname, '../../.env.local')
  if (!existsSync(envPath)) return
  const text = readFileSync(envPath, 'utf-8')
  for (const raw of text.split('\n')) {
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

const databaseUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

let mockUserId = ''
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: mockUserId } }, error: null }) },
  }),
  getCurrentUser: async () => ({ id: mockUserId }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}))
vi.mock('@/lib/analytics/server', () => ({
  captureServer: async () => {},
  isUserFirstNonDeletedRecord: async () => false,
}))

const { db } = await import('@/lib/db/client')
const S = await import('@/lib/db/schema')
const {
  profiles, oikosGroups, groupBalance, groupEpochs, assets,
  carDetails, houseDetails, childDetails, insuranceDetails, fuelLogs,
  cashTransactions, incomeTransactions, settlements, monthlyReviewMessages,
  recurringExpenseRules, recurringIncomeRules,
  pendingExpenseOccurrences, pendingIncomeOccurrences,
  trips, importBatches,
} = S
const { leaveGroup } = await import('@/actions/membership')
const recurringExpense = await import('@/actions/recurringExpense')
const recurringIncome = await import('@/actions/recurringIncome')
const { and, eq, inArray, isNull, sql } = await import('drizzle-orm')
const { unwrapAction } = await import('@/lib/action-errors')
const { seedAuthUsers, deleteAuthUsers } = await import('./_authUser')

vi.setConfig({ testTimeout: 60_000 })

const RECORD_TABLES = ['CashTransactions', 'IncomeTransactions', 'Settlements', 'MonthlyReviewMessages'] as const

/** Taipei calendar month + date of `d` — the snapshot function's month frame. */
function taipei(d: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return { year: Number(get('year')), month: Number(get('month')), ymd: `${get('year')}-${get('month')}-${get('day')}` }
}

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.execute<{ n: number }>(q)
  return Number(rows[0]?.n ?? 0)
}

/**
 * Rows of `groupId` that reference a row of a different ledger, per column.
 * Every reference column a ledger row can hold toward another ledger-owned row.
 */
async function crossRefs(groupId: string) {
  const g = sql`${groupId}::uuid`
  return {
    cashAsset: await scalar(sql`SELECT count(*)::int n FROM "CashTransactions" t JOIN "Assets" a ON a.id = t.asset_id WHERE t.group_id = ${g} AND a.group_id <> t.group_id`),
    cashFuelLog: await scalar(sql`SELECT count(*)::int n FROM "CashTransactions" t JOIN "FuelLogs" f ON f.id = t.fuel_log_id JOIN "Assets" a ON a.id = f.asset_id WHERE t.group_id = ${g} AND a.group_id <> t.group_id`),
    cashTrip: await scalar(sql`SELECT count(*)::int n FROM "CashTransactions" t JOIN "Trips" x ON x.id = t.trip_id WHERE t.group_id = ${g} AND x.group_id <> t.group_id`),
    cashImport: await scalar(sql`SELECT count(*)::int n FROM "CashTransactions" t JOIN "ImportBatches" b ON b.id = t.import_batch_id WHERE t.group_id = ${g} AND b.group_id <> t.group_id`),
    incomeAsset: await scalar(sql`SELECT count(*)::int n FROM "IncomeTransactions" t JOIN "Assets" a ON a.id = t.asset_id WHERE t.group_id = ${g} AND a.group_id <> t.group_id`),
    incomeImport: await scalar(sql`SELECT count(*)::int n FROM "IncomeTransactions" t JOIN "ImportBatches" b ON b.id = t.import_batch_id WHERE t.group_id = ${g} AND b.group_id <> t.group_id`),
    pendExpResolved: await scalar(sql`SELECT count(*)::int n FROM "PendingExpenseOccurrences" p JOIN "CashTransactions" t ON t.id = p.resolved_tx_id WHERE p.group_id = ${g} AND t.group_id <> p.group_id`),
    pendIncResolved: await scalar(sql`SELECT count(*)::int n FROM "PendingIncomeOccurrences" p JOIN "IncomeTransactions" t ON t.id = p.resolved_tx_id WHERE p.group_id = ${g} AND t.group_id <> p.group_id`),
    pendExpRule: await scalar(sql`SELECT count(*)::int n FROM "PendingExpenseOccurrences" p JOIN "RecurringExpenseRules" r ON r.id = p.rule_id WHERE p.group_id = ${g} AND r.group_id <> p.group_id`),
    pendIncRule: await scalar(sql`SELECT count(*)::int n FROM "PendingIncomeOccurrences" p JOIN "RecurringIncomeRules" r ON r.id = p.rule_id WHERE p.group_id = ${g} AND r.group_id <> p.group_id`),
    expenseRuleAsset: await scalar(sql`SELECT count(*)::int n FROM "RecurringExpenseRules" r JOIN "Assets" a ON a.id = r.asset_id WHERE r.group_id = ${g} AND a.group_id <> r.group_id`),
    incomeRuleAsset: await scalar(sql`SELECT count(*)::int n FROM "RecurringIncomeRules" r JOIN "Assets" a ON a.id = r.asset_id WHERE r.group_id = ${g} AND a.group_id <> r.group_id`),
    insVehicle: await scalar(sql`SELECT count(*)::int n FROM "InsuranceDetails" d JOIN "Assets" ia ON ia.id = d.asset_id JOIN "Assets" a ON a.id = d.vehicle_id WHERE ia.group_id = ${g} AND a.group_id <> ia.group_id`),
    insChild: await scalar(sql`SELECT count(*)::int n FROM "InsuranceDetails" d JOIN "Assets" ia ON ia.id = d.asset_id JOIN "Assets" a ON a.id = d.insured_child_id WHERE ia.group_id = ${g} AND a.group_id <> ia.group_id`),
  }
}

async function recordCounts(groupId: string) {
  const out: Record<string, number> = {}
  for (const t of RECORD_TABLES) {
    out[t] = await scalar(sql`SELECT count(*)::int n FROM ${sql.identifier(t)} WHERE group_id = ${groupId}::uuid`)
  }
  return out
}

/** Card 3 names of the stored snapshot, after recomputing it for (year, month). */
async function card3Names(groupId: string, year: number, month: number): Promise<string[]> {
  await db.execute(sql`SELECT public.compute_monthly_review_snapshot(${groupId}::uuid, ${year}, ${month})`)
  const rows = await db.execute<{ events: { name: string }[] | null }>(sql`
    SELECT recurring_events AS events FROM "MonthlyReviewSnapshots"
    WHERE group_id = ${groupId}::uuid AND year = ${year} AND month = ${month}`)
  expect(rows, 'snapshot row').toHaveLength(1)
  return (rows[0].events ?? []).map((e) => e.name).sort()
}

/** Mark `userId` for deletion past the grace period, run the processor. */
async function deleteAccount(userId: string) {
  await db.update(profiles).set({ deletionRequestedAt: sql`now() - interval '15 days'` }).where(eq(profiles.id, userId))
  const rows = await db.execute<{ n: number }>(sql`SELECT public.process_account_deletions() AS n`)
  return Number(rows[0].n)
}

/** Completed = the profile is gone, or a tombstone no longer pending deletion. */
async function deletionCompleted(userId: string) {
  const [p] = await db.select().from(profiles).where(eq(profiles.id, userId))
  return p === undefined || (p.deletionRequestedAt === null && p.displayName === '已離開的夥伴')
}

interface Fixture {
  tag: string
  A: string
  B: string
  G: string
  NB: string
  duoEpoch: string
  carB: string
  houseA: string
  childA: string
  carA: string
  insB: string
  insA: string
  reA: string
  reB: string
  riA: string
  riB: string
  pendResolvedA: { exp: string; inc: string }
  pendResolvedB: { exp: string; inc: string }
  pendOpenB: { exp: string; expSkipped: string; inc: string }
}

async function seed(tag: string): Promise<Fixture> {
  const f = { tag, A: randomUUID(), B: randomUUID() } as Fixture
  await db.insert(profiles).values([
    { id: f.A, displayName: `${tag}_A` },
    { id: f.B, displayName: `${tag}_B` },
  ])
  // Both are live users (#1701: "alive" = an auth.users row).
  await seedAuthUsers([{ id: f.A, displayName: `${tag}_A` }, { id: f.B, displayName: `${tag}_B` }])
  const startedAt = new Date(Date.now() - 30 * 86400_000)
  const [g] = await db.insert(oikosGroups).values({
    name: `${tag}_duo`, memberA: f.A, memberB: f.B, currentEpochStartedAt: startedAt, guardianBetaEnabled: true,
  }).returning({ id: oikosGroups.id })
  f.G = g.id
  await db.insert(groupBalance).values({ groupId: f.G, balance: 0, version: 0 })
  const [ep] = await db.insert(groupEpochs).values({
    groupId: f.G, startedAt, memberAId: f.A, memberBId: f.B,
  }).returning({ id: groupEpochs.id })
  f.duoEpoch = ep.id

  // Recorded inside the duo chapter, dated into the current (leave) month.
  const now = new Date()
  const when = new Date(now.getTime() - 60 * 60 * 1000)
  const today = taipei(when).ymd

  // 愛物: B's car + policy move; A's house / car / child stay.
  const mk = async (type: typeof assets.$inferInsert['type'], name: string) =>
    (await db.insert(assets).values({ groupId: f.G, type, name: `${tag} ${name}` }).returning({ id: assets.id }))[0].id
  f.carB = await mk('car', 'B car')
  await db.insert(carDetails).values({ assetId: f.carB, primaryUserId: f.B })
  f.carA = await mk('car', 'A car')
  await db.insert(carDetails).values({ assetId: f.carA, primaryUserId: f.A })
  f.houseA = await mk('house', 'A house')
  await db.insert(houseDetails).values({ assetId: f.houseA, owner: f.A })
  f.childA = await mk('child', 'child')
  await db.insert(childDetails).values({ assetId: f.childA, nickname: 'n' })
  f.insB = await mk('insurance', 'B policy')
  await db.insert(insuranceDetails).values({
    currency: 'twd', assetId: f.insB, insuredType: 'user', insuredUserId: f.B, insuredChildId: f.childA, vehicleId: f.carA,
  })
  f.insA = await mk('insurance', 'A policy')
  await db.insert(insuranceDetails).values({ currency: 'twd', assetId: f.insA, insuredType: 'user', insuredUserId: f.A, vehicleId: f.carB })
  const [fl] = await db.insert(fuelLogs).values({
    assetId: f.carB, liters: '30.00', fuelType: '95', odometer: 1000, station: `${tag} st`, loggedAt: when,
  }).returning({ id: fuelLogs.id })

  // An ended trip of the duo chapter, and an import batch by each person.
  const [trip] = await db.insert(trips).values({
    groupId: f.G, epochId: f.duoEpoch, name: `${tag} trip`, startDate: today, endDate: today,
    status: 'ended', endedAt: when,
  }).returning({ id: trips.id })
  const batch = async (by: string) => (await db.insert(importBatches).values({
    groupId: f.G, importedBy: by, source: 'futari_generic', fileName: `${tag}.csv`,
    totalRows: 1, importedCount: 1, status: 'completed',
  }).returning({ id: importBatches.id }))[0].id
  const batchA = await batch(f.A)
  const batchB = await batch(f.B)

  const cash = async (paidBy: string, description: string, extra: Partial<typeof cashTransactions.$inferInsert> = {}) =>
    (await db.insert(cashTransactions).values({
      groupId: f.G, paidBy, amount: 100, splitType: 'all_mine', description: `${tag} ${description}`,
      category: 'other', transactedAt: when, ...extra,
    }).returning({ id: cashTransactions.id }))[0].id
  const income = async (recipientId: string, extra: Partial<typeof incomeTransactions.$inferInsert> = {}) =>
    (await db.insert(incomeTransactions).values({
      groupId: f.G, recipientId, amount: 500, category: 'salary', occurredAt: today, ...extra,
    }).returning({ id: incomeTransactions.id }))[0].id

  // A pays 1000 'half', B settles 500: settled balance 0, both legs in the chapter.
  await cash(f.A, 'A dinner half', { amount: 1000, splitType: 'half' })
  await db.insert(settlements).values({ groupId: f.G, paidBy: f.B, amount: 500, settledAt: when })
  await cash(f.A, 'A fuel in B car', { assetId: f.carB, fuelLogId: fl.id })
  await cash(f.B, 'B fuel in B car', { assetId: f.carB })
  await cash(f.B, 'B on A house', { assetId: f.houseA })
  await cash(f.A, 'A trip', { tripId: trip.id })
  await cash(f.B, 'B trip', { tripId: trip.id })
  await cash(f.A, 'A imported', { importBatchId: batchA })
  await cash(f.B, 'B imported', { importBatchId: batchB })
  await income(f.B, { importBatchId: batchB })
  await income(f.A, { assetId: f.insB, category: 'maturity' })
  await db.insert(monthlyReviewMessages).values([
    { groupId: f.G, memberId: f.A, year: 2026, month: 9, body: `${tag} from A` },
    { groupId: f.G, memberId: f.B, year: 2026, month: 9, body: `${tag} from B` },
  ])

  // Recurring: each person has an expense and an income rule with a
  // confirmed (resolved) card this month; B also has open and skipped cards.
  const eRule = async (paidBy: string, description: string, assetId: string | null) =>
    (await db.insert(recurringExpenseRules).values({
      groupId: f.G, paidBy, amount: 300, splitType: 'all_mine', description: `${tag} ${description}`, category: 'housing',
      assetId, intervalMonths: 1, dayOfMonth: 1, startsOn: '2026-01-01', nextOccurrenceAt: '2099-01-01',
    }).returning({ id: recurringExpenseRules.id }))[0].id
  const iRule = async (recipientId: string, source: string) =>
    (await db.insert(recurringIncomeRules).values({
      groupId: f.G, recipientId, amount: 700, category: 'salary', source: `${tag} ${source}`,
      intervalMonths: 1, dayOfMonth: 1, startsOn: '2026-01-01', nextOccurrenceAt: '2099-01-01',
    }).returning({ id: recurringIncomeRules.id }))[0].id
  f.reA = await eRule(f.A, 'A gym', f.carB)        // stays; links the moving car → copy in G
  f.reB = await eRule(f.B, 'B rent', f.houseA)     // moves; links the staying house → copy in NB
  f.riA = await iRule(f.A, 'A bonus')
  f.riB = await iRule(f.B, 'B salary')

  const pendExp = async (ruleId: string, paidBy: string, period: string, extra: Partial<typeof pendingExpenseOccurrences.$inferInsert> = {}) =>
    (await db.insert(pendingExpenseOccurrences).values({
      groupId: f.G, ruleId, periodStart: period, proposedAmount: 300, proposedDate: period,
      proposedDescription: 'p', proposedPaidBy: paidBy, proposedSplitType: 'half', ...extra,
    }).returning({ id: pendingExpenseOccurrences.id }))[0].id
  const pendInc = async (ruleId: string, period: string, extra: Partial<typeof pendingIncomeOccurrences.$inferInsert> = {}) =>
    (await db.insert(pendingIncomeOccurrences).values({
      groupId: f.G, ruleId, periodStart: period, proposedAmount: 700, proposedDate: period, ...extra,
    }).returning({ id: pendingIncomeOccurrences.id }))[0].id

  const txReA = await cash(f.A, 'A gym paid', { amount: 300 })
  const txReB = await cash(f.B, 'B rent paid', { amount: 300 })
  const incRiA = await income(f.A, { amount: 700 })
  const incRiB = await income(f.B, { amount: 700 })
  f.pendResolvedA = {
    exp: await pendExp(f.reA, f.A, '2026-08-01', { resolvedTxId: txReA }),
    inc: await pendInc(f.riA, '2026-08-01', { resolvedTxId: incRiA }),
  }
  f.pendResolvedB = {
    exp: await pendExp(f.reB, f.B, '2026-08-01', { resolvedTxId: txReB }),
    inc: await pendInc(f.riB, '2026-08-01', { resolvedTxId: incRiB }),
  }
  f.pendOpenB = {
    exp: await pendExp(f.reB, f.B, '2026-09-01'),
    expSkipped: await pendExp(f.reB, f.B, '2026-07-01', { skippedAt: when }),
    inc: await pendInc(f.riB, '2026-09-01'),
  }
  return f
}

async function cleanup(f: Fixture | undefined) {
  if (!f) return
  const groups = [f.G, f.NB].filter(Boolean)
  const existing = (await db.select({ id: oikosGroups.id }).from(oikosGroups).where(inArray(oikosGroups.id, groups))).map((r) => r.id)
  if (existing.length) {
    const groupAssets = (await db.select({ id: assets.id }).from(assets).where(inArray(assets.groupId, existing))).map((a) => a.id)
    await db.delete(pendingExpenseOccurrences).where(inArray(pendingExpenseOccurrences.groupId, existing))
    await db.delete(pendingIncomeOccurrences).where(inArray(pendingIncomeOccurrences.groupId, existing))
    await db.delete(cashTransactions).where(inArray(cashTransactions.groupId, existing))
    await db.delete(incomeTransactions).where(inArray(incomeTransactions.groupId, existing))
    await db.delete(settlements).where(inArray(settlements.groupId, existing))
    await db.delete(monthlyReviewMessages).where(inArray(monthlyReviewMessages.groupId, existing))
    await db.execute(sql`DELETE FROM "MonthlyReviewSnapshots" WHERE group_id IN ${sql`(${sql.join(existing.map((id) => sql`${id}::uuid`), sql`, `)})`}`)
    await db.delete(recurringExpenseRules).where(inArray(recurringExpenseRules.groupId, existing))
    await db.delete(recurringIncomeRules).where(inArray(recurringIncomeRules.groupId, existing))
    await db.delete(importBatches).where(inArray(importBatches.groupId, existing))
    await db.delete(trips).where(inArray(trips.groupId, existing))
    if (groupAssets.length) {
      await db.delete(fuelLogs).where(inArray(fuelLogs.assetId, groupAssets))
      for (const t of [carDetails, houseDetails, childDetails, insuranceDetails]) {
        await db.delete(t).where(inArray(t.assetId, groupAssets))
      }
      await db.delete(assets).where(inArray(assets.id, groupAssets))
    }
    await db.delete(groupEpochs).where(inArray(groupEpochs.groupId, existing))
    await db.delete(groupBalance).where(inArray(groupBalance.groupId, existing))
    await db.delete(oikosGroups).where(inArray(oikosGroups.id, existing))
  }
  await deleteAuthUsers([f.A, f.B])
  await db.delete(profiles).where(inArray(profiles.id, [f.A, f.B]))
}

async function leave(f: Fixture) {
  mockUserId = f.B
  f.NB = unwrapAction(await leaveGroup()).groupId
}

async function assertMigratedDb() {
  const fns = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname IN ('compute_monthly_review_snapshot', 'process_account_deletions', '_delete_group_cascade')`)
  if (Number(fns[0].n) < 3) {
    throw new Error('this suite needs a MIGRATED database (drizzle migrator over drizzle/), not drizzle-kit push: the SQL functions are missing')
  }
}

describe.skipIf(!isLocalDb)('#1611 — leave keeps the chapter; stayer renames nothing, then the stayer deletes their account', () => {
  let f: Fixture
  let before: Record<string, number>
  let stayerResolvedBefore: { exp: typeof pendingExpenseOccurrences.$inferSelect; inc: typeof pendingIncomeOccurrences.$inferSelect }
  const { year, month } = taipei(new Date(Date.now() - 60 * 60 * 1000))

  beforeAll(async () => {
    await assertMigratedDb()
    f = await seed(`TEST_1611a_${randomUUID().slice(0, 6)}`)
    before = await recordCounts(f.G)
    stayerResolvedBefore = {
      exp: (await db.select().from(pendingExpenseOccurrences).where(eq(pendingExpenseOccurrences.id, f.pendResolvedA.exp)))[0],
      inc: (await db.select().from(pendingIncomeOccurrences).where(eq(pendingIncomeOccurrences.id, f.pendResolvedA.inc)))[0],
    }
    await leave(f)
  })
  afterAll(async () => {
    try { await cleanup(f) } catch (e) { console.error('cleanup failed', e) }
  })

  it('(1) every record of the chapter is still in it — counts identical, the leaver\'s rows included', async () => {
    expect(before.CashTransactions).toBeGreaterThan(0)
    expect(await recordCounts(f.G)).toEqual(before)
    expect(await recordCounts(f.NB)).toEqual({ CashTransactions: 0, IncomeTransactions: 0, Settlements: 0, MonthlyReviewMessages: 0 })
    const [ep] = await db.select().from(groupEpochs).where(eq(groupEpochs.id, f.duoEpoch))
    expect(ep.endedAt).not.toBeNull()
    for (const t of RECORD_TABLES) {
      const outside = await scalar(sql`
        SELECT count(*)::int n FROM ${sql.identifier(t)}
        WHERE group_id = ${f.G}::uuid AND NOT (created_at >= ${ep.startedAt.toISOString()}::timestamptz AND created_at < ${ep.endedAt!.toISOString()}::timestamptz)`)
      expect(outside, t).toBe(0)
    }
    const leaverRows = await scalar(sql`SELECT count(*)::int n FROM "CashTransactions" WHERE group_id = ${f.G}::uuid AND paid_by = ${f.B}::uuid`)
    expect(leaverRows).toBe(5)
    expect(await scalar(sql`SELECT count(*)::int n FROM "Settlements" WHERE group_id = ${f.G}::uuid AND paid_by = ${f.B}::uuid`)).toBe(1)
    expect(await scalar(sql`SELECT count(*)::int n FROM "IncomeTransactions" WHERE group_id = ${f.G}::uuid AND recipient_id = ${f.B}::uuid`)).toBe(2)
    expect(await scalar(sql`SELECT count(*)::int n FROM "MonthlyReviewMessages" WHERE group_id = ${f.G}::uuid AND member_id = ${f.B}::uuid`)).toBe(1)
  })

  it('(2) zero cross-ledger references in both ledgers, every reference column', async () => {
    const zero = {
      cashAsset: 0, cashFuelLog: 0, cashTrip: 0, cashImport: 0, incomeAsset: 0, incomeImport: 0,
      pendExpResolved: 0, pendIncResolved: 0, pendExpRule: 0, pendIncRule: 0,
      expenseRuleAsset: 0, incomeRuleAsset: 0, insVehicle: 0, insChild: 0,
    }
    expect(await crossRefs(f.G)).toEqual(zero)
    expect(await crossRefs(f.NB)).toEqual(zero)
  })

  it('(2) live items moved; the fixture did cross (the zero above is not vacuous)', async () => {
    const groupOf = async (id: string) => (await db.select({ g: assets.groupId }).from(assets).where(eq(assets.id, id)))[0].g
    expect(await groupOf(f.carB)).toBe(f.NB)
    expect(await groupOf(f.insB)).toBe(f.NB)
    expect(await groupOf(f.houseA)).toBe(f.G)
    const rule = async (id: string) => (await db.select().from(recurringExpenseRules).where(eq(recurringExpenseRules.id, id)))[0]
    expect((await rule(f.reB)).groupId).toBe(f.NB)
    expect((await rule(f.reA)).groupId).toBe(f.G)
    expect((await db.select().from(recurringIncomeRules).where(eq(recurringIncomeRules.id, f.riB)))[0].groupId).toBe(f.NB)
    const copies = await db.select().from(assets).where(and(inArray(assets.groupId, [f.G, f.NB]), sql`${assets.frozenAt} IS NOT NULL`))
    expect(copies.filter((c) => c.groupId === f.G).map((c) => c.name).sort()).toEqual([`${f.tag} B car`, `${f.tag} B policy`].sort())
    expect(copies.filter((c) => c.groupId === f.NB).map((c) => c.name).sort())
      .toEqual([`${f.tag} A car`, `${f.tag} A house`, `${f.tag} child`].sort())
  })

  it('(2) resolved occurrences of the leaver\'s rules are deleted; open and skipped ones moved; the stayer\'s untouched', async () => {
    expect(await db.select().from(pendingExpenseOccurrences).where(eq(pendingExpenseOccurrences.id, f.pendResolvedB.exp))).toHaveLength(0)
    expect(await db.select().from(pendingIncomeOccurrences).where(eq(pendingIncomeOccurrences.id, f.pendResolvedB.inc))).toHaveLength(0)

    const openExp = await db.select().from(pendingExpenseOccurrences)
      .where(inArray(pendingExpenseOccurrences.id, [f.pendOpenB.exp, f.pendOpenB.expSkipped]))
    expect(openExp).toHaveLength(2)
    for (const p of openExp) {
      expect(p.groupId).toBe(f.NB)
      expect(p.resolvedTxId).toBeNull()
      expect(p.proposedPaidBy).toBe(f.B)
      expect(p.proposedSplitType).toBe('all_mine')
    }
    expect(openExp.find((p) => p.id === f.pendOpenB.expSkipped)?.skippedAt).not.toBeNull()
    const [openInc] = await db.select().from(pendingIncomeOccurrences).where(eq(pendingIncomeOccurrences.id, f.pendOpenB.inc))
    expect(openInc.groupId).toBe(f.NB)

    const [exp] = await db.select().from(pendingExpenseOccurrences).where(eq(pendingExpenseOccurrences.id, f.pendResolvedA.exp))
    const [inc] = await db.select().from(pendingIncomeOccurrences).where(eq(pendingIncomeOccurrences.id, f.pendResolvedA.inc))
    expect(exp).toEqual(stayerResolvedBefore.exp)
    expect(inc).toEqual(stayerResolvedBefore.inc)
  })

  it('(2b) the leaver renames their moved rules; the stayer\'s leave-month card 3 shows none of it and keeps the stayer\'s events', async () => {
    mockUserId = f.B
    const base = { intervalMonths: 1, dayOfMonth: 1, startsOn: '2026-01-01', endsOn: null }
    unwrapAction(await recurringExpense.updateRule({
      ...base, id: f.reB, amount: 300, category: 'housing', paidBy: f.B, splitType: 'all_mine',
      description: `${f.tag} LEAKED expense`, assetId: (await db.select().from(recurringExpenseRules).where(eq(recurringExpenseRules.id, f.reB)))[0].assetId,
    }))
    unwrapAction(await recurringIncome.updateRule({
      ...base, id: f.riB, amount: 700, category: 'salary', recipientId: f.B, source: `${f.tag} LEAKED income`, assetId: null,
    }))
    const names = await card3Names(f.G, year, month)
    expect(names.some((n) => n.includes('LEAKED'))).toBe(false)
    // The leaver's confirmed events left with their rules' resolved cards
    // (as before #1611, when they moved away); the stayer's own are listed.
    expect(names).toEqual([`${f.tag} A bonus`, `${f.tag} A gym`])
  })

  it('(3) the stayer\'s account deletion completes and keeps the closed chapter for the leaver (#1701)', async () => {
    const [ep] = await db.select().from(groupEpochs).where(eq(groupEpochs.id, f.duoEpoch))
    // What the leaver's look-back reads (created_at in the chapter window;
    // review messages also need the whole month inside it — the reader's rule).
    const inChapter = (t: string) => sql`
      SELECT count(*)::int n FROM ${sql.identifier(t)}
      WHERE group_id = ${f.G}::uuid
        AND created_at >= ${ep.startedAt.toISOString()}::timestamptz AND created_at < ${ep.endedAt!.toISOString()}::timestamptz`
    const keptBefore = {
      CashTransactions: await scalar(inChapter('CashTransactions')),
      IncomeTransactions: await scalar(inChapter('IncomeTransactions')),
      Settlements: await scalar(inChapter('Settlements')),
      MonthlyReviewMessages: await scalar(sql`
        SELECT count(*)::int n FROM "MonthlyReviewMessages"
        WHERE group_id = ${f.G}::uuid
          AND created_at >= ${ep.startedAt.toISOString()}::timestamptz AND created_at < ${ep.endedAt!.toISOString()}::timestamptz
          AND make_timestamptz(year, month, 1, 0, 0, 0, 'Asia/Taipei') >= date_trunc('milliseconds', ${ep.startedAt.toISOString()}::timestamptz)
          AND make_timestamptz(year, month, 1, 0, 0, 0, 'Asia/Taipei') + interval '1 month'
              <= date_trunc('milliseconds', ${ep.endedAt!.toISOString()}::timestamptz)`),
    }
    expect(keptBefore.CashTransactions).toBeGreaterThan(0)

    expect(await deleteAccount(f.A)).toBe(1)
    expect(await deletionCompleted(f.A)).toBe(true)
    // The ledger stays as an orphan: no member_b, member_a's account gone.
    const [g] = await db.select().from(oikosGroups).where(eq(oikosGroups.id, f.G))
    expect(g).toMatchObject({ memberA: f.A, memberB: null, name: '家計簿' })
    expect(await scalar(sql`SELECT count(*)::int n FROM auth.users WHERE id = ${f.A}::uuid`)).toBe(0)
    // Exactly the chapter's records remain; the duo chapter names A as 「已離開的夥伴」.
    expect(await recordCounts(f.G)).toEqual(keptBefore)
    const [after] = await db.select().from(groupEpochs).where(eq(groupEpochs.id, f.duoEpoch))
    expect(after.memberAName).toBe('已離開的夥伴')
    expect(after.memberBName).toBe(`${f.tag}_B`)
    expect(await db.select().from(groupEpochs).where(and(eq(groupEpochs.groupId, f.G), isNull(groupEpochs.endedAt)))).toHaveLength(0)
    // The leaver's ledger is untouched by it.
    expect(await db.select().from(recurringExpenseRules).where(eq(recurringExpenseRules.id, f.reB))).toHaveLength(1)
  })
})

describe.skipIf(!isLocalDb)('#1611 — leave keeps the chapter; then the leaver deletes their account', () => {
  let f: Fixture
  const { year, month } = taipei(new Date(Date.now() - 60 * 60 * 1000))

  beforeAll(async () => {
    await assertMigratedDb()
    f = await seed(`TEST_1611b_${randomUUID().slice(0, 6)}`)
    await leave(f)
  })
  afterAll(async () => {
    try { await cleanup(f) } catch (e) { console.error('cleanup failed', e) }
  })

  it('(3) the leaver\'s account deletion completes, and the closed chapter keeps the leaver\'s records', async () => {
    const before = await recordCounts(f.G)
    expect(await deleteAccount(f.B)).toBe(1)
    expect(await deletionCompleted(f.B)).toBe(true)
    expect(await db.select().from(oikosGroups).where(eq(oikosGroups.id, f.NB))).toHaveLength(0)
    // Records written by the leaver stay in the stayer's ledger (tombstoned payer).
    expect(await recordCounts(f.G)).toEqual(before)
    expect(await scalar(sql`SELECT count(*)::int n FROM "CashTransactions" WHERE group_id = ${f.G}::uuid AND paid_by = ${f.B}::uuid`)).toBe(5)
    const [p] = await db.select().from(profiles).where(eq(profiles.id, f.B))
    expect(p?.displayName).toBe('已離開的夥伴')
    expect(await crossRefs(f.G)).toEqual(expect.objectContaining({ cashAsset: 0, cashFuelLog: 0, pendExpRule: 0, pendIncRule: 0 }))
  })

  it('(2b) after the leaver\'s deletion the stayer\'s leave-month card 3 still lists the stayer\'s events only', async () => {
    const names = await card3Names(f.G, year, month)
    expect(names).toEqual([`${f.tag} A bonus`, `${f.tag} A gym`])
  })

  it('(3) the stayer\'s later deletion completes too', async () => {
    expect(await deleteAccount(f.A)).toBe(1)
    expect(await deletionCompleted(f.A)).toBe(true)
    expect(await db.select().from(oikosGroups).where(eq(oikosGroups.id, f.G))).toHaveLength(0)
  })

  it('no leftover active fixtures in either ledger', async () => {
    expect(await db.select().from(groupEpochs).where(and(inArray(groupEpochs.groupId, [f.G, f.NB]), isNull(groupEpochs.endedAt)))).toHaveLength(0)
  })
})
