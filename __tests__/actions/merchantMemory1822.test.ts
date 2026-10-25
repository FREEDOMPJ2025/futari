// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { seedAuthUsers, deleteAuthUsers } from './_authUser'

// ─── #1822 — merchant memory against the real dev database ────────────────
//
// Ledger G, two chapters:
//
//   G:  [A+B] ──B leaves, C joins──▶ [A+C]
//
// B recorded "Mystery Clinic" as health in the A+B chapter. Expected:
//   - C (joined later) gets NO category for "Mystery Clinic": C was never in
//     that chapter (same scope as the description autocomplete);
//   - A, who was in both chapters, still gets health.
// Plus: a match older than 100 newer rows of other merchants is still found
// (no recency window); fullwidth ↔ halfwidth match; soft-deleted rows never
// surface; and the SQL normalization agrees with `normalizeMerchant`.
//
// Ledgers X / Y (route): R left X (still member_a of the solo X) and joined Y
// later as member_b. A Shortcut POST must read Y — the active ledger, the one
// confirm writes into — not X.
//
// Failure looks like: nothing errors. C's quick add / shortcut card silently
// pre-picks a category taken from a record C cannot see; a merchant used a
// while ago falls back to the default; R's card carries X's category.
//
// Commits rows to the shared dev DB (oikos-dev) and deletes them afterwards.
// Integration folder — excluded from CI.
// ──────────────────────────────────────────────────────────────────────────

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

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

if (!process.env.DATABASE_URL?.includes('ufhcprrauwsxdmscbkrf')) {
  throw new Error('#1822 dev-DB test: DATABASE_URL must point at the dev project (oikos-dev)')
}

const { AsyncLocalStorage } = await import('node:async_hooks')
const viewerStore = new AsyncLocalStorage<string>()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        const id = viewerStore.getStore()
        return { data: { user: id ? { id } : null }, error: null }
      },
    },
  }),
  getCurrentUser: async () => {
    const id = viewerStore.getStore()
    return id ? { id } : null
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}))
vi.mock('@/lib/analytics/server', () => ({
  captureServer: async () => {},
  isUserFirstNonDeletedRecord: async () => false,
}))
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }))

const { db } = await import('@/lib/db/client')
const {
  profiles, oikosGroups, groupBalance, groupEpochs, cashTransactions,
  shortcutKeys, shortcutPendingExpenses,
} = await import('@/lib/db/schema')
const { getCategoryForMerchant, merchantKeySql, normalizeMerchant } = await import('@/lib/db/queries/merchantMemory')
const { getMerchantCategory } = await import('@/actions/transaction')
const { generateShortcutKey } = await import('@/actions/shortcutKey')
const { POST } = await import('@/app/api/shortcut/pending/route')
const { unwrapAction } = await import('@/lib/action-errors')
const { eq, inArray, sql } = await import('drizzle-orm')

const as = <T>(userId: string, fn: () => Promise<T>) => viewerStore.run(userId, fn)

const T = 'TEST_1822'
const H = 60 * 60 * 1000
const D = 24 * H
const p = { A: randomUUID(), B: randomUUID(), C: randomUUID(), R: randomUUID(), S: randomUUID() }
const g = { G: '', X: '', Y: '' }

async function addTx(
  groupId: string, paidBy: string, description: string, category: string, createdAt: Date,
  deletedAt: Date | null = null,
) {
  await db.insert(cashTransactions).values({
    groupId, paidBy, amount: 100, splitType: 'all_mine',
    description, category, transactedAt: createdAt, createdAt, deletedAt,
  })
}

async function ledger(name: string, memberA: string, memberB: string | null, startedAt: Date) {
  const [row] = await db.insert(oikosGroups).values({
    name: `${T}_${name}`, memberA, memberB, currentEpochStartedAt: startedAt,
  }).returning({ id: oikosGroups.id })
  await db.insert(groupBalance).values({ groupId: row.id, balance: 0, version: 0 })
  return row.id
}

const t0 = new Date(Date.now() - 30 * D)
const t1 = new Date(t0.getTime() + 10 * D) // B leaves, C joins

beforeAll(async () => {
  const people = Object.entries(p).map(([k, id]) => ({ id, displayName: `${T}_${k}` }))
  await db.insert(profiles).values(people)
  await seedAuthUsers(people)

  // G: member_b is set for its whole life (B, then C), so the orphan sweep
  // never touches it; the OikosGroups row already shows the A+C state.
  g.G = await ledger('G', p.A, p.C, t1)
  await db.insert(groupEpochs).values([
    { groupId: g.G, startedAt: t0, endedAt: t1, memberAId: p.A, memberBId: p.B },
    { groupId: g.G, startedAt: t1, memberAId: p.A, memberBId: p.C },
  ])

  // (a) chapter A+B only.
  await addTx(g.G, p.B, 'Mystery Clinic', 'health', new Date(t0.getTime() + D))

  // (b) an A+C match, then 120 newer rows of other merchants.
  await addTx(g.G, p.A, 'Old Bakery', 'clothing', new Date(t1.getTime() + H))
  const filler = Array.from({ length: 120 }, (_, i) => ({
    groupId: g.G, paidBy: p.C, amount: 1, splitType: 'all_mine' as const,
    description: `${T} filler ${i}`, category: 'other',
    transactedAt: new Date(t1.getTime() + 2 * H + i * 60_000),
    createdAt: new Date(t1.getTime() + 2 * H + i * 60_000),
  }))
  await db.insert(cashTransactions).values(filler)

  // (c) fullwidth stored (letters + ideographic space), halfwidth stored.
  await addTx(g.G, p.C, 'ＦＵＬＬ　ＭＡＲＴ', 'transit', new Date(t1.getTime() + 3 * D))
  await addTx(g.G, p.C, '7-Eleven', 'entertainment', new Date(t1.getTime() + 3 * D))

  // (d) the newest "Gone Cafe" row is soft-deleted; an older live one remains.
  await addTx(g.G, p.A, 'Gone Cafe', 'dining', new Date(t1.getTime() + 4 * D))
  await addTx(g.G, p.A, 'Gone Cafe', 'health', new Date(t1.getTime() + 5 * D), new Date(t1.getTime() + 6 * D))
  await addTx(g.G, p.A, 'Only Deleted', 'health', new Date(t1.getTime() + 5 * D), new Date(t1.getTime() + 6 * D))

  // Route: R's old solo ledger X (inserted first) and the re-joined Y.
  g.X = await ledger('X', p.R, null, t1)
  await db.insert(groupEpochs).values({ groupId: g.X, startedAt: t1, memberAId: p.R, memberBId: null })
  const t2 = new Date(t1.getTime() + 2 * D)
  g.Y = await ledger('Y', p.S, p.R, t2)
  await db.insert(groupEpochs).values({ groupId: g.Y, startedAt: t2, memberAId: p.S, memberBId: p.R })
  await addTx(g.X, p.R, 'Corner Shop', 'transit', new Date(t1.getTime() + H))
  await addTx(g.Y, p.S, 'Corner Shop', 'health', new Date(t2.getTime() + H))
})

