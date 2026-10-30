// @vitest-environment node
/**
 * #968 S4b — Android FCM sending in send-recurring-push.
 *
 * The Deno entrypoint cannot run under vitest, so the parts that decide
 * anything were extracted into pure modules and are tested here: the request
 * shape (fcm.ts), the PEM handling (pem.ts), and the stale-token delete rule
 * plus what a failure may log (staleTokens.ts). The wiring in index.ts is
 * asserted on its source, like push-member-tokens-1605.test.ts does.
 *
 * The scenario the delete rule guards (security-review F4): one bad payload
 * deploy makes every FCM send return 400 INVALID_ARGUMENT. Failure looks like:
 * every Android token is deleted that night and Android users silently stop
 * getting the push, with no error on any later night.
 *
 * No private-key armour, JSON key name or service-account marker is written
 * literally in this file (the repo's secret guard would flag it); keys are
 * generated at runtime and the guard patterns are assembled from pieces.
 */
import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { normalizePemNewlines, pkcs8DerFromPem } from '../supabase/functions/send-recurring-push/pem.ts'
import {
  ASSERTION_TTL_SECONDS,
  FCM_SCOPE,
  FCM_SEND_URL,
  GOOGLE_TOKEN_URI,
  JWT_BEARER_GRANT,
  accessTokenFrom,
  fcmAssertionClaims,
  fcmAssertionHeader,
  fcmMessage,
  importFcmSigningKey,
  oauthTokenRequestBody,
  readFcmConfig,
} from '../supabase/functions/send-recurring-push/fcm.ts'
import {
  apnsFailureLog,
  classifyFcmResponse,
  decideFcmDeletes,
  fcmFailureLog,
  isStaleApnsStatus,
  oauthFailureLog,
  safeCode,
  type FcmSendResult,
} from '../supabase/functions/send-recurring-push/staleTokens.ts'

const FN_DIR = join(process.cwd(), 'supabase/functions/send-recurring-push')

// ─── FCM error bodies, shaped like FCM HTTP v1 responses ─────────────────────
const FCM_ERROR_TYPE = 'type.googleapis.com/google.firebase.fcm.v1.FcmError'
const BAD_REQUEST_TYPE = 'type.googleapis.com/google.rpc.BadRequest'

function fcmError(code: number, status: string, errorCode?: string, field?: string, message = 'free text') {
  const details: unknown[] = []
  if (errorCode) details.push({ '@type': FCM_ERROR_TYPE, errorCode })
  if (field) details.push({ '@type': BAD_REQUEST_TYPE, fieldViolations: [{ field, description: message }] })
  return { error: { code, message, status, details } }
}

const UNREGISTERED_404 = fcmError(404, 'NOT_FOUND', 'UNREGISTERED', undefined, 'Requested entity was not found.')
const TOKEN_400 = fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'message.token', 'The registration token is not a valid FCM registration token')
const PAYLOAD_400 = fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'message.notification.title', 'Invalid value')
const BARE_400 = fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT')

describe('stale FCM token decision (classifyFcmResponse)', () => {
  it('2xx is ok', () => {
    expect(classifyFcmResponse(200, null)).toBe('ok')
  })

  it('404 UNREGISTERED → delete', () => {
    expect(classifyFcmResponse(404, UNREGISTERED_404)).toBe('unregistered')
  })

  it('404 without UNREGISTERED (e.g. a wrong project path) → keep', () => {
    expect(classifyFcmResponse(404, fcmError(404, 'NOT_FOUND'))).toBe('keep')
    expect(classifyFcmResponse(404, null)).toBe('keep')
  })

  it('400 INVALID_ARGUMENT that names message.token → delete', () => {
    expect(classifyFcmResponse(400, TOKEN_400)).toBe('invalid-token')
  })

  it('400 INVALID_ARGUMENT about the payload → keep', () => {
    expect(classifyFcmResponse(400, PAYLOAD_400)).toBe('bad-request')
    expect(classifyFcmResponse(400, BARE_400)).toBe('bad-request')
    expect(classifyFcmResponse(400, null)).toBe('bad-request')
  })

  it('400 naming message.token but without INVALID_ARGUMENT → keep', () => {
    expect(classifyFcmResponse(400, fcmError(400, 'INVALID_ARGUMENT', undefined, 'message.token'))).toBe('bad-request')
  })

  it('does not key on the free-text message', () => {
    const msgOnly = { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'message.token is not a valid registration token', details: [{ errorCode: 'INVALID_ARGUMENT' }] } }
    expect(classifyFcmResponse(400, msgOnly)).toBe('bad-request')
  })

  it.each([401, 403, 429, 500, 503])('%i → keep, even with a token-looking body', (status) => {
    expect(classifyFcmResponse(status, UNREGISTERED_404)).toBe('keep')
    expect(classifyFcmResponse(status, TOKEN_400)).toBe('keep')
  })

  it('network error / timeout → keep', () => {
    expect(classifyFcmResponse(null, null)).toBe('keep')
  })
})

