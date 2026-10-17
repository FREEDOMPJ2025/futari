import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'
import {
  KEPT_AFTER_D, Recorder, TOMB, cash, ledger, ledgerRowCounts, person, requestDeletion, world,
  type World,
} from './_deletionWorld1701'

// ─── 0096: the stayer's account deletion keeps the shared chapter (#1701) ───
//
// LOCAL THROWAWAY SERVER ONLY. DATABASE_URL must point at a local Postgres 17
// server; the suite creates fresh Supabase stand-in databases on it
// (createStandInDb, migrated through 0096) and drops them at the end. It
// skips itself unless DATABASE_URL is localhost — never dev or prod.
//
//   DATABASE_URL=postgres://postgres:<pw>@localhost:<port>/postgres \
//   DATABASE_URL_DIRECT=<same> \
//     npx vitest run __tests__/actions/deletionKeepsChapter1701.test.ts
//
// Run stand-in suites one file at a time (`--no-file-parallelism` when
// naming several): two createStandInDb migrating at once collide on the
// cluster-wide `ALTER ROLE futari_app` (`tuple concurrently updated`).
//
// Every case goes through the real job, `process_account_deletions()` (what
// pg_cron runs), and reads the WARNINGs it raises: the job never fails, a
// broken user only shows up as `process_account_deletions: failed for …`.
// Plan acceptance a–j and the rollback test of plan-1701 (S1); (k) is
// deletionKeepsChapter1701.fk.test.ts.
//
// Failure this guards: nothing errors. Either X opens 「過去的時光」 and the
// chapter with D is gone (the 0088 cascade), or an orphan keeps something X
// never saw (an ID number, an import file, D's records after X left), or D's
// account is still there 14 days later with a daily WARNING.
// ──────────────────────────────────────────────────────────────────────────────

const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)

const postgres = (await import('postgres')).default
const read = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf-8')

let url = ''
let pg: Sql
let warnings: string[] = []

async function connect(u: string): Promise<Sql> {
  return postgres(u, {
    max: 1,
    onnotice: (n) => {
      if (n.severity === 'WARNING') warnings.push(String(n.message))
    },
  })
}

/** The cron job's call. Returns how many users it deleted and the WARNINGs. */
async function runJob(): Promise<{ n: number; warnings: string[] }> {
  warnings = []
  const [{ n }] = await pg<{ n: number }[]>`SELECT public.process_account_deletions() AS n`
  return { n, warnings: [...warnings] }
}

async function sweep(): Promise<{ n: number; warnings: string[] }> {
  warnings = []
  const [{ n }] = await pg<{ n: number }[]>`SELECT public.sweep_orphan_ledgers() AS n`
  return { n, warnings: [...warnings] }
}

const tag = () => `T1701_${randomUUID().slice(0, 8)}`

