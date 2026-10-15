// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactElement } from 'react'

// ─── Integration: month messages belong to the chapter that wrote them ──────
// (#1684, #1685)
//
// A message is a group-scoped row, and since #1611 leaving or being removed
// keeps every one of them in the ledger. Read group-wide by (year, month), a
// message follows the ledger instead of the relationship:
//
//   #1685  A writes to month M+1 while still with B. B is removed; C joins
//          inside M. M+1 lies wholly inside A+C's chapter, so C's /review/M+1
//          showed A's words to B.
//   #1684  B, while with A, writes ahead to a month far in the future. When
//          that month comes, the home banner quotes B's row to A and to C —
//          "the partner's message" was "any row that is not the viewer's".
//
// What it looks like when this regresses: nothing errors. A page or banner
// quietly quotes words that were written to, or by, someone else.
//
// World (months relative to today's Taipei month T, so the test never rots;
// M = T-2):
//   ledger G (today: member_a A, member_b C)
//     E1  A + B   T-12 → mid-M   (B removed)
//     E2  A + C   mid-M → open
//
// Real Postgres (DATABASE_URL, dev); only the session, the cookie jar,
// next/navigation and next/cache are mocked, so the loader's SQL runs for
// real. Harness modelled on __tests__/former-member-lookback-1612.test.ts.
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

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

let viewerId = ''
vi.mock('@/lib/supabase/server', () => ({
  getCurrentUser: async () => (viewerId ? { id: viewerId, email: 'test-1685@example.invalid' } : null),
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
    getAll: () => Array.from(cookieStore, ([name, value]) => ({ name, value })),
    has: (key: string) => cookieStore.has(key),
    set: (key: string, value: string) => { cookieStore.set(key, value) },
    delete: (key: string) => { cookieStore.delete(key) },
  }),
  headers: async () => new Headers(),
}))

vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))

vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidatePath: () => {},
  revalidateTag: () => {},
}))

const { db } = await import('@/lib/db/client')
const schema = await import('@/lib/db/schema')
const { profiles, oikosGroups, groupEpochs, monthlyReviewSnapshots, monthlyReviewMessages } = schema
const { PAST_EPOCH_COOKIE } = await import('@/lib/db/queries/epoch')
const { inArray } = await import('drizzle-orm')
const {
  currentYearMonthInTaipei, formatYearMonth, nextMonth, previousMonth, taipeiMonthStart,
} = await import('@/lib/monthlyReview')

const { default: DashboardPage } = await import('@/app/(dashboard)/dashboard/page')
const { default: MonthlyReviewPage } = await import('@/app/(dashboard)/review/[month]/page')

// ─── World ──────────────────────────────────────────────────────────────────

const A = randomUUID()
const B = randomUUID()
const C = randomUUID()
const people = [A, B, C]

const T = currentYearMonthInTaipei()
const M = previousMonth(previousMonth(T))
const M1 = nextMonth(M) // = T-1: wholly inside E2; the banner's reviewed month
const DAY = 24 * 60 * 60 * 1000
const at = (ym: { year: number; month: number }, days: number) => new Date(taipeiMonthStart(ym).getTime() + days * DAY)

const E1_START = taipeiMonthStart({ year: T.year - 1, month: T.month })
const BOUNDARY = at(M, 14) // B removed and C joined inside M

const MSG = {
  // #1685 — A's words to month M+1, written to B while still in E1.
  aToM1InE1: 'TEST_1685_A_TO_M1_WRITTEN_IN_E1',
  // #1684 — B, in E1, writes ahead to month T (about a year away then).
  bForgedToT: 'TEST_1684_B_FORGED_TO_T',
  // This chapter's own words to month T (E2, both people).
  aToTInE2: 'TEST_1685_A_TO_T_IN_E2',
  cToTInE2: 'TEST_1685_C_TO_T_IN_E2',
}

const w = {} as { g: string; e1: string; e2: string }

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set; cannot run integration test. Ensure .env.local has DATABASE_URL.')
  }
  await db.insert(profiles).values([
    { id: A, displayName: 'TEST_1685_A' },
    { id: B, displayName: 'TEST_1685_B' },
    { id: C, displayName: 'TEST_1685_C' },
  ])
  const [g] = await db.insert(oikosGroups).values({
    name: 'TEST_1685_LEDGER', memberA: A, memberB: C, currentEpochStartedAt: BOUNDARY,
  }).returning({ id: oikosGroups.id })
  w.g = g.id

  const [e1] = await db.insert(groupEpochs).values({
    groupId: w.g, startedAt: E1_START, endedAt: BOUNDARY, memberAId: A, memberBId: B,
    memberAName: 'TEST_1685_A_AT_CLOSE', memberBName: 'TEST_1685_B_AT_CLOSE',
  }).returning({ id: groupEpochs.id })
  const [e2] = await db.insert(groupEpochs).values({
    groupId: w.g, startedAt: BOUNDARY, endedAt: null, memberAId: A, memberBId: C,
  }).returning({ id: groupEpochs.id })
  w.e1 = e1.id; w.e2 = e2.id

  // The banner needs last month's (M+1's) snapshot, undismissed.
  await db.insert(monthlyReviewSnapshots).values({ groupId: w.g, year: M1.year, month: M1.month })

  await db.insert(monthlyReviewMessages).values([
    { groupId: w.g, memberId: A, ...M1, body: MSG.aToM1InE1, createdAt: at(M, 2) },
    { groupId: w.g, memberId: B, ...T, body: MSG.bForgedToT, createdAt: new Date(E1_START.getTime() + 3 * DAY) },
    { groupId: w.g, memberId: A, ...T, body: MSG.aToTInE2, createdAt: at(M1, 20) },
    { groupId: w.g, memberId: C, ...T, body: MSG.cToTInE2, createdAt: at(M1, 21) },
  ])
})

