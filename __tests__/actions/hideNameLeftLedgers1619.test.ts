// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'
import { Recorder, TOMB, ledger, person, requestDeletion } from './_deletionWorld1701'
import { openTx, sqlstate, waitLockWaiters } from './_lockHarness'

// ─── #1619: hide my name in the ledgers I left ─────────────────────────────
//
// `hideMyNameInLeftLedgers()` (actions/profile.ts → hideNameInLeftLedgers in
// lib/db/queries/epoch.ts) against a real Postgres: a stand-in database
// migrated through the latest migration, the real action, the real pages that
// decide whether the entry row shows.
//
// What it guards (failure looks like: nothing errors):
//   - too wide: a stayer, or someone who came back to the ledger, renames
//     themself in a chapter of a ledger they are still in; the leaver's
//     current ledger or a friend slot they took later through the share link
//     changes too;
//   - too narrow: the leaver's name stays in a chapter they asked to leave it
//     out of (a NULL snapshot, the slot next to a deleted account's tombstone);
//   - lock order: the action and process_account_deletions for the same
//     person deadlock (40P01) — 0096 renames OutingParticipants before
//     GroupEpochs, the opposite of the action, unless the action takes the
//     person's Profiles row first.
//
// LOCAL THROWAWAY SERVER ONLY. Skips itself unless DATABASE_URL is localhost:
//
//   docker run -d --name pg-1619 -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55619:5432 postgres:17
//   DATABASE_URL=postgres://postgres:pg@127.0.0.1:55619/postgres \
//   DATABASE_URL_DIRECT=postgres://postgres:pg@127.0.0.1:55619/postgres \
//     npx vitest run __tests__/actions/hideNameLeftLedgers1619.test.ts
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
  getCurrentUser: async () => (viewerId ? { id: viewerId, email: 'v-1619@example.invalid' } : null),
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: viewerId ? { id: viewerId } : null }, error: null }) },
  }),
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {},
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
const captured: { event: string; props: unknown }[] = []
vi.mock('@/lib/analytics/server', () => ({
  captureServer: async (_id: string, event: string, props?: unknown) => { captured.push({ event, props }) },
  isUserFirstNonDeletedRecord: async () => false,
}))

// The app talks to the stand-in database, never to what .env.local points at.
const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)
let standInUrl = ''
if (isLocalDb) {
  const journal = JSON.parse(readFileSync(resolve(__dirname, '../../drizzle/meta/_journal.json'), 'utf-8')) as {
    entries: { tag: string }[]
  }
  standInUrl = await createStandInDb(adminUrl, journal.entries[journal.entries.length - 1].tag.slice(0, 4))
  process.env.DATABASE_URL = standInUrl
  process.env.DATABASE_URL_DIRECT = standInUrl
}

const postgres = (await import('postgres')).default
const { hideMyNameInLeftLedgers } = await import('@/actions/profile')
const { countMyNameInLeftLedgers, listEpochsForViewer } = await import('@/lib/db/queries/epoch')
const { getLedgerExportForViewer } = await import('@/lib/db/queries/export')
const { default: SettingsPastTimesPage } = await import('@/app/(dashboard)/settings/past-times/page')
const { default: OnboardingPastTimesPage } = await import('@/app/onboarding/past-times/page')
const { HideNameInLeftLedgers } = await import('@/app/(dashboard)/settings/past-times/_components/HideNameInLeftLedgers')

/** The HideNameInLeftLedgers element in a server render, or null. */
function findEntry(node: unknown, depth = 0): { chapters: number; outings: number } | null {
  if (!node || typeof node !== 'object' || depth > 40) return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findEntry(n, depth + 1)
      if (hit) return hit
    }
    return null
  }
  const el = node as { type?: unknown; props?: { children?: unknown } & Record<string, unknown> }
  if (el.type === HideNameInLeftLedgers) return el.props as unknown as { chapters: number; outings: number }
  return el.props ? findEntry(el.props.children, depth + 1) : null
}

