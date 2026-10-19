import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { shortcutPendingExpenses } from '@/lib/db/schema'
import { taipeiDayOf } from '@/lib/monthKey'

/** Days an unconfirmed shortcut card stays on the dashboard (and confirmable). */
export const SHORTCUT_PENDING_TTL_DAYS = 30

/** At most this many cards reach the dashboard; the rest wait behind them. */
export const SHORTCUT_PENDING_DASHBOARD_LIMIT = 20

/**
 * The `WHERE` that makes a card the viewer's own, still open and still inside
 * its 30 days. One definition for the dashboard read and the confirm / skip
 * writes, so what you can see and what you can act on cannot drift apart.
 * Failure look if a path drops `user_id`: nothing errors; someone with a
 * card id could confirm or skip another person's card.
 */
export function openShortcutPendingWhere(userId: string) {
  return and(
    eq(shortcutPendingExpenses.userId, userId),
    isNull(shortcutPendingExpenses.skippedAt),
    gt(shortcutPendingExpenses.createdAt, sql`now() - interval '${sql.raw(String(SHORTCUT_PENDING_TTL_DAYS))} days'`),
  )
}

/** What a card needs on screen. No user id, key id or hash. */
export interface ShortcutPendingView {
  id: string
  amount: number
  /** null = the shortcut sent none; shown and recorded as 「其他」. */
  category: string | null
  /** Plain text, never linkified; null / empty = confirm needs an edit first. */
  note: string | null
  /** 'YYYY-MM-DD', the Asia/Taipei day the card was created on. */
  day: string
}

/**
 * The viewer's own open shortcut cards, newest first. Not realtime and not part
 * of the partner's view: the query is owner-scoped, and nothing else reads this
 * table for a dashboard.
 */
export async function listShortcutPendingsForViewer(userId: string): Promise<ShortcutPendingView[]> {
  const rows = await db
    .select({
      id: shortcutPendingExpenses.id,
      amount: shortcutPendingExpenses.amount,
      category: shortcutPendingExpenses.category,
      note: shortcutPendingExpenses.description,
      createdAt: shortcutPendingExpenses.createdAt,
    })
    .from(shortcutPendingExpenses)
    .where(openShortcutPendingWhere(userId))
    .orderBy(desc(shortcutPendingExpenses.createdAt))
    .limit(SHORTCUT_PENDING_DASHBOARD_LIMIT)
  return rows.map((r) => ({
    id: r.id,
    amount: r.amount,
    category: r.category,
    note: r.note,
    day: taipeiDayOf(r.createdAt),
  }))
}
