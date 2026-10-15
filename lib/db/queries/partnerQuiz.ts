import { db } from '@/lib/db/client'
import { partnerQuizAnswers, partnerQuizSessions } from '@/lib/db/schema'
import { and, asc, eq, inArray } from 'drizzle-orm'

export interface PartnerQuizSessionRow {
  id: string
  groupId: string
  epochId: string
  questionKeys: string[]
  createdAt: Date
  revealedAt: Date | null
}

export interface PartnerQuizAnswerRow {
  id: string
  sessionId: string
  memberId: string
  questionKey: string
  choiceKey: string
  answeredAt: Date
}

/**
 * #1683 — the quiz session of ONE chapter (GroupEpochs row), or null.
 *
 * A ledger keeps its id across partners, so it can hold one session per
 * chapter (0095: UNIQUE (epoch_id)). There is deliberately no lookup by
 * group: the old `loadPartnerQuizSessionByGroup` (limit 1, no order) handed
 * the next partner the previous partner's session and answers.
 *
 * Caller contract: `epochId` comes from `resolveViewerEpochContext`
 * (`context.window.epochId`), never from user input. A null epoch id means
 * "no chapter" — callers show no quiz rather than calling this.
 */
export async function loadPartnerQuizSessionByEpoch(
  epochId: string,
): Promise<PartnerQuizSessionRow | null> {
  const [row] = await db
    .select({
      id: partnerQuizSessions.id,
      groupId: partnerQuizSessions.groupId,
      epochId: partnerQuizSessions.epochId,
      questionKeys: partnerQuizSessions.questionKeys,
      createdAt: partnerQuizSessions.createdAt,
      revealedAt: partnerQuizSessions.revealedAt,
    })
    .from(partnerQuizSessions)
    .where(eq(partnerQuizSessions.epochId, epochId))
    .limit(1)
  return row ?? null
}

/**
 * A session's answers, limited to `memberIds` — the chapter's two people
 * (#1683). The session already belongs to one chapter; the member filter
 * keeps a row from anyone else (there should be none) off the page.
 */
export async function loadPartnerQuizAnswers(
  sessionId: string,
  memberIds: string[],
): Promise<PartnerQuizAnswerRow[]> {
  if (memberIds.length === 0) return []
  return db
    .select({
      id: partnerQuizAnswers.id,
      sessionId: partnerQuizAnswers.sessionId,
      memberId: partnerQuizAnswers.memberId,
      questionKey: partnerQuizAnswers.questionKey,
      choiceKey: partnerQuizAnswers.choiceKey,
      answeredAt: partnerQuizAnswers.answeredAt,
    })
    .from(partnerQuizAnswers)
    .where(and(
      eq(partnerQuizAnswers.sessionId, sessionId),
      inArray(partnerQuizAnswers.memberId, memberIds),
    ))
    .orderBy(asc(partnerQuizAnswers.answeredAt))
}

export async function loadPartnerQuizAnswerCountForMember(
  sessionId: string,
  memberId: string,
): Promise<number> {
  const rows = await db
    .select({ id: partnerQuizAnswers.id })
    .from(partnerQuizAnswers)
    .where(and(
      eq(partnerQuizAnswers.sessionId, sessionId),
      eq(partnerQuizAnswers.memberId, memberId),
    ))
  return rows.length
}
