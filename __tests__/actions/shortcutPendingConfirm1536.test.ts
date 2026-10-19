// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'
import { person } from './_deletionWorld1701'

// ─── #1536 S4 — confirm / edit-and-confirm / skip a shortcut card ───────────
//
// LOCAL THROWAWAY SERVER ONLY (stand-in database migrated through 0098 on the
// local server DATABASE_URL points at; skips otherwise):
//
//   DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres \
//   DATABASE_URL_DIRECT=<same> \
//     npx vitest run --no-file-parallelism __tests__/actions/shortcutPendingConfirm1536.test.ts
//
// The real actions run against the stand-in through the app's own db client.
// What each failure would look like in production (none of them errors):
//   - confirm without the shared side effects: the record shows in the feed
//     but GroupBalance keeps its old value and version, so the hero's balance
//     is wrong until some other write recomputes it;
//   - insert-then-delete instead of DELETE-RETURNING-then-insert: a double tap
//     records the same purchase twice;
//   - a card query without `user_id`: someone holding a card id confirms or
//     skips another person's card;
//   - the UTC day instead of the Taipei day: a card made at 00:30 Taipei lands
//     on yesterday.
// ──────────────────────────────────────────────────────────────────────────────

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 })

const { AsyncLocalStorage } = await import('node:async_hooks')
const viewerStore = new AsyncLocalStorage<string>()
const pin = vi.hoisted(() => ({ epochId: null as string | null }))
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
const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a), revalidateTag: () => {} }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'futari_past_epoch' && pin.epochId ? { value: pin.epochId } : undefined),
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}))
const captureServer = vi.fn()
vi.mock('@/lib/analytics/server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/analytics/server')>('@/lib/analytics/server')
  return { ...actual, captureServer: (...a: unknown[]) => captureServer(...a) }
})

const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)
let standInUrl = ''
if (isLocalDb) {
  standInUrl = await createStandInDb(
    adminUrl,
    // #1782 — the app code under test names every column of today's schema
    // (0099 added marker columns): a stand-in pinned to an older migration
    // fails with "column does not exist". Always the latest.
    (JSON.parse(readFileSync(resolve(__dirname, '../../drizzle/meta/_journal.json'), 'utf-8')) as { entries: { tag: string }[] })
    .entries.at(-1)!.tag.slice(0, 4),
  )
  process.env.DATABASE_URL = standInUrl
  process.env.DATABASE_URL_DIRECT = standInUrl
}

const postgres = (await import('postgres')).default
const { confirmShortcutPending, skipShortcutPending } = await import('@/actions/shortcutPending')
const { listShortcutPendingsForViewer } = await import('@/lib/db/queries/shortcutPending')
const { taipeiDayOf } = await import('@/lib/monthKey')

const as = <T>(userId: string, fn: () => Promise<T>) => viewerStore.run(userId, fn)

let pg: Sql

interface Duo { a: string; b: string; g: string }
/** A duo ledger with one open chapter; `ratioA` = the ledger's default split (member A's share). */
async function duo(ratioA: number | null): Promise<Duo> {
  const a = await person(pg, `a ${randomUUID().slice(0, 6)}`)
  const b = await person(pg, `b ${randomUUID().slice(0, 6)}`)
  const started = new Date(Date.now() - 90 * 86400_000)
  const [{ id: g }] = await pg<{ id: string }[]>`
    INSERT INTO "OikosGroups" (name, member_a, member_b, default_split_ratio_a, current_epoch_started_at)
    VALUES ('duo', ${a}, ${b}, ${ratioA}, ${started}) RETURNING id`
  await pg`INSERT INTO "GroupBalance" (group_id, balance, version) VALUES (${g}, 0, 0)`
  await pg`INSERT INTO "GroupEpochs" (group_id, started_at, ended_at, member_a_id, member_b_id) VALUES (${g}, ${started}, NULL, ${a}, ${b})`
  return { a, b, g }
}

