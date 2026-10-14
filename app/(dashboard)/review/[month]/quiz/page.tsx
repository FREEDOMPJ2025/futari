import { notFound, redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/supabase/server'
import { db } from '@/lib/db/client'
import { partnerQuizSessions } from '@/lib/db/schema'
import { profiles } from '@/lib/db/schema'
import { inArray, sql } from 'drizzle-orm'
import {
  loadPartnerQuizSessionByEpoch,
  loadPartnerQuizAnswers,
  type PartnerQuizSessionRow,
} from '@/lib/db/queries/partnerQuiz'
import {
  getEpochMembers,
  lockOpenEpochForWrite,
  resolveViewerEpochContext,
} from '@/lib/db/queries/epoch'
import { parseYearMonth, currentYearMonthInTaipei, isAfter, isMonthInChapter } from '@/lib/monthlyReview'
import { pickQuizQuestions } from '@/lib/partnerQuiz'
import { captureServer } from '@/lib/analytics/server'
import { QuizClient } from './_components/QuizClient'

interface PageProps {
  params: Promise<{ month: string }>
}

export default async function PartnerQuizPage({ params }: PageProps) {
  const { month: monthParam } = await params
  const reviewedMonth = parseYearMonth(monthParam)
  if (!reviewedMonth) notFound()

  const user = await getCurrentUser()
  if (!user) redirect('/sign-in')

  // Same future-month guard as /review/[month] itself.
  const today = currentYearMonthInTaipei()
  if (isAfter(reviewedMonth, today)) notFound()

  const context = await resolveViewerEpochContext(user.id)
  if (!context) redirect('/onboarding')
  // A closed chapter is read-only (#1603 / F7), and its quiz stays hidden
  // (#1683, owner decision D4: no look-back of quiz results). This guards the
  // URL itself; the review page shows no quiz entry when pinned.
  if (context.window.isPast) notFound()
  // Same chapter guard as /review/[month] (#1380): a month outside the viewed
  // chapter's window is not this chapter's.
  if (!isMonthInChapter(reviewedMonth, context.window)) notFound()
  // #1683 — the quiz belongs to a chapter. No chapter row, no quiz (fail
  // closed): never fall back to anything keyed by the ledger.
  const epochId = context.window.epochId
  if (!epochId) notFound()
  const { group } = context

  // The chapter's two people, from its GroupEpochs row — not the ledger's
  // members, which change when a partner leaves and someone else joins.
  const chapter = await getEpochMembers(epochId)
  if (!chapter) notFound()
  const memberIds = [chapter.memberAId, chapter.memberBId].filter((x): x is string => !!x)
  // Not one of this chapter's two people → 404 (never /sign-in, #1603).
  if (!memberIds.includes(user.id)) notFound()

  // Solo chapter → soft fallback (spec: solo mode 不渲染整段 quiz).
  if (!chapter.memberBId) {
    return (
      <QuizClient
        reviewedMonth={reviewedMonth}
        mode="solo"
        sessionId=""
        questionKeys={[]}
        selfAnsweredKeys={[]}
        revealedAt={null}
        viewer={{ id: user.id, displayName: '', avatarUrl: null }}
        partner={null}
        memberAId={chapter.memberAId}
        memberBId=""
        answers={[]}
      />
    )
  }

  // Profiles for both members (used by the answer / reveal / waiting screens).
  const profileRows = await db
    .select({
      id: profiles.id,
      displayName: profiles.displayName,
      // #1328 — mask at the query so a hidden avatar can never leak into the
      // returned row, for either member.
      avatarUrl: sql<string | null>`CASE WHEN ${profiles.avatarHidden} THEN NULL ELSE ${profiles.avatarUrl} END`,
    })
    .from(profiles)
    .where(inArray(profiles.id, memberIds))

  const viewerProfile = profileRows.find((p) => p.id === user.id)
  // Not one of the chapter's members: 404, not /sign-in — a signed-in user
  // sent to /sign-in bounces back to /dashboard and loops (#1603).
  if (!viewerProfile) notFound()
  const partnerProfile = profileRows.find((p) => p.id !== user.id)
  if (!partnerProfile) redirect('/dashboard')

  // Load (or lazily create) THIS chapter's session (#1683). Entering this page
  // IS the "start" event per spec — we don't gate it behind a button click.
  //
  // Session creation lives here, inline, and not behind a server action: the
  // page has to have a session before it can render anything, so a `'use server'`
  // round-trip would only add a hop the render already can't proceed without.
  // There used to be a `startPartnerQuizSession()` action doing the same thing;
  // it had no caller for months while the telemetry inside it silently reported
  // zero (#1139). Please don't reintroduce one — put changes to how a session
  // comes into existence right here.
  let session = await loadPartnerQuizSessionByEpoch(epochId)
  if (!session) {
    const picked = pickQuizQuestions()
    let createdNew = false
    // The insert holds the open chapter row FOR SHARE (lockOpenEpochForWrite)
    // and only writes when that row is still the chapter this page resolved:
    // a leave / remove / accept committing meanwhile closes it, and a session
    // created after that would belong to a chapter that is already over.
    // `null` = the chapter closed under us; `undefined` = the insert failed
    // (the partner just created the session — UNIQUE (epoch_id)) → re-read.
    let created: PartnerQuizSessionRow | null | undefined
    try {
      created = await db.transaction(async (tx) => {
        const open = await lockOpenEpochForWrite(tx, group.id)
        if (!open || open.id !== epochId) return null
        const [row] = await tx
          .insert(partnerQuizSessions)
          .values({ groupId: group.id, epochId, questionKeys: picked })
          .returning({
            id: partnerQuizSessions.id,
            groupId: partnerQuizSessions.groupId,
            epochId: partnerQuizSessions.epochId,
            questionKeys: partnerQuizSessions.questionKeys,
            createdAt: partnerQuizSessions.createdAt,
            revealedAt: partnerQuizSessions.revealedAt,
          })
        return row
      })
    } catch {
      created = undefined
    }
    if (created === null) notFound()
    if (created) {
      session = created
      createdNew = true
    } else {
      session = await loadPartnerQuizSessionByEpoch(epochId)
      if (!session) {
        // Truly unexpected — surface as 404 rather than swallow.
        notFound()
      }
    }
    // Engagement signal (#818, moved here from the orphan action in #1139).
    // UNIQUE (epoch_id) makes a successful insert the one moment a session
    // comes into existence, so `createdNew` is the only condition under which
    // this can fire once per session. The conflict branch above deliberately
    // does not fire: it re-reads a session the partner just created. Neither
    // does the outer `if` — that is skipped entirely on every later visit,
    // which is what keeps a refresh from counting as another start.
    //
    // Kept outside the try so a `captureServer` failure can never be mistaken
    // for an insert conflict and send the render down the re-read path.
    if (createdNew) {
      await captureServer(user.id, 'partner_quiz_started', { question_count: picked.length })
    }
  }

  const answers = await loadPartnerQuizAnswers(session.id, memberIds)
  const selfAnsweredKeys = answers
    .filter((a) => a.memberId === user.id)
    .map((a) => a.questionKey)

  const mode: 'answer' | 'waiting' | 'reveal' = session.revealedAt
    ? 'reveal'
    : selfAnsweredKeys.length >= session.questionKeys.length
      ? 'waiting'
      : 'answer'

  return (
    <QuizClient
      reviewedMonth={reviewedMonth}
      mode={mode}
      sessionId={session.id}
      questionKeys={session.questionKeys}
      selfAnsweredKeys={selfAnsweredKeys}
      revealedAt={session.revealedAt ? session.revealedAt.toISOString() : null}
      viewer={{
        id: viewerProfile.id,
        displayName: viewerProfile.displayName,
        avatarUrl: viewerProfile.avatarUrl,
      }}
      partner={{
        id: partnerProfile.id,
        displayName: partnerProfile.displayName,
        avatarUrl: partnerProfile.avatarUrl,
      }}
      memberAId={chapter.memberAId}
      memberBId={chapter.memberBId}
      answers={answers.map((a) => ({
        memberId: a.memberId,
        questionKey: a.questionKey,
        choiceKey: a.choiceKey,
      }))}
    />
  )
}
