// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl, migrateThrough } from './_supabaseStandIn'
import { Recorder, TOMB, ledger, person, requestDeletion } from './_deletionWorld1701'

// ─── #1782: 「已離開的夥伴」 is a system marker, shown in the viewer's language ──
//
// Against a real Postgres: a stand-in migrated through 0098, seeded with every
// shape 0099's backfill has to decide on, then migrated through 0099; then the
// real deletion job, #1619 action, snapshot trigger, readers, reserved-name
// checks and handle_new_user.
//
// What it guards (failure looks like: nothing errors):
//   - a marker that is not set where the literal is written (deletion, #1619,
//     a tombstone captured at close) → the en / ja viewer reads 已離開的夥伴;
//   - a marker set on a name someone chose (backfill too wide: guests,
//     live accounts) → their own name is replaced by the label;
//   - the marker's source (`is_tombstone`) reaching a client payload;
//   - a reserved name that slips through a normaliser bypass.
//
// LOCAL THROWAWAY SERVER ONLY. Skips itself unless DATABASE_URL is localhost:
//
//   docker run -d --name pg-1782 -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55782:5432 postgres:17
//   DATABASE_URL=postgres://postgres:pg@127.0.0.1:55782/postgres \
//   DATABASE_URL_DIRECT=postgres://postgres:pg@127.0.0.1:55782/postgres \
//     npx vitest run __tests__/actions/leftLabelMarker1782.test.ts
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
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 })

let viewerId = ''
vi.mock('@/lib/supabase/server', () => ({
  getCurrentUser: async () => (viewerId ? { id: viewerId, email: 'v-1782@example.invalid' } : null),
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: viewerId ? { id: viewerId } : null }, error: null }) },
  }),
}))
const cookieJar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (k: string) => (cookieJar.has(k) ? { name: k, value: cookieJar.get(k)! } : undefined),
    getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
    has: (k: string) => cookieJar.has(k),
    set: (name: string, value: string) => { cookieJar.set(name, value) },
    delete: (name: string) => { cookieJar.delete(name) },
  }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
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
  standInUrl = await createStandInDb(adminUrl, '0098')
  process.env.DATABASE_URL = standInUrl
  process.env.DATABASE_URL_DIRECT = standInUrl
}

const postgres = (await import('postgres')).default
const L = { zhTW: '已離開的夥伴', zhCN: '已离开的伙伴', en: 'Partner who left', ja: '退出したパートナー' }
const RESERVED_CODE = 'display_name_reserved'

let sql: Sql

// ─── the backfill world, seeded at 0098 (0096's deletion body) ─────────────
interface Backfill {
  tomb: string           // deleted at 0098, tombstone kept → is_tombstone true
  liveLiteral: string    // alive, named the literal → false
  noAuthOther: string    // no auth row, another name → false
  e: Record<string, string>
  o: Record<string, string>
}
let bf: Backfill

async function epochMarks(id: string) {
  const [r] = await sql<{ a: string | null; b: string | null; al: boolean; bl: boolean }[]>`
    SELECT member_a_name AS a, member_b_name AS b,
           member_a_name_is_left_label AS al, member_b_name_is_left_label AS bl
    FROM "GroupEpochs" WHERE id = ${id}`
  return r
}
async function slotMark(id: string) {
  const [r] = await sql<{ name: string; mark: boolean; profile_id: string | null }[]>`
    SELECT display_name AS name, display_name_is_left_label AS mark, profile_id
    FROM "OutingParticipants" WHERE id = ${id}`
  return r
}
async function tombstone(id: string) {
  const [r] = await sql<{ t: boolean; name: string }[]>`SELECT is_tombstone AS t, display_name AS name FROM "Profiles" WHERE id = ${id}`
  return r
}

