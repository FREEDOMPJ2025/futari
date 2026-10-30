/**
 * Who may trigger send-recurring-push (#1834; replaces the #968 S4b claim check).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE ONLY BARRIER. supabase/config.toml sets verify_jwt = false,  │
 * │ so the Supabase gateway lets every request through to the function.     │
 * │ Anything that makes checkCronApiKey accept more — a fallback path, a     │
 * │ second accepted key name, reading the Authorization header, treating a   │
 * │ missing config as "allow" — lets anyone on the internet make every       │
 * │ household's phones buzz on demand (and burn the FCM sender's quota).     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The only legitimate caller is the `notify-recurring-push` pg_cron job
 * (drizzle/0100). It sends `apikey: <Vault oikos_cron_secret_key>`, the
 * project's named secret key `cron` (`sb_secret_…`, created in the dashboard).
 * The hosted runtime injects every secret key of the project as
 * SUPABASE_SECRET_KEYS, a JSON object keyed by key name; the function accepts
 * the caller only when the `apikey` header equals the entry named `cron`.
 *
 *   - Only `cron`. Never `default` (that one builds the DB client, and other
 *     tools may hold it), never "any key in the object".
 *   - Never the Authorization header. During the transition the cron also sends
 *     `Authorization: Bearer <legacy service_role JWT>`; it is ignored here.
 *   - Fail closed: SUPABASE_SECRET_KEYS missing, not JSON, not an object, or its
 *     `cron` entry missing / not `sb_secret_…` → every call is refused
 *     (`no_key_config`). Parsed per request, never at module scope.
 *   - Constant-time comparison of equal-length strings; a length difference is
 *     answered at once (the length of the key is not the secret).
 *
 * Why verify_jwt is off: secret keys are not JWTs, so the gateway cannot verify
 * them; Supabase's docs say to set verify_jwt = false for a function called with
 * a secret key and to authorize the key in code
 * (https://supabase.com/docs/guides/api/api-keys).
 *
 * Withdrawn (2026-10-25, #1834): this file used to say it was "SOUND ONLY WITH
 * verify_jwt = true" and checked the legacy service_role JWT's claims
 * (role / ref / exp) behind the gateway's signature check. Supabase retires the
 * legacy JWT keys by the end of 2026; from that day the gateway would refuse the
 * cron's JWT. Failure would have looked like: the cron fires at 16:10 UTC,
 * `net._http_response` shows 401, the function logs no `[auth]` line, no push
 * goes out, nothing else errors. The claim check and its JWT decoding are gone
 * entirely — do not add them back beside this check: with verify_jwt = false a
 * claim check verifies nothing (anyone can write the claims).
 *
 * Withdrawn earlier (2026-10-23, #968): an exact match of the bearer against
 * SUPABASE_SERVICE_ROLE_KEY. See ops-runbook.md「呼叫者驗證」.
 *
 * The reason is safe to log; nothing from the header or the env ever is.
 * Pure (no Deno APIs) so vitest can run it: tests/push-caller-auth-968.test.ts.
 */

export type CallerRejectReason = 'no_key_config' | 'no_apikey' | 'mismatch'

export type CallerCheck = { ok: true } | { ok: false; reason: CallerRejectReason }

/** The one key name this function accepts. */
export const CRON_KEY_NAME = 'cron'

/** Longest apikey header (and configured key) looked at; anything longer is refused unread. */
export const MAX_APIKEY_LENGTH = 512

const SECRET_KEY_PREFIX = 'sb_secret_'

/**
 * The secret key named `name` from SUPABASE_SECRET_KEYS (a JSON object keyed by
 * key name), or null when the env is missing, is not JSON, is not a plain
 * object, has no own entry `name`, or that entry is not an `sb_secret_…` string
 * of sane length. Null means "fail closed" to every caller.
 */
export function secretKeyNamed(
  secretKeysEnvJson: string | null | undefined,
  name: string,
): string | null {
  if (!secretKeysEnvJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(secretKeysEnvJson)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  if (!Object.prototype.hasOwnProperty.call(parsed, name)) return null
  const value: unknown = (parsed as Record<string, unknown>)[name]
  if (typeof value !== 'string') return null
  if (!value.startsWith(SECRET_KEY_PREFIX) || value.length <= SECRET_KEY_PREFIX.length) return null
  if (value.length > MAX_APIKEY_LENGTH) return null
  return value
}

/** Equal-length strings compared without an early exit. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Accepts the caller only when `apikeyHeader` equals the project's secret key
 * named `cron`. `secretKeysEnvJson` is SUPABASE_SECRET_KEYS as the runtime
 * gives it. See the box at the top: this is the only check in front of the
 * function.
 */
export function checkCronApiKey(
  apikeyHeader: string | null | undefined,
  secretKeysEnvJson: string | null | undefined,
): CallerCheck {
  const expected = secretKeyNamed(secretKeysEnvJson, CRON_KEY_NAME)
  if (!expected) return { ok: false, reason: 'no_key_config' }
  if (!apikeyHeader || apikeyHeader === 'undefined') return { ok: false, reason: 'no_apikey' }
  if (apikeyHeader.length > MAX_APIKEY_LENGTH) return { ok: false, reason: 'mismatch' }
  if (!constantTimeEqual(apikeyHeader, expected)) return { ok: false, reason: 'mismatch' }
  return { ok: true }
}
