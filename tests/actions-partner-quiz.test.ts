import { describe, it, expect, beforeEach } from 'vitest'
import { setMockUser } from './_mocks/supabase'
import { mockBuilder, mockDb, queueDbResult, resetDbMocks } from './_mocks/db'
import { submitPartnerQuizAnswers } from '@/actions/partnerQuiz'

const VIEWER = { id: 'user-a', email: 'a@example.com' }
const GROUP = { id: 'grp-1', memberA: 'user-a', memberB: 'user-b', name: '我們家' }
const SOLO_GROUP = { ...GROUP, memberB: null }
const QUESTION_KEYS = ['impulse', 'risk', 'transparency']
const GOOD_ANSWERS = [
  { questionKey: 'impulse', choiceKey: 'a' },
  { questionKey: 'risk', choiceKey: 'b' },
  { questionKey: 'transparency', choiceKey: 'c' },
]

const OPEN_EPOCH = 'ep-ab'
const CHAPTER_AB = { memberAId: 'user-a', memberBId: 'user-b' }

beforeEach(() => {
  resetDbMocks()
  setMockUser(VIEWER)
})

/**
 * #1683 — the reads every submit does, in order, inside ONE transaction:
 * the ledger row (requireViewerGroup, outside), the session FOR UPDATE, the
 * open chapter row FOR SHARE (lockOpenEpochForWrite), that chapter's members.
 */
function queueLockedReads(opts: {
  group?: typeof GROUP
  session: Record<string, unknown>
  openEpoch?: string | null
  chapter?: { memberAId: string; memberBId: string | null }
}) {
  queueDbResult([opts.group ?? GROUP])
  queueDbResult([{ epochId: OPEN_EPOCH, ...opts.session }])
  const open = opts.openEpoch === undefined ? OPEN_EPOCH : opts.openEpoch
  queueDbResult(open ? [{ id: open }] : [])
  if (open) queueDbResult([opts.chapter ?? CHAPTER_AB])
}

