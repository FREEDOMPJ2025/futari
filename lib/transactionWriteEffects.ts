import { recalcGroupBalance } from '@/lib/db/queries/balance'
import type { db } from '@/lib/db/client'
import { captureServer, isUserFirstNonDeletedRecord } from '@/lib/analytics/server'
import { revalidateAfterTransactionMutation } from '@/lib/revalidate'

/**
 * What every path that writes one user-made CashTransaction does around the
 * insert (#1536 pulled it out of createTransaction, confirmPending,
 * editAndConfirmPending so the shortcut confirm cannot drift from them).
 *
 * Two halves, because one runs inside the DB transaction and one after commit:
 *
 *   1. `settleInsertedRecord(tx, ...)` — right after the insert, same tx:
 *      recompute the group balance, then ask whether this is the viewer's
 *      first record.
 *   2. `announceRecordCreated(...)` — after commit: revalidate the pages,
 *      then `first_record_created` (when it was) and `record_created`.
 *
 * Failure look if a new path skips half 1: nothing errors; the record shows in
 * the feed but `GroupBalance` keeps the old value (and `version`) until some
 * other write recomputes it. Skipping half 2 leaves the pages stale and the
 * activation metric (`record_created >= 1`) short by that path.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function settleInsertedRecord(
  tx: Tx,
  userId: string,
  groupId: string,
): Promise<{ isFirstRecord: boolean }> {
  await recalcGroupBalance(groupId, tx)
  // Per-user "first record" signal; see isUserFirstNonDeletedRecord for the
  // partner-as-payer caveat.
  const isFirstRecord = await isUserFirstNonDeletedRecord(tx, userId, groupId)
  return { isFirstRecord }
}

export async function announceRecordCreated(args: {
  userId: string
  isFirstRecord: boolean
  /** The pipe the record came in through (observability-design.md `via` list). */
  via: string
  /** Passed to `revalidateAfterTransactionMutation` as is. */
  revalidate?: Parameters<typeof revalidateAfterTransactionMutation>[0]
  /** Extra `record_created` properties; `via` is always set from `via`. */
  recordProps?: Record<string, unknown>
}): Promise<void> {
  const { userId, isFirstRecord, via, revalidate, recordProps } = args
  if (revalidate) revalidateAfterTransactionMutation(revalidate)
  else revalidateAfterTransactionMutation()
  if (isFirstRecord) {
    await captureServer(userId, 'first_record_created', { via })
  }
  await captureServer(userId, 'record_created', { ...recordProps, via })
}
