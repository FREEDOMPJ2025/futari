import { redirect } from 'next/navigation'
import { requireViewerOrRedirect } from '@/lib/auth/viewer'
import { resolveViewerEpochContext } from '@/lib/db/queries/epoch'
import { listAllTrips } from '@/lib/db/queries/trips'
import { TripList } from './_components/TripList'

export default async function TripsPage() {
  const { user } = await requireViewerOrRedirect()

  // #1614 — the list follows the chapter being viewed (pin included), the
  // same chapter /trips/[id] will open. No chapter → nothing to list.
  const context = await resolveViewerEpochContext(user.id)
  if (!context) redirect('/onboarding')
  const { group, window: epochWindow } = context

  const trips = epochWindow.epochId ? await listAllTrips(group.id, epochWindow.epochId) : []
  return <TripList trips={trips} baseCurrency={group.baseCurrency} />
}
