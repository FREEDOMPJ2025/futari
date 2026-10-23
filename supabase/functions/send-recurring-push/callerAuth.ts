/**
 * Who may trigger send-recurring-push (#968 S4b, security-review F8).
 *
 * The only legitimate caller is the `notify-recurring-push` pg_cron job
 * (drizzle/0056), which sends `Authorization: Bearer <Vault
 * oikos_service_role_key>`. The Supabase gateway's JWT check alone accepts the
 * public anon key too, so anyone holding the app's anon key could make every
 * household's phones buzz on demand (and, with FCM, burn the sender's quota).
 * This check requires the bearer to be exactly the function's own
 * SUPABASE_SERVICE_ROLE_KEY.
 *
 * Failure looks like: the cron still fires at 16:10 UTC and `net._http_response`
 * shows status_code 401 instead of 200 — no push goes out, nothing else errors.
 * That happens if the Vault secret and the function's SUPABASE_SERVICE_ROLE_KEY
 * ever stop being the same string (e.g. one of them rotated alone). The
 * post-deploy check in ops-runbook.md catches it.
 *
 * Pure (no Deno APIs) so vitest can run it: tests/push-caller-auth-968.test.ts.
 */

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

/**
 * Constant-time equality of two strings: both sides are hashed to 32 bytes
 * first, so neither the length nor the position of the first differing
 * character changes how long the comparison takes.
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i]
  return diff === 0
}

/**
 * True only when `authorization` is `Bearer <serviceRoleKey>` exactly.
 * Fails closed when the key is missing or empty (a misconfigured function
 * must not accept `Bearer ` with an empty value).
 */
export async function isServiceRoleCaller(
  authorization: string | null | undefined,
  serviceRoleKey: string | null | undefined,
): Promise<boolean> {
  if (!serviceRoleKey) return false
  if (!authorization) return false
  const m = /^Bearer (.+)$/.exec(authorization)
  if (!m) return false
  return timingSafeEqualStrings(m[1], serviceRoleKey)
}
