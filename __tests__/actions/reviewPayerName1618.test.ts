import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ReactElement } from 'react'
import { seedAuthUsers, deleteAuthUsers } from './_authUser'

// ─── #1618: card 2 of the monthly review — the real dev database ───────────
//
// Since 0089, compute_monthly_review_snapshot stores the largest expense's
// payer ID (never a name), and /review/[month] resolves the name only against
// the two people of the chapter being viewed (getEpochMembers: frozen names
// for a closed chapter, 「已離開的夥伴」 once the account is deleted).
//
//   chapter 1  A + B   2026-03-01 → 2026-06-15 (Taipei), closed
//   chapter 2  A + C   2026-06-15 → open
//   B left the group, but B's rows stay in it — including a FUTURE-DATED July
//   row, created while A+B were together, that would be the largest expense of
//   a month inside A+C's chapter. Since 0093 (#1621) the snapshot counts only
//   rows CREATED inside the month's chapter, so every row here carries an
//   explicit created_at in its own chapter, and July's stored card 2 is C's.
//   The name guard for an out-of-chapter payer is still exercised through a
//   snapshot stored the way 0089 computed it (legacyJuly): stored snapshots
//   are write-once, so such rows can exist from before 0093.
//
// Snapshots are computed by the real function (admin connection: EXECUTE is
// postgres / service_role only); the page runs for real against `db`.
// Failure this guards: nothing errors; C reads B's name on card 2 of C's own
// month, or a deleted account's real name stays on the partner's old months.
// Needs 0093 applied (.env.local → oikos-dev). Excluded from CI with the rest
// of __tests__/actions/**.
// ────────────────────────────────────────────────────────────────────────────

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnvLocal()
// Each test seeds over the network (incl. an auth.users row); the default 5 s is
// too tight against dev, and a timed-out test races its own afterEach (#1710).
vi.setConfig({ testTimeout: 60_000 })

let mockUserId = ''
let pinnedEpoch: string | null = null
vi.mock('@/lib/supabase/server', () => ({ getCurrentUser: async () => ({ id: mockUserId }) }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (k: string) => (k === 'futari_past_epoch' && pinnedEpoch ? { name: k, value: pinnedEpoch } : undefined),
    getAll: () => [], has: () => false, set: () => {}, delete: () => {},
  }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))

const { db } = await import('@/lib/db/client')
const {
  profiles, oikosGroups, groupBalance, groupEpochs, cashTransactions, monthlyReviewSnapshots,
} = await import('@/lib/db/schema')
const { loadMonthlyReviewSnapshot } = await import('@/lib/db/queries/monthlyReview')
const { inArray, eq } = await import('drizzle-orm')
const { default: MonthlyReviewPage } = await import('@/app/(dashboard)/review/[month]/page')

