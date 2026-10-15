// ─── The #1518 chapter world and "act as a user" helpers, for stand-in suites ─
//
// Shared by chapterScopedRls1518.test.ts (0080) and
// deletedRowsChapterRls1531.test.ts (0094). LOCAL STAND-IN DATABASES ONLY
// (see ./_supabaseStandIn.ts); every caller runs these inside a transaction
// that is rolled back.
//
// World: ledger G — chapter 1 A+B (−30d … −10d), B leaves; chapter 2 A solo
// (−10d … −5d); chapter 3 A+C (−5d …). Money rows in G at −40d (older than
// the first chapter → belongs to it), −20d, −7d, −3d. B's own row moved into
// B's new solo ledger SB keeps created_at −20d (older than SB's first chapter).
// Acting as a user = SET LOCAL ROLE authenticated + request.jwt.claims, which
// is what PostgREST and realtime.apply_rls do.
// ──────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'

export const MONEY = ['CashTransactions', 'IncomeTransactions', 'Settlements'] as const

export class Rollback extends Error {}

/** Run fn in a transaction on `pg` that is always rolled back. */
export async function rolledBack(pg: Sql, fn: (tx: TransactionSql) => Promise<void>) {
  try {
    await pg.begin(async (tx) => {
      await fn(tx)
      throw new Rollback()
    })
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
}

export type Who = string | 'anon' | 'no-session'

export async function become(tx: TransactionSql, who: Who) {
  if (who === 'anon') {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: 'anon' })}, true)`
    await tx.unsafe('SET LOCAL ROLE anon')
  } else if (who === 'no-session') {
    await tx`SELECT set_config('request.jwt.claims', '', true)`
    await tx.unsafe('SET LOCAL ROLE authenticated')
  } else {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: who, role: 'authenticated' })}, true)`
    await tx.unsafe('SET LOCAL ROLE authenticated')
  }
}

/** Run `body` as `who` through RLS, then back to postgres. Errors propagate. */
export async function as<T>(tx: TransactionSql, who: Who, body: () => Promise<T>): Promise<T> {
  await become(tx, who)
  try {
    return await body()
  } finally {
    await tx.unsafe('RESET ROLE')
  }
}

/** SQLSTATE of `query` run as `who` inside a savepoint, or null if it succeeded. Leaves no effects. */
export async function sqlstate(tx: TransactionSql, who: Who, query: string): Promise<string | null> {
  try {
    await tx.savepoint(async (sp) => {
      await become(sp as unknown as TransactionSql, who)
      await sp.unsafe(query)
      throw new Rollback()
    })
  } catch (e) {
    if (e instanceof Rollback) return null
    return (e as { code?: string }).code ?? String(e)
  }
  return null
}

export interface World {
  A: string; B: string; C: string
  G: string; SB: string
  rows: Record<(typeof MONEY)[number], { d40: string; d20: string; d7: string; d3: string }>
  moved: string
  fuel: { x3: string; x20: string; y20: string; z3: string }
  ts: { d40: string; d30: string; d20: string; d10: string; d7: string; d5: string; d3: string }
}