afterAll(async () => {
  try {
    const ids = Object.values(p)
    await db.delete(shortcutPendingExpenses).where(inArray(shortcutPendingExpenses.userId, ids))
    await db.delete(shortcutKeys).where(inArray(shortcutKeys.userId, ids))
    const groups = Object.values(g).filter(Boolean)
    if (groups.length) {
      await db.delete(cashTransactions).where(inArray(cashTransactions.groupId, groups))
      await db.delete(groupEpochs).where(inArray(groupEpochs.groupId, groups))
      await db.delete(groupBalance).where(inArray(groupBalance.groupId, groups))
      await db.delete(oikosGroups).where(inArray(oikosGroups.id, groups))
    }
    await deleteAuthUsers(ids)
    await db.delete(profiles).where(inArray(profiles.id, ids))
  } catch (err) {
    console.error('cleanup failed', err)
  }
})

describe('#1822 merchant memory (dev DB)', () => {
  it('(a) a partner who joined later gets nothing from an earlier chapter; the member of both still does', async () => {
    expect(await getCategoryForMerchant(g.G, p.C, 'Mystery Clinic')).toBeUndefined()
    expect(await getCategoryForMerchant(g.G, p.A, 'Mystery Clinic')).toBe('health')
    // Same through the server action the AddSheet calls (viewer from the session).
    expect(unwrapAction(await as(p.C, () => getMerchantCategory('Mystery Clinic')))).toBeNull()
    expect(unwrapAction(await as(p.A, () => getMerchantCategory('mystery clinic')))).toBe('health')
  })

  it('(b) a match older than 100 newer rows of other merchants is still found', async () => {
    expect(await getCategoryForMerchant(g.G, p.C, 'old bakery')).toBe('clothing')
  })

  it('(c) fullwidth and halfwidth match both ways', async () => {
    expect(await getCategoryForMerchant(g.G, p.A, ' full mart ')).toBe('transit')
    expect(await getCategoryForMerchant(g.G, p.A, '７－ＥＬＥＶＥＮ')).toBe('entertainment')
  })

  it('(d) soft-deleted rows are ignored', async () => {
    expect(await getCategoryForMerchant(g.G, p.A, 'Gone Cafe')).toBe('dining')
    expect(await getCategoryForMerchant(g.G, p.A, 'Only Deleted')).toBeUndefined()
  })

  it('no match / empty merchant → undefined', async () => {
    expect(await getCategoryForMerchant(g.G, p.A, 'Never Seen Here')).toBeUndefined()
    expect(await getCategoryForMerchant(g.G, p.A, '   ')).toBeUndefined()
  })

  it('SQL normalization agrees with normalizeMerchant', async () => {
    const samples = [
      'Starbucks', 'STARBUCKS', '  Cafe  ', '\t\nCafe\r\n', 'Cafe  Latte',
      '７－ＥＬＥＶＥＮ', '７−ＥＬＥＶＥＮ', '７ーＥＬＥＶＥＮ', 'ＦＵＬＬ　ＭＡＲＴ　',
      'Café', 'Café', 'C\'est Bon! (好吃)', ' nbsp ', '﻿bom ', '星巴克 Ｃｏｆｆｅｅ',
    ]
    for (const s of samples) {
      const [row] = await db.execute<{ k: string }>(sql`SELECT ${merchantKeySql(sql`${s}::text`)} AS k`)
      expect(row.k, JSON.stringify(s)).toBe(normalizeMerchant(s))
    }
  })

  it('route: a Shortcut POST reads the active (re-joined) ledger and prefers memory over the payload category', async () => {
    const key = unwrapAction(await as(p.R, () => generateShortcutKey())).key
    const res = await POST(new Request('https://futari.southern-light.dev/api/shortcut/pending', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ amount: 120, category: 'dining', note: 'corner shop' }),
    }))
    expect(res.status).toBe(201)
    const cards = await db.select({ category: shortcutPendingExpenses.category })
      .from(shortcutPendingExpenses).where(eq(shortcutPendingExpenses.userId, p.R))
    expect(cards).toEqual([{ category: 'health' }])
  })
})
