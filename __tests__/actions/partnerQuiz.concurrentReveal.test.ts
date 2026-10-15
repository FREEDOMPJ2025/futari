import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { loadEnvLocal } from '../outing/_setup'
import { seedAuthUsers, deleteAuthUsers } from './_authUser'

// ─── #1683 — both members submit the quiz at the same moment ──────────────
//
// submitPartnerQuizAnswers reads the session FOR UPDATE inside its one
// transaction, so two members submitting at once are serialized on that row:
// the second sees the first's answers and is the one that stamps revealed_at.
// Before #1683 the session was read without a lock and each transaction
// counted only its own (plus already-committed) answers: when both ran at
// once, neither saw the other's, neither revealed, and the quiz stuck on
// "waiting" for good with all 2N answers stored.
//
// The interleaving is forced, not hoped for: a holder connection takes the
// session row FOR UPDATE, both submits start and are confirmed waiting on it
// (pg_stat_activity / pg_blocking_pids / pg_locks via ./_lockHarness), then
// the holder commits and both proceed. On the pre-#1683 code both submits
// also wait here (their answer INSERT's FK check needs KEY SHARE on the
// session row) and then run side by side — the failure this test shows.
//
// Local throwaway database only (it holds row locks across connections and
// refuses anything that is not localhost). Needs 0095 applied (epoch_id):
//   DATABASE_URL=postgres://postgres:<pw>@localhost:<port>/<db> \
//     npx vitest run __tests__/actions/partnerQuiz.concurrentReveal.test.ts
// ──────────────────────────────────────────────────────────────────────────

loadEnvLocal()

const { AsyncLocalStorage } = await import('node:async_hooks')
const viewerStore = new AsyncLocalStorage<string>()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: viewerStore.getStore() ?? '' } }, error: null }),
    },
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock('@/lib/analytics/server', () => ({
  captureServer: async () => {},
  isUserFirstNonDeletedRecord: async () => false,
}))

const { db } = await import('@/lib/db/client')
const {
  profiles, oikosGroups, groupBalance, groupEpochs, partnerQuizSessions, partnerQuizAnswers,
} = await import('@/lib/db/schema')
const { submitPartnerQuizAnswers } = await import('@/actions/partnerQuiz')
const { eq, inArray } = await import('drizzle-orm')
const postgres = (await import('postgres')).default
type Sql = ReturnType<typeof postgres>
const { openTx, waitBlockedBy, waitLockWaiters, describeSettled } = await import('./_lockHarness')

const as = <T>(userId: string, fn: () => Promise<T>) => viewerStore.run(userId, fn)

const databaseUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

let holderConn: Sql
let monitor: Sql

beforeAll(() => {
  if (!isLocalDb) return
  holderConn = postgres(databaseUrl, { max: 1, prepare: false })
  monitor = postgres(databaseUrl, { max: 1, prepare: false })
})

afterAll(async () => {
  await holderConn?.end()
  await monitor?.end()
})

const created = { profiles: [] as string[], groups: [] as string[] }

afterEach(async () => {
  if (!isLocalDb) return
  if (created.groups.length) {
    const sessions = await db
      .select({ id: partnerQuizSessions.id })
      .from(partnerQuizSessions)
      .where(inArray(partnerQuizSessions.groupId, created.groups))
    if (sessions.length) {
      await db.delete(partnerQuizAnswers).where(inArray(partnerQuizAnswers.sessionId, sessions.map((s) => s.id)))
      await db.delete(partnerQuizSessions).where(inArray(partnerQuizSessions.groupId, created.groups))
    }
    await db.delete(groupEpochs).where(inArray(groupEpochs.groupId, created.groups))
    await db.delete(groupBalance).where(inArray(groupBalance.groupId, created.groups))
    await db.delete(oikosGroups).where(inArray(oikosGroups.id, created.groups))
  }
  if (created.profiles.length) {
    await deleteAuthUsers(created.profiles)
    await db.delete(profiles).where(inArray(profiles.id, created.profiles))
  }
  created.profiles = []
  created.groups = []
})

async function person(label: string): Promise<string> {
  const id = randomUUID()
  await db.insert(profiles).values({ id, displayName: `TEST_1683_${label}` })
  await seedAuthUsers([{ id, displayName: `TEST_1683_${label}` }])
  created.profiles.push(id)
  return id
}

