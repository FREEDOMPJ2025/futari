// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'

// #1700 — /assets/<non-uuid> is a 404, not a 500 from a failed uuid cast.
// getAssetById is the real query; the db throws what Postgres throws for a
// malformed uuid, so a query that still runs turns the page into a 500.
const select = vi.fn(() => {
  throw new Error('invalid input syntax for type uuid: "not-a-uuid"')
})
vi.mock('@/lib/db/client', () => ({ db: { select } }))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))
vi.mock('@/lib/supabase/server', () => ({ getCurrentUser: async () => ({ id: 'user-a' }) }))
vi.mock('@/lib/db/queries/epoch', () => ({
  resolveViewerEpochContext: async () => ({
    group: { id: 'g1', memberA: 'user-a', memberB: 'user-b', guardianBetaEnabled: true },
    window: { startedAt: new Date('2026-01-01T00:00:00Z'), endedAt: null, epochId: 'e1', isPast: false },
  }),
}))

const { default: AssetDetailPage } = await import('@/app/(dashboard)/assets/[id]/page')

describe('/assets/[id] with a malformed id', () => {
  it.each(['not-a-uuid', '123', "x'; select 1; --"])('%s → notFound, no query', async (id) => {
    await expect(AssetDetailPage({ params: Promise.resolve({ id }) })).rejects.toThrow('NEXT_NOT_FOUND')
    expect(select).not.toHaveBeenCalled()
  })
})
