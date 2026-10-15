import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'
import { isMonthInChapter } from '@/lib/monthlyReview'

// ─── #1621: the monthly review snapshot counts only the chapter's own rows ──
//
// LOCAL THROWAWAY SERVER ONLY. DATABASE_URL must point at a local Postgres 17
// server (the admin database); the suite creates a fresh Supabase stand-in
// database on it, migrated through 0093 (createStandInDb), and drops it at the
// end. It skips itself unless DATABASE_URL is localhost — never dev or prod.
//
//   DATABASE_URL=postgres://postgres@localhost:<port>/postgres \
//     npx vitest run __tests__/actions/reviewSnapshotChapter1621.test.ts
//
// Rows belong to a chapter by created_at (GroupEpochs [started_at, ended_at)),
// the snapshot picks a month by transacted_at / occurred_at. Since 0093, a
// month that lies wholly inside one chapter counts only rows CREATED inside
// that chapter, on every card; a straddling month and a group without
// chapters stay unfiltered.
//
// Failure this guards: nothing errors. C opens a month of the A+C chapter and
// reads an amount and description B recorded (future-dated) while A+B were
// together — or a row created later and backdated changes a closed chapter's
// month. Control runs swap in 0089's body and show the leak.
// ──────────────────────────────────────────────────────────────────────────────

const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)

const postgres = (await import('postgres')).default

const migration = (file: string) => readFileSync(resolve(__dirname, '../../drizzle', file), 'utf-8')
const fnOf = (file: string) =>
  migration(file).split('--> statement-breakpoint')
    .find((s) => s.includes('CREATE OR REPLACE FUNCTION public.compute_monthly_review_snapshot'))!
const FN_0093 = fnOf('0093_review_snapshot_chapter.sql')
const FN_0089 = fnOf('0089_review_payer_id.sql')
const SIGNATURE = 'public.compute_monthly_review_snapshot(uuid, integer, integer)'

/** An instant in Asia/Taipei (UTC+8), as a timestamptz literal with full precision. */
// Passed as text and cast in SQL: a parameter postgres-js sees typed as
// timestamptz goes through JS Date and loses its microseconds.
const tpe = (local: string) => `${local}+08`
/** Taipei-noon of a date: same-day rows (lib/validators.ts stores UTC noon; any in-day instant works here). */
const day = (d: string) => tpe(`${d} 12:00:00`)

let url = ''
let pg: Sql

async function profile(): Promise<string> {
  const id = randomUUID()
  // on_auth_user_created (handle_new_user) inserts the Profiles row.
  await pg`INSERT INTO auth.users (id, raw_user_meta_data) VALUES (${id}, '{"full_name":"TEST_1621"}'::jsonb)`
  return id
}

async function group(a: string, b: string | null): Promise<string> {
  const [g] = await pg<{ id: string }[]>`
    INSERT INTO "OikosGroups" (name, member_a, member_b, current_epoch_started_at, base_currency)
    VALUES ('TEST_1621', ${a}, ${b}, now(), 'twd') RETURNING id`
  return g.id
}

async function chapter(groupId: string, startedAt: string, endedAt: string | null, a: string, b: string | null) {
  await pg`
    INSERT INTO "GroupEpochs" (group_id, started_at, ended_at, member_a_id, member_b_id)
    VALUES (${groupId}, ${startedAt}::text::timestamptz, ${endedAt}::text::timestamptz, ${a}, ${b})`
}

async function asset(groupId: string, name: string): Promise<string> {
  const [r] = await pg<{ id: string }[]>`
    INSERT INTO "Assets" (group_id, type, name) VALUES (${groupId}, 'item', ${name}) RETURNING id`
  return r.id
}

type Tx = {
  paidBy: string
  amount: number
  at: string // transacted_at
  createdAt: string
  description: string
  category?: string
  split?: 'half' | 'all_mine'
  assetId?: string | null
}

async function cashTx(groupId: string, t: Tx): Promise<string> {
  const [r] = await pg<{ id: string }[]>`
    INSERT INTO "CashTransactions"
      (group_id, paid_by, amount, split_type, description, category, transacted_at, created_at, asset_id)
    VALUES (${groupId}, ${t.paidBy}, ${t.amount}, ${t.split ?? 'half'}, ${t.description}, ${t.category ?? 'dining'},
            ${t.at}::text::timestamptz, ${t.createdAt}::text::timestamptz, ${t.assetId ?? null}) RETURNING id`
  return r.id
}

