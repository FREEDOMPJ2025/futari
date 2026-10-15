// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'
import { TOMB, requestDeletion, world, type World } from './_deletionWorld1701'

// ─── #1701 S2: what X sees over an orphan ledger ────────────────────────────
//
// Former member X is pinned to the shared chapter E1 of D's ledger G. D (the
// stayer, alone since X left) deletes their account; 0096 keeps G as an
// orphan (member_a = D's tombstone Profile, no auth user, no member_b, no open
// chapter, kept assets stripped of *Details / notes / template_fields /
// name_encrypted, ledger name 「家計簿」, outing share tokens NULL).
//
// Every surface X has is rendered (server components, the pin, the export
// route) against the SAME database twice: before D's deletion is processed and
// after `process_account_deletions()` ran. The two renders must be equal once
// the allowed difference is applied: D's name reads 「已離開的夥伴」. (The
// outing share link is not part of any render X gets; a test checks it is
// gone from the render and from storage.)
//
// Failure this guards: nothing errors. X opens 「過去的時光」 and a page
// quietly drops a section (the asset page needs a *Details row, a page assumes
// the ledger has a live member_a or an open chapter), 404s, or shows D's real
// name or an ID number the cleanup was meant to remove.
//
// LOCAL THROWAWAY SERVER ONLY (stand-in database, migrated through 0096).
// Skips itself unless DATABASE_URL is localhost:
//
//   DATABASE_URL=postgres://postgres:<pw>@localhost:<port>/postgres \
//   DATABASE_URL_DIRECT=<same> \
//     npx vitest run __tests__/actions/orphanLookback1701.test.ts
//
// Integration folder (`__tests__/actions/**`): excluded from CI.
// ──────────────────────────────────────────────────────────────────────────

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnvLocal()
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

let viewerId = ''
vi.mock('@/lib/supabase/server', () => ({
  getCurrentUser: async () => (viewerId ? { id: viewerId, email: 'x-1701@example.invalid' } : null),
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
vi.mock('@/lib/analytics/server', () => ({
  captureServer: async () => {},
  isUserFirstNonDeletedRecord: async () => false,
}))

// The app talks to the stand-in database, never to what .env.local points at.
const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)
let standInUrl = ''
if (isLocalDb) {
  standInUrl = await createStandInDb(adminUrl, '0096')
  process.env.DATABASE_URL = standInUrl
  process.env.DATABASE_URL_DIRECT = standInUrl
}

const postgres = (await import('postgres')).default
const { PAST_EPOCH_COOKIE, listEpochsForViewer, resolveViewerEpochContext } = await import('@/lib/db/queries/epoch')
const { enterPastEpoch } = await import('@/actions/epoch-view')
const { loadMoreFeedAll } = await import('@/actions/transaction')
const { default: DashboardLayout } = await import('@/app/(dashboard)/layout')
const { default: DashboardPage } = await import('@/app/(dashboard)/dashboard/page')
const { default: RecordsPage } = await import('@/app/(dashboard)/records/page')
const { default: TripsPage } = await import('@/app/(dashboard)/trips/page')
const { default: TripDetailPage } = await import('@/app/(dashboard)/trips/[id]/page')
const { default: OutingsPage } = await import('@/app/(dashboard)/outings/page')
const { default: OutingDetailPage } = await import('@/app/(dashboard)/outings/[id]/page')
const { default: ReviewIndexPage } = await import('@/app/(dashboard)/review/page')
const { default: MonthlyReviewPage } = await import('@/app/(dashboard)/review/[month]/page')
const { default: AssetsPage } = await import('@/app/(dashboard)/assets/page')
const { default: AssetDetailPage } = await import('@/app/(dashboard)/assets/[id]/page')
const { default: PastTimesPage } = await import('@/app/(dashboard)/settings/past-times/page')
const { default: CurrencySettingsPage } = await import('@/app/(dashboard)/settings/currency/page')
const { default: OutingResumePage } = await import('@/app/[locale]/outing/r/[outingId]/page')
const { GET: exportGet } = await import('@/app/api/export/transactions/route')

// ─── Serialising what a page hands the client ──────────────────────────────

/** Walk a server render result into plain JSON: element props (recursively),
 *  awaited promises (streamed props), async server components (run), dates as
 *  ISO strings. Functions carry no data and are dropped. */
async function materialize(node: unknown, depth = 0): Promise<unknown> {
  if (depth > 80) return '[deep]'
  if (node === null || node === undefined) return node
  if (typeof node === 'function' || typeof node === 'symbol') return undefined
  if (typeof node !== 'object') return node
  if (node instanceof Date) return node.toISOString()
  if (typeof (node as { then?: unknown }).then === 'function') return materialize(await (node as Promise<unknown>), depth + 1)
  if (Array.isArray(node)) return Promise.all(node.map((n) => materialize(n, depth + 1)))
  if (node instanceof Map) return materialize(Array.from(node.entries()), depth + 1)
  const el = node as { $$typeof?: unknown; type?: unknown; props?: unknown }
  if (el.$$typeof !== undefined && 'props' in el) {
    const t = el.type as string | (((p: unknown) => unknown) & { displayName?: string })
    if (typeof t === 'function' && t.constructor?.name === 'AsyncFunction') {
      // An async function component is a Server Component: render it.
      return { el: t.name || '?', rendered: await materialize(await (t as (p: unknown) => unknown)(el.props), depth + 1) }
    }
    return { el: typeof t === 'string' ? t : (t?.displayName ?? t?.name ?? '?'), props: await materialize(el.props, depth + 1) }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) out[k] = await materialize(v, depth + 1)
  return out
}

/** The page's payload as a string, or what it threw (a 404 / redirect is a result too). */
async function capture(fn: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await materialize(await fn()))
  } catch (e) {
    return `THROWN ${(e as Error).message}`
  }
}

