'use server'

import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { shortcutKeys } from '@/lib/db/schema'
import { requireViewer } from '@/lib/auth/viewer'
import { lockProfileRow } from '@/lib/db/queries/epoch'
import { action } from '@/lib/action-errors'
import { generateShortcutKey as mintShortcutKey, hashShortcutKey, shortcutKeyHint } from '@/lib/shortcutKey'

// ─── #1536 — personal shortcut keys: generate / regenerate / revoke ────────
//
// The plaintext key exists in exactly one place: the return value of
// `generateShortcutKey` below, i.e. the body of that one server-action POST
// (Next sends it `Cache-Control: no-store`, the service worker never caches a
// POST). The database keeps only the SHA-256 and the last 4 characters. The
// settings page reads `getActiveShortcutKeySummary` (hint + times), never this.
//
// Rules for this file, each with what breaking it looks like:
//   - Owner-scoped by the re-validated viewer id; no action takes an id. A
//     parameter here would let anyone revoke or replace someone else's key.
//   - Never pass the key, its hint or its hash to captureServer, Sentry, or
//     console. Nothing would error; the key would just sit in a third party.
//   - Do not call revalidatePath here: a revalidating action response carries
//     the re-rendered page tree in the same POST. Harmless today (the page has
//     no key in it), but the client refreshes instead, so the generate
//     response stays exactly `{ key, hint, createdAt }`.
//
// Concurrency: both actions first take the viewer's `Profiles` row FOR NO KEY
// UPDATE (lockProfileRow; also refuses a deleted account), so two generates by
// the same person (two tabs, a double tap) run one after the other: the second
// revokes the first's key and inserts its own. Without the lock the second
// insert would hit `ShortcutKeys_one_active_per_user` and surface as an
// unexpected 23505. Lock order: profile row, then only this user's
// ShortcutKeys rows. The S3 endpoint locks a key row; it must not then wait on
// the Profiles row, or it would close a cycle with these.
// ──────────────────────────────────────────────────────────────────────────────

export interface GeneratedShortcutKey {
  /** The plaintext `fts_sk_…` key. Shown once, from client state only. */
  key: string
  hint: string
  createdAt: string
}

/**
 * Revoke the viewer's active key (if any) and mint a new one, in one
 * transaction. Returns the plaintext key — the only time it is ever sent.
 */
export const generateShortcutKey = action(async (): Promise<GeneratedShortcutKey> => {
  const { user } = await requireViewer()
  const key = mintShortcutKey()
  const hint = shortcutKeyHint(key)

  const createdAt = await db.transaction(async (tx) => {
    await lockProfileRow(tx, user.id)
    await tx
      .update(shortcutKeys)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(shortcutKeys.userId, user.id), isNull(shortcutKeys.revokedAt)))
    const [row] = await tx
      .insert(shortcutKeys)
      .values({ userId: user.id, keyHash: hashShortcutKey(key), keyHint: hint })
      .returning({ createdAt: shortcutKeys.createdAt })
    return row.createdAt
  })

  return { key, hint, createdAt: createdAt.toISOString() }
})

/** Revoke the viewer's active key. `revoked: false` when there was none. */
export const revokeShortcutKey = action(async (): Promise<{ revoked: boolean }> => {
  const { user } = await requireViewer()

  const revoked = await db.transaction(async (tx) => {
    await lockProfileRow(tx, user.id)
    const rows = await tx
      .update(shortcutKeys)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(shortcutKeys.userId, user.id), isNull(shortcutKeys.revokedAt)))
      .returning({ id: shortcutKeys.id })
    return rows.length > 0
  })

  return { revoked }
})
