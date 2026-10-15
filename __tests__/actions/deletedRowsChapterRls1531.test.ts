import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Sql, TransactionSql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl, migrateThrough } from './_supabaseStandIn'
import { privilegeLines, ALLOWLIST_AFTER_0080 } from './_dataApiAllowlist'
import { rolledBack as rolledBackOn, as, sqlstate, world, realtimeSees, type Who, type World } from './_chapterWorld1518'

// ─── 0094: deleted / processed rows stop at the chapter (#1531) ─────────────
//
// LOCAL THROWAWAY SERVER ONLY. Skips itself unless DATABASE_URL points at
// localhost; never run it against dev or prod. Creates its OWN database on
// that server (./_supabaseStandIn.ts, default ACL included), migrates it
// through 0092, runs the "before" control, applies 0094 through drizzle's
// migrator (plus anything numbered in between), runs the "after" cases and
// drops the database. Data cases run in transactions that are rolled back.
//
//   DATABASE_URL=postgres://postgres:pg@127.0.0.1:55518/postgres \
//     npx vitest run __tests__/actions/deletedRowsChapterRls1531.test.ts
//
// World: the #1518 world (./_chapterWorld1518.ts — ledger G: chapter 1 A+B
// −30d…−10d, chapter 2 A solo −10d…−5d, chapter 3 A+C −5d…; B's solo ledger SB
// from −10d) plus, per table, rows deleted / skipped / confirmed in chapters 1
// and 2, live rows created in chapter 1, a row deleted exactly at chapter 3's
// start, frozen copies, and B's own deleted rows in SB.
//
// Failure look of what this guards: nothing errors. Too loose, a later partner
// reads 愛物 deleted before they joined with their own session; too tight, the
// delete / skip / confirm Realtime frame silently stops reaching the other
// member (no redirect, no dashboard refresh until a reload).
// ──────────────────────────────────────────────────────────────────────────────

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 })

const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)
const postgres = (await import('postgres')).default

const read = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf-8')
const TAG_0094 = '0094_deleted_rows_chapter_rls'
const STATEMENTS_0094 = read(`drizzle/${TAG_0094}.sql`)
  .split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
const DOWN_0094 = read(`scripts/rollback/${TAG_0094}.down.sql`)
const WHEN_0094 = (JSON.parse(read('drizzle/meta/_journal.json')) as { entries: { tag: string; when: number }[] })
  .entries.find((e) => e.tag === TAG_0094)!.when

const TABLES = ['Assets', 'RecurringIncomeRules', 'RecurringExpenseRules', 'PendingIncomeOccurrences', 'PendingExpenseOccurrences'] as const
type Table = (typeof TABLES)[number]
const POLICY: Record<Table, string> = {
  Assets: 'assets_group_member_select',
  RecurringIncomeRules: 'rules_group_member_select',
  RecurringExpenseRules: 'expense_rules_group_member_select',
  PendingIncomeOccurrences: 'pendings_group_member_select',
  PendingExpenseOccurrences: 'expense_pendings_group_member_select',
}

let url = ''
let pg: Sql
let prePolicies: string[] = []
let preLines: string[] = []

const rolledBack = (fn: (tx: TransactionSql) => Promise<void>) => rolledBackOn(pg, fn)

/** Every public policy, with roles — the rollback must restore them exactly. */
async function policyLines(sql: Sql | TransactionSql) {
  const rows = await sql<{ l: string }[]>`
    SELECT tablename || '|' || policyname || '|' || cmd || '|' || permissive || '|' || roles::text || '|'
           || coalesce(qual, '') || '|' || coalesce(with_check, '') AS l
      FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`
  return rows.map((r) => r.l)
}

/** Permissive policies that apply to SELECT for authenticated, per table (OR-ed, so more than one can only widen). */
async function selectPolicyCounts(sql: Sql | TransactionSql) {
  const rows = await sql<{ t: string; n: number }[]>`
    SELECT tablename AS t, count(*)::int AS n FROM pg_policies
     WHERE schemaname = 'public' AND tablename IN ${sql(TABLES as unknown as string[])}
       AND permissive = 'PERMISSIVE' AND cmd IN ('SELECT', 'ALL')
       AND (roles && ARRAY['authenticated', 'public']::name[])
     GROUP BY 1 ORDER BY 1`
  return Object.fromEntries(rows.map((r) => [r.t, r.n]))
}