afterAll(async () => {
  try {
    if (w.g) {
      await db.delete(monthlyReviewMessages).where(inArray(monthlyReviewMessages.groupId, [w.g]))
      await db.delete(monthlyReviewSnapshots).where(inArray(monthlyReviewSnapshots.groupId, [w.g]))
      await db.delete(groupEpochs).where(inArray(groupEpochs.groupId, [w.g]))
      await db.delete(oikosGroups).where(inArray(oikosGroups.id, [w.g]))
    }
    await db.delete(profiles).where(inArray(profiles.id, people))
  } catch (e) {
    console.error('cleanup failed', e)
  }
})

beforeEach(() => {
  cookieStore.clear()
  viewerId = ''
})

function as(user: string, pin?: string) {
  viewerId = user
  cookieStore.clear()
  if (pin) cookieStore.set(PAST_EPOCH_COOKIE, pin)
}

/** Find the first element named `name` in a server render tree; return its props. */
async function propsOf<P>(node: unknown, name: string): Promise<P | null> {
  const seen = new Set<unknown>()
  const visit = async (n: unknown, depth: number): Promise<P | null> => {
    if (depth > 60 || n === null || typeof n !== 'object' || seen.has(n)) return null
    seen.add(n)
    if (typeof (n as { then?: unknown }).then === 'function') return visit(await (n as Promise<unknown>), depth + 1)
    const el = n as { $$typeof?: unknown; type?: { name?: string; displayName?: string } | string; props?: unknown }
    if (el.$$typeof !== undefined && 'props' in el) {
      const t = el.type
      const elName = typeof t === 'string' ? t : (t?.displayName ?? t?.name)
      if (elName === name) return el.props as P
      return visit(el.props, depth + 1)
    }
    for (const v of Object.values(n)) {
      const hit = await visit(v, depth + 1)
      if (hit) return hit
    }
    return null
  }
  return visit(node, 0)
}

type ReviewProps = {
  pastMessages: { memberId: string; body: string }[]
  ownEditorMessage: { body: string } | null
  partnerEditorMessage: { body: string } | null
}
const review = async (ym: { year: number; month: number }) =>
  (await MonthlyReviewPage({ params: Promise.resolve({ month: formatYearMonth(ym) }) }) as ReactElement<ReviewProps>).props

const bannerQuote = async () => {
  const banner = await propsOf<{ quote: string | null }>(await DashboardPage(), 'MonthlyReviewBanner')
  expect(banner, 'the banner renders for last month').not.toBeNull()
  return banner!.quote
}

// ─── Acceptance ─────────────────────────────────────────────────────────────

describe('#1685 — a new partner never reads words written to the previous one', () => {
  it(`C at /review/M+1 sees none of A's message written to M+1 during A+B`, async () => {
    as(C)
    const p = await review(M1)
    expect(p.pastMessages.map((m) => m.body)).not.toContain(MSG.aToM1InE1)
    expect(p.pastMessages).toEqual([])
    // Positive control: the editor month (T) shows this chapter's own words.
    expect(p.partnerEditorMessage?.body).toBe(MSG.aToTInE2)
    expect(p.ownEditorMessage?.body).toBe(MSG.cToTInE2)
  })

  it('A at /review/M+1 (open chapter) does not see it either: it was written to B', async () => {
    as(A)
    const p = await review(M1)
    expect(p.pastMessages.map((m) => m.body)).not.toContain(MSG.aToM1InE1)
    expect(p.partnerEditorMessage?.body).toBe(MSG.cToTInE2)
  })
})

describe('#1684 — the home banner quotes only the open chapter\'s partner', () => {
  it(`A's banner quotes C, never B's forged row`, async () => {
    as(A)
    const quote = await bannerQuote()
    expect(quote).not.toBe(MSG.bForgedToT)
    expect(quote).toBe(MSG.cToTInE2)
  })

  it(`C's banner quotes A, never B's forged row`, async () => {
    as(C)
    const quote = await bannerQuote()
    expect(quote).not.toBe(MSG.bForgedToT)
    expect(quote).toBe(MSG.aToTInE2)
  })
})

describe('the loader, run against Postgres', () => {
  it('E1 (A+B, closed) reads its own rows and nothing written after it closed', async () => {
    const { loadChapterReviewMessages } = await import('@/lib/db/queries/monthlyReview')
    const e1Window = { startedAt: E1_START, endedAt: BOUNDARY, epochId: w.e1, isPast: true }
    const t = await loadChapterReviewMessages(w.g, T, { memberIds: [A, B], window: e1Window })
    expect(t.map((m) => m.body)).toEqual([MSG.bForgedToT])
    const m1 = await loadChapterReviewMessages(w.g, M1, { memberIds: [A, B], window: e1Window })
    expect(m1.map((m) => m.body)).toEqual([MSG.aToM1InE1])
  })

  it('no member ids → no rows (fails closed)', async () => {
    const { loadChapterReviewMessages } = await import('@/lib/db/queries/monthlyReview')
    const e2Window = { startedAt: BOUNDARY, endedAt: null, epochId: w.e2, isPast: false }
    expect(await loadChapterReviewMessages(w.g, T, { memberIds: [], window: e2Window })).toEqual([])
  })
})
