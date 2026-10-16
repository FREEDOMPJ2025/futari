import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── Chapter scope of the export, description suggestions and import history ─
//
// Part 1 — one ledger, four people, four chapters:
//
//   G:  [A+B] ──B leaves──▶ [A solo] ──C joins──▶ [A+C]
//   GB: [B solo] ──D joins──▶ [B+D]
//
// The leave is the real `leaveGroup` action. Since #1611 it moves none of
// B's records: the A+B chapter stays whole in G, B's rows included. Expected:
//   - export / suggestions cover exactly the chapters the viewer was in:
//       A@G  → every G row (the whole A+B chapter)   C@G  → only the A+C chapter
//       B@G  → exactly the A+B chapter               B@GB → B solo + B+D only
//       D@GB → only the B+D chapter
//   - import history / count list only the open chapter's batches.
//
// Part 2 (#1460, further down) — the export across ledgers: income and
// settlements, the #1612 look-back rule, snapshot names, and the per-row
// split shares through swaps, leaves, rejoins and an account deletion.
//
// Writes whole fixtures, so it only runs against a local throwaway database
// (DATABASE_URL on localhost). Integration folder — excluded from CI.
// ──────────────────────────────────────────────────────────────────────────

function loadEnvLocal() {
  const envPath = resolve(__dirname, '../../.env.local')
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

const { AsyncLocalStorage } = await import('node:async_hooks')
const viewerStore = new AsyncLocalStorage<string>()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: viewerStore.getStore() ?? '' } }, error: null }),
    },
  }),
  getCurrentUser: async () => ({ id: viewerStore.getStore() ?? '' }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    getAll: () => [],
    has: () => false,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}))
vi.mock('@/lib/analytics/server', () => ({
  captureServer: async () => {},
  isUserFirstNonDeletedRecord: async () => false,
}))

const databaseUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

const { db } = await import('@/lib/db/client')
const { seedAuthUsers, deleteAuthUsers } = await import('./_authUser')
const {
  profiles, oikosGroups, groupBalance, groupEpochs, cashTransactions, importBatches,
} = await import('@/lib/db/schema')
const { leaveGroup } = await import('@/actions/membership')
const { getImportHistory, countImportBatches } = await import('@/actions/import')
const { getDescriptionSuggestions } = await import('@/actions/transaction')
const { viewerChaptersClause } = await import('@/lib/db/queries/_predicates')
const { and, eq, inArray, isNull } = await import('drizzle-orm')
const { unwrapAction } = await import('@/lib/action-errors')

const as = <T>(userId: string, fn: () => Promise<T>) => viewerStore.run(userId, fn)

const H = 60 * 60 * 1000
const D = 24 * H

const ids = {
  A: randomUUID(), B: randomUUID(), C: randomUUID(), D: randomUUID(),
  G: '', GB: '',
}
const tag = `TEST_scope_${ids.A.slice(0, 8)}`
const txIds: string[] = []
const batchIds: { ab: string; ac: string } = { ab: '', ac: '' }

async function addTx(groupId: string, paidBy: string, description: string, createdAt: Date) {
  const [row] = await db.insert(cashTransactions).values({
    groupId, paidBy, amount: 100, splitType: 'all_mine',
    description, category: 'other',
    transactedAt: createdAt, createdAt,
  }).returning({ id: cashTransactions.id })
  txIds.push(row.id)
}

async function addBatch(groupId: string, importedBy: string, fileName: string, createdAt: Date) {
  const [row] = await db.insert(importBatches).values({
    groupId, importedBy, source: 'futari_generic', fileName,
    totalRows: 1, importedCount: 1, status: 'completed', createdAt,
  }).returning({ id: importBatches.id })
  return row.id
}

/** Seat `joiner` as member_b the way acceptInvite does: close the open chapter, open a duo one. */
async function join(groupId: string, memberA: string, joiner: string, at: Date) {
  await db.update(groupEpochs).set({ endedAt: at })
    .where(and(eq(groupEpochs.groupId, groupId), isNull(groupEpochs.endedAt)))
  await db.insert(groupEpochs).values({ groupId, startedAt: at, memberAId: memberA, memberBId: joiner })
  await db.update(oikosGroups).set({ memberB: joiner, currentEpochStartedAt: at })
    .where(eq(oikosGroups.id, groupId))
}

// The viewer's export, narrowed to one ledger's expense rows. Imported lazily
// so this file also runs against the code before #1460 (the part 2 cases
// there go through the route only).
const exportedDescriptions = async (groupId: string, viewerId: string) => {
  const { getLedgerExportForViewer } = await import('@/lib/db/queries/export')
  const { dbRows } = await getLedgerExportForViewer(viewerId)
  const ids = dbRows.filter((r) => r.kind === 'expense' && r.groupId === groupId).map((r) => r.id)
  if (ids.length === 0) return []
  const rows = await db.select({ d: cashTransactions.description }).from(cashTransactions)
    .where(inArray(cashTransactions.id, ids))
  return rows.map((r) => r.d).sort()
}

