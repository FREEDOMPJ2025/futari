// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ReactElement } from 'react'
import { loadEnvLocal } from './outing/_setup'

// ─── Integration: an outing belongs to its own chapter (#1682) ───────────────
//
// /outings/[id] and /outings serve the chapter being viewed — the open
// chapter, or a pinned chapter the viewer is named on (resolveViewerEpochContext,
// as #1614 does for trips) — and nothing else. The admin tier ("member") is a
// current ledger member who is ALSO named on the outing's own chapter row; a
// later partner is nobody there, so the public /outing/r and /outing/<token>
// routes no longer hand them the dashboard page. Admin actions refuse a
// closed-chapter outing, except ending it, which a member of that chapter can
// do unpinned or pinned to exactly that chapter (owner decision D2(a)).
//
//   group G (today: member_a S, member_b C)
//   Esolo  S solo   2026-01 → 2026-02   outing OSolo (ACTIVE, S's slot)
//   E0     S + C    2026-02 → 2026-03   outing O0 (ended)
//   E1     S + X    2026-03 → 2026-04   outing O1 (active; S, X, friend F bound; X paid)
//   E2     S + C    2026-04 → open      outing O2 (active)
//   group H (member_a Y)  open chapter EH, outing OH
//
// What it looks like when this regresses: nothing errors. The partner who
// joined later opens an earlier chapter's outing by URL (or follows its share
// link and is forwarded into the dashboard) and reads the ex's amounts and
// friends; or renames, deletes or ends it.
//
// Real Postgres (DATABASE_URL, dev); only the session, the cookie jar,
// next/navigation and next/cache are mocked.
// ──────────────────────────────────────────────────────────────────────────

loadEnvLocal()
vi.setConfig({ testTimeout: 60_000 })

let viewerId = ''
vi.mock('@/lib/supabase/server', () => ({
  getCurrentUser: async () => (viewerId ? { id: viewerId } : null),
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: viewerId ? { id: viewerId } : null }, error: null }) },
  }),
}))

const cookieStore = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (key: string) => {
      const value = cookieStore.get(key)
      return value === undefined ? undefined : { name: key, value }
    },
    getAll: () => [...cookieStore].map(([name, value]) => ({ name, value })),
    has: (key: string) => cookieStore.has(key),
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}))

vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))

// Pass-through spies: the real queries run, the test sees whether they ran.
// `getOutingDetail` is the pre-#1682 loader (header + everything, unscoped);
// `loadOutingDetailRows` is what the page loads after the chapter check.
vi.mock('@/lib/db/queries/outing', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/db/queries/outing')>()
  return {
    ...real,
    getOutingDetail: vi.fn(real.getOutingDetail),
    loadOutingDetailRows: vi.fn(real.loadOutingDetailRows),
  }
})

const { db } = await import('@/lib/db/client')
const {
  profiles, oikosGroups, groupEpochs, groupBalance, settlements,
  outings, outingParticipants, outingExpenses, outingExpenseShares, outingSettlements,
} = await import('@/lib/db/schema')
const { PAST_EPOCH_COOKIE } = await import('@/lib/db/queries/epoch')
const outingQueries = await import('@/lib/db/queries/outing')
const { hashToken, generateToken } = await import('@/lib/outing/tokens')
const {
  endOuting, softDeleteOuting, renameOuting, getOutingShareLink, resetOutingShareLink,
  releaseOutingSlot, addOutingParticipant, deactivateOutingParticipant, addOutingExpense,
} = await import('@/actions/outing')
const { default: OutingDetailPage } = await import('@/app/(dashboard)/outings/[id]/page')
const { default: OutingsPage } = await import('@/app/(dashboard)/outings/page')
const { default: OutingResumePage } = await import('@/app/[locale]/outing/r/[outingId]/page')
const { default: OutingSharePage } = await import('@/app/[locale]/outing/[shareToken]/page')
const { eq, inArray } = await import('drizzle-orm')

const S = randomUUID()
const C = randomUUID()
const X = randomUUID()
const Y = randomUUID()
const F = randomUUID()
const people = [S, C, X, Y, F]

const w = {} as {
  g: string
  h: string
  eSolo: string
  e0: string
  e1: string
  e2: string
  eH: string
  oSolo: string
  o0: string
  o1: string
  o2: string
  oH: string
  o1SlotX: string
  o1SlotLoose: string
  o1Expense: string
  o1Share: string
}

