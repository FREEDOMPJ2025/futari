import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireViewerOrRedirect } from '@/lib/auth/viewer'
import { getActiveGroupForUser } from '@/lib/db/queries/group'
import { listEpochsForViewer, PAST_EPOCH_COOKIE } from '@/lib/db/queries/epoch'
import { cookies } from 'next/headers'
import { getLocale, getTranslations } from '@/lib/i18n/t'
import { PastTimesList } from '@/app/(dashboard)/settings/past-times/_components/PastTimesList'

// Auth-walled, like the rest of /onboarding (#391): keep crawlers out.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

/**
 * #1612 — 過去的時光 for a signed-in person with no ledger of their own (a
 * removed partner). Lives outside the (dashboard) layout on purpose: that
 * layout needs a resolved chapter or ledger and sends everyone else to
 * /onboarding, which is exactly where this person already is.
 *
 * Same rows as /settings/past-times (`listEpochsForViewer`: chapters a pin
 * can open — for this person, the closed chapters of the ledger they were
 * removed from). Tapping a row pins it (`enterPastEpoch`) and opens
 * /dashboard, where the layout renders the former-member look-back; the
 * PastChapterBar's exit brings them back here via /dashboard → /onboarding.
 *
 * Someone who does have a ledger uses the in-app page instead.
 */
export default async function StandalonePastTimesPage() {
  const { user } = await requireViewerOrRedirect()

  if (await getActiveGroupForUser(user.id)) redirect('/settings/past-times')

  const [epochs, jar, locale, t] = await Promise.all([
    listEpochsForViewer(user.id),
    cookies(),
    getLocale(),
    getTranslations(),
  ])
  const pinnedId = jar.get(PAST_EPOCH_COOKIE)?.value ?? null

  return (
    <main className="mx-auto min-h-dvh max-w-md bg-bg pb-10">
      <PastTimesList
        epochs={epochs.map((e) => ({
          id: e.id,
          startedAt: e.startedAt.toISOString(),
          endedAt: e.endedAt?.toISOString() ?? null,
          memberAName: e.memberAName,
          memberBName: e.memberBName,
          memberAId: e.memberAId,
          memberBId: e.memberBId,
        }))}
        pinnedEpochId={pinnedId}
        viewerId={user.id}
        locale={locale}
        t={t.pastTimes}
        backLabel={t.pastTimes.back}
        neutralPartnerLabel={t.common.partner}
        backHref="/onboarding"
      />
    </main>
  )
}
