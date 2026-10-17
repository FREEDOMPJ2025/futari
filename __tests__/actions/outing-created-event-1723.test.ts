import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { loadEnvLocal, seedGroup, deleteSeededAuthUsers } from '../outing/_setup'

// ─── #1723 — `outing_created` is sent from createOuting, keyed on the user id ──
//
// Server-side on purpose: `signed_up` and `setup_completed` are server events
// keyed on the auth user id, and client events are anonymous per page load
// (persistence 'memory', no identify). Only a server event joins that chain.
// Integration test against the dev database, like the rest of
// __tests__/actions/** (excluded from CI by vitest.config.ci.ts).
// ──────────────────────────────────────────────────────────────────────────────

loadEnvLocal()
vi.setConfig({ testTimeout: 60_000 })

let mockUserId = ''
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: mockUserId } }, error: null }) },
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}))

const captured: Array<{ distinctId: string; event: string; props?: Record<string, unknown> }> = []
vi.mock('@/lib/analytics/server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/analytics/server')>('@/lib/analytics/server')
  return {
    ...actual,
    captureServer: async (distinctId: string, event: string, props?: Record<string, unknown>) => {
      captured.push({ distinctId, event, props })
    },
  }
})

const { db } = await import('@/lib/db/client')
const { outings, outingParticipants } = await import('@/lib/db/schema')
const { inArray, sql } = await import('drizzle-orm')
const { createOuting } = await import('@/actions/outing')

const seededGroups = new Set<string>()
beforeEach(() => { captured.length = 0 })

// Its own hook so a failing purge below cannot leave the auth rows behind.
afterAll(async () => { await deleteSeededAuthUsers() })

afterAll(async () => {
  const ids = [...seededGroups]
  if (ids.length === 0) return
  await db.transaction(async (tx) => {
    await tx.delete(outingParticipants).where(sql`${outingParticipants.outingId} IN (SELECT id FROM "Outings" WHERE group_id IN ${ids})`)
    await tx.delete(outings).where(inArray(outings.groupId, ids))
  })
})

describe('outing_created', () => {
  it('is captured once, for the creating user, with no properties', async () => {
    const seed = await seedGroup()
    seededGroups.add(seed.groupId)
    mockUserId = seed.userId
    const name = `九份兩日-${seed.groupId.slice(0, 8)}`

    const r = await createOuting({ name })
    if (!r.ok) throw new Error(`expected ok, got ${r.code}`)

    const events = captured.filter((c) => c.event === 'outing_created')
    expect(events).toHaveLength(1)
    expect(events[0].distinctId).toBe(seed.userId)
    expect(events[0].props).toBeUndefined()
    // Nothing identifying the outing anywhere in what was captured.
    const all = JSON.stringify(captured)
    expect(all).not.toContain(r.data.id)
    expect(all).not.toContain(name)
  })

  it('is not captured when the create is refused', async () => {
    const seed = await seedGroup()
    seededGroups.add(seed.groupId)
    mockUserId = seed.userId

    const r = await createOuting({ name: '   ' })
    expect(r.ok).toBe(false)
    expect(captured.filter((c) => c.event === 'outing_created')).toHaveLength(0)
  })
})
