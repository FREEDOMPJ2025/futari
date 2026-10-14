import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * #1139 — `partner_quiz_started` used to live inside `startPartnerQuizSession()`,
 * a server action with no production caller. The real session is created inline
 * by this page, so the event never fired once in prod while
 * `partner_quiz_completed` kept firing normally — a funnel built on the pair
 * divides by zero and looks like a finding rather than a bug.
 *
 * The event now sits in the page's lazy-insert success branch. The thing worth
 * guarding is not that it fires at all but that it fires *once*: the page is a
 * Server Component that re-runs on every visit and every `router.refresh()`, so
 * an event placed one indentation level too far out would count each refresh as
 * a new start and re-inflate the same number in the opposite direction.
 */

const h = vi.hoisted(() => ({
  captureServer: vi.fn(async () => {}),
  getCurrentUser: vi.fn(),
  resolveViewerEpochContext: vi.fn(),
  getEpochMembers: vi.fn(),
  lockOpenEpochForWrite: vi.fn(),
  loadPartnerQuizSessionByEpoch: vi.fn(),
  loadPartnerQuizAnswers: vi.fn(async () => []),
}))

vi.mock('@/lib/analytics/server', () => ({ captureServer: h.captureServer }))
vi.mock('@/lib/supabase/server', () => ({ getCurrentUser: h.getCurrentUser }))
vi.mock('@/lib/db/queries/epoch', () => ({
  resolveViewerEpochContext: h.resolveViewerEpochContext,
  getEpochMembers: h.getEpochMembers,
  lockOpenEpochForWrite: h.lockOpenEpochForWrite,
}))
vi.mock('@/lib/db/queries/partnerQuiz', () => ({
  loadPartnerQuizSessionByEpoch: h.loadPartnerQuizSessionByEpoch,
  loadPartnerQuizAnswers: h.loadPartnerQuizAnswers,
}))
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
  redirect: vi.fn((path: string) => { throw new Error(`REDIRECT:${path}`) }),
}))
// The page only needs to *return* this element; rendering is out of scope here
// and its subtree would drag the whole client-component tree into the test.
vi.mock('@/app/(dashboard)/review/[month]/quiz/_components/QuizClient', () => ({
  QuizClient: () => null,
}))

import { mockBuilder, mockDb, queueDbResult, resetDbMocks } from './_mocks/db'
import PartnerQuizPage from '@/app/(dashboard)/review/[month]/quiz/page'

const VIEWER = { id: 'user-a', email: 'a@example.com' }
const GROUP = { id: 'grp-1', memberA: 'user-a', memberB: 'user-b' }
const QUESTION_KEYS = ['impulse', 'risk', 'transparency']
const PROFILE_ROWS = [
  { id: 'user-a', displayName: 'A', avatarUrl: null },
  { id: 'user-b', displayName: 'B', avatarUrl: null },
]
const EPOCH = 'ep-open'
// The open chapter, started well before the reviewed month (2026-08).
const OPEN_WINDOW = { startedAt: new Date('2026-01-01T00:00:00Z'), endedAt: null, epochId: EPOCH, isPast: false }
const EXISTING_SESSION = {
  id: 'sess-1',
  groupId: GROUP.id,
  epochId: EPOCH,
  questionKeys: QUESTION_KEYS,
  createdAt: new Date('2026-08-02T00:00:00Z'),
  revealedAt: null,
}

// A month in the past relative to any run date this repo will see — the page
// 404s on future months before it ever reaches the session logic.
const params = Promise.resolve({ month: '2026-08' })

function renderPage() {
  return PartnerQuizPage({ params })
}

beforeEach(() => {
  resetDbMocks()
  vi.clearAllMocks()
  h.getCurrentUser.mockResolvedValue(VIEWER)
  h.resolveViewerEpochContext.mockResolvedValue({ group: GROUP, window: OPEN_WINDOW })
  h.getEpochMembers.mockResolvedValue({ memberAId: 'user-a', memberBId: 'user-b', memberAName: 'A', memberBName: 'B' })
  h.lockOpenEpochForWrite.mockResolvedValue({ id: EPOCH })
  h.loadPartnerQuizAnswers.mockResolvedValue([])
})