const adminUrl = process.env.DATABASE_URL_DIRECT
if (!adminUrl) throw new Error('DATABASE_URL_DIRECT not set; this test needs the admin connection.')
const postgres = (await import('postgres')).default
const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} })

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set; cannot run integration test.')
  const [{ ok }] = await admin<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'MonthlyReviewSnapshots' AND column_name = 'largest_expense_paid_by') AS ok`
  if (!ok) throw new Error('0089 is not applied on this database (largest_expense_paid_by missing).')
  const [{ scoped }] = await admin<{ scoped: boolean }[]>`
    SELECT position('"GroupEpochs"' in prosrc) > 0 AS scoped
      FROM pg_proc WHERE oid = 'public.compute_monthly_review_snapshot(uuid, integer, integer)'::regprocedure`
  if (!scoped) throw new Error('0093 is not applied on this database (snapshot not chapter-scoped).')
})
afterAll(async () => { await admin.end() })

const TPE = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d) - 8 * 60 * 60 * 1000)
const NOON = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12))
const people: string[] = []
const groups: string[] = []

afterEach(async () => {
  if (groups.length) {
    await db.delete(cashTransactions).where(inArray(cashTransactions.groupId, groups))
    await db.delete(monthlyReviewSnapshots).where(inArray(monthlyReviewSnapshots.groupId, groups))
    await db.delete(groupEpochs).where(inArray(groupEpochs.groupId, groups))
    await db.delete(groupBalance).where(inArray(groupBalance.groupId, groups))
    await db.delete(oikosGroups).where(inArray(oikosGroups.id, groups))
  }
  await deleteAuthUsers(people)
  if (people.length) await db.delete(profiles).where(inArray(profiles.id, people))
  people.length = 0
  groups.length = 0
  pinnedEpoch = null
})

async function person(name: string): Promise<string> {
  const id = randomUUID()
  await db.insert(profiles).values({ id, displayName: name })
  await seedAuthUsers([{ id, displayName: name }])
  people.push(id)
  return id
}

const rename = (id: string, displayName: string) =>
  db.update(profiles).set({ displayName }).where(eq(profiles.id, id))

async function seed() {
  const a = await person('TEST_1618 A then')
  const b = await person('TEST_1618 B then')
  const c = await person('TEST_1618 C')
  const handover = TPE(2026, 6, 15)
  // The group as it is after B left and C joined.
  const [g] = await db.insert(oikosGroups).values({
    name: 'TEST_1618', memberA: a, memberB: c, currentEpochStartedAt: handover, baseCurrency: 'twd',
  }).returning({ id: oikosGroups.id })
  groups.push(g.id)
  await db.insert(groupBalance).values({ groupId: g.id, balance: 0 })
  // Inserted closed: 0088's trigger freezes A's and B's names as of now.
  const [e1] = await db.insert(groupEpochs).values({
    groupId: g.id, startedAt: TPE(2026, 3, 1), endedAt: handover, memberAId: a, memberBId: b,
  }).returning({ id: groupEpochs.id })
  await db.insert(groupEpochs).values({ groupId: g.id, startedAt: handover, memberAId: a, memberBId: c })

  // createdAt decides the chapter (#1621); set it explicitly per chapter.
  const tx = (paidBy: string, amount: number, at: Date, createdAt: Date, description: string) => ({
    groupId: g.id, paidBy, amount, splitType: 'half' as const, description, category: 'dining',
    transactedAt: at, createdAt,
  })
  const DURING_AB = TPE(2026, 6, 1)
  const DURING_AC = TPE(2026, 6, 20)
  await db.insert(cashTransactions).values([
    tx(b, 900, NOON(2026, 4, 10), DURING_AB, 'TEST_1618 apr B'),
    tx(a, 100, NOON(2026, 4, 11), DURING_AB, 'TEST_1618 apr A'),
    tx(a, 800, NOON(2026, 5, 10), DURING_AB, 'TEST_1618 may A'),
    // B's future-dated row, created during A+B and dated into A+C's July.
    tx(b, 5000, NOON(2026, 7, 20), DURING_AB, 'TEST_1618 jul B'),
    tx(c, 300, NOON(2026, 7, 10), DURING_AC, 'TEST_1618 jul C'),
    tx(c, 700, NOON(2026, 8, 10), DURING_AC, 'TEST_1618 aug C'),
  ])
  for (const month of [4, 5, 7, 8]) {
    await admin`SELECT public.compute_monthly_review_snapshot(${g.id}, 2026, ${month})`
  }
  // Everyone renames after chapter 1 closed.
  await rename(a, 'TEST_1618 A later')
  await rename(b, 'TEST_1618 B later')
  return { a, b, c, groupId: g.id, e1: e1.id }
}

/**
 * July's snapshot as 0089 stored it (before #1621): B's future-dated row as
 * card 2, with B's payer id. Snapshots are write-once, so rows like this can
 * outlive 0093; the page must still never show B's name or id for them.
 */
async function legacyJuly(groupId: string, b: string) {
  await admin`
    UPDATE "MonthlyReviewSnapshots"
       SET largest_expense_amount = 5000, largest_expense_description = 'TEST_1618 jul B',
           largest_expense_category = 'dining', largest_expense_paid_by = ${b}
     WHERE group_id = ${groupId} AND year = 2026 AND month = 7`
}

type Props = {
  snapshot: Record<string, unknown> | null
  payerName: string | null
  viewer: { id: string; displayName: string }
} & Record<string, unknown>

async function open(viewer: string, month: string, pin: string | null = null): Promise<Props> {
  mockUserId = viewer
  pinnedEpoch = pin
  const el = (await MonthlyReviewPage({ params: Promise.resolve({ month }) })) as ReactElement<Props>
  return el.props
}

/** React's production Flight encoder, as in tests/action-result-wire.test.ts. */
function encodeProduction(value: unknown): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      ['--conditions=react-server', join(process.cwd(), 'tests/_helpers/rsc-production-wire.mjs')],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', fail)
    child.on('close', (code) => {
      if (code !== 0) return fail(new Error(`encoder exited ${code}: ${err}`))
      try { done((JSON.parse(out) as string[])[0]) } catch (e) { fail(e) }
    })
    child.stdin.end(JSON.stringify([{ kind: 'value', value }]))
  })
}

describe('card 2 payer on /review/[month] (#1618) — dev DB', () => {
  it('the snapshot stores the payer id and no name', async () => {
    const s = await seed()
    const [row] = await admin<{ paid_by: string | null; has_name: boolean }[]>`
      SELECT largest_expense_paid_by AS paid_by, largest_expense_paid_by_name IS NOT NULL AS has_name
        FROM "MonthlyReviewSnapshots" WHERE group_id = ${s.groupId} AND year = 2026 AND month = 4`
    expect(row).toEqual({ paid_by: s.b, has_name: false })
  })

  it("closed chapter: A sees B under B's frozen chapter name, not B's later rename", async () => {
    const s = await seed()
    const p = await open(s.a, '2026-04', s.e1)
    expect(p.payerName).toBe('TEST_1618 B then')
  })

  it("the viewer as payer: A sees A's chapter name, not the live profile name", async () => {
    const s = await seed()
    const p = await open(s.a, '2026-05', s.e1)
    expect(p.payerName).toBe('TEST_1618 A then')
    expect(p.viewer.displayName).toBe('TEST_1618 A later') // the live one exists; the card does not use it
  })

  it('open chapter: C as payer is shown with the live chapter name', async () => {
    const s = await seed()
    const p = await open(s.c, '2026-08')
    expect(p.payerName).toBe('TEST_1618 C')
  })

  it("cross-chapter (#1621): B's future-dated row is not in July at all — not its amount, description or payer", async () => {
    const s = await seed()
    const stored = await loadMonthlyReviewSnapshot(s.groupId, 2026, 7)
    expect({
      amount: stored?.largestExpenseAmount, description: stored?.largestExpenseDescription, payer: stored?.largestExpensePaidBy,
    }).toEqual({ amount: 300, description: 'TEST_1618 jul C', payer: s.c })
    const p = await open(s.c, '2026-07')
    expect(p.snapshot?.largestExpenseAmount).toBe(300)
    expect(p.snapshot?.largestExpenseDescription).toBe('TEST_1618 jul C')
    expect(p.payerName).toBe('TEST_1618 C')
    const props = JSON.stringify(p)
    expect(props).not.toContain('TEST_1618 jul B')
    expect(Object.values(p.snapshot!)).not.toContain(5000)
  })

  it("cross-chapter, stored before 0093: B's row is July's largest; C sees no name", async () => {
    const s = await seed()
    await legacyJuly(s.groupId, s.b)
    // Control: the stored payer really is B.
    expect((await loadMonthlyReviewSnapshot(s.groupId, 2026, 7))?.largestExpensePaidBy).toBe(s.b)
    const p = await open(s.c, '2026-07')
    expect(p.snapshot?.largestExpenseAmount).toBe(5000)
    expect(p.payerName).toBeNull() // → CardLargest: card2BodyNoName, no chip
  })

  it("payload (a): B's uuid is nowhere in the serialized props on the cross-chapter fixture", async () => {
    const s = await seed()
    await legacyJuly(s.groupId, s.b) // the stored row holds B's id
    const p = await open(s.c, '2026-07')
    const payload = await encodeProduction(JSON.parse(JSON.stringify(p)))
    expect(payload).toContain(s.c) // control: ids do appear (the viewer's own)
    expect(payload).not.toContain(s.b)
    expect(payload).not.toContain('TEST_1618 B')
  })

  it('payload (b): the snapshot prop carries no payer id key', async () => {
    const s = await seed()
    await legacyJuly(s.groupId, s.b) // July holds an out-of-chapter id
    for (const [viewer, month, pin] of [[s.c, '2026-07', null], [s.a, '2026-04', s.e1], [s.c, '2026-08', null]] as const) {
      const p = await open(viewer, month, pin)
      expect(p.snapshot).not.toBeNull()
      const keys = Object.keys(p.snapshot!)
      expect(keys).not.toContain('largestExpensePaidBy')
      expect(keys.filter((k) => /paidBy|payerId/i.test(k))).toEqual([])
      for (const id of [s.a, s.b, s.c]) expect(Object.values(p.snapshot!)).not.toContain(id)
    }
  })

  it('cron context (#1621): service_role without a JWT computes the chapter-scoped snapshot', async () => {
    const s = await seed()
    // In a transaction that is rolled back: nothing this computes stays.
    const seen = await admin.begin(async (tx) => {
      await tx`SET LOCAL ROLE service_role`
      const [ctx] = await tx<{ role: string; claims: string | null }[]>`
        SELECT current_user::text AS role, nullif(current_setting('request.jwt.claims', true), '') AS claims`
      await tx`DELETE FROM "MonthlyReviewSnapshots" WHERE group_id = ${s.groupId} AND year = 2026 AND month = 7`
      await tx`SELECT public.compute_monthly_review_snapshot(${s.groupId}, 2026, 7)`
      const [row] = await tx<{ amount: number | null; total: number | null }[]>`
        SELECT largest_expense_amount AS amount, top_category_total AS total
          FROM "MonthlyReviewSnapshots" WHERE group_id = ${s.groupId} AND year = 2026 AND month = 7`
      throw Object.assign(new Error('rollback'), { seen: { ...ctx, ...row } })
    }).catch((e: { seen?: unknown }) => { if (!e.seen) throw e; return e.seen })
    // July inside A+C: C's 300 only (B's A+B-era 5000 is not counted).
    expect(seen).toEqual({ role: 'service_role', claims: null, amount: 300, total: 300 })
  })

  it("after B's account is deleted (process_account_deletions), A's old month shows 「已離開的夥伴」", async () => {
    const s = await seed()
    // process_account_deletions handles EVERY due request; refuse to run it if
    // anything but this fixture is due, so the test never deletes a real dev account.
    await admin`UPDATE "Profiles" SET deletion_requested_at = now() - interval '15 days' WHERE id = ${s.b}`
    const [{ due }] = await admin<{ due: number }[]>`
      SELECT count(*)::int AS due FROM "Profiles" p
       WHERE p.deletion_requested_at < now() - interval '14 days'
         AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
         AND p.id <> ${s.b}`
    expect(due).toBe(0)
    await admin`SELECT public.process_account_deletions()`
    const [{ gone }] = await admin<{ gone: boolean }[]>`
      SELECT NOT EXISTS (SELECT 1 FROM auth.users WHERE id = ${s.b}) AS gone`
    expect(gone).toBe(true)

    const p = await open(s.a, '2026-04', s.e1)
    expect(p.payerName).toBe('已離開的夥伴')
    const payload = await encodeProduction(JSON.parse(JSON.stringify(p)))
    expect(payload).not.toContain('TEST_1618 B')
  })
})
