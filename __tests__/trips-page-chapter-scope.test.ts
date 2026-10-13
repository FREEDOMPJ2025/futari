// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactElement } from 'react'

// ─── Integration: a trip is readable only inside its own chapter (#1614) ─────
//
// /trips/[id] and /trips serve the chapter being viewed — the open chapter,
// or a pinned chapter the viewer is named on (resolveViewerEpochContext's
// rule) — and nothing else. A trip from any other chapter is notFound, and
// none of its expenses (nor the group's rates) are even queried.
//
//   group G (today: member_a S, member_b C)
//   Esolo  S solo   2026-01 → 2026-02   trip Tsolo
//   E0     S + C    2026-02 → 2026-03   trip T0      (C left, later rejoined)
//   E1     S + X    2026-03 → 2026-04   trip T1      (X left; X paid an expense)
//   E2     S + C    2026-04 → open      trip T2, deleted trip Tdel
//   group H (member_a Y)  open chapter EH, trip TH
//
// What it looks like when this regresses: nothing errors. The partner who
// joined later opens an earlier chapter's trip by URL and reads the ex's
// amounts and notes.
//
// Real Postgres (DATABASE_URL, dev); only the session, the cookie jar and
// next/navigation are mocked, so resolveViewerEpochContext runs for real.
// ──────────────────────────────────────────────────────────────────────────

function loadEnvLocal() {
  const envPath = resolve(__dirname, '../.env.local')
  if (!existsSync(envPath)) return
  const text = readFileSync(envPath, 'utf-8')
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnvLocal()

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
      return value === undefined ? undefined : { value }
    },
    getAll: () => [],
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

// Pass-through spies: the real queries run, the test sees whether they ran.
vi.mock('@/lib/db/queries/tripExpense', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/db/queries/tripExpense')>()
  return {
    ...real,
    listTripExpenses: vi.fn(real.listTripExpenses),
    countTripExpensesByCurrency: vi.fn(real.countTripExpensesByCurrency),
  }
})
vi.mock('@/lib/db/queries/currencyRates', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/db/queries/currencyRates')>()
  return { ...real, listRatesForGroup: vi.fn(real.listRatesForGroup) }
})

const { db } = await import('@/lib/db/client')
const { profiles, oikosGroups, groupEpochs, trips, tripExpenses } = await import('@/lib/db/schema')
const { PAST_EPOCH_COOKIE } = await import('@/lib/db/queries/epoch')
const tripExpenseQueries = await import('@/lib/db/queries/tripExpense')
const rateQueries = await import('@/lib/db/queries/currencyRates')
const { default: TripDetailPage } = await import('@/app/(dashboard)/trips/[id]/page')
const { default: TripsPage } = await import('@/app/(dashboard)/trips/page')
const { eq, inArray } = await import('drizzle-orm')

const S = randomUUID()
const C = randomUUID()
const X = randomUUID()
const Y = randomUUID()
const people = [S, C, X, Y]

const w = {} as {
  g: string
  h: string
  eSolo: string
  e0: string
  e1: string
  e2: string
  eH: string
  tSolo: string
  t0: string
  t1: string
  t2: string
  tDel: string
  tH: string
  xExpense: string
}

