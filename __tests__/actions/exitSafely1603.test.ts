import { describe, it, expect, vi, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { seedAuthUsers, deleteAuthUsers } from './_authUser'

// ─── #1603: a former member's stale pin no longer locks them out — dev DB ───
//
// The pin rule (resolveViewerEpochContext) and the past-times list
// (listEpochsForViewer) against real SQL. A pin counts if the viewer is named
// on the chapter, its group exists, and the viewer is still member_a /
// member_b of it OR the chapter is closed (#1612: a former member's
// read-only look-back, flagged `isFormerMemberView`); the list shows exactly
// the chapters that pass that rule.
//
// Failure #1603 guarded: a leaver's pin was accepted, the dashboard layout
// found them missing from the group's members and redirected to /sign-in,
// which sent a signed-in user straight back to /dashboard — a loop with no way
// out. Since #1612 the layout renders the former member's view from their own
// profile and the chapter row (__tests__/former-member-lookback-1612.test.ts).
// Integration test: excluded from CI with the rest of __tests__/actions/**.
// ────────────────────────────────────────────────────────────────────────────

function loadEnvLocal() {
  const envPath = resolve(__dirname, '../../.env.local')
  if (!existsSync(envPath)) return
  for (const raw of readFileSync(envPath, 'utf-8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnvLocal()
// Each test seeds over the network (incl. an auth.users row, #1710); the default
// 5 s is too tight against dev.
vi.setConfig({ testTimeout: 60_000 })

let pin: string | undefined
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (k: string) => (k === 'futari_past_epoch' && pin ? { value: pin } : undefined),
    getAll: () => [], has: () => false, set: () => {}, delete: () => {},
  }),
  headers: async () => new Headers(),
}))

const { db } = await import('@/lib/db/client')
const { profiles, oikosGroups, groupEpochs, groupBalance } = await import('@/lib/db/schema')
const { eq, inArray } = await import('drizzle-orm')
const { resolveViewerEpochContext, listEpochsForViewer, PAST_EPOCH_COOKIE } = await import('@/lib/db/queries/epoch')

const D = (iso: string) => new Date(`${iso}T00:00:00Z`)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  pin = undefined
  // Reverse order: groups (seeded after their profiles) go before profiles.
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function seedGroup(memberA: string, memberB: string | null, epochs: {
  a: string; b: string | null; from: string; to: string | null
}[]) {
  const [g] = await db.insert(oikosGroups).values({
    name: 'TEST_1603', memberA, memberB, currentEpochStartedAt: D(epochs[epochs.length - 1].from), baseCurrency: 'twd',
  }).returning()
  await db.insert(groupBalance).values({ groupId: g.id, balance: 0 })
  const rows = await db.insert(groupEpochs).values(epochs.map((e) => ({
    groupId: g.id, memberAId: e.a, memberBId: e.b, startedAt: D(e.from), endedAt: e.to ? D(e.to) : null,
  }))).returning({ id: groupEpochs.id })
  cleanups.push(async () => {
    await db.delete(groupEpochs).where(eq(groupEpochs.groupId, g.id))
    await db.delete(groupBalance).where(eq(groupBalance.groupId, g.id))
    await db.delete(oikosGroups).where(eq(oikosGroups.id, g.id))
  })
  return { groupId: g.id, epochIds: rows.map((r) => r.id) }
}

async function seedProfiles(n: number) {
  const ids = Array.from({ length: n }, () => randomUUID())
  const people = ids.map((id, i) => ({ id, displayName: `TEST_1603_${i}` }))
  await db.insert(profiles).values(people)
  await seedAuthUsers(people)
  cleanups.push(async () => {
    await deleteAuthUsers(ids)
    await db.delete(profiles).where(inArray(profiles.id, ids))
  })
  return ids
}

/**
 * B started X solo (chapter 0), A joined (chapter 1), B left: X is now A + C
 * (chapter 2), B has a new solo Y. The epoch rows keep naming who lived each
 * chapter; the group row names only who is there today.
 */
async function seedLeave() {
  const [a, b, c] = await seedProfiles(3)
  const x = await seedGroup(a, c, [
    { a: b, b: null, from: '2025-01-01', to: '2025-03-01' }, // B's solo chapter 0 on X
    { a: b, b: a, from: '2025-03-01', to: '2025-06-01' },    // A + B
    { a, b: c, from: '2025-06-01', to: null },               // A + C, open
  ])
  const y = await seedGroup(b, null, [{ a: b, b: null, from: '2025-06-01', to: null }])
  return { a, b, c, x, y }
}

