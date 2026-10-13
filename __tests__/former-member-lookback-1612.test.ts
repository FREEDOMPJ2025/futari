// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactElement } from 'react'

// ─── Integration: a former member's read-only look-back (#1612) ─────────────
//
// A person who left (B) or was removed (B2) can open, read-only, the closed
// chapter they were in. Every server payload in that mode holds only that
// chapter's data plus frozen identities — nothing of the ledger's present.
//
//   ledger G (today: member_a A, member_b C — name, ratio, rates, guardian
//   flag all set by A after the leave)
//     E0     A + B2   2026-01-01 → 2026-03-01  (B2 removed; A's frozen name NULL)
//     E1     A + B    2026-03-01 → 2026-05-01  (B left)
//     Esolo  A        2026-05-01 → 2026-06-01
//     E2     A + C    2026-06-01 → open
//   ledger LB  B's own solo ledger, open from 2026-05-01
//   ledger K   a forged world: an OPEN chapter naming B on a ledger B is not in
//
// After the leave A renames themself, changes photo, renames the ledger,
// adds an asset, logs fuel on the old car, edits the old car's details,
// writes this month's and May's review messages, sets a rate and a default
// ratio; C joins (E2) and writes a message.
//
// What it looks like when this regresses: nothing errors. The leaver's page
// payload quietly carries the stayer's current name and photo, the new
// partner's id, words written after they left, or an asset bought later.
//
// Real Postgres (DATABASE_URL, dev); only the session, the cookie jar,
// next/navigation and next/cache are mocked, so every resolver runs for real.
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
  getCurrentUser: async () => (viewerId ? { id: viewerId, email: 'test-1612@example.invalid' } : null),
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

// Pass-through spy: the real query runs; the test sees whether it ran.
vi.mock('@/lib/db/queries/currencyRates', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/db/queries/currencyRates')>()
  return { ...real, listRatesForGroup: vi.fn(real.listRatesForGroup) }
})

vi.mock('@/lib/db/queries/monthlyReview', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/db/queries/monthlyReview')>()
  return { ...real, loadMonthlyReviewMessages: vi.fn(real.loadMonthlyReviewMessages) }
})

const { db } = await import('@/lib/db/client')
const reviewQueries = await import('@/lib/db/queries/monthlyReview')
const schema = await import('@/lib/db/schema')
const {
  profiles, oikosGroups, groupEpochs, cashTransactions, assets, carDetails, fuelLogs,
  monthlyReviewSnapshots, monthlyReviewMessages, currencyRates, trips,
} = schema
const { PAST_EPOCH_COOKIE, listEpochsForViewer, resolveViewerEpochContext } = await import('@/lib/db/queries/epoch')
const rateQueries = await import('@/lib/db/queries/currencyRates')
const { eq, inArray } = await import('drizzle-orm')

const { default: DashboardLayout } = await import('@/app/(dashboard)/layout')
const { default: DashboardPage } = await import('@/app/(dashboard)/dashboard/page')
const { default: RecordsPage } = await import('@/app/(dashboard)/records/page')
const { default: AssetsPage } = await import('@/app/(dashboard)/assets/page')
const { default: AssetDetailPage } = await import('@/app/(dashboard)/assets/[id]/page')
const { default: ReviewIndexPage } = await import('@/app/(dashboard)/review/page')
const { default: MonthlyReviewPage } = await import('@/app/(dashboard)/review/[month]/page')
const { default: QuizPage } = await import('@/app/(dashboard)/review/[month]/quiz/page')
const { default: PastTimesPage } = await import('@/app/(dashboard)/settings/past-times/page')
const { default: CurrencySettingsPage } = await import('@/app/(dashboard)/settings/currency/page')
const { default: TripsPage } = await import('@/app/(dashboard)/trips/page')
const { default: TripDetailPage } = await import('@/app/(dashboard)/trips/[id]/page')
const { default: OnboardingPage } = await import('@/app/onboarding/page')
const { default: StandalonePastTimesPage } = await import('@/app/onboarding/past-times/page')
const { enterPastEpoch, exitPastEpoch } = await import('@/actions/epoch-view')
const { loadMoreFeedAll, createTransaction } = await import('@/actions/transaction')
const { createIncome } = await import('@/actions/income')
const { revealCarPlate, editCar } = await import('@/actions/asset')
const { dismissMonthlyReviewBanner } = await import('@/actions/monthlyReview')

// ─── World ──────────────────────────────────────────────────────────────────

const A = randomUUID()
const B = randomUUID()
const B2 = randomUUID()
const C = randomUUID()
const people = [A, B, B2, C]