const d = (s: string) => new Date(`${s}T00:00:00Z`)

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set; cannot run integration test. Ensure .env.local has DATABASE_URL.')
  }
  await db.insert(profiles).values([
    { id: S, displayName: 'TEST_TRIP_PAGE_S' },
    { id: C, displayName: 'TEST_TRIP_PAGE_C' },
    { id: X, displayName: 'TEST_TRIP_PAGE_X' },
    { id: Y, displayName: 'TEST_TRIP_PAGE_Y' },
  ])

  const [g] = await db.insert(oikosGroups).values({
    name: 'TEST_TRIP_PAGE_G', memberA: S, memberB: C, currentEpochStartedAt: d('2026-04-01'),
  }).returning({ id: oikosGroups.id })
  const [h] = await db.insert(oikosGroups).values({
    name: 'TEST_TRIP_PAGE_H', memberA: Y, currentEpochStartedAt: d('2026-01-01'),
  }).returning({ id: oikosGroups.id })
  w.g = g.id
  w.h = h.id

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

  const trip = async (groupId: string, epochId: string, name: string, startDate: string, closed: boolean) => {
    const [row] = await db.insert(trips).values({
      groupId,
      epochId,
      name,
      startDate,
      status: closed ? 'ended' : 'active',
      endDate: closed ? startDate : null,
      endedAt: closed ? d(startDate) : null,
    }).returning({ id: trips.id })
    return row.id
  }
  w.tSolo = await trip(w.g, w.eSolo, 'Solo trip', '2026-01-10', true)
  w.t0 = await trip(w.g, w.e0, 'E0 trip', '2026-02-10', true)
  w.t1 = await trip(w.g, w.e1, 'E1 trip', '2026-03-10', true)
  w.t2 = await trip(w.g, w.e2, 'E2 trip', '2026-04-10', false)
  w.tDel = await trip(w.g, w.e2, 'Deleted trip', '2026-04-11', false)
  await db.update(trips).set({ deletedAt: new Date() }).where(eq(trips.id, w.tDel))
  w.tH = await trip(w.h, w.eH, 'Other group trip', '2026-01-10', false)

  const [xExp] = await db.insert(tripExpenses).values([
    { tripId: w.t1, paidBy: X, amount: 4200, category: 'dining', splitType: 'half', description: 'X dinner', transactedAt: d('2026-03-10') },
    { tripId: w.t1, paidBy: S, amount: 800, category: 'transit', splitType: 'half', description: 'S taxi', transactedAt: d('2026-03-11') },
  ]).returning({ id: tripExpenses.id })
  w.xExpense = xExp.id
  await db.insert(tripExpenses).values([
    { tripId: w.t0, paidBy: C, amount: 300, category: 'dining', splitType: 'half', transactedAt: d('2026-02-10') },
    { tripId: w.t2, paidBy: C, amount: 500, category: 'dining', splitType: 'half', transactedAt: d('2026-04-10') },
    { tripId: w.tSolo, paidBy: S, amount: 700, category: 'dining', splitType: 'all_mine', transactedAt: d('2026-01-10') },
  ])
})

