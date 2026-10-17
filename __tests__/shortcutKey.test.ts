import { describe, it, expect } from 'vitest'
import {
  SHORTCUT_KEY_PREFIX, generateShortcutKey, hashShortcutKey, isWellFormedShortcutKey, shortcutKeyHint,
} from '@/lib/shortcutKey'

// ─── #1536 — personal shortcut keys: format, hash, hint ─────────────────────
//
// `ShortcutKeys.key_hash` (drizzle/0098) is looked up by hashShortcutKey(key).
// The hashed string is the FULL key, prefix included. If that ever changes
// (hashing only the body, trimming, lower-casing), nothing errors: every
// existing key stops matching and every Shortcut gets 401. The vectors below
// were computed by Postgres 17:
//   SELECT encode(sha256(convert_to('<key>', 'UTF8')), 'hex')
// ──────────────────────────────────────────────────────────────────────────────

const K1 = 'fts_sk_' + 'A'.repeat(43)
const K2 = 'fts_sk_' + '_'.repeat(42) + '8'

describe('hashShortcutKey (#1536)', () => {
  it('matches the Postgres sha256 vectors of the full key string', () => {
    expect(hashShortcutKey(K1)).toBe('571049494e1d0931f87e5367e15826e7581a14cc62e0dfc743b06873b1867c5f')
    expect(hashShortcutKey(K2)).toBe('256c7099c0c070fda39cf74d20e577821b0e6c6539b5aba4610f672bc47e1524')
  })

  it('hashes the prefix too (not just the 43-character body)', () => {
    // sha256('A' × 43), the body alone — must NOT be what a key hashes to.
    expect(hashShortcutKey(K1)).not.toBe('0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a')
  })

  it('is 64 lowercase hex characters and does not contain the key', () => {
    const k = generateShortcutKey()
    const h = hashShortcutKey(k)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain(k.slice(SHORTCUT_KEY_PREFIX.length))
  })
})

describe('generateShortcutKey (#1536)', () => {
  it('is fts_sk_ + 43 base64url characters (32 random bytes), and well-formed', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const k = generateShortcutKey()
      expect(k).toMatch(/^fts_sk_[A-Za-z0-9_-]{43}$/)
      expect(isWellFormedShortcutKey(k)).toBe(true)
      seen.add(k)
    }
    expect(seen.size).toBe(200)
  })
})

describe('isWellFormedShortcutKey (#1536)', () => {
  it.each([
    ['empty', ''],
    ['prefix only', 'fts_sk_'],
    ['body only (no prefix)', 'A'.repeat(43)],
    ['one short', 'fts_sk_' + 'A'.repeat(42)],
    ['one long', 'fts_sk_' + 'A'.repeat(44)],
    ['wrong prefix case', 'FTS_SK_' + 'A'.repeat(43)],
    ['other prefix', 'fts_pk_' + 'A'.repeat(43)],
    ['padded base64', 'fts_sk_' + 'A'.repeat(42) + '='],
    ['standard base64 alphabet', 'fts_sk_' + 'A'.repeat(41) + '+/'],
    ['leading space', ' fts_sk_' + 'A'.repeat(43)],
    ['trailing newline', 'fts_sk_' + 'A'.repeat(43) + '\n'],
    ['Bearer prefix left on', 'Bearer fts_sk_' + 'A'.repeat(43)],
    ['percent-encoded', 'fts_sk_' + 'A'.repeat(40) + '%2F'],
    ['non-ASCII', 'fts_sk_' + 'A'.repeat(42) + 'é'],
  ])('rejects %s', (_label, value) => {
    expect(isWellFormedShortcutKey(value)).toBe(false)
  })

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 42, {}, ['fts_sk_' + 'A'.repeat(43)]]) {
      expect(isWellFormedShortcutKey(v)).toBe(false)
    }
  })
})

describe('shortcutKeyHint (#1536)', () => {
  it('is the last 4 characters', () => {
    expect(shortcutKeyHint(K2)).toBe('___8')
    expect(shortcutKeyHint('fts_sk_' + 'A'.repeat(39) + 'wxyz')).toBe('wxyz')
  })
})