const d = (s: string) => new Date(`${s}T00:00:00Z`)

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set; cannot run integration test. Ensure .env.local has DATABASE_URL.')
  }
  await db.insert(profiles).values([
    { id: S, displayName: 'TEST_OUTING_PAGE_S' },
    { id: C, displayName: 'TEST_OUTING_PAGE_C' },
    { id: X, displayName: 'TEST_OUTING_PAGE_X' },
    { id: Y, displayName: 'TEST_OUTING_PAGE_Y' },
    { id: F, displayName: 'TEST_OUTING_PAGE_F' },
  ])

  const [g] = await db.insert(oikosGroups).values({
    name: 'TEST_OUTING_PAGE_G', memberA: S, memberB: C, currentEpochStartedAt: d('2026-04-01'), baseCurrency: 'twd',
  }).returning({ id: oikosGroups.id })
  const [h] = await db.insert(oikosGroups).values({
    name: 'TEST_OUTING_PAGE_H', memberA: Y, currentEpochStartedAt: d('2026-01-01'), baseCurrency: 'twd',
  }).returning({ id: oikosGroups.id })
  w.g = g.id
  w.h = h.id
  await db.insert(groupBalance).values([{ groupId: w.g, balance: 0 }, { groupId: w.h, balance: 0 }])

  const epoch = async (groupId: string, from: string, to: string | null, a: string, b: string | null) => {
    const [row] = await db.insert(groupEpochs).values({
      groupId, startedAt: d(from), endedAt: to ? d(to) : null, memberAId: a, memberBId: b,
    }).returning({ id: groupEpochs.id })
    return row.id
  }
  w.eSolo = await epoch(w.g, '2026-01-01', '2026-02-01', S, null)
  w.e0 = await epoch(w.g, '2026-02-01', '2026-03-01', S, C)
  w.e1 = await epoch(w.g, '2026-03-01', '2026-04-01', S, X)
  w.e2 = await epoch(w.g, '2026-04-01', null, S, C)
  w.eH = await epoch(w.h, '2026-01-01', null, Y, null)

  const outing = async (groupId: string, epochId: string, createdBy: string, name: string, at: string, ended: boolean) => {
    const [row] = await db.insert(outings).values({
      groupId, epochId, createdBy, name, currency: 'twd',
      status: ended ? 'ended' : 'active',
      endedAt: ended ? d(at) : null,
      createdAt: d(at),
    }).returning({ id: outings.id })
    return row.id
  }
  w.oSolo = await outing(w.g, w.eSolo, S, 'Solo outing', '2026-01-10', false)
  w.o0 = await outing(w.g, w.e0, S, 'E0 outing', '2026-02-10', true)
  w.o1 = await outing(w.g, w.e1, S, 'E1 outing', '2026-03-10', false)
  w.o2 = await outing(w.g, w.e2, S, 'E2 outing', '2026-04-10', false)
  w.oH = await outing(w.h, w.eH, Y, 'Other group outing', '2026-01-10', false)

  const slot = async (outingId: string, displayName: string, profileId: string | null, claimed = false) => {
    const [row] = await db.insert(outingParticipants).values({
      outingId, displayName, profileId,
      claimTokenHash: claimed ? hashToken(generateToken()) : null,
      claimedAt: claimed || profileId ? new Date() : null,
    }).returning({ id: outingParticipants.id })
    return row.id
  }
  await slot(w.oSolo, 'S', S)
  await slot(w.o0, 'S', S)
  await slot(w.o0, 'C', C)
  const o1SlotS = await slot(w.o1, 'S', S)
  w.o1SlotX = await slot(w.o1, 'X', X)
  await slot(w.o1, 'F', F)
  w.o1SlotLoose = await slot(w.o1, 'Loose friend', null, true) // cookie-claimed, releasable
  await slot(w.o2, 'S', S)
  await slot(w.o2, 'C', C)
  await slot(w.oH, 'Y', Y)

  const [exp] = await db.insert(outingExpenses).values({
    outingId: w.o1, paidByParticipantId: w.o1SlotX, amount: 4200, description: 'X dinner', transactedAt: d('2026-03-10'),
  }).returning({ id: outingExpenses.id })
  w.o1Expense = exp.id
  await db.insert(outingExpenseShares).values([
    { expenseId: exp.id, participantId: w.o1SlotX, shareAmount: 2100 },
    { expenseId: exp.id, participantId: o1SlotS, shareAmount: 2100 },
  ])

  // A share link on the E1 outing, as a member would have created it.
  w.o1Share = generateToken()
  await db.update(outings).set({ shareTokenHash: hashToken(w.o1Share) }).where(eq(outings.id, w.o1))
})

