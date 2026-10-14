import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Sql, TransactionSql } from 'postgres'
import { loadEnvLocal } from '../outing/_setup'

// ─── 0095: one partner quiz per chapter (#1683) ────────────────────────────
//
// LOCAL THROWAWAY DATABASE ONLY. Every case runs inside a transaction that is
// rolled back, but 0095 takes an ACCESS EXCLUSIVE lock on the real
// "PartnerQuizSessions" table while it runs, so run this file on its own. It
// skips itself unless DATABASE_URL points at localhost — never run it against
// dev or prod.
//
// Database: postgres:17 plus the Supabase stand-ins (STANDIN_SQL in
// ./_supabaseStandIn.ts — it includes auth.identities, which 0081 needs — and
// db/triggers/handle_new_user.sql), then `drizzle-kit migrate`. Either state
// works:
//   - migrated through 0094 (the real pre-0095 table), or
//   - migrated through 0095: each case first puts the 0094 shape back inside
//     its transaction (`toPre0095`: drop epoch_id, re-add 0034's
//     UNIQUE (group_id)).
// The table must hold no other sessions (a fresh database): 0095 RAISEs on
// any row it cannot place, and other rows would make that the result here.
//
//   DATABASE_URL=postgres://postgres:<pw>@localhost:<port>/<db> \
//     npx vitest run __tests__/actions/partnerQuizEpoch0095.test.ts
//
// What it proves:
//   1. Backfill: a session older than the group's first chapter → the first
//      chapter; A+B → solo → A+C with the session created in A+B → A+B's
//      chapter (not today's A+C); a session created in a solo chapter → that
//      chapter; a session at exactly a boundary → the chapter starting there.
//      After it: epoch_id NOT NULL (enforced), UNIQUE (epoch_id) (enforced),
//      no UNIQUE (group_id) (a ledger may now hold one session per chapter),
//      no answer row lost.
//   2. The migration RAISEs, changing nothing, when (pre-0095 shape) the
//      UNIQUE (group_id) is missing, when a session matches no chapter, and
//      when a session matches more than one.
//   3. A second run is a no-op (catalog and epoch_id values unchanged).
//   4. The rollback script restores the 0094 shape while each ledger holds
//      ≤1 session, and RAISEs (changing nothing) once one holds two.
//
// Failure look of what this guards: the migration puts a session in the
// wrong chapter (the next partner sees the previous partner's quiz again, or
// a pair loses theirs), or a failed check leaves the table half-changed.
// ──────────────────────────────────────────────────────────────────────────────

loadEnvLocal()

const databaseUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

const postgres = (await import('postgres')).default

const read = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf-8')
const FILE_0095 = read('drizzle/0095_partner_quiz_epoch.sql')
// Split the way drizzle-kit does; each statement runs on its own, in order,
// inside one transaction.
const STATEMENTS_0095 = FILE_0095.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
const DOWN_0095 = read('scripts/rollback/0095_partner_quiz_epoch.down.sql')

let pg: Sql

class Rollback extends Error {}

