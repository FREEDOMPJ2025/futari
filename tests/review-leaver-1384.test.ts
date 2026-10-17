// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactElement } from 'react'

// #1384 — a partner who left can open their own old chapter's reviews
// (read-only), with that chapter's two people; access does not widen.
//
//   chapter 1  A + B   2026-03-01 → 2026-06-15 (Taipei), epoch e1 — B left
//   chapter 2  A + C   2026-06-15 → open,                epoch e2
//   group row today: member_a A, member_b C
//
// #1612 — the resolver hands B this context again (a closed chapter of a
// ledger they left: the former-member look-back, tests/queries-epoch.test.ts
// › former members). The resolver is mocked here, so these cases test the
// page's own chapter-membership logic.

const TPE = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d) - 8 * 60 * 60 * 1000)
const CH1 = { startedAt: TPE(2026, 3, 1), endedAt: TPE(2026, 6, 15), epochId: 'e1', isPast: true }
const CH2 = { startedAt: TPE(2026, 6, 15), endedAt: null, epochId: 'e2', isPast: false }
const GROUP = { id: 'g1', memberA: 'user-a', memberB: 'user-c' }
// #1604 part 2 — what getEpochMembers returns: for the closed chapter e1, the
// names frozen when it closed ('A at close' / 'B at close'); for the open e2,
// the live names. The live profiles below carry later names and photos.
const EPOCH_MEMBERS: Record<string, {
  memberAId: string; memberBId: string | null
  memberAName: { name: string | null; isLeftLabel: boolean }; memberBName: { name: string | null; isLeftLabel: boolean }
}> = {
  e1: { memberAId: 'user-a', memberBId: 'user-b', memberAName: { name: 'A at close', isLeftLabel: false }, memberBName: { name: 'B at close', isLeftLabel: false } },
  e2: { memberAId: 'user-a', memberBId: 'user-c', memberAName: { name: 'A', isLeftLabel: false }, memberBName: { name: 'C', isLeftLabel: false } },
}
const PROFILES = [
  { id: 'user-a', displayName: 'A', avatarUrl: 'https://img.example/a-now.jpg' },
  { id: 'user-b', displayName: 'B renamed later', avatarUrl: 'https://img.example/b-now.jpg' },
  { id: 'user-c', displayName: 'C', avatarUrl: 'https://img.example/c-now.jpg' },
  { id: 'user-x', displayName: 'X', avatarUrl: null },
]

let viewer = 'user-b'
let window: typeof CH1 | typeof CH2 = CH1
let requestedIds: string[] = []
// #1683 — sessions are per chapter: e1 holds A+B's (revealed) quiz, e2 has none
// yet. The page must look the session up by the viewed chapter's epoch id.
const SESSIONS: Record<string, { id: string; questionKeys: string[]; revealedAt: Date | null }> = {
  e1: { id: 'q-ab', questionKeys: ['impulse'], revealedAt: new Date('2026-05-01T00:00:00Z') },
}
const quizLoader = vi.fn(async (epochId: string) => SESSIONS[epochId] ?? null)

vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))
vi.mock('@/lib/supabase/server', () => ({ getCurrentUser: async () => ({ id: viewer }) }))
// #1612 — a closed chapter's neutral label comes from the dictionary.
vi.mock('@/lib/i18n/t', async () => ({
  getTranslations: async () => (await import('@/lib/i18n/locales/zh-TW')).zhTW,
}))
vi.mock('@/lib/db/queries/epoch', () => ({
  getEpochMembers: async (id: string) => EPOCH_MEMBERS[id] ?? null,
  resolveViewerEpochContext: async () => ({ group: GROUP, window }),
}))
// Profiles query: capture the requested ids and return only those rows.
vi.mock('drizzle-orm', async (orig) => ({
  ...(await orig<typeof import('drizzle-orm')>()),
  inArray: (_col: unknown, ids: string[]) => { requestedIds = ids; return ids },
}))
vi.mock('@/lib/db/client', () => ({
  db: { select: () => ({ from: () => ({ where: async () => PROFILES.filter((p) => requestedIds.includes(p.id)) }) }) },
}))
vi.mock('@/lib/db/queries/monthlyReview', () => ({
  loadMonthlyReviewSnapshot: async () => ({ computedAt: new Date() }),
  // Group-scoped rows: B's and A's from chapter 1, plus a C row that must not
  // show in chapter 1. The member filter lives in the loader now (#1685; its
  // SQL is exercised against Postgres in
  // __tests__/review-messages-chapter-1684-1685.test.ts); this stand-in applies
  // the same rule to the memberIds the page passes, so the assertions below
  // check that the page names the viewed chapter's two people.
  loadChapterReviewMessages: async (_g: string, _ym: unknown, scope: { memberIds: string[] }) => [
    { id: 'm-a', memberId: 'user-a', body: 'from A', lockedAt: new Date() },
    { id: 'm-b', memberId: 'user-b', body: 'from B', lockedAt: new Date() },
    { id: 'm-c', memberId: 'user-c', body: 'from C', lockedAt: new Date() },
  ].filter((m) => scope.memberIds.includes(m.memberId)),
}))
vi.mock('@/lib/db/queries/partnerQuiz', () => ({
  loadPartnerQuizSessionByEpoch: quizLoader,
  loadPartnerQuizAnswers: async () => [],
}))
vi.mock('@/lib/monthlyReview', async (orig) => ({
  ...(await orig<typeof import('@/lib/monthlyReview')>()),
  currentYearMonthInTaipei: () => ({ year: 2026, month: 9 }),
}))