afterAll(async () => {
  try {
    const groupIds = [w.g, w.h].filter(Boolean)
    if (!groupIds.length) return
    const outingIds = (await db.select({ id: outings.id }).from(outings).where(inArray(outings.groupId, groupIds))).map((o) => o.id)
    if (outingIds.length) {
      const expIds = (await db.select({ id: outingExpenses.id }).from(outingExpenses).where(inArray(outingExpenses.outingId, outingIds))).map((e) => e.id)
      if (expIds.length) await db.delete(outingExpenseShares).where(inArray(outingExpenseShares.expenseId, expIds))
      await db.delete(outingExpenses).where(inArray(outingExpenses.outingId, outingIds))
      await db.delete(outingSettlements).where(inArray(outingSettlements.outingId, outingIds))
      await db.delete(outingParticipants).where(inArray(outingParticipants.outingId, outingIds))
      await db.delete(outings).where(inArray(outings.id, outingIds))
    }
    await db.delete(settlements).where(inArray(settlements.groupId, groupIds))
    await db.delete(groupBalance).where(inArray(groupBalance.groupId, groupIds))
    await db.delete(groupEpochs).where(inArray(groupEpochs.groupId, groupIds))
    await db.delete(oikosGroups).where(inArray(oikosGroups.id, groupIds))
    await db.delete(profiles).where(inArray(profiles.id, people))
  } catch (e) {
    console.error('cleanup failed', e)
  }
})

beforeEach(() => {
  cookieStore.clear()
  viewerId = ''
  clearSpies()
})

function as(user: string, pin?: string) {
  viewerId = user
  cookieStore.clear()
  if (pin) cookieStore.set(PAST_EPOCH_COOKIE, pin)
}

type DetailProps = {
  outing: { id: string; status: string }
  canManage: boolean
  canEnd: boolean
  expenses: Array<{ id: string; amount: number }>
  participants: Array<{ id: string; isMember: boolean }>
}

async function openOuting(id: string) {
  const el = (await OutingDetailPage({ params: Promise.resolve({ id }) })) as ReactElement<DetailProps>
  return el.props
}

function clearSpies() {
  vi.mocked(outingQueries.getOutingDetail).mockClear()
  vi.mocked(outingQueries.loadOutingDetailRows).mockClear()
}

/** Refused with `error`, and none of the outing's participants, expenses or settlements were queried. */
async function expectRefusedWithoutData(id: string, error: string | RegExp) {
  clearSpies()
  await expect(OutingDetailPage({ params: Promise.resolve({ id }) })).rejects.toThrow(error)
  expect(outingQueries.getOutingDetail).not.toHaveBeenCalled()
  expect(outingQueries.loadOutingDetailRows).not.toHaveBeenCalled()
}

const expectNotFoundWithoutData = (id: string) => expectRefusedWithoutData(id, 'NEXT_NOT_FOUND')

async function listedOutingIds() {
  const el = (await OutingsPage({})) as ReactElement<{ outings: Array<{ id: string }> }>
  return el.props.outings.map((o) => o.id).sort()
}

async function statusOf(id: string) {
  const [row] = await db.select({ status: outings.status, name: outings.name, deletedAt: outings.deletedAt }).from(outings).where(eq(outings.id, id))
  return row
}

/** Render a public page; returns the redirect target, or null when it rendered in place. */
async function publicRedirect(render: () => Promise<unknown>): Promise<string | null> {
  try {
    await render()
    return null
  } catch (e) {
    const m = /^NEXT_REDIRECT (.+)$/.exec((e as Error).message)
    if (m) return m[1]
    throw e
  }
}

const resume = (outingId: string) => () => OutingResumePage({ params: Promise.resolve({ locale: 'zh-TW', outingId }) })
const share = (shareToken: string) => () => OutingSharePage({ params: Promise.resolve({ locale: 'zh-TW', shareToken }) })