export async function world(tx: TransactionSql): Promise<World> {
  const A = randomUUID(), B = randomUUID(), C = randomUUID()
  for (const id of [A, B, C]) await tx`INSERT INTO "Profiles" (id, display_name) VALUES (${id}, 'TEST_1518')`
  const ago = (d: number) => tx`SELECT (now() - make_interval(days => ${d}))::text AS t`.then((r) => r[0].t as string)
  const ts = { d40: await ago(40), d30: await ago(30), d20: await ago(20), d10: await ago(10), d7: await ago(7), d5: await ago(5), d3: await ago(3) }

  const [g] = await tx<{ id: string }[]>`
    INSERT INTO "OikosGroups" (name, member_a, member_b, current_epoch_started_at)
    VALUES ('TEST_1518 G', ${A}, ${C}, ${ts.d5}) RETURNING id`
  await tx`INSERT INTO "GroupEpochs" (group_id, started_at, ended_at, member_a_id, member_b_id) VALUES
    (${g.id}, ${ts.d30}, ${ts.d10}, ${A}, ${B}),
    (${g.id}, ${ts.d10}, ${ts.d5}, ${A}, NULL),
    (${g.id}, ${ts.d5}, NULL, ${A}, ${C})`
  const [sb] = await tx<{ id: string }[]>`
    INSERT INTO "OikosGroups" (name, member_a, member_b, current_epoch_started_at)
    VALUES ('TEST_1518 SB', ${B}, NULL, ${ts.d10}) RETURNING id`
  await tx`INSERT INTO "GroupEpochs" (group_id, started_at, ended_at, member_a_id, member_b_id) VALUES (${sb.id}, ${ts.d10}, NULL, ${B}, NULL)`
  await tx`INSERT INTO "GroupBalance" (group_id, balance, version) VALUES (${g.id}, 0, 1) ON CONFLICT (group_id) DO NOTHING`

  const cash = async (group: string, payer: string, at: string) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO "CashTransactions" (group_id, paid_by, amount, split_type, split_ratio_a, description, category, transacted_at, created_at)
      VALUES (${group}, ${payer}, 100, 'weighted', 60, 'TEST_1518', 'dining', ${at}, ${at}) RETURNING id`
    return r.id
  }
  const income = async (at: string) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO "IncomeTransactions" (group_id, recipient_id, amount, category, occurred_at, created_at)
      VALUES (${g.id}, ${A}, 100, 'salary', ${at}::timestamptz::date, ${at}) RETURNING id`
    return r.id
  }
  const settle = async (at: string) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO "Settlements" (group_id, paid_by, amount, settled_at, created_at)
      VALUES (${g.id}, ${A}, 100, ${at}, ${at}) RETURNING id`
    return r.id
  }
  const rows = {
    CashTransactions: { d40: await cash(g.id, A, ts.d40), d20: await cash(g.id, A, ts.d20), d7: await cash(g.id, A, ts.d7), d3: await cash(g.id, A, ts.d3) },
    IncomeTransactions: { d40: await income(ts.d40), d20: await income(ts.d20), d7: await income(ts.d7), d3: await income(ts.d3) },
    Settlements: { d40: await settle(ts.d40), d20: await settle(ts.d20), d7: await settle(ts.d7), d3: await settle(ts.d3) },
  }
  const moved = await cash(sb.id, B, ts.d20)

  const asset = async (name: string, at: string, frozenAt: string | null) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO "Assets" (group_id, type, name, created_at, frozen_at) VALUES (${g.id}, 'car', ${name}, ${at}, ${frozenAt}) RETURNING id`
    return r.id
  }
  const X = await asset('TEST_1518 X (chapter 1)', ts.d20, null)
  const Y = await asset('TEST_1518 Y (chapter 3)', ts.d3, null)
  const Z = await asset('TEST_1518 Z (frozen copy)', ts.d20, ts.d10)
  const fl = async (assetId: string, at: string) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO "FuelLogs" (asset_id, liters, fuel_type, odometer, logged_at, created_at)
      VALUES (${assetId}, '30.00', '95', 1000, ${at}, ${at}) RETURNING id`
    return r.id
  }
  const fuel = { x3: await fl(X, ts.d3), x20: await fl(X, ts.d20), y20: await fl(Y, ts.d20), z3: await fl(Z, ts.d3) }

  await tx`INSERT INTO "RecurringExpenseRules" (group_id, paid_by, amount, split_type, description, category, day_of_month, starts_on, next_occurrence_at)
           VALUES (${g.id}, ${A}, 100, 'half', 'TEST_1518 rent', 'housing', 1, now()::date, now()::date)`
  await tx`INSERT INTO "Trips" (group_id, epoch_id, name, start_date)
           SELECT ${g.id}, e.id, 'TEST_1518 chapter-1 trip', ${ts.d20}::timestamptz::date FROM "GroupEpochs" e
            WHERE e.group_id = ${g.id} AND e.member_b_id = ${B}`
  return { A, B, C, G: g.id, SB: sb.id, rows, moved, fuel, ts }
}

/** realtime.apply_rls's visibility check for one row: `select exists(select 1 from <t> where id = …)` as the subscriber. */
export async function realtimeSees(tx: TransactionSql, who: Who, table: string, id: string) {
  return as(tx, who, async () => {
    const [r] = await tx.unsafe(`SELECT EXISTS (SELECT 1 FROM "${table}" WHERE id = '${id}') AS v`)
    return r.v as boolean
  })
}