describe('stale FCM token decision (decideFcmDeletes, with breaker)', () => {
  const r = (id: string, httpStatus: number | null, body: unknown = null): FcmSendResult => ({ ids: [id], httpStatus, body })

  it('deletes UNREGISTERED and token-specific 400 rows by id; keeps the rest', () => {
    const d = decideFcmDeletes([
      r('ok1', 200), r('ok2', 200), r('ok3', 200),
      r('gone', 404, UNREGISTERED_404),
      r('bad-token', 400, TOKEN_400),
      r('auth', 401), r('perm', 403), r('quota', 429), r('server', 500),
      r('net', null),
    ])
    expect(d.breakerTripped).toBe(false)
    expect(d.deleteIds.sort()).toEqual(['bad-token', 'gone'])
  })

  it('a device shared by both members deletes both row ids', () => {
    const d = decideFcmDeletes([{ ids: ['a', 'c'], httpStatus: 404, body: UNREGISTERED_404 }, r('ok', 200)])
    expect(d.deleteIds.sort()).toEqual(['a', 'c'])
  })

  it('breaker: more than half the responses are 400 → delete nothing at all', () => {
    // A broken payload: every send 400. Token-specific bodies or not, nothing goes.
    const d = decideFcmDeletes([
      r('t1', 400, TOKEN_400), r('t2', 400, TOKEN_400), r('t3', 400, PAYLOAD_400),
      r('gone', 404, UNREGISTERED_404),
    ])
    expect(d.breakerTripped).toBe(true)
    expect(d.badRequests).toBe(3)
    expect(d.responded).toBe(4)
    expect(d.deleteIds).toEqual([])
  })

  it('breaker: exactly half is not more than half', () => {
    const d = decideFcmDeletes([r('t1', 400, TOKEN_400), r('ok', 200)])
    expect(d.breakerTripped).toBe(false)
    expect(d.deleteIds).toEqual(['t1'])
  })

  it('breaker counts only sends that got a response (network errors are not in the denominator)', () => {
    const d = decideFcmDeletes([r('t1', 400, TOKEN_400), r('n1', null), r('n2', null), r('n3', null)])
    expect(d.responded).toBe(1)
    expect(d.breakerTripped).toBe(true)
    expect(d.deleteIds).toEqual([])
  })

  it('no responses at all → nothing to delete, breaker not tripped', () => {
    expect(decideFcmDeletes([r('n1', null)])).toEqual({ deleteIds: [], breakerTripped: false, badRequests: 0, responded: 0 })
  })
})

describe('APNs stale rule is unchanged', () => {
  it('410 deletes; nothing else does', () => {
    expect(isStaleApnsStatus(410)).toBe(true)
    for (const s of [200, 400, 403, 404, 429, 500]) expect(isStaleApnsStatus(s)).toBe(false)
  })
})

describe('failure logs carry codes only', () => {
  const token = 'abcdefgh' + 'SECRET-REST-OF-TOKEN'

  it('FCM: status, error.status, errorCode, 8-char prefix — never the message or the full token', () => {
    const body = fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'message.token', `bad token ${token}`)
    const line = fcmFailureLog(token, 400, body)
    expect(line).toBe('[fcm] failed token=abcdefgh… status=400 error.status=INVALID_ARGUMENT errorCode=INVALID_ARGUMENT')
    expect(line).not.toContain('SECRET')
  })

  it('FCM: network error logs status=network only', () => {
    expect(fcmFailureLog(token, null, null)).toBe('[fcm] failed token=abcdefgh… status=network')
  })

  it('codes from a response body that are not short identifiers become `other`', () => {
    expect(safeCode('UNREGISTERED')).toBe('UNREGISTERED')
    expect(safeCode('has space')).toBe('other')
    expect(safeCode('x'.repeat(65))).toBe('other')
    expect(safeCode('line\nbreak')).toBe('other')
    expect(safeCode(42)).toBe('other')
    expect(safeCode(undefined)).toBe('none')
  })

  it('APNs: status + reason + prefix, not the raw body', () => {
    expect(apnsFailureLog(token, 410, '{"reason":"Unregistered","timestamp":1}')).toBe(
      '[apns] failed token=abcdefgh… status=410 reason=Unregistered',
    )
    expect(apnsFailureLog(token, 500, '<html>oops</html>')).toBe('[apns] failed token=abcdefgh… status=500 reason=none')
  })

  it('OAuth: only the `error` field, never error_description', () => {
    const line = oauthFailureLog(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature for sa@x' })
    expect(line).toBe('[fcm] oauth failed status=400 error=invalid_grant')
  })
})