describe('partner_quiz_started (#1139)', () => {
  it('fires once when the page actually inserts the session', async () => {
    h.loadPartnerQuizSessionByEpoch.mockResolvedValueOnce(null)
    queueDbResult(PROFILE_ROWS)
    queueDbResult([{ ...EXISTING_SESSION, id: 'sess-new' }])

    await renderPage()

    expect(mockDb.insert).toHaveBeenCalledTimes(1)
    expect(h.captureServer).toHaveBeenCalledTimes(1)
    expect(h.captureServer).toHaveBeenCalledWith(
      VIEWER.id,
      'partner_quiz_started',
      { question_count: 3 },
    )
  })

  it('does NOT fire when the page re-renders on an existing session', async () => {
    // This is the refresh / second-visit path: the Server Component re-runs in
    // full, finds the session, and must stay silent.
    h.loadPartnerQuizSessionByEpoch.mockResolvedValue(EXISTING_SESSION)
    queueDbResult(PROFILE_ROWS)

    await renderPage()

    expect(mockDb.insert).not.toHaveBeenCalled()
    expect(h.captureServer).not.toHaveBeenCalled()
  })

  // This is the test that pins `createdNew`. The "two refreshes" case below
  // passes with or without the flag, because a later visit never enters the
  // `if (!session)` block at all — so don't delete this one believing that
  // one covers the guard. Verified by mutation: dropping `if (createdNew)`
  // fails here and nowhere else in this file.
  it('does NOT fire on the UNIQUE-conflict re-read (partner created it first)', async () => {
    // Both members opened the link at once; our insert loses the race and the
    // page re-reads. That is not a start — the winner already reported one.
    h.loadPartnerQuizSessionByEpoch
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(EXISTING_SESSION)
    mockDb.insert.mockImplementationOnce(() => {
      throw new Error('duplicate key value violates unique constraint')
    })
    queueDbResult(PROFILE_ROWS)

    await renderPage()

    expect(h.loadPartnerQuizSessionByEpoch).toHaveBeenCalledTimes(2)
    expect(h.captureServer).not.toHaveBeenCalled()
  })

  it('stays silent across a create followed by two refreshes (net: one event)', async () => {
    // The regression this file exists for, spelled out end to end.
    h.loadPartnerQuizSessionByEpoch.mockResolvedValueOnce(null)
    queueDbResult(PROFILE_ROWS)
    queueDbResult([{ ...EXISTING_SESSION, id: 'sess-new' }])
    await renderPage()

    h.loadPartnerQuizSessionByEpoch.mockResolvedValue(EXISTING_SESSION)
    queueDbResult(PROFILE_ROWS)
    await renderPage()
    queueDbResult(PROFILE_ROWS)
    await renderPage()

    expect(h.captureServer).toHaveBeenCalledTimes(1)
  })
})

// #1603 / F7 — a past chapter is read-only, and the quiz session this page
// loads (or lazily inserts) is the group's live one, i.e. today's pair's.
// Before the guard, opening /review/<month>/quiz while pinned to a closed
// chapter showed — or created — a session for the current pair.
describe('pinned to a past chapter (#1603)', () => {
  it('returns 404 without reading or inserting a quiz session', async () => {
    h.resolveViewerEpochContext.mockResolvedValue({
      group: GROUP,
      window: { ...OPEN_WINDOW, endedAt: new Date('2026-12-01T00:00:00Z'), isPast: true },
    })
    queueDbResult(PROFILE_ROWS)

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND')

    expect(h.loadPartnerQuizSessionByEpoch).not.toHaveBeenCalled()
    expect(mockDb.insert).not.toHaveBeenCalled()
    expect(h.captureServer).not.toHaveBeenCalled()
  })
})

// #1683 — the session is the viewed chapter's, found and created by its epoch id.
describe('one quiz per chapter (#1683)', () => {
  it('looks the session up by the chapter\'s epoch id and creates it with that epoch id', async () => {
    h.loadPartnerQuizSessionByEpoch.mockResolvedValueOnce(null)
    queueDbResult(PROFILE_ROWS)
    queueDbResult([{ ...EXISTING_SESSION, id: 'sess-new' }])

    await renderPage()

    expect(h.loadPartnerQuizSessionByEpoch).toHaveBeenCalledWith(EPOCH)
    expect(h.lockOpenEpochForWrite).toHaveBeenCalledWith(mockDb, GROUP.id)
    const inserted = mockBuilder.values.mock.calls[0][0] as Record<string, unknown>
    expect(inserted).toMatchObject({ groupId: GROUP.id, epochId: EPOCH })
  })

  it('does not insert when the chapter closed under the page (open chapter is another one) → 404', async () => {
    h.loadPartnerQuizSessionByEpoch.mockResolvedValueOnce(null)
    h.lockOpenEpochForWrite.mockResolvedValueOnce({ id: 'ep-next' })
    queueDbResult(PROFILE_ROWS)

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(mockDb.insert).not.toHaveBeenCalled()
    expect(h.captureServer).not.toHaveBeenCalled()
  })

  it('fails closed with no chapter row (epochId null): 404, no session read or written', async () => {
    h.resolveViewerEpochContext.mockResolvedValue({ group: GROUP, window: { ...OPEN_WINDOW, epochId: null } })

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(h.loadPartnerQuizSessionByEpoch).not.toHaveBeenCalled()
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('a month outside the chapter is 404 (isMonthInChapter), before any session read', async () => {
    h.resolveViewerEpochContext.mockResolvedValue({
      group: GROUP,
      window: { ...OPEN_WINDOW, startedAt: new Date('2026-08-15T00:00:00Z') },
    })

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(h.loadPartnerQuizSessionByEpoch).not.toHaveBeenCalled()
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('a viewer who is not one of the chapter\'s two people is 404', async () => {
    h.getEpochMembers.mockResolvedValue({ memberAId: 'user-x', memberBId: 'user-b', memberAName: 'X', memberBName: 'B' })

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(h.loadPartnerQuizSessionByEpoch).not.toHaveBeenCalled()
  })

  it('answers are read only for the chapter\'s two people', async () => {
    h.loadPartnerQuizSessionByEpoch.mockResolvedValue(EXISTING_SESSION)
    queueDbResult(PROFILE_ROWS)

    await renderPage()

    expect(h.loadPartnerQuizAnswers).toHaveBeenCalledWith(EXISTING_SESSION.id, ['user-a', 'user-b'])
  })
})