/** Run fn in a transaction that is always rolled back. */
async function rolledBack(fn: (tx: TransactionSql) => Promise<void>) {
  try {
    await pg.begin(async (tx) => {
      await fn(tx)
      throw new Rollback()
    })
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
}

async function run0095(tx: TransactionSql) {
  for (const stmt of STATEMENTS_0095) await tx.unsafe(stmt)
}

/**
 * Put the table in the shape 0094 leaves it in (0034's table: no epoch_id,
 * UNIQUE (group_id) named PartnerQuizSessions_group_id_key). Against a DB
 * migrated through 0094 this changes nothing. Returns which state it found.
 */
async function toPre0095(tx: TransactionSql): Promise<'0094' | '0095'> {
  const [{ had }] = await tx<{ had: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'PartnerQuizSessions' AND column_name = 'epoch_id'
    ) AS had`
  await tx.unsafe(`ALTER TABLE "PartnerQuizSessions" DROP COLUMN IF EXISTS "epoch_id" CASCADE`)
  await tx.unsafe(`
    DO $$ BEGIN
      IF to_regclass('"PartnerQuizSessions_group_id_key"') IS NULL THEN
        ALTER TABLE "PartnerQuizSessions" ADD CONSTRAINT "PartnerQuizSessions_group_id_key" UNIQUE ("group_id");
      END IF;
    END $$`)
  return had ? '0095' : '0094'
}

type Shape = {
  epochColumn: 'YES' | 'NO' | null
  constraints: string[]
  sessions: Record<string, string | null>
  answers: number
}

/** Catalog view of PartnerQuizSessions plus every session's epoch_id. */
async function shape(tx: TransactionSql): Promise<Shape> {
  const [col] = await tx<{ is_nullable: 'YES' | 'NO' }[]>`
    SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'PartnerQuizSessions' AND column_name = 'epoch_id'`
  const cons = await tx<{ c: string }[]>`
    SELECT conname || ' ' || pg_get_constraintdef(oid) AS c FROM pg_constraint
     WHERE conrelid = '"PartnerQuizSessions"'::regclass ORDER BY conname`
  const rows = await tx<{ id: string; epoch: string | null }[]>`
    SELECT id, (to_jsonb(s) ->> 'epoch_id') AS epoch FROM "PartnerQuizSessions" s ORDER BY id`
  const [{ n }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM "PartnerQuizAnswers"`
  return {
    epochColumn: col?.is_nullable ?? null,
    constraints: cons.map((r) => r.c),
    sessions: Object.fromEntries(rows.map((r) => [r.id, r.epoch])),
    answers: n,
  }
}

const PRE_CONSTRAINTS = [
  'PartnerQuizSessions_group_id_fkey FOREIGN KEY (group_id) REFERENCES "OikosGroups"(id)',
  'PartnerQuizSessions_group_id_key UNIQUE (group_id)',
  'PartnerQuizSessions_pkey PRIMARY KEY (id)',
]
const POST_CONSTRAINTS = [
  'PartnerQuizSessions_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES "GroupEpochs"(id)',
  'PartnerQuizSessions_epoch_id_unique UNIQUE (epoch_id)',
  'PartnerQuizSessions_group_id_fkey FOREIGN KEY (group_id) REFERENCES "OikosGroups"(id)',
  'PartnerQuizSessions_pkey PRIMARY KEY (id)',
]

// ─── fixtures ─────────────────────────────────────────────────────────────

const D = (iso: string) => `${iso}T00:00:00Z`

async function person(tx: TransactionSql): Promise<string> {
  const id = randomUUID()
  // on_auth_user_created (handle_new_user) inserts the Profiles row.
  await tx`INSERT INTO auth.users (id, raw_user_meta_data) VALUES (${id}, '{"full_name":"TEST_1683"}'::jsonb)`
  return id
}

type Chapter = { a: string; b: string | null; from: string; to: string | null }

/** A ledger with the given chapters; today's members are the last chapter's. */
async function ledger(tx: TransactionSql, chapters: Chapter[]) {
  const last = chapters[chapters.length - 1]
  const [g] = await tx<{ id: string }[]>`
    INSERT INTO "OikosGroups" (name, member_a, member_b, current_epoch_started_at, base_currency)
    VALUES ('TEST_1683', ${last.a}, ${last.b}, ${D(last.from)}, 'twd') RETURNING id`
  const epochs: string[] = []
  for (const c of chapters) {
    const [e] = await tx<{ id: string }[]>`
      INSERT INTO "GroupEpochs" (group_id, started_at, ended_at, member_a_id, member_b_id)
      VALUES (${g.id}, ${D(c.from)}, ${c.to ? D(c.to) : null}, ${c.a}, ${c.b}) RETURNING id`
    epochs.push(e.id)
  }
  return { groupId: g.id, epochs }
}

/** A pre-0095 session (no epoch_id) created at `at`, with `answers` answers from `by`. */
async function session(tx: TransactionSql, groupId: string, at: string, by: string[] = []) {
  const [s] = await tx<{ id: string }[]>`
    INSERT INTO "PartnerQuizSessions" (group_id, question_keys, created_at)
    VALUES (${groupId}, ARRAY['impulse','risk','transparency'], ${at}) RETURNING id`
  for (const m of by) {
    for (const q of ['impulse', 'risk', 'transparency']) {
      await tx`INSERT INTO "PartnerQuizAnswers" (session_id, member_id, question_key, choice_key)
               VALUES (${s.id}, ${m}, ${q}, 'a')`
    }
  }
  return s.id
}

/** The four backfill fixtures; returns each session id with the epoch it must land in. */
async function seedBackfill(tx: TransactionSql) {
  const a = await person(tx)
  const b = await person(tx)
  const c = await person(tx)
  const expected: Record<string, string> = {}

  // 1. A session older than the group's first chapter → the first chapter.
  const g1 = await ledger(tx, [{ a, b, from: '2026-03-01', to: null }])
  expected[await session(tx, g1.groupId, D('2026-02-10'), [a])] = g1.epochs[0]

  // 2. A+B → A solo → A+C; the session was created (and B answered) in A+B.
  const g2 = await ledger(tx, [
    { a, b, from: '2026-01-01', to: '2026-04-01' },
    { a, b: null, from: '2026-04-01', to: '2026-06-01' },
    { a, b: c, from: '2026-06-01', to: null },
  ])
  expected[await session(tx, g2.groupId, D('2026-02-15'), [b])] = g2.epochs[0]

  // 3. A session created while the chapter was solo → that solo chapter.
  const g3 = await ledger(tx, [
    { a, b, from: '2026-01-01', to: '2026-03-01' },
    { a, b: null, from: '2026-03-01', to: null },
  ])
  expected[await session(tx, g3.groupId, D('2026-05-05'))] = g3.epochs[1]

  // 4. Exactly at a boundary → the chapter that starts there (inclusive start,
  //    exclusive end — epochClause).
  const g4 = await ledger(tx, [
    { a, b, from: '2026-01-01', to: '2026-03-01' },
    { a, b: c, from: '2026-03-01', to: null },
  ])
  expected[await session(tx, g4.groupId, D('2026-03-01'), [a, c])] = g4.epochs[1]

  return { expected, a, b, c, g2 }
}

describe.skipIf(!isLocalDb)('0095 one partner quiz per chapter (#1683) — local throwaway DB', () => {
  beforeAll(async () => {
    pg = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'test_1683_0095' } })
    let start = ''
    await rolledBack(async (tx) => { start = await toPre0095(tx) })
    console.info(`[0095] database migrated through ${start}`)
  })

  afterAll(async () => {
    await pg?.end()
  })

  it('pre-0095 shape: no epoch_id, UNIQUE (group_id), no other sessions in the table', async () => {
    await rolledBack(async (tx) => {
      await toPre0095(tx)
      const s = await shape(tx)
      expect(s.epochColumn).toBeNull()
      expect(s.constraints).toEqual(PRE_CONSTRAINTS)
      expect(s.sessions).toEqual({})
    })
  })

  it('backfills each session into the chapter holding its created_at, then enforces one session per chapter', async () => {
    await rolledBack(async (tx) => {
      await toPre0095(tx)
      const { expected, g2 } = await seedBackfill(tx)
      const before = await shape(tx)

      await run0095(tx)

      const after = await shape(tx)
      expect(after.sessions).toEqual(expected)
      expect(after.epochColumn).toBe('NO')
      expect(after.constraints).toEqual(POST_CONSTRAINTS)
      expect(after.answers).toBe(before.answers)
      expect(after.answers).toBe(3 + 3 + 6)

      // A+C (today's chapter of g2) can now get its own session…
      await tx`INSERT INTO "PartnerQuizSessions" (group_id, epoch_id, question_keys)
               VALUES (${g2.groupId}, ${g2.epochs[2]}, ARRAY['future'])`
      // …but a chapter still holds at most one (UNIQUE (epoch_id))…
      await expect(tx.savepoint((sp) => sp`
        INSERT INTO "PartnerQuizSessions" (group_id, epoch_id, question_keys)
        VALUES (${g2.groupId}, ${g2.epochs[2]}, ARRAY['future'])`))
        .rejects.toMatchObject({ code: '23505', constraint_name: 'PartnerQuizSessions_epoch_id_unique' })
      // …and NOT NULL is enforced, not just declared.
      await expect(tx.savepoint((sp) => sp`
        INSERT INTO "PartnerQuizSessions" (group_id, question_keys) VALUES (${g2.groupId}, ARRAY['future'])`))
        .rejects.toMatchObject({ code: '23502', column_name: 'epoch_id' })
    })
  })

  it('a missing UNIQUE (group_id) aborts 0095 and changes nothing', async () => {
    await rolledBack(async (tx) => {
      await toPre0095(tx)
      await seedBackfill(tx)
      await tx.unsafe(`ALTER TABLE "PartnerQuizSessions" DROP CONSTRAINT "PartnerQuizSessions_group_id_key"`)
      const before = await shape(tx)

      await expect(tx.savepoint((sp) => run0095(sp)))
        .rejects.toThrow(/expected exactly one UNIQUE \(group_id\) on PartnerQuizSessions, found 0/)

      expect(await shape(tx)).toEqual(before)
      expect(before.epochColumn).toBeNull()
    })
  })

  it('a session that matches no chapter aborts 0095 and changes nothing', async () => {
    await rolledBack(async (tx) => {
      await toPre0095(tx)
      await seedBackfill(tx)
      // The ledger's only chapter ended before the session was created, and no
      // chapter is open: nothing holds it.
      const x = await person(tx)
      const g = await ledger(tx, [{ a: x, b: null, from: '2026-01-01', to: '2026-02-01' }])
      await session(tx, g.groupId, D('2026-03-01'))
      const before = await shape(tx)

      await expect(tx.savepoint((sp) => run0095(sp)))
        .rejects.toThrow(/1 PartnerQuizSessions row\(s\) match no chapter and 0 match more than one/)

      expect(await shape(tx)).toEqual(before)
    })
  })

  it('a session that matches more than one chapter aborts 0095 and changes nothing', async () => {
    await rolledBack(async (tx) => {
      await toPre0095(tx)
      await seedBackfill(tx)
      // Two overlapping chapters (corrupt data): the session is in both.
      const x = await person(tx)
      const g = await ledger(tx, [
        { a: x, b: null, from: '2026-01-01', to: '2026-05-01' },
        { a: x, b: null, from: '2026-02-01', to: null },
      ])
      await session(tx, g.groupId, D('2026-03-01'))
      const before = await shape(tx)

      await expect(tx.savepoint((sp) => run0095(sp)))
        .rejects.toThrow(/0 PartnerQuizSessions row\(s\) match no chapter and 1 match more than one/)

      expect(await shape(tx)).toEqual(before)
    })
  })

  it('a second run of 0095 is a no-op', async () => {
    await rolledBack(async (tx) => {
      await toPre0095(tx)
      const { expected } = await seedBackfill(tx)
      await run0095(tx)
      const once = await shape(tx)
      await run0095(tx)
      expect(await shape(tx)).toEqual(once)
      expect(once.sessions).toEqual(expected)
      expect(once.constraints).toEqual(POST_CONSTRAINTS)
    })
  })

  it('rollback script: 0094 shape back while every ledger has ≤1 session; 0095 re-applies', async () => {
    await rolledBack(async (tx) => {
      await toPre0095(tx)
      const { expected } = await seedBackfill(tx)
      await run0095(tx)
      const migrated = await shape(tx)

      await tx.unsafe(DOWN_0095).simple()

      const down = await shape(tx)
      expect(down.epochColumn).toBeNull()
      expect(down.constraints).toEqual(PRE_CONSTRAINTS)
      expect(down.answers).toBe(migrated.answers)
      expect(Object.keys(down.sessions).sort()).toEqual(Object.keys(expected).sort())

      await run0095(tx)
      expect(await shape(tx)).toEqual(migrated)
    })
  })

  it('rollback script RAISEs, changing nothing, once a ledger holds two sessions', async () => {
    await rolledBack(async (tx) => {
      await toPre0095(tx)
      const { g2 } = await seedBackfill(tx)
      await run0095(tx)
      await tx`INSERT INTO "PartnerQuizSessions" (group_id, epoch_id, question_keys)
               VALUES (${g2.groupId}, ${g2.epochs[2]}, ARRAY['future'])`
      const before = await shape(tx)

      await expect(tx.savepoint((sp) => sp.unsafe(DOWN_0095).simple()))
        .rejects.toThrow(/1 ledger\(s\) hold more than one PartnerQuizSessions row; forward-fix only/)

      expect(await shape(tx)).toEqual(before)
    })
  })
})
