// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres, { type Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'

// ─── #1834: 0100's Vault precondition and the job it schedules, applied ──────
//
// Against a real Postgres (stand-in, migrated through 0100):
//   - 0100 applies where there is no Vault at all (the stand-in): the
//     precondition skips itself (F11).
//   - With a Vault, a missing or malformed entry makes 0100 FAIL and leaves the
//     existing job untouched; the error names the entry, never its value (F10).
//     Failure look without this: the job is rescheduled with a NULL url/header
//     and the 16:10 UTC run fails in pg_net, with the headers in the error.
//   - The stored cron.job.command reads every value from Vault (no key or URL
//     in the text futari_backup can read, F7 / F4).
//   - The down script restores the Bearer-only shape, URL still from Vault.
// The Vault here is a plain table standing in for vault.decrypted_secrets;
// every value is a made-up fixture.
//
// LOCAL THROWAWAY SERVER ONLY. Skips itself unless DATABASE_URL is localhost:
//
//   initdb -U postgres -D <dir> && pg_ctl -D <dir> -o '-p 55834 -k <dir>' start
//   DATABASE_URL=postgres://postgres@127.0.0.1:55834/postgres \
//     npx vitest run __tests__/actions/cronSecretKey1834.test.ts
//
// Integration folder (`__tests__/actions/**`): excluded from CI.
// ──────────────────────────────────────────────────────────────────────────

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 })

const REPO = resolve(__dirname, '../..')
const MIGRATION = readFileSync(resolve(REPO, 'drizzle/0100_recurring_push_cron_secret_key.sql'), 'utf-8')
const DOWN = readFileSync(resolve(REPO, 'scripts/rollback/0100_recurring_push_cron_secret_key.down.sql'), 'utf-8')

const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)
let standInUrl = ''
let sql: Sql

const JOB = 'notify-recurring-push'
const SENTINEL = 'SELECT 1 /* pre-0100 job */'
const SECRET = 'sb_' + 'secret_'
const GOOD = {
  oikos_project_url: 'https://abcdefghij0123456789.supabase.co',
  oikos_cron_secret_key: `${SECRET}FAKEcron`.padEnd(41, '0'),
  oikos_service_role_key: 'legacy-fixture-not-a-jwt',
}
type Vault = Record<string, string | null | undefined>

beforeAll(async () => {
  if (!isLocalDb) return
  standInUrl = await createStandInDb(adminUrl, '0100')
  sql = postgres(standInUrl, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  if (!isLocalDb) return
  await sql?.end()
  await dropStandInDb(adminUrl, standInUrl)
})

/**
 * Inside a transaction that is always rolled back: create a stand-in Vault
 * holding `vault`, reset the job to SENTINEL, run `file`. Returns the error
 * message (or null) and the job's command afterwards.
 */
async function applyWithVault(file: string, vault: Vault): Promise<{ error: string | null; command: string | null }> {
  const ROLLBACK = new Error('rollback')
  let out: { error: string | null; command: string | null } = { error: null, command: null }
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe('CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets (name text UNIQUE, decrypted_secret text)')
      for (const [name, value] of Object.entries(vault)) {
        if (value !== undefined) await tx`INSERT INTO vault.decrypted_secrets VALUES (${name}, ${value})`
      }
      await tx`SELECT cron.schedule(${JOB}, '10 16 * * *', ${SENTINEL})`
      let error: string | null = null
      try {
        await tx.savepoint((sp) => sp.unsafe(file))
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      const [row] = await tx<{ command: string }[]>`SELECT command FROM cron.job WHERE jobname = ${JOB}`
      out = { error, command: row?.command ?? null }
      throw ROLLBACK
    })
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  return out
}

function expectNoValuesIn(message: string) {
  for (const v of Object.values(GOOD)) expect(message).not.toContain(v)
  expect(message).not.toMatch(/sb_secret_[A-Za-z0-9]|https:\/\/[a-z0-9]/)
}