// Markers of the ledger's present. None may appear in a former member's payload.
const LIVE = {
  aName: 'TEST_1612_A_LIVE_NAME',
  aAvatar: 'https://img.example/test-1612-a-now.jpg',
  cName: 'TEST_1612_C_NAME',
  ledgerName: 'TEST_1612_LEDGER_NOW',
  newAsset: 'TEST_1612_NEW_ASSET',
  carBrand: 'TEST_1612_BRAND_NOW',
  carNotes: 'TEST_1612_NOTE_NOW',
  postFuelStation: 'TEST_1612_STATION_POST',
  msgCurrent: 'TEST_1612_MSG_CURRENT',
  msgEditorMay: 'TEST_1612_MSG_EDITOR_MAY',
  msgC: 'TEST_1612_MSG_FROM_C',
  postTxn: 'TEST_1612_POST_TXN',
  postTrip: 'TEST_1612_TRIP_POST',
  rate: '31.416',
  lbTxn: 'TEST_1612_LB_TXN',
}
const RATIO_NOW = 73

const w = {} as {
  g: string; lb: string; k: string
  e0: string; e1: string; eSolo: string; e2: string; eLb: string; eK: string
  oldCar: string; newAsset: string
  e0Txn: string; e1Txn1: string; e1Txn2: string; postTxn: string; lbTxn: string
  t1: string; t2: string
}

