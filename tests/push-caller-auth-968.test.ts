// @vitest-environment node
/**
 * #968 S4b (security-review F8) — send-recurring-push accepts only the
 * service-role bearer that the notify-recurring-push cron sends from Vault.
 *
 * Scenario: the Supabase gateway's JWT check accepts the public anon key, so
 * before this anyone holding it could POST to the function and push every
 * household with a pending card. Failure looks like (if this check broke the
 * other way): the 16:10 UTC cron gets 401, no push goes out, nothing else
 * errors — see the post-deploy check in ops-runbook.md.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isServiceRoleCaller,
  timingSafeEqualStrings,
} from '../supabase/functions/send-recurring-push/callerAuth.ts'

const SERVICE = 'service-role-key-0123456789abcdef'

describe('isServiceRoleCaller', () => {
  it('accepts exactly `Bearer <service role key>`', async () => {
    expect(await isServiceRoleCaller(`Bearer ${SERVICE}`, SERVICE)).toBe(true)
  })

  it('rejects a wrong key of the same length (e.g. the anon key)', async () => {
    const wrong = SERVICE.slice(0, -1) + (SERVICE.endsWith('f') ? 'e' : 'f')
    expect(wrong).toHaveLength(SERVICE.length)
    expect(await isServiceRoleCaller(`Bearer ${wrong}`, SERVICE)).toBe(false)
  })

  it('rejects a missing or empty header', async () => {
    expect(await isServiceRoleCaller(null, SERVICE)).toBe(false)
    expect(await isServiceRoleCaller(undefined, SERVICE)).toBe(false)
    expect(await isServiceRoleCaller('', SERVICE)).toBe(false)
    expect(await isServiceRoleCaller('Bearer ', SERVICE)).toBe(false)
  })

  it('rejects a key of a different length (prefix, longer, padded)', async () => {
    expect(await isServiceRoleCaller(`Bearer ${SERVICE.slice(0, 8)}`, SERVICE)).toBe(false)
    expect(await isServiceRoleCaller(`Bearer ${SERVICE}x`, SERVICE)).toBe(false)
    expect(await isServiceRoleCaller(`Bearer ${SERVICE} `, SERVICE)).toBe(false)
    expect(await isServiceRoleCaller(`Bearer  ${SERVICE}`, SERVICE)).toBe(false)
  })

  it('rejects other schemes and the bare key', async () => {
    expect(await isServiceRoleCaller(SERVICE, SERVICE)).toBe(false)
    expect(await isServiceRoleCaller(`Basic ${SERVICE}`, SERVICE)).toBe(false)
    expect(await isServiceRoleCaller(`bearer ${SERVICE}`, SERVICE)).toBe(false)
  })

  it('fails closed when the function has no service role key', async () => {
    expect(await isServiceRoleCaller('Bearer ', '')).toBe(false)
    expect(await isServiceRoleCaller('Bearer x', undefined)).toBe(false)
    expect(await isServiceRoleCaller('Bearer x', null)).toBe(false)
  })
})

describe('timingSafeEqualStrings', () => {
  it('compares by value', async () => {
    expect(await timingSafeEqualStrings('abc', 'abc')).toBe(true)
    expect(await timingSafeEqualStrings('abc', 'abd')).toBe(false)
    expect(await timingSafeEqualStrings('abc', 'abcd')).toBe(false)
    expect(await timingSafeEqualStrings('', '')).toBe(true)
  })
})

describe('send-recurring-push wiring (#968 S4b caller auth)', () => {
  const src = readFileSync(
    join(process.cwd(), 'supabase/functions/send-recurring-push/index.ts'),
    'utf8',
  )

  it('checks the caller before creating the DB client, and answers 401', () => {
    const serve = src.slice(src.indexOf('Deno.serve('))
    const check = serve.indexOf("isServiceRoleCaller(req.headers.get('authorization'), SUPABASE_SERVICE_ROLE_KEY)")
    const client = serve.indexOf('createClient(')
    expect(check).toBeGreaterThan(-1)
    expect(client).toBeGreaterThan(check)
    expect(serve.slice(check, client)).toContain("new Response('unauthorized', { status: 401 })")
  })
})