describe.skipIf(!isLocalDb)('chapter scope: export, suggestions, import history', () => {
  beforeAll(async () => {
    await db.insert(profiles).values([
      { id: ids.A, displayName: `${tag}_A` },
      { id: ids.B, displayName: `${tag}_B` },
      { id: ids.C, displayName: `${tag}_C` },
      { id: ids.D, displayName: `${tag}_D` },
    ])

    const t0 = new Date(Date.now() - 10 * D)
    const [g] = await db.insert(oikosGroups).values({
      name: `${tag}_G`, memberA: ids.A, memberB: ids.B, currentEpochStartedAt: t0,
    }).returning({ id: oikosGroups.id })
    ids.G = g.id
    await db.insert(groupBalance).values({ groupId: ids.G, balance: 0, version: 0 })
    await db.insert(groupEpochs).values({ groupId: ids.G, startedAt: t0, memberAId: ids.A, memberBId: ids.B })

    // Chapter A+B.
    await addTx(ids.G, ids.A, `${tag} A in AB`, new Date(t0.getTime() + D))
    await addTx(ids.G, ids.B, `${tag} B in AB`, new Date(t0.getTime() + D))
    batchIds.ab = await addBatch(ids.G, ids.A, `${tag}_ab.csv`, new Date(t0.getTime() + D))

    // B leaves (real action). Since #1611 B's row stays in G; GB starts empty.
    const left = unwrapAction(await as(ids.B, () => leaveGroup()))
    ids.GB = left.groupId
    const [leaveEpoch] = await db.select({ startedAt: groupEpochs.startedAt }).from(groupEpochs)
      .where(and(eq(groupEpochs.groupId, ids.G), isNull(groupEpochs.endedAt)))
    const L = leaveEpoch.startedAt.getTime()

    // Chapter A solo.
    await addTx(ids.G, ids.A, `${tag} A solo`, new Date(L + H))

    // C joins G → chapter A+C.
    const J = L + 2 * H
    await join(ids.G, ids.A, ids.C, new Date(J))
    await addTx(ids.G, ids.C, `${tag} C in AC`, new Date(J + H))
    await addTx(ids.G, ids.A, `${tag} A in AC`, new Date(J + 2 * H))
    batchIds.ac = await addBatch(ids.G, ids.C, `${tag}_ac.csv`, new Date(J + H))

    // B's own solo chapter in GB.
    await addTx(ids.GB, ids.B, `${tag} B solo`, new Date(L + H))

    // D joins GB → chapter B+D.
    const K = L + 3 * H
    await join(ids.GB, ids.B, ids.D, new Date(K))
    await addTx(ids.GB, ids.D, `${tag} D in BD`, new Date(K + H))
  })

  afterAll(async () => {
    const groups = [ids.G, ids.GB].filter(Boolean)
    await db.delete(cashTransactions).where(inArray(cashTransactions.id, txIds))
    await db.delete(cashTransactions).where(inArray(cashTransactions.groupId, groups))
    await db.delete(importBatches).where(inArray(importBatches.groupId, groups))
    await db.delete(groupEpochs).where(inArray(groupEpochs.groupId, groups))
    await db.delete(groupBalance).where(inArray(groupBalance.groupId, groups))
    await db.delete(oikosGroups).where(inArray(oikosGroups.id, groups))
    await db.delete(profiles).where(inArray(profiles.id, [ids.A, ids.B, ids.C, ids.D]))
  })

  it('fixture: the leave kept B\'s row in G, inside the closed A+B chapter (#1611)', async () => {
    const [kept] = await db.select({ groupId: cashTransactions.groupId, createdAt: cashTransactions.createdAt })
      .from(cashTransactions).where(eq(cashTransactions.description, `${tag} B in AB`))
    expect(kept.groupId).toBe(ids.G)
    const [ab] = await db.select().from(groupEpochs)
      .where(and(eq(groupEpochs.groupId, ids.G), eq(groupEpochs.memberBId, ids.B)))
    expect(ab.endedAt).not.toBeNull()
    expect(kept.createdAt.getTime()).toBeGreaterThanOrEqual(ab.startedAt.getTime())
    expect(kept.createdAt.getTime()).toBeLessThan(ab.endedAt!.getTime())
    // Nothing of G was carried into GB.
    const gb = await db.select({ d: cashTransactions.description }).from(cashTransactions)
      .where(eq(cashTransactions.groupId, ids.GB))
    expect(gb.map((r) => r.d).sort()).toEqual([`${tag} B solo`, `${tag} D in BD`])
  })

  describe('export', () => {
    it('a later partner gets only the chapter they are in', async () => {
      expect(await exportedDescriptions(ids.G, ids.C)).toEqual([`${tag} A in AC`, `${tag} C in AC`])
    })

    it('a member of every chapter gets every row of the group, the whole A+B chapter included', async () => {
      expect(await exportedDescriptions(ids.G, ids.A)).toEqual(
        [`${tag} A in AB`, `${tag} A in AC`, `${tag} A solo`, `${tag} B in AB`, `${tag} C in AC`],
      )
    })

    it('the leaver\'s export from the new ledger contains none of the A+B chapter\'s rows', async () => {
      expect(await exportedDescriptions(ids.GB, ids.B)).toEqual([`${tag} B solo`, `${tag} D in BD`])
    })

    it('a partner who joins the leaver\'s new group gets only their own chapter', async () => {
      expect(await exportedDescriptions(ids.GB, ids.D)).toEqual([`${tag} D in BD`])
    })

    it('a former member gets exactly the chapter they were in, both people\'s rows', async () => {
      expect(await exportedDescriptions(ids.G, ids.B)).toEqual([`${tag} A in AB`, `${tag} B in AB`])
    })

    it('viewerChaptersClause(G, B) matches exactly the A+B chapter\'s rows', async () => {
      const rows = await db.select({ d: cashTransactions.description }).from(cashTransactions)
        .where(and(
          eq(cashTransactions.groupId, ids.G),
          viewerChaptersClause('"CashTransactions"."created_at"', ids.G, ids.B),
        ))
      expect(rows.map((r) => r.d).filter((d) => d.startsWith(tag)).sort())
        .toEqual([`${tag} A in AB`, `${tag} B in AB`])
    })

    it('someone who was never in the group gets nothing', async () => {
      expect(await exportedDescriptions(ids.G, ids.D)).toEqual([])
    })
  })

  describe('description suggestions', () => {
    const mine = (list: string[]) => list.filter((d) => d.startsWith(tag)).sort()

    it('a later partner is offered only their chapter\'s descriptions', async () => {
      const list = unwrapAction(await as(ids.C, () => getDescriptionSuggestions()))
      expect(mine(list)).toEqual([`${tag} A in AC`, `${tag} C in AC`])
    })

    it('the leaver is offered only the new ledger\'s chapters; the new partner only theirs', async () => {
      expect(mine(unwrapAction(await as(ids.B, () => getDescriptionSuggestions()))))
        .toEqual([`${tag} B solo`, `${tag} D in BD`])
      expect(mine(unwrapAction(await as(ids.D, () => getDescriptionSuggestions()))))
        .toEqual([`${tag} D in BD`])
    })
  })

  describe('import history', () => {
    it('lists and counts only the open chapter\'s batches', async () => {
      for (const viewer of [ids.C, ids.A]) {
        const history = unwrapAction(await as(viewer, () => getImportHistory()))
        expect(history.map((b) => b.id)).toEqual([batchIds.ac])
        expect(unwrapAction(await as(viewer, () => countImportBatches()))).toBe(1)
      }
    })
  })
})

