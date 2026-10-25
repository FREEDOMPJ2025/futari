// @vitest-environment node
/**
 * #1834 — the notify-recurring-push cron job, as 0100 schedules it and as its
 * rollback script restores it. Nothing here talks to Postgres: the job body is
 * parsed out of the live migration (the highest-numbered one scheduling the
 * job, see tests/_helpers/cronJob.ts) and out of the down script.
 *
 * What it guards (each fails silently in production — the job is created, the
 * cron fires, and only net._http_response / the function log shows it):
 *   - a key or token written into the command. cron.job.command is readable by
 *     futari_backup and copied into every backup manifest; a key there leaks
 *     with each backup. Values must be read from Vault when the job runs.
 *   - a literal project URL. 0056 hard-coded prod's, so dev's cron called prod
 *     with dev's key (F4). The URL comes from Vault oikos_project_url.
 *   - the apikey header missing (the #1834 function answers 401 no_apikey) or
 *     the transition Bearer missing (the pre-#1834 function answers 401).
 *   - the schedule drifting off 16:10 UTC (00:10 Taipei, after the generators).
 *   - a Vault precondition that prints the values it checks, or that cannot be
 *     applied to the test stand-in (no Vault there).
 *   - the #874 trap: an SQL file without its journal entry is skipped silently.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DRIZZLE_DIR, cronJobIn, liveCronJob, liveCronJobFile } from './_helpers/cronJob'

const JOB = 'notify-recurring-push'
const MIGRATION = '0100_recurring_push_cron_secret_key'
const DOWN = join(process.cwd(), `scripts/rollback/${MIGRATION}.down.sql`)

const migrationSql = readFileSync(join(DRIZZLE_DIR, `${MIGRATION}.sql`), 'utf8')
const downSql = readFileSync(DOWN, 'utf8')

/** `(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '<name>' LIMIT 1)`, any whitespace. */
const vaultRead = (name: string) =>
  `\\(\\s*SELECT\\s+decrypted_secret\\s+FROM\\s+vault\\.decrypted_secrets\\s+WHERE\\s+name\\s*=\\s*'${name}'\\s+LIMIT\\s+1\\s*\\)`

const URL_FROM_VAULT = new RegExp(
  `url\\s*:=\\s*${vaultRead('oikos_project_url')}\\s*\\|\\|\\s*'/functions/v1/send-recurring-push'`,
)
const BEARER_FROM_VAULT = new RegExp(`'Authorization',\\s*'Bearer '\\s*\\|\\|\\s*${vaultRead('oikos_service_role_key')}`)
const APIKEY_FROM_VAULT = new RegExp(`'apikey',\\s*${vaultRead('oikos_cron_secret_key')}`)