const d = (s: string) => new Date(`${s}T00:00:00Z`)

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set; cannot run integration test. Ensure .env.local has DATABASE_URL.')
  }
  await db.insert(profiles).values([
    { id: A, displayName: LIVE.aName, avatarUrl: LIVE.aAvatar },
    { id: B, displayName: 'TEST_1612_B_LIVE' },
    { id: B2, displayName: 'TEST_1612_B2_LIVE' },
    { id: C, displayName: LIVE.cName, avatarUrl: 'https://img.example/test-1612-c.jpg' },
  ])

  const [g] = await db.insert(oikosGroups).values({
    name: LIVE.ledgerName, memberA: A, memberB: C, currentEpochStartedAt: d('2026-06-01'),
    defaultSplitRatioA: RATIO_NOW, guardianBetaEnabled: true,
  }).returning({ id: oikosGroups.id })
  const [lb] = await db.insert(oikosGroups).values({
    name: 'TEST_1612_LB', memberA: B, currentEpochStartedAt: d('2026-05-01'),
  }).returning({ id: oikosGroups.id })
  const [k] = await db.insert(oikosGroups).values({
    name: 'TEST_1612_K', memberA: A, currentEpochStartedAt: d('2026-06-01'),
  }).returning({ id: oikosGroups.id })
  w.g = g.id; w.lb = lb.id; w.k = k.id

  const epoch = async (groupId: string, from: string, to: string | null, a: string, b: string | null, aName: string | null, bName: string | null) => {
    const [row] = await db.insert(groupEpochs).values({
      groupId, startedAt: d(from), endedAt: to ? d(to) : null, memberAId: a, memberBId: b,
      memberAName: to ? aName : null, memberBName: to ? bName : null,
    }).returning({ id: groupEpochs.id })
    return row.id
  }
  w.e0 = await epoch(w.g, '2026-01-01', '2026-03-01', A, B2, 'placeholder', 'TEST_1612_B2_AT_CLOSE')
  // 5c — a closed chapter whose snapshot for A was never taken. The 0088
  // trigger fires on INSERT / UPDATE OF ended_at only, so this stays NULL.
  await db.update(groupEpochs).set({ memberAName: null }).where(eq(groupEpochs.id, w.e0))
  w.e1 = await epoch(w.g, '2026-03-01', '2026-05-01', A, B, 'TEST_1612_A_AT_CLOSE', 'TEST_1612_B_AT_CLOSE')
  w.eSolo = await epoch(w.g, '2026-05-01', '2026-06-01', A, null, 'TEST_1612_A_AT_CLOSE', null)
  w.e2 = await epoch(w.g, '2026-06-01', null, A, C, null, null)
  w.eLb = await epoch(w.lb, '2026-05-01', null, B, null, null, null)
  w.eK = await epoch(w.k, '2026-06-01', null, A, B, null, null)

  const [oldCar] = await db.insert(assets).values({
    groupId: w.g, type: 'car', name: 'TEST_1612_OLD_CAR', notes: LIVE.carNotes, createdAt: d('2026-03-05'),
  }).returning({ id: assets.id })
  await db.insert(carDetails).values({ assetId: oldCar.id, brand: LIVE.carBrand, initialOdometer: 1000 })
  const [newAsset] = await db.insert(assets).values({
    groupId: w.g, type: 'house', name: LIVE.newAsset, createdAt: d('2026-07-01'),
  }).returning({ id: assets.id })
  w.oldCar = oldCar.id; w.newAsset = newAsset.id

  const [fE1] = await db.insert(fuelLogs).values({
    assetId: w.oldCar, liters: '30.00', fuelType: '95', odometer: 1300, station: 'TEST_1612_STATION_E1',
    loggedAt: d('2026-03-20'), createdAt: d('2026-03-20'),
  }).returning({ id: fuelLogs.id })
  const [fPost] = await db.insert(fuelLogs).values({
    assetId: w.oldCar, liters: '31.00', fuelType: '95', odometer: 2000, station: LIVE.postFuelStation,
    loggedAt: d('2026-07-20'), createdAt: d('2026-07-20'),
  }).returning({ id: fuelLogs.id })

  const cash = async (groupId: string, paidBy: string, at: string, description: string, extra: Partial<typeof cashTransactions.$inferInsert> = {}) => {
    const [row] = await db.insert(cashTransactions).values({
      groupId, paidBy, amount: 1000, splitType: 'half', description, category: 'dining',
      transactedAt: d(at), createdAt: d(at), ...extra,
    }).returning({ id: cashTransactions.id })
    return row.id
  }
  w.e0Txn = await cash(w.g, B2, '2026-02-10', 'TEST_1612_E0_TXN')
  w.e1Txn1 = await cash(w.g, B, '2026-03-20', 'TEST_1612_E1_FUEL', { assetId: w.oldCar, fuelLogId: fE1.id, category: 'transit' })
  w.e1Txn2 = await cash(w.g, A, '2026-04-10', 'TEST_1612_E1_TXN')
  w.postTxn = await cash(w.g, A, '2026-07-20', LIVE.postTxn, { assetId: w.oldCar, fuelLogId: fPost.id, category: 'transit' })
  await cash(w.g, A, '2026-07-21', LIVE.postTxn, { assetId: w.newAsset })
  w.lbTxn = await cash(w.lb, B, '2026-06-10', LIVE.lbTxn)

  // Reviews: April (E1) and February (E0) belong to their chapters; the
  // dashboard banner's month (September) is E2's.
  await db.insert(monthlyReviewSnapshots).values([
    { groupId: w.g, year: 2026, month: 4, largestExpenseAmount: 1000, largestExpenseDescription: 'TEST_1612_E1_TXN', largestExpenseCategory: 'dining', largestExpensePaidBy: A },
    { groupId: w.g, year: 2026, month: 2, largestExpenseAmount: 1000, largestExpenseDescription: 'TEST_1612_E0_TXN', largestExpenseCategory: 'dining', largestExpensePaidBy: A },
    { groupId: w.g, year: 2026, month: 9, largestExpenseAmount: 1000, largestExpenseDescription: LIVE.postTxn, largestExpenseCategory: 'dining', largestExpensePaidBy: C },
  ])
  await db.insert(monthlyReviewMessages).values([
    { groupId: w.g, memberId: A, year: 2026, month: 4, body: 'TEST_1612_MSG_E1_A', createdAt: d('2026-03-28') },
    { groupId: w.g, memberId: A, year: 2026, month: 5, body: LIVE.msgEditorMay, createdAt: d('2026-05-03') },
    { groupId: w.g, memberId: A, year: 2026, month: 10, body: LIVE.msgCurrent, createdAt: d('2026-09-28') },
    { groupId: w.g, memberId: C, year: 2026, month: 10, body: LIVE.msgC, createdAt: d('2026-09-28') },
  ])
  await db.insert(currencyRates).values({ groupId: w.g, fromCurrency: 'usd', toCurrency: 'twd', rate: LIVE.rate })

  const [t1] = await db.insert(trips).values({
    groupId: w.g, epochId: w.e1, name: 'TEST_1612_TRIP_E1', startDate: '2026-03-10', status: 'ended', endDate: '2026-03-12', endedAt: d('2026-03-12'),
  }).returning({ id: trips.id })
  const [t2] = await db.insert(trips).values({
    groupId: w.g, epochId: w.e2, name: LIVE.postTrip, startDate: '2026-07-10', status: 'active',
  }).returning({ id: trips.id })
  w.t1 = t1.id; w.t2 = t2.id
})