async function solo(): Promise<{ a: string; g: string }> {
  const a = await person(pg, `s ${randomUUID().slice(0, 6)}`)
  const started = new Date(Date.now() - 90 * 86400_000)
  const [{ id: g }] = await pg<{ id: string }[]>`
    INSERT INTO "OikosGroups" (name, member_a, member_b, current_epoch_started_at)
    VALUES ('solo', ${a}, NULL, ${started}) RETURNING id`
  await pg`INSERT INTO "GroupBalance" (group_id, balance, version) VALUES (${g}, 0, 0)`
  await pg`INSERT INTO "GroupEpochs" (group_id, started_at, ended_at, member_a_id, member_b_id) VALUES (${g}, ${started}, NULL, ${a}, NULL)`
  return { a, g }
}

interface CardSpec { amount?: number; category?: string | null; description?: string | null; createdAt?: Date; skipped?: boolean }
async function card(userId: string, c: CardSpec = {}): Promise<string> {
  const [{ id }] = await pg<{ id: string }[]>`
    INSERT INTO "ShortcutPendingExpenses" (user_id, amount, category, description, created_at, skipped_at)
    VALUES (${userId}, ${c.amount ?? 1000}, ${c.category === undefined ? 'dining' : c.category},
            ${c.description === undefined ? '午餐' : c.description},
            ${c.createdAt ?? new Date()}, ${c.skipped ? new Date() : null})
    RETURNING id`
  return id
}

