// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'
import { person, requestDeletion } from './_deletionWorld1701'

// ─── #1536 S3 — POST /api/shortcut/pending against a real database ─────────
//
// LOCAL THROWAWAY SERVER ONLY (stand-in database migrated through 0098 on the
// local server DATABASE_URL points at; skips otherwise):
//
//   DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres \
//   DATABASE_URL_DIRECT=$DATABASE_URL \
//     npx vitest run __tests__/actions/shortcutPendingRoute1536.test.ts
//
// The real route handler runs through the app's own db client. What each
// failure would look like in production (none of them errors on its own):
//   - a revoked / regenerated key or a deleting account still plants cards;
//   - count-then-insert without the per-owner lock lets a burst of parallel
//     requests past the 30/hour or 50-open limit;
//   - the lock order drifting from actions/shortcutKey.ts: a Shortcut POST
//     racing "regenerate key" deadlocks (40P01) and one side gets a 500;
//   - a key revoked while a POST is in flight still inserts a card.
// ──────────────────────────────────────────────────────────────────────────────

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

// S2's actions resolve the viewer through the cookie session; the route must
// not. The route's own isolation from the session is proven in
// tests/shortcut-pending-route-1536.test.ts.
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
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}))
const captureServer = vi.fn()
vi.mock('@/lib/analytics/server', () => ({
  captureServer: (...a: unknown[]) => captureServer(...a),
  isUserFirstNonDeletedRecord: async () => false,
}))
const sentryCapture = vi.fn()
vi.mock('@sentry/nextjs', () => ({ captureException: (...a: unknown[]) => sentryCapture(...a) }))

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
const { POST } = await import('@/app/api/shortcut/pending/route')
const { generateShortcutKey, revokeShortcutKey } = await import('@/actions/shortcutKey')

const as = <T>(userId: string, fn: () => Promise<T>) => viewerStore.run(userId, fn)

let pg: Sql
const URL_ = 'https://futari.southern-light.dev/api/shortcut/pending'

interface Owner { id: string; key: string; keyId: string }

/** A live user with a solo ledger and a freshly generated key (through S2's real action). */
async function owner(opts: { ledger?: boolean } = {}): Promise<Owner> {
  const id = await person(pg, `sp ${randomUUID().slice(0, 6)}`)
  if (opts.ledger !== false) {
    await pg`INSERT INTO "OikosGroups" (name, member_a) VALUES ('t', ${id})`
  }
  const res = await as(id, () => generateShortcutKey())
  if (!res.ok) throw new Error('generate failed')
  const [{ id: keyId }] = await pg<{ id: string }[]>`
    SELECT id FROM "ShortcutKeys" WHERE user_id = ${id} AND revoked_at IS NULL`
  return { id, key: res.data.key, keyId }
}

function send(key: string | null, body: string | Uint8Array | ReadableStream<Uint8Array> = '{"amount":120}',
  headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { 'content-type': 'application/json', ...headers }
  if (key !== null) h.authorization = `Bearer ${key}`
  const init: RequestInit & { duplex?: 'half' } = { method: 'POST', headers: h, body: body as BodyInit }
  if (body instanceof ReadableStream) init.duplex = 'half'
  return POST(new Request(URL_, init))
}

const cardsOf = (userId: string) =>
  pg<{ amount: number; category: string | null; description: string | null; key_id: string | null; skipped_at: Date | null }[]>`
    SELECT amount, category, description, key_id, skipped_at FROM "ShortcutPendingExpenses" WHERE user_id = ${userId}`
const countOf = async (userId: string) => (await cardsOf(userId)).length

/** Insert `n` cards directly, `ageMinutes` old. */
async function seed(o: Owner, n: number, ageMinutes: number, skipped = false) {
  await pg`
    INSERT INTO "ShortcutPendingExpenses" (user_id, key_id, amount, created_at, skipped_at)
    SELECT ${o.id}, ${o.keyId}, 1, now() - make_interval(mins => ${ageMinutes}),
           CASE WHEN ${skipped} THEN now() ELSE NULL END
    FROM generate_series(1, ${n})`
}

async function expectStatus(res: Response, status: number, body?: unknown) {
  expect(res.status).toBe(status)
  expect(res.headers.get('cache-control')).toBe('no-store, max-age=0')
  if (body !== undefined) expect(await res.json()).toEqual(body)
}

const UNAUTH = { ok: false, error: 'unauthorized' }