async function recurringExpense(groupId: string, t: Tx & { rule: string }) {
  const [rule] = await pg<{ id: string }[]>`
    INSERT INTO "RecurringExpenseRules"
      (group_id, paid_by, amount, split_type, description, category, day_of_month, starts_on, next_occurrence_at)
    VALUES (${groupId}, ${t.paidBy}, ${t.amount}, 'half', ${t.rule}, 'housing', 10, '2025-01-10', '2027-01-10') RETURNING id`
  const txId = await cashTx(groupId, { ...t, category: 'housing' })
  await pg`
    INSERT INTO "PendingExpenseOccurrences"
      (group_id, rule_id, period_start, proposed_amount, proposed_date, proposed_description, proposed_paid_by, proposed_split_type, resolved_tx_id)
    VALUES (${groupId}, ${rule.id}, ${t.at.slice(0, 10)}, ${t.amount}, ${t.at.slice(0, 10)}, ${t.rule}, ${t.paidBy}, 'half', ${txId})`
}

async function recurringIncome(groupId: string, i: { recipient: string; amount: number; on: string; createdAt: string; source: string }) {
  const [rule] = await pg<{ id: string }[]>`
    INSERT INTO "RecurringIncomeRules"
      (group_id, recipient_id, amount, category, source, day_of_month, starts_on, next_occurrence_at)
    VALUES (${groupId}, ${i.recipient}, ${i.amount}, 'salary', ${i.source}, 5, '2025-01-05', '2027-01-05') RETURNING id`
  const [tx] = await pg<{ id: string }[]>`
    INSERT INTO "IncomeTransactions" (group_id, recipient_id, amount, category, occurred_at, created_at)
    VALUES (${groupId}, ${i.recipient}, ${i.amount}, 'salary', ${i.on}, ${i.createdAt}::text::timestamptz) RETURNING id`
  await pg`
    INSERT INTO "PendingIncomeOccurrences" (group_id, rule_id, period_start, proposed_amount, proposed_date, resolved_tx_id)
    VALUES (${groupId}, ${rule.id}, ${i.on}, ${i.amount}, ${i.on}, ${tx.id})`
}

type Snapshot = {
  top_category: string | null
  top_category_total: number | null
  largest_expense_amount: number | null
  largest_expense_description: string | null
  largest_expense_category: string | null
  largest_expense_paid_by: string | null
  recurring_events: { name: string; amount: number; direction: string; occurredAt: string }[]
  recurring_total_income: number
  recurring_total_expense: number
  asset_breakdown: { assetName: string; total: number }[]
}

/** Fresh compute (the upsert is write-once for non-empty rows, so drop the old one first). */
async function compute(groupId: string, year: number, month: number, conn: Sql = pg): Promise<Snapshot> {
  await conn`DELETE FROM "MonthlyReviewSnapshots" WHERE group_id = ${groupId} AND year = ${year} AND month = ${month}`
  await conn`SELECT public.compute_monthly_review_snapshot(${groupId}, ${year}, ${month})`
  const [row] = await conn<Snapshot[]>`
    SELECT top_category, top_category_total,
           largest_expense_amount, largest_expense_description, largest_expense_category, largest_expense_paid_by,
           recurring_events, recurring_total_income, recurring_total_expense, asset_breakdown
      FROM "MonthlyReviewSnapshots" WHERE group_id = ${groupId} AND year = ${year} AND month = ${month}`
  return row
}

async function under0089<T>(fn: () => Promise<T>): Promise<T> {
  try {
    await pg.unsafe(FN_0089)
    return await fn()
  } finally {
    await pg.unsafe(FN_0093)
  }
}

/** The JS rule the review page uses, on bounds read back from the database. */
async function jsInside(groupId: string, year: number, month: number): Promise<boolean[]> {
  const rows = await pg<{ started_at: Date; ended_at: Date | null }[]>`
    SELECT started_at, ended_at FROM "GroupEpochs" WHERE group_id = ${groupId} ORDER BY started_at`
  return rows.map((r) => isMonthInChapter({ year, month }, { startedAt: r.started_at, endedAt: r.ended_at }))
}