let sql: Sql
const NAME = { A: 'A 本名', B: 'B 本名', R: 'R 本名', S: 'S 本名', X: 'X 本名', Y: 'Y 本名' }

interface W {
  A: string; B: string; D: string; D2: string; R: string; S: string; X: string; Y: string
  e: Record<string, string>
  o: Record<string, string>
}
let w: W

/** member_a_name / member_b_name of a chapter. */
async function names(epochId: string) {
  const [r] = await sql<{ a: string | null; b: string | null; a_id: string; b_id: string | null; ended_at: Date | null }[]>`
    SELECT member_a_name AS a, member_b_name AS b, member_a_id AS a_id, member_b_id AS b_id, ended_at
    FROM "GroupEpochs" WHERE id = ${epochId}`
  return r
}
async function slot(id: string) {
  const [r] = await sql<{ display_name: string; profile_id: string | null; claim_token_hash: string | null; claimed_at: Date | null }[]>`
    SELECT display_name, profile_id, claim_token_hash, claimed_at FROM "OutingParticipants" WHERE id = ${id}`
  return r
}
/** Every GroupEpochs / OutingParticipants row, for "nothing else changed". */
async function snapshot() {
  const e = await sql`SELECT id, member_a_name, member_b_name, ended_at FROM "GroupEpochs" ORDER BY id`
  const p = await sql`SELECT id, display_name, profile_id, claim_token_hash, claimed_at FROM "OutingParticipants" ORDER BY id`
  return JSON.stringify({ e, p })
}

async function setNames(epochId: string, a: string | null, b: string | null) {
  await sql`UPDATE "GroupEpochs" SET member_a_name = ${a}, member_b_name = ${b} WHERE id = ${epochId}`
}

