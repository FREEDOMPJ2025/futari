/**
 * #1827 S2 — the PushTokens format rule and per-person cap have one source
 * (lib/pushTokenFormat.ts), and 0101 says exactly that.
 *
 * Guards, without a database (the stand-in test
 * __tests__/actions/pushTokenFormatCap1827.test.ts applies 0101 for real):
 *   - 0101's DELETE and CHECK carry the predicate rebuilt from the constants,
 *     and the cap trigger uses PUSH_TOKENS_PER_USER.
 *   - Every platform's maxLength is at most the sign-out limit in
 *     actions/auth.ts. Failure looks like (if it were higher): no error; a
 *     token the database took is longer than signOut(token) will look at, so
 *     signing out never removes that device's row and a shared phone keeps
 *     getting the signed-out person's push. #1831 raises the sign-out limit to
 *     4096; when both are in, raising a CHECK max needs a new migration and
 *     this test passes only if sign-out still covers it.
 *   - The cap trigger is AFTER INSERT (BEFORE INSERT also fires on the
 *     upsert's DO UPDATE path and would refuse a re-registration at the cap),
 *     SECURITY DEFINER with search_path '', advisory-locked per user; both
 *     functions REVOKEd from PUBLIC, anon, authenticated, service_role.
 *   - The journal lists 0101; the down script removes what 0101 adds.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PUSH_TOKEN_FORMAT,
  PUSH_TOKENS_PER_USER,
  isWellFormedPushToken,
  pushTokenFormatSql,
  type PushTokenPlatform,
} from '@/lib/pushTokenFormat'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const TAG = '0101_push_token_format_cap'
const migration = read(`drizzle/${TAG}.sql`)
const down = read(`scripts/rollback/${TAG}.down.sql`)
/** SQL without `--` comments, so prose about BEFORE INSERT does not count. */
const migrationCode = migration.replace(/--.*$/gm, '')
const PLATFORMS: PushTokenPlatform[] = ['apns', 'fcm']

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

describe('0101 matches lib/pushTokenFormat.ts', () => {
  it.each(PLATFORMS)('%s: the same predicate in the DELETE and in the CHECK', (platform) => {
    expect(count(migrationCode, pushTokenFormatSql(platform))).toBe(2)
  })

  it('the DELETE removes what the CHECK would refuse, and the CHECK is validated (no NOT VALID)', () => {
    const del = migrationCode.indexOf('DELETE FROM "PushTokens"\n WHERE NOT (')
    const add = migrationCode.indexOf('ADD CONSTRAINT push_tokens_token_format CHECK (')
    expect(del).toBeGreaterThan(-1)
    expect(add).toBeGreaterThan(del)
    expect(migrationCode).not.toMatch(/NOT VALID/i)
    expect(migrationCode).toContain('DROP CONSTRAINT IF EXISTS push_tokens_token_format')
  })

  it('the cap trigger keeps PUSH_TOKENS_PER_USER rows', () => {
    expect(migrationCode).toContain(`v_cap constant integer := ${PUSH_TOKENS_PER_USER};`)
    expect(PUSH_TOKENS_PER_USER).toBe(10)
  })
})

describe('every token the database accepts can be removed at sign-out', () => {
  const auth = read('actions/auth.ts')
  const m = auth.match(/const MAX_PUSH_TOKEN_LENGTH = (\d+)\b/)

  it('actions/auth.ts still declares MAX_PUSH_TOKEN_LENGTH and gates the delete on it', () => {
    expect(m).not.toBeNull()
    expect(auth).toContain('token.length <= MAX_PUSH_TOKEN_LENGTH')
  })

  it.each(PLATFORMS)('%s: CHECK max <= sign-out max', (platform) => {
    expect(PUSH_TOKEN_FORMAT[platform].maxLength).toBeLessThanOrEqual(Number(m![1]))
  })

  it('no CHECK bound is above 512 while the shared token index caps a row near 2.7 kB', () => {
    // push_tokens_unique (user_id, platform, token) is a btree; Postgres refuses
    // an index row above 2704 bytes, so a much longer token fails on insert
    // anyway — with 54000, not 23514. Keep the CHECK the error people see.
    for (const p of PLATFORMS) expect(PUSH_TOKEN_FORMAT[p].maxLength).toBeLessThanOrEqual(2048)
  })
})

