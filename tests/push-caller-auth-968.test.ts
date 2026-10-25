// @vitest-environment node
/**
 * #1834 (replaces #968 S4b) — send-recurring-push accepts only the project's
 * named secret key `cron`, sent by the notify-recurring-push cron as `apikey`.
 *
 * How it holds: supabase/config.toml sets verify_jwt = false (the gateway
 * cannot verify sb_ keys), so callerAuth.ts#checkCronApiKey is the ONLY check.
 * It compares the `apikey` header with the `cron` entry of the runtime's
 * SUPABASE_SECRET_KEYS (a JSON object keyed by key name), constant-time, and
 * fails closed on any config problem.
 *
 * Scenario guarded (exploit): with verify_jwt off, any fail-open path — a
 * missing / unparsable SUPABASE_SECRET_KEYS treated as "allow", an undefined
 * vs undefined compare, accepting the `default` key or any key in the object,
 * reading the Authorization header, a leftover JWT claim check (anyone can
 * write claims when nobody verifies the signature) — lets anyone POST to the
 * function and push every household with a pending card.
 *
 * Scenario guarded (failure): Supabase retires the legacy JWT keys at the end
 * of 2026. The withdrawn claim check needed the cron's legacy service_role JWT;
 * from that day the 16:10 UTC cron would get 401, no `[auth]` log line, no
 * push, nothing else erroring — see 「呼叫者驗證」 in ops-runbook.md. The
 * "accepts the cron key" case is that regression check.
 *
 * Fixtures are built here; none of them is a real key. They are assembled from
 * pieces so this file never spells out an sb_secret_-shaped literal
 * (tests/no-tracked-secrets-968.test.ts scans it like every other file).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CRON_KEY_NAME,
  MAX_APIKEY_LENGTH,
  checkCronApiKey,
  secretKeyNamed,
} from '../supabase/functions/send-recurring-push/callerAuth.ts'

const SECRET = 'sb_' + 'secret_'
const fakeSecret = (tag: string) => `${SECRET}${tag}`.padEnd(41, '0')
const CRON_KEY = fakeSecret('cronFAKE')
const DEFAULT_KEY = fakeSecret('defaultFAKE')
const PUBLISHABLE_KEY = `${'sb_' + 'publishable_'}FAKE`.padEnd(46, '0')
const LEGACY_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoic2VydmljZV9yb2xlIn0', 'not-a-real-signature'].join('.')

const keys = (entries: Record<string, unknown>) => JSON.stringify(entries)
const CONFIG = keys({ default: DEFAULT_KEY, cron: CRON_KEY })

const rejects = (apikey: string | null | undefined, reason: string, config: string | null | undefined = CONFIG) =>
  expect(checkCronApiKey(apikey, config)).toEqual({ ok: false, reason })

describe('checkCronApiKey — accept', () => {
  it('accepts the cron key on the apikey header', () => {
    expect(checkCronApiKey(CRON_KEY, CONFIG)).toEqual({ ok: true })
  })

  it('accepts it whatever other keys the project has', () => {
    expect(checkCronApiKey(CRON_KEY, keys({ cron: CRON_KEY }))).toEqual({ ok: true })
    expect(checkCronApiKey(CRON_KEY, keys({ default: DEFAULT_KEY, other: fakeSecret('o'), cron: CRON_KEY }))).toEqual({ ok: true })
  })

  it('only accepts the key named cron', () => {
    expect(CRON_KEY_NAME).toBe('cron')
  })
})

describe('checkCronApiKey — fails closed on the key config (no_key_config)', () => {
  it.each([
    ['missing (undefined)', undefined],
    ['missing (null)', null],
    ['empty', ''],
    ['not JSON', 'cron=' + CRON_KEY],
    ['JSON null', 'null'],
    ['JSON array', JSON.stringify([CRON_KEY])],
    ['JSON string', JSON.stringify(CRON_KEY)],
    ['no cron entry', keys({ default: DEFAULT_KEY })],
    ['empty object', '{}'],
    ['cron entry not a string', keys({ cron: 42 })],
    ['cron entry null', keys({ cron: null })],
    ['cron entry is a publishable key', keys({ cron: PUBLISHABLE_KEY })],
    ['cron entry is a legacy JWT', keys({ cron: LEGACY_JWT })],
    ['cron entry is only the prefix', keys({ cron: SECRET })],
    ['cron entry is empty', keys({ cron: '' })],
    ['cron entry too long', keys({ cron: SECRET + 'x'.repeat(MAX_APIKEY_LENGTH) })],
    ['cron only via __proto__', '{"__proto__":{"cron":"' + CRON_KEY + '"}}'],
    ['different case of the name', keys({ Cron: CRON_KEY })],
  ])('%s → every caller is refused, even one sending the right key', (_name, config) => {
    // Called directly: passing undefined to the `rejects` helper would pick up its default CONFIG.
    for (const apikey of [CRON_KEY, null, undefined]) {
      expect(checkCronApiKey(apikey, config)).toEqual({ ok: false, reason: 'no_key_config' })
    }
  })
})

describe('checkCronApiKey — the apikey header', () => {
  it.each([
    ['missing (null)', null],
    ['missing (undefined)', undefined],
    ['empty', ''],
    ['the string "undefined"', 'undefined'],
  ])('rejects %s as no_apikey', (_name, apikey) => {
    rejects(apikey, 'no_apikey')
  })

  it('rejects a key sent only as Authorization (the apikey header is absent)', () => {
    // The function passes req.headers.get('apikey') and nothing else; a caller
    // that puts the right key in Authorization reaches the check with null.
    rejects(null, 'no_apikey')
  })

  it.each([
    ['the publishable key', PUBLISHABLE_KEY],
    ['the default secret key', DEFAULT_KEY],
    ['another secret key', fakeSecret('other')],
    ['a legacy service_role JWT', LEGACY_JWT],
    ['a Bearer-prefixed cron key', `Bearer ${CRON_KEY}`],
    ['trailing whitespace', `${CRON_KEY} `],
    ['leading whitespace', ` ${CRON_KEY}`],
    ['trailing newline', `${CRON_KEY}\n`],
    ['two joined values ("k, k")', `${CRON_KEY}, ${CRON_KEY}`],
    ['the key upper-cased', CRON_KEY.toUpperCase()],
    ['the key minus its last character', CRON_KEY.slice(0, -1)],
    ['one character different, same length', CRON_KEY.slice(0, -1) + (CRON_KEY.endsWith('1') ? '2' : '1')],
    ['only the prefix', SECRET],
    ['longer than the cap', CRON_KEY + 'x'.repeat(MAX_APIKEY_LENGTH)],
    ['the string "null"', 'null'],
  ])('rejects %s as mismatch', (_name, apikey) => {
    rejects(apikey, 'mismatch')
  })
})

describe('secretKeyNamed (the DB client key)', () => {
  it('returns the default key for the DB client, and the cron key by name', () => {
    expect(secretKeyNamed(CONFIG, 'default')).toBe(DEFAULT_KEY)
    expect(secretKeyNamed(CONFIG, 'cron')).toBe(CRON_KEY)
  })

  it('returns null rather than a fallback', () => {
    expect(secretKeyNamed(keys({ cron: CRON_KEY }), 'default')).toBeNull()
    expect(secretKeyNamed(undefined, 'default')).toBeNull()
    expect(secretKeyNamed('not json', 'default')).toBeNull()
    expect(secretKeyNamed(keys({ default: LEGACY_JWT }), 'default')).toBeNull()
  })
})

/** Source with // and /* *\/ comments removed, so prose about the old design does not count. */
function code(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('send-recurring-push wiring (#1834 caller auth)', () => {
  const src = readFileSync(join(process.cwd(), 'supabase/functions/send-recurring-push/index.ts'), 'utf8')
  const serveAt = src.indexOf('Deno.serve(')
  const moduleScope = src.slice(0, serveAt)
  const serve = src.slice(serveAt)
  const CALL = "checkCronApiKey(req.headers.get('apikey'), secretKeys)"
  const check = serve.indexOf(CALL)
  const client = serve.indexOf('createClient(')
  const gate = serve.slice(check, client)
  const authCode = code('supabase/functions/send-recurring-push/callerAuth.ts')
  const indexCode = code('supabase/functions/send-recurring-push/index.ts')

  it('checks the caller on the apikey header before creating the DB client or any query, and answers 401', () => {
    expect(serveAt).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(-1)
    expect(client).toBeGreaterThan(check)
    expect(serve.indexOf('.from(')).toBeGreaterThan(client)
    expect(serve.slice(0, check)).toMatch(/if \(req\.method !== 'POST'\) return new Response\('method not allowed', \{ status: 405 \}\)/)
    expect(gate).toMatch(/if \(!caller\.ok\) \{[\s\S]*?return new Response\('unauthorized', \{ status: 401 \}\)\s*\}/)
  })

  it('reads SUPABASE_SECRET_KEYS inside the request handler, never at module scope', () => {
    expect(moduleScope).not.toContain('SUPABASE_SECRET_KEYS')
    expect(serve.slice(0, check)).toContain("const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')")
  })

  it('builds the DB client from the default secret key, not SUPABASE_SERVICE_ROLE_KEY (F3)', () => {
    expect(gate).toContain("const dbKey = secretKeyNamed(secretKeys, 'default')")
    expect(serve).toContain('createClient(SUPABASE_URL, dbKey)')
    expect(indexCode).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(src.match(/createClient\(/g)).toHaveLength(1)
  })

  it('logs only the reason on reject, and nothing on accept', () => {
    const rejectBranch = gate.slice(0, gate.indexOf("return new Response('unauthorized'"))
    const logs = rejectBranch.match(/console\.\w+\([^\n]*\)/g) ?? []
    expect(logs).toEqual(['console.warn(`[auth] reject reason=${caller.reason}`)'])
    for (const l of logs) expect(l).not.toMatch(/apikey|secretKeys|token|header|bearer|authorization/i)
    expect(gate.indexOf('if (!caller.ok) {')).toBeLessThan(gate.indexOf('console.warn('))
  })

  it('callerAuth never reads Authorization, the env, or JWT claims; accepts only the key named cron', () => {
    expect(authCode).not.toMatch(/authorization|bearer/i)
    expect(authCode).not.toMatch(/Deno\.env|process\.env/)
    expect(authCode).not.toMatch(/service_role|atob|\.role\b|\bexp\b|decodeJwtSegment|checkServiceRoleJwt|projectRefFromUrl/)
    expect(authCode).not.toMatch(/'default'/)
    expect(authCode).toMatch(/export const CRON_KEY_NAME = 'cron'/)
    expect(authCode).toMatch(/secretKeyNamed\(secretKeysEnvJson, CRON_KEY_NAME\)/)
  })

  it('no file in the function still carries the withdrawn claim check', () => {
    for (const f of ['index.ts', 'callerAuth.ts']) {
      const c = code(`supabase/functions/send-recurring-push/${f}`)
      expect(c).not.toMatch(/checkServiceRoleJwt|decodeJwtSegment|projectRefFromUrl|PROJECT_REF|service_role/)
    }
  })
})

describe('verify_jwt is off for send-recurring-push (#1834)', () => {
  it('supabase/config.toml pins verify_jwt = false, once, in one section', () => {
    const toml = readFileSync(join(process.cwd(), 'supabase/config.toml'), 'utf8')
    const lines = toml.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean)
    const start = lines.indexOf('[functions.send-recurring-push]')
    expect(start).toBeGreaterThan(-1)
    const next = lines.findIndex((l, i) => i > start && l.startsWith('['))
    const section = lines.slice(start + 1, next === -1 ? undefined : next)
    expect(section.filter((l) => /^verify_jwt\s*=/.test(l))).toEqual(['verify_jwt = false'])
    // Only one section for this function (a later duplicate would override it).
    expect(lines.filter((l) => /^\[functions\.["']?send-recurring-push["']?\]$/.test(l))).toHaveLength(1)
  })
})