const { default: MonthlyReviewPage } = await import('@/app/(dashboard)/review/[month]/page')

type Props = {
  viewer: { id: string }
  partner: { id: string; displayName: string; avatarUrl: string | null } | null
  isSolo: boolean
  readOnly: boolean
  quiz: unknown
  pastMessages: { memberId: string }[]
  ownEditorMessage: unknown
  partnerEditorMessage: unknown
}
async function open(month: string): Promise<Props> {
  const el = (await MonthlyReviewPage({ params: Promise.resolve({ month }) })) as ReactElement<Props>
  return el.props
}

beforeEach(() => { quizLoader.mockClear() })

describe('B (left) viewing chapter 1 through the past-times pin', () => {
  beforeEach(() => { viewer = 'user-b'; window = CH1 })

  it('opens an A+B month instead of bouncing to /sign-in', async () => {
    const p = await open('2026-04')
    expect(p.viewer.id).toBe('user-b')
    expect(p.partner?.id).toBe('user-a')
    expect(p.isSolo).toBe(false)
  })

  it('sees both A and B messages from that chapter, and nothing C wrote', async () => {
    const p = await open('2026-04')
    expect(p.pastMessages.map((m) => m.memberId).sort()).toEqual(['user-a', 'user-b'])
  })

  it('is read-only: no editor, and no quiz from the group\'s current (A+C) session', async () => {
    const p = await open('2026-04')
    expect(p.readOnly).toBe(true)
    expect(p.quiz).toBeNull()
    expect(quizLoader).not.toHaveBeenCalled()
  })

  // #1612 — read-only reads only the viewer's own profile (A's live name and
  // photo are never loaded) and no next-month (editor) messages.
  it("reads only B's own profile and serializes no editor-month message", async () => {
    const p = await open('2026-04')
    expect(requestedIds).toEqual(['user-b'])
    expect(p.ownEditorMessage).toBeNull()
    expect(p.partnerEditorMessage).toBeNull()
    expect(p.partner).toEqual({ id: 'user-a', displayName: 'A at close', avatarUrl: null })
    expect(JSON.stringify(p)).not.toContain('a-now.jpg')
  })

  it('the chapter guard still applies: a chapter-2 month is 404', async () => {
    await expect(open('2026-07')).rejects.toThrow('NEXT_NOT_FOUND')
  })
})

describe('A (stayed) viewing chapter 1', () => {
  it('sees B — not C, the next partner — as the other half of that chapter', async () => {
    viewer = 'user-a'; window = CH1
    const p = await open('2026-04')
    expect(p.partner?.id).toBe('user-b')
  })

  // #1604 part 2 — the closed chapter shows B as B was when it closed: the
  // snapshot name from getEpochMembers, never B's later name, and no photo.
  it("shows B under the name frozen at the chapter's close, with no avatar", async () => {
    viewer = 'user-a'; window = CH1
    const p = await open('2026-04')
    expect(p.partner).toEqual({ id: 'user-b', displayName: 'B at close', avatarUrl: null })
  })
})

describe('the open chapter keeps the live profile (#1604 part 2)', () => {
  it("C on a chapter-2 month sees A's live name and photo", async () => {
    viewer = 'user-c'; window = CH2
    const p = await open('2026-07')
    expect(p.partner).toEqual({ id: 'user-a', displayName: 'A', avatarUrl: 'https://img.example/a-now.jpg' })
  })
})

describe('access does not widen', () => {
  it('C (current chapter) still 404s on A+B months', async () => {
    viewer = 'user-c'; window = CH2
    await expect(open('2026-04')).rejects.toThrow('NEXT_NOT_FOUND')
  })

  // #1683 — flipped. This used to assert the "live quiz" was loaded by group,
  // which handed C the A+B session (B's answers once revealed). C must get
  // chapter 2's own quiz, never chapter 1's.
  it('C on a chapter-2 month: partner A, editable, and only chapter 2\'s quiz — never the A+B session', async () => {
    viewer = 'user-c'; window = CH2
    const p = await open('2026-07')
    expect(p.partner?.id).toBe('user-a')
    expect(p.readOnly).toBe(false)
    expect(quizLoader).toHaveBeenCalledOnce()
    expect(quizLoader).toHaveBeenCalledWith('e2')
    expect(quizLoader).not.toHaveBeenCalledWith('e1')
    // No chapter-2 session yet → the invitation, not A+B's revealed quiz.
    expect(p.quiz).toMatchObject({ status: 'invited', revealPreview: [] })
    expect(p.pastMessages.map((m) => m.memberId).sort()).toEqual(['user-a', 'user-c'])
  })

  it('an outsider handed a chapter they are not in is refused (404), before any profile is read', async () => {
    viewer = 'user-x'; window = CH1
    requestedIds = []
    await expect(open('2026-04')).rejects.toThrow('NEXT_NOT_FOUND')
    expect(requestedIds).toEqual([])
  })
})
