/**
 * What a `PushTokens.token` may look like, per platform, and how many rows one
 * person may hold (#1827).
 *
 * This is the one place the numbers live. `drizzle/0101_push_token_format_cap.sql`
 * writes them into a CHECK constraint and a trigger; tests/push-token-format-1827.test.ts
 * rebuilds the SQL predicate from this file and fails when the migration says
 * anything else, and fails when a platform's `maxLength` is above the sign-out
 * limit in `actions/auth.ts` (`MAX_PUSH_TOKEN_LENGTH`).
 *
 * Why the sign-out limit matters: signOut(token) only deletes this device's row
 * when the token is at most MAX_PUSH_TOKEN_LENGTH characters. A token the
 * database accepts but sign-out refuses to look at can never be removed by
 * signing out. Failure looks like: no error anywhere; a shared phone keeps
 * getting the signed-out person's 「有待確認的定期收支」 push.
 *
 * - APNs: hex, either case (Capacitor's iOS plugin emits UPPERCASE `%02X`; prod
 *   had 41 rows, all 64-char uppercase hex, 2026-10-25). Even length, because
 *   a device token is bytes written as hex. 64 today; up to 512 leaves room for
 *   Apple lengthening it without accepting arbitrary payloads.
 * - FCM: Firebase does not document the registration-token format. Real ones
 *   are about 160–200 characters of `[A-Za-z0-9_:-]`; the lower bound 20 only
 *   rejects obvious junk. The upper bound is 512 — the sign-out limit on main
 *   today — not 4096: #1831 (Android FCM registration) raises sign-out to 4096,
 *   and only after that may this bound go up (the guard test allows it then).
 *   Not to 4096, though: the unique btree index push_tokens_unique refuses an
 *   index row above 2704 bytes, so a token much past ~2.6k characters fails on
 *   insert with 54000 whatever the CHECK says (measured on Postgres 17,
 *   2026-10-26). The guard keeps every max at or below 2048.
 *
 * PostgreSQL regular expressions cap `{m,n}` bounds at 255, so the lengths are
 * separate `char_length` predicates, not part of the pattern.
 */

export type PushTokenPlatform = 'apns' | 'fcm'

export interface PushTokenFormat {
  /** Anchored character-class pattern, identical in SQL and JavaScript. */
  charset: string
  minLength: number
  maxLength: number
  evenLength: boolean
}

export const PUSH_TOKEN_FORMAT: Readonly<Record<PushTokenPlatform, PushTokenFormat>> = {
  apns: { charset: '^[0-9A-Fa-f]+$', minLength: 64, maxLength: 512, evenLength: true },
  fcm: { charset: '^[A-Za-z0-9_:-]+$', minLength: 20, maxLength: 512, evenLength: false },
}

/**
 * Rows one user_id may hold. 0101's AFTER INSERT trigger evicts the least
 * recently registered rows (by updated_at) beyond this. Prod's largest was 2
 * (2026-10-25).
 */
export const PUSH_TOKENS_PER_USER = 10

/** The SQL predicate for one platform, exactly as 0101 writes it. */
export function pushTokenFormatSql(platform: PushTokenPlatform): string {
  const f = PUSH_TOKEN_FORMAT[platform]
  const parts = [
    `platform = '${platform}'`,
    `token ~ '${f.charset}'`,
    `char_length(token) BETWEEN ${f.minLength} AND ${f.maxLength}`,
  ]
  if (f.evenLength) parts.push('char_length(token) % 2 = 0')
  return `(${parts.join(' AND ')})`
}

/** The same rule in JavaScript (the tests cross-check it against Postgres). */
export function isWellFormedPushToken(platform: string, token: string): boolean {
  if (platform !== 'apns' && platform !== 'fcm') return false
  const f = PUSH_TOKEN_FORMAT[platform]
  if (token.length < f.minLength || token.length > f.maxLength) return false
  if (f.evenLength && token.length % 2 !== 0) return false
  return new RegExp(f.charset).test(token)
}