async function seedBackfill(): Promise<Backfill> {
  const rec = new Recorder(sql)
  const T = await person(sql, 'BF T 本名')
  const P = await person(sql, 'BF P')
  const LIVE = await person(sql, 'BF live')
  const RENAMED = await person(sql, 'BF renamed')
  const Q = await person(sql, 'BF Q')
  const NOAUTH = await person(sql, 'BF no auth', false)

  // T and P share K; T deletes (duo branch: K stays with P; the K0 chapter
  // keeps T's Profiles row as a tombstone).
  const K = await ledger(rec, sql, 'BF-K', 'BF K', [
    { label: 'BF-K0', start: '2026-01-01T00:00:00Z', end: null, a: T, b: P },
  ])
  const oK = await rec.ins('Outings', 'BF-oK', { group_id: K.g, epoch_id: K.epochs['BF-K0'], created_by: P, name: 'oK', currency: 'twd' })
  const part = (label: string, o: string, name: string, profile: string | null, extra: Record<string, unknown> = {}) =>
    rec.ins('OutingParticipants', label, { outing_id: o, display_name: name, profile_id: profile, ...extra })
  const tSlot = await part('BF-tSlot', oK, 'BF T 本名', T)
  // 0083-before shape: unbound, unclaimed, tokenless — looks like a member-added guest.
  const pre0083 = await part('BF-pre0083', oK, TOMB, null)
  // Anonymous joinOuting guest who typed the literal (token + claimed_at).
  const anonGuest = await part('BF-anonGuest', oK, TOMB, null, {
    claim_token_hash: 'bf-hash-anon', claimed_at: new Date('2026-02-01T00:00:00Z'),
  })
  // Signed-in joinOuting guest who typed the literal (bound, claimed_at, no token).
  const signedGuest = await part('BF-signedGuest', oK, TOMB, Q, { claimed_at: new Date('2026-02-02T00:00:00Z') })
  // A released slot (releaseOutingSlot clears claimed_at with the token).
  const released = await part('BF-released', oK, TOMB, null)

  // LIVE is named the literal and was frozen so at a close (alive → false).
  // RENAMED was the literal at the close and renamed afterwards (still in the
  // ledger, alive → false).
  const M = await ledger(rec, sql, 'BF-M', 'BF M', [
    { label: 'BF-M0', start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z', a: LIVE, b: RENAMED },
    { label: 'BF-M1', start: '2026-03-01T00:00:00Z', end: null, a: LIVE, b: RENAMED },
  ])
  await sql`UPDATE "GroupEpochs" SET member_a_name = ${TOMB}, member_b_name = ${TOMB} WHERE id = ${M.epochs['BF-M0']}`
  await sql`UPDATE "Profiles" SET display_name = ${TOMB} WHERE id = ${LIVE}`

  // A chapter naming NOAUTH (no auth row) under another name: false.
  const N = await ledger(rec, sql, 'BF-N', 'BF N', [
    { label: 'BF-N0', start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z', a: Q, b: NOAUTH },
    { label: 'BF-N1', start: '2026-02-01T00:00:00Z', end: null, a: Q, b: null },
  ])
  await sql`UPDATE "GroupEpochs" SET member_a_name = 'BF Q', member_b_name = 'BF no auth' WHERE id = ${N.epochs['BF-N0']}`

  await requestDeletion(sql, T)
  const [{ n }] = await sql<{ n: number }[]>`SELECT public.process_account_deletions() AS n`
  expect(n).toBe(1)

  return {
    tomb: T, liveLiteral: LIVE, noAuthOther: NOAUTH,
    e: { K0: K.epochs['BF-K0'], M0: M.epochs['BF-M0'], N0: N.epochs['BF-N0'] },
    o: { tSlot, pre0083, anonGuest, signedGuest, released },
  }
}

/** The backfill's four UPDATEs, as 0099 runs them. */
function backfillStatements(): string[] {
  const file = readFileSync(resolve(__dirname, '../../drizzle/0099_left_label_marker.sql'), 'utf-8')
  return file.slice(file.indexOf('-- ─── backfill')).split('--> statement-breakpoint')
    .map((s) => s.trim()).filter((s) => /UPDATE/.test(s))
}
let backfillRerun = { statements: 0, changed: -1 }

if (isLocalDb) {
  sql = postgres(standInUrl, { max: 4, onnotice: () => {} })
  bf = await seedBackfill()
  await migrateThrough(standInUrl, '0099')
  // Re-run right away, before anything after 0099 writes: a second run must
  // change nothing (and must not be what sets the markers the writers below
  // are tested for).
  const statements = backfillStatements()
  let changed = 0
  for (const s of statements) changed += (await sql.unsafe(s)).count
  backfillRerun = { statements: statements.length, changed }
}

const P = await import('@/actions/profile')
const O = await import('@/actions/outing')
const { countMyNameInLeftLedgers, getEpochMembers, listEpochsForViewer } = await import('@/lib/db/queries/epoch')
const { getLedgerExportForViewer } = await import('@/lib/db/queries/export')
const { loadOutingDetailRows } = await import('@/lib/db/queries/outing')
const { getOutingLanding, getOutingFullView } = await import('@/lib/db/queries/outingPublic')
const { localizeChapterMembers } = await import('@/lib/leftPartnerLabel')
const { buildChapterIdentity } = await import('@/lib/chapterIdentity')
const { resolveReviewPayerName } = await import('@/lib/monthlyReview')
const { generateToken, hashToken } = await import('@/lib/outing/tokens')
const { default: OutingSharePage } = await import('@/app/[locale]/outing/[shareToken]/page')

// ─── the main world, after 0099 ───────────────────────────────────────────
interface W {
  A: string; B: string; B2: string; U: string; Pt: string; Q: string; LIT: string; R: string
  e: Record<string, string>
  o: Record<string, string>
  g: Record<string, string>
  share: { oK0: string; oG1: string }
}
let w: W

async function seedMain(): Promise<W> {
  const rec = new Recorder(sql)
  const A = await person(sql, 'A 本名')
  const B = await person(sql, 'B 本名')
  const B2 = await person(sql, 'B2 本名')
  const U = await person(sql, 'U 本名')
  const Pt = await person(sql, 'Pt 本名')
  const Q = await person(sql, 'Q 本名')
  const LIT = await person(sql, 'LIT 本名')
  const R = await person(sql, 'R 本名')
  await sql`UPDATE "Profiles" SET display_name = ${TOMB} WHERE id = ${LIT}` // named the literal before it was reserved

  // G: A and B; B left (G0 closed); A alone now (G1 open). B2 too, earlier.
  const G = await ledger(rec, sql, 'G', 'G', [
    { label: 'G00', start: '2025-10-01T00:00:00Z', end: '2025-12-01T00:00:00Z', a: A, b: B2 },
    { label: 'G0', start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z', a: A, b: B },
    { label: 'G1', start: '2026-03-01T00:00:00Z', end: null, a: A, b: null },
  ])
  await sql`UPDATE "GroupEpochs" SET member_a_name = 'A 本名', member_b_name = 'B 本名' WHERE id = ${G.epochs.G0}`
  // B2 named themself the literal back then: the slot reads it, unmarked.
  await sql`UPDATE "GroupEpochs" SET member_a_name = 'A 本名', member_b_name = ${TOMB} WHERE id = ${G.epochs.G00}`
  await ledger(rec, sql, 'H', 'H', [{ label: 'H0', start: '2026-03-01T00:00:00Z', end: null, a: B, b: null }])
  await ledger(rec, sql, 'H2', 'H2', [{ label: 'H20', start: '2025-12-01T00:00:00Z', end: null, a: B2, b: null }])

  // K: U and Pt, open; U also was member_b of Q's M0. U deletes below.
  const K = await ledger(rec, sql, 'K', 'K', [
    { label: 'K0', start: '2026-01-01T00:00:00Z', end: null, a: U, b: Pt },
  ])
  const M = await ledger(rec, sql, 'M', 'M', [
    { label: 'M0', start: '2025-06-01T00:00:00Z', end: '2025-12-01T00:00:00Z', a: Q, b: U },
    { label: 'M1', start: '2025-12-01T00:00:00Z', end: null, a: Q, b: null },
  ])
  await sql`UPDATE "GroupEpochs" SET member_a_name = 'Q 本名', member_b_name = 'U 本名' WHERE id = ${M.epochs.M0}`
  // N: LIT (named the literal) and R, open.
  const N = await ledger(rec, sql, 'N', 'N', [
    { label: 'N0', start: '2026-01-01T00:00:00Z', end: null, a: LIT, b: R },
  ])
  // U paid a cash row in K0 (exported below).
  await rec.ins('CashTransactions', 'uCash', {
    group_id: K.g, paid_by: U, amount: 1000, split_type: 'half', description: 'u paid',
    category: 'dining', transacted_at: new Date('2026-02-01T00:00:00Z'), created_at: new Date('2026-02-01T00:00:00Z'),
  })

  const outing = (label: string, g: string, epoch: string, by: string, share: string) =>
    rec.ins('Outings', label, {
      group_id: g, epoch_id: epoch, created_by: by, name: label, currency: 'twd', share_token_hash: hashToken(share),
    })
  const part = (label: string, o: string, name: string, profile: string | null) =>
    rec.ins('OutingParticipants', label, { outing_id: o, display_name: name, profile_id: profile })
  const share = { oK0: generateToken(), oG1: generateToken() }
  const oK0 = await outing('oK0', K.g, K.epochs.K0, Pt, share.oK0)
  const oG0 = await outing('oG0', G.g, G.epochs.G0, A, generateToken())
  const oG1 = await outing('oG1', G.g, G.epochs.G1, A, share.oG1)
  const o = {
    oK0, oG0, oG1,
    kU: await part('kU', oK0, 'U 本名', U),
    kPt: await part('kPt', oK0, 'Pt 本名', Pt),
    kGuestLiteral: await part('kGuestLiteral', oK0, TOMB, null), // a guest typed the literal long ago
    gA: await part('gA', oG0, 'A 本名', A),
    gB: await part('gB', oG0, 'B 本名', B),
    g1A: await part('g1A', oG1, 'A 本名', A),
  }

  await requestDeletion(sql, U)
  const [{ n }] = await sql<{ n: number }[]>`SELECT public.process_account_deletions() AS n`
  expect(n).toBe(1)

  return {
    A, B, B2, U, Pt, Q, LIT, R,
    e: { ...G.epochs, ...K.epochs, ...M.epochs, ...N.epochs },
    o,
    g: { G: G.g, K: K.g, M: M.g, N: N.g },
    share,
  }
}

beforeAll(async () => {
  if (!isLocalDb) return
  w = await seedMain()
})

afterAll(async () => {
  if (!isLocalDb) return
  await sql?.end()
  await dropStandInDb(adminUrl, standInUrl)
})

type R<T> = { ok: true; data: T } | { ok: false; code: string }
function ok<T>(r: R<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`)
  return r.data
}

describe.skipIf(!isLocalDb)('#1782 — 0099 backfill (seeded at 0098, deletion-written shapes only)', () => {
  it('Profiles: the tombstone of an account deleted before 0099 → true; a live literal and a no-auth other name → false', async () => {
    expect(await tombstone(bf.tomb)).toEqual({ t: true, name: TOMB })
    expect(await tombstone(bf.liveLiteral)).toEqual({ t: false, name: TOMB })
    expect(await tombstone(bf.noAuthOther)).toEqual({ t: false, name: 'BF no auth' })
  })

  it('GroupEpochs: the deleted member\'s slot → true; a live member frozen as the literal (still or since renamed) → false', async () => {
    expect(await epochMarks(bf.e.K0)).toMatchObject({ a: TOMB, al: true, b: 'BF P', bl: false })
    expect(await epochMarks(bf.e.M0)).toMatchObject({ a: TOMB, al: false, b: TOMB, bl: false })
    expect(await epochMarks(bf.e.N0)).toMatchObject({ a: 'BF Q', al: false, b: 'BF no auth', bl: false })
  })

  it('OutingParticipants: only the deletion scrub shape → true; pre-0083, anonymous / signed-in guests, released → false', async () => {
    expect(await slotMark(bf.o.tSlot)).toEqual({ name: TOMB, mark: true, profile_id: null })
    expect((await slotMark(bf.o.pre0083)).mark).toBe(false)
    expect((await slotMark(bf.o.anonGuest)).mark).toBe(false)
    expect((await slotMark(bf.o.signedGuest)).mark).toBe(false)
    expect((await slotMark(bf.o.released)).mark).toBe(false)
  })

  it('a second run of the backfill changes 0 rows', () => {
    expect(backfillRerun).toEqual({ statements: 4, changed: 0 })
  })
})

describe.skipIf(!isLocalDb)('#1782 — writers set the marker with the literal', () => {
  it('account deletion: every chapter slot, the outing slot and the tombstone are marked', async () => {
    expect(await epochMarks(w.e.K0)).toMatchObject({ a: TOMB, al: true, b: 'Pt 本名', bl: false })
    expect(await epochMarks(w.e.M0)).toMatchObject({ a: 'Q 本名', al: false, b: TOMB, bl: true })
    expect(await slotMark(w.o.kU)).toEqual({ name: TOMB, mark: true, profile_id: null })
    expect((await slotMark(w.o.kPt)).mark).toBe(false)
    expect(await slotMark(w.o.kGuestLiteral)).toMatchObject({ name: TOMB, mark: false })
    expect(await tombstone(w.U)).toEqual({ t: true, name: TOMB })
    expect(await tombstone(w.Pt)).toMatchObject({ t: false })
  })

  it('#1619: marks exactly the left ledger\'s slots; a second run is a no-op (0 / 0)', async () => {
    viewerId = w.B
    expect(await countMyNameInLeftLedgers(w.B)).toEqual({ chapters: 1, outings: 1 })
    expect(await P.hideMyNameInLeftLedgers()).toEqual({ ok: true, data: { chapters: 1, outings: 1 } })
    expect(await epochMarks(w.e.G0)).toMatchObject({ a: 'A 本名', al: false, b: TOMB, bl: true })
    expect(await slotMark(w.o.gB)).toEqual({ name: TOMB, mark: true, profile_id: w.B })
    expect((await slotMark(w.o.gA)).mark).toBe(false)
    expect(await countMyNameInLeftLedgers(w.B)).toEqual({ chapters: 0, outings: 0 })
    expect(await P.hideMyNameInLeftLedgers()).toEqual({ ok: true, data: { chapters: 0, outings: 0 } })
  })

  it('#1619: a slot that already reads the literal but is unmarked (the person chose it) is counted and marked', async () => {
    viewerId = w.B2
    expect(await epochMarks(w.e.G00)).toMatchObject({ b: TOMB, bl: false })
    expect(await countMyNameInLeftLedgers(w.B2)).toEqual({ chapters: 1, outings: 0 })
    expect(await P.hideMyNameInLeftLedgers()).toEqual({ ok: true, data: { chapters: 1, outings: 0 } })
    expect(await epochMarks(w.e.G00)).toMatchObject({ b: TOMB, bl: true })
  })

  it('snapshot trigger: a tombstone captured at a close carries the marker (INSERT closed, and UPDATE OF ended_at)', async () => {
    const [z] = await sql<{ id: string }[]>`
      INSERT INTO "OikosGroups" (name, member_a, member_b) VALUES ('Z', ${w.Pt}, NULL) RETURNING id`
    const [ins] = await sql<{ id: string }[]>`
      INSERT INTO "GroupEpochs" (group_id, started_at, ended_at, member_a_id, member_b_id)
      VALUES (${z.id}, '2024-01-01', '2024-02-01', ${w.Pt}, ${w.U}) RETURNING id`
    expect(await epochMarks(ins.id)).toMatchObject({ a: 'Pt 本名', al: false, b: TOMB, bl: true })
    const [open] = await sql<{ id: string }[]>`
      INSERT INTO "GroupEpochs" (group_id, started_at, member_a_id, member_b_id)
      VALUES (${z.id}, '2024-03-01', ${w.U}, ${w.Pt}) RETURNING id`
    expect(await epochMarks(open.id)).toMatchObject({ a: null, al: false, b: null, bl: false })
    await sql`UPDATE "GroupEpochs" SET ended_at = '2024-04-01' WHERE id = ${open.id}`
    expect(await epochMarks(open.id)).toMatchObject({ a: TOMB, al: true, b: 'Pt 本名', bl: false })
    // A re-close keeps the snapshot and its marker.
    await sql`UPDATE "GroupEpochs" SET ended_at = '2024-04-02' WHERE id = ${open.id}`
    expect(await epochMarks(open.id)).toMatchObject({ a: TOMB, al: true })
  })

  it('snapshot trigger: a live person named the literal is frozen unmarked', async () => {
    await sql`UPDATE "GroupEpochs" SET ended_at = now() WHERE id = ${w.e.N0}`
    expect(await epochMarks(w.e.N0)).toMatchObject({ a: TOMB, al: false, b: 'R 本名', bl: false })
  })
})

describe.skipIf(!isLocalDb)('#1782 — readers show the viewer\'s label for a marked slot only', () => {
  it('getEpochMembers → localizeChapterMembers: each language\'s label; the chapter identity has no initial', async () => {
    const raw = (await getEpochMembers(w.e.K0))!
    expect(raw.memberAName).toEqual({ name: TOMB, isLeftLabel: true })
    for (const label of Object.values(L)) {
      const c = localizeChapterMembers(raw, label)
      expect(c).toMatchObject({ memberAName: label, memberAIsLeftLabel: true, memberBName: 'Pt 本名', memberBIsLeftLabel: false })
      expect(buildChapterIdentity(c, w.Pt, '對方').partner).toEqual({
        id: w.U, displayName: label, initial: '', avatarUrl: null, isLeftLabel: true,
      })
    }
  })

  it('a person named the literal stays as written in every language, with their own initial', async () => {
    const raw = (await getEpochMembers(w.e.N0))!
    const c = localizeChapterMembers(raw, L.en)
    expect(c).toMatchObject({ memberAName: TOMB, memberAIsLeftLabel: false })
    expect(buildChapterIdentity(c, w.R, 'Partner').partner).toMatchObject({ displayName: TOMB, initial: '已', isLeftLabel: false })
  })

  it('past-times list rows carry the marker; the monthly-review payer reads the label', async () => {
    const list = await listEpochsForViewer(w.Pt)
    expect(list.find((e) => e.id === w.e.K0)).toMatchObject({ memberAName: { name: TOMB, isLeftLabel: true } })
    const c = localizeChapterMembers((await getEpochMembers(w.e.K0))!, L.ja)
    expect(resolveReviewPayerName(w.U, c, [])).toBe(L.ja)
    expect(resolveReviewPayerName(w.Pt, c, [])).toBe('Pt 本名')
  })

  it('CSV export: the chapter column and the person column read the export locale\'s label', async () => {
    const exp = await getLedgerExportForViewer(w.Pt, L.en)
    expect(exp.chapters.find((c) => c.id === w.e.K0)).toMatchObject({ memberAName: L.en, memberBName: 'Pt 本名' })
    const row = exp.rows.find((r) => r.description === 'u paid')
    expect(row).toMatchObject({ personName: L.en, chapter: { partnerName: L.en } })
  })

  it('dashboard outing list: the marked slot reads the label, a guest who typed the literal does not', async () => {
    const d = await loadOutingDetailRows(w.o.oK0, L.ja)
    expect(d.participants.find((p) => p.id === w.o.kU)).toMatchObject({ displayName: L.ja, isLeftLabel: true })
    expect(d.participants.find((p) => p.id === w.o.kGuestLiteral)).toMatchObject({ displayName: TOMB, isLeftLabel: false })
    expect(d.participants.find((p) => p.id === w.o.kPt)).toMatchObject({ displayName: 'Pt 本名', isLeftLabel: false })
  })

  it('public outing: translated on the server; the payload has only the isLeftLabel boolean, no tombstone field', async () => {
    const landing = (await getOutingLanding(w.share.oK0, L.en))!
    for (const s of landing.slots) expect(Object.keys(s).sort()).toEqual(['claim', 'displayName', 'id', 'isLeftLabel'])
    expect(landing.slots.find((s) => s.id === w.o.kU)).toMatchObject({ displayName: L.en, isLeftLabel: true })

    const full = await getOutingFullView(
      (await sql`SELECT id, group_id AS "groupId", epoch_id AS "epochId", status, name, currency FROM "Outings" WHERE id = ${w.o.oK0}`)[0] as never,
      { kind: 'participant', participantId: w.o.kPt, userId: null, via: 'cookie' } as never,
      L.ja,
    )
    for (const p of full.participants) {
      expect(Object.keys(p).sort()).toEqual(['active', 'claim', 'displayName', 'id', 'isLeftLabel', 'net'])
    }
    expect(full.participants.find((p) => p.id === w.o.kU)).toMatchObject({ displayName: L.ja, isLeftLabel: true })

    // The share page's server render (its props are the RSC payload).
    viewerId = ''
    cookieJar.clear()
    const page = await OutingSharePage({ params: Promise.resolve({ locale: 'en', shareToken: w.share.oK0 }) })
    const payload = JSON.stringify(page)
    expect(payload).toContain(L.en)
    expect(payload).toContain('"isLeftLabel":true')
    expect(payload).not.toMatch(/[Tt]ombstone|_is_left_label|NameIsLeftLabel|profileId|profile_id|claimTokenHash/)
  })
})

describe.skipIf(!isLocalDb)('#1782 — function hygiene and grants after 0099', () => {
  it('both functions keep SECURITY, search_path, owner; anon / authenticated cannot execute them', async () => {
    const rows = await sql<{ f: string; sd: boolean; cfg: string[]; owner: string; anon: boolean; auth: boolean; svc: boolean }[]>`
      SELECT p.proname AS f, p.prosecdef AS sd, p.proconfig AS cfg, pg_get_userbyid(p.proowner) AS owner,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
      FROM pg_proc p
      WHERE p.oid IN ('public.process_account_deletions()'::regprocedure, 'public.snapshot_epoch_member_names()'::regprocedure)
      ORDER BY 1`
    expect(rows).toEqual([
      { f: 'process_account_deletions', sd: true, cfg: ['search_path=public, pg_temp'], owner: 'postgres', anon: false, auth: false, svc: true },
      { f: 'snapshot_epoch_member_names', sd: false, cfg: ['search_path=public, pg_temp'], owner: 'postgres', anon: false, auth: false, svc: true },
    ])
  })

  it('anon / authenticated hold no privilege on the four new columns (0080 post-check query)', async () => {
    const rows = await sql`
      SELECT c.relname, r.role, a.attname
        FROM pg_class c
        CROSS JOIN (VALUES ('anon'), ('authenticated')) r(role)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
         AND a.attname IN ('member_a_name_is_left_label', 'member_b_name_is_left_label', 'display_name_is_left_label', 'is_tombstone')
         AND has_column_privilege(r.role, c.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES')`
    expect(rows).toEqual([])
    // Positive control: the columns exist where expected.
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN (('GroupEpochs', 'member_a_name_is_left_label'), ('GroupEpochs', 'member_b_name_is_left_label'),
                                           ('OutingParticipants', 'display_name_is_left_label'), ('Profiles', 'is_tombstone'))
         AND is_nullable = 'NO' AND column_default = 'false'`
    expect(n).toBe(4)
  })
})

describe.skipIf(!isLocalDb)('#1782 (a) — reserved names', () => {
  const blocked = [
    L.zhTW, L.zhCN, L.en, L.ja,
    '已離开的伙伴', '已离開的夥伴', '已离开的夥伴', // mixed traditional / simplified
    '已離​開的夥伴', '‍已離開的夥伴', '已離開﻿的夥伴', '‮已離開的夥伴', '已離開的夥伴­', // invisible / bidi
    '  A  Partner   who LEFT ', 'ａ ｐａｒｔｎｅｒ ｗｈｏ ｌｅｆｔ', '退出したﾊﾟｰﾄﾅｰ', // whitespace, case, NFKC
  ]

  it('updateDisplayName refuses every bypass with display_name_reserved and leaves the name alone', async () => {
    viewerId = w.A
    const [before] = await sql`SELECT display_name FROM "Profiles" WHERE id = ${w.A}`
    for (const name of blocked) {
      expect(await P.updateDisplayName(name)).toEqual({ ok: false, code: RESERVED_CODE })
    }
    const [after] = await sql`SELECT display_name FROM "Profiles" WHERE id = ${w.A}`
    expect(after).toEqual(before)
  })

  it('updateDisplayName stores a ZWJ emoji name exactly as typed, and a name that only contains the label', async () => {
    viewerId = w.A
    for (const name of ['Ray 👨‍💻', '👩‍👩‍👧', '已離開的夥伴們']) {
      expect(await P.updateDisplayName(name)).toEqual({ ok: true, data: { ok: true } })
      const [r] = await sql<{ display_name: string }[]>`SELECT display_name FROM "Profiles" WHERE id = ${w.A}`
      expect(r.display_name).toBe(name)
    }
    ok(await P.updateDisplayName('A 本名'))
  })

  it('addOutingParticipant and the signed-out joinOuting refuse a reserved name; a ZWJ emoji name is stored as typed', async () => {
    viewerId = w.A
    for (const name of [L.zhTW, '已離​開的夥伴', L.ja]) {
      expect(await O.addOutingParticipant({ outingId: w.o.oG1, displayName: name })).toEqual({ ok: false, code: RESERVED_CODE })
    }
    viewerId = ''
    cookieJar.clear()
    for (const name of [L.en, '已离開的夥伴']) {
      expect(await O.joinOuting({ shareToken: w.share.oG1, displayName: name })).toEqual({ ok: false, code: RESERVED_CODE })
    }
    const joined = ok(await O.joinOuting({ shareToken: w.share.oG1, displayName: '小美 👩‍🍳' }))
    expect(await slotMark(joined.participantId)).toMatchObject({ name: '小美 👩‍🍳', mark: false })
  })

  it('createOuting: a member whose profile name is reserved joins the list under the generic name', async () => {
    await sql`UPDATE "GroupEpochs" SET ended_at = NULL, member_a_name = NULL, member_b_name = NULL WHERE id = ${w.e.N0}`
    viewerId = w.R
    const { id } = ok(await O.createOuting({ name: 'N 出遊' }))
    const rows = await sql<{ name: string; profile_id: string; mark: boolean }[]>`
      SELECT display_name AS name, profile_id, display_name_is_left_label AS mark FROM "OutingParticipants" WHERE outing_id = ${id} ORDER BY display_name`
    expect(rows.find((r) => r.profile_id === w.LIT)).toEqual({ name: '成員', profile_id: w.LIT, mark: false })
    expect(rows.find((r) => r.profile_id === w.R)).toMatchObject({ name: 'R 本名' })
  })

  it('handle_new_user: a reserved provider name falls back to the email; anything else is kept as given', async () => {
    const cases: [string, string | null][] = [
      [L.zhTW, null], [L.zhCN, null], [L.en.toUpperCase(), null], [L.ja, null],
      ['已離​開的伙伴', null], [' a  partner who left ', null], [' Partner  who left ', null], ['退出したﾊﾟｰﾄﾅｰ', null],
      ['Dev 👨‍💻', 'Dev 👨‍💻'], ['已離開的夥伴 小明', '已離開的夥伴 小明'], ['己離開的夥伴', '己離開的夥伴'],
    ]
    for (const [name, expected] of cases) {
      const [{ id }] = await sql<{ id: string }[]>`SELECT gen_random_uuid() AS id`
      const email = `${id}@example.invalid`
      await sql`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (${id}, ${email}, jsonb_build_object('full_name', ${name}::text))`
      const [p] = await sql<{ display_name: string }[]>`SELECT display_name FROM "Profiles" WHERE id = ${id}`
      expect([name, p.display_name]).toEqual([name, expected ?? email])
    }
    const [f] = await sql<{ cfg: string[]; sd: boolean; anon: boolean; auth: boolean }[]>`
      SELECT proconfig AS cfg, prosecdef AS sd,
             has_function_privilege('anon', oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', oid, 'EXECUTE') AS auth
      FROM pg_proc WHERE oid = 'public.handle_new_user()'::regprocedure`
    expect(f).toEqual({ cfg: ['search_path=public, pg_temp'], sd: true, anon: false, auth: false })
  })
})