// ─── Part 2 (#1460): one export across ledgers ──────────────────────────────
//
//   W1  G1: [A1+B1] ─B1 leaves─▶ [A1 solo] ─C1 joins─▶ [A1+C1] ─A1⇄C1 swap
//       GB1: [B1 solo]   (B1's own ledger)
//       GX: X1's own ledger · GK: a forged OPEN chapter naming B1 on X1's ledger
//   W2  G2: [A2+B2] ─B2 leaves─▶ [A2 solo] ─C2 joins─▶ [A2+C2] ─A2 deleted, C2 promoted
//   W3  G3: [A3+B3] ─B3 leaves─▶ [A3 solo] ─C3 joins─▶ [A3+C3] ─A3⇄C3 swap
//           ─A3 leaves─▶ [C3 solo] ─C3 re-invites B3─▶ [C3+B3] ─(e) B3⇄C3 swap
//   W4  G4: [A4+R4] ─A4 removes R4─▶ [A4 solo]   (R4 has no ledger at all)
//   W5  G5: [A5+B5] ─A5⇄B5 swap─ A5 leaves ─▶ [B5 solo] ─C5 joins─▶ [B5+C5]
//           ─B5⇄C5 swap─ B5 leaves ─▶ [C5 solo] ─A5 rejoins─▶ [C5+A5]   (#1706)
//   Z   a signed-in person with no chapter anywhere
//
// Leaves, removals and swaps are the real actions, the account deletion the
// real process_account_deletions() body scoped to one user (see
// runAccountDeletionFor); joins are written the way
// acceptInvite does (close the open chapter, open a duo one, seat member_b).
// Expectations are read from the CSV the route returns, as the person gets it.
//
// The weighted row in W1/W2/W3 is A 70 / B 30, paid by A while A held slot a.
// Failure looks like: nothing errors — a former member's file shows the other
// person's share as theirs (naive "current member_a" reading), the stayer's
// later name, or rows of chapters they were never in.

const { GET: exportGet } = await import('@/app/api/export/transactions/route')
const { proposeSwap, confirmSwap, removePartner } = await import('@/actions/membership')
const { incomeTransactions, settlements } = await import('@/lib/db/schema')
const { sql } = await import('drizzle-orm')
const { zhTW } = await import('@/lib/i18n/locales/zh-TW')

const CSV_BOM = '﻿'

/** RFC 4180 → rows of cells (header first). */
function parseCsv(text: string): string[][] {
  const body = text.startsWith(CSV_BOM) ? text.slice(CSV_BOM.length) : text
  const rows: string[][] = []
  let row: string[] = []
  let i = 0
  while (i < body.length) {
    let v = ''
    if (body[i] === '"') {
      i++
      while (i < body.length) {
        if (body[i] === '"' && body[i + 1] === '"') { v += '"'; i += 2 }
        else if (body[i] === '"') { i++; break }
        else { v += body[i]; i++ }
      }
    } else {
      while (i < body.length && body[i] !== ',' && body[i] !== '\r') { v += body[i]; i++ }
    }
    row.push(v)
    if (body[i] === ',') { i++; continue }
    if (body[i] === '\r' && body[i + 1] === '\n') { rows.push(row); row = []; i += 2; continue }
  }
  return rows
}

interface ExportFile {
  status: number
  header: string[]
  rows: string[][]
}

async function exportFor(viewerId: string): Promise<ExportFile> {
  const res = await as(viewerId, () => exportGet())
  if (res.status !== 200) return { status: res.status, header: [], rows: [] }
  const [header, ...rows] = parseCsv(await res.text())
  return { status: res.status, header, rows }
}

