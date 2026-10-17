// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'
import { person, requestDeletion } from './_deletionWorld1701'

// ─── #1536 S2 — generate / regenerate / revoke a personal shortcut key ─────
//
// LOCAL THROWAWAY SERVER ONLY (stand-in database migrated through 0098 on the
// local server DATABASE_URL points at; skips otherwise):
//
//   DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres \
//     npx vitest run __tests__/actions/shortcutKeyActions1536.test.ts
//
// The real actions run against the stand-in through the app's own db client.
// What each failure would look like in production (none of them errors):
//   - plaintext or a different hash stored: a DB read (backup, support query)
//     yields working keys; or every Shortcut gets 401 because the hash the
//     endpoint computes never matches;
//   - regenerate without revoke: the "old" key keeps working after the user
//     was told it stopped;
//   - no per-user lock: a double tap surfaces as an unexpected 23505 (an
//     error page) instead of a key;
//   - a scoping slip: one user's generate revokes the partner's key.
// ──────────────────────────────────────────────────────────────────────────────

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 })

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

const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)
let standInUrl = ''
if (isLocalDb) {
  standInUrl = await createStandInDb(adminUrl, '0098')
  process.env.DATABASE_URL = standInUrl
}

const postgres = (await import('postgres')).default
const { generateShortcutKey, revokeShortcutKey } = await import('@/actions/shortcutKey')
const { hashShortcutKey, isWellFormedShortcutKey } = await import('@/lib/shortcutKey')
const { getActiveShortcutKeySummary } = await import('@/lib/db/queries/shortcutKey')

const as = <T>(userId: string, fn: () => Promise<T>) => viewerStore.run(userId, fn)

let pg: Sql

interface KeyRow {
  id: string
  key_hash: string
  key_hint: string
  revoked_at: Date | null
  created_at: Date
}
const keysOf = (userId: string) =>
  pg<KeyRow[]>`SELECT id, key_hash, key_hint, revoked_at, created_at FROM "ShortcutKeys" WHERE user_id = ${userId} ORDER BY created_at, id`
