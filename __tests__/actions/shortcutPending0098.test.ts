import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'
import { TOMB, person, requestDeletion, world } from './_deletionWorld1701'
import { generateShortcutKey, hashShortcutKey, shortcutKeyHint } from '@/lib/shortcutKey'

// ─── 0098: shortcut keys and pending cards (#1536 S1) ───────────────────────
//
// LOCAL THROWAWAY SERVER ONLY (creates a stand-in database migrated through
// 0098 on the local server DATABASE_URL points at; skips otherwise).
//
//   DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres \
//     npx vitest run __tests__/actions/shortcutPending0098.test.ts
//
// Run stand-in suites one file at a time (see deletionKeepsChapter1701.test.ts).
//
// What each failure would look like in production (none of them errors):
//   - grants: GET /rest/v1/ShortcutKeys works from a signed-in browser and RLS
//     alone decides (key hashes and other people's cards one policy away);
//   - FK to "Profiles" instead of auth.users: a deleted user whose profile is
//     kept as a tombstone keeps their key hashes and cards forever;
//   - one-active-key index missing: two live keys per user, revoking "the"
//     key leaves the other one working;
//   - cron missing / wrong body: old cards and revoked key hashes pile up.
// ──────────────────────────────────────────────────────────────────────────────

const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)
const postgres = (await import('postgres')).default

const MIG = readFileSync(resolve(__dirname, '../../drizzle/0098_shortcut_pending.sql'), 'utf-8')
const MIG_0097 = readFileSync(resolve(__dirname, '../../drizzle/0097_cleanup_cron_resolved_cards.sql'), 'utf-8')
const CRON_BODY = /cron\.schedule\('cleanup-shortcut-pending', '20 19 \* \* \*', \$\$([\s\S]*?)\$\$\);/.exec(MIG)![1]
const SOFT_BODY_0097 = /cron\.schedule\('cleanup-soft-deleted', '0 3 \* \* 0', \$\$([\s\S]*?)\$\$\);/.exec(MIG_0097)![1]

const TABLES = ['ShortcutKeys', 'ShortcutPendingExpenses'] as const

let url = ''
let pg: Sql

/** A live user (auth.users + Profiles via handle_new_user). */
const user = (name: string) => person(pg, `${name} ${randomUUID().slice(0, 6)}`)

async function addKey(userId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const key = generateShortcutKey()
  const row = { user_id: userId, key_hash: hashShortcutKey(key), key_hint: shortcutKeyHint(key), ...extra }
  const [r] = await pg<{ id: string }[]>`INSERT INTO "ShortcutKeys" ${pg(row as unknown as Record<string, never>)} RETURNING id`
  return r.id
}

async function addCard(userId: string, keyId: string | null, extra: Record<string, unknown> = {}): Promise<string> {
  const row = { user_id: userId, key_id: keyId, amount: 120, category: 'dining', description: 'coffee', ...extra }
  const [r] = await pg<{ id: string }[]>`INSERT INTO "ShortcutPendingExpenses" ${pg(row as unknown as Record<string, never>)} RETURNING id`
  return r.id
}

const countFor = async (table: string, userId: string) =>
  (await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM ${pg(table)} WHERE user_id = ${userId}`)[0].n

const exists = async (table: string, id: string) =>
  (await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM ${pg(table)} WHERE id = ${id}`)[0].n === 1

