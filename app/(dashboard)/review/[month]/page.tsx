import { notFound, redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/supabase/server'
import { db } from '@/lib/db/client'
import { profiles } from '@/lib/db/schema'
import { inArray, sql } from 'drizzle-orm'
import {
  loadMonthlyReviewSnapshot,
  loadChapterReviewMessages,
} from '@/lib/db/queries/monthlyReview'
import {
  loadPartnerQuizSessionByGroup,
  loadPartnerQuizAnswers,
} from '@/lib/db/queries/partnerQuiz'
import {
  derivePartnerQuizStatus,
  isPartnerQuizQuestionKey,
} from '@/lib/partnerQuiz'
import { getEpochMembers, resolveViewerEpochContext } from '@/lib/db/queries/epoch'
import {
  parseYearMonth,
  currentYearMonthInTaipei,
  isAfter,
  isMonthInChapter,
  nextMonth,
  resolveReviewPayerName,
  toClientReviewSnapshot,
} from '@/lib/monthlyReview'
import { getTranslations } from '@/lib/i18n/t'
import { ReviewClient } from './_components/ReviewClient'

interface PageProps {
  params: Promise<{ month: string }>
}

export default async function MonthlyReviewPage({ params }: PageProps) {
  const { month: monthParam } = await params
  const reviewedMonth = parseYearMonth(monthParam)
  if (!reviewedMonth) notFound()

  const user = await getCurrentUser()
  if (!user) redirect('/sign-in')

  // Future month → 404 (spec: 「直接訪問 /review/未來月：404」).
  const today = currentYearMonthInTaipei()
  if (isAfter(reviewedMonth, today)) notFound()

  // Pin-aware so /review/[month] reflects the pinned chapter's group when the
  // viewer is browsing a past epoch (possibly cross-group, see #141). The
  // month review is intrinsically tied to a group's chapter, not the viewer's
  // current active group.
  const context = await resolveViewerEpochContext(user.id)
  if (!context) redirect('/onboarding')
  const { group } = context

  // Reviews follow the chapter (#1380): a month outside the viewed chapter's
  // window is not this chapter's to show — including its messages, which are
  // group-scoped too. A month straddling a chapter boundary belongs to neither
  // side (lib/monthlyReview.ts › isMonthInChapter).
  if (!isMonthInChapter(reviewedMonth, context.window)) notFound()

  // Members of the chapter being viewed, not of the group today (#1384). The
  // group row no longer names a partner who left; the epoch row does. Reading
  // the group row showed the stayer the NEXT partner as the other half of an
  // old chapter.
  //
  // #1612 — a partner who left (or was removed) reaches this page for a
  // closed chapter they were in (resolveViewerEpochContext's former-member
  // view). The chapter row, not the group row, names the two people.
  const chapter = context.window.epochId ? await getEpochMembers(context.window.epochId) : null
  const memberA = chapter ? chapter.memberAId : group.memberA
  const memberB = chapter ? chapter.memberBId : group.memberB
  const memberIds = [memberA, memberB].filter((x): x is string => !!x)
  // Not one of this chapter's two people → not theirs to see. Unreachable
  // through resolveViewerEpochContext; kept so the page never relies on a
  // caller for its own access rule.
  if (!memberIds.includes(user.id)) notFound()

  // A closed chapter is read-only (epoch-readonly): no next-month editor, and
  // no partner quiz — the quiz session is the group's live one, which after a
  // leave belongs to a different pair.
  const readOnly = context.window.isPast

  // #1612 — in a closed chapter the other person is shown from the chapter
  // row alone (below), so only the viewer's own profile is read: the other
  // person's live name and photo are never loaded.
  const profileIds = readOnly ? [user.id] : memberIds
  const profileRows = await db
    .select({
      id: profiles.id,
      displayName: profiles.displayName,
      // #1328 — mask at the query so a hidden avatar can never leak into the
      // returned row, for either member.
      avatarUrl: sql<string | null>`CASE WHEN ${profiles.avatarHidden} THEN NULL ELSE ${profiles.avatarUrl} END`,
    })
    .from(profiles)
    .where(inArray(profiles.id, profileIds))

  const viewerProfile = profileRows.find((p) => p.id === user.id)
  // 404, never /sign-in: the viewer is signed in, and /sign-in would bounce
  // them back to /dashboard in a loop (#1603).
  if (!viewerProfile) notFound()
  const otherMemberId = memberIds.find((id) => id !== user.id) ?? null
  // #1604 part 2 — in a closed chapter the other person is shown as they were
  // when it closed: the name getEpochMembers returns (the snapshot) and no
  // avatar (after-leaving spec,「人：停在當時」). Never the live profile, whose
  // name and photo may be from long after the chapter ended. #1612 — with no
  // snapshot, the neutral 「對方」 stands in. The open chapter keeps the live
  // profile.
  const neutralPartner = readOnly ? (await getTranslations()).common.partner : ''
  const chapterPartnerName = readOnly && chapter
    ? (chapter.memberAId === user.id ? chapter.memberBName : chapter.memberAName)
    : null
  const partnerProfile = !otherMemberId
    ? null
    : readOnly
      ? { id: otherMemberId, displayName: chapterPartnerName ?? neutralPartner, avatarUrl: null }
      : (profileRows.find((p) => p.id === otherMemberId) ?? null)
  const isSolo = !memberB

  const editorMonth = nextMonth(reviewedMonth)

  // #1684 #1685 — messages are group-scoped rows that outlive a leave
  // (#1611). Only the viewed chapter's two people's, written while it was
  // open, belong here: the window keeps the stayer's words to a previous
  // partner off a new partner's page (the month can lie wholly inside the new
  // chapter while the message to it was written in the old one).
  const chapterScope = { memberIds, window: context.window }
  const [snapshot, pastMessages, editorMessages, quizSession] = await Promise.all([
    loadMonthlyReviewSnapshot(group.id, reviewedMonth.year, reviewedMonth.month),
    loadChapterReviewMessages(group.id, reviewedMonth, chapterScope),
    // #1612 — read-only has no next-month editor, so the next month's
    // messages are neither read nor sent. They were written in that month,
    // which may lie after the chapter closed (the stayer's, or a new
    // partner's, words to each other).
    readOnly
      ? Promise.resolve([] as Awaited<ReturnType<typeof loadChapterReviewMessages>>)
      : loadChapterReviewMessages(group.id, editorMonth, chapterScope),
    isSolo || readOnly ? Promise.resolve(null) : loadPartnerQuizSessionByGroup(group.id),
  ])

  // Quiz state — only resolved for dyad groups. Spec: solo mode 不渲染整段
  // quiz；surface 條件「第一次有 MonthlyReviewSnapshot row 後」由 snapshot 存在判定。
  const quizAnswers = quizSession ? await loadPartnerQuizAnswers(quizSession.id) : []
  const selfAnswered = quizSession
    ? quizAnswers.some((a) => a.memberId === user.id)
    : false
  const partnerAnswered = quizSession && partnerProfile
    ? quizAnswers.some((a) => a.memberId === partnerProfile.id)
    : false
  const quizStatus = !isSolo && !readOnly && snapshot
    ? derivePartnerQuizStatus({
        hasSession: !!quizSession,
        selfAnswered,
        partnerAnswered,
        revealedAt: quizSession?.revealedAt ?? null,
      })
    : null
  const quizRevealPreview = quizSession && quizStatus === 'revealed'
    ? quizSession.questionKeys.filter(isPartnerQuizQuestionKey)
    : []

  // #1618 — card 2's payer: the snapshot stores an id; the name comes only from
  // this chapter's two people (lib/monthlyReview.ts › resolveReviewPayerName),
  // and the id itself never reaches the client.
  // #1612 — a closed chapter with no snapshot for the payer: the viewer is
  // themselves, the other person is the neutral 「對方」 (never a live name).
  const payerId = snapshot?.largestExpensePaidBy ?? null
  const payerName = snapshot
    ? (resolveReviewPayerName(payerId, chapter, profileRows)
        ?? (readOnly && payerId && memberIds.includes(payerId)
          ? (payerId === user.id ? viewerProfile.displayName : neutralPartner)
          : null))
    : null

  // Snapshot may be missing for the current (still-in-progress) month or for
  // any month that pre-dates the group. Spec: render a friendly "not ready"
  // surface rather than 404, so the editor for next month still works.
  const ownEditorMessage = editorMessages.find((m) => m.memberId === user.id) ?? null
  const partnerEditorMessage = partnerProfile
    ? editorMessages.find((m) => m.memberId !== user.id) ?? null
    : null

  return (
    <ReviewClient
      reviewedMonth={reviewedMonth}
      editorMonth={editorMonth}
      snapshot={snapshot ? toClientReviewSnapshot(snapshot) : null}
      payerName={payerName}
      pastMessages={pastMessages.map((m) => ({
        id: m.id,
        memberId: m.memberId,
        body: m.body,
      }))}
      ownEditorMessage={ownEditorMessage ? {
        id: ownEditorMessage.id,
        body: ownEditorMessage.body,
        lockedAt: ownEditorMessage.lockedAt?.toISOString() ?? null,
      } : null}
      partnerEditorMessage={partnerEditorMessage ? {
        id: partnerEditorMessage.id,
        body: partnerEditorMessage.body,
      } : null}
      viewer={{
        id: viewerProfile.id,
        displayName: viewerProfile.displayName,
        avatarUrl: viewerProfile.avatarUrl,
      }}
      partner={partnerProfile ? {
        id: partnerProfile.id,
        displayName: partnerProfile.displayName,
        avatarUrl: partnerProfile.avatarUrl,
      } : null}
      isSolo={isSolo}
      readOnly={readOnly}
      quiz={quizStatus ? {
        status: quizStatus,
        partnerName: partnerProfile?.displayName ?? '',
        revealPreview: quizRevealPreview,
      } : null}
    />
  )
}