/** A duo ledger with one open chapter and that chapter's quiz session. */
async function duoWithSession(a: string, b: string) {
  const startedAt = new Date(Date.now() - 48 * 60 * 60 * 1000)
  const [g] = await db.insert(oikosGroups)
    .values({ name: 'TEST_1683_group', memberA: a, memberB: b, currentEpochStartedAt: startedAt })
    .returning({ id: oikosGroups.id })
  created.groups.push(g.id)
  await db.insert(groupBalance).values({ groupId: g.id, balance: 0, version: 0 })
  const [e] = await db.insert(groupEpochs)
    .values({ groupId: g.id, startedAt, memberAId: a, memberBId: b })
    .returning({ id: groupEpochs.id })
  const [s] = await db.insert(partnerQuizSessions)
    .values({ groupId: g.id, epochId: e.id, questionKeys: QUESTION_KEYS })
    .returning({ id: partnerQuizSessions.id })
  return { groupId: g.id, epochId: e.id, sessionId: s.id }
}

const QUESTION_KEYS = ['impulse', 'risk', 'transparency']
const answersFor = (choice: 'a' | 'b') => QUESTION_KEYS.map((questionKey) => ({ questionKey, choiceKey: choice }))

// The harness waits up to 10s for a lock-wait before failing with a dump.
const T = 30_000

describe.skipIf(!isLocalDb)('partner quiz: two members submit at once (#1683)', () => {
  it('serializes on the session row: 2N answers stored, revealed_at stamped exactly once', { timeout: T }, async () => {
    const a = await person('a')
    const b = await person('b')
    const { sessionId } = await duoWithSession(a, b)

    // 1. Something holds the session row, so both submits queue on it.
    const holder = await openTx(holderConn)
    await holder.run((t) => t`SELECT id FROM "PartnerQuizSessions" WHERE id = ${sessionId} FOR UPDATE`)

    // 2. Both members submit; both are confirmed waiting on the holder.
    const subA = as(a, () => submitPartnerQuizAnswers({ sessionId, answers: answersFor('a') }))
    const subB = as(b, () => submitPartnerQuizAnswers({ sessionId, answers: answersFor('b') }))
    subA.catch(() => {})
    subB.catch(() => {})
    // The first waits on the holder; the second queues behind the first on
    // the same row (tuple lock), so it is not "blocked by" the holder itself.
    await waitBlockedBy(monitor, holder.pid, 1)
    await waitLockWaiters(monitor, 2)

    // 3. Release; they run.
    await holder.commit()
    const settled = await Promise.allSettled([subA, subB])
    const results = settled.map(describeSettled)

    expect(results).toEqual(expect.arrayContaining([
      { ok: true, data: { revealed: true } },
      { ok: true, data: { revealed: false } },
    ]))

    const [row] = await db
      .select({ revealedAt: partnerQuizSessions.revealedAt })
      .from(partnerQuizSessions)
      .where(eq(partnerQuizSessions.id, sessionId))
    expect(row.revealedAt).not.toBeNull()

    const stored = await db
      .select({ memberId: partnerQuizAnswers.memberId })
      .from(partnerQuizAnswers)
      .where(eq(partnerQuizAnswers.sessionId, sessionId))
    expect(stored).toHaveLength(2 * QUESTION_KEYS.length)
    expect(stored.filter((r) => r.memberId === a)).toHaveLength(QUESTION_KEYS.length)
    expect(stored.filter((r) => r.memberId === b)).toHaveLength(QUESTION_KEYS.length)
  })

  it('a re-submit racing the first submit by the same member is refused (already_answered), never doubled', { timeout: T }, async () => {
    const a = await person('a')
    const b = await person('b')
    const { sessionId } = await duoWithSession(a, b)

    const holder = await openTx(holderConn)
    await holder.run((t) => t`SELECT id FROM "PartnerQuizSessions" WHERE id = ${sessionId} FOR UPDATE`)
    const first = as(a, () => submitPartnerQuizAnswers({ sessionId, answers: answersFor('a') }))
    const second = as(a, () => submitPartnerQuizAnswers({ sessionId, answers: answersFor('b') }))
    first.catch(() => {})
    second.catch(() => {})
    // The first waits on the holder; the second queues behind the first on
    // the same row (tuple lock), so it is not "blocked by" the holder itself.
    await waitBlockedBy(monitor, holder.pid, 1)
    await waitLockWaiters(monitor, 2)
    await holder.commit()

    const results = (await Promise.allSettled([first, second])).map(describeSettled)
    expect(results).toEqual(expect.arrayContaining([
      { ok: true, data: { revealed: false } },
      { ok: false, code: 'already_answered' },
    ]))
    const stored = await db
      .select({ memberId: partnerQuizAnswers.memberId })
      .from(partnerQuizAnswers)
      .where(eq(partnerQuizAnswers.sessionId, sessionId))
    expect(stored).toHaveLength(QUESTION_KEYS.length)
  })
})