// Chapter layout shared by cases 1–3:
//   A+B  2026-03-01 00:00 → 2026-06-15 10:00:00.123456 (Taipei), closed
//   A+C  2026-06-15 10:00:00.123456 → open
// August is wholly inside A+C; April is wholly inside A+B; June straddles.
const HANDOVER = tpe('2026-06-15 10:00:00.123456')
const DURING_AB = tpe('2026-05-01 09:00:00')
const DURING_AC = tpe('2026-07-01 09:00:00')

async function handoverFixture() {
  const a = await profile()
  const b = await profile()
  const c = await profile()
  const g = await group(a, c)
  await chapter(g, tpe('2026-03-01 00:00:00'), HANDOVER, a, b)
  await chapter(g, HANDOVER, null, a, c)
  return { a, b, c, g }
}

describe.skipIf(!isLocalDb)('0093 review snapshot is chapter-scoped (#1621) — local stand-in', () => {
  beforeAll(async () => {
    url = await createStandInDb(adminUrl, '0093')
    pg = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'test_1621' } })
  }, 120_000)

  afterAll(async () => {
    await pg?.end()
    if (url) await dropStandInDb(adminUrl, url)
  })

  // ─── case 1: rows created in A+B, dated into an A+C month ──────────────
  async function seedFutureDated() {
    const f = await handoverFixture()
    const car = await asset(f.g, 'TEST_1621 car')
    // Created while A+B were together, dated into August (inside A+C).
    await cashTx(f.g, { paidBy: f.b, amount: 5000, at: day('2026-08-20'), createdAt: DURING_AB, description: 'TEST_1621 B future', category: 'entertainment', assetId: car })
    await cashTx(f.g, { paidBy: f.a, amount: 4000, at: day('2026-08-21'), createdAt: DURING_AB, description: 'TEST_1621 A future', category: 'entertainment', assetId: car })
    await recurringExpense(f.g, { paidBy: f.b, amount: 2500, at: day('2026-08-10'), createdAt: DURING_AB, description: 'TEST_1621 B rent', rule: 'TEST_1621 B rent rule' })
    await recurringIncome(f.g, { recipient: f.a, amount: 7000, on: '2026-08-05', createdAt: DURING_AB, source: 'TEST_1621 A old pay' })
    // Created inside A+C.
    await cashTx(f.g, { paidBy: f.c, amount: 300, at: day('2026-08-10'), createdAt: DURING_AC, description: 'TEST_1621 C aug', assetId: car })
    await cashTx(f.g, { paidBy: f.a, amount: 200, at: day('2026-08-11'), createdAt: DURING_AC, description: 'TEST_1621 A aug' })
    await recurringExpense(f.g, { paidBy: f.c, amount: 100, at: day('2026-08-12'), createdAt: DURING_AC, description: 'TEST_1621 C rent', rule: 'TEST_1621 C rent rule' })
    await recurringIncome(f.g, { recipient: f.c, amount: 900, on: '2026-08-06', createdAt: DURING_AC, source: 'TEST_1621 C pay' })
    return f
  }

  it('control: under 0089 rows created in A+B (B\'s and A\'s) leak into an A+C month on every card', async () => {
    const f = await seedFutureDated()
    const s = await under0089(() => compute(f.g, 2026, 8))
    expect(s.top_category).toBe('entertainment')
    expect(s.largest_expense_description).toBe('TEST_1621 B future')
    expect(s.recurring_total_expense).toBe(2500 + 100)
    expect(s.recurring_total_income).toBe(7000 + 900)
    expect(s.asset_breakdown).toEqual([{ assetName: 'TEST_1621 car', total: 5000 + 4000 + 300 }])
  })

  it('case 1: an A+C month holds none of the rows created during A+B — cards 1, 2, 3, 4', async () => {
    const f = await seedFutureDated()
    expect(await jsInside(f.g, 2026, 8)).toEqual([false, true])
    const s = await compute(f.g, 2026, 8)
    // card 1: only in-chapter half rows (dining 300 + 200; housing 100).
    expect({ c: s.top_category, t: s.top_category_total }).toEqual({ c: 'dining', t: 500 })
    // card 2: C's row, not B's (amount, description, category, payer id).
    expect({
      amount: s.largest_expense_amount, description: s.largest_expense_description,
      category: s.largest_expense_category, paidBy: s.largest_expense_paid_by,
    }).toEqual({ amount: 300, description: 'TEST_1621 C aug', category: 'dining', paidBy: f.c })
    // card 3: expense and income events and totals.
    expect(s.recurring_events).toEqual([
      { name: 'TEST_1621 C pay', amount: 900, direction: 'income', occurredAt: '2026-08-06' },
      { name: 'TEST_1621 C rent rule', amount: 100, direction: 'expense', occurredAt: '2026-08-12' },
    ])
    expect({ inc: s.recurring_total_income, exp: s.recurring_total_expense }).toEqual({ inc: 900, exp: 100 })
    // card 4: totals.
    expect(s.asset_breakdown).toEqual([{ assetName: 'TEST_1621 car', total: 300 }])
    // Nothing of B's (or A's A+B-era rows) anywhere in the stored row.
    const blob = JSON.stringify(s)
    for (const leak of ['B future', 'A future', 'B rent', 'A old pay', f.b]) expect(blob).not.toContain(leak)
  })

  // ─── case 2: upper bound — created in the next chapter, backdated ──────
  it('case 2: rows created in A+C and backdated into an A+B month are excluded (closed chapter)', async () => {
    const f = await handoverFixture()
    await cashTx(f.g, { paidBy: f.a, amount: 100, at: day('2026-04-10'), createdAt: DURING_AB, description: 'TEST_1621 A apr' })
    await cashTx(f.g, { paidBy: f.c, amount: 9000, at: day('2026-04-11'), createdAt: DURING_AC, description: 'TEST_1621 C backdated', category: 'entertainment' })
    await recurringIncome(f.g, { recipient: f.c, amount: 800, on: '2026-04-05', createdAt: DURING_AC, source: 'TEST_1621 C backdated pay' })
    expect(await jsInside(f.g, 2026, 4)).toEqual([true, false])
    const control = await under0089(() => compute(f.g, 2026, 4))
    expect(control.largest_expense_description).toBe('TEST_1621 C backdated')

    const s = await compute(f.g, 2026, 4)
    expect({ c: s.top_category, t: s.top_category_total }).toEqual({ c: 'dining', t: 100 })
    expect({ d: s.largest_expense_description, p: s.largest_expense_paid_by }).toEqual({ d: 'TEST_1621 A apr', p: f.a })
    expect(s.recurring_events).toEqual([])
    expect(s.recurring_total_income).toBe(0)
  })

  // ─── case 3: microsecond edge at ended_at ──────────────────────────────
  it('case 3: created_at = ended_at − 1µs counts in the closing chapter; = ended_at does not', async () => {
    const f = await handoverFixture()
    await cashTx(f.g, { paidBy: f.a, amount: 100, at: day('2026-04-10'), createdAt: DURING_AB, description: 'TEST_1621 base' })
    // Trip-fold rows are written at boundary − 1µs (actions/invite.ts).
    await cashTx(f.g, { paidBy: f.a, amount: 20, at: day('2026-04-11'), createdAt: tpe('2026-06-15 10:00:00.123455'), description: 'TEST_1621 edge-1us' })
    await cashTx(f.g, { paidBy: f.c, amount: 4, at: day('2026-04-12'), createdAt: HANDOVER, description: 'TEST_1621 edge' })
    // Fixture sanity: the microseconds really are stored (not cut to ms on the way in).
    const stored = await pg<{ ended: string; edge: string }[]>`
      SELECT (SELECT to_char(ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
                FROM "GroupEpochs" WHERE group_id = ${f.g} AND ended_at IS NOT NULL) AS ended,
             (SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
                FROM "CashTransactions" WHERE group_id = ${f.g} AND description = 'TEST_1621 edge-1us') AS edge`
    expect(stored[0]).toEqual({ ended: '2026-06-15 02:00:00.123456', edge: '2026-06-15 02:00:00.123455' })
    const april = await compute(f.g, 2026, 4)
    expect(april.top_category_total).toBe(120)

    // The mirror: the same two instants dated into August (inside A+C).
    await cashTx(f.g, { paidBy: f.a, amount: 20, at: day('2026-08-11'), createdAt: tpe('2026-06-15 10:00:00.123455'), description: 'TEST_1621 edge-1us aug' })
    await cashTx(f.g, { paidBy: f.c, amount: 4, at: day('2026-08-12'), createdAt: HANDOVER, description: 'TEST_1621 edge aug' })
    const august = await compute(f.g, 2026, 8)
    expect({ t: august.top_category_total, d: august.largest_expense_description }).toEqual({ t: 4, d: 'TEST_1621 edge aug' })
  })

  // ─── case 4: strict lower bound of the first chapter ───────────────────
  it('case 4: a row created before the first chapter started is excluded from a month inside it', async () => {
    const a = await profile()
    const b = await profile()
    const g = await group(a, b)
    await chapter(g, tpe('2026-03-01 00:00:00'), null, a, b)
    await cashTx(g, { paidBy: a, amount: 100, at: day('2026-04-10'), createdAt: tpe('2026-03-02 09:00:00'), description: 'TEST_1621 in' })
    await cashTx(g, { paidBy: b, amount: 700, at: day('2026-04-11'), createdAt: tpe('2026-02-20 09:00:00'), description: 'TEST_1621 before first chapter' })
    const s = await compute(g, 2026, 4)
    expect({ t: s.top_category_total, d: s.largest_expense_description }).toEqual({ t: 100, d: 'TEST_1621 in' })
  })

  // ─── case 5: "inside" agrees with isMonthInChapter ─────────────────────
  async function startedAtFixture(startedAt: string) {
    const a = await profile()
    const b = await profile()
    const g = await group(a, b)
    await chapter(g, startedAt, null, a, b)
    // Created before the chapter (by a fraction of a millisecond, and by weeks), dated into March.
    await cashTx(g, { paidBy: b, amount: 700, at: day('2026-03-10'), createdAt: tpe('2026-02-20 09:00:00'), description: 'TEST_1621 weeks before' })
    await cashTx(g, { paidBy: b, amount: 50, at: day('2026-03-11'), createdAt: tpe('2026-03-01 00:00:00'), description: 'TEST_1621 at month start' })
    await cashTx(g, { paidBy: a, amount: 100, at: day('2026-03-12'), createdAt: startedAt, description: 'TEST_1621 at started_at' })
    return g
  }

  it('case 5a: started_at 0.5 ms after the Taipei month start — JS and SQL both say inside; full-precision filter', async () => {
    const g = await startedAtFixture(tpe('2026-03-01 00:00:00.0005'))
    expect(await jsInside(g, 2026, 3)).toEqual([true])
    const s = await compute(g, 2026, 3)
    // Inside → filtered: only the row created at/after started_at (full precision) counts.
    expect({ t: s.top_category_total, d: s.largest_expense_description }).toEqual({ t: 100, d: 'TEST_1621 at started_at' })
  })

  it('case 5b: started_at 1 ms after the month start — JS and SQL both say not inside; unfiltered', async () => {
    const g = await startedAtFixture(tpe('2026-03-01 00:00:00.001'))
    expect(await jsInside(g, 2026, 3)).toEqual([false])
    const s = await compute(g, 2026, 3)
    expect({ t: s.top_category_total, d: s.largest_expense_description }).toEqual({ t: 850, d: 'TEST_1621 weeks before' })
  })

  it('case 5c: a month straddling two chapters stays unfiltered', async () => {
    const f = await handoverFixture()
    await cashTx(f.g, { paidBy: f.a, amount: 100, at: day('2026-06-10'), createdAt: DURING_AB, description: 'TEST_1621 jun A+B' })
    await cashTx(f.g, { paidBy: f.c, amount: 200, at: day('2026-06-20'), createdAt: DURING_AC, description: 'TEST_1621 jun A+C' })
    await cashTx(f.g, { paidBy: f.a, amount: 40, at: day('2026-06-21'), createdAt: tpe('2026-01-01 09:00:00'), description: 'TEST_1621 jun pre' })
    expect(await jsInside(f.g, 2026, 6)).toEqual([false, false])
    const s = await compute(f.g, 2026, 6)
    expect(s.top_category_total).toBe(340)
  })

  // ─── case 6: a group without GroupEpochs rows ──────────────────────────
  it('case 6: a group with no chapters is unfiltered (legacy behaviour)', async () => {
    const a = await profile()
    const b = await profile()
    const g = await group(a, b)
    await cashTx(g, { paidBy: a, amount: 100, at: day('2026-04-10'), createdAt: tpe('2026-01-01 09:00:00'), description: 'TEST_1621 old' })
    await cashTx(g, { paidBy: b, amount: 300, at: day('2026-04-11'), createdAt: tpe('2026-09-01 09:00:00'), description: 'TEST_1621 later' })
    const s = await compute(g, 2026, 4)
    expect({ t: s.top_category_total, d: s.largest_expense_description }).toEqual({ t: 400, d: 'TEST_1621 later' })
  })

  // ─── case 7: v_is_solo follows the chapter ─────────────────────────────
  it('case 7: a duo chapter that closed on day 1 of M+1 counts only `half` rows on card 1 for M', async () => {
    const a = await profile()
    const b = await profile()
    const g = await group(a, null) // B has left: the group row is solo today
    const closed = tpe('2026-09-01 10:00:00')
    await chapter(g, tpe('2026-03-01 00:00:00'), closed, a, b)
    await chapter(g, closed, null, a, null)
    await cashTx(g, { paidBy: a, amount: 100, at: day('2026-08-10'), createdAt: tpe('2026-08-10 13:00:00'), description: 'TEST_1621 joint' })
    await cashTx(g, { paidBy: b, amount: 900, at: day('2026-08-11'), createdAt: tpe('2026-08-11 13:00:00'), description: 'TEST_1621 own', category: 'clothing', split: 'all_mine' })
    expect(await jsInside(g, 2026, 8)).toEqual([true, false])
    const control = await under0089(() => compute(g, 2026, 8))
    expect({ c: control.top_category, t: control.top_category_total }).toEqual({ c: 'clothing', t: 900 })
    const s = await compute(g, 2026, 8)
    expect({ c: s.top_category, t: s.top_category_total }).toEqual({ c: 'dining', t: 100 })
  })

  // ─── case 8: catalog ───────────────────────────────────────────────────
  it('case 8: one function, SECURITY INVOKER, pinned search_path, EXECUTE only for postgres / service_role', async () => {
    const [fn] = await pg<{ proconfig: string[] | null; prosecdef: boolean; lang: string }[]>`
      SELECT p.proconfig, p.prosecdef, l.lanname AS lang
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.oid = ${SIGNATURE}::regprocedure`
    expect(fn).toEqual({ proconfig: ['search_path=public, pg_temp'], prosecdef: false, lang: 'plpgsql' })
    const [{ n }] = await pg<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'compute_monthly_review_snapshot'`
    expect(n).toBe(1)
    const [{ acl }] = await pg<{ acl: string[] }[]>`SELECT proacl::text[] AS acl FROM pg_proc WHERE oid = ${SIGNATURE}::regprocedure`
    expect(acl.filter((e) => e.startsWith('='))).toEqual([]) // no PUBLIC
    const can = async (role: string) =>
      (await pg<{ ok: boolean }[]>`SELECT has_function_privilege(${role}, ${SIGNATURE}, 'EXECUTE') AS ok`)[0].ok
    const roles = (await pg<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'futari_app', 'service_role')`).map((r) => r.rolname)
    expect(roles).toEqual(expect.arrayContaining(['anon', 'authenticated', 'service_role']))
    for (const role of ['anon', 'authenticated', 'futari_app'].filter((r) => roles.includes(r))) {
      expect({ role, execute: await can(role) }).toEqual({ role, execute: false })
    }
    expect(await can('postgres')).toBe(true)
    expect(await can('service_role')).toBe(true)
    console.info(`[1621 ACL] futari_app checked: ${roles.includes('futari_app')}`)
  })

  // ─── case 9: cron context (no JWT) ─────────────────────────────────────
  it('case 9: without a JWT (cron, as postgres) a populated in-chapter month gets a non-empty snapshot', async () => {
    const f = await seedFutureDated()
    const cron = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'pg_cron_stand_in' } })
    try {
      const [{ claims, uid }] = await cron<{ claims: string | null; uid: string | null }[]>`
        SELECT nullif(current_setting('request.jwt.claims', true), '') AS claims, auth.uid()::text AS uid`
      expect({ claims, uid }).toEqual({ claims: null, uid: null })
      const s = await compute(f.g, 2026, 8, cron)
      expect(s.largest_expense_amount).toBe(300)
      expect(s.top_category_total).toBe(500)
      expect(s.asset_breakdown).toHaveLength(1)
    } finally {
      await cron.end()
    }
  })
})