async function authExists(id: string) {
  const [{ n }] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.users WHERE id = ${id}`
  return n > 0
}
async function profileOf(id: string) {
  const rows = await pg<{ display_name: string; avatar_url: string | null; deletion_requested_at: Date | null }[]>`
    SELECT display_name, avatar_url, deletion_requested_at FROM "Profiles" WHERE id = ${id}`
  return rows[0]
}

/** Every at-rest field the orphan must not hold (acceptance g). Zero each. */
async function atRest(g: string): Promise<Record<string, number>> {
  const q = async (s: ReturnType<typeof pg>) => ((await s) as unknown as { n: number }[])[0].n
  const assetIds = pg`SELECT id FROM "Assets" WHERE group_id = ${g}`
  return {
    assetEncrypted: await q(pg`SELECT count(*)::int AS n FROM "Assets" WHERE group_id = ${g}
      AND (name_encrypted IS NOT NULL OR notes IS NOT NULL OR template_fields IS NOT NULL)`),
    details: await q(pg`SELECT (
        (SELECT count(*) FROM "CarDetails" WHERE asset_id IN (${assetIds}))
      + (SELECT count(*) FROM "HouseDetails" WHERE asset_id IN (${assetIds}))
      + (SELECT count(*) FROM "ChildDetails" WHERE asset_id IN (${assetIds}))
      + (SELECT count(*) FROM "PetDetails" WHERE asset_id IN (${assetIds}))
      + (SELECT count(*) FROM "PlantDetails" WHERE asset_id IN (${assetIds}))
      + (SELECT count(*) FROM "InsuranceDetails" WHERE asset_id IN (${assetIds})))::int AS n`),
    importBatches: await q(pg`SELECT count(*)::int AS n FROM "ImportBatches" WHERE group_id = ${g}`),
    importErrors: await q(pg`SELECT count(*)::int AS n FROM "ImportErrors" e
      JOIN "ImportBatches" b ON b.id = e.batch_id WHERE b.group_id = ${g}`),
    importLinks: await q(pg`SELECT ((SELECT count(*) FROM "CashTransactions" WHERE group_id = ${g} AND import_batch_id IS NOT NULL)
      + (SELECT count(*) FROM "IncomeTransactions" WHERE group_id = ${g} AND import_batch_id IS NOT NULL))::int AS n`),
    shareTokens: await q(pg`SELECT count(*)::int AS n FROM "Outings" WHERE group_id = ${g}
      AND (share_token_hash IS NOT NULL OR share_token_encrypted IS NOT NULL)`),
    currencyRates: await q(pg`SELECT count(*)::int AS n FROM "CurrencyRates" WHERE group_id = ${g}`),
    invites: await q(pg`SELECT count(*)::int AS n FROM "GroupInvites" WHERE group_id = ${g}`),
    invoice: await q(pg`SELECT ((SELECT count(*) FROM "InvoiceCredentials" WHERE group_id = ${g})
      + (SELECT count(*) FROM "InvoiceImportRuns" WHERE group_id = ${g})
      + (SELECT count(*) FROM "InvoiceImportSnapshots" WHERE group_id = ${g}))::int AS n`),
    quiz: await q(pg`SELECT count(*)::int AS n FROM "PartnerQuizSessions" WHERE group_id = ${g}`),
    pushTokens: await q(pg`SELECT count(*)::int AS n FROM "PushTokens" WHERE group_id = ${g}`),
    tripExpensesOutsideKept: await q(pg`SELECT count(*)::int AS n FROM "TripExpenses" te
      JOIN "Trips" t ON t.id = te.trip_id
      WHERE t.group_id = ${g}
        AND NOT EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = t.epoch_id AND k.ended_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id IN (k.member_a_id, k.member_b_id)))`),
    pendingsWithoutTx: await q(pg`SELECT ((SELECT count(*) FROM "PendingExpenseOccurrences" p WHERE p.group_id = ${g}
        AND p.resolved_tx_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CashTransactions" t WHERE t.id = p.resolved_tx_id))
      + (SELECT count(*) FROM "PendingIncomeOccurrences" p WHERE p.group_id = ${g}
        AND p.resolved_tx_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "IncomeTransactions" t WHERE t.id = p.resolved_tx_id)))::int AS n`),
    openPendings: await q(pg`SELECT ((SELECT count(*) FROM "PendingExpenseOccurrences" WHERE group_id = ${g}
        AND skipped_at IS NULL AND resolved_tx_id IS NULL)
      + (SELECT count(*) FROM "PendingIncomeOccurrences" WHERE group_id = ${g}
        AND skipped_at IS NULL AND resolved_tx_id IS NULL))::int AS n`),
    messagesOutsideKept: await q(pg`SELECT count(*)::int AS n FROM "MonthlyReviewMessages" m WHERE m.group_id = ${g}
      AND NOT EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.group_id = m.group_id AND k.ended_at IS NOT NULL
        AND m.created_at >= k.started_at AND m.created_at < k.ended_at
        AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id IN (k.member_a_id, k.member_b_id)))`),
    unpausedRules: await q(pg`SELECT ((SELECT count(*) FROM "RecurringExpenseRules" WHERE group_id = ${g} AND paused_at IS NULL)
      + (SELECT count(*) FROM "RecurringIncomeRules" WHERE group_id = ${g} AND paused_at IS NULL))::int AS n`),
    snapshotPayerNames: await q(pg`SELECT count(*)::int AS n FROM "MonthlyReviewSnapshots" WHERE group_id = ${g}
      AND largest_expense_paid_by_name IS NOT NULL`),
  }
}
const ZERO_AT_REST = {
  assetEncrypted: 0, details: 0, importBatches: 0, importErrors: 0, importLinks: 0, shareTokens: 0,
  currencyRates: 0, invites: 0, invoice: 0, quiz: 0, pushTokens: 0, tripExpensesOutsideKept: 0,
  pendingsWithoutTx: 0, openPendings: 0, messagesOutsideKept: 0, unpausedRules: 0, snapshotPayerNames: 0,
}

/** D (the stayer) deleted while X is alive: the state of case (a). */
async function afterD(opts: { xAlive?: boolean } = {}): Promise<World> {
  const w = await world(pg, tag(), opts)
  await requestDeletion(pg, w.D)
  const r = await runJob()
  expect(r).toEqual({ n: 1, warnings: [] })
  return w
}

describe.skipIf(!isLocalDb)('0096 — the stayer\'s deletion keeps the shared chapter (#1701)', () => {
  beforeAll(async () => {
    url = await createStandInDb(adminUrl, '0096')
    pg = await connect(url)
  }, 180_000)

  afterAll(async () => {
    await pg?.end()
    if (url) await dropStandInDb(adminUrl, url)
  })

  describe('(a) D, alone after X left, deletes their account', () => {
    let w: World
    beforeAll(async () => {
      w = await world(pg, tag())
      await requestDeletion(pg, w.D)
    })

    it('the job deletes D with no WARNING; D\'s login and PII are gone, D is 「已離開的夥伴」', async () => {
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      expect(await authExists(w.D)).toBe(false)
      // Kept rows still reference D: a scrubbed tombstone, no name.
      expect(await profileOf(w.D)).toEqual({ display_name: TOMB, avatar_url: null, deletion_requested_at: null })
      expect(await authExists(w.X)).toBe(true)
    })

    it('exactly the chapter X can look back on stays (pre-chapter assets / rules per ②, post-leave rows gone)', async () => {
      expect(await w.rec.surviving(Object.keys(KEPT_AFTER_D))).toEqual(KEPT_AFTER_D)
    })

    it('every other table holds nothing of the ledger (the unconditional deletes)', async () => {
      const left = await w.rec.surviving()
      const outside = Object.keys(left).filter((t) => !(t in KEPT_AFTER_D))
      expect(outside).toEqual([])
    })

    it('the ledger is an orphan: member_a = D (no auth row), no member_b, every chapter closed, neutral name, zero balance', async () => {
      const [g] = await pg`SELECT member_a, member_b, name, pending_swap_proposed_by FROM "OikosGroups" WHERE id = ${w.G}`
      expect(g).toEqual({ member_a: w.D, member_b: null, name: '家計簿', pending_swap_proposed_by: null })
      const [b] = await pg`SELECT balance FROM "GroupBalance" WHERE group_id = ${w.G}`
      expect(b.balance).toBe(0)
      const open = await pg`SELECT id FROM "GroupEpochs" WHERE group_id = ${w.G} AND ended_at IS NULL`
      expect(open).toHaveLength(0)
    })

    it('(F12) D\'s name slots read 「已離開的夥伴」 after the chapter close fired the name snapshot; X\'s name stays', async () => {
      const eps = await pg<{ id: string; member_a_name: string; member_b_name: string | null }[]>`
        SELECT id, member_a_name, member_b_name FROM "GroupEpochs" WHERE group_id = ${w.G}`
      for (const e of eps) expect(e.member_a_name).toBe(TOMB)
      const e1 = eps.find((e) => e.id === w.E1)!
      expect(e1.member_b_name).toMatch(/ X$/)
      const pD = await pg`SELECT profile_id, display_name FROM "OutingParticipants" WHERE id = ${w.rec.id('outingIn.pD')}`
      expect(pD[0]).toEqual({ profile_id: null, display_name: TOMB })
      const [{ n }] = await pg<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "Profiles" WHERE display_name LIKE '%D real name%'`
      expect(n).toBe(0)
    })

    it('(g) nothing X never sees stays at rest', async () => {
      expect(await atRest(w.G)).toEqual(ZERO_AT_REST)
      // The scrubbed asset name: the plain name the list shows stays.
      const [a] = await pg`SELECT name, notes, template_fields, name_encrypted FROM "Assets" WHERE id = ${w.rec.id('petIn')}`
      expect(a).toEqual({ name: 'n petIn', notes: null, template_fields: null, name_encrypted: null })
    })

    it('(f) FK closure: imported tx kept without its batch; insurance with a post-chapter child / car kept; a trip of another chapter kept as a bare parent', async () => {
      const [imp] = await pg`SELECT import_batch_id, deleted_at FROM "CashTransactions" WHERE id = ${w.rec.id('cashInImported')}`
      expect(imp).toEqual({ import_batch_id: null, deleted_at: null })
      // Insurance kept; its details (insured child, linked car) gone, so the
      // post-chapter child and car are not held back.
      expect(await w.rec.surviving(['Assets'])).toEqual({ Assets: KEPT_AFTER_D.Assets })
      const [tripPre] = await pg`SELECT name, cover_photo_url, budget_amount, budget_currency FROM "Trips" WHERE id = ${w.rec.id('tripPre')}`
      expect(tripPre).toEqual({ name: 'trip tripPre', cover_photo_url: null, budget_amount: null, budget_currency: null })
      const te = await pg`SELECT id FROM "TripExpenses" WHERE trip_id = ${w.rec.id('tripPre')}`
      expect(te).toHaveLength(0)
      // A trip of the kept chapter keeps its fields and all its expenses (the
      // trip page reads them with no time filter).
      const [tripIn] = await pg`SELECT cover_photo_url, budget_amount FROM "Trips" WHERE id = ${w.rec.id('tripIn')}`
      expect(tripIn).toEqual({ cover_photo_url: 'https://example.invalid/tripIn.jpg', budget_amount: 9000 })
    })

    it('X\'s own ledger is untouched', async () => {
      expect(await ledgerRowCounts(pg, w.NX)).toEqual({ OikosGroups: 1, GroupBalance: 1, GroupEpochs: 1, CashTransactions: 1 })
      const [g] = await pg`SELECT member_a, member_b FROM "OikosGroups" WHERE id = ${w.NX}`
      expect(g).toEqual({ member_a: w.X, member_b: null })
    })

    it('(j) a second prune / sweep / job run changes nothing (idempotent)', async () => {
      const before = await w.rec.fingerprint()
      const [{ r }] = await pg<{ r: string }[]>`SELECT public._prune_ledger(${w.G}::uuid) AS r`
      expect(r).toBe('pruned')
      expect(await sweep()).toMatchObject({ warnings: [] })
      expect(await runJob()).toEqual({ n: 0, warnings: [] })
      expect(await w.rec.fingerprint()).toEqual(before)
    })

    it('(c) X deletes later → the orphan is purged and both tombstones go', async () => {
      await requestDeletion(pg, w.X)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      expect(await ledgerRowCounts(pg, w.G)).toEqual({})
      expect(await ledgerRowCounts(pg, w.NX)).toEqual({})
      expect(await profileOf(w.D)).toBeUndefined()
      expect(await profileOf(w.X)).toBeUndefined()
      expect(await w.rec.surviving()).toEqual({})
    })
  })

  describe('(b) X was deleted first → D\'s deletion cascades as before #1701', () => {
    it('X\'s deletion leaves G alone (D alive); D\'s then removes all of G and both profiles', async () => {
      const w = await world(pg, tag())
      await requestDeletion(pg, w.X)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      expect(await authExists(w.X)).toBe(false)
      expect(await ledgerRowCounts(pg, w.NX)).toEqual({})
      // G is D's live ledger: not an orphan, nothing pruned.
      const [g] = await pg`SELECT name FROM "OikosGroups" WHERE id = ${w.G}`
      expect(g.name).toMatch(/D 的家計簿$/)
      expect((await profileOf(w.X))?.display_name).toBe(TOMB)

      await requestDeletion(pg, w.D)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      expect(await ledgerRowCounts(pg, w.G)).toEqual({})
      expect(await w.rec.surviving()).toEqual({})
      expect(await profileOf(w.D)).toBeUndefined()
      expect(await profileOf(w.X)).toBeUndefined()
    })

    it('a fixture where X never had an account behaves the same (no kept chapter)', async () => {
      const w = await world(pg, tag(), { xAlive: false })
      await requestDeletion(pg, w.D)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      expect(await ledgerRowCounts(pg, w.G)).toEqual({})
    })
  })

  describe('(d) both pending', () => {
    it('due in the same run → purged, whatever order the job takes them in', async () => {
      const w = await world(pg, tag())
      await requestDeletion(pg, w.D)
      await requestDeletion(pg, w.X)
      expect(await runJob()).toEqual({ n: 2, warnings: [] })
      expect(await ledgerRowCounts(pg, w.G)).toEqual({})
      expect(await ledgerRowCounts(pg, w.NX)).toEqual({})
      expect(await w.rec.surviving()).toEqual({})
      expect(await profileOf(w.D)).toBeUndefined()
      expect(await profileOf(w.X)).toBeUndefined()
    })

    it('D due, X pending (not yet due) → kept for X (pending counts as alive); X due later → purged', async () => {
      const w = await world(pg, tag())
      await requestDeletion(pg, w.D)
      await requestDeletion(pg, w.X, 1)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      expect(await w.rec.surviving(Object.keys(KEPT_AFTER_D))).toEqual(KEPT_AFTER_D)
      await requestDeletion(pg, w.X)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      expect(await w.rec.surviving()).toEqual({})
    })
    // D first then X, in separate runs: (a)+(c). X first then D: (b).
  })

  describe('(e) two former partners, P1 and P2', () => {
    // G: E0 D | E1 D+P1 | E2 D | E3 D+P2 | E4 D (open). Rows labelled by chapter.
    async function twoPartners() {
      const t = tag()
      const rec = new Recorder(pg)
      const D = await person(pg, `${t} D`)
      const P1 = await person(pg, `${t} P1`)
      const P2 = await person(pg, `${t} P2`)
      const { g: G, epochs } = await ledger(rec, pg, 'G', `${t} G`, [
        { label: 'E0', start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z', a: D, b: null },
        { label: 'E1', start: '2026-02-01T00:00:00Z', end: '2026-04-01T00:00:00Z', a: D, b: P1 },
        { label: 'E2', start: '2026-04-01T00:00:00Z', end: '2026-05-01T00:00:00Z', a: D, b: null },
        { label: 'E3', start: '2026-05-01T00:00:00Z', end: '2026-08-01T00:00:00Z', a: D, b: P2 },
        { label: 'E4', start: '2026-08-01T00:00:00Z', end: null, a: D, b: null },
      ])
      for (const [p, e, day] of [['P1', 'E1', '2026-03'], ['P2', 'E3', '2026-06']] as const) {
        const who = p === 'P1' ? P1 : P2
        await cash(rec, G, `${p}.cash`, who, `${day}-05T00:00:00Z`)
        const trip = await rec.ins('Trips', `${p}.trip`, { group_id: G, epoch_id: epochs[e], name: `trip ${p}`, start_date: `${day}-06` })
        await rec.ins('TripExpenses', `${p}.tripExpense`, { trip_id: trip, paid_by: who, amount: 1, category: 'dining', split_type: 'half', created_at: new Date(`${day}-06T00:00:00Z`) })
        const o = await rec.ins('Outings', `${p}.outing`, { group_id: G, epoch_id: epochs[e], created_by: who, name: `o ${p}`, currency: 'twd' })
        await rec.ins('OutingParticipants', `${p}.participant`, { outing_id: o, display_name: p, profile_id: who })
        const month = Number(day.slice(5))
        await rec.ins('MonthlyReviewSnapshots', `${p}.snapshot`, { group_id: G, year: 2026, month })
        await rec.ins('MonthlyReviewMessages', `${p}.message`, { group_id: G, member_id: who, year: 2026, month, body: 'b', created_at: new Date(`${day}-20T00:00:00Z`) })
        // Created and deleted inside the chapter: only that chapter shows it.
        await rec.ins('Assets', `${p}.asset`, { group_id: G, type: 'item', name: `a ${p}`, created_at: new Date(`${day}-07T00:00:00Z`), deleted_at: new Date(`${day}-08T00:00:00Z`) })
      }
      // Seen by both chapters.
      await rec.ins('Assets', 'shared.asset', { group_id: G, type: 'pet', name: 'shared', created_at: new Date('2026-01-15T00:00:00Z') })
      await cash(rec, G, 'D.after', D, '2026-09-01T00:00:00Z')
      return { rec, D, P1, P2, G }
    }
    const ONLY = (p: 'P1' | 'P2') => [`${p}.asset`, `${p}.cash`, `${p}.message`, `${p}.outing`, `${p}.participant`, `${p}.snapshot`, `${p}.trip`, `${p}.tripExpense`]
    const labels = (s: Record<string, string[]>) => Object.values(s).flat().sort()

    for (const [first, second] of [['P1', 'P2'], ['P2', 'P1']] as const) {
      it(`D deleted keeps both chapters; ${first} deleted removes only ${first}'s; ${second} deleted purges`, async () => {
        const f = await twoPartners()
        const ids = { P1: f.P1, P2: f.P2 }
        await requestDeletion(pg, f.D)
        expect(await runJob()).toEqual({ n: 1, warnings: [] })
        const both = labels(await f.rec.surviving())
        expect(both).toEqual(['E0', 'E1', 'E2', 'E3', 'E4', 'G', ...ONLY('P1'), ...ONLY('P2'), 'shared.asset'].sort())
        const fpBefore = await f.rec.fingerprint()

        await requestDeletion(pg, ids[first])
        expect(await runJob()).toEqual({ n: 1, warnings: [] })
        const one = labels(await f.rec.surviving())
        expect(one).toEqual(both.filter((l) => !ONLY(first).includes(l)))
        // The other chapter's rows are byte-for-byte unchanged.
        const fpAfter = await f.rec.fingerprint()
        for (const l of ONLY(second)) {
          const k = Object.keys(fpBefore).find((x) => x.endsWith(`:${l}`))!
          expect(fpAfter[k]).toBe(fpBefore[k])
        }
        // Its chapter row (GroupEpochs, kept until the purge) still names
        // the id: a scrubbed tombstone, no name.
        expect((await profileOf(ids[first]))?.display_name).toBe(TOMB)

        await requestDeletion(pg, ids[second])
        expect(await runJob()).toEqual({ n: 1, warnings: [] })
        expect(await f.rec.surviving()).toEqual({})
        for (const id of [f.D, f.P1, f.P2]) expect(await profileOf(id)).toBeUndefined()
      })
    }
  })

  // #1706 — every other case keeps a chapter that has an earlier one (E0), so
  // "created before the kept chapter" always meant "not visible to it". The
  // ledger's EARLIEST chapter is different: rows older than it belong to it
  // (viewer_in_chapter, 0080 — the first chapter has no lower bound), and the
  // prune must keep them. Failure looks like: nothing errors; X opens the first
  // chapter they shared and the records dated before it are gone.
  describe('(l) the kept chapter is the ledger\'s earliest: no lower bound', () => {
    it('rows older than it stay (cash, income, settlements, fuel logs); rows after it go', async () => {
      const t = tag()
      const rec = new Recorder(pg)
      const D = await person(pg, `${t} D`)
      const X = await person(pg, `${t} X`)
      const { g: G } = await ledger(rec, pg, 'G', `${t} G`, [
        { label: 'F1', start: '2026-02-10T00:00:00Z', end: '2026-07-20T00:00:00Z', a: D, b: X },
        { label: 'F2', start: '2026-07-20T00:00:00Z', end: null, a: D, b: null },
      ])
      const car = await rec.ins('Assets', 'car', { group_id: G, type: 'car', name: 'car', created_at: new Date('2026-01-01T00:00:00Z') })
      const income = (label: string, created: string) => rec.ins('IncomeTransactions', label, {
        group_id: G, recipient_id: D, amount: 700, category: 'salary', source: `s ${label}`,
        occurred_at: created.slice(0, 10), created_at: new Date(created),
      })
      const settle = (label: string, created: string) => rec.ins('Settlements', label, {
        group_id: G, paid_by: X, amount: 300, settled_at: new Date(created), created_at: new Date(created), note: label,
      })
      const fuel = (label: string, created: string) => rec.ins('FuelLogs', label, {
        asset_id: car, liters: '30', fuel_type: '95', odometer: 100, logged_at: new Date(created), created_at: new Date(created),
      })
      await cash(rec, G, 'cashBeforeFirst', D, '2026-01-05T00:00:00Z')
      await cash(rec, G, 'cashInFirst', X, '2026-03-05T00:00:00Z')
      await cash(rec, G, 'cashAfter', D, '2026-08-01T00:00:00Z')
      await income('incomeBeforeFirst', '2026-01-06T00:00:00Z')
      await income('incomeAfter', '2026-08-02T00:00:00Z')
      await settle('settleBeforeFirst', '2026-01-07T00:00:00Z')
      await settle('settleAfter', '2026-08-03T00:00:00Z')
      await fuel('fuelBeforeFirst', '2026-01-08T00:00:00Z')
      await fuel('fuelAfter', '2026-08-04T00:00:00Z')

      await requestDeletion(pg, D)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      const left = Object.values(await rec.surviving()).flat().sort()
      expect(left).toEqual([
        'F1', 'F2', 'G', 'car', 'cashBeforeFirst', 'cashInFirst', 'fuelBeforeFirst', 'incomeBeforeFirst', 'settleBeforeFirst',
      ])

      await requestDeletion(pg, X)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      expect(await rec.surviving()).toEqual({})
    })
  })

  describe('(h) a prune that fails', () => {
    it('X\'s deletion still completes (WARNING); the sweep purges once the fault is gone', async () => {
      const w = await afterD()
      await pg`CREATE TABLE public.fault_1701 (trip_id uuid REFERENCES "Trips" (id))`
      try {
        await pg`INSERT INTO public.fault_1701 VALUES (${w.rec.id('tripIn')})`
        await requestDeletion(pg, w.X)
        const r = await runJob()
        expect(r.n).toBe(1)
        expect(r.warnings).toEqual([
          expect.stringMatching(new RegExp(`^process_account_deletions: prune of ${w.G} after ${w.X} failed: .*fault_1701`)),
          expect.stringMatching(new RegExp(`^sweep_orphan_ledgers: failed for ${w.G}: .*fault_1701`)),
        ])
        expect(await authExists(w.X)).toBe(false)
        // G untouched by the failed prune; X's own ledger purged as usual.
        expect(await w.rec.surviving(Object.keys(KEPT_AFTER_D))).toEqual({
          ...KEPT_AFTER_D,
          OikosGroups: ['G'],
          GroupEpochs: ['E0', 'E1', 'E2'],
          CashTransactions: KEPT_AFTER_D.CashTransactions.filter((l) => l !== 'nxOwn'),
        })
      } finally {
        await pg`DROP TABLE public.fault_1701`
      }
      expect(await sweep()).toMatchObject({ warnings: [] })
      expect(await ledgerRowCounts(pg, w.G)).toEqual({})
      expect(await w.rec.surviving()).toEqual({})
    })

    it('D\'s own prune failing rolls D back (WARNING, account still there), never falls through to a cascade', async () => {
      const w = await world(pg, tag())
      await pg`CREATE TABLE public.fault_1701 (trip_id uuid REFERENCES "Trips" (id))`
      try {
        // tripPost is not in X's chapter: the prune must delete it, and cannot.
        await pg`INSERT INTO public.fault_1701 VALUES (${w.rec.id('tripPost')})`
        const before = await w.rec.fingerprint()
        await requestDeletion(pg, w.D)
        const r = await runJob()
        expect(r.n).toBe(0)
        expect(r.warnings).toEqual([expect.stringMatching(new RegExp(`^process_account_deletions: failed for ${w.D}: .*fault_1701`))])
        expect(await authExists(w.D)).toBe(true)
        const after = await w.rec.fingerprint()
        expect(after).toEqual(before)
      } finally {
        await pg`DROP TABLE public.fault_1701`
      }
      // Next run (fault gone) completes.
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      expect(await w.rec.surviving(Object.keys(KEPT_AFTER_D))).toEqual(KEPT_AFTER_D)
      await requestDeletion(pg, w.X)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
    })

    // #1706 — the test above injects its fault with an FK into "Trips", which
    // blocks the prune AND `_delete_group_cascade` (both delete the trip). A
    // regression that catches the prune's error and falls back to the cascade
    // would hit the same wall there, roll D back all the same, and pass. This
    // fault is one only the prune can reach: a trigger on UPDATE "Assets" (the
    // prune scrubs the kept assets' notes; the cascade only deletes them). A
    // fallback to the cascade would succeed here, delete D, and destroy the
    // chapter X can still look back on.
    it('D\'s prune failing on an error only the prune hits still rolls D back; the cascade is not a fallback (#1706)', async () => {
      const w = await world(pg, tag())
      await pg`CREATE FUNCTION public.fault_1706() RETURNS trigger LANGUAGE plpgsql
        AS $f$ BEGIN RAISE EXCEPTION 'fault_1706 injected'; END $f$`
      await pg`CREATE TRIGGER fault_1706 BEFORE UPDATE ON "Assets" FOR EACH ROW EXECUTE FUNCTION public.fault_1706()`
      try {
        const before = await w.rec.fingerprint()
        await requestDeletion(pg, w.D)
        const r = await runJob()
        expect(r.n).toBe(0)
        expect(r.warnings).toEqual([expect.stringMatching(new RegExp(`^process_account_deletions: failed for ${w.D}: .*fault_1706 injected`))])
        expect(await authExists(w.D)).toBe(true)
        // Not one row of the ledger moved: X's chapter and everything else.
        expect(await w.rec.fingerprint()).toEqual(before)
        expect(await w.rec.surviving(Object.keys(KEPT_AFTER_D))).not.toEqual({})
        expect(await ledgerRowCounts(pg, w.G)).not.toEqual({})
      } finally {
        await pg`DROP TRIGGER fault_1706 ON "Assets"`
        await pg`DROP FUNCTION public.fault_1706()`
      }
      // Next run (fault gone) completes, keeping X's chapter.
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      expect(await w.rec.surviving(Object.keys(KEPT_AFTER_D))).toEqual(KEPT_AFTER_D)
      await requestDeletion(pg, w.X)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
    })
  })

  describe('(i) the crons write nothing into an orphan', () => {
    let w: World
    const job = async (name: string) => {
      const [j] = await pg<{ command: string }[]>`SELECT command FROM cron.job WHERE jobname = ${name}`
      expect(j, name).toBeDefined()
      return j.command
    }
    beforeAll(async () => {
      w = await afterD()
    })
    afterAll(async () => {
      await requestDeletion(pg, w.X)
      await runJob()
    })

    it('monthly-review-snapshot: no snapshot, no lock in the orphan; X\'s live ledger still gets both', async () => {
      const [{ y, m }] = await pg<{ y: number; m: number }[]>`
        SELECT EXTRACT(YEAR FROM (date_trunc('month', NOW() AT TIME ZONE 'Asia/Taipei') - INTERVAL '1 day'))::int AS y,
               EXTRACT(MONTH FROM (date_trunc('month', NOW() AT TIME ZONE 'Asia/Taipei') - INTERVAL '1 day'))::int AS m`
      // A message addressed to the target month in each ledger (written
      // directly: nothing in the app can write into the orphan).
      await pg`INSERT INTO "MonthlyReviewMessages" (group_id, member_id, year, month, body) VALUES (${w.G}, ${w.X}, ${y}, ${m}, 'orphan')`
      await pg`INSERT INTO "MonthlyReviewMessages" (group_id, member_id, year, month, body) VALUES (${w.NX}, ${w.X}, ${y}, ${m}, 'live')`
      const before = await w.rec.fingerprint()
      await pg.unsafe(await job('monthly-review-snapshot'))
      const snaps = await pg`SELECT group_id FROM "MonthlyReviewSnapshots" WHERE year = ${y} AND month = ${m} AND group_id IN (${w.G}, ${w.NX})`
      expect(snaps.map((s) => s.group_id)).toEqual([w.NX])
      const locks = await pg<{ group_id: string; locked: boolean }[]>`
        SELECT group_id, locked_at IS NOT NULL AS locked FROM "MonthlyReviewMessages"
         WHERE year = ${y} AND month = ${m} AND group_id IN (${w.G}, ${w.NX}) ORDER BY body`
      // ORDER BY body: 'live' (NX) before 'orphan' (G).
      expect(locks).toEqual([{ group_id: w.NX, locked: true }, { group_id: w.G, locked: false }])
      expect(await w.rec.fingerprint()).toEqual(before)
      await pg`DELETE FROM "MonthlyReviewMessages" WHERE body IN ('orphan', 'live') AND group_id IN (${w.G}, ${w.NX})`
    })

    it('generate-pending-*: kept rules are paused, so nothing is generated in the orphan; a live rule still generates', async () => {
      await pg`INSERT INTO "RecurringExpenseRules" (group_id, paid_by, amount, split_type, description, category, interval_months, day_of_month, starts_on, next_occurrence_at)
        VALUES (${w.NX}, ${w.X}, 1, 'all_mine', 'live', 'housing', 1, 1, '2026-01-01', '2026-01-01')`
      await pg`INSERT INTO "RecurringIncomeRules" (group_id, recipient_id, amount, category, interval_months, day_of_month, starts_on, next_occurrence_at)
        VALUES (${w.NX}, ${w.X}, 1, 'salary', 1, 1, '2026-01-01', '2026-01-01')`
      const before = await w.rec.fingerprint()
      await pg.unsafe(await job('generate-pending-expense'))
      await pg.unsafe(await job('generate-pending-income'))
      const count = async (g: string) => (await pg<{ n: number }[]>`
        SELECT ((SELECT count(*) FROM "PendingExpenseOccurrences" WHERE group_id = ${g})
          + (SELECT count(*) FROM "PendingIncomeOccurrences" WHERE group_id = ${g}))::int AS n`)[0].n
      expect(await count(w.G)).toBe(KEPT_AFTER_D.PendingExpenseOccurrences.length + KEPT_AFTER_D.PendingIncomeOccurrences.length)
      expect(await count(w.NX)).toBe(2)
      expect(await w.rec.fingerprint()).toEqual(before)
    })
  })

  describe('(j) catalog', () => {
    it('the three functions: owner postgres, search_path pinned, SECURITY DEFINER', async () => {
      const rows = await pg<{ name: string; owner: string; definer: boolean; config: string[] | null }[]>`
        SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config
          FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('_prune_ledger', 'sweep_orphan_ledgers', 'process_account_deletions') ORDER BY 1`
      expect(rows).toEqual(['_prune_ledger', 'process_account_deletions', 'sweep_orphan_ledgers'].map((name) => ({
        name, owner: 'postgres', definer: true, config: ['search_path=public, pg_temp'],
      })))
    })

    it('only postgres may run the prune and the sweep; the job keeps 0088\'s grants (postgres, service_role)', async () => {
      const can = async (role: string, fn: string) => (await pg<{ ok: boolean }[]>`
        SELECT has_function_privilege(${role}, ${fn}, 'EXECUTE') AS ok`)[0].ok
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await can(role, 'public._prune_ledger(uuid, uuid)'), role).toBe(false)
        expect(await can(role, 'public.sweep_orphan_ledgers()'), role).toBe(false)
      }
      expect(await can('anon', 'public.process_account_deletions()')).toBe(false)
      expect(await can('authenticated', 'public.process_account_deletions()')).toBe(false)
      expect(await can('service_role', 'public.process_account_deletions()')).toBe(true)
      // Positive control: the stand-in's default ACL WOULD have granted it.
      const [{ ok }] = await pg<{ ok: boolean }[]>`
        SELECT has_function_privilege('authenticated', 'public.viewer_in_chapter(uuid, timestamptz)', 'EXECUTE') AS ok`
      expect(ok).toBe(true)
    })

    it('authenticated calling the prune is refused by the grant, not by the orphan check', async () => {
      const w = await world(pg, tag())
      await expect(pg.begin(async (tx) => {
        await tx`SET LOCAL ROLE authenticated`
        await tx`SELECT public._prune_ledger(${w.G}::uuid)`
      })).rejects.toThrow(/permission denied for function _prune_ledger/)
      // And postgres calling it on a live ledger is refused by the check.
      await expect(pg`SELECT public._prune_ledger(${w.G}::uuid)`).rejects.toThrow(/is not an orphan ledger/)
      await expect(pg`SELECT public._prune_ledger(${w.NX}::uuid)`).rejects.toThrow(/is not an orphan ledger/)
      await requestDeletion(pg, w.D)
      await requestDeletion(pg, w.X)
      expect(await runJob()).toMatchObject({ n: 2, warnings: [] })
    })

    it('cron: sweep-orphan-ledgers daily 15:00 UTC; monthly-review-snapshot skips orphans; process-account-deletions unchanged', async () => {
      const jobs = await pg<{ jobname: string; schedule: string; command: string }[]>`
        SELECT jobname, schedule, command FROM cron.job
         WHERE jobname IN ('sweep-orphan-ledgers', 'monthly-review-snapshot', 'process-account-deletions') ORDER BY 1`
      expect(jobs.map((j) => [j.jobname, j.schedule])).toEqual([
        ['monthly-review-snapshot', '5 16 1 * *'],
        ['process-account-deletions', '30 16 * * *'],
        ['sweep-orphan-ledgers', '0 15 * * *'],
      ])
      expect(jobs[2].command.trim()).toBe('SELECT public.sweep_orphan_ledgers();')
      expect(jobs[0].command.match(/NOT EXISTS \(SELECT 1 FROM auth\.users u WHERE u\.id = g\.member_a\)/g)).toHaveLength(2)
    })

    it('re-applying 0096 is a no-op on data and catalog', async () => {
      const w = await afterD()
      const before = await w.rec.fingerprint()
      const jobsBefore = await pg`SELECT jobname, schedule, command FROM cron.job ORDER BY 1`
      const stmts = read('drizzle/0096_deletion_keeps_shared_chapter.sql').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
      await pg.begin(async (tx) => {
        for (const s of stmts) await tx.unsafe(s)
      })
      expect(await pg`SELECT jobname, schedule, command FROM cron.job ORDER BY 1`).toEqual(jobsBefore)
      expect(await w.rec.fingerprint()).toEqual(before)
      await requestDeletion(pg, w.X)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
    })
  })
})