const cardCount = async (id: string) =>
  (await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM "ShortcutPendingExpenses" WHERE id = ${id}`)[0].n
const txsOf = (g: string) => pg<{
  id: string; paid_by: string; amount: number; split_type: string; split_ratio_a: number | null
  description: string; category: string; day: string
}[]>`
  SELECT id, paid_by, amount, split_type, split_ratio_a, description, category,
         to_char(transacted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
  FROM "CashTransactions" WHERE group_id = ${g} AND deleted_at IS NULL ORDER BY created_at`
const balanceOf = async (g: string) =>
  (await pg<{ balance: number; version: number }[]>`SELECT balance, version FROM "GroupBalance" WHERE group_id = ${g}`)[0]
const events = (name: string) => captureServer.mock.calls.filter((c) => c[1] === name)

describe.skipIf(!isLocalDb)('#1536 S4 — shortcut pending actions (stand-in through 0098)', () => {
  beforeAll(() => {
    pg = postgres(standInUrl, { max: 4, onnotice: () => {} })
  })

  afterEach(() => {
    captureServer.mockClear()
    revalidatePath.mockClear()
    pin.epochId = null
  })

  afterAll(async () => {
    await pg?.end()
    const { db } = await import('@/lib/db/client')
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
    if (standInUrl) await dropStandInDb(adminUrl, standInUrl)
  })

  it('one-tap confirm in a half ledger: record, recomputed balance + version, card gone, events and revalidate', async () => {
    const { a, g } = await duo(null)
    const id = await card(a, { amount: 1000, category: 'dining', description: '午餐' })
    const res = await as(a, () => confirmShortcutPending(id))
    expect(res.ok).toBe(true)

    const txs = await txsOf(g)
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({
      paid_by: a, amount: 1000, split_type: 'half', split_ratio_a: null, description: '午餐', category: 'dining',
    })
    // A (member A) paid 1000 and splits evenly: the partner owes 500.
    expect(await balanceOf(g)).toEqual({ balance: 500, version: 1 })
    expect(await cardCount(id)).toBe(0)

    // Both pages revalidated; first record + record_created via 'shortcut'.
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard')
    expect(revalidatePath).toHaveBeenCalledWith('/records')
    expect(events('first_record_created')).toEqual([[a, 'first_record_created', { via: 'shortcut' }]])
    expect(events('record_created')).toEqual([[a, 'record_created', { via: 'shortcut', group_id: g }]])
    // No note or amount in any analytics payload.
    expect(JSON.stringify(captureServer.mock.calls)).not.toMatch(/午餐|1000/)

    // A second record is not a first record.
    captureServer.mockClear()
    const id2 = await card(a)
    expect((await as(a, () => confirmShortcutPending(id2))).ok).toBe(true)
    expect(events('first_record_created')).toHaveLength(0)
    expect(events('record_created')).toHaveLength(1)
    expect((await balanceOf(g)).version).toBe(2)
  })

  it('one-tap confirm in a weighted ledger carries split_ratio_a; member B as viewer pays with the ledger ratio', async () => {
    const { a, b, g } = await duo(70)
    const idA = await card(a, { amount: 1000 })
    expect((await as(a, () => confirmShortcutPending(idA))).ok).toBe(true)
    const [t1] = await txsOf(g)
    expect(t1).toMatchObject({ paid_by: a, split_type: 'weighted', split_ratio_a: 70 })
    // A paid 1000 and carries 70%: B owes 300.
    expect(await balanceOf(g)).toEqual({ balance: 300, version: 1 })

    const idB = await card(b, { amount: 1000 })
    expect((await as(b, () => confirmShortcutPending(idB))).ok).toBe(true)
    const txs = await txsOf(g)
    expect(txs[1]).toMatchObject({ paid_by: b, split_type: 'weighted', split_ratio_a: 70 })
    // B paid 1000, A carries 70% = 700 owed to B: 300 - 700.
    expect(await balanceOf(g)).toEqual({ balance: -400, version: 2 })
  })

  it('solo ledger: the record is all_mine', async () => {
    const { a, g } = await solo()
    const id = await card(a)
    expect((await as(a, () => confirmShortcutPending(id))).ok).toBe(true)
    expect((await txsOf(g))[0]).toMatchObject({ paid_by: a, split_type: 'all_mine', split_ratio_a: null })
    expect(await balanceOf(g)).toEqual({ balance: 0, version: 1 })
  })

  it('files the record under the Asia/Taipei day of created_at, not the UTC day', async () => {
    const { a, g } = await duo(null)
    // Yesterday 00:30 and 23:30 Taipei. The first is the day before in UTC.
    const taipeiMidnight = (daysAgo: number) => {
      const day = taipeiDayOf(new Date(Date.now() - daysAgo * 86400_000))
      return new Date(`${day}T00:00:00+08:00`)
    }
    const early = new Date(taipeiMidnight(2).getTime() + 30 * 60_000)
    const late = new Date(taipeiMidnight(2).getTime() + (23 * 60 + 30) * 60_000)
    expect(early.toISOString().slice(0, 10)).not.toBe(taipeiDayOf(early))
    const idEarly = await card(a, { createdAt: early })
    const idLate = await card(a, { createdAt: late })
    expect((await as(a, () => confirmShortcutPending(idEarly))).ok).toBe(true)
    expect((await as(a, () => confirmShortcutPending(idLate))).ok).toBe(true)
    const days = (await txsOf(g)).map((t) => t.day)
    expect(days).toEqual([taipeiDayOf(early), taipeiDayOf(late)])
    expect(days[0]).toBe(days[1])
  })

  it('a no-note card: one-tap answers a code and keeps the card; edit-and-confirm with a description works; null category is other', async () => {
    const { a, g } = await duo(null)
    const id = await card(a, { description: null, category: null })
    const res = await as(a, () => confirmShortcutPending(id))
    expect(res).toEqual({ ok: false, code: 'shortcut_pending_needs_note' })
    expect(await cardCount(id)).toBe(1)
    expect(await txsOf(g)).toHaveLength(0)
    expect((await balanceOf(g)).version).toBe(0)
    expect(captureServer).not.toHaveBeenCalled()

    // A blank override is no note either.
    expect(await as(a, () => confirmShortcutPending(id, { description: '   ' })))
      .toEqual({ ok: false, code: 'shortcut_pending_needs_note' })

    const ok = await as(a, () => confirmShortcutPending(id, { description: '早餐' }))
    expect(ok.ok).toBe(true)
    expect((await txsOf(g))[0]).toMatchObject({ description: '早餐', category: 'other' })
    expect(await cardCount(id)).toBe(0)
  })

  it('edit-and-confirm applies overrides (amount, category, split, payer, date) through the createTransaction validation', async () => {
    const { a, b, g } = await duo(null)
    const id = await card(a, { amount: 1000, description: '午餐' })
    const res = await as(a, () => confirmShortcutPending(id, {
      amount: 600, description: '晚餐', category: 'dining', splitType: 'weighted', splitRatioA: 25, paidBy: b, transactedAt: '2026-09-01',
    }))
    expect(res.ok).toBe(true)
    expect((await txsOf(g))[0]).toMatchObject({
      paid_by: b, amount: 600, split_type: 'weighted', split_ratio_a: 25, description: '晚餐', day: '2026-09-01',
    })
    // The viewer (A) is the one whose first-record signal counts paid_by = viewer: B paid, so none.
    expect(events('first_record_created')).toHaveLength(0)
    expect(events('record_created')).toHaveLength(1)
  })

  it('an override the validator rejects answers a code and keeps the card', async () => {
    const { a, g } = await duo(null)
    const id = await card(a)
    for (const bad of [{ amount: 0 }, { amount: 10_000_000 }, { transactedAt: '2026-02-30' }, { splitType: 'weighted' as const, splitRatioA: null }]) {
      expect(await as(a, () => confirmShortcutPending(id, bad))).toEqual({ ok: false, code: 'shortcut_pending_invalid' })
    }
    // A payer outside the ledger is refused with the existing code.
    const stranger = await person(pg, 'stranger')
    expect(await as(a, () => confirmShortcutPending(id, { paidBy: stranger }))).toEqual({ ok: false, code: 'payer_not_in_group' })
    expect(await cardCount(id)).toBe(1)
    expect(await txsOf(g)).toHaveLength(0)
    expect(await balanceOf(g)).toEqual({ balance: 0, version: 0 })
  })

  it('two parallel confirms record exactly once; the other answers handled_elsewhere', async () => {
    const { a, g } = await duo(null)
    const id = await card(a)
    const results = await Promise.all([
      as(a, () => confirmShortcutPending(id)),
      as(a, () => confirmShortcutPending(id)),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'shortcut_pending_handled_elsewhere' }])
    expect(await txsOf(g)).toHaveLength(1)
    expect(await balanceOf(g)).toEqual({ balance: 500, version: 1 })
    expect(events('record_created')).toHaveLength(1)
  })

  it('confirm after skip, skip after confirm, and skip twice are all handled_elsewhere', async () => {
    const { a, g } = await duo(null)
    const skipped = await card(a)
    expect((await as(a, () => skipShortcutPending(skipped))).ok).toBe(true)
    expect(await as(a, () => confirmShortcutPending(skipped))).toEqual({ ok: false, code: 'shortcut_pending_handled_elsewhere' })
    expect(await as(a, () => skipShortcutPending(skipped))).toEqual({ ok: false, code: 'shortcut_pending_handled_elsewhere' })
    expect(await txsOf(g)).toHaveLength(0)
    const [{ skipped_at }] = await pg<{ skipped_at: Date | null }[]>`SELECT skipped_at FROM "ShortcutPendingExpenses" WHERE id = ${skipped}`
    expect(skipped_at).not.toBeNull()

    const done = await card(a)
    expect((await as(a, () => confirmShortcutPending(done))).ok).toBe(true)
    expect(await as(a, () => skipShortcutPending(done))).toEqual({ ok: false, code: 'shortcut_pending_handled_elsewhere' })
  })

  it("another user's card id: confirm and skip answer handled_elsewhere and leave it untouched", async () => {
    const { a, b, g } = await duo(null)
    const mine = await card(a)
    expect(await as(b, () => confirmShortcutPending(mine))).toEqual({ ok: false, code: 'shortcut_pending_handled_elsewhere' })
    expect(await as(b, () => skipShortcutPending(mine))).toEqual({ ok: false, code: 'shortcut_pending_handled_elsewhere' })
    const [row] = await pg<{ skipped_at: Date | null }[]>`SELECT skipped_at FROM "ShortcutPendingExpenses" WHERE id = ${mine}`
    expect(row.skipped_at).toBeNull()
    expect(await txsOf(g)).toHaveLength(0)
    expect(await balanceOf(g)).toEqual({ balance: 0, version: 0 })
  })

  it("the partner's dashboard data never contains the owner's cards", async () => {
    const { a, b } = await duo(null)
    await card(a, { amount: 111 })
    await card(a, { amount: 222 })
    expect((await listShortcutPendingsForViewer(a)).map((c) => c.amount).sort()).toEqual([111, 222])
    expect(await listShortcutPendingsForViewer(b)).toEqual([])
  })

  it('lists the owner\'s open cards newest first, with the Taipei day, without skipped or 30-day-old ones', async () => {
    const { a } = await duo(null)
    const day = 86400_000
    await card(a, { amount: 1, createdAt: new Date(Date.now() - 3 * day) })
    await card(a, { amount: 2, createdAt: new Date(Date.now() - 1 * day) })
    await card(a, { amount: 3, createdAt: new Date(Date.now() - 29 * day) })
    await card(a, { amount: 4, createdAt: new Date(Date.now() - 31 * day) })
    await card(a, { amount: 5, skipped: true })
    const list = await listShortcutPendingsForViewer(a)
    expect(list.map((c) => c.amount)).toEqual([2, 1, 3])
    expect(list[0].day).toBe(taipeiDayOf(new Date(Date.now() - 1 * day)))
    expect(Object.keys(list[0]).sort()).toEqual(['amount', 'category', 'day', 'id', 'note'])
  })

  it('a card older than 30 days cannot be confirmed or skipped', async () => {
    const { a, g } = await duo(null)
    const old = await card(a, { createdAt: new Date(Date.now() - 31 * 86400_000) })
    expect(await as(a, () => confirmShortcutPending(old))).toEqual({ ok: false, code: 'shortcut_pending_handled_elsewhere' })
    expect(await as(a, () => skipShortcutPending(old))).toEqual({ ok: false, code: 'shortcut_pending_handled_elsewhere' })
    expect(await cardCount(old)).toBe(1)
    expect(await txsOf(g)).toHaveLength(0)
    // 29 days is still fine.
    const fresh = await card(a, { createdAt: new Date(Date.now() - 29 * 86400_000) })
    expect((await as(a, () => confirmShortcutPending(fresh))).ok).toBe(true)
  })

  it('a viewer pinned to a past chapter is rejected and nothing changes', async () => {
    const { a, b, g } = await duo(null)
    // Close the open chapter's predecessor: make a closed chapter A+B to pin to.
    const [{ id: closed }] = await pg<{ id: string }[]>`
      INSERT INTO "GroupEpochs" (group_id, started_at, ended_at, member_a_id, member_b_id)
      VALUES (${g}, now() - interval '200 days', now() - interval '100 days', ${a}, ${b}) RETURNING id`
    const id = await card(a)
    pin.epochId = closed
    await expect(as(a, () => confirmShortcutPending(id))).rejects.toThrow('過去章節不可編輯')
    pin.epochId = null
    expect(await cardCount(id)).toBe(1)
    expect(await txsOf(g)).toHaveLength(0)
    expect(await balanceOf(g)).toEqual({ balance: 0, version: 0 })
    expect(captureServer).not.toHaveBeenCalled()
  })
})