describe('0101 triggers and privileges', () => {
  it('cap trigger: AFTER INSERT, never BEFORE INSERT', () => {
    expect(migrationCode).toMatch(/CREATE TRIGGER "PushTokens_enforce_cap"\s+AFTER INSERT ON "PushTokens"\s+FOR EACH ROW/)
    expect(migrationCode).not.toMatch(/BEFORE INSERT/)
  })

  it('updated_at trigger: BEFORE UPDATE, row level', () => {
    expect(migrationCode).toMatch(/CREATE TRIGGER "PushTokens_touch_updated_at"\s+BEFORE UPDATE ON "PushTokens"\s+FOR EACH ROW/)
  })

  it('cap function: SECURITY DEFINER, search_path empty, advisory lock per user before the DELETE', () => {
    const start = migrationCode.indexOf('CREATE OR REPLACE FUNCTION public.push_tokens_enforce_cap()')
    const body = migrationCode.slice(start, migrationCode.indexOf('$fn$;', start))
    expect(body).toMatch(/SECURITY DEFINER\s+SET search_path = ''/)
    const lock = body.indexOf('pg_catalog.pg_advisory_xact_lock(')
    expect(lock).toBeGreaterThan(-1)
    expect(body.indexOf('DELETE FROM public."PushTokens"')).toBeGreaterThan(lock)
    expect(body).toContain("hashtextextended('PushTokens.cap:' || NEW.user_id::text, 0)")
    // The row just inserted sorts first, so it is never the one evicted.
    expect(body).toContain('ORDER BY (k.id = NEW.id) DESC, k.updated_at DESC')
  })

  it.each(['push_tokens_touch_updated_at', 'push_tokens_enforce_cap'])('%s: owner postgres, REVOKE ALL from every API role', (fn) => {
    expect(migrationCode).toContain(`ALTER FUNCTION public.${fn}() OWNER TO postgres;`)
    expect(migrationCode).toContain(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC, anon, authenticated, service_role;`)
    expect(migrationCode).not.toMatch(new RegExp(`GRANT [^;]*${fn}`))
  })

  it('journal lists 0101 right after 0100', () => {
    const journal = JSON.parse(read('drizzle/meta/_journal.json')) as { entries: { idx: number; tag: string; when: number }[] }
    const i = journal.entries.findIndex((e) => e.tag === TAG)
    expect(i).toBeGreaterThan(-1)
    expect(journal.entries[i].idx).toBe(101)
    expect(journal.entries[i - 1].tag).toBe('0100_recurring_push_cron_secret_key')
    expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when)
  })

  it('the down script drops both triggers, both functions and the constraint', () => {
    for (const s of [
      'DROP TRIGGER IF EXISTS "PushTokens_enforce_cap" ON "PushTokens";',
      'DROP TRIGGER IF EXISTS "PushTokens_touch_updated_at" ON "PushTokens";',
      'DROP FUNCTION IF EXISTS public.push_tokens_enforce_cap();',
      'DROP FUNCTION IF EXISTS public.push_tokens_touch_updated_at();',
      'ALTER TABLE "PushTokens" DROP CONSTRAINT IF EXISTS push_tokens_token_format;',
    ]) expect(down).toContain(s)
  })
})

describe('isWellFormedPushToken', () => {
  const hex64 = 'ab'.repeat(32)
  it.each<[string, string, boolean]>([
    ['apns', hex64, true],
    ['apns', hex64.toUpperCase(), true],
    ['apns', 'Ab'.repeat(32), true],
    ['apns', 'ab'.repeat(256), true],
    ['apns', 'ab'.repeat(256) + 'ab', false],
    ['apns', hex64 + 'a', false],
    ['apns', hex64.slice(2), false],
    ['apns', 'TEST', false],
    ['apns', ` ${hex64.slice(1)}`, false],
    ['apns', `${hex64.slice(1)}\n`, false],
    ['apns', 'g'.repeat(64), false],
    ['fcm', 'dGVzdA:APA91b' + 'x_-'.repeat(50), true],
    ['fcm', 'a'.repeat(20), true],
    ['fcm', 'a'.repeat(19), false],
    ['fcm', 'a'.repeat(513), false],
    ['fcm', 'a'.repeat(30) + '/', false],
    ['fcm', 'a'.repeat(30) + '.', false],
    ['webpush', hex64, false],
  ])('%s %#', (platform, token, ok) => {
    expect(isWellFormedPushToken(platform, token)).toBe(ok)
  })
})
