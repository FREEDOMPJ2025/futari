'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db/client'
import { cashTransactions, shortcutPendingExpenses } from '@/lib/db/schema'
import { requireViewer } from '@/lib/auth/viewer'
import { assertMemberInGroup } from '@/lib/auth/member'
import { getViewerWriteContext } from '@/lib/actionContext'
import { action, actionError } from '@/lib/action-errors'
import { validateTransactionInput } from '@/lib/validators'
import { taipeiDayOf } from '@/lib/monthKey'
import type { SplitType } from '@/lib/balance'
import { openShortcutPendingWhere } from '@/lib/db/queries/shortcutPending'
import { settleInsertedRecord, announceRecordCreated } from '@/lib/transactionWriteEffects'

// ─── #1536 — confirm / skip a card an iOS Shortcut left in 待確認 ─────────────
//
// A card is the owner's alone: every statement below is scoped by
// `user_id = viewer` (openShortcutPendingWhere), so a card id that belongs to
// someone else behaves exactly like one that does not exist. Never send the
// note or the amount to captureServer / Sentry.
//
// Confirm is ONE transaction that first claims the card with
// `DELETE … RETURNING` and only then inserts the record from the returned
// values. Two taps (two tabs, a retry) both try the DELETE; the loser waits on
// the row lock, finds nothing, and answers `shortcut_pending_handled_elsewhere`.
// The earlier plan, "insert, then delete the card in a second step", would
// record twice. The same claim is what keeps a confirm after a skip, or after
// the 30 days, from writing anything.
// ────────────────────────────────────────────────────────────────────────────

/** What 改一下 (AddSheet) may change. Anything left out keeps the card's value. */
export interface ShortcutPendingOverrides {
  amount?: number
  description?: string
  category?: string
  splitType?: SplitType
  splitRatioA?: number | null
  /** The payer; must be a member of the ledger. Defaults to the viewer. */
  paidBy?: string
  /** Calendar day 'YYYY-MM-DD'. Defaults to the Asia/Taipei day the card was created on. */
  transactedAt?: string
}

/**
 * The split a record gets when nobody picked one: solo → all mine; otherwise
 * the ledger's default ratio. A ratio of 50 (or none) is a plain 'half'; any
 * other is 'weighted' and MUST carry `split_ratio_a` (#1243: a weighted row
 * with a NULL ratio is read three different ways and none of them errors).
 */
function ledgerDefaultSplit(group: {
  memberB: string | null
  defaultSplitRatioA: number | null
}): { splitType: SplitType; splitRatioA: number | null } {
  if (!group.memberB) return { splitType: 'all_mine', splitRatioA: null }
  const r = group.defaultSplitRatioA
  if (r === null || r === 50 || !Number.isInteger(r) || r < 1 || r > 99) {
    return { splitType: 'half', splitRatioA: null }
  }
  return { splitType: 'weighted', splitRatioA: r }
}

export const confirmShortcutPending = action(async (
  id: string,
  overrides?: ShortcutPendingOverrides,
): Promise<{ txId: string }> => {
  // A past chapter is read-only, same as every record write (throws a plain
  // Error there, like confirmPending).
  const { user, group } = await getViewerWriteContext()
  const o = overrides ?? {}

  const result = await db.transaction(async (tx) => {
    const [card] = await tx
      .delete(shortcutPendingExpenses)
      .where(and(eq(shortcutPendingExpenses.id, id), openShortcutPendingWhere(user.id)))
      .returning()
    if (!card) throw actionError('shortcut_pending_handled_elsewhere')

    // A record needs a description and the shortcut's note is optional: no note
    // and none supplied → ask for one, never invent text in some language.
    // Throwing rolls the DELETE back, so the card stays.
    const description = (o.description ?? card.description ?? '').trim()
    if (!description) throw actionError('shortcut_pending_needs_note')

    const payerId = o.paidBy ?? user.id
    assertMemberInGroup(payerId, group, 'payer_not_in_group')

    const split = o.splitType
      ? { splitType: o.splitType, splitRatioA: o.splitRatioA ?? null }
      : ledgerDefaultSplit(group)

    // The same validator createTransaction runs (amount cap, category fallback
    // to 'other', weighted ratio 1–99, date shape). Its messages are prose, not
    // codes, so a failure is mapped to one code the client can localize.
    let validated: ReturnType<typeof validateTransactionInput>
    try {
      validated = validateTransactionInput({
        amount: o.amount ?? card.amount,
        description,
        category: o.category ?? card.category ?? 'other',
        splitType: split.splitType,
        splitRatioA: split.splitRatioA,
        payerId,
        transactedAt: o.transactedAt ?? taipeiDayOf(card.createdAt),
      })
    } catch {
      throw actionError('shortcut_pending_invalid')
    }

    const [inserted] = await tx
      .insert(cashTransactions)
      .values({
        groupId: group.id,
        paidBy: validated.payerId,
        amount: validated.amount,
        splitType: validated.splitType,
        splitRatioA: validated.splitRatioA,
        description: validated.description,
        category: validated.category,
        status: validated.status,
        transactedAt: validated.transactedAt,
      })
      .returning({ id: cashTransactions.id })

    const { isFirstRecord } = await settleInsertedRecord(tx, user.id, group.id)
    return { txId: inserted.id, isFirstRecord }
  })

  await announceRecordCreated({
    userId: user.id,
    isFirstRecord: result.isFirstRecord,
    via: 'shortcut',
    recordProps: { group_id: group.id },
  })
  return { txId: result.txId }
})

export const skipShortcutPending = action(async (id: string): Promise<void> => {
  const { user } = await requireViewer()
  const updated = await db
    .update(shortcutPendingExpenses)
    .set({ skippedAt: new Date() })
    .where(and(eq(shortcutPendingExpenses.id, id), openShortcutPendingWhere(user.id)))
    .returning({ id: shortcutPendingExpenses.id })
  if (updated.length === 0) throw actionError('shortcut_pending_handled_elsewhere')
  revalidatePath('/dashboard')
})
