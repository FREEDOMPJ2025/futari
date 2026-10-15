'use server'

import { db } from '@/lib/db/client'
import { groupEpochs, partnerQuizAnswers, partnerQuizSessions } from '@/lib/db/schema'
import { requireViewerGroup } from '@/lib/auth/viewer'
import { lockOpenEpochForWrite } from '@/lib/db/queries/epoch'
import {
  validateAnswersBatch,
  type PartnerQuizAnswerInput,
} from '@/lib/partnerQuiz'
import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { captureServer } from '@/lib/analytics/server'
import { action } from '@/lib/action-errors'

export interface SubmitPartnerQuizAnswersInput {
  sessionId: string
  answers: PartnerQuizAnswerInput[]
}

export interface SubmitPartnerQuizAnswersResult {
  revealed: boolean
}

/**
 * Batch-writes the viewer's answers for the session, and stamps `revealed_at`
 * in the same transaction when both of the chapter's members are complete.
 *
 * #1683 — everything runs in ONE transaction, under locks, in this order:
 *   1. the session row FOR UPDATE: two members submitting at once are
 *      serialized here, so the second sees the first's answers and exactly one
 *      of them stamps `revealed_at`;
 *   2. the group's open chapter row FOR SHARE (lockOpenEpochForWrite; entity
 *      row → chapter row, the order the chapter closers expect). The session
 *      must belong to THAT chapter: a session of a closed chapter (a previous
 *      partner's) is refused as `session_not_found`, the same answer a trip or
 *      record of another chapter gets (actions/trip.ts). While the share lock
 *      is held no leave / remove / accept can close the chapter, so the answers
 *      cannot land after the chapter they belong to has ended.
 * Every precondition (not revealed, viewer is one of the chapter's two people,
 * not already answered) is checked under those locks, never before them.
 *
 * Reveal is per member: each of the CHAPTER's two members (its GroupEpochs
 * row, not the ledger row) has an answer to every question. The old rule
 * (total rows == 2N, counted against today's member_b) never fired for A+C
 * on a session B had answered, and the quiz stuck in "waiting".
 */
export const submitPartnerQuizAnswers = action(async (
  input: SubmitPartnerQuizAnswersInput,
): Promise<SubmitPartnerQuizAnswersResult> => {
  const { user, group } = await requireViewerGroup()
  if (!group.memberB) {
    // Error CODE, not prose: QuestionCard renders whatever code this action
    // raises, so a literal string here ships hard-coded zh-TW to en / ja
    // viewers and bypasses `quiz.errors.solo` entirely. The `action()` wrapper
    // turns this throw into `{ ok: false, code: 'solo_group' }` at the export
    // boundary (#1223); `describeQuizError` maps it.
    throw new Error('solo_group')
  }

  const { revealed, questionCount } = await db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        id: partnerQuizSessions.id,
        groupId: partnerQuizSessions.groupId,
        epochId: partnerQuizSessions.epochId,
        questionKeys: partnerQuizSessions.questionKeys,
        revealedAt: partnerQuizSessions.revealedAt,
      })
      .from(partnerQuizSessions)
      .where(eq(partnerQuizSessions.id, input.sessionId))
      .for('update')

    // Codes, not prose — same contract as `solo_group` above (#1140).
    if (!session) throw new Error('session_not_found')
    if (session.groupId !== group.id) throw new Error('wrong_group')

    const open = await lockOpenEpochForWrite(tx, group.id)
    if (!open || open.id !== session.epochId) throw new Error('session_not_found')

    const [chapter] = await tx
      .select({ memberAId: groupEpochs.memberAId, memberBId: groupEpochs.memberBId })
      .from(groupEpochs)
      .where(eq(groupEpochs.id, open.id))
    if (!chapter) throw new Error('session_not_found')
    if (!chapter.memberBId) throw new Error('solo_group')
    const memberA = chapter.memberAId
    const memberB = chapter.memberBId
    if (user.id !== memberA && user.id !== memberB) throw new Error('wrong_group')

    if (session.revealedAt) throw new Error('already_revealed')

    const { answers } = validateAnswersBatch(session.questionKeys, input.answers)

    const existing = await tx
      .select({ id: partnerQuizAnswers.id })
      .from(partnerQuizAnswers)
      .where(and(
        eq(partnerQuizAnswers.sessionId, session.id),
        eq(partnerQuizAnswers.memberId, user.id),
      ))
    if (existing.length > 0) {
      throw new Error('already_answered')
    }

    await tx.insert(partnerQuizAnswers).values(
      answers.map((a) => ({
        sessionId: session.id,
        memberId: user.id,
        questionKey: a.questionKey,
        choiceKey: a.choiceKey,
      })),
    )

    const allAnswers = await tx
      .select({ memberId: partnerQuizAnswers.memberId })
      .from(partnerQuizAnswers)
      .where(eq(partnerQuizAnswers.sessionId, session.id))

    const total = session.questionKeys.length
    const countA = allAnswers.filter((r) => r.memberId === memberA).length
    const countB = allAnswers.filter((r) => r.memberId === memberB).length

    if (countA === total && countB === total) {
      await tx
        .update(partnerQuizSessions)
        .set({ revealedAt: new Date() })
        .where(eq(partnerQuizSessions.id, session.id))
      return { revealed: true, questionCount: total }
    }
    return { revealed: false, questionCount: total }
  })

  // Both members' /review/[YYYY-MM] pages derive from this session's state
  // (any month, because the invitation card and CTA link follow viewer-level
  // status). We don't know which month the viewer entered from, so blanket-
  // revalidate the dashboard + bust client cache on next nav.
  revalidatePath('/dashboard')

  // Engagement signal (#818): fires only on the second answerer who triggers reveal.
  if (revealed) {
    await captureServer(user.id, 'partner_quiz_completed', { question_count: questionCount })
  }

  return { revealed }
})