describe.skipIf(!isLocalDb)('#1834 — 0100 on a database without Vault (the stand-in)', () => {
  it('applied, and the job reads url, Bearer and apikey from Vault at run time', async () => {
    const [job] = await sql<{ schedule: string; command: string }[]>`
      SELECT schedule, command FROM cron.job WHERE jobname = ${JOB}`
    expect(job.schedule).toBe('10 16 * * *')
    for (const name of ['oikos_project_url', 'oikos_service_role_key', 'oikos_cron_secret_key']) {
      expect(job.command).toContain(`WHERE name = '${name}'`)
    }
    expect(job.command).toMatch(/'apikey',/)
    expect(job.command).not.toMatch(/https?:\/\/|supabase\.co|sb_|eyJ/)
  })
})

describe.skipIf(!isLocalDb)('#1834 — 0100 Vault precondition', () => {
  it('passes with well-formed entries and reschedules the job', async () => {
    const r = await applyWithVault(MIGRATION, GOOD)
    expect(r.error).toBeNull()
    expect(r.command).not.toBe(SENTINEL)
    expect(r.command).toMatch(/'apikey',/)
    // Nothing from the Vault was copied into the command text.
    for (const v of Object.values(GOOD)) expect(r.command).not.toContain(v)
  })

  it.each<[string, Vault, string]>([
    ['project url missing', { ...GOOD, oikos_project_url: undefined }, 'oikos_project_url'],
    ['project url NULL', { ...GOOD, oikos_project_url: null }, 'oikos_project_url'],
    ['project url with a trailing slash', { ...GOOD, oikos_project_url: `${GOOD.oikos_project_url}/` }, 'oikos_project_url'],
    ['project url over http', { ...GOOD, oikos_project_url: GOOD.oikos_project_url.replace('https', 'http') }, 'oikos_project_url'],
    ['project url on another domain', { ...GOOD, oikos_project_url: 'https://abcdefghij0123456789.example.com' }, 'oikos_project_url'],
    ['project url with a newline', { ...GOOD, oikos_project_url: `${GOOD.oikos_project_url}\n` }, 'oikos_project_url'],
    ['cron key missing', { ...GOOD, oikos_cron_secret_key: undefined }, 'oikos_cron_secret_key'],
    ['cron key is a publishable key', { ...GOOD, oikos_cron_secret_key: 'sb_publishable_FAKE'.padEnd(46, '0') }, 'oikos_cron_secret_key'],
    ['cron key is a legacy JWT shape', { ...GOOD, oikos_cron_secret_key: 'eyJhbGciOiJIUzI1NiJ9.e30.sig' }, 'oikos_cron_secret_key'],
    ['cron key is only the prefix', { ...GOOD, oikos_cron_secret_key: SECRET }, 'oikos_cron_secret_key'],
    ['cron key with a trailing newline', { ...GOOD, oikos_cron_secret_key: `${GOOD.oikos_cron_secret_key}\n` }, 'oikos_cron_secret_key'],
    ['transition Bearer missing', { ...GOOD, oikos_service_role_key: undefined }, 'oikos_service_role_key'],
    ['transition Bearer empty', { ...GOOD, oikos_service_role_key: '' }, 'oikos_service_role_key'],
  ])('%s → 0100 fails, names the entry, prints no value, leaves the job alone', async (_n, vault, entry) => {
    const r = await applyWithVault(MIGRATION, vault)
    expect(r.error).toContain(`Vault secret ${entry}`)
    expectNoValuesIn(r.error!)
    expect(r.command).toBe(SENTINEL)
  })
})

describe.skipIf(!isLocalDb)('#1834 — 0100 down script', () => {
  it('restores the Bearer-only job with the URL still from Vault', async () => {
    const r = await applyWithVault(DOWN, GOOD)
    expect(r.error).toBeNull()
    expect(r.command).toContain("WHERE name = 'oikos_project_url'")
    expect(r.command).toContain("WHERE name = 'oikos_service_role_key'")
    expect(r.command).not.toMatch(/apikey|oikos_cron_secret_key|https?:\/\/|supabase\.co/)
  })

  it('refuses to run without a well-formed oikos_project_url, and prints no value', async () => {
    const r = await applyWithVault(DOWN, { ...GOOD, oikos_project_url: `${GOOD.oikos_project_url}/` })
    expect(r.error).toContain('Vault secret oikos_project_url')
    expectNoValuesIn(r.error!)
    expect(r.command).toBe(SENTINEL)
  })
})
