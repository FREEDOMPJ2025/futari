import { notFound, redirect } from 'next/navigation'
import { requireViewerOrRedirect } from '@/lib/auth/viewer'
import { resolveViewedPair, resolveViewerEpochContext } from '@/lib/db/queries/epoch'
import { getOutingInChapter, loadOutingDetailRows } from '@/lib/db/queries/outing'
import { buildOutingView } from '@/lib/outing/view'
import { isUuid } from '@/lib/outing/validate'
import { foldPreviewFor, memberPidsOf } from '@/lib/outing/foldback'
import { adminChapterRefusal, currentEpochId, endChapterRefusal, resolveActor } from '@/lib/outing/access'
import { db } from '@/lib/db/client'
import { participantClaim } from '../_components/participantClaim'
import { OutingDetailClient } from './_components/OutingDetailClient'

export default async function OutingDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  // A malformed id would fail the uuid cast in Postgres and 500; it is simply not an outing.
  if (!isUuid(id)) notFound()
  const { user } = await requireViewerOrRedirect()

  // #1682 — an outing is readable only inside the chapter being viewed: the
  // open chapter, or a pinned one (same rule as trips, #1614). The chapter
  // check is the first outing query; a different chapter's outing is not
  // found, and none of its participants, expenses or settlements is loaded.
  const context = await resolveViewerEpochContext(user.id)
  if (!context) redirect('/onboarding')
  const { group, window: epochWindow } = context
  if (!epochWindow.epochId) notFound()
  const outing = await getOutingInChapter(id, group.id, epochWindow.epochId)
  if (!outing) notFound()
  const detail = { outing, ...(await loadOutingDetailRows(outing.id)) }

  // The chapter's two people frame "member" vs friend: a past chapter's from
  // its GroupEpochs row (getEpochMembers via resolveViewedPair), never today's
  // group row, which after a leave names the stayer and the next partner.
  const pair = await resolveViewedPair(context, user.id)

  // Same null-guarded resolver the end action uses: a solo group's missing
  // member must not resolve to an unbound friend.
  const { a: memberAParticipantId, b: memberBParticipantId } = memberPidsOf(detail.participants, pair.memberA, pair.memberB)

  const view = buildOutingView({
    participants: detail.participants.map((p) => ({ id: p.id, displayName: p.displayName, profileId: p.profileId })),
    expenses: detail.expenses.map((e) => ({ paidByParticipantId: e.paidByParticipantId, amount: e.amount, shares: e.shares })),
    settlements: detail.settlements.map((s) => ({ fromParticipantId: s.fromParticipantId, toParticipantId: s.toParticipantId, amount: s.amount })),
    memberAParticipantId,
    memberBParticipantId,
    // The line this outing already folded into the ledger stays out of the list (#1635).
    foldedLine: detail.outing.foldFromParticipantId && detail.outing.foldToParticipantId
      ? { from: detail.outing.foldFromParticipantId, to: detail.outing.foldToParticipantId }
      : null,
  })

  // Same in-request check the end action makes: only an active outing in the
  // current chapter folds, so only then is there anything to preview.
  const currentEpoch = await currentEpochId(db, group.id)
  const foldPreview = foldPreviewFor(detail.outing, currentEpoch, view.coupleNet)

  // #1698 — which controls the page offers, from the rule the actions refuse
  // with (lockForAdmin; content writes refuse the same chapter states). A
  // closed chapter or a pinned viewer gets END only, where END is allowed; a
  // former member looking back is no member here and gets none. The claim
  // cookie is irrelevant: only a member administers.
  const actor = await resolveActor(db, outing, { userId: user.id, claimToken: null }, { lockGroup: false })
  const member = actor?.kind === 'member' ? actor : null
  const canManage = member !== null && adminChapterRefusal(member, outing, currentEpoch) === null
  const canEnd = member !== null && endChapterRefusal(member, outing) === null

  return (
    <OutingDetailClient
      outing={{
        id: detail.outing.id,
        name: detail.outing.name,
        currency: detail.outing.currency,
        status: detail.outing.status,
      }}
      // Profile ids stay on the server: a friend's bound account is not the
      // viewer's to see, and nothing on the page needs it.
      view={{ ...view, participants: view.participants.map((p) => ({ id: p.id, displayName: p.displayName, net: p.net })) }}
      foldPreview={foldPreview}
      canManage={canManage}
      canEnd={canEnd}
      expenses={detail.expenses}
      participants={detail.participants.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        active: p.deactivatedAt === null,
        ...participantClaim(p),
        isMember: p.profileId !== null && (p.profileId === pair.memberA || p.profileId === pair.memberB),
      }))}
      settlements={[...detail.settlements].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((s) => ({
        id: s.id,
        fromParticipantId: s.fromParticipantId,
        toParticipantId: s.toParticipantId,
        amount: s.amount,
      }))}
    />
  )
}
