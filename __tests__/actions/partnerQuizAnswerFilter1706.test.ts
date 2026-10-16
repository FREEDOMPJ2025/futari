import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { loadEnvLocal } from '../outing/_setup'
import { seedAuthUsers, deleteAuthUsers } from './_authUser'

// ─── #1706 (from #1696, mutation M3) — the answers loader's member filter ──
//
// A quiz session belongs to ONE chapter and only that chapter's two people can
// write to it (submitPartnerQuizAnswers checks the viewer against the chapter
// row, under locks). So in every state the writers can reach, the session's
// answers are already the two members' own — and `inArray(member_id, [A, B])`
// in loadPartnerQuizAnswers is a second fence nothing exercised: delete it and
// every reachable state still passes.
//
// Here a third person's rows are put into the session directly (the only way
// they can get there), so the filter is the only thing keeping them off the
// /review and /review/[month]/quiz pages.
//
// Failure looks like: nothing errors. A stranger's answers show up as one of
// the pair's, or the reveal screen counts rows nobody in the chapter wrote.
//
// Dev database (DATABASE_URL), no lock tricks: it runs wherever the other
// __tests__/actions suites run.
// ──────────────────────────────────────────────────────────────────────────

loadEnvLocal()
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const { db } = await import('@/lib/db/client')
const {
  profiles, oikosGroups, groupBalance, groupEpochs, partnerQuizSessions, partnerQuizAnswers,
} = await import('@/lib/db/schema')
const { loadPartnerQuizAnswers } = await import('@/lib/db/queries/partnerQuiz')
const { eq, inArray } = await import('drizzle-orm')

const A = randomUUID()
const B = randomUUID()
const X = randomUUID() // in no chapter of this ledger
const KEYS = ['impulse', 'risk', 'transparency']

let groupId = ''
let sessionId = ''

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set; cannot run integration test. Ensure .env.local has DATABASE_URL.')
  }
  await db.insert(profiles).values([
    { id: A, displayName: 'TEST_1706_A' },
    { id: B, displayName: 'TEST_1706_B' },
    { id: X, displayName: 'TEST_1706_X' },
  ])
  await seedAuthUsers([
    { id: A, displayName: 'TEST_1706_A' },
    { id: B, displayName: 'TEST_1706_B' },
  ])
  const startedAt = new Date(Date.now() - 48 * 60 * 60 * 1000)
  const [g] = await db.insert(oikosGroups)
    .values({ name: 'TEST_1706_quiz', memberA: A, memberB: B, currentEpochStartedAt: startedAt })
    .returning({ id: oikosGroups.id })
  groupId = g.id
  await db.insert(groupBalance).values({ groupId, balance: 0, version: 0 })
  const [e] = await db.insert(groupEpochs)
    .values({ groupId, startedAt, memberAId: A, memberBId: B })
    .returning({ id: groupEpochs.id })
  const [s] = await db.insert(partnerQuizSessions)
    .values({ groupId, epochId: e.id, questionKeys: KEYS })
    .returning({ id: partnerQuizSessions.id })
  sessionId = s.id
  const rows = (memberId: string) => KEYS.map((questionKey) => ({ sessionId, memberId, questionKey, choiceKey: 'a' }))
  await db.insert(partnerQuizAnswers).values([...rows(A), ...rows(B), ...rows(X)])
})

afterAll(async () => {
  try {
    if (sessionId) await db.delete(partnerQuizAnswers).where(eq(partnerQuizAnswers.sessionId, sessionId))
    if (groupId) {
      await db.delete(partnerQuizSessions).where(eq(partnerQuizSessions.groupId, groupId))
      await db.delete(groupEpochs).where(eq(groupEpochs.groupId, groupId))
      await db.delete(groupBalance).where(eq(groupBalance.groupId, groupId))
      await db.delete(oikosGroups).where(eq(oikosGroups.id, groupId))
    }
    await deleteAuthUsers([A, B])
    await db.delete(profiles).where(inArray(profiles.id, [A, B, X]))
  } catch (e) {
    console.error('cleanup failed', e)
  }
})

describe('loadPartnerQuizAnswers member filter (#1696, #1706)', () => {
  it("returns only the chapter's two people's answers, never a third person's row in the same session", async () => {
    const rows = await loadPartnerQuizAnswers(sessionId, [A, B])
    expect(rows).toHaveLength(2 * KEYS.length)
    expect(new Set(rows.map((r) => r.memberId))).toEqual(new Set([A, B]))
  })

  it('a single-member list returns just that member', async () => {
    const rows = await loadPartnerQuizAnswers(sessionId, [A])
    expect(rows).toHaveLength(KEYS.length)
    expect(rows.every((r) => r.memberId === A)).toBe(true)
  })

  it('no member ids → no rows', async () => {
    expect(await loadPartnerQuizAnswers(sessionId, [])).toEqual([])
  })
})
