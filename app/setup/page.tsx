// 建立帳本 / 邀請對方。動線與文案立場見
// docs/superpowers/specs/onboarding-design.md；邀請連結被既有 group 使用者
// 點開時的分流見 invite-existing-group-design.md。
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/supabase/server'
import { db } from '@/lib/db/client'
import { oikosGroups } from '@/lib/db/schema'
import { eq, or } from 'drizzle-orm'
import { getTranslations } from '@/lib/i18n/t'
import { hasClosedChapterForViewer } from '@/lib/db/queries/epoch'
import { INTENT_EXISTING_USER_DESTINATION, parseOnboardingIntent } from '@/lib/onboarding/intent'
import SetupForm from './SetupForm'
import { PastTimesEntryLink } from '@/app/onboarding/PastTimesEntryLink'

export default async function SetupPage({
  searchParams,
}: {
  searchParams?: Promise<{ intent?: string | string[] }>
}) {
  const user = await getCurrentUser()
  if (!user) redirect('/sign-in')
  const intent = parseOnboardingIntent((await searchParams)?.intent)

  const [group] = await db
    .select()
    .from(oikosGroups)
    .where(or(eq(oikosGroups.memberA, user.id), eq(oikosGroups.memberB, user.id)))
    .limit(1)

  if (group) redirect(intent ? INTENT_EXISTING_USER_DESTINATION[intent] : '/dashboard')

  // #1612 — /onboarding forwards anyone who has seen the cards straight here
  // (PhilosophyCards' localStorage check), so a removed partner with no
  // ledger meets the way back to their past chapters on this page too.
  const [t, hasPastChapter] = await Promise.all([
    getTranslations(),
    hasClosedChapterForViewer(user.id),
  ])
  return (
    <>
      {hasPastChapter && <PastTimesEntryLink label={t.pastTimes.title} corner="right" />}
      <SetupForm t={t} intent={intent} />
    </>
  )
}