type Page = [name: string, fn: () => Promise<unknown>]

const SURFACE_NAMES = [
  'layout', 'past-times page', 'dashboard', 'records', 'records drill carPre', 'records drill itemRefByKeptTx',
  'records more (paging)', 'trips list', 'trip detail tripIn', 'trip detail tripPre', 'trip detail tripPost',
  'outings list', 'outing detail outingIn', 'outing detail outingPost', 'outing resume outingIn', 'review index',
  'review 2026-04', 'review 2026-05', 'review 2026-01', 'review 2026-09', 'assets list',
  'asset detail carPre', 'asset detail childPre', 'asset detail petIn', 'asset detail insIn',
  'asset detail houseDelIn', 'asset detail itemRefByKeptTx', 'asset detail carPost', 'asset detail childPost',
  'currency settings', 'export csv',
]

function surfaces(w: World): Page[] {
  const id = (l: string) => w.rec.id(l)
  const month = (m: string) => () => MonthlyReviewPage({ params: Promise.resolve({ month: m }) })
  const asset = (l: string) => () => AssetDetailPage({ params: Promise.resolve({ id: id(l) }) })
  const trip = (l: string) => () => TripDetailPage({ params: Promise.resolve({ id: id(l) }) })
  const outing = (l: string) => () => OutingDetailPage({ params: Promise.resolve({ id: id(l) }) })
  const records = (extra: Record<string, string> = {}) => () =>
    RecordsPage({ searchParams: Promise.resolve({ range: 'all', ...extra }) })
  return [
    ['layout', () => DashboardLayout({ children: null })],
    ['past-times page', () => PastTimesPage()],
    ['dashboard', () => DashboardPage()],
    ['records', records()],
    ['records drill carPre', records({ drillAsset: id('carPre') })],
    ['records drill itemRefByKeptTx', records({ drillAsset: id('itemRefByKeptTx') })],
    ['records more (paging)', () => loadMoreFeedAll(null, 50)],
    ['trips list', () => TripsPage()],
    ['trip detail tripIn', trip('tripIn')],
    ['trip detail tripPre', trip('tripPre')],
    ['trip detail tripPost', trip('tripPost')],
    ['outings list', () => OutingsPage({})],
    ['outing detail outingIn', outing('outingIn')],
    ['outing detail outingPost', outing('outingPost')],
    ['outing resume outingIn', () => OutingResumePage({ params: Promise.resolve({ locale: 'zh-TW', outingId: id('outingIn') }) })],
    ['review index', () => ReviewIndexPage()],
    ['review 2026-04', month('2026-04')],
    ['review 2026-05', month('2026-05')],
    ['review 2026-01', month('2026-01')],
    ['review 2026-09', month('2026-09')],
    ['assets list', () => AssetsPage()],
    ...(['carPre', 'childPre', 'petIn', 'insIn', 'houseDelIn', 'itemRefByKeptTx', 'carPost', 'childPost'] as const)
      .map((l): Page => [`asset detail ${l}`, asset(l)]),
    ['currency settings', () => CurrencySettingsPage()],
  ]
}