describe('/outings/[id] — chapter scope (#1682)', () => {
  it('1. the later partner cannot open the earlier chapter\'s outing, nor the stayer\'s solo one', async () => {
    as(C)
    await expectNotFoundWithoutData(w.o1)
    await expectNotFoundWithoutData(w.oSolo)
    as(C, w.eSolo) // a pin to a chapter C is not named on is ignored
    await expectNotFoundWithoutData(w.oSolo)
    as(C, w.e1)
    await expectNotFoundWithoutData(w.o1)
  })

  it('2. the later partner opens the open chapter\'s outing', async () => {
    as(C)
    const props = await openOuting(w.o2)
    expect(props.outing.id).toBe(w.o2)
    // #1698 — the open chapter: every control.
    expect(props).toMatchObject({ canManage: true, canEnd: true })
  })

  it('3a. the stayer, unpinned, cannot open the earlier chapter\'s outing', async () => {
    as(S)
    await expectNotFoundWithoutData(w.o1)
  })

  it('3b. the stayer pinned to E1 opens O1 with the ex\'s expense, the ex framed as a member of that chapter', async () => {
    as(S, w.e1)
    const props = await openOuting(w.o1)
    expect(props.outing.id).toBe(w.o1)
    expect(props.expenses.map((e) => e.id)).toEqual([w.o1Expense])
    expect(props.participants.find((p) => p.id === w.o1SlotX)?.isMember).toBe(true)
    // #1698 — pinned to O1's own closed chapter: END only (test 11 / 13 are the refusals).
    expect(props).toMatchObject({ canManage: false, canEnd: true })
  })

  it('3c. the stayer pinned to E1 cannot open the open chapter\'s outing', async () => {
    as(S, w.e1)
    await expectNotFoundWithoutData(w.o2)
  })

  it('4. per chapter: C pinned to E0 opens O0 but still not O1', async () => {
    as(C, w.e0)
    expect((await openOuting(w.o0)).outing.id).toBe(w.o0)
    await expectNotFoundWithoutData(w.o1)
  })

  it('5. the former member X, pinned to E1, reads O1 and nothing else', async () => {
    as(X, w.e1)
    const props = await openOuting(w.o1)
    expect(props.outing.id).toBe(w.o1)
    // #1698 — looking back is no admin: no control (endOuting refuses X, test 12).
    expect(props).toMatchObject({ canManage: false, canEnd: false })
    await expectNotFoundWithoutData(w.o2)
    await expectNotFoundWithoutData(w.o0)
    as(X) // unpinned, with no ledger of their own
    await expectRefusedWithoutData(w.o1, 'NEXT_REDIRECT /onboarding')
  })

  it('6. unknown, deleted-group and other-group ids are notFound', async () => {
    as(C)
    await expectNotFoundWithoutData(randomUUID())
    await expectNotFoundWithoutData(w.oH)
    as(Y)
    await expectNotFoundWithoutData(w.o1)
  })
})

describe('/outings — the list follows the viewed chapter (#1682)', () => {
  it('7. unpinned lists the open chapter; a pin lists that chapter; a hostile pin falls back', async () => {
    as(S)
    expect(await listedOutingIds()).toEqual([w.o2])
    as(S, w.e1)
    expect(await listedOutingIds()).toEqual([w.o1])
    as(C)
    expect(await listedOutingIds()).toEqual([w.o2])
    as(C, w.e1) // C is not named on E1 → open chapter
    expect(await listedOutingIds()).toEqual([w.o2])
  })
})

describe('public routes do not forward a later partner into the dashboard (#1682)', () => {
  it('8a. /outing/r/<E1 outing>: C gets the no-access page, not a redirect', async () => {
    as(C)
    expect(await publicRedirect(resume(w.o1))).toBeNull()
    as(C)
    expect(await publicRedirect(resume(w.oSolo))).toBeNull()
  })

  it('8b. /outing/<token of the E1 outing>: C is not forwarded to /outings/<id>', async () => {
    as(C)
    expect(await publicRedirect(share(w.o1Share))).toBeNull()
  })

  it('8c. the stayer (named on E1) is still a member there; the open chapter is unchanged for C', async () => {
    as(S)
    expect(await publicRedirect(resume(w.o1))).toBe(`/outings/${w.o1}`)
    as(C)
    expect(await publicRedirect(resume(w.o2))).toBe(`/outings/${w.o2}`)
  })

  it('9. the former partner X and the bound friend F keep reading O1 as participants', async () => {
    for (const who of [X, F]) {
      as(who)
      expect(await publicRedirect(resume(w.o1))).toBeNull()
      const el = (await resume(w.o1)()) as ReactElement<{ view?: { outing?: { name?: string } } }>
      expect(el.props.view?.outing?.name).toBe('E1 outing')
      as(who)
      expect(await publicRedirect(share(w.o1Share))).toBe(`/zh-TW/outing/r/${w.o1}`)
    }
  })
})

