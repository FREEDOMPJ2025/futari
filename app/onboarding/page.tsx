// 這頁是 sign-in 之後、建立帳本之前的哲學卡片。整條 onboarding 動線
// （sign-in → 建群組 → 邀請對方／稍後再說）見
// docs/superpowers/specs/onboarding-design.md。
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/supabase/server'
import { db } from '@/lib/db/client'
import { oikosGroups } from '@/lib/db/schema'
import { eq, or } from 'drizzle-orm'
import { getTranslations } from '@/lib/i18n/t'
import { hasClosedChapterForViewer } from '@/lib/db/queries/epoch'
import { INTENT_EXISTING_USER_DESTINATION, intentQuery, parseOnboardingIntent } from '@/lib/onboarding/intent'
import PhilosophyCards from './PhilosophyCards'
import { PastTimesEntryLink } from './PastTimesEntryLink'

// Auth-walled, transient flow — keep crawlers out (#391). robots.ts also
// disallows /onboarding so the signal is consistent even if redirects misfire.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams?: Promise<{ intent?: string | string[] }>
}) {
  const user = await getCurrentUser()
  if (!user) redirect('/sign-in')
  // #1726 — closed-set intent from the /features/outing CTA; see lib/onboarding/intent.ts.
  const intent = parseOnboardingIntent((await searchParams)?.intent)

  const [group] = await db
    .select()
    .from(oikosGroups)
    .where(or(eq(oikosGroups.memberA, user.id), eq(oikosGroups.memberB, user.id)))
    .limit(1)

  if (group) redirect(intent ? INTENT_EXISTING_USER_DESTINATION[intent] : '/dashboard')

  // Someone who came to split a trip goes straight to naming the ledger: the
  // philosophy cards are about the two of you, and five of them stand between
  // this visitor and the thing they asked for. Other entries keep the cards.
  if (intent) redirect(`/setup${intentQuery(intent)}`)

  // Outside the (dashboard) layout, so there is no TranslationsProvider here —
  // hand the cards their copy directly, the same way /setup does (#1163).
  const [t, hasPastChapter] = await Promise.all([
    getTranslations(),
    // #1612 — a removed partner with no ledger can still look back at the
    // chapters they were in.
    hasClosedChapterForViewer(user.id),
  ])
  return (
    <>
      {hasPastChapter && <PastTimesEntryLink label={t.pastTimes.title} corner="left" />}
      <PhilosophyCards copy={t.onboarding} />
    </>
  )
}
