// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres, { type Sql, type TransactionSql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl, migrateThrough } from './_supabaseStandIn'
import { privilegeLines, ALLOWLIST_AFTER_0080 } from './_dataApiAllowlist'
import { as, become, rolledBack, sqlstate } from './_chapterWorld1518'
import { PUSH_TOKENS_PER_USER, isWellFormedPushToken } from '@/lib/pushTokenFormat'

// ─── #1827 S2: 0101 applied to a real Postgres ───────────────────────────────
//
// Against a stand-in migrated through 0100, then 0101 through drizzle's own
// migrator:
//   - 0101 deletes the rows that fail the format and keeps real ones (upper-
//     and lowercase 64-hex APNs, a sample-shaped FCM token).
//   - The CHECK refuses junk as `authenticated` with 23514: 'TEST', whitespace,
//     a trailing newline, odd-length hex, too short, too long, non-ASCII digits.
//     Postgres and lib/pushTokenFormat.ts agree on every sample.
//   - At most PUSH_TOKENS_PER_USER rows per user: cap + 5 inserts end at cap
//     with the newest kept; an upsert of an existing token at the cap succeeds
//     and evicts nothing; 2 connections × 15 parallel inserts end at <= cap;
//     another user's rows are never touched.
//   - updated_at moves on UPDATE (and on the upsert's DO UPDATE path).
//   - Neither trigger function is executable by anon / authenticated, and the
//     #1518 allowlist is exactly what it was (no new line).
//   - The down script removes everything 0101 added.
// Failure look without 0101: one account upserts thousands of junk "tokens"
// and the nightly push spends its run on them; nothing errors in the app.
//
// LOCAL THROWAWAY SERVER ONLY. Skips itself unless DATABASE_URL is localhost:
//
//   initdb -U postgres -A trust -D <dir> && pg_ctl -D <dir> -o '-p 55827' start
//   DATABASE_URL=postgres://postgres@127.0.0.1:55827/postgres \
//     npx vitest run __tests__/actions/pushTokenFormatCap1827.test.ts
//
// Integration folder (`__tests__/actions/**`): excluded from CI.
// ──────────────────────────────────────────────────────────────────────────────

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 })

const REPO = resolve(__dirname, '../..')
const MIGRATION = readFileSync(resolve(REPO, 'drizzle/0101_push_token_format_cap.sql'), 'utf-8')
const DOWN = readFileSync(resolve(REPO, 'scripts/rollback/0101_push_token_format_cap.down.sql'), 'utf-8')

const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)
let url = ''
let sql: Sql
let preLines: string[] = []

const CAP = PUSH_TOKENS_PER_USER
const hex = (bytes: number) => randomBytes(bytes).toString('hex')
const HEX_UP = hex(32).toUpperCase()
const HEX_LOW = hex(32)
// The shape of a real FCM registration token: instance id, colon, APA91b… body.
const FCM_SAMPLE = `${randomBytes(8).toString('base64url').slice(0, 11)}:APA91b${randomBytes(110).toString('base64url')}`

// Rows that exist before 0101 runs: which survive.
const PRE = {
  keepUpper: { platform: 'apns', token: HEX_UP },
  keepLower: { platform: 'apns', token: HEX_LOW },
  keepFcm: { platform: 'fcm', token: FCM_SAMPLE },
  dropTest: { platform: 'apns', token: 'TEST_1827_token' },
  dropOdd: { platform: 'apns', token: `${hex(32)}A` },
  dropSpace: { platform: 'apns', token: ` ${hex(32)}` },
  dropHuge: { platform: 'apns', token: hex(600) },
  dropFcmSlash: { platform: 'fcm', token: `${FCM_SAMPLE}/x` },
  dropHexAsFcmShort: { platform: 'fcm', token: 'abc' },
} as const

let preUser = ''
let preGroup = ''

async function person(db: Sql | TransactionSql): Promise<string> {
  const id = randomUUID()
  await db`INSERT INTO "Profiles" (id, display_name) VALUES (${id}, 'TEST_1827')`
  return id
}