interface W1531 extends World {
  /** Rows that only someone in the chapter of the deletion / skip / confirmation may see. */
  old: Record<'ch1' | 'ch2', Record<Table, string[]>>
  /** Live rows created in chapter 1 — every current member sees them. */
  live: Record<Table, string[]>
  /** Deleted exactly at chapter 3's started_at. */
  boundary: { asset: string; rule: string }
  /** Frozen copies: z = 0079's copy (not deleted); f1d3 frozen in ch1, deleted in ch3; f3d1 frozen in ch3, deleted in ch1; f3d3 both in ch3. */
  frozen: { z: string; f1d3: string; f3d1: string; f3d3: string }
  /** Rows written by the "now" actions below (live before the action). */
  now: { asset: string; incomeRule: string; expenseRule: string; skipIncome: string; skipExpense: string; confirmIncome: string; confirmExpense: string }
  /** B's own deleted rows moved into B's solo ledger SB (deleted −20d, older than SB's first chapter). */
  movedRows: { asset: string; rule: string }
  D: string
}

async function world1531(tx: TransactionSql): Promise<W1531> {
  const w = await world(tx)
  const { A, B, G, SB, ts } = w
  const D = randomUUID() // a signed-in user with no ledger at all
  await tx`INSERT INTO "Profiles" (id, display_name) VALUES (${D}, 'TEST_1531')`

  const asset = async (group: string, name: string, deletedAt: string | null, frozenAt: string | null = null, createdAt = ts.d30) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO "Assets" (group_id, type, name, notes, created_at, frozen_at, deleted_at)
      VALUES (${group}, 'car', ${name}, 'TEST_1531 notes', ${createdAt}, ${frozenAt}, ${deletedAt}) RETURNING id`
    return r.id
  }
  const incomeRule = async (group: string, who: string, deletedAt: string | null, pausedAt: string | null = null) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO "RecurringIncomeRules" (group_id, recipient_id, amount, category, day_of_month, starts_on, next_occurrence_at, created_at, deleted_at, paused_at)
      VALUES (${group}, ${who}, 100, 'salary', 1, ${ts.d30}::timestamptz::date, now()::date, ${ts.d30}, ${deletedAt}, ${pausedAt}) RETURNING id`
    return r.id
  }
  const expenseRule = async (group: string, who: string, deletedAt: string | null, pausedAt: string | null = null) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO "RecurringExpenseRules" (group_id, paid_by, amount, split_type, description, category, day_of_month, starts_on, next_occurrence_at, created_at, deleted_at, paused_at)
      VALUES (${group}, ${who}, 100, 'half', 'TEST_1531 rule', 'housing', 1, ${ts.d30}::timestamptz::date, now()::date, ${ts.d30}, ${deletedAt}, ${pausedAt}) RETURNING id`
    return r.id
  }
  const pIncomeRule = await incomeRule(G, A, null)
  const pExpenseRule = await expenseRule(G, A, null)
  let period = 0
  const incomePending = async (skippedAt: string | null, resolvedTx: string | null) => {
    period += 1
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO "PendingIncomeOccurrences" (group_id, rule_id, period_start, proposed_amount, proposed_date, created_at, skipped_at, resolved_tx_id)
      VALUES (${G}, ${pIncomeRule}, (now() - make_interval(months => ${period}))::date, 100, now()::date, ${ts.d30}, ${skippedAt}, ${resolvedTx}) RETURNING id`
    return r.id
  }
  const expensePending = async (skippedAt: string | null, resolvedTx: string | null) => {
    period += 1
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO "PendingExpenseOccurrences" (group_id, rule_id, period_start, proposed_amount, proposed_date, proposed_description, proposed_paid_by, proposed_split_type, created_at, skipped_at, resolved_tx_id)
      VALUES (${G}, ${pExpenseRule}, (now() - make_interval(months => ${period}))::date, 100, now()::date, 'TEST_1531 pending', ${A}, 'half', ${ts.d30}, ${skippedAt}, ${resolvedTx}) RETURNING id`
    return r.id
  }

  const old = { ch1: {} as Record<Table, string[]>, ch2: {} as Record<Table, string[]> }
  for (const [ch, at, k] of [['ch1', ts.d20, 'd20'], ['ch2', ts.d7, 'd7']] as const) {
    old[ch] = {
      Assets: [await asset(G, `TEST_1531 deleted in ${ch}`, at)],
      RecurringIncomeRules: [await incomeRule(G, A, at)],
      RecurringExpenseRules: [await expenseRule(G, A, at)],
      // skipped in the chapter; confirmed as a transaction created in the chapter
      PendingIncomeOccurrences: [await incomePending(at, null), await incomePending(null, w.rows.IncomeTransactions[k])],
      PendingExpenseOccurrences: [await expensePending(at, null), await expensePending(null, w.rows.CashTransactions[k])],
    }
  }
  // Confirmed as a transaction older than the first chapter (→ chapter 1).
  old.ch1.PendingIncomeOccurrences.push(await incomePending(null, w.rows.IncomeTransactions.d40))
  old.ch1.PendingExpenseOccurrences.push(await expensePending(null, w.rows.CashTransactions.d40))

  const [x] = await tx<{ id: string }[]>`SELECT id FROM "Assets" WHERE group_id = ${G} AND name LIKE '%X (chapter 1)%'`
  const live: Record<Table, string[]> = {
    Assets: [x.id],
    RecurringIncomeRules: [pIncomeRule, await incomeRule(G, A, null, ts.d20)], // the second one paused in chapter 1
    RecurringExpenseRules: [pExpenseRule, await expenseRule(G, A, null, ts.d20)],
    PendingIncomeOccurrences: [await incomePending(null, null)],
    PendingExpenseOccurrences: [await expensePending(null, null)],
  }
  const boundary = { asset: await asset(G, 'TEST_1531 deleted at chapter 3 start', ts.d5), rule: await incomeRule(G, A, ts.d5) }

  const [z] = await tx<{ id: string }[]>`SELECT id FROM "Assets" WHERE group_id = ${G} AND name LIKE '%Z (frozen copy)%'`
  const frozen = {
    z: z.id,
    f1d3: await asset(G, 'TEST_1531 frozen ch1, deleted ch3', ts.d3, ts.d20),
    f3d1: await asset(G, 'TEST_1531 frozen ch3, deleted ch1', ts.d20, ts.d3),
    f3d3: await asset(G, 'TEST_1531 frozen ch3, deleted ch3', ts.d3, ts.d3),
  }

  const now = {
    asset: await asset(G, 'TEST_1531 deleted now', null, null, ts.d20),
    incomeRule: await incomeRule(G, A, null),
    expenseRule: await expenseRule(G, A, null),
    skipIncome: await incomePending(null, null),
    skipExpense: await expensePending(null, null),
    confirmIncome: await incomePending(null, null),
    confirmExpense: await expensePending(null, null),
  }

  const movedRows = { asset: await asset(SB, 'TEST_1531 B moved deleted', ts.d20), rule: await expenseRule(SB, B, ts.d20) }
  return { ...w, old, live, boundary, frozen, now, movedRows, D }
}

/** Ids among `ids` that `who` can read from `table` (only id / group_id are selected — the columns authenticated holds). */
async function readable(tx: TransactionSql, who: Who, table: Table, ids: string[]) {
  return as(tx, who, async () =>
    (await tx<{ id: string }[]>`SELECT id, group_id FROM ${tx(table)} WHERE id IN ${tx(ids)}`).map((r) => r.id).sort())
}

const allOld = (w: W1531, table: Table) => [...w.old.ch1[table], ...w.old.ch2[table]].sort()

describe.skipIf(!isLocalDb)('0094 deleted / processed rows chapter-scoped — fresh local stand-in', () => {
  beforeAll(async () => {
    url = await createStandInDb(adminUrl, '0092')
    pg = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
    prePolicies = await policyLines(pg)
    preLines = await privilegeLines(pg)
  })

  afterAll(async () => {
    await pg?.end()
    if (url) await dropStandInDb(adminUrl, url)
  })

  describe('before 0094 (positive control: the stand-in reproduces the exposure)', () => {
    it('the later partner reads rows deleted / skipped / confirmed before they joined', async () => {
      expect(preLines).toEqual(ALLOWLIST_AFTER_0080)
      await rolledBack(async (tx) => {
        const w = await world1531(tx)
        for (const t of TABLES) expect(await readable(tx, w.C, t, allOld(w, t)), t).toEqual(allOld(w, t))
        const names = await as(tx, w.C, () => tx`SELECT name, notes FROM "Assets" WHERE id = ${w.old.ch1.Assets[0]}`)
        expect(names).toEqual([{ name: 'TEST_1531 deleted in ch1', notes: 'TEST_1531 notes' }])
      })
    })
  })

  describe('after 0094', () => {
    beforeAll(async () => {
      await migrateThrough(url, '0094')
      const [{ n }] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE created_at = ${WHEN_0094}`
      if (n !== 1) throw new Error('0094 was not applied by the migrator')
    })

    it('1. the later partner cannot see rows deleted / skipped / confirmed in chapters 1 and 2, by SELECT or Realtime', async () => {
      await rolledBack(async (tx) => {
        const w = await world1531(tx)
        for (const t of TABLES) {
          expect(await readable(tx, w.C, t, allOld(w, t)), t).toEqual([])
          for (const id of allOld(w, t)) expect(await realtimeSees(tx, w.C, t, id), `${t} ${id}`).toBe(false)
        }
        // The deleted 愛物's name / notes are no longer readable.
        expect(await as(tx, w.C, () => tx`SELECT name FROM "Assets" WHERE id IN ${tx(allOld(w, 'Assets'))}`)).toEqual([])
      })
    })

    it('2. anon gets 42501; a signed-in non-member and no session see nothing', async () => {
      await rolledBack(async (tx) => {
        const w = await world1531(tx)
        for (const t of TABLES) {
          expect(await sqlstate(tx, 'anon', `SELECT id FROM "${t}" LIMIT 1`), t).toBe('42501')
          const every = [...allOld(w, t), ...w.live[t]]
          expect(await readable(tx, w.D, t, every), t).toEqual([])
          expect(await readable(tx, 'no-session', t, every), t).toEqual([])
        }
      })
    })

    it('3. exactly one permissive SELECT policy per table; an added permissive policy is caught', async () => {
      await rolledBack(async (tx) => {
        expect(await selectPolicyCounts(tx)).toEqual(Object.fromEntries(TABLES.map((t) => [t, 1])))
        const pols = await tx<{ tablename: Table; policyname: string; cmd: string; permissive: string; roles: string; qual: string }[]>`
          SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual FROM pg_policies
           WHERE schemaname = 'public' AND tablename IN ${tx(TABLES as unknown as string[])} ORDER BY tablename`
        expect(pols.map((p) => [p.tablename, p.policyname, p.cmd, p.permissive, p.roles])).toEqual(
          [...TABLES].sort().map((t) => [t, POLICY[t], 'SELECT', 'PERMISSIVE', '{authenticated}']))
        for (const p of pols) expect(p.qual, p.tablename).toContain('viewer_in_chapter(')
        expect(pols.find((p) => p.tablename === 'Assets')!.qual).toContain('frozen_copy_visible(')
        expect(pols.find((p) => p.tablename === 'PendingIncomeOccurrences')!.qual).toContain('"IncomeTransactions"')
        expect(pols.find((p) => p.tablename === 'PendingExpenseOccurrences')!.qual).toContain('"CashTransactions"')

        // Negative control: OR-ed with the chapter policy, an extra permissive one reopens #1531.
        const w = await world1531(tx)
        await tx.unsafe(`CREATE POLICY "test_1531_wide" ON "Assets" FOR SELECT TO authenticated USING (true)`)
        expect(await readable(tx, w.C, 'Assets', allOld(w, 'Assets'))).toEqual(allOld(w, 'Assets'))
        expect((await selectPolicyCounts(tx)).Assets).toBe(2)
      })
    })

    it('4. the stayer sees every row deleted / skipped / confirmed in chapters 1 and 2', async () => {
      await rolledBack(async (tx) => {
        const w = await world1531(tx)
        for (const t of TABLES) {
          expect(await readable(tx, w.A, t, allOld(w, t)), t).toEqual(allOld(w, t))
          for (const id of allOld(w, t)) expect(await realtimeSees(tx, w.A, t, id), `${t} ${id}`).toBe(true)
        }
      })
    })

    it('5. a soft-delete, a skip and a confirm made now reach both current members (Realtime UPDATE frame)', async () => {
      await rolledBack(async (tx) => {
        const w = await world1531(tx)
        // What actions/asset.ts, actions/recurring*.ts write (deletedAt / skippedAt = new Date(); confirm inserts the
        // transaction with created_at defaulting to now() and sets resolved_tx_id).
        await tx`UPDATE "Assets" SET deleted_at = now() WHERE id = ${w.now.asset}`
        await tx`UPDATE "RecurringIncomeRules" SET deleted_at = now() WHERE id = ${w.now.incomeRule}`
        await tx`UPDATE "RecurringExpenseRules" SET deleted_at = now() WHERE id = ${w.now.expenseRule}`
        await tx`UPDATE "PendingIncomeOccurrences" SET skipped_at = now() WHERE id = ${w.now.skipIncome}`
        await tx`UPDATE "PendingExpenseOccurrences" SET skipped_at = now() WHERE id = ${w.now.skipExpense}`
        const [it] = await tx<{ id: string }[]>`
          INSERT INTO "IncomeTransactions" (group_id, recipient_id, amount, category, occurred_at)
          VALUES (${w.G}, ${w.A}, 100, 'salary', now()::date) RETURNING id`
        await tx`UPDATE "PendingIncomeOccurrences" SET resolved_tx_id = ${it.id} WHERE id = ${w.now.confirmIncome}`
        const [ct] = await tx<{ id: string }[]>`
          INSERT INTO "CashTransactions" (group_id, paid_by, amount, split_type, description, category, transacted_at)
          VALUES (${w.G}, ${w.A}, 100, 'half', 'TEST_1531 confirmed', 'housing', now()) RETURNING id`
        await tx`UPDATE "PendingExpenseOccurrences" SET resolved_tx_id = ${ct.id} WHERE id = ${w.now.confirmExpense}`

        const frames: [Table, string][] = [
          ['Assets', w.now.asset],
          ['RecurringIncomeRules', w.now.incomeRule], ['RecurringExpenseRules', w.now.expenseRule],
          ['PendingIncomeOccurrences', w.now.skipIncome], ['PendingExpenseOccurrences', w.now.skipExpense],
          ['PendingIncomeOccurrences', w.now.confirmIncome], ['PendingExpenseOccurrences', w.now.confirmExpense],
        ]
        for (const who of [w.A, w.C]) {
          for (const [t, id] of frames) expect(await realtimeSees(tx, who, t, id), `${who === w.A ? 'A' : 'C'} ${t} ${id}`).toBe(true)
          // AssetDetailClient / SavingsView redirect on the frame's deleted_at.
          const [r] = await as(tx, who, () => tx`SELECT deleted_at IS NOT NULL AS d FROM "Assets" WHERE id = ${w.now.asset}`)
          expect(r?.d).toBe(true)
        }
      })
    })

    it('6. live rows created in chapter 1 (incl. a paused rule) stay visible to the later partner', async () => {
      await rolledBack(async (tx) => {
        const w = await world1531(tx)
        for (const t of TABLES) {
          expect(await readable(tx, w.C, t, w.live[t]), t).toEqual([...w.live[t]].sort())
          for (const id of w.live[t]) expect(await realtimeSees(tx, w.C, t, id), `${t} ${id}`).toBe(true)
        }
      })
    })

    it('7. frozen copies unchanged (A yes, C no); a deleted frozen copy must pass both checks', async () => {
      await rolledBack(async (tx) => {
        const w = await world1531(tx)
        const f = w.frozen
        const ids = [f.z, f.f1d3, f.f3d1, f.f3d3]
        expect(await readable(tx, w.A, 'Assets', ids)).toEqual([...ids].sort())
        // z: frozen in ch2 (C absent) · f1d3: frozen check fails · f3d1: frozen passes, chapter check fails · f3d3: both pass.
        expect(await readable(tx, w.C, 'Assets', ids)).toEqual([f.f3d3])
      })
    })

    it('8. deleted_at exactly at chapter 3\'s started_at is visible to the later partner', async () => {
      await rolledBack(async (tx) => {
        const w = await world1531(tx)
        expect(await readable(tx, w.C, 'Assets', [w.boundary.asset])).toEqual([w.boundary.asset])
        expect(await readable(tx, w.C, 'RecurringIncomeRules', [w.boundary.rule])).toEqual([w.boundary.rule])
      })
    })

    it('9. the leaver still sees their own deleted rows moved into their solo ledger; nothing of G', async () => {
      await rolledBack(async (tx) => {
        const w = await world1531(tx)
        expect(await readable(tx, w.B, 'Assets', [w.movedRows.asset])).toEqual([w.movedRows.asset])
        expect(await readable(tx, w.B, 'RecurringExpenseRules', [w.movedRows.rule])).toEqual([w.movedRows.rule])
        for (const t of TABLES) expect(await readable(tx, w.B, t, [...w.old.ch1[t], ...w.live[t]]), t).toEqual([])
      })
    })

    it('10. SELECT id, group_id as the later partner raises no 42501 on rules and pendings', async () => {
      await rolledBack(async (tx) => {
        const w = await world1531(tx)
        // The policy reads a column authenticated holds no grant on; only the query's own columns are checked.
        const policyColumn: Partial<Record<Table, string>> = {
          RecurringIncomeRules: 'deleted_at', RecurringExpenseRules: 'deleted_at',
          PendingIncomeOccurrences: 'skipped_at', PendingExpenseOccurrences: 'resolved_tx_id',
        }
        for (const [t, col] of Object.entries(policyColumn)) {
          expect(await sqlstate(tx, w.C, `SELECT id, group_id FROM "${t}"`), t).toBeNull()
          expect(await as(tx, w.C, () => tx`SELECT id FROM ${tx(t)} WHERE id IN ${tx(w.live[t as Table])}`), t).toHaveLength(w.live[t as Table].length)
          // …and that column is still not granted (no fallback grant was needed).
          expect(await sqlstate(tx, w.C, `SELECT ${col} FROM "${t}"`), `${t}.${col}`).toBe('42501')
        }
      })
    })

    it('11. the anon / authenticated privilege matrix is unchanged by 0094', async () => {
      await rolledBack(async (tx) => {
        expect(await privilegeLines(tx)).toEqual(preLines)
        expect(await privilegeLines(tx)).toEqual(ALLOWLIST_AFTER_0080)
      })
    })

    it('12. the rollback restores the pre-0094 policies and privileges exactly; 0094 re-applies idempotently', async () => {
      await rolledBack(async (tx) => {
        const w = await world1531(tx)
        await tx.unsafe(DOWN_0094)
        expect(await policyLines(tx)).toEqual(prePolicies)
        expect(await privilegeLines(tx)).toEqual(preLines)
        expect(await privilegeLines(tx)).toEqual(ALLOWLIST_AFTER_0080)
        const [{ n }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE created_at = ${WHEN_0094}`
        expect(n).toBe(0)
        expect(await readable(tx, w.C, 'Assets', allOld(w, 'Assets'))).toEqual(allOld(w, 'Assets')) // #1531 is back

        for (const stmt of STATEMENTS_0094) await tx.unsafe(stmt)
        for (const stmt of STATEMENTS_0094) await tx.unsafe(stmt) // idempotent
        expect(await selectPolicyCounts(tx)).toEqual(Object.fromEntries(TABLES.map((t) => [t, 1])))
        for (const t of TABLES) expect(await readable(tx, w.C, t, allOld(w, t)), t).toEqual([])
      })
    })
  })
})
