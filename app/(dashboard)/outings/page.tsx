import { redirect } from 'next/navigation'
import { requireViewerOrRedirect } from '@/lib/auth/viewer'
import { resolveViewerEpochContext } from '@/lib/db/queries/epoch'
import { listOutings } from '@/lib/db/queries/outing'
import { listParticipatingOutings } from '@/lib/db/queries/outingPublic'
import { getLocale } from '@/lib/i18n/t'
import { OutingList } from './_components/OutingList'

export default async function OutingsPage() {
  const { user } = await requireViewerOrRedirect()

  // #1682 — the list follows the chapter being viewed (pin included), the
  // same chapter /outings/[id] will open (as /trips does, #1614). No chapter
  // → nothing to list.
  const context = await resolveViewerEpochContext(user.id)
  if (!context) redirect('/onboarding')
  const { group, window: epochWindow } = context

  const [outings, participating, locale] = await Promise.all([
    epochWindow.epochId ? listOutings(group.id, epochWindow.epochId) : Promise.resolve([]),
    // 我參與的出遊 (#1558): other ledgers' outings this account is bound to.
    // The query already leaves out every outing of a ledger the user is a
    // member of, so nothing here repeats the list above.
    listParticipatingOutings(user.id),
    getLocale(),
  ])
  return (
    <OutingList
      outings={outings}
      participating={participating.map((o) => ({
        id: o.id,
        name: o.name,
        ended: o.status !== 'active',
        href: `/${locale}/outing/r/${o.id}`,
      }))}
    />
  )
}