/** Runs `body` as `role` in a transaction that always rolls back; returns the SQLSTATE it failed with, or 'ok'. */
async function asRole(role: string, body: (tx: Sql) => Promise<unknown>): Promise<string> {
  const ROLLBACK = new Error('rollback')
  try {
    await pg.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`)
      await body(tx as unknown as Sql)
      throw ROLLBACK
    })
  } catch (e) {
    if (e === ROLLBACK) return 'ok'
    return (e as { code?: string }).code ?? String(e)
  }
  return 'ok'
}

describe.skipIf(!isLocalDb)('0098 — shortcut keys and pending cards (#1536 S1)', () => {
  beforeAll(async () => {
    url = await createStandInDb(adminUrl, '0098')
    pg = postgres(url, { max: 1, onnotice: () => {} })
  }, 180_000)

  afterAll(async () => {
    await pg?.end()
    if (url) await dropStandInDb(adminUrl, url)
  })

  describe('catalog', () => {
    it('both tables exist with the expected columns and nullability', async () => {
      const cols = await pg<{ t: string; c: string; type: string; nullable: string }[]>`
        SELECT table_name AS t, column_name AS c, data_type AS type, is_nullable AS nullable
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name IN ${pg(TABLES as unknown as string[])}
         ORDER BY table_name, ordinal_position`
      expect(cols.map((r) => `${r.t}.${r.c}:${r.type}:${r.nullable}`)).toEqual([
        'ShortcutKeys.id:uuid:NO',
        'ShortcutKeys.user_id:uuid:NO',
        'ShortcutKeys.key_hash:text:NO',
        'ShortcutKeys.key_hint:text:NO',
        'ShortcutKeys.created_at:timestamp with time zone:NO',
        'ShortcutKeys.last_used_at:timestamp with time zone:YES',
        'ShortcutKeys.revoked_at:timestamp with time zone:YES',
        'ShortcutPendingExpenses.id:uuid:NO',
        'ShortcutPendingExpenses.user_id:uuid:NO',
        'ShortcutPendingExpenses.key_id:uuid:YES',
        'ShortcutPendingExpenses.amount:integer:NO',
        'ShortcutPendingExpenses.category:text:YES',
        'ShortcutPendingExpenses.description:text:YES',
        'ShortcutPendingExpenses.created_at:timestamp with time zone:NO',
        'ShortcutPendingExpenses.skipped_at:timestamp with time zone:YES',
      ])
    })

    it('has the unique hash, the one-active-key index and both pending indexes', async () => {
      const idx = await pg<{ name: string; def: string }[]>`
        SELECT indexname AS name, indexdef AS def FROM pg_indexes
         WHERE schemaname = 'public' AND tablename IN ${pg(TABLES as unknown as string[])}
         ORDER BY indexname`
      const byName = Object.fromEntries(idx.map((r) => [r.name, r.def.replace(/ ON public\./, ' ON ')]))
      expect(Object.keys(byName).sort()).toEqual([
        'ShortcutKeys_key_hash_unique',
        'ShortcutKeys_one_active_per_user',
        'ShortcutKeys_pkey',
        'ShortcutPendingExpenses_key_created_idx',
        'ShortcutPendingExpenses_pkey',
        'ShortcutPendingExpenses_user_open_idx',
      ])
      expect(byName.ShortcutKeys_key_hash_unique).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(key_hash\)$/)
      expect(byName.ShortcutKeys_one_active_per_user)
        .toMatch(/^CREATE UNIQUE INDEX .* USING btree \(user_id\) WHERE \(revoked_at IS NULL\)$/)
      expect(byName.ShortcutPendingExpenses_key_created_idx).toMatch(/USING btree \(key_id, created_at\)$/)
      expect(byName.ShortcutPendingExpenses_user_open_idx)
        .toMatch(/USING btree \(user_id\) WHERE \(skipped_at IS NULL\)$/)
    })

    it('user_id → auth.users ON DELETE CASCADE (not Profiles); key_id → ShortcutKeys ON DELETE SET NULL', async () => {
      const fks = await pg<{ fk: string }[]>`
        SELECT c.conrelid::regclass::text || '.' || a.attname || ' -> ' || c.confrelid::regclass::text
               || ' ' || c.confdeltype::text AS fk
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
         WHERE c.contype = 'f' AND c.conrelid IN ('public."ShortcutKeys"'::regclass, 'public."ShortcutPendingExpenses"'::regclass)
         ORDER BY 1`
      expect(fks.map((r) => r.fk)).toEqual([
        '"ShortcutKeys".user_id -> auth.users c',
        '"ShortcutPendingExpenses".key_id -> "ShortcutKeys" n',
        '"ShortcutPendingExpenses".user_id -> auth.users c',
      ])
    })

    it('RLS is enabled with no policies, and neither table is in supabase_realtime', async () => {
      const rls = await pg<{ t: string; on: boolean }[]>`
        SELECT relname AS t, relrowsecurity AS on FROM pg_class
         WHERE relnamespace = 'public'::regnamespace AND relname IN ${pg(TABLES as unknown as string[])} ORDER BY 1`
      expect(rls).toEqual([{ t: 'ShortcutKeys', on: true }, { t: 'ShortcutPendingExpenses', on: true }])
      const [{ n: policies }] = await pg<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename IN ${pg(TABLES as unknown as string[])}`
      expect(policies).toBe(0)
      const [{ n: pub }] = await pg<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime' AND tablename IN ${pg(TABLES as unknown as string[])}`
      expect(pub).toBe(0)
    })

    it('schedules cleanup-shortcut-pending with exactly the file\'s body, and leaves cleanup-soft-deleted as 0097 set it', async () => {
      const jobs = await pg<{ jobname: string; schedule: string; command: string }[]>`
        SELECT jobname, schedule, command FROM cron.job
         WHERE jobname IN ('cleanup-shortcut-pending', 'cleanup-soft-deleted') ORDER BY jobname`
      expect(jobs).toEqual([
        { jobname: 'cleanup-shortcut-pending', schedule: '20 19 * * *', command: CRON_BODY },
        { jobname: 'cleanup-soft-deleted', schedule: '0 3 * * 0', command: SOFT_BODY_0097 },
      ])
      expect(CRON_BODY).toMatch(/DELETE FROM "ShortcutPendingExpenses" WHERE created_at < NOW\(\) - INTERVAL '30 days';/)
      expect(CRON_BODY).toMatch(/DELETE FROM "ShortcutKeys"\s+WHERE revoked_at < NOW\(\) - INTERVAL '30 days';/)
    })
  })

  describe('privileges', () => {
    it('positive control: a public table created without a REVOKE IS readable by authenticated (default ACL modelled)', async () => {
      await pg`CREATE TABLE public."_ctl1536" (id int)`
      try {
        const [r] = await pg<{ a: boolean; b: boolean }[]>`
          SELECT has_table_privilege('anon', 'public."_ctl1536"', 'SELECT') AS a,
                 has_table_privilege('authenticated', 'public."_ctl1536"', 'SELECT') AS b`
        expect(r).toEqual({ a: true, b: true })
      } finally {
        await pg`DROP TABLE public."_ctl1536"`
      }
    })

    it('anon and authenticated hold no privilege on either table', async () => {
      const rows = await pg<{ line: string }[]>`
        SELECT t || '|' || r || '|' || p AS line
          FROM unnest(${TABLES as unknown as string[]}::text[]) t,
               unnest(ARRAY['anon', 'authenticated']) r,
               unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
         WHERE has_table_privilege(r, ('public.' || quote_ident(t))::regclass, p)`
      expect(rows.map((r) => r.line)).toEqual([])
    })

    it('anon and authenticated cannot select or insert (42501), even with a JWT for the owner', async () => {
      const owner = await user('priv')
      const keyId = await addKey(owner)
      await addCard(owner, keyId)
      for (const role of ['anon', 'authenticated']) {
        for (const t of TABLES) {
          expect(await asRole(role, async (tx) => {
            await tx.unsafe(`SELECT set_config('request.jwt.claims', '{"sub":"${owner}","role":"${role}"}', true)`)
            await tx.unsafe(`SELECT * FROM "${t}"`)
          }), `${role} SELECT ${t}`).toBe('42501')
        }
        expect(await asRole(role, (tx) => tx`
          INSERT INTO "ShortcutPendingExpenses" (user_id, amount) VALUES (${owner}, 1)`), `${role} INSERT pending`).toBe('42501')
        expect(await asRole(role, (tx) => tx`
          INSERT INTO "ShortcutKeys" (user_id, key_hash, key_hint)
          VALUES (${owner}, ${hashShortcutKey(generateShortcutKey())}, 'abcd')`), `${role} INSERT key`).toBe('42501')
      }
    })

    it('the runtime role futari_app (BYPASSRLS) can read and write both tables', async () => {
      const owner = await user('app')
      expect(await asRole('futari_app', async (tx) => {
        const [k] = await tx<{ id: string }[]>`
          INSERT INTO "ShortcutKeys" (user_id, key_hash, key_hint)
          VALUES (${owner}, ${hashShortcutKey(generateShortcutKey())}, 'abcd') RETURNING id`
        await tx`INSERT INTO "ShortcutPendingExpenses" (user_id, key_id, amount) VALUES (${owner}, ${k.id}, 5)`
        const rows = await tx`SELECT 1 FROM "ShortcutPendingExpenses" WHERE user_id = ${owner}`
        if (rows.length !== 1) throw new Error(`futari_app read ${rows.length} rows`)
        await tx`UPDATE "ShortcutKeys" SET revoked_at = now() WHERE id = ${k.id}`
        await tx`DELETE FROM "ShortcutPendingExpenses" WHERE user_id = ${owner}`
      })).toBe('ok')
    })
  })

  describe('constraints', () => {
    it('one unrevoked key per user: a second active key fails 23505; after revoking, a new one is fine', async () => {
      const u = await user('one')
      const other = await user('other')
      const k1 = await addKey(u)
      await expect(addKey(u)).rejects.toMatchObject({ code: '23505', constraint_name: 'ShortcutKeys_one_active_per_user' })
      await addKey(other) // another user is unaffected
      await pg`UPDATE "ShortcutKeys" SET revoked_at = now() WHERE id = ${k1}`
      await addKey(u)
      await addKey(u, { revoked_at: new Date() }) // any number of revoked keys
      const [{ active, all }] = await pg<{ active: number; all: number }[]>`
        SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active, count(*)::int AS all
          FROM "ShortcutKeys" WHERE user_id = ${u}`
      expect({ active, all }).toEqual({ active: 1, all: 3 })
    })

    it('the same key hash cannot be stored twice', async () => {
      const a = await user('dupA')
      const b = await user('dupB')
      const h = hashShortcutKey(generateShortcutKey())
      await pg`INSERT INTO "ShortcutKeys" (user_id, key_hash, key_hint) VALUES (${a}, ${h}, 'abcd')`
      await expect(pg`INSERT INTO "ShortcutKeys" (user_id, key_hash, key_hint) VALUES (${b}, ${h}, 'abcd')`)
        .rejects.toMatchObject({ code: '23505', constraint_name: 'ShortcutKeys_key_hash_unique' })
    })

    it('key_hash accepts only a SHA-256 hex digest: storing the plaintext key fails 23514', async () => {
      const u = await user('plain')
      const key = generateShortcutKey()
      await expect(pg`INSERT INTO "ShortcutKeys" (user_id, key_hash, key_hint) VALUES (${u}, ${key}, 'abcd')`)
        .rejects.toMatchObject({ code: '23514', constraint_name: 'ShortcutKeys_key_hash_is_sha256_hex' })
      await expect(pg`INSERT INTO "ShortcutKeys" (user_id, key_hash, key_hint) VALUES (${u}, ${hashShortcutKey(key).toUpperCase()}, 'abcd')`)
        .rejects.toMatchObject({ code: '23514' })
    })

    it('amount must be > 0; user_id must be a real auth user', async () => {
      const u = await user('amt')
      await expect(addCard(u, null, { amount: 0 })).rejects.toMatchObject({ code: '23514', constraint_name: 'ShortcutPendingExpenses_amount_positive' })
      await expect(addCard(u, null, { amount: -5 })).rejects.toMatchObject({ code: '23514' })
      // A Profiles row without an auth.users row (a tombstone) cannot own a card or key.
      const ghost = await person(pg, 'ghost', false)
      await expect(addCard(ghost, null)).rejects.toMatchObject({ code: '23503' })
      await expect(addKey(ghost)).rejects.toMatchObject({ code: '23503' })
    })

    it('deleting a key keeps its cards with key_id NULL', async () => {
      const u = await user('setnull')
      const k = await addKey(u)
      const c = await addCard(u, k)
      await pg`DELETE FROM "ShortcutKeys" WHERE id = ${k}`
      const [r] = await pg<{ key_id: string | null }[]>`SELECT key_id FROM "ShortcutPendingExpenses" WHERE id = ${c}`
      expect(r).toEqual({ key_id: null })
    })
  })

  describe('account deletion (0096 process_account_deletions)', () => {
    it('a deleted user whose profile is kept as a tombstone leaves 0 rows in both tables; the partner\'s rows stay', async () => {
      const w = await world(pg, `T1536_${randomUUID().slice(0, 8)}`)
      const kD = await addKey(w.D)
      await addKey(w.D, { revoked_at: new Date() })
      await addCard(w.D, kD)
      await addCard(w.D, kD, { skipped_at: new Date() })
      await addCard(w.D, null, { category: null, description: null })
      const kX = await addKey(w.X)
      const cX = await addCard(w.X, kX)
      expect([await countFor('ShortcutKeys', w.D), await countFor('ShortcutPendingExpenses', w.D)]).toEqual([2, 3])

      await requestDeletion(pg, w.D)
      const [{ n }] = await pg<{ n: number }[]>`SELECT public.process_account_deletions() AS n`
      expect(n).toBe(1)

      const [{ authLeft }] = await pg<{ authLeft: number }[]>`SELECT count(*)::int AS "authLeft" FROM auth.users WHERE id = ${w.D}`
      expect(authLeft).toBe(0)
      // The case F1 is about: the Profiles row survives (partner's chapter references it).
      const [p] = await pg<{ display_name: string }[]>`SELECT display_name FROM "Profiles" WHERE id = ${w.D}`
      expect(p?.display_name).toBe(TOMB)

      expect([await countFor('ShortcutKeys', w.D), await countFor('ShortcutPendingExpenses', w.D)]).toEqual([0, 0])
      expect(await exists('ShortcutKeys', kX)).toBe(true)
      expect(await exists('ShortcutPendingExpenses', cX)).toBe(true)
    })
  })

  describe('cleanup-shortcut-pending (the scheduled command, run as written in cron.job)', () => {
    it('removes cards older than 30 days (skipped or not) and keys revoked over 30 days ago; keeps the rest', async () => {
      const u = await user('cron')
      const ago = (days: number) => new Date(Date.now() - days * 86_400_000)
      const kOldRevoked = await addKey(u, { revoked_at: ago(31), created_at: ago(90) })
      const kYoungRevoked = await addKey(u, { revoked_at: ago(29), created_at: ago(60) })
      const kActiveOld = await addKey(u, { created_at: ago(400) })
      const cOld = await addCard(u, kOldRevoked, { created_at: ago(31) })
      const cOldSkipped = await addCard(u, kActiveOld, { created_at: ago(31), skipped_at: ago(30) })
      const cYoung = await addCard(u, kOldRevoked, { created_at: ago(29) })
      const cYoungSkipped = await addCard(u, kActiveOld, { created_at: ago(1), skipped_at: ago(0) })

      const [{ command }] = await pg<{ command: string }[]>`SELECT command FROM cron.job WHERE jobname = 'cleanup-shortcut-pending'`
      await pg.unsafe(command)

      expect({
        kOldRevoked: await exists('ShortcutKeys', kOldRevoked),
        kYoungRevoked: await exists('ShortcutKeys', kYoungRevoked),
        kActiveOld: await exists('ShortcutKeys', kActiveOld),
        cOld: await exists('ShortcutPendingExpenses', cOld),
        cOldSkipped: await exists('ShortcutPendingExpenses', cOldSkipped),
        cYoung: await exists('ShortcutPendingExpenses', cYoung),
        cYoungSkipped: await exists('ShortcutPendingExpenses', cYoungSkipped),
      }).toEqual({
        kOldRevoked: false, kYoungRevoked: true, kActiveOld: true,
        cOld: false, cOldSkipped: false, cYoung: true, cYoungSkipped: true,
      })
      // The young card of the purged key survives, unlinked.
      const [r] = await pg<{ key_id: string | null }[]>`SELECT key_id FROM "ShortcutPendingExpenses" WHERE id = ${cYoung}`
      expect(r.key_id).toBeNull()
    })
  })

  describe('idempotency', () => {
    it('re-running the migration body changes nothing and does not fail', async () => {
      const before = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM cron.job WHERE jobname = 'cleanup-shortcut-pending'`
      for (const stmt of MIG.split('--> statement-breakpoint')) await pg.unsafe(stmt)
      const after = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM cron.job WHERE jobname = 'cleanup-shortcut-pending'`
      expect([before[0].n, after[0].n]).toEqual([1, 1])
      const rows = await pg<{ line: string }[]>`
        SELECT t || '|' || r AS line FROM unnest(ARRAY['ShortcutKeys', 'ShortcutPendingExpenses']) t,
               unnest(ARRAY['anon', 'authenticated']) r
         WHERE has_table_privilege(r, ('public.' || quote_ident(t))::regclass, 'SELECT')`
      expect(rows).toEqual([])
    })
  })
})