async function soloLedger(db: Sql | TransactionSql, member: string): Promise<string> {
  const [g] = await db<{ id: string }[]>`
    INSERT INTO "OikosGroups" (name, member_a, member_b, current_epoch_started_at)
    VALUES ('TEST_1827', ${member}, NULL, now()) RETURNING id`
  return g.id
}

/** The client's upsert as PostgREST runs it (merge-duplicates). */
function upsertSql(user: string, group: string, platform: string, token: string): string {
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
  return `INSERT INTO "PushTokens" (user_id, group_id, platform, token)
    VALUES (${lit(user)}, ${lit(group)}, ${lit(platform)}, ${lit(token)})
    ON CONFLICT (user_id, platform, token) DO UPDATE SET user_id = EXCLUDED.user_id, group_id = EXCLUDED.group_id,
      platform = EXCLUDED.platform, token = EXCLUDED.token`
}

/** Insert one token as `user` in its own committed transaction (so now() differs per row). */
async function insertCommitted(db: Sql, user: string, group: string, token: string): Promise<void> {
  await db.begin(async (tx) => {
    await become(tx, user)
    await tx.unsafe(upsertSql(user, group, 'apns', token))
  })
}

async function tokensOf(db: Sql | TransactionSql, user: string): Promise<string[]> {
  const rows = await db<{ token: string }[]>`SELECT token FROM "PushTokens" WHERE user_id = ${user} ORDER BY token`
  return rows.map((r) => r.token)
}

beforeAll(async () => {
  if (!isLocalDb) return
  url = await createStandInDb(adminUrl, '0100')
  sql = postgres(url, { max: 1, onnotice: () => {} })
  preLines = await privilegeLines(sql)
  preUser = await person(sql)
  preGroup = await soloLedger(sql, preUser)
  for (const r of Object.values(PRE)) {
    await sql`INSERT INTO "PushTokens" (user_id, group_id, platform, token) VALUES (${preUser}, ${preGroup}, ${r.platform}, ${r.token})`
  }
  await migrateThrough(url, '0101')
})

afterAll(async () => {
  if (!isLocalDb) return
  await sql?.end()
  if (url) await dropStandInDb(adminUrl, url)
})

describe.skipIf(!isLocalDb)('#1827 — 0101 data repair and CHECK', () => {
  it('deleted exactly the rows that fail the format, kept real ones', async () => {
    const rows = await sql<{ platform: string; token: string }[]>`
      SELECT platform, token FROM "PushTokens" WHERE user_id = ${preUser}`
    const kept = rows.map((r) => `${r.platform}:${r.token}`).sort()
    expect(kept).toEqual([PRE.keepUpper, PRE.keepLower, PRE.keepFcm].map((r) => `${r.platform}:${r.token}`).sort())
  })

  it('pg_get_constraintdef shows the per-platform CHECK', async () => {
    const [c] = await sql<{ def: string; validated: boolean }[]>`
      SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_constraint
       WHERE conrelid = '"PushTokens"'::regclass AND conname = 'push_tokens_token_format'`
    expect(c.validated).toBe(true)
    expect(c.def).toContain("'^[0-9A-Fa-f]+$'")
    expect(c.def).toContain("'^[A-Za-z0-9_:-]+$'")
    expect(c.def).toMatch(/char_length\(token\) >= 64\)? AND \(?char_length\(token\) <= 512/)
    expect(c.def).toMatch(/char_length\(token\) % 2\) = 0/)
    expect(c.def).toMatch(/char_length\(token\) >= 20\)? AND \(?char_length\(token\) <= 512/)
  })

  const samples: [string, string, string, boolean][] = [
    ['64 uppercase hex', 'apns', HEX_UP, true],
    ['64 lowercase hex', 'apns', HEX_LOW, true],
    ['512 hex (max)', 'apns', hex(256), true],
    ['sample-shaped FCM', 'fcm', FCM_SAMPLE, true],
    ['FCM of 20 (min)', 'fcm', 'a'.repeat(20), true],
    ['TEST', 'apns', 'TEST', false],
    ['TEST_1605_T1-style fixture', 'apns', 'TEST_1605_T1', false],
    ['leading space', 'apns', ` ${hex(32)}`, false],
    ['trailing newline', 'apns', `${hex(32)}\n`, false],
    ['odd length hex', 'apns', `${hex(32)}A`, false],
    ['62 hex (too short)', 'apns', hex(31), false],
    ['514 hex (too long)', 'apns', hex(257), false],
    ['fullwidth digits', 'apns', '０'.repeat(64), false],
    ['Arabic-Indic digits', 'apns', '٠'.repeat(64), false],
    ['FCM with a slash', 'fcm', `${FCM_SAMPLE}/`, false],
    ['FCM with a space', 'fcm', `${FCM_SAMPLE} x`, false],
    ['FCM of 19', 'fcm', 'a'.repeat(19), false],
    ['FCM of 513', 'fcm', 'a'.repeat(513), false],
  ]

  it.each(samples)('%s → %s accepted=%s, and lib/pushTokenFormat agrees', async (_n, platform, token, ok) => {
    expect(isWellFormedPushToken(platform, token)).toBe(ok)
    await rolledBack(sql, async (tx) => {
      const u = await person(tx)
      const g = await soloLedger(tx, u)
      expect(await sqlstate(tx, u, upsertSql(u, g, platform, token))).toBe(ok ? null : '23514')
    })
  })
})