/** The export route's CSV body (the file name carries today's date). */
async function exportCsv(): Promise<string> {
  const res = await exportGet()
  return `${res.status}\n${await res.text()}`
}

// ─── World, before and after ───────────────────────────────────────────────

let pg: Sql
let warnings: string[] = []
const before: Record<string, string> = {}
const after: Record<string, string> = {}
let w: World
let pinBefore: unknown
let pinAfter: unknown
let epochsBefore: unknown
let epochsAfter: unknown
let enterBefore: unknown
let enterAfter: unknown
let tag = ''

async function renderAll(into: Record<string, string>) {
  viewerId = w.X
  cookieStore.clear()
  cookieStore.set(PAST_EPOCH_COOKIE, w.E1)
  for (const [name, fn] of surfaces(w)) into[name] = await capture(fn)
  into['export csv'] = await capture(exportCsv)
}

const pinOf = async () => {
  viewerId = w.X
  cookieStore.clear()
  cookieStore.set(PAST_EPOCH_COOKIE, w.E1)
  const ctx = await resolveViewerEpochContext(w.X)
  return ctx && {
    groupId: ctx.group.id, epochId: ctx.window.epochId, isPast: ctx.window.isPast,
    endedAt: ctx.window.endedAt, isFormerMemberView: ctx.isFormerMemberView,
  }
}
const epochsOf = async () => (await listEpochsForViewer(w.X)).map((e) => ({
  id: e.id, groupId: e.groupId, startedAt: e.startedAt, endedAt: e.endedAt, memberAId: e.memberAId, memberBId: e.memberBId,
  memberAName: e.memberAName, memberBName: e.memberBName,
}))
const enter = async () => {
  viewerId = w.X
  cookieStore.clear()
  const r = await enterPastEpoch(w.E1)
  return { r, cookie: cookieStore.get(PAST_EPOCH_COOKIE) ?? null }
}