describe('FCM request building', () => {
  it('sends to the oikos-pj HTTP v1 endpoint and exchanges at the Google token URI', () => {
    expect(FCM_SEND_URL).toBe('https://fcm.googleapis.com/v1/projects/oikos-pj/messages:send')
    expect(GOOGLE_TOKEN_URI).toBe('https://oauth2.googleapis.com/token')
  })

  it('assertion header and claims: RS256 + kid, scope firebase.messaging, one hour', () => {
    expect(fcmAssertionHeader('kid-123')).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-123' })
    expect(fcmAssertionClaims('sender@example.iam.gserviceaccount.com', 1_000)).toEqual({
      iss: 'sender@example.iam.gserviceaccount.com',
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URI,
      iat: 1_000,
      exp: 1_000 + ASSERTION_TTL_SECONDS,
    })
    expect(FCM_SCOPE).toBe('https://www.googleapis.com/auth/firebase.messaging')
    expect(ASSERTION_TTL_SECONDS).toBe(3600)
  })

  it('token exchange is the JWT-bearer grant as a form body', () => {
    const body = oauthTokenRequestBody('signed.jwt.here')
    expect(body.get('grant_type')).toBe(JWT_BEARER_GRANT)
    expect(JWT_BEARER_GRANT).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(body.get('assertion')).toBe('signed.jwt.here')
  })

  it('requires access_token to be a non-empty string', () => {
    expect(accessTokenFrom({ access_token: 'ya29.x', expires_in: 3599 })).toBe('ya29.x')
    expect(accessTokenFrom({ access_token: '' })).toBeNull()
    expect(accessTokenFrom({ access_token: 42 })).toBeNull()
    expect(accessTokenFrom({})).toBeNull()
    expect(accessTokenFrom(null)).toBeNull()
  })

  it('message is token + fixed notification, no data payload', () => {
    expect(fcmMessage('tok', 'T', 'B')).toEqual({ message: { token: 'tok', notification: { title: 'T', body: 'B' } } })
  })

  it('reads the three split secrets; any missing or blank → null', () => {
    const env: Record<string, string> = {
      FCM_CLIENT_EMAIL: 'sender@example.iam.gserviceaccount.com',
      FCM_PRIVATE_KEY_PEM: 'pem',
      FCM_PRIVATE_KEY_ID: 'kid',
    }
    expect(readFcmConfig((n) => env[n])).toEqual({
      clientEmail: env.FCM_CLIENT_EMAIL,
      privateKeyPem: 'pem',
      privateKeyId: 'kid',
    })
    for (const name of Object.keys(env)) {
      expect(readFcmConfig((n) => (n === name ? undefined : env[n]))).toBeNull()
      expect(readFcmConfig((n) => (n === name ? '  ' : env[n]))).toBeNull()
    }
  })
})

describe('PEM handling', () => {
  it('turns JSON-escaped \\n back into newlines and leaves real newlines alone', () => {
    expect(normalizePemNewlines('a\\nb\\nc')).toBe('a\nb\nc')
    expect(normalizePemNewlines('a\nb')).toBe('a\nb')
  })

  it('imports a JSON-escaped RSA key as non-extractable RS256 sign-only, and it signs', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const escaped = privateKey.replace(/\n/g, '\\n') // as pasted from the downloaded JSON
    const key = await importFcmSigningKey(escaped)
    expect(key.extractable).toBe(false)
    expect(key.usages).toEqual(['sign'])
    expect(key.algorithm).toMatchObject({ name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } })

    const data = new TextEncoder().encode('header.payload')
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data))
    const verify = createVerify('RSA-SHA256')
    verify.update(data)
    expect(verify.verify(publicKey, sig)).toBe(true)
  })

  it('still imports the APNs-style P-256 key through the same helper', async () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8DerFromPem(privateKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    expect(key.type).toBe('private')
  })
})

describe('send-recurring-push wiring (#968 S4b)', () => {
  const src = readFileSync(join(FN_DIR, 'index.ts'), 'utf8')

  it('pins supabase-js to an exact version', () => {
    expect(src).toContain("from 'https://esm.sh/@supabase/supabase-js@2.105.1'")
    expect(src).not.toMatch(/supabase-js@2'/)
  })

  it('times out the OAuth exchange and each FCM send', () => {
    expect(src.match(/signal: AbortSignal\.timeout\(FCM_FETCH_TIMEOUT_MS\)/g)).toHaveLength(2)
  })

  it('deletes stale rows by id and platform, never by token string alone', () => {
    expect(src).not.toMatch(/\.in\(\s*'token'/)
    expect(src).toMatch(/\.delete\(\)\s*\.eq\('platform', platform\)\s*\.in\('id', ids\)/)
  })

  it('runs each platform branch isolated from the other', () => {
    expect(src).toContain("isolated('apns', () =>")
    expect(src).toContain("isolated('fcm', () =>")
  })

  it('never logs the access token, the assertion or an authorization header', () => {
    const logLines = src.split('\n').filter((l) => /console\.(error|log|warn|info)/.test(l))
    for (const l of logLines) {
      expect(l).not.toMatch(/accessToken|assertion|authorization|\.message/i)
    }
  })
})

describe('no private-key material written literally (secret guard compatibility)', () => {
  // Assembled from pieces so this file does not contain what it looks for.
  const patterns = [
    new RegExp('-----BEGIN (RSA )?' + 'PRIV' + 'ATE KEY-----'),
    new RegExp('"priv' + 'ate_key"\\s*:'),
    new RegExp('"type"\\s*:\\s*"service_' + 'account"'),
  ]

  it.each(readdirSync(FN_DIR))('%s', (file) => {
    const text = readFileSync(join(FN_DIR, file), 'utf8')
    for (const p of patterns) expect(text).not.toMatch(p)
  })
})