describe.skipIf(!isLocalDb)('#1827 — at most PUSH_TOKENS_PER_USER rows per user', () => {
  it(`cap + 5 inserts end at ${CAP} rows, the newest kept; another user's rows untouched`, async () => {
    const u = await person(sql)
    const g = await soloLedger(sql, u)
    const other = await person(sql)
    const og = await soloLedger(sql, other)
    const otherTokens = Array.from({ length: CAP }, () => hex(32))
    for (const t of otherTokens) await insertCommitted(sql, other, og, t)

    const mine = Array.from({ length: CAP + 5 }, () => hex(32))
    for (const t of mine) await insertCommitted(sql, u, g, t)

    expect(await tokensOf(sql, u)).toEqual(mine.slice(5).sort())
    expect(await tokensOf(sql, other)).toEqual([...otherTokens].sort())
  })

  it('upsert of an existing token at the cap succeeds, evicts nothing, and refreshes its updated_at', async () => {
    const u = await person(sql)
    const g = await soloLedger(sql, u)
    const mine = Array.from({ length: CAP }, () => hex(32))
    for (const t of mine) await insertCommitted(sql, u, g, t)
    const [before] = await sql<{ at: Date }[]>`SELECT updated_at AS at FROM "PushTokens" WHERE user_id = ${u} AND token = ${mine[0]}`

    await insertCommitted(sql, u, g, mine[0]) // DO UPDATE path
    expect(await tokensOf(sql, u)).toEqual([...mine].sort())
    const [after] = await sql<{ at: Date }[]>`SELECT updated_at AS at FROM "PushTokens" WHERE user_id = ${u} AND token = ${mine[0]}`
    expect(after.at.getTime()).toBeGreaterThan(before.at.getTime())

    // The next new device evicts the least recently registered one — mine[1],
    // not mine[0], which was just re-registered.
    const fresh = hex(32)
    await insertCommitted(sql, u, g, fresh)
    expect(await tokensOf(sql, u)).toEqual([mine[0], ...mine.slice(2), fresh].sort())
  })

  it(`2 connections × 15 parallel inserts end at <= ${CAP}`, async () => {
    const u = await person(sql)
    const g = await soloLedger(sql, u)
    const pool = postgres(url, { max: 2, onnotice: () => {} })
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, () => insertCommitted(pool, u, g, hex(32))),
      )
      expect(results.filter((r) => r.status === 'rejected')).toEqual([])
    } finally {
      await pool.end()
    }
    expect((await tokensOf(sql, u)).length).toBe(CAP)
  })

  it('updated_at moves on a plain UPDATE (leaveGroup / acceptInvite move rows this way)', async () => {
    await rolledBack(sql, async (tx) => {
      const u = await person(tx)
      const g = await soloLedger(tx, u)
      const g2 = await soloLedger(tx, u)
      await tx`INSERT INTO "PushTokens" (user_id, group_id, platform, token, created_at, updated_at)
        VALUES (${u}, ${g}, 'apns', ${HEX_UP}, now() - interval '1 day', now() - interval '1 day')`
      await tx`UPDATE "PushTokens" SET group_id = ${g2} WHERE user_id = ${u}`
      const [r] = await tx<{ fresh: boolean }[]>`
        SELECT updated_at > created_at AS fresh FROM "PushTokens" WHERE user_id = ${u}`
      expect(r.fresh).toBe(true)
    })
  })
})

