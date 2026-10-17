import { createHash } from 'crypto'
import { generateToken } from '@/lib/invite'

/**
 * #1536 — personal shortcut keys (the bearer an iOS Shortcut sends to
 * POST /api/shortcut/pending).
 *
 * Format: `fts_sk_` + {@link generateToken} (32 random bytes as unpadded
 * base64url, always 43 characters). The prefix makes a leaked key
 * recognisable (log scrubbing, secret scanners) and keeps it from being
 * mistaken for an invite token.
 *
 * What the database keeps (`ShortcutKeys`, drizzle/0098): only
 * {@link hashShortcutKey} of the FULL key string, prefix included, and
 * {@link shortcutKeyHint} (the last 4 characters, for the settings page). The
 * plaintext key exists once, in the response that minted it.
 *
 * Failure look if the hashed string ever changes (e.g. someone hashes only
 * the 43-character body, or trims/lower-cases first): nothing errors; every
 * existing key just stops matching and every Shortcut gets 401.
 * `__tests__/shortcutKey.test.ts` pins the hash to fixed vectors.
 */
export const SHORTCUT_KEY_PREFIX = 'fts_sk_'

const SHORTCUT_KEY_RE = /^fts_sk_[A-Za-z0-9_-]{43}$/

export function generateShortcutKey(): string {
  return `${SHORTCUT_KEY_PREFIX}${generateToken()}`
}

/**
 * The exact shape {@link generateShortcutKey} returns. Checked before any
 * database lookup, so a truncated paste or a probe never reaches a query.
 */
export function isWellFormedShortcutKey(key: unknown): key is string {
  return typeof key === 'string' && SHORTCUT_KEY_RE.test(key)
}

/**
 * What `ShortcutKeys.key_hash` stores and is looked up by: lowercase hex
 * SHA-256 of the full key's UTF-8 bytes (`fts_sk_…`). Unkeyed on purpose, as
 * `hashToken` in lib/invite.ts: the key carries 256 random bits, so the hash
 * cannot be reversed by guessing. Equal to Postgres
 * `encode(sha256(convert_to(key, 'UTF8')), 'hex')`.
 */
export function hashShortcutKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** Last 4 characters of the key: what the settings page shows to tell keys apart. */
export function shortcutKeyHint(key: string): string {
  return key.slice(-4)
}
