/**
 * Reading pg_cron job bodies out of the migrations, for tests that cannot talk
 * to Postgres (#1262, #1834).
 *
 * cron.schedule() replaces a job by name, so the highest-numbered migration
 * that schedules a job is the one that is live. A future migration that
 * re-schedules a job from an older copy fails the tests built on this.
 */
import { expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const DRIZZLE_DIR = join(process.cwd(), 'drizzle')

/** The schedule + `$$…$$` body of `cron.schedule('<jobName>', …)` in `sql`, or null. */
export function cronJobIn(sql: string, jobName: string): { schedule: string; body: string } | null {
  const m = sql.match(
    new RegExp(`cron\\.schedule\\('${jobName}',\\s*'([^']+)',\\s*\\$\\$([\\s\\S]*?)\\$\\$\\)`),
  )
  return m ? { schedule: m[1], body: m[2] } : null
}

/** The migration file (name) that currently owns `jobName`. */
export function liveCronJobFile(jobName: string): string {
  const files = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql')).sort()
  const owning = files.filter((f) =>
    readFileSync(join(DRIZZLE_DIR, f), 'utf8').includes(`cron.schedule('${jobName}'`),
  )
  expect(owning.length, `no migration schedules ${jobName}`).toBeGreaterThan(0)
  return owning[owning.length - 1]
}

/** The schedule + body of the migration that currently owns `jobName`. */
export function liveCronJob(jobName: string): { schedule: string; body: string } {
  const sql = readFileSync(join(DRIZZLE_DIR, liveCronJobFile(jobName)), 'utf8')
  const job = cronJobIn(sql, jobName)
  expect(job, `cron.schedule('${jobName}', ...) body should be parseable`).not.toBeNull()
  return job!
}