/** Every path where two JSON values differ (the payloads are big). */
function diffPaths(got: unknown, want: unknown, path = '$', out: string[] = []): string[] {
  if (JSON.stringify(got) === JSON.stringify(want)) return out
  if (got && want && typeof got === 'object' && typeof want === 'object' && Array.isArray(got) === Array.isArray(want)) {
    const keys = new Set([...Object.keys(got), ...Object.keys(want)])
    for (const k of keys) {
      diffPaths((got as Record<string, unknown>)[k], (want as Record<string, unknown>)[k], `${path}.${k}`, out)
    }
    return out
  }
  out.push(`${path}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  return out
}

/** null when equal, else the differing paths. */
function firstDiff(got: string, want: string): string | null {
  if (got === want) return null
  try {
    return diffPaths(JSON.parse(got), JSON.parse(want)).join('\n')
  } catch {
    return `got ${got.slice(0, 300)}\nwant ${want.slice(0, 300)}`
  }
}

/**
 * The allowed differences, applied to the "before" render.
 *  1. D's name reads 「已離開的夥伴」 (and the avatar initial follows the name).
 *  2. Outing detail: the processor unbinds D's participant (0088, unchanged by
 *     0096: profile_id NULL, claimed_at set), so the row reads `claimed`
 *     instead of `bound`, `isMember` is false, and the member-to-member fold
 *     (`coupleNet`, not rendered; `foldPreview` stays 0 in a past chapter) is
 *     0. The same as when the partner of a paired ledger deletes.
 *     The public resume page shows the same `claim` change.
 *  3. Outings list: the "participating" list also holds outings X joined in
 *     D's ledger after the chapter (a friend slot); D's deletion removes that
 *     post-chapter outing (not visible-to-chapter), so it leaves the list.
 */
function allowed(name: string, s: string): string {
  const named = s
    .split(`${tag} D real name`).join(TOMB)
    .replace(new RegExp(`("displayName":"${TOMB}","initial":")[^"]*"`, 'g'), '$1已"')
  if (!named.startsWith('{')) return named
  const o = JSON.parse(named)
  if (name === 'outing detail outingIn') {
    o.props.view.coupleNet = 0
    for (const p of o.props.participants) {
      if (p.displayName === TOMB) { p.isMember = false; p.claim = 'claimed' }
    }
  }
  if (name === 'outing resume outingIn') {
    for (const p of o.props.view.participants) if (p.displayName === TOMB) p.claim = 'claimed'
  }
  if (name === 'outings list') {
    o.props.participating = o.props.participating.filter((p: { id: string }) => p.id !== w.rec.id('outingPost'))
  }
  return JSON.stringify(o)
}

describe.skipIf(!isLocalDb)('#1701 S2 — X looks back over an orphan ledger', () => {
  beforeAll(async () => {
    pg = postgres(standInUrl, {
      max: 1,
      onnotice: (n) => { if (n.severity === 'WARNING') warnings.push(String(n.message)) },
    })
    tag = `T1701S2_${randomUUID().slice(0, 8)}`
    w = await world(pg, tag)

    // Before: D alive, ledger G live (member_a = D, no member_b, open chapter E2).
    await renderAll(before)
    pinBefore = await pinOf()
    epochsBefore = await epochsOf()
    enterBefore = await enter()

    // D's account deletion is processed (case a of S1).
    await requestDeletion(pg, w.D)
    warnings = []
    const [{ n }] = await pg<{ n: number }[]>`SELECT public.process_account_deletions() AS n`
    expect({ n, warnings }).toEqual({ n: 1, warnings: [] })

    await renderAll(after)
    pinAfter = await pinOf()
    epochsAfter = await epochsOf()
    enterAfter = await enter()
  })

  afterAll(async () => {
    await pg?.end()
    if (standInUrl) await dropStandInDb(adminUrl, standInUrl)
  })

  it('premise: G is an orphan now (member_a = D with no login, no member_b, no open chapter), D is a tombstone', async () => {
    const [g] = await pg`SELECT member_a, member_b, name FROM "OikosGroups" WHERE id = ${w.G}`
    expect(g).toEqual({ member_a: w.D, member_b: null, name: '家計簿' })
    const [{ n }] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.users WHERE id = ${w.D}`
    expect(n).toBe(0)
    const open = await pg`SELECT 1 FROM "GroupEpochs" WHERE group_id = ${w.G} AND ended_at IS NULL`
    expect(open).toHaveLength(0)
    const [p] = await pg`SELECT display_name FROM "Profiles" WHERE id = ${w.D}`
    expect(p.display_name).toBe(TOMB)
  })

  describe('past-times list and the pin', () => {
    it('listEpochsForViewer: the same chapters for X, with D\'s slot 「已離開的夥伴」', () => {
      const b = epochsBefore as { id: string; memberAName: string | null }[]
      const a = epochsAfter as typeof b
      expect(a.map((e) => e.id)).toContain(w.E1)
      expect(a.map((e) => e.id).sort()).toEqual(b.map((e) => e.id).sort())
      expect(JSON.parse(allowed('', JSON.stringify(b)))).toEqual(JSON.parse(JSON.stringify(a)))
      expect(a.find((e) => e.id === w.E1)!.memberAName).toBe(TOMB)
      // E0 / E2 name only D: not X's chapters.
      expect(a.map((e) => e.id)).not.toContain(w.E0)
      expect(a.map((e) => e.id)).not.toContain(w.E2)
    })

    it('pin (pinAcceptable): X pinned to E1 still resolves to G, read-only, as a former member', () => {
      expect(pinAfter).toEqual(pinBefore)
      expect(pinAfter).toMatchObject({ groupId: w.G, epochId: w.E1, isPast: true, isFormerMemberView: true })
    })

    it('enterPastEpoch(E1) is accepted and sets the cookie', () => {
      expect(enterAfter).toEqual(enterBefore)
      expect(enterAfter).toMatchObject({ cookie: w.E1 })
      expect((enterAfter as { r: { ok: boolean } }).r.ok).toBe(true)
    })
  })

  // One test per surface: equal to the "before" render once D's name is the
  // placeholder, and (non-vacuous) the render holds what it must hold.
  const must: Record<string, (W: World) => string[]> = {
    dashboard: (W) => [W.rec.id('cashInX'), W.rec.id('cashInD')],
    records: (W) => [W.rec.id('cashInX'), W.rec.id('cashInTripIn'), W.rec.id('cashInImported'), W.rec.id('incomeIn'), W.rec.id('settleIn')],
    'records more (paging)': (W) => [W.rec.id('cashInX')],
    'trips list': (W) => [W.rec.id('tripIn')],
    'trip detail tripIn': () => ['te teIn', 'te teInLate'],
    'outings list': (W) => [W.rec.id('outingIn')],
    'outing detail outingIn': () => ['bbq', 'friend'],
    'review 2026-04': () => ['b msgAprX', 'b msgAprD'],
    'assets list': (W) => [W.rec.id('carPre'), W.rec.id('petIn'), W.rec.id('insIn')],
    'asset detail carPre': () => ['n carPre'],
    'asset detail petIn': () => ['n petIn'],
    'asset detail childPre': () => ['n childPre'],
    'asset detail insIn': () => ['n insIn'],
    'export csv': () => ['d cashInX', 'd cashInD'],
  }
  const mustNot: Record<string, (W: World) => string[]> = {
    dashboard: (W) => [W.rec.id('cashPost'), W.rec.id('cashPostTrip')],
    records: (W) => [W.rec.id('cashPost'), W.rec.id('cashPostImported'), W.rec.id('incomePost'), W.rec.id('settlePost')],
    'trips list': (W) => [W.rec.id('tripPost')],
    'outings list': (W) => [W.rec.id('outingPost')],
    'assets list': (W) => [W.rec.id('carPost'), W.rec.id('childPost')],
    'review 2026-04': () => ['b msgMayDLate', 'b msgSepD', 'b msgJanX'],
  }

  for (const name of SURFACE_NAMES) {
    it(`${name}: the same as before D's deletion, but for D's name`, () => {
      const b = before[name]
      const a = after[name]
      expect(a).toBeDefined()
      expect(firstDiff(a, allowed(name, b))).toBeNull()
      for (const m of must[name]?.(w) ?? []) expect(a, `holds ${m}`).toContain(m)
      for (const m of mustNot[name]?.(w) ?? []) expect(a, `lacks ${m}`).not.toContain(m)
      // D's real name is nowhere after.
      expect(a).not.toContain(`${tag} D real name`)
    })
  }

  it('the surfaces that matter render (not 404 / redirect), before and after', () => {
    const live = [
      'layout', 'past-times page', 'dashboard', 'records', 'records more (paging)', 'trips list', 'trip detail tripIn',
      'outings list', 'outing detail outingIn', 'outing resume outingIn', 'review index', 'review 2026-04', 'assets list',
      'asset detail carPre', 'asset detail childPre', 'asset detail petIn', 'asset detail insIn', 'export csv',
    ]
    for (const n of live) {
      expect(before[n], `before: ${n}`).not.toMatch(/^THROWN/)
      expect(after[n], `after: ${n}`).not.toMatch(/^THROWN/)
    }
    // Outside the chapter (or deleted by the cleanup): not found, as before.
    for (const n of ['trip detail tripPost', 'outing detail outingPost', 'asset detail carPost', 'asset detail childPost', 'review 2026-09']) {
      expect(after[n], n).toBe('THROWN NEXT_NOT_FOUND')
    }
  })

  it('where D is shown, it is 「已離開的夥伴」 (layout chapter partner, review payer, outing participant)', () => {
    expect(after['layout']).toContain(TOMB)
    expect(after['review 2026-04']).toContain(TOMB)
    expect(after['outing detail outingIn']).toContain(TOMB)
  })

  it('the outing share link is gone: no share token in the outing renders, none stored', async () => {
    for (const s of [after['outing detail outingIn'], after['outings list']]) {
      expect(s).not.toMatch(/share_?token|shareToken/i)
    }
    const [{ n }] = await pg<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Outings" WHERE group_id = ${w.G}
        AND (share_token_hash IS NOT NULL OR share_token_encrypted IS NOT NULL)`
    expect(n).toBe(0)
  })

  it('what the cleanup removed at rest reaches no surface: no note, template field, encrypted name or detail value', () => {
    const all = Object.values(after).join('\n')
    for (const s of ['note carPre', 'enc carPre', 'enc plate', 'enc id', 'secret policy', 'enc addr']) {
      expect(all, s).not.toContain(s)
    }
  })

  it('X\'s own ledger is untouched by the whole thing (control)', async () => {
    const [{ n }] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM "CashTransactions" WHERE group_id = ${w.NX}`
    expect(n).toBe(1)
  })
})
