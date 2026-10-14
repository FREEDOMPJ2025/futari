import { db } from '@/lib/db/client'
import { monthlyReviewMessages, monthlyReviewSnapshots } from '@/lib/db/schema'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { isMonthInChapter, type YearMonth } from '@/lib/monthlyReview'
import { epochClause } from './_predicates'
import type { EpochWindow } from './epoch'

export interface RecurringEvent {
  name: string
  amount: number
  direction: 'income' | 'expense'
  occurredAt: string
}

export interface AssetBreakdownRow {
  assetName: string
  total: number
}

export interface MonthlyReviewSnapshotRow {
  id: string
  groupId: string
  year: number
  month: number
  computedAt: Date
  topCategory: string | null
  topCategoryTotal: number | null
  largestExpenseAmount: number | null
  largestExpenseDescription: string | null
  largestExpenseCategory: string | null
  /**
   * The largest expense's payer id (#1618). SERVER ONLY: resolve it with
   * resolveReviewPayerName and strip it (toClientReviewSnapshot, both in
   * lib/monthlyReview.ts) before the snapshot reaches a client component. It
   * may be a former partner's id.
   */
  largestExpensePaidBy: string | null
  recurringEvents: RecurringEvent[]
  recurringTotalIncome: number
  recurringTotalExpense: number
  assetBreakdown: AssetBreakdownRow[]
  bannerDismissedByMemberAAt: Date | null
  bannerDismissedByMemberBAt: Date | null
}

/** What a client component may receive: the snapshot without the payer id. */
export type ClientReviewSnapshot = Omit<MonthlyReviewSnapshotRow, 'largestExpensePaidBy'>

export interface MonthlyReviewMessageRow {
  id: string
  memberId: string
  year: number
  month: number
  body: string
  createdAt: Date
  updatedAt: Date
  lockedAt: Date | null
}

function rehydrate(row: typeof monthlyReviewSnapshots.$inferSelect): MonthlyReviewSnapshotRow {
  // jsonb columns come back already-parsed; defaults guard against NULL on
  // very-early snapshots where the cron fired before any data existed.
  const events = (row.recurringEvents as RecurringEvent[] | null) ?? []
  const assets = (row.assetBreakdown as AssetBreakdownRow[] | null) ?? []
  return {
    id: row.id,
    groupId: row.groupId,
    year: row.year,
    month: row.month,
    computedAt: row.computedAt,
    topCategory: row.topCategory,
    topCategoryTotal: row.topCategoryTotal,
    largestExpenseAmount: row.largestExpenseAmount,
    largestExpenseDescription: row.largestExpenseDescription,
    largestExpenseCategory: row.largestExpenseCategory,
    largestExpensePaidBy: row.largestExpensePaidBy,
    recurringEvents: events,
    recurringTotalIncome: row.recurringTotalIncome ?? 0,
    recurringTotalExpense: row.recurringTotalExpense ?? 0,
    assetBreakdown: assets,
    bannerDismissedByMemberAAt: row.bannerDismissedByMemberAAt,
    bannerDismissedByMemberBAt: row.bannerDismissedByMemberBAt,
  }
}

export async function loadMonthlyReviewSnapshot(
  groupId: string,
  year: number,
  month: number,
): Promise<MonthlyReviewSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(monthlyReviewSnapshots)
    .where(and(
      eq(monthlyReviewSnapshots.groupId, groupId),
      eq(monthlyReviewSnapshots.year, year),
      eq(monthlyReviewSnapshots.month, month),
    ))
    .limit(1)
  return row ? rehydrate(row) : null
}

/**
 * The messages given to month `ym` that belong to one chapter (#1684, #1685):
 * written by one of that chapter's two people (`memberIds`, from its epoch
 * row) while it was open (`created_at` inside `window`).
 *
 * Messages are group-scoped rows and leave/remove keep them in the ledger
 * (#1611), so a group-wide read for a month serves words written to a
 * previous partner to the next one, and a row with a forged future month to
 * whoever is in the ledger when that month comes. The window is what stops
 * both: the stayer is a member of the next chapter too, so the member filter
 * alone would still pass their words to the old partner. The member filter is
 * the second fence — only the two people the chapter row names, never anyone
 * else whose row happens to fall inside the window.
 *
 * What it looks like when this regresses: nothing errors. A new partner's
 * /review page or home banner quietly quotes a message that was written to
 * someone else.
 *
 * Fails closed: no member ids → no rows.
 */
export async function loadChapterReviewMessages(
  groupId: string,
  ym: YearMonth,
  chapter: { memberIds: string[]; window: EpochWindow },
): Promise<MonthlyReviewMessageRow[]> {
  if (chapter.memberIds.length === 0) return []
  return db
    .select({
      id: monthlyReviewMessages.id,
      memberId: monthlyReviewMessages.memberId,
      year: monthlyReviewMessages.year,
      month: monthlyReviewMessages.month,
      body: monthlyReviewMessages.body,
      createdAt: monthlyReviewMessages.createdAt,
      updatedAt: monthlyReviewMessages.updatedAt,
      lockedAt: monthlyReviewMessages.lockedAt,
    })
    .from(monthlyReviewMessages)
    .where(and(
      eq(monthlyReviewMessages.groupId, groupId),
      eq(monthlyReviewMessages.year, ym.year),
      eq(monthlyReviewMessages.month, ym.month),
      inArray(monthlyReviewMessages.memberId, chapter.memberIds),
      epochClause(monthlyReviewMessages.createdAt, chapter.window),
    ))
    .orderBy(asc(monthlyReviewMessages.createdAt))
}

/**
 * Months with a review that belong to `chapter`, newest first (#1364, #1380).
 * Feeds the /review index and the dashboard 月回顧 cell. Reviews follow the
 * chapter, not the group — see isMonthInChapter for the rule, including why a
 * month straddling a chapter boundary belongs to neither side.
 */
export async function listMonthlyReviewMonths(
  groupId: string,
  chapter: { startedAt: Date; endedAt: Date | null },
): Promise<{ year: number; month: number }[]> {
  const rows = await db
    .select({ year: monthlyReviewSnapshots.year, month: monthlyReviewSnapshots.month })
    .from(monthlyReviewSnapshots)
    .where(eq(monthlyReviewSnapshots.groupId, groupId))
    .orderBy(desc(monthlyReviewSnapshots.year), desc(monthlyReviewSnapshots.month))
  return rows.filter((ym) => isMonthInChapter(ym, chapter))
}