describe.skipIf(!isLocalDb)('#1536 S3 — POST /api/shortcut/pending (stand-in through 0098)', () => {
  beforeAll(() => {
    pg = postgres(standInUrl, { max: 4, onnotice: () => {} })
  })

  beforeEach(() => {
    sentryCapture.mockClear()
    captureServer.mockClear()
  })

  afterAll(async () => {
    await pg?.end()
    const { db } = await import('@/lib/db/client')
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
    if (standInUrl) await dropStandInDb(adminUrl, standInUrl)
  })

  it('201 {ok:true}: one card with the parsed fields, last_used_at stamped, nothing logged', async () => {
    const o = await owner()
    const lines: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')) }))
    let res: Response
    try {
      res = await send(o.key, JSON.stringify({ amount: '1,200', category: 'dining', note: ' 午餐‮ ', extra: 'x' }),
        { 'content-type': 'Application/JSON; charset=UTF-8' })
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
    await expectStatus(res, 201, { ok: true })
    expect(await cardsOf(o.id)).toEqual([
      { amount: 1200, category: 'dining', description: '午餐', key_id: o.keyId, skipped_at: null },
    ])
    const [{ last_used_at }] = await pg<{ last_used_at: Date | null }[]>`
      SELECT last_used_at FROM "ShortcutKeys" WHERE id = ${o.keyId}`
    expect(last_used_at).toBeInstanceOf(Date)
    expect(lines.join('\n')).toBe('')
    expect(sentryCapture).not.toHaveBeenCalled()
    expect(captureServer).not.toHaveBeenCalled()
  })

  it('unknown category is dropped (null), no note → null description', async () => {
    const o = await owner()
    await expectStatus(await send(o.key, '{"amount":5,"category":"nope"}'), 201)
    expect(await cardsOf(o.id)).toMatchObject([{ amount: 5, category: null, description: null }])
  })

  describe('401: the same answer for every unusable key', () => {
    it('missing header, malformed, unknown', async () => {
      await expectStatus(await send(null), 401, UNAUTH)
      await expectStatus(await send('fts_sk_short'), 401, UNAUTH)
      await expectStatus(await send(`fts_sk_${'Z'.repeat(43)}`), 401, UNAUTH)
    })

    it('key in the query string or the body only', async () => {
      const o = await owner()
      const q = await POST(new Request(`${URL_}?key=${o.key}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"amount":1}',
      }))
      await expectStatus(q, 401, UNAUTH)
      await expectStatus(await send(null, JSON.stringify({ amount: 1, key: o.key })), 401, UNAUTH)
      expect(await countOf(o.id)).toBe(0)
    })

    it('revoked, and the old key after regenerate', async () => {
      const o = await owner()
      await as(o.id, () => generateShortcutKey())
      await expectStatus(await send(o.key), 401, UNAUTH)
      const fresh = await owner()
      await as(fresh.id, () => revokeShortcutKey())
      await expectStatus(await send(fresh.key), 401, UNAUTH)
      expect(await countOf(o.id) + await countOf(fresh.id)).toBe(0)
    })

    it('owner asked for deletion (14-day grace) → 401', async () => {
      const o = await owner()
      await requestDeletion(pg, o.id, 1)
      await expectStatus(await send(o.key), 401, UNAUTH)
      expect(await countOf(o.id)).toBe(0)
    })

    it('deleted account kept as a tombstone → 401 (key cascaded away with auth.users)', async () => {
      const o = await owner()
      await pg`DELETE FROM auth.users WHERE id = ${o.id}`
      const [{ n }] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM "Profiles" WHERE id = ${o.id}`
      expect(n).toBe(1) // the tombstone is still there
      await expectStatus(await send(o.key), 401, UNAUTH)
    })

    it('owner not live but key row present (profile_is_live false) → 401', async () => {
      // The FK cascade makes this unreachable in production; force it to prove
      // the check itself: drop the FK, delete auth.users, keep the key row.
      const o = await owner()
      const [{ conname }] = await pg<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = '"ShortcutKeys"'::regclass AND contype = 'f'`
      await pg.begin(async (t) => {
        await t.unsafe(`ALTER TABLE "ShortcutKeys" DROP CONSTRAINT "${conname}"`)
        await t`DELETE FROM auth.users WHERE id = ${o.id}`
        const [{ k }] = await t<{ k: number }[]>`SELECT count(*)::int AS k FROM "ShortcutKeys" WHERE id = ${o.keyId}`
        expect(k).toBe(1)
        // Run the request while the FK is gone (this transaction holds an
        // ACCESS EXCLUSIVE lock on ShortcutKeys, so commit first).
      })
      try {
        await expectStatus(await send(o.key), 401, UNAUTH)
      } finally {
        await pg`DELETE FROM "ShortcutKeys" WHERE user_id = ${o.id}`
        await pg.unsafe(`ALTER TABLE "ShortcutKeys" ADD CONSTRAINT "${conname}"
          FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE`)
      }
    })
  })

  describe('body', () => {
    it('415 for a non-JSON media type', async () => {
      const o = await owner()
      for (const ct of ['text/plain', 'application/jsonx', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
        await expectStatus(await send(o.key, '{"amount":1}', { 'content-type': ct }), 415,
          { ok: false, error: 'unsupported_media_type' })
      }
      expect(await countOf(o.id)).toBe(0)
    })

    it('413 by Content-Length, and by counting a chunked body with no length (3 KB)', async () => {
      const o = await owner()
      await expectStatus(await send(o.key, '{"amount":1}', { 'content-length': '2049' }), 413,
        { ok: false, error: 'payload_too_large' })

      const chunk = new TextEncoder().encode(' '.repeat(512))
      let pulled = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (pulled === 0) c.enqueue(new TextEncoder().encode('{"amount":1'))
          else if (pulled <= 6) c.enqueue(chunk)
          else { c.enqueue(new TextEncoder().encode('}')); c.close() }
          pulled++
        },
      })
      const req = new Request(URL_, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      expect(req.headers.get('content-length')).toBeNull()
      await expectStatus(await POST(req), 413, { ok: false, error: 'payload_too_large' })
      expect(await countOf(o.id)).toBe(0)
    })

    it('exactly 2048 bytes is accepted', async () => {
      const o = await owner()
      const base = '{"amount":1}'
      const body = base.slice(0, -1) + ' '.repeat(2048 - base.length) + '}'
      expect(new TextEncoder().encode(body).byteLength).toBe(2048)
      await expectStatus(await send(o.key, body), 201)
    })

    it.each([
      ['bad JSON', '{"amount":'],
      ['empty body', ''],
      ['invalid UTF-8', new Uint8Array([0x7b, 0x22, 0x61, 0xff, 0x22, 0x3a, 0x31, 0x7d])],
      ['array amount', '{"amount":["120"]}'],
      ['object amount', '{"amount":{"v":120}}'],
      ['object body', '{"x":1}'],
      ['array body', '[{"amount":1}]'],
      ['missing amount', '{"note":"x"}'],
      ['zero amount', '{"amount":0}'],
      ['wrong category type', '{"amount":1,"category":5}'],
      ['wrong note type', '{"amount":1,"note":true}'],
    ])('400 for %s, never echoing input', async (_l, body) => {
      const o = await owner()
      const res = await send(o.key, body)
      expect(res.status).toBe(400)
      expect(res.headers.get('cache-control')).toBe('no-store, max-age=0')
      expect(await res.text()).toBe('{"ok":false,"error":"invalid_request"}')
      expect(await countOf(o.id)).toBe(0)
    })
  })

  it('409 when the owner has no ledger', async () => {
    const o = await owner({ ledger: false })
    await expectStatus(await send(o.key), 409, { ok: false, error: 'no_ledger' })
    expect(await countOf(o.id)).toBe(0)
  })

  describe('429 limits', () => {
    it('31st card from one key in an hour (skipped ones count)', async () => {
      const o = await owner()
      await seed(o, 20, 5)
      await seed(o, 10, 30, true)
      await seed(o, 5, 61) // older than an hour: not counted
      await expectStatus(await send(o.key), 429, { ok: false, error: 'rate_limited' })
      expect(await countOf(o.id)).toBe(35)
    })

    it('30th card in an hour is still accepted', async () => {
      const o = await owner()
      await seed(o, 29, 5)
      await expectStatus(await send(o.key), 201)
    })

    it('51st open card (older than an hour, younger than 30 days); skipped and >30-day cards do not count', async () => {
      const o = await owner()
      await seed(o, 50, 120)
      await expectStatus(await send(o.key), 429, { ok: false, error: 'rate_limited' })
      const p = await owner()
      await seed(p, 49, 120)
      await seed(p, 10, 120, true)
      await seed(p, 10, 60 * 24 * 31)
      await expectStatus(await send(p.key), 201)
      await expectStatus(await send(p.key), 429)
    })

    it('20 parallel POSTs never exceed 30 per hour', async () => {
      const o = await owner()
      await seed(o, 20, 5)
      const res = await Promise.all(Array.from({ length: 20 }, () => send(o.key)))
      const codes = res.map((r) => r.status).sort()
      expect(codes.filter((c) => c === 201)).toHaveLength(10)
      expect(codes.filter((c) => c === 429)).toHaveLength(10)
      expect(await countOf(o.id)).toBe(30)
      expect(sentryCapture).not.toHaveBeenCalled()
    })

    it('20 parallel POSTs never exceed 50 open', async () => {
      const o = await owner()
      await seed(o, 40, 120)
      const res = await Promise.all(Array.from({ length: 20 }, () => send(o.key)))
      expect(res.filter((r) => r.status === 201)).toHaveLength(10)
      expect(res.filter((r) => r.status === 429)).toHaveLength(10)
      expect(await countOf(o.id)).toBe(50)
    })
  })

  describe('concurrency with generate / revoke (lock order)', () => {
    it('POSTs racing regenerate and revoke: no 40P01 / 500, and every card names a key that existed', async () => {
      for (let round = 0; round < 15; round++) {
        const o = await owner()
        const ops: Promise<unknown>[] = []
        const posts: Promise<Response>[] = []
        for (let i = 0; i < 4; i++) posts.push(send(o.key))
        ops.push(as(o.id, () => generateShortcutKey()))
        ops.push(as(o.id, () => revokeShortcutKey()))
        for (let i = 0; i < 2; i++) posts.push(send(o.key))
        const [results, actions] = await Promise.all([Promise.all(posts), Promise.all(ops)])
        for (const r of results) expect([201, 401]).toContain(r.status)
        for (const a of actions as { ok: boolean }[]) expect(a.ok).toBe(true)
        // Cards only ever come from the original key.
        const cards = await cardsOf(o.id)
        expect(cards.every((c) => c.key_id === o.keyId)).toBe(true)
        expect(cards).toHaveLength(results.filter((r) => r.status === 201).length)
      }
      expect(sentryCapture).not.toHaveBeenCalled()
    })

    it('a POST that passed the key check before a revoke committed inserts nothing', async () => {
      const o = await owner()
      const blocker = postgres(standInUrl, { max: 1, onnotice: () => {} })
      try {
        let release!: () => void
        const released = new Promise<void>((r) => { release = r })
        let locked!: () => void
        const isLocked = new Promise<void>((r) => { locked = r })
        // What revokeShortcutKey does, held open: Profiles row first, then the key.
        const tx = blocker.begin(async (t) => {
          await t`SELECT 1 FROM "Profiles" WHERE id = ${o.id} FOR NO KEY UPDATE`
          locked()
          await released
          await t`UPDATE "ShortcutKeys" SET revoked_at = now() WHERE user_id = ${o.id} AND revoked_at IS NULL`
        })
        await isLocked
        const inflight = send(o.key) // resolves the key (unlocked read: still valid), then waits on Profiles
        // Wait until the request is actually blocked on the row lock.
        for (let i = 0; i < 200; i++) {
          const [{ n }] = await pg<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`
          if (n > 0) break
          await new Promise((r) => setTimeout(r, 25))
        }
        release()
        await tx
        await expectStatus(await inflight, 401, UNAUTH)
        expect(await countOf(o.id)).toBe(0)
      } finally {
        await blocker.end()
      }
    })

    it('a POST that waited for the deletion request to commit gets 401', async () => {
      const o = await owner()
      const blocker = postgres(standInUrl, { max: 1, onnotice: () => {} })
      try {
        let release!: () => void
        const released = new Promise<void>((r) => { release = r })
        let locked!: () => void
        const isLocked = new Promise<void>((r) => { locked = r })
        const tx = blocker.begin(async (t) => {
          await t`SELECT 1 FROM "Profiles" WHERE id = ${o.id} FOR NO KEY UPDATE`
          locked()
          await released
          await t`UPDATE "Profiles" SET deletion_requested_at = now() WHERE id = ${o.id}`
        })
        await isLocked
        const inflight = send(o.key)
        for (let i = 0; i < 200; i++) {
          const [{ n }] = await pg<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`
          if (n > 0) break
          await new Promise((r) => setTimeout(r, 25))
        }
        release()
        await tx
        await expectStatus(await inflight, 401, UNAUTH)
        expect(await countOf(o.id)).toBe(0)
      } finally {
        await blocker.end()
      }
    })
  })
})