describe('submitPartnerQuizAnswers', () => {
  it('writes 3 answers and does NOT reveal when partner hasn’t answered', async () => {
    queueLockedReads({ session: { id: 'sess-1', groupId: GROUP.id, questionKeys: QUESTION_KEYS, revealedAt: null } })
    // transaction: existing-answers-for-self lookup → empty
    queueDbResult([])
    // transaction: insert .values(...) chain promise → []
    queueDbResult([])
    // transaction: allAnswers after insert — only viewer has 3 rows
    queueDbResult([
      { memberId: 'user-a' },
      { memberId: 'user-a' },
      { memberId: 'user-a' },
    ])

    const out = await submitPartnerQuizAnswers({
      sessionId: 'sess-1',
      answers: GOOD_ANSWERS,
    })
    expect(out).toEqual({ ok: true, data: { revealed: false } })

    // We expect exactly one .insert() and zero .update() — reveal was NOT stamped.
    expect(mockDb.insert).toHaveBeenCalledTimes(1)
    expect(mockDb.update).not.toHaveBeenCalled()

    const insertedRows = mockBuilder.values.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(insertedRows).toHaveLength(3)
    for (const row of insertedRows) {
      expect(row.sessionId).toBe('sess-1')
      expect(row.memberId).toBe(VIEWER.id)
    }
  })

  it('stamps revealed_at when partner is already done (atomic reveal)', async () => {
    queueLockedReads({ session: { id: 'sess-2', groupId: GROUP.id, questionKeys: QUESTION_KEYS, revealedAt: null } })
    queueDbResult([])                                                // self has no answers yet
    queueDbResult([])                                                // insert chain
    // partner had already written 3 rows; insert just added 3 of ours.
    queueDbResult([
      { memberId: 'user-b' }, { memberId: 'user-b' }, { memberId: 'user-b' },
      { memberId: 'user-a' }, { memberId: 'user-a' }, { memberId: 'user-a' },
    ])
    queueDbResult([])  // the update chain promise

    const out = await submitPartnerQuizAnswers({
      sessionId: 'sess-2',
      answers: GOOD_ANSWERS,
    })
    expect(out).toEqual({ ok: true, data: { revealed: true } })

    expect(mockDb.update).toHaveBeenCalledTimes(1)
    const setPayload = mockBuilder.set.mock.calls[0][0] as Record<string, unknown>
    expect(setPayload.revealedAt).toBeInstanceOf(Date)
  })

  it('refuses to re-submit when the viewer already has answers', async () => {
    queueLockedReads({ session: { id: 'sess-3', groupId: GROUP.id, questionKeys: QUESTION_KEYS, revealedAt: null } })
    queueDbResult([{ id: 'ans-existing' }])  // existing-answers lookup non-empty

    expect(await submitPartnerQuizAnswers({
      sessionId: 'sess-3',
      answers: GOOD_ANSWERS,
    })).toEqual({ ok: false, code: 'already_answered' })

    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('refuses to write when the session belongs to a different group', async () => {
    queueLockedReads({ session: { id: 'sess-x', groupId: 'other-group', questionKeys: QUESTION_KEYS, revealedAt: null } })

    expect(await submitPartnerQuizAnswers({
      sessionId: 'sess-x',
      answers: GOOD_ANSWERS,
    })).toEqual({ ok: false, code: 'wrong_group' })
  })

  it('refuses when the session is already revealed', async () => {
    queueLockedReads({ session: { id: 'sess-4', groupId: GROUP.id, questionKeys: QUESTION_KEYS, revealedAt: new Date() } })

    expect(await submitPartnerQuizAnswers({
      sessionId: 'sess-4',
      answers: GOOD_ANSWERS,
    })).toEqual({ ok: false, code: 'already_revealed' })
  })

  it('rejects an answer set whose keys don’t match the session', async () => {
    queueLockedReads({ session: { id: 'sess-5', groupId: GROUP.id, questionKeys: QUESTION_KEYS, revealedAt: null } })

    expect(await submitPartnerQuizAnswers({
      sessionId: 'sess-5',
      answers: [
        { questionKey: 'future', choiceKey: 'a' },
        { questionKey: 'risk', choiceKey: 'b' },
        { questionKey: 'transparency', choiceKey: 'c' },
      ],
    })).toEqual({ ok: false, code: 'quiz_question_out_of_range' })
  })

  // #1123 / #1140 — QuestionCard renders whatever this action returns. A prose
  // message here would ship hard-coded zh-TW to en / ja viewers, so the contract
  // for every rejection is an error CODE (`{ ok: false, code }`) that
  // `describeQuizError` maps to a dictionary entry. The exact-match assertions
  // above and below are deliberate: a loose match would still pass if someone
  // reintroduced a prose message alongside the code.
  it('refuses in solo mode with a code, not prose', async () => {
    queueDbResult([SOLO_GROUP])
    expect(await submitPartnerQuizAnswers({
      sessionId: 'sess-solo',
      answers: GOOD_ANSWERS,
    })).toEqual({ ok: false, code: 'solo_group' })
  })
  // ─── #1683 — one quiz per chapter ───────────────────────────────────────

  it('reads the session FOR UPDATE and the open chapter FOR SHARE, all inside one transaction', async () => {
    queueLockedReads({ session: { id: 'sess-lock', groupId: GROUP.id, questionKeys: QUESTION_KEYS, revealedAt: null } })
    queueDbResult([])  // existing
    queueDbResult([])  // insert
    queueDbResult([{ memberId: 'user-a' }, { memberId: 'user-a' }, { memberId: 'user-a' }])

    expect(await submitPartnerQuizAnswers({ sessionId: 'sess-lock', answers: GOOD_ANSWERS }))
      .toEqual({ ok: true, data: { revealed: false } })
    expect(mockDb.transaction).toHaveBeenCalledTimes(1)
    expect(mockBuilder.for.mock.calls.map((c) => c[0])).toEqual(['update', 'share'])
  })

  it('refuses a session of another chapter (a closed A+B session) as session_not_found, writing nothing', async () => {
    queueLockedReads({
      session: { id: 'sess-old', groupId: GROUP.id, epochId: 'ep-closed', questionKeys: QUESTION_KEYS, revealedAt: null },
    })

    expect(await submitPartnerQuizAnswers({ sessionId: 'sess-old', answers: GOOD_ANSWERS }))
      .toEqual({ ok: false, code: 'session_not_found' })
    expect(mockDb.insert).not.toHaveBeenCalled()
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('refuses when the ledger has no open chapter (closed under us), writing nothing', async () => {
    queueLockedReads({
      session: { id: 'sess-c', groupId: GROUP.id, questionKeys: QUESTION_KEYS, revealedAt: null },
      openEpoch: null,
    })

    expect(await submitPartnerQuizAnswers({ sessionId: 'sess-c', answers: GOOD_ANSWERS }))
      .toEqual({ ok: false, code: 'session_not_found' })
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('refuses a viewer who is not one of the chapter\'s two people', async () => {
    setMockUser({ id: 'user-x', email: 'x@example.com' })
    queueLockedReads({
      group: { ...GROUP, memberA: 'user-x' },
      session: { id: 'sess-n', groupId: GROUP.id, questionKeys: QUESTION_KEYS, revealedAt: null },
    })

    expect(await submitPartnerQuizAnswers({ sessionId: 'sess-n', answers: GOOD_ANSWERS }))
      .toEqual({ ok: false, code: 'wrong_group' })
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('reveals per member: each chapter member has N answers, whatever else the session holds', async () => {
    queueLockedReads({ session: { id: 'sess-pm', groupId: GROUP.id, questionKeys: QUESTION_KEYS, revealedAt: null } })
    queueDbResult([])  // existing
    queueDbResult([])  // insert
    // A's 3 + B's 3, plus 3 rows from someone outside the chapter. The old
    // rule (total rows == 2N) never revealed this session.
    queueDbResult([
      { memberId: 'user-z' }, { memberId: 'user-z' }, { memberId: 'user-z' },
      { memberId: 'user-b' }, { memberId: 'user-b' }, { memberId: 'user-b' },
      { memberId: 'user-a' }, { memberId: 'user-a' }, { memberId: 'user-a' },
    ])
    queueDbResult([])  // update

    expect(await submitPartnerQuizAnswers({ sessionId: 'sess-pm', answers: GOOD_ANSWERS }))
      .toEqual({ ok: true, data: { revealed: true } })
    expect(mockDb.update).toHaveBeenCalledTimes(1)
  })

  it('does not reveal on 2N rows when one chapter member has none', async () => {
    queueLockedReads({ session: { id: 'sess-pm2', groupId: GROUP.id, questionKeys: QUESTION_KEYS, revealedAt: null } })
    queueDbResult([])  // existing
    queueDbResult([])  // insert
    queueDbResult([
      { memberId: 'user-a' }, { memberId: 'user-a' }, { memberId: 'user-a' },
      { memberId: 'user-z' }, { memberId: 'user-z' }, { memberId: 'user-z' },
    ])

    expect(await submitPartnerQuizAnswers({ sessionId: 'sess-pm2', answers: GOOD_ANSWERS }))
      .toEqual({ ok: true, data: { revealed: false } })
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('B answered, then left; A+C get their own session and it reveals (no longer stuck)', async () => {
    // Chapter A+B (ep-ab) closed with only B's answers; chapter A+C (ep-ac) is open.
    const GROUP_AC = { ...GROUP, memberB: 'user-c' }
    const CHAPTER_AC = { memberAId: 'user-a', memberBId: 'user-c' }

    // A on the old A+B session: refused, nothing written.
    queueLockedReads({
      group: GROUP_AC,
      session: { id: 'sess-ab', groupId: GROUP.id, epochId: 'ep-ab', questionKeys: QUESTION_KEYS, revealedAt: null },
      openEpoch: 'ep-ac',
      chapter: CHAPTER_AC,
    })
    expect(await submitPartnerQuizAnswers({ sessionId: 'sess-ab', answers: GOOD_ANSWERS }))
      .toEqual({ ok: false, code: 'session_not_found' })
    expect(mockDb.insert).not.toHaveBeenCalled()

    // A on the A+C session, after C answered: revealed.
    resetDbMocks()
    setMockUser(VIEWER)
    queueLockedReads({
      group: GROUP_AC,
      session: { id: 'sess-ac', groupId: GROUP.id, epochId: 'ep-ac', questionKeys: QUESTION_KEYS, revealedAt: null },
      openEpoch: 'ep-ac',
      chapter: CHAPTER_AC,
    })
    queueDbResult([])  // existing
    queueDbResult([])  // insert
    queueDbResult([
      { memberId: 'user-c' }, { memberId: 'user-c' }, { memberId: 'user-c' },
      { memberId: 'user-a' }, { memberId: 'user-a' }, { memberId: 'user-a' },
    ])
    queueDbResult([])  // update

    expect(await submitPartnerQuizAnswers({ sessionId: 'sess-ac', answers: GOOD_ANSWERS }))
      .toEqual({ ok: true, data: { revealed: true } })
    expect(mockDb.update).toHaveBeenCalledTimes(1)
  })
})