/** Things that look like a key, token or URL written into SQL text. */
function assertNoLiterals(sql: string, body: string) {
  // Anywhere in the file (comments included): no key- or token-shaped literal.
  expect(sql).not.toMatch(/sb_secret_[A-Za-z0-9_-]{8,}/)
  expect(sql).not.toMatch(/sb_publishable_[A-Za-z0-9_-]{8,}/)
  expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/)
  expect(sql).not.toMatch(/[a-z0-9]{20}\.supabase\.co/)
  // In the job body: no URL, no key prefix, and nothing built at apply time.
  expect(body).not.toMatch(/https?:\/\//)
  expect(body).not.toMatch(/supabase\.co/)
  expect(body).not.toMatch(/sb_|eyJ/)
  expect(sql).not.toMatch(/\bformat\s*\(|\bEXECUTE\b|current_setting/i)
}

const cases = [
  ['0100 (the live job)', migrationSql, () => liveCronJob(JOB)],
  ['the 0100 down script', downSql, () => cronJobIn(downSql, JOB)!],
] as const

describe.each(cases)('%s', (_name, sql, job) => {
  it('is parseable and keeps the 16:10 UTC schedule', () => {
    const j = job()
    expect(j).not.toBeNull()
    expect(j.schedule).toBe('10 16 * * *')
  })

  it('reads the URL from Vault oikos_project_url at run time, never a literal', () => {
    expect(job().body).toMatch(URL_FROM_VAULT)
  })

  it('sends the transition Bearer from Vault oikos_service_role_key', () => {
    expect(job().body).toMatch(BEARER_FROM_VAULT)
  })

  it('has no key, token or project URL literal, and builds nothing at apply time', () => {
    assertNoLiterals(sql, job().body)
  })

  it('checks oikos_project_url before rescheduling, without printing it', () => {
    const pre = sql.indexOf('DO $$')
    expect(pre).toBeGreaterThan(-1)
    expect(pre).toBeLessThan(sql.indexOf(`cron.schedule('${JOB}'`))
    expect(sql).toContain(`v_url !~ '^https://[a-z0-9]{20}\\.supabase\\.co$'`)
    const raises = sql.split('\n').filter((l) => /RAISE\s+(EXCEPTION|NOTICE|WARNING|LOG|INFO)/.test(l))
    expect(raises.length).toBeGreaterThan(0)
    for (const l of raises) {
      expect(l).not.toMatch(/v_url|v_key|decrypted_secret\b|%/)
    }
  })
})

describe('0100 — the job sends the cron key', () => {
  it('0100 owns the job (no later migration reschedules it from an older copy)', () => {
    expect(liveCronJobFile(JOB)).toBe(`${MIGRATION}.sql`)
  })

  it('sends apikey from Vault oikos_cron_secret_key', () => {
    expect(liveCronJob(JOB).body).toMatch(APIKEY_FROM_VAULT)
  })

  it('sends exactly these headers: Content-Type, Authorization (transition), apikey', () => {
    const body = liveCronJob(JOB).body
    const headerKeys = [...body.matchAll(/^\s*'([A-Za-z-]+)',/gm)].map((m) => m[1])
    expect(headerKeys).toEqual(['Content-Type', 'Authorization', 'apikey'])
  })

  it('checks every Vault entry the job reads, and skips only when there is no Vault at all', () => {
    expect(migrationSql).toMatch(
      /IF to_regclass\('vault\.decrypted_secrets'\) IS NULL THEN[\s\S]*?RETURN;\s*END IF;/,
    )
    expect(migrationSql).toMatch(/left\(v_key, 10\) <> 'sb_secret_'/)
    expect(migrationSql).toMatch(/v_key ~ '\\s'/)
    for (const name of ['oikos_project_url', 'oikos_cron_secret_key', 'oikos_service_role_key']) {
      expect(migrationSql).toContain(`RAISE EXCEPTION '0100: Vault secret ${name} is missing`)
    }
  })

  it('is in the journal right after 0099 (#874: a file without an entry is skipped silently)', () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[]
    }
    const i = journal.entries.findIndex((e) => e.tag === MIGRATION)
    expect(i).toBeGreaterThan(-1)
    expect(journal.entries[i].idx).toBe(100)
    expect(journal.entries[i - 1].tag).toBe('0099_left_label_marker')
    expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when)
  })
})

describe('the 0100 down script — 0056 header shape, Vault URL', () => {
  it('drops the apikey header and does not read the cron key', () => {
    const { body } = cronJobIn(downSql, JOB)!
    expect(body).not.toMatch(/apikey/i)
    expect(body).not.toContain('oikos_cron_secret_key')
    const headerKeys = [...body.matchAll(/^\s*'([A-Za-z-]+)',/gm)].map((m) => m[1])
    expect(headerKeys).toEqual(['Content-Type', 'Authorization'])
  })

  it('is manual-only: not in the journal, and says so', () => {
    expect(downSql).toMatch(/MANUAL ONLY, NEVER RUN AUTOMATICALLY/)
    const journal = readFileSync(join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')
    expect(journal).not.toContain('.down')
  })
})