/** What the S3 endpoint will look up: an unrevoked row with this hash. */
const liveByKey = async (key: string) =>
  (await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM "ShortcutKeys" WHERE key_hash = ${hashShortcutKey(key)} AND revoked_at IS NULL`)[0].n

const newUser = () => person(pg, `sk ${randomUUID().slice(0, 6)}`)

/** Every console line written while `fn` runs. */
async function consoleDuring<T>(fn: () => Promise<T>): Promise<{ out: T; lines: string }> {
  const lines: string[] = []
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')) }),
  )
  try {
    return { out: await fn(), lines: lines.join('\n') }
  } finally {
    spies.forEach((s) => s.mockRestore())
  }
}

describe.skipIf(!isLocalDb)('#1536 S2 — shortcut key actions (stand-in through 0098)', () => {
  beforeAll(() => {
    pg = postgres(standInUrl, { max: 2, onnotice: () => {} })
  })

  afterEach(() => {
    captureServer.mockClear()
  })

  afterAll(async () => {
    await pg?.end()
    const { db } = await import('@/lib/db/client')
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
    if (standInUrl) await dropStandInDb(adminUrl, standInUrl)
  })

  it('generate stores only a SHA-256 hex hash and the last 4 characters, and returns the key once', async () => {
    const u = await newUser()
    const { out: res, lines } = await consoleDuring(() => as(u, () => generateShortcutKey()))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const { key, hint, createdAt } = res.data
    expect(isWellFormedShortcutKey(key)).toBe(true)
    expect(key.startsWith('fts_sk_')).toBe(true)
    expect(hint).toBe(key.slice(-4))
    expect(Number.isNaN(Date.parse(createdAt))).toBe(false)

    const rows = await keysOf(u)
    expect(rows).toHaveLength(1)
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0].key_hash).toBe(hashShortcutKey(key))
    // Same digest Postgres computes over the full key string.
    const [{ pgHash }] = await pg<{ pgHash: string }[]>`SELECT encode(sha256(convert_to(${key}, 'UTF8')), 'hex') AS "pgHash"`
    expect(rows[0].key_hash).toBe(pgHash)
    expect(rows[0].key_hint).toBe(hint)
    expect(rows[0].revoked_at).toBeNull()

    // The plaintext is nowhere in the row (any column, any encoding we'd notice).
    const [raw] = await pg<{ t: string }[]>`SELECT row_to_json(k)::text AS t FROM "ShortcutKeys" k WHERE user_id = ${u}`
    expect(raw.t).not.toContain(key)
    expect(raw.t).not.toContain(key.slice(7))

    // Nothing about the key left the process.
    expect(captureServer).not.toHaveBeenCalled()
    expect(lines).not.toContain('fts_sk_')
    expect(lines).not.toContain(key.slice(7, 20))

    // The settings page's read: hint and times only.
    const summary = await getActiveShortcutKeySummary(u)
    expect(Object.keys(summary ?? {}).sort()).toEqual(['createdAt', 'hint', 'lastUsedAt'])
    expect(summary?.hint).toBe(hint)
  })

  it('regenerate revokes the old key: old hash revoked, exactly one active, old key no longer looks up', async () => {
    const u = await newUser()
    const first = await as(u, () => generateShortcutKey())
    const second = await as(u, () => generateShortcutKey())
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.data.key).not.toBe(first.data.key)

    const rows = await keysOf(u)
    expect(rows).toHaveLength(2)
    const old = rows.find((r) => r.key_hash === hashShortcutKey(first.data.key))!
    const cur = rows.find((r) => r.key_hash === hashShortcutKey(second.data.key))!
    expect(old.revoked_at).not.toBeNull()
    expect(cur.revoked_at).toBeNull()
    expect(rows.filter((r) => r.revoked_at === null)).toHaveLength(1)
    expect(await liveByKey(first.data.key)).toBe(0)
    expect(await liveByKey(second.data.key)).toBe(1)
  })

  it('revoke turns the active key off; a second revoke is a no-op', async () => {
    const u = await newUser()
    const gen = await as(u, () => generateShortcutKey())
    if (!gen.ok) throw new Error('generate failed')

    const r1 = await as(u, () => revokeShortcutKey())
    expect(r1).toEqual({ ok: true, data: { revoked: true } })
    expect(await liveByKey(gen.data.key)).toBe(0)
    expect(await getActiveShortcutKeySummary(u)).toBeNull()

    const r2 = await as(u, () => revokeShortcutKey())
    expect(r2).toEqual({ ok: true, data: { revoked: false } })
    expect(captureServer).not.toHaveBeenCalled()
  })

  it('five concurrent generates: all succeed, exactly one active, and it is one of the returned keys', async () => {
    const u = await newUser()
    const results = await Promise.all(Array.from({ length: 5 }, () => as(u, () => generateShortcutKey())))
    // No unhandled 23505: every call resolved to ok (a thrown error would reject Promise.all).
    expect(results.every((r) => r.ok)).toBe(true)
    const keys = results.flatMap((r) => (r.ok ? [r.data.key] : []))
    expect(new Set(keys).size).toBe(5)

    const rows = await keysOf(u)
    expect(rows).toHaveLength(5)
    const active = rows.filter((r) => r.revoked_at === null)
    expect(active).toHaveLength(1)
    expect(keys.map(hashShortcutKey)).toContain(active[0].key_hash)
    expect(keys.filter((k) => liveByKeySync(k, active[0].key_hash))).toHaveLength(1)
  })

  it('concurrent generate and revoke leave a consistent state (at most one active)', async () => {
    const u = await newUser()
    await as(u, () => generateShortcutKey())
    const results = await Promise.all([
      as(u, () => generateShortcutKey()),
      as(u, () => revokeShortcutKey()),
      as(u, () => generateShortcutKey()),
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    const active = (await keysOf(u)).filter((r) => r.revoked_at === null)
    expect(active.length).toBeLessThanOrEqual(1)
  })

  it("another user's key is untouched by my generate and revoke", async () => {
    const me = await newUser()
    const partner = await newUser()
    const theirs = await as(partner, () => generateShortcutKey())
    if (!theirs.ok) throw new Error('generate failed')

    await as(me, () => generateShortcutKey())
    await as(me, () => generateShortcutKey())
    await as(me, () => revokeShortcutKey())

    expect(await liveByKey(theirs.data.key)).toBe(1)
    const partnerRows = await keysOf(partner)
    expect(partnerRows).toHaveLength(1)
    expect(partnerRows[0].revoked_at).toBeNull()
  })

  it('refuses a signed-out caller and a deleted account', async () => {
    // Signed out: requireViewer throws Unauthorized (unexpected error, not a code).
    await expect(viewerStore.run('', () => generateShortcutKey())).rejects.toThrow('Unauthorized')

    // Account deleted (auth.users gone, Profiles kept as a tombstone): lockProfileRow says no.
    const gone = await newUser()
    await requestDeletion(pg, gone)
    await pg`DELETE FROM auth.users WHERE id = ${gone}`
    expect(await as(gone, () => generateShortcutKey())).toEqual({ ok: false, code: 'profile_not_found' })
    expect(await keysOf(gone)).toHaveLength(0)
  })
})

function liveByKeySync(key: string, activeHash: string): boolean {
  return hashShortcutKey(key) === activeHash
}