afterAll(async () => {
  try {
    const groupIds = [w.g, w.lb, w.k].filter(Boolean)
    if (groupIds.length) {
      await db.delete(trips).where(inArray(trips.groupId, groupIds))
      await db.delete(cashTransactions).where(inArray(cashTransactions.groupId, groupIds))
      const assetIds = (await db.select({ id: assets.id }).from(assets).where(inArray(assets.groupId, groupIds))).map((a) => a.id)
      if (assetIds.length) {
        await db.delete(fuelLogs).where(inArray(fuelLogs.assetId, assetIds))
        await db.delete(carDetails).where(inArray(carDetails.assetId, assetIds))
        await db.delete(assets).where(inArray(assets.id, assetIds))
      }
      await db.delete(monthlyReviewMessages).where(inArray(monthlyReviewMessages.groupId, groupIds))
      await db.delete(monthlyReviewSnapshots).where(inArray(monthlyReviewSnapshots.groupId, groupIds))
      await db.delete(currencyRates).where(inArray(currencyRates.groupId, groupIds))
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
  vi.mocked(rateQueries.listRatesForGroup).mockClear()
  vi.mocked(reviewQueries.loadMonthlyReviewMessages).mockClear()
})

function as(user: string, pin?: string) {
  viewerId = user
  cookieStore.clear()
  if (pin) cookieStore.set(PAST_EPOCH_COOKIE, pin)
}

// ─── Serialising what a page hands the client ──────────────────────────────

/** Walk a server render result into plain JSON: element props (recursively),
 *  awaited promises (streamed props), dates as ISO strings. Functions — the
 *  component types and callbacks — carry no data and are dropped. */
async function materialize(node: unknown, depth = 0): Promise<unknown> {
  if (depth > 60) return '[deep]'
  if (node === null || node === undefined) return node
  if (typeof node === 'function' || typeof node === 'symbol') return undefined
  if (typeof node !== 'object') return node
  if (node instanceof Date) return node.toISOString()
  if (typeof (node as { then?: unknown }).then === 'function') return materialize(await (node as Promise<unknown>), depth + 1)
  if (Array.isArray(node)) return Promise.all(node.map((n) => materialize(n, depth + 1)))
  if (node instanceof Map) return materialize(Array.from(node.entries()), depth + 1)
  const el = node as { $$typeof?: unknown; type?: unknown; props?: unknown }
  if (el.$$typeof !== undefined && 'props' in el) {
    const t = el.type as { name?: string; displayName?: string } | string
    return { el: typeof t === 'string' ? t : (t?.displayName ?? t?.name ?? '?'), props: await materialize(el.props, depth + 1) }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) out[k] = await materialize(v, depth + 1)
  return out
}

async function payloadOf(el: unknown): Promise<string> {
  return JSON.stringify(await materialize(el))
}

/** Acceptance 5 — nothing of the ledger's present is in `json`. */
function expectNoLiveState(json: string) {
  for (const [key, marker] of Object.entries(LIVE)) {
    expect(json, `live marker ${key}`).not.toContain(marker)
  }
  expect(json, "C's id").not.toContain(C)
  expect(json, "the new asset's id").not.toContain(w.newAsset)
  expect(json, 'post-leave expense id').not.toContain(w.postTxn)
  expect(json, 'E2 trip id').not.toContain(w.t2)
  expect(json, "A's current default ratio").not.toMatch(new RegExp(`(defaultSplitRatioA|groupDefaultRatioA)":${RATIO_NOW}\\b`))
}

const layoutFor = async () => payloadOf(await DashboardLayout({ children: null }))

type MemberValue = {
  group: { id: string; name: string }
  viewer: { id: string; displayName: string; avatarUrl: string | null }
  partner: unknown
  isPast: boolean
  isFormerMember?: boolean
  isSolo: boolean
  viewerIsA: boolean
  canAccessGuardian: boolean
  chapter: { partner: { id: string; displayName: string; avatarUrl: null } | null; isSolo: boolean } | null
}

/** The MemberContext value the layout builds (ViewerProvider's prop). */
async function memberValue(): Promise<MemberValue> {
  const tree = await materialize(await DashboardLayout({ children: null }))
  let found: MemberValue | null = null
  const visit = (n: unknown) => {
    if (found || !n || typeof n !== 'object') return
    const o = n as { el?: string; props?: { value?: unknown } }
    if (o.el === 'ViewerProvider' && o.props?.value) { found = o.props.value as MemberValue; return }
    for (const v of Object.values(n)) visit(v)
  }
  visit(tree)
  if (!found) throw new Error('ViewerProvider not found in the layout tree')
  return found
}

// ─── Acceptance ─────────────────────────────────────────────────────────────

describe('#1612 — 1. the pin resolves for former members', () => {
  it('B on E1 and B2 on E0 resolve to G, read-only, as former members', async () => {
    as(B, w.e1)
    const b = await resolveViewerEpochContext(B)
    expect(b).toMatchObject({ group: { id: w.g }, window: { epochId: w.e1, isPast: true }, isFormerMemberView: true })
    as(B2, w.e0)
    const b2 = await resolveViewerEpochContext(B2)
    expect(b2).toMatchObject({ group: { id: w.g }, window: { epochId: w.e0, isPast: true }, isFormerMemberView: true })
  })

  it('the stayer pinned to E1 is not a former member', async () => {
    as(A, w.e1)
    expect((await resolveViewerEpochContext(A))!.isFormerMemberView).toBe(false)
  })

  it('listEpochsForViewer lists the closed chapter they were in and nothing of E2 / Esolo / K', async () => {
    const bIds = (await listEpochsForViewer(B)).map((e) => e.id).sort()
    expect(bIds).toEqual([w.e1, w.eLb].sort())
    const b2Ids = (await listEpochsForViewer(B2)).map((e) => e.id)
    expect(b2Ids).toEqual([w.e0])
  })
})

describe('#1612 — 2. the layout renders from the viewer and the chapter row', () => {
  it('B: own profile, no live partner, chapter partner = frozen name with no avatar, neutral ledger label', async () => {
    as(B, w.e1)
    const v = await memberValue()
    expect(v.viewer.id).toBe(B)
    expect(v.partner).toBeNull()
    expect(v.isFormerMember).toBe(true)
    expect(v.isPast).toBe(true)
    expect(v.isSolo).toBe(false)
    expect(v.viewerIsA).toBe(false)
    expect(v.canAccessGuardian).toBe(false)
    expect(v.chapter?.partner).toEqual({ id: A, displayName: 'TEST_1612_A_AT_CLOSE', initial: 'T', avatarUrl: null })
    expect(v.group).toMatchObject({ id: w.g, name: '家計簿' })
    expectNoLiveState(await layoutFor())
  })

  it('B2: the frozen name is NULL → the neutral 「對方」', async () => {
    as(B2, w.e0)
    const v = await memberValue()
    expect(v.viewer.id).toBe(B2)
    expect(v.chapter?.partner).toMatchObject({ id: A, displayName: '對方', avatarUrl: null })
    expectNoLiveState(await layoutFor())
  })

  it('no Realtime channel is mounted on the ledger they left', async () => {
    as(B, w.e1)
    const json = await layoutFor()
    expect(json).not.toContain('"el":"RealtimeProvider"')
    as(A) // control: the stayer's live view mounts it
    expect(await layoutFor()).toContain('"el":"RealtimeProvider"')
  })
})

describe('#1612 — 3. the chapter\'s own rows are served', () => {
  it('dashboard feed, records feed and paging hold exactly E1\'s rows', async () => {
    as(B, w.e1)
    const dash = await materialize(await DashboardPage()) as unknown
    const dashJson = JSON.stringify(dash)
    expect(dashJson).toContain(w.e1Txn1)
    expect(dashJson).toContain(w.e1Txn2)
    expect(dashJson).not.toContain(w.e0Txn)

    const rec = await RecordsPage({ searchParams: Promise.resolve({ range: 'all' }) }) as ReactElement<{ initial: { id: string }[] }>
    expect(rec.props.initial.map((r) => r.id).sort()).toEqual([w.e1Txn1, w.e1Txn2].sort())

    const paged = await loadMoreFeedAll(null, 50)
    expect(paged.ok).toBe(true)
    if (paged.ok) expect(paged.data.map((r) => r.id).sort()).toEqual([w.e1Txn1, w.e1Txn2].sort())
  })

  it('the review index lists E1\'s month and the month renders', async () => {
    as(B, w.e1)
    const idx = await ReviewIndexPage() as ReactElement<{ monthKeys: string[] }>
    expect(idx.props.monthKeys).toContain('2026-04')
    const month = await MonthlyReviewPage({ params: Promise.resolve({ month: '2026-04' }) }) as ReactElement<{
      readOnly: boolean; partner: { id: string; displayName: string; avatarUrl: string | null } | null; payerName: string | null
    }>
    expect(month.props.readOnly).toBe(true)
    expect(month.props.partner).toEqual({ id: A, displayName: 'TEST_1612_A_AT_CLOSE', avatarUrl: null })
    expect(month.props.payerName).toBe('TEST_1612_A_AT_CLOSE')
  })
})

describe('#1612 — 4. the way in and out', () => {
  it('B2 (no ledger): /onboarding offers the list → enter → /dashboard; exit → /onboarding', async () => {
    as(B2)
    const onboarding = await payloadOf(await OnboardingPage())
    expect(onboarding).toContain('"el":"PastTimesEntryLink"')

    const list = await StandalonePastTimesPage() as ReactElement<{ props: unknown }>
    const listJson = await payloadOf(list)
    expect(listJson).toContain(w.e0)
    expect(listJson).toContain('"neutralPartnerLabel":"對方"')
    expectNoLiveState(listJson)

    expect((await enterPastEpoch(w.e0)).ok).toBe(true)
    expect(cookieStore.get(PAST_EPOCH_COOKIE)).toBe(w.e0)
    expect((await memberValue()).isFormerMember).toBe(true)

    expect((await exitPastEpoch()).ok).toBe(true)
    await expect(DashboardLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT /onboarding')
  })

  it('B (own ledger): /onboarding sends them to /dashboard; exit returns to LB', async () => {
    as(B)
    await expect(OnboardingPage()).rejects.toThrow('NEXT_REDIRECT /dashboard')
    await expect(StandalonePastTimesPage()).rejects.toThrow('NEXT_REDIRECT /settings/past-times')
    as(B, w.e1)
    expect((await exitPastEpoch()).ok).toBe(true)
    const v = await memberValue()
    expect(v.group.id).toBe(w.lb)
    expect(v.isFormerMember).toBe(false)
  })

  it('someone with no closed chapter sees no entry on /onboarding', async () => {
    const lonely = randomUUID()
    await db.insert(profiles).values({ id: lonely, displayName: 'TEST_1612_LONELY' })
    try {
      as(lonely)
      expect(await payloadOf(await OnboardingPage())).not.toContain('PastTimesEntryLink')
    } finally {
      await db.delete(profiles).where(eq(profiles.id, lonely))
    }
  })
})

describe('#1612 — 5. nothing of the present is served', () => {
  const pages = (who: 'B' | 'B2'): [string, () => Promise<unknown>][] => [
    ['layout', () => DashboardLayout({ children: null })],
    ['/dashboard', () => DashboardPage()],
    ['/records', () => RecordsPage({ searchParams: Promise.resolve({ range: 'all' }) })],
    ['/records drill new asset', () => RecordsPage({ searchParams: Promise.resolve({ range: 'all', drillAsset: w.newAsset }) })],
    ['/assets', () => AssetsPage()],
    // The old car was bought in E1, after B2's chapter: B2 gets 404 (below).
    ...(who === 'B'
      ? [['/assets/[old car]', () => AssetDetailPage({ params: Promise.resolve({ id: w.oldCar }) })] as [string, () => Promise<unknown>]]
      : []),
    ['/review', () => ReviewIndexPage()],
    ['/trips', () => TripsPage()],
  ]

  for (const [who, pin] of [['B', 'e1'], ['B2', 'e0']] as const) {
    it(`${who}: every page payload is free of live state`, async () => {
      const user = who === 'B' ? B : B2
      for (const [name, render] of pages(who)) {
        as(user, w[pin])
        const json = await payloadOf(await render())
        try {
          expectNoLiveState(json)
        } catch (e) {
          throw new Error(`${name}: ${(e as Error).message}`)
        }
      }
    })
  }

  it('B: records stats, the review month, the trip and past-times are free of live state', async () => {
    as(B, w.e1)
    const rec = await RecordsPage({ searchParams: Promise.resolve({ range: 'all' }) }) as ReactElement<{
      statsSlot: ReactElement<Record<string, unknown>>; assets: { id: string }[]; drillAssetName: string | null
    }>
    const stats = await (rec.props.statsSlot.type as (p: unknown) => Promise<unknown>)(rec.props.statsSlot.props)
    expectNoLiveState(await payloadOf(stats))
    expect(rec.props.assets.map((a) => a.id)).toEqual([w.oldCar])

    const drill = await RecordsPage({ searchParams: Promise.resolve({ range: 'all', drillAsset: w.newAsset }) }) as ReactElement<{ drillAssetName: string | null }>
    expect(drill.props.drillAssetName).toBeNull()
    const drillOld = await RecordsPage({ searchParams: Promise.resolve({ range: 'all', drillAsset: w.oldCar }) }) as ReactElement<{ drillAssetName: string | null }>
    expect(drillOld.props.drillAssetName).toBe('TEST_1612_OLD_CAR')

    expectNoLiveState(await payloadOf(await MonthlyReviewPage({ params: Promise.resolve({ month: '2026-04' }) })))
    expectNoLiveState(await payloadOf(await TripDetailPage({ params: Promise.resolve({ id: w.t1 }) })))
    expectNoLiveState(await payloadOf(await PastTimesPage()))
  })

  it('B: the asset detail shows only the name and the chapter money', async () => {
    as(B, w.e1)
    const el = await AssetDetailPage({ params: Promise.resolve({ id: w.oldCar }) }) as ReactElement<Record<string, unknown>>
    expect(Object.keys(el.props).sort()).toEqual(['assetId', 'chapterTotal', 'fuelLogs', 'initialReturns', 'initialTxns', 'name', 'pageSize'])
    expect(el.props.name).toBe('TEST_1612_OLD_CAR')
    expect(el.props.chapterTotal).toBe(1000)
    expect((el.props.initialTxns as { id: string }[]).map((r) => r.id)).toEqual([w.e1Txn1])
    expect((el.props.fuelLogs as { station: string }[]).map((f) => f.station)).toEqual(['TEST_1612_STATION_E1'])
    const list = await AssetsPage() as ReactElement<{ items: unknown[] }>
    expect(list.props.items).toEqual([{ id: w.oldCar, type: 'car', name: 'TEST_1612_OLD_CAR', totalAmount: 1000 }])
  })

  it('B and B2: the new asset, an E2 trip and /settings/currency are not found', async () => {
    for (const [user, pin] of [[B, w.e1], [B2, w.e0]] as const) {
      as(user, pin)
      await expect(AssetDetailPage({ params: Promise.resolve({ id: w.newAsset }) })).rejects.toThrow('NEXT_NOT_FOUND')
      await expect(TripDetailPage({ params: Promise.resolve({ id: w.t2 }) })).rejects.toThrow('NEXT_NOT_FOUND')
      await expect(CurrencySettingsPage()).rejects.toThrow('NEXT_NOT_FOUND')
    }
    as(B2, w.e0)
    // E1's trip and an asset bought in E1 are not B2's chapter.
    await expect(TripDetailPage({ params: Promise.resolve({ id: w.t1 }) })).rejects.toThrow('NEXT_NOT_FOUND')
    await expect(AssetDetailPage({ params: Promise.resolve({ id: w.oldCar }) })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('B: the E1 trip opens without reading the ledger\'s rates', async () => {
    as(B, w.e1)
    const el = await TripDetailPage({ params: Promise.resolve({ id: w.t1 }) }) as ReactElement<{ trip: { id: string }; rates: unknown[]; groupDefaultRatioA: number | null }>
    expect(el.props.trip.id).toBe(w.t1)
    expect(el.props.rates).toEqual([])
    expect(el.props.groupDefaultRatioA).toBeNull()
    expect(rateQueries.listRatesForGroup).not.toHaveBeenCalled()
    const list = await TripsPage() as ReactElement<{ trips: { id: string }[] }>
    expect(list.props.trips.map((t) => t.id)).toEqual([w.t1])
  })

  it('B: the dashboard reads no rates and no month messages (F2)', async () => {
    as(B, w.e1)
    const el = await DashboardPage() as ReactElement
    expect(rateQueries.listRatesForGroup).not.toHaveBeenCalled()
    expect(reviewQueries.loadMonthlyReviewMessages).not.toHaveBeenCalled()
    expectNoLiveState(await payloadOf(el))
  })

  it('B: the read-only review month loads that month\'s messages only, never the editor month (F4)', async () => {
    as(B, w.e1)
    const el = await MonthlyReviewPage({ params: Promise.resolve({ month: '2026-04' }) }) as ReactElement<{
      pastMessages: { body: string }[]; ownEditorMessage: unknown; partnerEditorMessage: unknown
    }>
    expect(vi.mocked(reviewQueries.loadMonthlyReviewMessages).mock.calls.map((c) => c.slice(1))).toEqual([[2026, 4]])
    expect(el.props.pastMessages.map((m) => m.body)).toEqual(['TEST_1612_MSG_E1_A'])
    expect(el.props.ownEditorMessage).toBeNull()
    expect(el.props.partnerEditorMessage).toBeNull()
  })
})

describe('#1612 — 5b. who is in the ledger today does not change the dashboard', () => {
  const normalize = (s: string) => s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<ts>')

  it('B\'s /dashboard (and layout) payload is the same with or without C in G', async () => {
    as(B, w.e1)
    const withC = normalize(await payloadOf(await DashboardPage())) + normalize(await layoutFor())
    await db.update(oikosGroups).set({ memberB: null }).where(eq(oikosGroups.id, w.g))
    try {
      as(B, w.e1)
      const withoutC = normalize(await payloadOf(await DashboardPage())) + normalize(await layoutFor())
      expect(withoutC).toBe(withC)
    } finally {
      await db.update(oikosGroups).set({ memberB: C }).where(eq(oikosGroups.id, w.g))
    }
  })
})

describe('#1612 — 5c. a NULL frozen name reads as 「對方」 everywhere', () => {
  it('B2: review month, payer, and the standalone list', async () => {
    as(B2, w.e0)
    const month = await MonthlyReviewPage({ params: Promise.resolve({ month: '2026-02' }) }) as ReactElement<{
      partner: { displayName: string; avatarUrl: string | null } | null; payerName: string | null
    }>
    expect(month.props.partner).toMatchObject({ displayName: '對方', avatarUrl: null })
    expect(month.props.payerName).toBe('對方')
    const listed = (await listEpochsForViewer(B2))[0]
    expect(listed.memberAName).toBeNull() // no live read; the page shows 「對方」
    expectNoLiveState(await payloadOf(month))
  })
})

describe('#1612 — 6. forged and stale pins fall through', () => {
  it('an open chapter naming B on a ledger B is not in → B\'s own ledger', async () => {
    as(B, w.eK)
    expect((await memberValue()).group.id).toBe(w.lb)
  })
  it('a chapter B is not named on → B\'s own ledger; B2 with no ledger → /onboarding', async () => {
    as(B, w.e2)
    expect((await memberValue()).group.id).toBe(w.lb)
    as(B2, w.e1)
    await expect(DashboardLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT /onboarding')
  })
  it('a pin to a chapter that no longer exists (its ledger was deleted) → own ledger / onboarding', async () => {
    const [gone] = await db.insert(oikosGroups).values({ name: 'TEST_1612_GONE', memberA: A, currentEpochStartedAt: d('2026-02-01') }).returning({ id: oikosGroups.id })
    const [eGone] = await db.insert(groupEpochs).values({
      groupId: gone.id, startedAt: d('2026-01-01'), endedAt: d('2026-02-01'), memberAId: A, memberBId: B2,
      memberAName: 'x', memberBName: 'y',
    }).returning({ id: groupEpochs.id })
    await db.delete(groupEpochs).where(eq(groupEpochs.groupId, gone.id))
    await db.delete(oikosGroups).where(eq(oikosGroups.id, gone.id))
    as(B2, eGone.id)
    await expect(DashboardLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT /onboarding')
    as(B, eGone.id)
    expect((await memberValue()).group.id).toBe(w.lb)
  })
})

describe('#1612 — 7. writes are refused', () => {
  async function rowsOf(groupIds: string[]) {
    const snaps = await db.select().from(monthlyReviewSnapshots).where(inArray(monthlyReviewSnapshots.groupId, groupIds))
    const msgs = await db.select().from(monthlyReviewMessages).where(inArray(monthlyReviewMessages.groupId, groupIds))
    const cash = await db.select({ id: cashTransactions.id }).from(cashTransactions).where(inArray(cashTransactions.groupId, groupIds))
    const car = await db.select().from(carDetails).where(eq(carDetails.assetId, w.oldCar))
    return JSON.stringify([snaps, msgs, cash.map((c) => c.id).sort(), car])
  }

  it('every write path refuses, and no row in G or LB changes', async () => {
    const before = await rowsOf([w.g, w.lb])
    for (const [user, pin] of [[B, w.e1], [B2, w.e0]] as const) {
      as(user, pin)
      await expect(createTransaction({
        amount: 100, description: 'TEST_1612_WRITE', category: 'dining', splitType: 'half',
        payerId: user, transactedAt: '2026-04-01',
      } as Parameters<typeof createTransaction>[0])).rejects.toThrow('過去章節不可編輯')
      await expect(createIncome({
        amount: 100, category: 'salary', recipientId: user, occurredAt: '2026-04-01',
      } as Parameters<typeof createIncome>[0])).rejects.toThrow('過去章節不可編輯')
      await expect(QuizPage({ params: Promise.resolve({ month: '2026-04' }) })).rejects.toThrow('NEXT_NOT_FOUND')
    }
    // Reveal / asset edits resolve the viewer's ACTIVE ledger, never G.
    as(B, w.e1)
    expect(await revealCarPlate(w.oldCar)).toMatchObject({ ok: false, code: 'aibutsu_not_found' })
    const edited = await editCar({ id: w.oldCar, name: 'TEST_1612_HACK' } as Parameters<typeof editCar>[0]).catch((e: Error) => e)
    expect(edited instanceof Error || (edited as { ok: boolean }).ok === false).toBe(true)
    expect((await dismissMonthlyReviewBanner({ year: 2026, month: 4 })).ok).toBe(true) // acts on LB: no such snapshot there
    as(B2, w.e0)
    await expect(revealCarPlate(w.oldCar)).rejects.toThrow('找不到家計簿')
    await expect(dismissMonthlyReviewBanner({ year: 2026, month: 4 })).rejects.toThrow('找不到家計簿')

    expect(await rowsOf([w.g, w.lb])).toBe(before)
    const [car] = await db.select({ name: assets.name }).from(assets).where(eq(assets.id, w.oldCar))
    expect(car.name).toBe('TEST_1612_OLD_CAR')
  })
})

describe('#1612 — 10. current members are unchanged', () => {
  it('the stayer pinned to E1 keeps the live layout (name, ratio, Realtime)', async () => {
    as(A, w.e1)
    const v = await memberValue()
    expect(v.isFormerMember).toBe(false)
    expect(v.group.name).toBe(LIVE.ledgerName)
    expect(v.chapter?.partner).toMatchObject({ id: B, displayName: 'TEST_1612_B_AT_CLOSE', avatarUrl: null })
    expect(await layoutFor()).toContain('"el":"RealtimeProvider"')
  })

  it('C (open chapter) sees the live rates on the dashboard', async () => {
    as(C)
    await DashboardPage()
    expect(rateQueries.listRatesForGroup).toHaveBeenCalled()
  })

  it('the stayer can still read listEpochsForViewer for every chapter of G', async () => {
    const ids = (await listEpochsForViewer(A)).map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining([w.e0, w.e1, w.eSolo, w.e2]))
    // A is named on K's open chapter and is K's member_a: listed too.
    expect(ids).toContain(w.eK)
    expect(ids.some((id) => id === w.eLb)).toBe(false)
  })
})