describe.skipIf(!isLocalDb)('#1827 — privileges and the #1518 allowlist', () => {
  it('neither trigger function is executable by anon, authenticated or service_role', async () => {
    for (const fn of ['public.push_tokens_touch_updated_at()', 'public.push_tokens_enforce_cap()']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const [r] = await sql<{ ok: boolean }[]>`SELECT has_function_privilege(${role}, ${fn}, 'EXECUTE') AS ok`
        expect({ fn, role, ok: r.ok }).toEqual({ fn, role, ok: false })
      }
    }
  })

  it('the cap function is SECURITY DEFINER with an empty search_path, owned by postgres', async () => {
    const [r] = await sql<{ definer: boolean; config: string[]; owner: string }[]>`
      SELECT prosecdef AS definer, proconfig AS config, pg_get_userbyid(proowner) AS owner
        FROM pg_proc WHERE oid = 'public.push_tokens_enforce_cap()'::regprocedure`
    expect(r).toEqual({ definer: true, config: ['search_path=""'], owner: 'postgres' })
  })

  it('the anon / authenticated privileges are the 0080 allowlist, unchanged by 0101', async () => {
    expect(preLines).toEqual(ALLOWLIST_AFTER_0080)
    expect(await privilegeLines(sql)).toEqual(ALLOWLIST_AFTER_0080)
  })

  it('authenticated still cannot DELETE PushTokens (the cap trigger adds no grant)', async () => {
    await rolledBack(sql, async (tx) => {
      const u = await person(tx)
      await soloLedger(tx, u)
      expect(await sqlstate(tx, u, 'DELETE FROM "PushTokens"')).toBe('42501')
    })
  })

  it('0087 still refuses a ledger the user is not in', async () => {
    await rolledBack(sql, async (tx) => {
      const u = await person(tx)
      const stranger = await person(tx)
      const theirs = await soloLedger(tx, stranger)
      expect(await sqlstate(tx, u, upsertSql(u, theirs, 'apns', HEX_UP))).toBe('42501')
    })
  })
})

describe.skipIf(!isLocalDb)('#1827 — idempotency and rollback', () => {
  it('0101 runs a second time without error and changes nothing', async () => {
    await rolledBack(sql, async (tx) => {
      const [{ n: before }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM "PushTokens"`
      await tx.unsafe(MIGRATION)
      const [{ n: after }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM "PushTokens"`
      expect(after).toBe(before)
    })
  })

  it('the down script removes the constraint, both triggers and both functions', async () => {
    await rolledBack(sql, async (tx) => {
      await tx.unsafe(DOWN)
      const [c] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'push_tokens_token_format'`
      const [t] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = '"PushTokens"'::regclass AND NOT tgisinternal`
      const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('push_tokens_touch_updated_at', 'push_tokens_enforce_cap')`
      expect([c.n, t.n, f.n]).toEqual([0, 0, 0])
      const u = await person(tx)
      const g = await soloLedger(tx, u)
      await as(tx, u, () => tx.unsafe(upsertSql(u, g, 'apns', 'TEST_after_down')))
    })
  })
})
