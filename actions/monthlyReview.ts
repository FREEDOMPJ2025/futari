'use server'

import { db } from '@/lib/db/client'
import { groupEpochs, monthlyReviewMessages, monthlyReviewSnapshots } from '@/lib/db/schema'
import { requireViewerGroup } from '@/lib/auth/viewer'
import { lockOpenEpochForWrite } from '@/lib/db/queries/epoch'
import {
  currentYearMonthInTaipei,
  formatYearMonth,
  isAfter,
  isMonthInChapter,
  previousMonth,
  validateMessageBody,
} from '@/lib/monthlyReview'
import { and, eq, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { action, actionError } from '@/lib/action-errors'

export interface UpsertMonthlyReviewMessageInput {
  /** Message is *given to* this month (future-facing — see schema comment). */
  year: number
  month: number
  body: string
}

/**
 * Upsert the viewer's own message for (year, month). Refuses when locked_at
 * is set on the existing row (post month-end cron); the UI defends with a
 * read-only state but the server is the authority.
 *
 * #1684 #1685 — the message is given to `ym` from the review of the month
 * before it, so that reviewed month must be one the open chapter could show
 * (/review/[month] 404s the rest): not in the future, and wholly inside the
 * open chapter. Everything runs in one transaction holding the open chapter
 * row FOR SHARE (lockOpenEpochForWrite), checked against that locked row:
 * a leave/remove that closes the chapter either waits for this write (so the
 * row's created_at lands before its boundary) or, if it got there first,
 * makes this refuse. Without the lock nothing errors — the row commits after
 * the close and is filed under the next chapter, where a new partner reads
 * it, or a closed chapter's message is edited after it closed.
 */
export const upsertMonthlyReviewMessage = action(async (
  input: UpsertMonthlyReviewMessageInput,
): Promise<{ id: string }> => {
  const body = validateMessageBody(input.body)
  const { user, group } = await requireViewerGroup()

  const id = await db.transaction(async (tx) => {
    const openEpoch = await lockOpenEpochForWrite(tx, group.id)
    if (!openEpoch) throw actionError('current_epoch_not_found')
    const [chapter] = await tx
      .select({ startedAt: groupEpochs.startedAt, endedAt: groupEpochs.endedAt })
      .from(groupEpochs)
      .where(eq(groupEpochs.id, openEpoch.id))
      .limit(1)
    if (!chapter) throw actionError('current_epoch_not_found')

    // Malformed input never comes from the editor: a shape error, not a refusal.
    if (
      !Number.isInteger(input.year) || !Number.isInteger(input.month)
      || input.month < 1 || input.month > 12
      || input.year < 2000 || input.year > 9999
    ) {
      throw new Error('Invalid review month')
    }
    const reviewed = previousMonth({ year: input.year, month: input.month })
    if (isAfter(reviewed, currentYearMonthInTaipei())) throw actionError('review_month_locked')
    // The locked row's own window (never the viewer's look-back pin).
    if (!isMonthInChapter(reviewed, chapter)) throw actionError('review_month_locked')

    const [existing] = await tx
      .select({
        id: monthlyReviewMessages.id,
        lockedAt: monthlyReviewMessages.lockedAt,
      })
      .from(monthlyReviewMessages)
      .where(and(
        eq(monthlyReviewMessages.groupId, group.id),
        eq(monthlyReviewMessages.memberId, user.id),
        eq(monthlyReviewMessages.year, input.year),
        eq(monthlyReviewMessages.month, input.month),
      ))
      .limit(1)

    if (existing?.lockedAt) {
      throw actionError('review_month_locked')
    }

    if (existing) {
      const [updated] = await tx
        .update(monthlyReviewMessages)
        .set({ body, updatedAt: new Date() })
        .where(and(
          eq(monthlyReviewMessages.id, existing.id),
          // Defence-in-depth: if the cron stamps locked_at between our SELECT
          // and UPDATE, the WHERE filter prevents the write.
          isNull(monthlyReviewMessages.lockedAt),
        ))
        .returning({ id: monthlyReviewMessages.id })
      if (!updated) throw actionError('review_message_locked')
      return updated.id
    }
    const [created] = await tx
      .insert(monthlyReviewMessages)
      .values({
        groupId: group.id,
        memberId: user.id,
        year: input.year,
        month: input.month,
        body,
      })
      .returning({ id: monthlyReviewMessages.id })
    return created.id
  })

  // Both /review pages (the one being edited and the one whose banner cites
  // this message) derive from this row.
  const monthSlug = formatYearMonth({ year: input.year, month: input.month })
  const reviewSlug = formatYearMonth(prevMonthFor(input.year, input.month))
  revalidatePath(`/review/${monthSlug}`)
  revalidatePath(`/review/${reviewSlug}`)
  revalidatePath('/dashboard')
  return { id }
})

function prevMonthFor(year: number, month: number) {
  if (month === 1) return { year: year - 1, month: 12 }
  return { year, month: month - 1 }
}

export interface DismissMonthlyReviewBannerInput {
  /** The reviewed month (snapshot.year/snapshot.month — past month). */
  year: number
  month: number
}

/**
 * Records that the viewer has dismissed the banner for (year, month). Sets
 * `banner_dismissed_by_member_<a|b>_at` based on which side of the group
 * the viewer is. Idempotent — re-dismissing a row with timestamp set leaves
 * the original timestamp.
 *
 * Auto-clicking the CTA also goes through this action (UI calls it before
 * navigating), so the partner can still see the banner once.
 */
export const dismissMonthlyReviewBanner = action(async (
  input: DismissMonthlyReviewBannerInput,
): Promise<void> => {
  const { user, group } = await requireViewerGroup()

  const viewerIsA = group.memberA === user.id
  const viewerIsB = group.memberB === user.id
  if (!viewerIsA && !viewerIsB) {
    // Should be impossible (RLS would block) but guard for clarity.
    throw new Error('Unauthorized')
  }

  const setExpr = viewerIsA
    ? { bannerDismissedByMemberAAt: new Date() }
    : { bannerDismissedByMemberBAt: new Date() }

  await db
    .update(monthlyReviewSnapshots)
    .set(setExpr)
    .where(and(
      eq(monthlyReviewSnapshots.groupId, group.id),
      eq(monthlyReviewSnapshots.year, input.year),
      eq(monthlyReviewSnapshots.month, input.month),
      // Don't overwrite the original dismiss timestamp.
      viewerIsA
        ? isNull(monthlyReviewSnapshots.bannerDismissedByMemberAAt)
        : isNull(monthlyReviewSnapshots.bannerDismissedByMemberBAt),
    ))

  revalidatePath('/dashboard')
})