type ColumnKey = 'type' | 'date' | 'description' | 'amount' | 'currency' | 'category' | 'person'
  | 'settlementTo' | 'myShare' | 'theirShare' | 'status' | 'notes' | 'chapter'
/** A cell by the zh-TW header name (DEFAULT_LOCALE; the test sets no locale cookie). */
function cell(file: ExportFile, row: string[], key: ColumnKey): string | undefined {
  const name = (zhTW.csvExport.columns as Record<string, string | undefined>)[key]
  const i = name === undefined ? -1 : file.header.indexOf(name)
  return i === -1 ? undefined : row[i]
}

const P = `T1460_${randomUUID().slice(0, 6)}`
/** Every description / source / note starts with this, so a row is found by any cell. */
const M = (s: string) => `${P}#${s}`
/** The rows carrying marker `m` in any cell. */
const rowsWith = (file: ExportFile, m: string) => file.rows.filter((r) => r.includes(M(m)))
/** Every marker in the file (one per row, sorted). */
const markers = (file: ExportFile) =>
  file.rows.flatMap((r) => r.filter((c) => c.startsWith(`${P}#`))).map((c) => c.slice(P.length + 1)).sort()

const w2 = {} as Record<string, string>
const people2 = {
  A1: randomUUID(), B1: randomUUID(), C1: randomUUID(), X1: randomUUID(),
  A2: randomUUID(), B2: randomUUID(), C2: randomUUID(),
  A3: randomUUID(), B3: randomUUID(), C3: randomUUID(),
  A4: randomUUID(), R4: randomUUID(),
  A5: randomUUID(), B5: randomUUID(), C5: randomUUID(),
  Z: randomUUID(),
}
const NAME = {
  A1then: `${P}_A1_then`, A1live: `${P}_A1_LIVE_NOW`, B1: `${P}_B1`, C1: `${P}_C1`,
}

/** The DB clock, 1 ms on, after a short pause — so rows and boundaries written
 *  by the test interleave correctly with the real actions' clock_timestamp(). */
