// Who bore how much of an exported expense, from the viewer's side (#1460).
// Pure; the export query (lib/db/queries/export.ts) supplies the chapter's
// participants and their slots. Scope and reasoning:
// docs/superpowers/specs/csv-export-design.md「分攤欄」.
import type { SplitType } from '@/lib/balance'

export type Slot = 'a' | 'b'

export interface ShareRow {
  splitType: SplitType
  /** CashTransactions.split_ratio_a as stored NOW: member_a's share in %. */
  splitRatioA: number | null
  paidBy: string
}

/**
 * The two people of the row's chapter, and for each the ledger slot they hold
 * TODAY — or null when that slot cannot be trusted for this chapter's rows.
 *
 * `split_ratio_a` is "member_a's share", and member_a is whoever holds the
 * a-slot now: a swap and an account-deletion promotion flip the ratio on every
 * row of the ledger and toggle the continuing members' slots together. A leave
 * (member_b only) and a rejoin (acceptInvite seats member_b) change slots
 * WITHOUT flipping. So a participant's current slot tells a row's ratio parity
 * only if they have been named on every chapter of the ledger from the row's
 * chapter through the open one (no break) and still hold a slot. The query
 * sets the slot to null otherwise.
 */
export interface ShareChapter {
  memberAId: string
  memberBId: string | null
  memberASlotNow: Slot | null
  memberBSlotNow: Slot | null
}

export interface ViewerShares {
  /** Percent of the amount the viewer bore. */
  mine: number
  /** Percent the chapter's other person bore. */
  theirs: number
}

/** The payer's share under a non-weighted split — `transactionDelta`'s semantics. */
function payerSharePercent(splitType: Exclude<SplitType, 'weighted'>): number {
  switch (splitType) {
    case 'all_mine': return 100   // payer bears it all (delta 0)
    case 'all_theirs': return 0   // the other person owes all of it
    case 'half': return 50        // ceil(amount / 2) owed to the payer
  }
}

/**
 * The viewer's and the other person's share of an expense row, in percent, or
 * null when it cannot be told (blank cells — never a guess).
 *
 * - half / all_mine / all_theirs: resolved against the stored payer exactly as
 *   `transactionDelta` (lib/balance.ts) does; no slot involved.
 * - weighted: through a participant whose slot is trusted (see
 *   {@link ShareChapter}). The viewer is tried first; if both qualify they
 *   necessarily agree. Neither ⇒ null.
 *
 * Failure this prevents: nothing errors. Reading the ratio against whoever is
 * member_a today hands a former member the other person's share — after a
 * swap, or after they left and were invited back.
 */
export function viewerShares(row: ShareRow, chapter: ShareChapter, viewerId: string): ViewerShares | null {
  if (row.splitType !== 'weighted') {
    const payer = payerSharePercent(row.splitType)
    const mine = row.paidBy === viewerId ? payer : 100 - payer
    return { mine, theirs: 100 - mine }
  }

  const ratioA = row.splitRatioA ?? 50  // transactionDelta's fallback
  const people: { id: string; slot: Slot | null }[] = [
    { id: chapter.memberAId, slot: chapter.memberASlotNow },
    ...(chapter.memberBId ? [{ id: chapter.memberBId, slot: chapter.memberBSlotNow }] : []),
  ]
  // Only the chapter's own people can vouch for the row; the viewer first.
  if (!people.some((p) => p.id === viewerId)) return null
  people.sort((x, y) => Number(y.id === viewerId) - Number(x.id === viewerId))

  for (const p of people) {
    if (p.slot === null) continue
    const share = p.slot === 'a' ? ratioA : 100 - ratioA
    return p.id === viewerId
      ? { mine: share, theirs: 100 - share }
      : { mine: 100 - share, theirs: share }
  }
  return null
}
