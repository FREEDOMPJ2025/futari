import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { shortcutKeys } from '@/lib/db/schema'

/**
 * #1536 — what the shortcut-key settings page may know about the viewer's key.
 *
 * Deliberately no `id`, no `keyHash` and (it cannot exist here) no plaintext:
 * this object becomes Server Component props, i.e. part of the page's RSC
 * payload and HTML, which the browser, the router cache and any proxy can keep.
 * The plaintext key only ever travels in the response of the generate action.
 * Failure look if a field is added here carelessly: nothing errors; the hash
 * (or worse) just sits in every render of /settings/shortcut-key.
 */
export interface ShortcutKeySummary {
  /** Last 4 characters of the key (`ShortcutKeys.key_hint`). */
  hint: string
  createdAt: Date
  lastUsedAt: Date | null
}

/** The viewer's unrevoked key, or null. Owner-scoped by `userId` only. */
export async function getActiveShortcutKeySummary(userId: string): Promise<ShortcutKeySummary | null> {
  const [row] = await db
    .select({
      hint: shortcutKeys.keyHint,
      createdAt: shortcutKeys.createdAt,
      lastUsedAt: shortcutKeys.lastUsedAt,
    })
    .from(shortcutKeys)
    .where(and(eq(shortcutKeys.userId, userId), isNull(shortcutKeys.revokedAt)))
    .limit(1)
  return row ?? null
}