describe('admin actions on a closed-chapter outing (#1682, D2(a))', () => {
  const closed = { ok: false, code: 'outing_epoch_closed' }

  it('10. every admin action except ending refuses O1 for the stayer, and nothing changes', async () => {
    as(S)
    expect(await renameOuting({ outingId: w.o1, name: 'renamed' })).toEqual(closed)
    expect(await getOutingShareLink({ outingId: w.o1 })).toEqual(closed)
    expect(await resetOutingShareLink({ outingId: w.o1 })).toEqual(closed)
    expect(await releaseOutingSlot({ outingId: w.o1, participantId: w.o1SlotLoose })).toEqual(closed)
    expect(await addOutingParticipant({ outingId: w.o1, displayName: 'late' })).toEqual(closed)
    expect(await deactivateOutingParticipant({ outingId: w.o1, participantId: w.o1SlotLoose })).toEqual(closed)
    expect(await softDeleteOuting({ outingId: w.o1 })).toEqual(closed)
    const row = await statusOf(w.o1)
    expect(row).toMatchObject({ status: 'active', name: 'E1 outing', deletedAt: null })
    const [link] = await db.select({ h: outings.shareTokenHash }).from(outings).where(eq(outings.id, w.o1))
    expect(link.h).toBe(hashToken(w.o1Share))
    const [loose] = await db.select().from(outingParticipants).where(eq(outingParticipants.id, w.o1SlotLoose))
    expect(loose.claimTokenHash).not.toBeNull()
    expect(loose.deactivatedAt).toBeNull()
  })

  it('11. pinned to E1, the stayer still gets outing_viewing_past_chapter for rename / delete', async () => {
    as(S, w.e1)
    expect(await renameOuting({ outingId: w.o1, name: 'renamed' })).toEqual({ ok: false, code: 'outing_viewing_past_chapter' })
    expect(await softDeleteOuting({ outingId: w.o1 })).toEqual({ ok: false, code: 'outing_viewing_past_chapter' })
  })

  it('12. the later partner is nobody on O1 / OSolo; the ex and the friend are not admins', async () => {
    as(C)
    for (const outingId of [w.o1, w.oSolo]) {
      expect(await endOuting({ outingId })).toEqual({ ok: false, code: 'outing_not_found' })
      expect(await renameOuting({ outingId, name: 'mine now' })).toEqual({ ok: false, code: 'outing_not_found' })
      expect(await softDeleteOuting({ outingId })).toEqual({ ok: false, code: 'outing_not_found' })
      expect(await getOutingShareLink({ outingId })).toEqual({ ok: false, code: 'outing_not_found' })
    }
    as(X)
    expect(await endOuting({ outingId: w.o1 })).toEqual({ ok: false, code: 'outing_admin_only' })
    as(F)
    expect(await endOuting({ outingId: w.o1 })).toEqual({ ok: false, code: 'outing_admin_only' })
    // The friend's content write gets the existing 「只能結束」 refusal.
    as(F)
    expect(await addOutingExpense({ outingId: w.o1, paidByParticipantId: w.o1SlotX, amount: 5, participantIds: [w.o1SlotX] }))
      .toEqual({ ok: false, code: 'outing_epoch_closed' })
    expect(await statusOf(w.o1)).toMatchObject({ status: 'active', deletedAt: null })
    expect(await statusOf(w.oSolo)).toMatchObject({ status: 'active', deletedAt: null })
  })

  it('13. the real route: solo owner pins Esolo → list → detail → End succeeds; another pin and the later partner are refused', async () => {
    // A different past chapter pinned: the outing is not this view's, End refused.
    as(S, w.e0)
    expect(await endOuting({ outingId: w.oSolo })).toEqual({ ok: false, code: 'outing_viewing_past_chapter' })
    // The later partner: no page, no End.
    as(C)
    await expectNotFoundWithoutData(w.oSolo)
    expect(await endOuting({ outingId: w.oSolo })).toEqual({ ok: false, code: 'outing_not_found' })
    expect((await statusOf(w.oSolo)).status).toBe('active')

    // The chapter's own member, pinned to it.
    as(S, w.eSolo)
    expect(await listedOutingIds()).toEqual([w.oSolo])
    const props = await openOuting(w.oSolo)
    expect(props.outing).toMatchObject({ id: w.oSolo, status: 'active' })
    expect(props).toMatchObject({ canManage: false, canEnd: true })
    as(S, w.eSolo)
    expect(await endOuting({ outingId: w.oSolo })).toEqual({ ok: true, data: { folded: false } })
    expect((await statusOf(w.oSolo)).status).toBe('ended')
    expect(await db.select().from(settlements).where(eq(settlements.groupId, w.g))).toHaveLength(0)
  })
})
