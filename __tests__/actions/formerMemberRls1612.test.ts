import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'

// ─── #1612 acceptance 9: a former member's own session reads nothing of G ───
//
// LOCAL THROWAWAY SERVER ONLY. Skips itself unless DATABASE_URL points at
// localhost; never run it against dev or prod. It creates its OWN database on
// that server (Supabase stand-ins incl. the default ACL, then every migration
// in the journal), runs the cases in rolled-back transactions, and drops it.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:<port>/postgres \
//     npx vitest run __tests__/actions/formerMemberRls1612.test.ts
//
// #1612 opens a closed chapter of the ledger G to the person who left it (B),
// read-only, through the app server (Drizzle, service connection). That must
// not widen what B's OWN session can read through the Data API or Realtime:
// RLS (0080) still gives a non-member of G zero rows, so A's expense and asset
// created after the leave reach B by no path. No migration or policy change
// ships with #1612; this pins the existing boundary it relies on.
//
// Failure look of what this guards: nothing errors. B's browser client,
// subscribed with B's own JWT, quietly receives the stayer's new rows.
// ──────────────────────────────────────────────────────────────────────────

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 })

const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)
const postgres = (await import('postgres')).default

/** The newest migration in the journal (e.g. '0092'). */
async function latestMigration(): Promise<string> {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const journal = JSON.parse(readFileSync(resolve(__dirname, '../../drizzle/meta/_journal.json'), 'utf-8')) as {
    entries: { tag: string }[]
  }
  return journal.entries[journal.entries.length - 1].tag.slice(0, 4)
}

let url = ''
let pg: Sql

class Rollback extends Error {}

async function rolledBack(fn: (tx: TransactionSql) => Promise<void>) {
  try {
    await pg.begin(async (tx) => {
      await fn(tx)
      throw new Rollback()
    })
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
}

/** Run `body` as the user `who` through RLS (what PostgREST and realtime.apply_rls do), then back. */
async function as<T>(tx: TransactionSql, who: string, body: () => Promise<T>): Promise<T> {
  await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: who, role: 'authenticated' })}, true)`
  await tx.unsafe('SET LOCAL ROLE authenticated')
  try {
    return await body()
  } finally {
    await tx.unsafe('RESET ROLE')
  }
}

/** realtime.apply_rls's visibility check for one row, as the subscriber. */
async function realtimeSees(tx: TransactionSql, who: string, table: string, id: string) {
  return as(tx, who, async () => {
    const [r] = await tx.unsafe(`SELECT EXISTS (SELECT 1 FROM "${table}" WHERE id = '${id}') AS v`)
    return r.v as boolean
  })
}

interface World {
  A: string; B: string; B2: string; C: string
  G: string; LB: string
  e1Row: string; newRow: string; newAsset: string; lbRow: string
}

async function world(tx: TransactionSql): Promise<World> {
  const A = randomUUID(), B = randomUUID(), B2 = randomUUID(), C = randomUUID()
  for (const id of [A, B, B2, C]) await tx`INSERT INTO "Profiles" (id, display_name) VALUES (${id}, 'TEST_1612')`
  const ago = (d: number) => tx`SELECT (now() - make_interval(days => ${d}))::text AS t`.then((r) => r[0].t as string)
  const ts = { d60: await ago(60), d40: await ago(40), d30: await ago(30), d20: await ago(20), d10: await ago(10), d5: await ago(5), d3: await ago(3) }

  // G: E0 A+B2 (B2 removed), E1 A+B (B left), solo A, E2 A+C (open).
  const [g] = await tx<{ id: string }[]>`
    INSERT INTO "OikosGroups" (name, member_a, member_b, current_epoch_started_at)
    VALUES ('TEST_1612 G', ${A}, ${C}, ${ts.d5}) RETURNING id`
  await tx`INSERT INTO "GroupEpochs" (group_id, started_at, ended_at, member_a_id, member_b_id) VALUES
    (${g.id}, ${ts.d60}, ${ts.d40}, ${A}, ${B2}),
    (${g.id}, ${ts.d40}, ${ts.d20}, ${A}, ${B}),
    (${g.id}, ${ts.d20}, ${ts.d5}, ${A}, NULL),
    (${g.id}, ${ts.d5}, NULL, ${A}, ${C})`
  const [lb] = await tx<{ id: string }[]>`
    INSERT INTO "OikosGroups" (name, member_a, member_b, current_epoch_started_at)
    VALUES ('TEST_1612 LB', ${B}, NULL, ${ts.d20}) RETURNING id`
  await tx`INSERT INTO "GroupEpochs" (group_id, started_at, ended_at, member_a_id, member_b_id) VALUES (${lb.id}, ${ts.d20}, NULL, ${B}, NULL)`

  const cash = async (group: string, payer: string, at: string) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO "CashTransactions" (group_id, paid_by, amount, split_type, description, category, transacted_at, created_at)
      VALUES (${group}, ${payer}, 100, 'half', 'TEST_1612', 'dining', ${at}, ${at}) RETURNING id`
    return r.id
  }
  const e1Row = await cash(g.id, B, ts.d30)
  const newRow = await cash(g.id, A, ts.d3)
  const lbRow = await cash(lb.id, B, ts.d10)
  const [asset] = await tx<{ id: string }[]>`
    INSERT INTO "Assets" (group_id, type, name, created_at) VALUES (${g.id}, 'house', 'TEST_1612 new', ${ts.d3}) RETURNING id`
  return { A, B, B2, C, G: g.id, LB: lb.id, e1Row, newRow, newAsset: asset.id, lbRow }
}

describe.skipIf(!isLocalDb)('#1612 — RLS for former members (fresh local stand-in, all migrations)', () => {
  beforeAll(async () => {
    url = await createStandInDb(adminUrl, await latestMigration())
    pg = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  })

  afterAll(async () => {
    await pg?.end()
    if (url) await dropStandInDb(adminUrl, url)
  })

  it('B (left) and B2 (removed) read 0 of G\'s CashTransactions through their own session', async () => {
    await rolledBack(async (tx) => {
      const w = await world(tx)
      for (const who of [w.B, w.B2]) {
        const rows = await as(tx, who, () => tx`SELECT id FROM "CashTransactions" WHERE group_id = ${w.G}`)
        expect(rows).toHaveLength(0)
      }
      // Positive controls: the stayer reads G; B reads their own ledger.
      const aRows = await as(tx, w.A, () => tx`SELECT id FROM "CashTransactions" WHERE group_id = ${w.G}`)
      expect(aRows.map((r) => r.id).sort()).toEqual([w.e1Row, w.newRow].sort())
      const bOwn = await as(tx, w.B, () => tx`SELECT id FROM "CashTransactions" WHERE group_id = ${w.LB}`)
      expect(bOwn.map((r) => r.id)).toEqual([w.lbRow])
    })
  })

  it('Realtime\'s check for A\'s new expense and new asset is false for B and B2, true for A and C', async () => {
    await rolledBack(async (tx) => {
      const w = await world(tx)
      for (const who of [w.B, w.B2]) {
        expect(await realtimeSees(tx, who, 'CashTransactions', w.newRow)).toBe(false)
        expect(await realtimeSees(tx, who, 'Assets', w.newAsset)).toBe(false)
        expect(await realtimeSees(tx, who, 'CashTransactions', w.e1Row)).toBe(false)
      }
      for (const who of [w.A, w.C]) {
        expect(await realtimeSees(tx, who, 'CashTransactions', w.newRow)).toBe(true)
        expect(await realtimeSees(tx, who, 'Assets', w.newAsset)).toBe(true)
      }
    })
  })
})