async function dbNow(): Promise<Date> {
  await new Promise((r) => setTimeout(r, 5))
  const [row] = await db.execute<{ t: string }>(
    sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`,
  )
  return new Date(new Date(row.t).getTime() + 1)
}

async function cash(groupId: string, paidBy: string, m: string, at: Date,
  extra: Partial<typeof cashTransactions.$inferInsert> = {}) {
  const [row] = await db.insert(cashTransactions).values({
    groupId, paidBy, amount: 1000, splitType: 'half', description: M(m), category: 'dining',
    transactedAt: at, createdAt: at, ...extra,
  }).returning({ id: cashTransactions.id })
  return row.id
}

async function newLedger(memberA: string, memberB: string | null, startedAt: Date, name: string) {
  const [g] = await db.insert(oikosGroups).values({
    name, memberA, memberB, currentEpochStartedAt: startedAt,
  }).returning({ id: oikosGroups.id })
  await db.insert(groupBalance).values({ groupId: g.id, balance: 0, version: 0 })
  await db.insert(groupEpochs).values({ groupId: g.id, startedAt, memberAId: memberA, memberBId: memberB })
  return g.id
}

/**
 * The real, current process_account_deletions() body (the last migration that
 * defines it), created as a session-local copy limited to one user and run in
 * one transaction. Two reasons not to call public.process_account_deletions()
 * here: it processes EVERY due account in the database, so in a parallel run it
 * would take other test files' users; and several of those files replace the
 * public function with an older migration's body (0068 / 0069) on the shared
 * local database, which would silently test the wrong code.
 */
async function runAccountDeletionFor(userId: string): Promise<number> {
  const dir = resolve(__dirname, '../../drizzle')
  let body = ''
  for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    const section = readFileSync(resolve(dir, f), 'utf-8').split('--> statement-breakpoint')
      .find((x) => x.includes('CREATE OR REPLACE FUNCTION public.process_account_deletions()'))
    if (section) body = section
  }
  const header = 'CREATE OR REPLACE FUNCTION public.process_account_deletions()'
  const scan = 'WHERE deletion_requested_at IS NOT NULL'
  if (!/^[0-9a-f-]{36}$/.test(userId) || !body.includes(header) || !body.includes(scan)) {
    throw new Error('runAccountDeletionFor: unexpected function body')
  }
  // #1701 — the body ends with sweep_orphan_ledgers(), which prunes EVERY
  // orphan ledger in the database; scoped to one user, it must not run here.
  const sweep = 'PERFORM public.sweep_orphan_ledgers();'
  if (body.includes('sweep_orphan_ledgers') && !body.includes(sweep)) {
    throw new Error('runAccountDeletionFor: unexpected sweep call')
  }
  const scoped = body
    .replace(header, 'CREATE FUNCTION pg_temp.process_account_deletions_1460()')
    .replace(scan, `WHERE id = '${userId}'::uuid AND deletion_requested_at IS NOT NULL`)
    .replace(sweep, 'NULL;')
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(scoped))
    const [row] = await tx.execute<{ n: number }>(sql`SELECT pg_temp.process_account_deletions_1460() AS n`)
    return Number(row.n)
  })
}

const ratioOf = async (txId: string) => {
  const [r] = await db.select({ ratio: cashTransactions.splitRatioA }).from(cashTransactions)
    .where(eq(cashTransactions.id, txId))
  return r.ratio
}

const sharesOf = (file: ExportFile, m: string) => {
  const rows = rowsWith(file, m)
  expect(rows).toHaveLength(1)
  return [cell(file, rows[0], 'myShare'), cell(file, rows[0], 'theirShare')]
}

describe.skipIf(!isLocalDb)('#1460 export across ledgers', () => {
  const t0 = new Date(Date.now() - 30 * D)
  const at = (h: number) => new Date(t0.getTime() + h * H)

  beforeAll(async () => {
    const p = people2
    await db.insert(profiles).values([
      { id: p.A1, displayName: NAME.A1then }, { id: p.B1, displayName: NAME.B1 },
      { id: p.C1, displayName: NAME.C1 }, { id: p.X1, displayName: `${P}_X1` },
      { id: p.A2, displayName: `${P}_A2` }, { id: p.B2, displayName: `${P}_B2` }, { id: p.C2, displayName: `${P}_C2` },
      { id: p.A3, displayName: `${P}_A3` }, { id: p.B3, displayName: `${P}_B3` }, { id: p.C3, displayName: `${P}_C3` },
      { id: p.A4, displayName: `${P}_A4` }, { id: p.R4, displayName: `${P}_R4` },
      { id: p.A5, displayName: `${P}_A5` }, { id: p.B5, displayName: `${P}_B5` }, { id: p.C5, displayName: `${P}_C5` },
      { id: p.Z, displayName: `${P}_Z` },
    ])
    // #1701 — live people have an auth.users row. Without one, a solo ledger
    // whose member_a is one of these ids is an orphan (account gone) and the
    // deletion job's prune purges it.
    const rows = await db.select({ id: profiles.id, displayName: profiles.displayName }).from(profiles)
      .where(inArray(profiles.id, Object.values(p)))
    await seedAuthUsers(rows)

    // ── W1 ──
    w2.G1 = await newLedger(p.A1, p.B1, t0, `${P}_G1`)
    w2.preFirst = await cash(w2.G1, p.B1, 'W1 older than the first chapter', new Date(t0.getTime() - 2 * D))
    w2.W1 = await cash(w2.G1, p.A1, 'W1 weighted', at(24), { splitType: 'weighted', splitRatioA: 70 })
    await cash(w2.G1, p.B1, 'W1 half by B1', at(25))
    await cash(w2.G1, p.A1, 'W1 pending', at(26), { splitType: 'all_theirs', status: 'pending' })
    // An edit is soft delete + insert: the old version must not be exported.
    await cash(w2.G1, p.A1, 'W1 edit v1', at(27), { deletedAt: at(28) })
    await cash(w2.G1, p.A1, 'W1 edit v2', at(28))
    await db.insert(incomeTransactions).values({
      groupId: w2.G1, recipientId: p.B1, amount: 50000, category: 'salary', source: M('W1 income B1'),
      occurredAt: at(29).toISOString().slice(0, 10), createdAt: at(29),
    })
    await db.insert(settlements).values({
      groupId: w2.G1, paidBy: p.B1, amount: 300, note: M('W1 settle B1 to A1'), settledAt: at(30), createdAt: at(30),
    })
    // #1706 (M6) — a soft-deleted settlement inside the same chapter.
    await db.insert(settlements).values({
      groupId: w2.G1, paidBy: p.B1, amount: 7, note: M('W1 settle deleted'),
      settledAt: at(33), createdAt: at(33), deletedAt: at(34),
    })
    await db.insert(incomeTransactions).values({
      groupId: w2.G1, recipientId: p.B1, amount: 1, category: 'salary', source: M('W1 income deleted'),
      occurredAt: at(31).toISOString().slice(0, 10), createdAt: at(31), deletedAt: at(32),
    })

    const left1 = unwrapAction(await as(p.B1, () => leaveGroup()))
    w2.GB1 = left1.groupId
    // After the close, A1 renames: B1's file must keep the name from then.
    await db.update(profiles).set({ displayName: NAME.A1live }).where(eq(profiles.id, p.A1))
    await cash(w2.G1, p.A1, 'W1 A1 solo', await dbNow(), { splitType: 'all_mine' })
    await cash(w2.GB1, p.B1, 'W1 B1 own ledger', await dbNow(), { splitType: 'all_mine' })
    await join(w2.G1, p.A1, p.C1, await dbNow())
    await cash(w2.G1, p.C1, 'W1 C1 in A1+C1', await dbNow())
    await cash(w2.G1, p.A1, 'W1 A1 in A1+C1', await dbNow())
    unwrapAction(await as(p.C1, () => proposeSwap()))
    unwrapAction(await as(p.A1, () => confirmSwap()))

    // Another person's ledger, and a forged OPEN chapter naming B1 on it.
    w2.GX = await newLedger(p.X1, null, t0, `${P}_GX`)
    await cash(w2.GX, p.X1, 'X1 own ledger', at(40), { splitType: 'all_mine' })
    w2.GK = await newLedger(p.X1, null, t0, `${P}_GK`)
    await db.update(groupEpochs).set({ memberBId: p.B1 }).where(eq(groupEpochs.groupId, w2.GK))
    await cash(w2.GK, p.X1, 'GK open chapter naming B1', at(41))

    // ── W2 ──
    w2.G2 = await newLedger(p.A2, p.B2, t0, `${P}_G2`)
    w2.W2 = await cash(w2.G2, p.A2, 'W2 weighted', at(24), { splitType: 'weighted', splitRatioA: 70 })
    unwrapAction(await as(p.B2, () => leaveGroup()))
    await join(w2.G2, p.A2, p.C2, await dbNow())
    await db.update(profiles).set({ deletionRequestedAt: new Date(Date.now() - 15 * D) })
      .where(eq(profiles.id, p.A2))
    expect(await runAccountDeletionFor(p.A2)).toBe(1)

    // ── W3 ──
    w2.G3 = await newLedger(p.A3, p.B3, t0, `${P}_G3`)
    w2.W3 = await cash(w2.G3, p.A3, 'W3 weighted', at(24), { splitType: 'weighted', splitRatioA: 70 })
    unwrapAction(await as(p.B3, () => leaveGroup()))
    await join(w2.G3, p.A3, p.C3, await dbNow())
    await cash(w2.G3, p.C3, 'W3 in A3+C3', await dbNow(), { splitType: 'all_mine' })
    unwrapAction(await as(p.C3, () => proposeSwap()))
    unwrapAction(await as(p.A3, () => confirmSwap()))
    unwrapAction(await as(p.A3, () => leaveGroup()))
    await cash(w2.G3, p.C3, 'W3 C3 solo', await dbNow(), { splitType: 'all_mine' })
    await join(w2.G3, p.C3, p.B3, await dbNow())
    await cash(w2.G3, p.B3, 'W3 in C3+B3', await dbNow())

    // ── W4 ──
    w2.G4 = await newLedger(p.A4, p.R4, t0, `${P}_G4`)
    await cash(w2.G4, p.R4, 'W4 R4 paid', at(24))
    await db.insert(incomeTransactions).values({
      groupId: w2.G4, recipientId: p.R4, amount: 100, category: 'bonus', source: M('W4 R4 income'),
      occurredAt: at(25).toISOString().slice(0, 10), createdAt: at(25),
    })
    unwrapAction(await as(p.A4, () => removePartner()))
    await cash(w2.G4, p.A4, 'W4 A4 after removal', await dbNow(), { splitType: 'all_mine' })

    // ── W5 (#1706, M8): member_a's presence breaks while the ratio parity comes
    // back. Two swaps flip the stored ratio twice (70 → 30 → 70) and A5 ends in
    // slot b, so reading A5's CURRENT slot against the stored ratio is inverted
    // for the A5+B5 chapter, though both chapter members' slots look "fine".
    w2.G5 = await newLedger(p.A5, p.B5, t0, `${P}_G5`)
    w2.W5 = await cash(w2.G5, p.A5, 'W5 weighted', at(24), { splitType: 'weighted', splitRatioA: 70 })
    // B5 owed A5 300 on that row; this one makes the ledger even again, because
    // leaving needs a zero balance.
    await cash(w2.G5, p.B5, 'W5 offset', at(25), { amount: 600 })
    unwrapAction(await as(p.B5, () => proposeSwap()))
    unwrapAction(await as(p.A5, () => confirmSwap()))          // flip #1: B5 is member_a
    unwrapAction(await as(p.A5, () => leaveGroup()))           // member_b leaves
    await join(w2.G5, p.B5, p.C5, await dbNow())
    unwrapAction(await as(p.C5, () => proposeSwap()))
    unwrapAction(await as(p.B5, () => confirmSwap()))          // flip #2: C5 is member_a
    unwrapAction(await as(p.B5, () => leaveGroup()))
    await join(w2.G5, p.C5, p.A5, await dbNow())               // A5 back, as member_b
    await cash(w2.G5, p.A5, 'W5 in C5+A5', await dbNow(), { splitType: 'all_mine' })
  })

  afterAll(async () => {
    const p = people2
    const persons = Object.values(p)
    const groups = (await db.select({ id: oikosGroups.id }).from(oikosGroups)
      .where(sql`${oikosGroups.name} LIKE ${`${P}%`} OR ${oikosGroups.memberA} IN ${persons}
        OR ${oikosGroups.memberB} IN ${persons}`)).map((g) => g.id)
    const all = [...new Set([...groups, ...Object.entries(w2).filter(([k]) => k.startsWith('G')).map(([, v]) => v)])]
    if (all.length > 0) {
      await db.delete(cashTransactions).where(inArray(cashTransactions.groupId, all))
      await db.delete(incomeTransactions).where(inArray(incomeTransactions.groupId, all))
      await db.delete(settlements).where(inArray(settlements.groupId, all))
      await db.delete(groupEpochs).where(inArray(groupEpochs.groupId, all))
      await db.delete(groupBalance).where(inArray(groupBalance.groupId, all))
      await db.delete(oikosGroups).where(inArray(oikosGroups.id, all))
    }
    await deleteAuthUsers(persons)
    await db.delete(profiles).where(inArray(profiles.id, persons))
  })

  it('fixture: the real actions did what the scenarios say', async () => {
    const p = people2
    const g = async (id: string) => (await db.select().from(oikosGroups).where(eq(oikosGroups.id, id)))[0]
    expect(await g(w2.G1)).toMatchObject({ memberA: p.C1, memberB: p.A1 })      // swapped
    expect(await ratioOf(w2.W1)).toBe(30)
    expect(await g(w2.G2)).toMatchObject({ memberA: p.C2, memberB: null })      // promoted
    expect(await ratioOf(w2.W2)).toBe(30)
    expect(await g(w2.G3)).toMatchObject({ memberA: p.C3, memberB: p.B3 })      // B3 back, slot b
    expect(await ratioOf(w2.W3)).toBe(30)
    expect(await g(w2.G4)).toMatchObject({ memberA: p.A4, memberB: null })
    // W5: two swaps put the stored ratio back where it started, A5 holds slot b.
    expect(await g(w2.G5)).toMatchObject({ memberA: p.C5, memberB: p.A5 })
    expect(await ratioOf(w2.W5)).toBe(70)
    const r4Ledgers = await db.select({ id: oikosGroups.id }).from(oikosGroups)
      .where(sql`${oikosGroups.memberA} = ${p.R4} OR ${oikosGroups.memberB} = ${p.R4}`)
    expect(r4Ledgers).toEqual([])
  })

  describe('scope', () => {
    it('a former member gets their closed chapter of the ledger they left, together with their own ledger', async () => {
      const f = await exportFor(people2.B1)
      expect(f.status).toBe(200)
      expect(markers(f)).toEqual([
        'W1 B1 own ledger',
        'W1 edit v2',
        'W1 half by B1',
        'W1 income B1',
        'W1 older than the first chapter',
        'W1 pending',
        'W1 settle B1 to A1',
        'W1 weighted',
      ])
    })

    it('NOT exported to the leaver: the stayer\'s later chapters (solo, and A1+C1 with its rows), another ledger, a forged open chapter', async () => {
      const m = markers(await exportFor(people2.B1))
      for (const x of ['W1 A1 solo', 'W1 C1 in A1+C1', 'W1 A1 in A1+C1', 'X1 own ledger', 'GK open chapter naming B1']) {
        expect(m).not.toContain(x)
      }
    })

    it('NOT exported to the later partner: the chapter before they joined, older rows included', async () => {
      expect(markers(await exportFor(people2.C1))).toEqual(['W1 A1 in A1+C1', 'W1 C1 in A1+C1'])
    })

    it('the stayer gets every chapter of the ledger, each row once; soft-deleted versions never', async () => {
      const f = await exportFor(people2.A1)
      expect(markers(f)).toEqual([
        'W1 A1 in A1+C1', 'W1 A1 solo', 'W1 C1 in A1+C1', 'W1 edit v2', 'W1 half by B1', 'W1 income B1',
        'W1 older than the first chapter', 'W1 pending', 'W1 settle B1 to A1', 'W1 weighted',
      ])
      expect(rowsWith(f, 'W1 older than the first chapter')).toHaveLength(1)
      expect(markers(f)).not.toContain('W1 edit v1')
      expect(markers(f)).not.toContain('W1 income deleted')
      // #1706 (M6) — nor a soft-deleted settlement.
      expect(markers(f)).not.toContain('W1 settle deleted')
      expect(rowsWith(f, 'W1 settle B1 to A1')).toHaveLength(1)
    })

    it('a former member\'s file carries no soft-deleted settlement either (#1706)', async () => {
      expect(markers(await exportFor(people2.B1))).not.toContain('W1 settle deleted')
    })

    it('a removed partner with no ledger at all exports the closed chapter they were in', async () => {
      const f = await exportFor(people2.R4)
      expect(f.status).toBe(200)
      expect(markers(f)).toEqual(['W4 R4 income', 'W4 R4 paid'])
    })

    it('someone with no chapter anywhere: 200 with only the header', async () => {
      const f = await exportFor(people2.Z)
      expect(f.status).toBe(200)
      expect(f.rows).toEqual([])
      expect(f.header).toEqual(Object.values(zhTW.csvExport.columns))
    })

    it('rows run newest event date first', async () => {
      const f = await exportFor(people2.A1)
      const dates = f.rows.map((r) => cell(f, r, 'date') ?? '')
      expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true)
      expect([...dates].sort().reverse()).toEqual(dates)
    })

    it('for a current member, each ledger\'s expense rows are exactly viewerChaptersClause\'s', async () => {
      const { getLedgerExportForViewer } = await import('@/lib/db/queries/export')
      for (const [viewer, groupId] of [[people2.A1, w2.G1], [people2.C1, w2.G1], [people2.B1, w2.GB1], [people2.B3, w2.G3]]) {
        const { dbRows } = await getLedgerExportForViewer(viewer)
        const mine = dbRows.filter((r) => r.kind === 'expense' && r.groupId === groupId).map((r) => r.id).sort()
        const byClause = (await db.select({ id: cashTransactions.id }).from(cashTransactions).where(and(
          eq(cashTransactions.groupId, groupId),
          isNull(cashTransactions.deletedAt),
          viewerChaptersClause('"CashTransactions"."created_at"', groupId, viewer),
        ))).map((r) => r.id).sort()
        expect(mine).toEqual(byClause)
      }
    })
  })

  describe('kinds, names and labels', () => {
    it('income and settlement rows carry their type, people and labels', async () => {
      const f = await exportFor(people2.B1)
      const [inc] = rowsWith(f, 'W1 income B1')
      expect(cell(f, inc, 'type')).toBe(zhTW.csvExport.types.income)
      expect(cell(f, inc, 'category')).toBe(zhTW.incomeCategory.salary)
      expect(cell(f, inc, 'person')).toBe(NAME.B1)
      expect(cell(f, inc, 'amount')).toBe('50000')
      expect(cell(f, inc, 'currency')).toBe('TWD')
      const [st] = rowsWith(f, 'W1 settle B1 to A1')
      expect(cell(f, st, 'type')).toBe(zhTW.csvExport.types.settlement)
      expect(cell(f, st, 'person')).toBe(NAME.B1)
      expect(cell(f, st, 'settlementTo')).toBe(NAME.A1then)
      const [pend] = rowsWith(f, 'W1 pending')
      expect(cell(f, pend, 'type')).toBe(zhTW.csvExport.types.expense)
      expect(cell(f, pend, 'status')).toBe(zhTW.addSheet.statusPending)
    })

    it('a closed chapter shows the names frozen at its close, never the later live name', async () => {
      const f = await exportFor(people2.B1)
      const [w] = rowsWith(f, 'W1 weighted')
      expect(cell(f, w, 'person')).toBe(NAME.A1then)
      expect(cell(f, w, 'chapter')).toContain(NAME.A1then)
      for (const r of f.rows) expect(r.join('|')).not.toContain(NAME.A1live)
    })

    it('the open chapter shows live names; the stayer\'s own closed chapter keeps theirs from then', async () => {
      const f = await exportFor(people2.A1)
      expect(cell(f, rowsWith(f, 'W1 A1 in A1+C1')[0], 'person')).toBe(NAME.A1live)
      expect(cell(f, rowsWith(f, 'W1 weighted')[0], 'person')).toBe(NAME.A1then)
    })

    it('a deleted account\'s name reads as the snapshot 「已離開的夥伴」', async () => {
      const f = await exportFor(people2.B2)
      expect(cell(f, rowsWith(f, 'W2 weighted')[0], 'person')).toBe('已離開的夥伴')
    })
  })

  describe('split shares (rev3: continuous presence)', () => {
    // #1706 (M8) — the break is on the chapter's member_a. E1 is A5(a) + B5(b);
    // A5 is named on E1 and on today's chapter but not on the ones between
    // (B5 solo, B5+C5, C5 solo), and holds slot b now. The two swaps put the
    // stored ratio back to 70, so a current-slot reading says A5 bore 30.
    it('(f) member_a is absent from a middle chapter and rejoins → blank for A5 and for B5; never an inverted share', async () => {
      expect(sharesOf(await exportFor(people2.A5), 'W5 weighted')).toEqual(['', ''])
      expect(sharesOf(await exportFor(people2.B5), 'W5 weighted')).toEqual(['', ''])
    })

    it('(f) scope: A5 gets the A5+B5 chapter and the C5+A5 one, nothing from the chapters in between', async () => {
      expect(markers(await exportFor(people2.A5))).toEqual(['W5 in C5+A5', 'W5 offset', 'W5 weighted'])
    })

    it('(a) B leaves, C joins A, A and C swap → B\'s file shows 30% / 70%', async () => {
      expect(sharesOf(await exportFor(people2.B1), 'W1 weighted')).toEqual(['30%', '70%'])
    })

    it('(c) A\'s own file after the swap shows 70% / 30%', async () => {
      expect(sharesOf(await exportFor(people2.A1), 'W1 weighted')).toEqual(['70%', '30%'])
    })

    it('half / all_theirs resolve against the stored payer, as transactionDelta does', async () => {
      const b = await exportFor(people2.B1)
      expect(sharesOf(b, 'W1 half by B1')).toEqual(['50%', '50%'])
      expect(sharesOf(b, 'W1 pending')).toEqual(['100%', '0%'])  // A1 paid, all B1's
      const a = await exportFor(people2.A1)
      expect(sharesOf(a, 'W1 pending')).toEqual(['0%', '100%'])
    })

    it('(b) A (member_a) deletes their account and C is promoted → B\'s file shows blank shares', async () => {
      expect(sharesOf(await exportFor(people2.B2), 'W2 weighted')).toEqual(['', ''])
    })

    it('(d) B left, C joined, A and C swapped, A left, C re-invited B → B\'s file shows blank shares; so does A\'s', async () => {
      expect(sharesOf(await exportFor(people2.B3), 'W3 weighted')).toEqual(['', ''])
      expect(sharesOf(await exportFor(people2.A3), 'W3 weighted')).toEqual(['', ''])
    })

    it('(d) scope: B gets their first chapter and the new C3+B3 chapter, not A3+C3 or C3 solo', async () => {
      expect(markers(await exportFor(people2.B3))).toEqual(['W3 in C3+B3', 'W3 weighted'])
    })

    it('(e) then B swaps into slot a → still blank for B and for A; no file shows flipped shares', async () => {
      unwrapAction(await as(people2.C3, () => proposeSwap()))
      unwrapAction(await as(people2.B3, () => confirmSwap()))
      const [g] = await db.select().from(oikosGroups).where(eq(oikosGroups.id, w2.G3))
      expect(g).toMatchObject({ memberA: people2.B3, memberB: people2.C3 })
      expect(await ratioOf(w2.W3)).toBe(70)
      expect(sharesOf(await exportFor(people2.B3), 'W3 weighted')).toEqual(['', ''])
      expect(sharesOf(await exportFor(people2.A3), 'W3 weighted')).toEqual(['', ''])
      expect(markers(await exportFor(people2.C3))).not.toContain('W3 weighted')
    })
  })
})