afterAll(async () => {
  try {
    const groupIds = [w.g, w.h].filter(Boolean)
    if (groupIds.length) {
      const tripIds = (await db.select({ id: trips.id }).from(trips).where(inArray(trips.groupId, groupIds))).map((t) => t.id)
      if (tripIds.length) {
        await db.delete(tripExpenses).where(inArray(tripExpenses.tripId, tripIds))
        await db.delete(trips).where(inArray(trips.id, tripIds))
      }
      await db.delete(groupEpochs).where(inArray(groupEpochs.groupId, groupIds))
      await db.delete(oikosGroups).where(inArray(oikosGroups.id, groupIds))
    }
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

type DetailProps = { trip: { id: string }; records: Array<{ id: string; paidBy: string; amount: number }> }

async function openTrip(id: string) {
  const el = (await TripDetailPage({ params: Promise.resolve({ id }) })) as ReactElement<DetailProps>
  return el.props
}

function clearSpies() {
  vi.mocked(tripExpenseQueries.listTripExpenses).mockClear()
  vi.mocked(tripExpenseQueries.countTripExpensesByCurrency).mockClear()
  vi.mocked(rateQueries.listRatesForGroup).mockClear()
}

function expectNoDataQueried() {
  expect(tripExpenseQueries.listTripExpenses).not.toHaveBeenCalled()
  expect(tripExpenseQueries.countTripExpensesByCurrency).not.toHaveBeenCalled()
  expect(rateQueries.listRatesForGroup).not.toHaveBeenCalled()
}

/** Refused with `error`, and none of the trip's expenses nor the group's rates were queried. */
async function expectRefusedWithoutData(id: string, error: string | RegExp) {
  clearSpies()
  await expect(TripDetailPage({ params: Promise.resolve({ id }) })).rejects.toThrow(error)
  expectNoDataQueried()
}

const expectNotFoundWithoutData = (id: string) => expectRefusedWithoutData(id, 'NEXT_NOT_FOUND')

async function listedTripIds() {
  const el = (await TripsPage()) as ReactElement<{ trips: Array<{ id: string }> }>
  return el.props.trips.map((t) => t.id).sort()
}

describe('/trips/[id] — chapter scope (#1614)', () => {
  it('1. the new partner cannot open the earlier chapter\'s trip', async () => {
    as(C)
    await expectNotFoundWithoutData(w.t1)
  })

  it('2. the new partner opens the open chapter\'s trip', async () => {
    as(C)
    const props = await openTrip(w.t2)
    expect(props.trip.id).toBe(w.t2)
    expect(props.records.map((r) => r.amount)).toEqual([500])
  })

  it('3a. the stayer, unpinned, cannot open the earlier chapter\'s trip', async () => {
    as(S)
    await expectNotFoundWithoutData(w.t1)
  })

  it('3b. the stayer pinned to E1 opens T1 with the ex\'s expense', async () => {
    as(S, w.e1)
    const props = await openTrip(w.t1)
    expect(props.trip.id).toBe(w.t1)
    expect(props.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: w.xExpense, paidBy: X, amount: 4200 }),
    ]))
    expect(props.records).toHaveLength(2)
  })

  it('3c. the stayer pinned to E1 cannot open the open chapter\'s trip', async () => {
    as(S, w.e1)
    await expectNotFoundWithoutData(w.t2)
  })

  it('5. per chapter, not per group: C pinned to E0 opens T0 but still not T1', async () => {
    as(C, w.e0)
    const props = await openTrip(w.t0)
    expect(props.trip.id).toBe(w.t0)
    await expectNotFoundWithoutData(w.t1)
  })

  it('6. the stayer\'s solo-chapter trip is not the new partner\'s', async () => {
    as(C)
    await expectNotFoundWithoutData(w.tSolo)
    as(C, w.eSolo) // a pin to a chapter C is not named on is ignored
    await expectNotFoundWithoutData(w.tSolo)
  })

  it('7a. unknown, malformed, deleted and other-group ids are notFound', async () => {
    as(C)
    await expectNotFoundWithoutData(randomUUID())
    await expectNotFoundWithoutData('not-a-uuid')
    await expectNotFoundWithoutData(`${w.t2}' OR '1'='1`)
    await expectNotFoundWithoutData(w.tDel)
    await expectNotFoundWithoutData(w.tH)
  })

  it('7b. a hostile or stale pin falls back to the open chapter and still cannot open T1', async () => {
    as(C, w.e1) // C is not named on E1
    await expectNotFoundWithoutData(w.t1)
    as(C, randomUUID()) // stale
    await expectNotFoundWithoutData(w.t1)
    // A malformed pin fails the resolver's uuid lookup (a pre-existing
    // resolver behaviour shared by every dashboard page): the request errors
    // and serves nothing, which is still closed.
    as(C, 'garbage')
    await expectRefusedWithoutData(w.t1, /Failed query/)
    as(X, w.e1) // the ex: named on E1 but no longer in G → no pin, no group of their own
    await expectRefusedWithoutData(w.t1, 'NEXT_REDIRECT /onboarding')
    // Fallback really is the open chapter: T2 opens under the same hostile pin.
    as(C, w.e1)
    expect((await openTrip(w.t2)).trip.id).toBe(w.t2)
  })
})

describe('/trips — the list follows the viewed chapter (#1614)', () => {
  it('4. pinned to E1 lists T1 only; unpinned lists T2 only; C lists T2 only', async () => {
    as(S, w.e1)
    expect(await listedTripIds()).toEqual([w.t1])
    as(S)
    expect(await listedTripIds()).toEqual([w.t2])
    as(C)
    expect(await listedTripIds()).toEqual([w.t2])
    as(C, w.e1) // hostile pin → open chapter
    expect(await listedTripIds()).toEqual([w.t2])
  })
})
