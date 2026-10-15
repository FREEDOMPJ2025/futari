import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setMockUser } from './_mocks/supabase'
import { mockBuilder, mockDb, queueDbResult, resetDbMocks } from './_mocks/db'
import {
  currentYearMonthInTaipei,
  nextMonth,
  previousMonth,
  taipeiMonthStart,
} from '@/lib/monthlyReview'
import {
  upsertMonthlyReviewMessage,
  dismissMonthlyReviewBanner,
} from '@/actions/monthlyReview'

const VIEWER = { id: 'user-a', email: 'a@example.com' }
const GROUP = { id: 'grp-1', memberA: 'user-a', memberB: 'user-b', name: '我們家' }
const SOLO_GROUP = { ...GROUP, memberB: null }

// Months relative to the real Taipei clock, so the tests do not rot.
const TODAY = currentYearMonthInTaipei()
/** The month the editor writes to: next month, from this month's review. */
const NEXT = nextMonth(TODAY)
/** The open chapter: opened at the start of the Taipei month a year ago. */
const OPEN_CHAPTER = {
  startedAt: taipeiMonthStart({ year: TODAY.year - 1, month: TODAY.month }),
  endedAt: null,
}

/**
 * Every DB call inside the action's transaction goes to this handle, not to
 * `db` — the test fails if a select or write bypasses the locked transaction.
 */
const tx = {
  select: vi.fn(() => mockBuilder),
  insert: vi.fn(() => mockBuilder),
  update: vi.fn(() => mockBuilder),
  delete: vi.fn(() => mockBuilder),
  execute: vi.fn(),
}

beforeEach(() => {
  resetDbMocks()
  setMockUser(VIEWER)
  for (const fn of Object.values(tx)) fn.mockClear()
  mockDb.transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx))
})

/** getViewerGroup → lockOpenEpochForWrite → the locked chapter's window. */
function queueOpenChapter(group: typeof GROUP | typeof SOLO_GROUP = GROUP, chapter = OPEN_CHAPTER) {
  queueDbResult([group])
  queueDbResult([{ id: 'epoch-open' }])
  queueDbResult([chapter])
}

/** Only the group lookup (requireViewerGroup) may use `db` directly. */
function expectEverythingThroughTx() {
  expect(mockDb.transaction).toHaveBeenCalledTimes(1)
  expect(mockDb.select).toHaveBeenCalledTimes(1)
  expect(mockDb.insert).not.toHaveBeenCalled()
  expect(mockDb.update).not.toHaveBeenCalled()
  expect(mockDb.delete).not.toHaveBeenCalled()
}