describe.skipIf(!isLocalDb)('0096 rollback script', () => {
  let rurl = ''
  let rpg: Sql
  beforeAll(async () => {
    rurl = await createStandInDb(adminUrl, '0096')
    rpg = await connect(rurl)
  }, 180_000)
  afterAll(async () => {
    await rpg?.end()
    if (rurl) await dropStandInDb(adminUrl, rurl)
  })

  it('restores 0088\'s processor and grants, keeps the sweep job; an orphan still converges to 0 rows', async () => {
    const saved = pg
    pg = rpg
    try {
      const w = await afterD()
      await rpg.unsafe(read('scripts/rollback/0096_deletion_keeps_shared_chapter.down.sql'))

      // The processor body is 0088's again (statement text compared after
      // the same whitespace normalisation).
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
      const fn0088 = read('drizzle/0088_epoch_name_snapshot.sql').split('--> statement-breakpoint')
        .find((s) => s.includes('CREATE OR REPLACE FUNCTION public.process_account_deletions'))!
      const body0088 = fn0088.slice(fn0088.indexOf('$fn$') + 4, fn0088.lastIndexOf('$fn$'))
      const [{ src }] = await rpg<{ src: string }[]>`
        SELECT prosrc AS src FROM pg_proc WHERE oid = 'public.process_account_deletions()'::regprocedure`
      expect(norm(src)).toBe(norm(body0088))
      expect(src).not.toMatch(/_prune_ledger|sweep_orphan_ledgers/)
      const [{ ok }] = await rpg<{ ok: boolean }[]>`
        SELECT has_function_privilege('service_role', 'public.process_account_deletions()', 'EXECUTE') AND
               NOT has_function_privilege('authenticated', 'public.process_account_deletions()', 'EXECUTE') AS ok`
      expect(ok).toBe(true)

      // The sweep, its job and the prune stay.
      const jobs = await rpg`SELECT jobname FROM cron.job WHERE jobname = 'sweep-orphan-ledgers'`
      expect(jobs).toHaveLength(1)

      // X (the last former member) deleted after the rollback: 0088's job
      // does not prune; the next sweep (its own job) does.
      await requestDeletion(rpg, w.X)
      expect(await runJob()).toEqual({ n: 1, warnings: [] })
      const [{ cmd }] = await rpg<{ cmd: string }[]>`SELECT command AS cmd FROM cron.job WHERE jobname = 'sweep-orphan-ledgers'`
      await rpg.unsafe(cmd)
      expect(await ledgerRowCounts(rpg, w.G)).toEqual({})
      expect(await w.rec.surviving()).toEqual({})
    } finally {
      pg = saved
    }
  })
})