beforeAll(async () => {
  if (!isLocalDb) return
  sql = postgres(standInUrl, { max: 4, onnotice: () => {} })
  const rec = new Recorder(sql)
  const A = await person(sql, NAME.A)
  const B = await person(sql, NAME.B)
  const D = await person(sql, 'D 本名')   // stayer of M, deletes their account → M is an orphan
  const D2 = await person(sql, 'D2 本名') // B's partner in B's current ledger H
  const R = await person(sql, NAME.R)     // left K, came back
  const S = await person(sql, NAME.S)
  const X = await person(sql, NAME.X)     // removed from N, no ledger of their own
  const Y = await person(sql, NAME.Y)

  // G: B started it alone (G0, closed with no snapshot), A joined (G1), B
  // left (G1 closed), A alone now (G2, open).
  const G = await ledger(rec, sql, 'G', 'G', [
    { label: 'G0', start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z', a: B, b: null },
    { label: 'G1', start: '2026-02-01T00:00:00Z', end: '2026-05-01T00:00:00Z', a: B, b: A },
    { label: 'G2', start: '2026-05-01T00:00:00Z', end: null, a: A, b: null },
  ])
  await setNames(G.epochs.G1, NAME.B, NAME.A)
  // H: B's own ledger now — a closed solo chapter, then D2 joined (open).
  const H = await ledger(rec, sql, 'H', 'H', [
    { label: 'H0', start: '2026-05-01T00:00:00Z', end: '2026-06-01T00:00:00Z', a: B, b: null },
    { label: 'H1', start: '2026-06-01T00:00:00Z', end: null, a: B, b: D2 },
  ])
  await setNames(H.epochs.H0, NAME.B, null)
  // M: D and B; B left (B in the member_b slot); D alone after; D deletes
  // their account below, so M becomes an orphan ledger (0096) whose closed
  // chapter keeps D's tombstone.
  const M = await ledger(rec, sql, 'M', 'M', [
    { label: 'M0', start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z', a: D, b: B },
    { label: 'M1', start: '2026-03-01T00:00:00Z', end: null, a: D, b: null },
  ])
  await setNames(M.epochs.M0, 'D 本名', NAME.B)
  // K: R and S; R left (K1 S alone, closed); R came back (K2, open). R also
  // has a ledger of their own (L): a current member of two ledgers.
  const K = await ledger(rec, sql, 'K', 'K', [
    { label: 'K0', start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z', a: R, b: S },
    { label: 'K1', start: '2026-02-01T00:00:00Z', end: '2026-03-01T00:00:00Z', a: S, b: null },
    { label: 'K2', start: '2026-03-01T00:00:00Z', end: null, a: R, b: S },
  ])
  await setNames(K.epochs.K0, NAME.R, NAME.S)
  await setNames(K.epochs.K1, NAME.S, null)
  const L = await ledger(rec, sql, 'L', 'L', [
    { label: 'L0', start: '2026-02-01T00:00:00Z', end: null, a: R, b: null },
  ])
  // N: Y removed X; X has no ledger.
  const N = await ledger(rec, sql, 'N', 'N', [
    { label: 'N0', start: '2026-01-01T00:00:00Z', end: '2026-04-01T00:00:00Z', a: Y, b: X },
    { label: 'N1', start: '2026-04-01T00:00:00Z', end: null, a: Y, b: null },
  ])
  await setNames(N.epochs.N0, NAME.Y, NAME.X)

  // Outings. oG1: shared chapter G1 (A, B, a friend). oG2: A's later chapter,
  // B took a friend slot through the share link (claimed, profile bound).
  // oH0: B's current ledger. oM0: shared chapter of the orphan ledger. oN0: X's.
  const outing = (label: string, g: string, epoch: string, by: string) =>
    rec.ins('Outings', label, { group_id: g, epoch_id: epoch, created_by: by, name: label, currency: 'twd' })
  const part = (label: string, o: string, name: string, profile: string | null, extra: Record<string, unknown> = {}) =>
    rec.ins('OutingParticipants', label, { outing_id: o, display_name: name, profile_id: profile, ...extra })
  const oG1 = await outing('oG1', G.g, G.epochs.G1, A)
  const oG2 = await outing('oG2', G.g, G.epochs.G2, A)
  const oH0 = await outing('oH0', H.g, H.epochs.H0, B)
  const oM0 = await outing('oM0', M.g, M.epochs.M0, D)
  const oN0 = await outing('oN0', N.g, N.epochs.N0, Y)
  const o = {
    gA: await part('gA', oG1, NAME.A, A),
    gB: await part('gB', oG1, NAME.B, B),
    gFriend: await part('gFriend', oG1, '朋友', null),
    g2A: await part('g2A', oG2, NAME.A, A),
    g2BFriend: await part('g2BFriend', oG2, 'B 用連結加入', B, {
      claim_token_hash: 'hash-1619-b', claimed_at: new Date('2026-05-10T00:00:00Z'),
    }),
    hB: await part('hB', oH0, NAME.B, B),
    mD: await part('mD', oM0, 'D 本名', D),
    mB: await part('mB', oM0, NAME.B, B),
    nX: await part('nX', oN0, NAME.X, X),
    nY: await part('nY', oN0, NAME.Y, Y),
  }

  // D deletes their account: M becomes an orphan, D's slots read TOMB.
  await requestDeletion(sql, D)
  await sql`SELECT public.process_account_deletions()`

  w = {
    A, B, D, D2, R, S, X, Y,
    e: { ...G.epochs, ...H.epochs, ...M.epochs, ...K.epochs, ...N.epochs, L0: L.epochs.L0 },
    o,
  }
})

afterAll(async () => {
  if (!isLocalDb) return
  await sql?.end()
  // The app's own pool still holds connections; DROP … WITH (FORCE) ends them.
  await dropStandInDb(adminUrl, standInUrl)
})

describe.skipIf(!isLocalDb)('#1619 hideMyNameInLeftLedgers — local stand-in DB', () => {
  it('the orphan ledger is set up as 0096 leaves it: D is a tombstone named 「已離開的夥伴」', async () => {
    expect(await names(w.e.M0)).toMatchObject({ a: TOMB, b: NAME.B })
    expect(await slot(w.o.mD)).toMatchObject({ display_name: TOMB, profile_id: null })
  })

  it('signed out: refused, nothing changes', async () => {
    viewerId = ''
    const before = await snapshot()
    await expect(hideMyNameInLeftLedgers()).rejects.toThrow('Unauthorized')
    expect(await snapshot()).toBe(before)
  })

  it('the stayer (A) gets 0 / 0 and the entry is hidden; nothing changes', async () => {
    viewerId = w.A
    expect(await countMyNameInLeftLedgers(w.A)).toEqual({ chapters: 0, outings: 0 })
    expect(findEntry(await SettingsPastTimesPage())).toBeNull()
    const before = await snapshot()
    expect(await hideMyNameInLeftLedgers()).toEqual({ ok: true, data: { chapters: 0, outings: 0 } })
    expect(await snapshot()).toBe(before)
  })

  it('someone who left and came back (R, member of two ledgers) gets 0 / 0', async () => {
    viewerId = w.R
    expect(await countMyNameInLeftLedgers(w.R)).toEqual({ chapters: 0, outings: 0 })
    const before = await snapshot()
    expect(await hideMyNameInLeftLedgers()).toEqual({ ok: true, data: { chapters: 0, outings: 0 } })
    expect(await snapshot()).toBe(before)
    expect(await names(w.e.K0)).toMatchObject({ a: NAME.R, b: NAME.S })
  })

  it('the leaver (B): entry shows the count; the run changes exactly the left ledgers\' closed chapters and their outing slots', async () => {
    viewerId = w.B
    // G0 (NULL snapshot), G1 (member_a), M0 (member_b, next to the tombstone);
    // outing slots gB (G1) and mB (M0).
    expect(await countMyNameInLeftLedgers(w.B)).toEqual({ chapters: 3, outings: 2 })
    expect(findEntry(await SettingsPastTimesPage())).toEqual({ chapters: 3, outings: 2 })

    const untouched = {
      G2: await names(w.e.G2), H0: await names(w.e.H0), H1: await names(w.e.H1),
      g2BFriend: await slot(w.o.g2BFriend), hB: await slot(w.o.hB), gA: await slot(w.o.gA),
      gFriend: await slot(w.o.gFriend), mD: await slot(w.o.mD), gBBefore: await slot(w.o.gB),
    }
    captured.length = 0
    expect(await hideMyNameInLeftLedgers()).toEqual({ ok: true, data: { chapters: 3, outings: 2 } })

    // Closed chapters of the ledgers B left: B's slot only.
    expect(await names(w.e.G0)).toMatchObject({ a: TOMB, b: null, a_id: w.B }) // NULL snapshot written
    expect(await names(w.e.G1)).toMatchObject({ a: TOMB, b: NAME.A })
    expect(await names(w.e.M0)).toMatchObject({ a: TOMB, b: TOMB, a_id: w.D, b_id: w.B }) // tombstone slot as it was
    // ended_at never written (the snapshot trigger fires on it).
    expect((await names(w.e.G1)).ended_at?.toISOString()).toBe('2026-05-01T00:00:00.000Z')

    // B's current ledger, open or closed: unchanged.
    expect(await names(w.e.G2)).toEqual(untouched.G2)
    expect(await names(w.e.H0)).toEqual(untouched.H0)
    expect(await names(w.e.H1)).toEqual(untouched.H1)
    expect(await slot(w.o.hB)).toEqual(untouched.hB)

    // Outing slots of those chapters: name only; still B's slot.
    expect(await slot(w.o.gB)).toEqual({ ...untouched.gBBefore, display_name: TOMB })
    expect(await slot(w.o.gB)).toMatchObject({ profile_id: w.B })
    expect(await slot(w.o.mB)).toMatchObject({ display_name: TOMB, profile_id: w.B })
    // The friend slot B took in a later chapter of G, and everyone else: unchanged.
    expect(await slot(w.o.g2BFriend)).toEqual(untouched.g2BFriend)
    expect(await slot(w.o.gA)).toEqual(untouched.gA)
    expect(await slot(w.o.gFriend)).toEqual(untouched.gFriend)
    expect(await slot(w.o.mD)).toEqual(untouched.mD)

    // Analytics: counts only.
    expect(captured).toEqual([{ event: 'left_ledger_name_hidden', props: { chapters: 3, outings: 2 } }])
  })

  it('the stayer now reads 「已離開的夥伴」 for B in the shared chapter (past-times list and CSV export)', async () => {
    const list = await listEpochsForViewer(w.A)
    const g1 = list.find((e) => e.id === w.e.G1)
    expect(g1).toMatchObject({ memberAName: { name: TOMB, isLeftLabel: true }, memberBName: { name: NAME.A, isLeftLabel: false } })
    const exp = await getLedgerExportForViewer(w.A, '已離開的夥伴')
    const ch = exp.chapters.find((c) => c.id === w.e.G1)
    expect(ch).toMatchObject({ memberAName: TOMB, memberBName: NAME.A })
  })

  it('a second run is 0 / 0, changes nothing, and the entry is gone', async () => {
    viewerId = w.B
    const before = await snapshot()
    expect(await countMyNameInLeftLedgers(w.B)).toEqual({ chapters: 0, outings: 0 })
    expect(await hideMyNameInLeftLedgers()).toEqual({ ok: true, data: { chapters: 0, outings: 0 } })
    expect(await snapshot()).toBe(before)
    expect(findEntry(await SettingsPastTimesPage())).toBeNull()
  })

  it('a removed person with no ledger (X): /onboarding/past-times shows the entry; the run changes their slot only', async () => {
    viewerId = w.X
    expect(findEntry(await OnboardingPastTimesPage())).toEqual({ chapters: 1, outings: 1 })
    expect(await hideMyNameInLeftLedgers()).toEqual({ ok: true, data: { chapters: 1, outings: 1 } })
    expect(await names(w.e.N0)).toMatchObject({ a: NAME.Y, b: TOMB })
    expect(await slot(w.o.nX)).toMatchObject({ display_name: TOMB, profile_id: w.X })
    expect(await slot(w.o.nY)).toMatchObject({ display_name: NAME.Y, profile_id: w.Y })
    expect(findEntry(await OnboardingPastTimesPage())).toBeNull()
  })

  describe('same person: the action and process_account_deletions together never deadlock', () => {
    /** A person P who left ledger LP (partner Q stays) and has their own solo ledger; P's deletion is due. */
    async function leaverDueForDeletion(tag: string) {
      const rec = new Recorder(sql)
      const P = await person(sql, `${tag} P`)
      const Q = await person(sql, `${tag} Q`)
      const LP = await ledger(rec, sql, `${tag}LP`, 'LP', [
        { label: 'LP0', start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z', a: Q, b: P },
        { label: 'LP1', start: '2026-03-01T00:00:00Z', end: null, a: Q, b: null },
      ])
      await setNames(LP.epochs.LP0, `${tag} Q`, `${tag} P`)
      await ledger(rec, sql, `${tag}OWN`, 'OWN', [
        { label: 'OWN0', start: '2026-03-01T00:00:00Z', end: null, a: P, b: null },
      ])
      const o = await rec.ins('Outings', `${tag}o`, { group_id: LP.g, epoch_id: LP.epochs.LP0, created_by: Q, name: 'o', currency: 'twd' })
      const pSlot = await rec.ins('OutingParticipants', `${tag}pP`, { outing_id: o, display_name: `${tag} P`, profile_id: P })
      await requestDeletion(sql, P)
      return { P, LP0: LP.epochs.LP0, pSlot }
    }

    it('action first (held mid-transaction on its outing write): the job waits for it; both finish', async () => {
      const s = await leaverDueForDeletion('c1')
      const holder = postgres(standInUrl, { max: 1, onnotice: () => {} })
      const job = postgres(standInUrl, { max: 1, onnotice: () => {} })
      const monitor = postgres(standInUrl, { max: 1, onnotice: () => {} })
      try {
        // Hold P's outing slot so the action stops after its GroupEpochs writes,
        // with P's Profiles row already locked.
        const h = await openTx(holder)
        await h.run((t) => t`SELECT 1 FROM "OutingParticipants" WHERE id = ${s.pSlot} FOR UPDATE`)
        viewerId = s.P
        const act = hideMyNameInLeftLedgers()
        act.catch(() => {})
        await waitLockWaiters(monitor, 1)
        const jobDone = job`SELECT public.process_account_deletions() AS n`
        jobDone.catch(() => {})
        await waitLockWaiters(monitor, 2) // the job queues behind the action on P's Profiles row
        await h.commit()
        const [a, j] = await Promise.allSettled([act, jobDone])
        expect(a.status === 'rejected' ? sqlstate(a.reason) : null).toBeNull()
        expect(j.status === 'rejected' ? sqlstate(j.reason) : null).toBeNull()
        expect(a).toMatchObject({ status: 'fulfilled', value: { ok: true, data: { chapters: 1, outings: 1 } } })
        expect(j.status).toBe('fulfilled')
        // P is gone; their slot reads TOMB either way.
        expect(await names(s.LP0)).toMatchObject({ b: TOMB })
        const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.users WHERE id = ${s.P}`
        expect(n).toBe(0)
      } finally {
        await Promise.all([holder.end(), job.end(), monitor.end()])
      }
    })

    // The order that deadlocks without the action's Profiles lock: the job
    // holds P's Profiles row and waits on P's outing slot; an action that
    // went straight to its writes would lock LP0, then queue on the slot
    // behind the job, and the job's next write (LP0) closes the cycle → 40P01.
    it('job first (held mid-job at P\'s outing slot): the action waits at P\'s Profiles row, then finds the account gone', async () => {
      const s = await leaverDueForDeletion('c2')
      const holder = postgres(standInUrl, { max: 1, onnotice: () => {} })
      const job = postgres(standInUrl, { max: 1, onnotice: () => {} })
      const monitor = postgres(standInUrl, { max: 1, onnotice: () => {} })
      try {
        const h = await openTx(holder)
        await h.run((t) => t`SELECT 1 FROM "OutingParticipants" WHERE id = ${s.pSlot} FOR UPDATE`)
        const jobDone = job`SELECT public.process_account_deletions() AS n`
        jobDone.catch(() => {})
        await waitLockWaiters(monitor, 1) // the job, P's Profiles row held, at P's outing slot
        viewerId = s.P
        const act = hideMyNameInLeftLedgers()
        act.catch(() => {})
        await waitLockWaiters(monitor, 2) // the action, behind the job
        await h.commit()
        const [a, j] = await Promise.allSettled([act, jobDone])
        expect(a.status === 'rejected' ? sqlstate(a.reason) : null).toBeNull()
        expect(j.status === 'rejected' ? sqlstate(j.reason) : null).toBeNull()
        expect(j.status).toBe('fulfilled')
        expect(a).toMatchObject({ status: 'fulfilled', value: { ok: false, code: 'profile_not_found' } })
        expect(await names(s.LP0)).toMatchObject({ b: TOMB })
      } finally {
        await Promise.all([holder.end(), job.end(), monitor.end()])
      }
    })
  })
})