describe('upsertMonthlyReviewMessage', () => {
  it('inserts a fresh message when none exists', async () => {
    queueOpenChapter()
    queueDbResult([])          // existing message lookup → none
    queueDbResult([{ id: 'msg-1' }]) // insert returning

    const out = await upsertMonthlyReviewMessage({
      ...NEXT, body: '下個月想一起去看海',
    })

    expect(out).toEqual({ ok: true, data: { id: 'msg-1' } })
    const insertedValues = mockBuilder.values.mock.calls[0][0] as Record<string, unknown>
    expect(insertedValues.groupId).toBe(GROUP.id)
    expect(insertedValues.memberId).toBe(VIEWER.id)
    expect(insertedValues.year).toBe(NEXT.year)
    expect(insertedValues.month).toBe(NEXT.month)
    expect(insertedValues.body).toBe('下個月想一起去看海')
    expectEverythingThroughTx()
    // lock → window → existing; then the insert.
    expect(tx.select).toHaveBeenCalledTimes(3)
    expect(tx.insert).toHaveBeenCalledTimes(1)
    // The open chapter row is taken FOR SHARE first.
    expect(mockBuilder.for).toHaveBeenCalledWith('share')
  })

  it('updates an existing un-locked message', async () => {
    queueOpenChapter()
    queueDbResult([{ id: 'msg-existing', lockedAt: null }])
    queueDbResult([{ id: 'msg-existing' }])

    const out = await upsertMonthlyReviewMessage({
      ...NEXT, body: '改一下',
    })

    expect(out).toEqual({ ok: true, data: { id: 'msg-existing' } })
    const setPayload = mockBuilder.set.mock.calls[0][0] as Record<string, unknown>
    expect(setPayload.body).toBe('改一下')
    expect(setPayload.updatedAt).toBeInstanceOf(Date)
    expectEverythingThroughTx()
    expect(tx.update).toHaveBeenCalledTimes(1)
  })

  it('a past month inside the open chapter is still writable (no product change)', async () => {
    const past = previousMonth(previousMonth(TODAY))
    queueOpenChapter()
    queueDbResult([])
    queueDbResult([{ id: 'msg-past' }])

    expect(await upsertMonthlyReviewMessage({ ...past, body: '補寫' }))
      .toEqual({ ok: true, data: { id: 'msg-past' } })
  })

  it('refuses to update when locked_at is set', async () => {
    queueOpenChapter()
    queueDbResult([{ id: 'msg-existing', lockedAt: new Date() }])

    expect(await upsertMonthlyReviewMessage({
      ...NEXT, body: '想改但鎖了',
    })).toEqual({ ok: false, code: 'review_month_locked' })
  })

  // #1684 — a far-future row written now would wait in the ledger and be
  // quoted to whoever is in it when that month comes.
  it('rejects a month after next (its reviewed month is in the future)', async () => {
    queueOpenChapter()

    expect(await upsertMonthlyReviewMessage({
      ...nextMonth(NEXT), body: '寫給很久以後',
    })).toEqual({ ok: false, code: 'review_month_locked' })
    expect(tx.insert).not.toHaveBeenCalled()
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('rejects a far-future year', async () => {
    queueOpenChapter()
    expect(await upsertMonthlyReviewMessage({ year: 2099, month: 12, body: '未來' }))
      .toEqual({ ok: false, code: 'review_month_locked' })
    expect(tx.insert).not.toHaveBeenCalled()
  })

  // #1685 — the reviewed month must lie wholly inside the LOCKED open chapter.
  it('rejects when the reviewed month straddles the open chapter\'s start', async () => {
    // The chapter opened one millisecond after this month began (C joined
    // mid-month): this month belongs to no chapter, so neither does a message
    // given from its review.
    const straddling = { startedAt: new Date(taipeiMonthStart(TODAY).getTime() + 1), endedAt: null }
    queueOpenChapter(GROUP, straddling)

    expect(await upsertMonthlyReviewMessage({ ...NEXT, body: '給新章節' }))
      .toEqual({ ok: false, code: 'review_month_locked' })
    expect(tx.insert).not.toHaveBeenCalled()
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('rejects a month from before the open chapter (the previous partner\'s months)', async () => {
    const chapter = { startedAt: taipeiMonthStart(TODAY), endedAt: null }
    queueOpenChapter(GROUP, chapter)

    // Reviewed = last month, wholly before the chapter.
    expect(await upsertMonthlyReviewMessage({ ...TODAY, body: '寫給上一章' }))
      .toEqual({ ok: false, code: 'review_month_locked' })
    expect(tx.insert).not.toHaveBeenCalled()
  })

  it('refuses (fails closed) when no open chapter can be locked', async () => {
    queueDbResult([GROUP])
    queueDbResult([])          // lockOpenEpochForWrite → null

    expect(await upsertMonthlyReviewMessage({ ...NEXT, body: '章節剛關' }))
      .toEqual({ ok: false, code: 'current_epoch_not_found' })
    expect(tx.select).toHaveBeenCalledTimes(1)
    expect(tx.insert).not.toHaveBeenCalled()
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('rejects a malformed month', async () => {
    queueOpenChapter()
    await expect(upsertMonthlyReviewMessage({ year: NEXT.year, month: 13, body: 'x' }))
      .rejects.toThrow(/Invalid review month/)
    queueOpenChapter()
    await expect(upsertMonthlyReviewMessage({ year: NEXT.year, month: 1.5, body: 'x' }))
      .rejects.toThrow(/Invalid review month/)
    expect(tx.insert).not.toHaveBeenCalled()
  })

  it('rejects empty body before touching the DB', async () => {
    // No queue: getViewerGroup is *not* expected to fire because validation
    // runs first.
    await expect(upsertMonthlyReviewMessage({
      ...NEXT, body: '   ',
    })).rejects.toThrow(/不能為空/)
  })

  it('rejects body over 200 codepoints', async () => {
    const tooLong = '字'.repeat(201)
    await expect(upsertMonthlyReviewMessage({
      ...NEXT, body: tooLong,
    })).rejects.toThrow(/最長/)
  })

  it('handles solo mode (memberB null) without complaint', async () => {
    queueOpenChapter(SOLO_GROUP)
    queueDbResult([])
    queueDbResult([{ id: 'msg-solo' }])

    const out = await upsertMonthlyReviewMessage({
      ...NEXT, body: '一個人也要好好過',
    })
    expect(out).toEqual({ ok: true, data: { id: 'msg-solo' } })
  })
})

describe('dismissMonthlyReviewBanner', () => {
  it('sets memberA dismiss flag for member A viewer', async () => {
    queueDbResult([GROUP])
    queueDbResult([])  // update().where(...).then resolves to []

    await dismissMonthlyReviewBanner({ year: 2026, month: 5 })

    const setPayload = mockBuilder.set.mock.calls[0][0] as Record<string, unknown>
    expect(setPayload.bannerDismissedByMemberAAt).toBeInstanceOf(Date)
    expect(setPayload.bannerDismissedByMemberBAt).toBeUndefined()
  })

  it('sets memberB dismiss flag for member B viewer', async () => {
    setMockUser({ id: 'user-b' })
    queueDbResult([GROUP])
    queueDbResult([])

    await dismissMonthlyReviewBanner({ year: 2026, month: 5 })

    const setPayload = mockBuilder.set.mock.calls[0][0] as Record<string, unknown>
    expect(setPayload.bannerDismissedByMemberBAt).toBeInstanceOf(Date)
    expect(setPayload.bannerDismissedByMemberAAt).toBeUndefined()
  })
})