describe('pin acceptance (#1603)', () => {
  it('#1612 — a leaver pinned to a closed chapter of the ledger they left gets that chapter, read-only', async () => {
    const s = await seedLeave()
    pin = s.x.epochIds[1]
    const ctx = await resolveViewerEpochContext(s.b)
    expect(ctx!.group.id).toBe(s.x.groupId)
    expect(ctx!.window).toMatchObject({ epochId: s.x.epochIds[1], isPast: true })
    expect(ctx!.isFormerMemberView).toBe(true)
  })

  it("a leaver pinned to the left ledger's OPEN chapter (not theirs) resolves to their own ledger", async () => {
    const s = await seedLeave()
    pin = s.x.epochIds[2]
    const ctx = await resolveViewerEpochContext(s.b)
    expect(ctx!.group.id).toBe(s.y.groupId)
    expect(ctx!.window).toMatchObject({ epochId: s.y.epochIds[0], isPast: false })
    expect(ctx!.isFormerMemberView).toBe(false)
  })

  it('#1612 — a removed person with no group gets the closed chapter; unpinned → null (/onboarding)', async () => {
    const [stayer, removed] = await seedProfiles(2)
    const z = await seedGroup(stayer, null, [
      { a: stayer, b: removed, from: '2025-01-01', to: '2025-06-01' },
      { a: stayer, b: null, from: '2025-06-01', to: null },
    ])
    pin = z.epochIds[0]
    const ctx = await resolveViewerEpochContext(removed)
    expect(ctx!.group.id).toBe(z.groupId)
    expect(ctx!.isFormerMemberView).toBe(true)
    pin = z.epochIds[1] // the stayer's solo chapter: not theirs
    expect(await resolveViewerEpochContext(removed)).toBeNull()
  })

  it('a stayer pinned to an old chapter of their current group resolves to the pin', async () => {
    const s = await seedLeave()
    pin = s.x.epochIds[1]
    const ctx = await resolveViewerEpochContext(s.a)
    expect(ctx!.group.id).toBe(s.x.groupId)
    expect(ctx!.window).toMatchObject({ epochId: s.x.epochIds[1], isPast: true })
  })

  it('a person pinned to their own old solo ledger after accepting an invite resolves to the pin', async () => {
    // acceptInvite leaves the joiner as member_a of their old solo ledger and
    // only closes its epoch (actions/invite.ts), so they are still a member.
    const [p, q] = await seedProfiles(2)
    const solo = await seedGroup(p, null, [{ a: p, b: null, from: '2025-01-01', to: '2025-06-01' }])
    await seedGroup(q, p, [{ a: q, b: p, from: '2025-06-01', to: null }])
    pin = solo.epochIds[0]
    const ctx = await resolveViewerEpochContext(p)
    expect(ctx!.group.id).toBe(solo.groupId)
    expect(ctx!.window).toMatchObject({ epochId: solo.epochIds[0], isPast: true })
  })

  it('the cookie name the test drives is the real one', () => {
    expect(PAST_EPOCH_COOKIE).toBe('futari_past_epoch')
  })
})

describe('past-times list (#1603)', () => {
  it("#1612 — a leaver sees their new ledger's chapter plus the closed chapters they lived on the left ledger, never its open one", async () => {
    const s = await seedLeave()
    const ids = (await listEpochsForViewer(s.b)).map((r) => r.id)
    expect(ids).toEqual([s.y.epochIds[0], s.x.epochIds[1], s.x.epochIds[0]])
    expect(ids).not.toContain(s.x.epochIds[2])
  })

  it("the stayer's list is unchanged: every chapter of X they lived, newest first", async () => {
    const s = await seedLeave()
    const rows = await listEpochsForViewer(s.a)
    expect(rows.map((r) => r.id)).toEqual([s.x.epochIds[2], s.x.epochIds[1]])
    expect(rows[1]).toMatchObject({ groupId: s.x.groupId, memberAName: 'TEST_1603_1', memberBName: 'TEST_1603_0' })
  })

  it('an invite acceptor still sees the solo chapter on the ledger they kept', async () => {
    const [p, q] = await seedProfiles(2)
    const solo = await seedGroup(p, null, [{ a: p, b: null, from: '2025-01-01', to: '2025-06-01' }])
    const duo = await seedGroup(q, p, [{ a: q, b: p, from: '2025-06-01', to: null }])
    const ids = (await listEpochsForViewer(p)).map((r) => r.id)
    expect(ids).toEqual([duo.epochIds[0], solo.epochIds[0]])
  })

  it('every listed chapter opens when tapped (resolver accepts each pin)', async () => {
    const s = await seedLeave()
    for (const viewer of [s.a, s.b, s.c]) {
      for (const row of await listEpochsForViewer(viewer)) {
        pin = row.id
        const ctx = await resolveViewerEpochContext(viewer)
        expect(ctx!.window.epochId).toBe(row.id)
      }
    }
  })
})
