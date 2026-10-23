// @vitest-environment node
/**
 * #968 S4b (security-review F8) — send-recurring-push accepts only the legacy
 * service_role JWT that the notify-recurring-push cron sends from Vault.
 *
 * How it holds: the Supabase gateway (verify_jwt = true, pinned in
 * supabase/config.toml) verifies the JWT signature; callerAuth.ts checks the
 * claims role=service_role, ref=<this project>, exp in the future. The fixtures
 * below carry made-up signatures on purpose — checking the signature is the
 * gateway's job, which is why the config pin at the bottom is part of this test.
 *
 * Scenario guarded (exploit): the gateway alone lets the public anon key and
 * `sb_publishable_…` keys through, so anyone holding them could POST to the
 * function and push every household with a pending card.
 *
 * Scenario guarded (failure, 2026-10-23): the withdrawn check required the
 * bearer to equal SUPABASE_SERVICE_ROLE_KEY, which the hosted runtime sets to a
 * new-style `sb_` secret key while the cron sends the legacy JWT. Failure looked
 * like: the 16:10 UTC cron gets 401, no push goes out, nothing else errors —
 * see 「呼叫者驗證」 in ops-runbook.md. The "accepts the cron's token shape"
 * case is that regression check.
 *
 * Fixtures are built from JSON here; none of them is a real key.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_AUTHORIZATION_LENGTH,
  checkServiceRoleJwt,
  decodeJwtSegment,
  projectRefFromUrl,
} from '../supabase/functions/send-recurring-push/callerAuth.ts'

const REF = 'abcdefghij0123456789' // 20 chars, same shape as a real ref
const NOW = 1_800_000_000
const FUTURE = 2_082_758_400 // 2036, like the legacy keys
const FAKE_SIG = 'not-a-real-signature_gateway-checks-it'

function b64url(s: string | Uint8Array): string {
  return Buffer.from(s).toString('base64url')
}
function seg(value: unknown): string {
  return b64url(JSON.stringify(value))
}
function jwt(payload: unknown, header: unknown = { alg: 'HS256', typ: 'JWT' }): string {
  return `${seg(header)}.${seg(payload)}.${FAKE_SIG}`
}
const CRON_CLAIMS = { iss: 'supabase', ref: REF, role: 'service_role', iat: 1_700_000_000, exp: FUTURE }
const bearer = (token: string) => `Bearer ${token}`
const check = (authorization: string | null | undefined, ref: string | null | undefined = REF) =>
  checkServiceRoleJwt(authorization, ref, NOW)
const rejects = (authorization: string | null | undefined, reason: string, ref: string | null | undefined = REF) =>
  expect(check(authorization, ref)).toEqual({ ok: false, reason })

describe('checkServiceRoleJwt — accept', () => {
  it("accepts the cron's token shape (role/ref/exp); the signature is the gateway's job, not checked here", () => {
    expect(check(bearer(jwt(CRON_CLAIMS)))).toEqual({ ok: true })
  })

  it('accepts without iss/iat (only role, ref, exp are required)', () => {
    expect(check(bearer(jwt({ role: 'service_role', ref: REF, exp: NOW + 1 })))).toEqual({ ok: true })
  })
})

describe('checkServiceRoleJwt — claims', () => {
  it.each([
    ['anon', { ...CRON_CLAIMS, role: 'anon' }],
    ['authenticated', { ...CRON_CLAIMS, role: 'authenticated' }],
    ['missing', { iss: 'supabase', ref: REF, exp: FUTURE }],
    ['array', { ...CRON_CLAIMS, role: ['service_role'] }],
    ['wrong case', { ...CRON_CLAIMS, role: 'Service_Role' }],
    ['leading space', { ...CRON_CLAIMS, role: ' service_role' }],
    ['trailing space', { ...CRON_CLAIMS, role: 'service_role ' }],
  ])('rejects role %s', (_name, payload) => {
    rejects(bearer(jwt(payload)), 'role')
  })

  it('rejects a token for another project, or with no ref', () => {
    rejects(bearer(jwt({ ...CRON_CLAIMS, ref: 'zzzzzzzzzz0123456789' })), 'ref')
    rejects(bearer(jwt({ iss: 'supabase', role: 'service_role', exp: FUTURE })), 'ref')
    rejects(bearer(jwt({ ...CRON_CLAIMS, ref: REF.toUpperCase() })), 'ref')
  })

  it('fails closed when the function has no project ref', () => {
    rejects(bearer(jwt(CRON_CLAIMS)), 'no_ref_config', null)
    rejects(bearer(jwt(CRON_CLAIMS)), 'no_ref_config', '')
    // Called directly: passing undefined to the helper would pick up its default REF.
    expect(checkServiceRoleJwt(bearer(jwt(CRON_CLAIMS)), undefined, NOW)).toEqual({ ok: false, reason: 'no_ref_config' })
  })

  it.each([
    ['past', NOW - 1],
    ['exactly now', NOW],
    ['a string', String(FUTURE)],
    ['null', null],
  ])('rejects exp %s', (_name, exp) => {
    rejects(bearer(jwt({ ...CRON_CLAIMS, exp })), 'expired')
  })

  it('rejects a missing exp', () => {
    rejects(bearer(jwt({ iss: 'supabase', ref: REF, role: 'service_role' })), 'expired')
  })

  it.each(['none', 'NONE', 'None'])('rejects alg %s', (alg) => {
    rejects(bearer(jwt(CRON_CLAIMS, { alg, typ: 'JWT' })), 'not_jwt')
  })

  it('rejects a header without a string alg', () => {
    rejects(bearer(jwt(CRON_CLAIMS, { typ: 'JWT' })), 'not_jwt')
    rejects(bearer(jwt(CRON_CLAIMS, { alg: 256 })), 'not_jwt')
  })
})

describe('checkServiceRoleJwt — header shape', () => {
  const good = jwt(CRON_CLAIMS)

  it('rejects a missing or empty header', () => {
    rejects(null, 'no_header')
    rejects(undefined, 'no_header')
    rejects('', 'no_header')
  })

  it('rejects other schemes, lowercase bearer, a bare token, and leading whitespace', () => {
    rejects(`Basic ${good}`, 'not_bearer')
    rejects(`bearer ${good}`, 'not_bearer')
    rejects(`BEARER ${good}`, 'not_bearer')
    rejects(good, 'not_bearer')
    rejects(` Bearer ${good}`, 'not_bearer')
    rejects(`Bearer\t${good}`, 'not_bearer')
  })

  it('rejects a header longer than the limit without parsing it', () => {
    const long = `Bearer ${seg({ alg: 'HS256' })}.${seg({ ...CRON_CLAIMS, pad: 'x'.repeat(MAX_AUTHORIZATION_LENGTH) })}.${FAKE_SIG}`
    expect(long.length).toBeGreaterThan(MAX_AUTHORIZATION_LENGTH)
    rejects(long, 'not_bearer')
  })

  it.each([
    ['sb_publishable key', 'Bearer sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
    ['sb_secret key', 'Bearer sb_secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
    ['empty bearer', 'Bearer '],
    ['two segments', `Bearer ${seg({ alg: 'HS256' })}.${seg(CRON_CLAIMS)}`],
    ['four segments', `Bearer ${good}.extra`],
    ['empty signature', `Bearer ${seg({ alg: 'HS256' })}.${seg(CRON_CLAIMS)}.`],
    ['empty header segment', `Bearer .${seg(CRON_CLAIMS)}.${FAKE_SIG}`],
    ['`=` padding', `Bearer ${good}=`],
    ['standard base64 `+`', `Bearer ${good}+x`],
    ['standard base64 `/`', `Bearer ${good}/x`],
    ['two joined headers', `Bearer ${good}, Bearer ${good}`],
    ['trailing space', `Bearer ${good} `],
    ['trailing newline', `Bearer ${good}\n`],
    ['double space', `Bearer  ${good}`],
    ['two tokens', `Bearer ${good} ${good}`],
  ])('rejects %s as not a JWT', (_name, authorization) => {
    rejects(authorization, 'not_jwt')
  })

  it.each([
    ['non-JSON payload', `${seg({ alg: 'HS256' })}.${b64url('not json')}.${FAKE_SIG}`],
    ['JSON null payload', `${seg({ alg: 'HS256' })}.${seg(null)}.${FAKE_SIG}`],
    ['JSON array payload', `${seg({ alg: 'HS256' })}.${seg([CRON_CLAIMS])}.${FAKE_SIG}`],
    ['JSON number payload', `${seg({ alg: 'HS256' })}.${seg(42)}.${FAKE_SIG}`],
    ['JSON string payload', `${seg({ alg: 'HS256' })}.${seg('service_role')}.${FAKE_SIG}`],
    ['invalid UTF-8 payload', `${seg({ alg: 'HS256' })}.${b64url(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))}.${FAKE_SIG}`],
    ['impossible base64 length', `${seg({ alg: 'HS256' })}.A.${FAKE_SIG}`],
    ['non-JSON header', `${b64url('HS256')}.${seg(CRON_CLAIMS)}.${FAKE_SIG}`],
    ['JSON array header', `${seg(['HS256'])}.${seg(CRON_CLAIMS)}.${FAKE_SIG}`],
  ])('rejects %s', (_name, token) => {
    rejects(bearer(token), 'bad_payload')
  })
})

describe('decodeJwtSegment', () => {
  it('decodes base64url with `-`/`_` and multi-byte UTF-8', () => {
    // UTF-8 of this object encodes to base64 containing both `+` and `/`, so
    // its base64url form contains both `-` and `_`.
    const value = { n: 'é漢字?>~>?', role: 'service_role' }
    const s = seg(value)
    expect(s).toMatch(/-/)
    expect(s).toMatch(/_/)
    expect(s).not.toMatch(/[+/=]/)
    expect(decodeJwtSegment(s)).toEqual(value)
  })

  it('decodes an unpadded segment of every length remainder', () => {
    for (const v of [{ a: 1 }, { ab: 1 }, { abc: 1 }]) {
      expect(decodeJwtSegment(seg(v))).toEqual(v)
    }
  })
})

describe('projectRefFromUrl', () => {
  it('reads the ref from https://<ref>.supabase.co, with or without a trailing slash', () => {
    expect(projectRefFromUrl(`https://${REF}.supabase.co`)).toBe(REF)
    expect(projectRefFromUrl(`https://${REF}.supabase.co/`)).toBe(REF)
  })

  it('returns null for anything else (fail closed)', () => {
    expect(projectRefFromUrl('https://api.futari.example')).toBeNull()
    expect(projectRefFromUrl(`http://${REF}.supabase.co`)).toBeNull()
    expect(projectRefFromUrl(`https://${REF}.supabase.co/functions/v1`)).toBeNull()
    expect(projectRefFromUrl(`https://${REF}x.supabase.co`)).toBeNull()
    expect(projectRefFromUrl(`https://${REF.toUpperCase()}.supabase.co`)).toBeNull()
    expect(projectRefFromUrl(`https://${REF}.supabase.co.evil.example`)).toBeNull()
    expect(projectRefFromUrl('')).toBeNull()
    expect(projectRefFromUrl(undefined)).toBeNull()
  })
})

describe('send-recurring-push wiring (#968 S4b caller auth)', () => {
  const src = readFileSync(
    join(process.cwd(), 'supabase/functions/send-recurring-push/index.ts'),
    'utf8',
  )
  const serve = src.slice(src.indexOf('Deno.serve('))
  const CALL = "checkServiceRoleJwt(req.headers.get('authorization'), PROJECT_REF, Math.floor(Date.now() / 1000))"
  const check = serve.indexOf(CALL)
  const client = serve.indexOf('createClient(')
  const gate = serve.slice(check, client)

  it('derives the project ref from SUPABASE_URL', () => {
    expect(src).toMatch(/^const SUPABASE_URL = Deno\.env\.get\('SUPABASE_URL'\)!$/m)
    expect(src).toMatch(/^const PROJECT_REF = projectRefFromUrl\(SUPABASE_URL\)$/m)
  })

  it('checks the caller before creating the DB client or any query, and answers 401', () => {
    expect(serve.indexOf('Deno.serve(')).toBe(0)
    expect(check).toBeGreaterThan(-1)
    expect(client).toBeGreaterThan(check)
    expect(serve.indexOf('.from(')).toBeGreaterThan(client)
    expect(gate).toMatch(/if \(!caller\.ok\) \{[\s\S]*?return new Response\('unauthorized', \{ status: 401 \}\)\s*\}/)
  })

  it('logs only the reason on reject, and nothing on accept', () => {
    const logs = gate.match(/console\.\w+\([^\n]*\)/g) ?? []
    expect(logs).toEqual(['console.warn(`[auth] reject reason=${caller.reason}`)'])
    for (const l of logs) expect(l).not.toMatch(/authorization|token|payload|role|header|bearer/i)
    // The one log line sits inside the reject branch.
    expect(gate.indexOf('if (!caller.ok) {')).toBeLessThan(gate.indexOf('console.warn('))
  })

  it('has no exact-match path against SUPABASE_SERVICE_ROLE_KEY (withdrawn 2026-10-23)', () => {
    expect(gate).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
    const auth = readFileSync(
      join(process.cwd(), 'supabase/functions/send-recurring-push/callerAuth.ts'),
      'utf8',
    )
    expect(auth).not.toMatch(/timingSafe|isServiceRoleCaller|crypto\.subtle|Deno\.env/)
  })
})

describe('verify_jwt stays on for send-recurring-push (the claim check depends on it)', () => {
  it('supabase/config.toml pins verify_jwt = true and never false', () => {
    const toml = readFileSync(join(process.cwd(), 'supabase/config.toml'), 'utf8')
    const lines = toml.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean)
    const start = lines.indexOf('[functions.send-recurring-push]')
    expect(start).toBeGreaterThan(-1)
    const next = lines.findIndex((l, i) => i > start && l.startsWith('['))
    const section = lines.slice(start + 1, next === -1 ? undefined : next)
    expect(section).toContain('verify_jwt = true')
    expect(section.filter((l) => /^verify_jwt\s*=/.test(l))).toEqual(['verify_jwt = true'])
    // Only one section for this function (a later duplicate would override it).
    expect(lines.filter((l) => /^\[functions\.["']?send-recurring-push["']?\]$/.test(l))).toHaveLength(1)
  })

  it('no tracked doc, script, skill or workflow deploys it with --no-verify-jwt', () => {
    const files = execFileSync('git', ['ls-files', '-z', '--', 'docs', 'scripts', '.claude', '.github', 'package.json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean)
    expect(files.length).toBeGreaterThan(10)
    const hits: string[] = []
    for (const rel of files) {
      let text: string
      try {
        text = readFileSync(join(process.cwd(), rel), 'utf8')
      } catch {
        continue
      }
      // Join shell line continuations so a multi-line deploy command is one line.
      const lines = text.replace(/\\\r?\n/g, ' ').split('\n')
      lines.forEach((l, i) => {
        if (/functions\s+deploy/.test(l) && l.includes('send-recurring-push') && l.includes('--no-verify-jwt')) {
          hits.push(`${rel}:${i + 1}`)
        }
      })
    }
    expect(hits).toEqual([])
  })
})
