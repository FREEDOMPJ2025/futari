/**
 * Who may trigger send-recurring-push (#968 S4b, security-review F8).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ SOUND ONLY WITH verify_jwt = true (supabase/config.toml).                │
 * │ The Supabase gateway verifies the JWT *signature*; this file only reads  │
 * │ the *claims*. It never checks a signature. If verify_jwt is ever turned  │
 * │ off for this function (`--no-verify-jwt`, the dashboard toggle, or the   │
 * │ config entry), anyone can write a token with these claims and pass.      │
 * │ The future move to `apikey` + `sb_secret_…` must REPLACE this check,     │
 * │ not be added beside it.                                                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The only legitimate caller is the `notify-recurring-push` pg_cron job
 * (drizzle/0056). It sends `Authorization: Bearer <Vault
 * oikos_service_role_key>`, which is the project's legacy service_role JWT
 * (HS256; claims role=service_role, ref=<project ref>, iss=supabase). The
 * gateway's JWT check alone also lets the public anon key through, and passes
 * new-style `sb_publishable_…` / `sb_secret_…` keys sent as a bearer; without
 * this check anyone holding the app's public key could make every household's
 * phones buzz on demand (and, with FCM, burn the sender's quota).
 *
 * So, after the gateway has verified the signature, the caller is accepted
 * only when the bearer is a three-part JWT whose payload says
 * role=service_role, ref=<this project's ref> and an exp still in the future.
 *   - role: the anon key and user session tokens are signed by the same
 *     project, so the signature alone does not tell them apart.
 *   - ref: config sanity — the token was issued for the project this function
 *     runs in. It is NOT forgery protection; the gateway signature is.
 *   - exp: an issued token past its expiry is refused even if the gateway
 *     were to let it through.
 *
 * Withdrawn (2026-10-23): this file used to require the bearer to equal the
 * function's own SUPABASE_SERVICE_ROLE_KEY byte for byte (hashed, constant-time
 * compare). A dev deploy showed the hosted runtime sets SUPABASE_SERVICE_ROLE_KEY
 * to a new-style 41-character `sb_` secret key, while the cron sends the legacy
 * service_role JWT — the two never match, so the real caller got 401.
 * Failure looked like: the cron fires at 16:10 UTC, `net._http_response` shows
 * 401 instead of 200, no push goes out, nothing else errors. Do not reintroduce
 * an exact-match path against SUPABASE_SERVICE_ROLE_KEY. See ops-runbook.md
 * 「呼叫者驗證」.
 *
 * Pure (no Deno APIs) so vitest can run it: tests/push-caller-auth-968.test.ts.
 */

export type CallerRejectReason =
  | 'no_ref_config'
  | 'no_header'
  | 'not_bearer'
  | 'not_jwt'
  | 'bad_payload'
  | 'role'
  | 'ref'
  | 'expired'

export type CallerCheck = { ok: true } | { ok: false; reason: CallerRejectReason }

/** Longest Authorization header looked at; anything longer is refused unparsed. */
export const MAX_AUTHORIZATION_LENGTH = 4096

const PROJECT_URL = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/

// The whole header: exactly one `Bearer `, one space, three non-empty
// base64url segments, nothing before or after. Rejects `Bearer sb_…`, two
// joined headers ("a, Bearer b"), extra whitespace, `=` padding and `+`/`/`.
const BEARER_JWT = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/

/**
 * The project ref from the function's SUPABASE_URL
 * (`https://<20-char ref>.supabase.co`), or null for anything else — a custom
 * domain, http, a path. Null makes every call fail closed (`no_ref_config`).
 */
export function projectRefFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const m = PROJECT_URL.exec(url)
  return m ? m[1] : null
}

/**
 * Decodes one base64url JWT segment to a plain JSON object, or null when it is
 * not valid base64url, not valid UTF-8, not JSON, or not a plain object.
 */
export function decodeJwtSegment(segment: string): Record<string, unknown> | null {
  try {
    let b64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    if (b64.length % 4 !== 0) b64 += '='.repeat(4 - (b64.length % 4))
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Claim check for the cron's legacy service_role JWT. See the box at the top:
 * this assumes the gateway (verify_jwt = true) has already verified the
 * signature. `nowSec` is Unix seconds.
 *
 * The reason is safe to log; nothing from the header itself ever is.
 */
export function checkServiceRoleJwt(
  authorization: string | null | undefined,
  ref: string | null | undefined,
  nowSec: number,
): CallerCheck {
  if (!ref) return { ok: false, reason: 'no_ref_config' }
  if (!authorization) return { ok: false, reason: 'no_header' }
  if (authorization.length > MAX_AUTHORIZATION_LENGTH || !authorization.startsWith('Bearer ')) {
    return { ok: false, reason: 'not_bearer' }
  }
  const m = BEARER_JWT.exec(authorization)
  if (!m) return { ok: false, reason: 'not_jwt' }

  const [headerSeg, payloadSeg] = m[1].split('.')
  const header = decodeJwtSegment(headerSeg)
  const payload = decodeJwtSegment(payloadSeg)
  if (!header || !payload) return { ok: false, reason: 'bad_payload' }
  if (typeof header.alg !== 'string' || header.alg.toLowerCase() === 'none') {
    return { ok: false, reason: 'not_jwt' }
  }

  if (payload.role !== 'service_role') return { ok: false, reason: 'role' }
  if (payload.ref !== ref) return { ok: false, reason: 'ref' }
  if (typeof payload.exp !== 'number' || !(payload.exp > nowSec)) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true }
}
