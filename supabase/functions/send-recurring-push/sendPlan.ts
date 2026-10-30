/**
 * Which push targets this run sends to, and in what order (#1827 S1).
 *
 * Why: every signed-in user can write their own PushTokens rows. Before #1827
 * nothing limited how many, and the sender walked them in table order, one
 * request at a time. One account with a thousand rows on a ledger with a due
 * card would eat the whole run, and every ledger after it in the list got
 * nothing. Failure looks like: nothing errors; most families silently stop
 * getting 「有待確認的定期收支」 while one account's junk is tried every night.
 * 0101 now caps rows per user in the database; this is the sender's own limit,
 * which also holds before 0101 is applied and for whatever rows exist.
 *
 * The plan:
 *   - round-robin across ledgers (sorted by id, so runs are reproducible): each
 *     round gives every ledger with something left one send;
 *   - inside a ledger, round-robin across its users, so one member's many
 *     devices do not starve the other member's;
 *   - at most PER_USER_SEND_CAP sends charged to one user, PER_LEDGER_SEND_CAP
 *     per ledger, PER_RUN_SEND_CAP per run. Everything not planned is counted
 *     as skipped_by_cap.
 * A target (one device) is planned at most once, even when it appears under
 * two ledgers or two users; it is charged to the user whose queue reached it.
 * A target none of whose rows has a known owner is never planned (fail closed).
 *
 * Pure (no Deno APIs) so vitest can run it: tests/push-send-plan-1827.test.ts.
 */
import type { PushTarget } from './memberTokens.ts'

/** Real people have 1–2 devices (prod max 2 rows per user, 2026-10-25). */
export const PER_USER_SEND_CAP = 10
/** Two members × PER_USER_SEND_CAP. */
export const PER_LEDGER_SEND_CAP = 20
/** Prod had 41 tokens in all (2026-10-25); 2000 leaves ~50× headroom. */
export const PER_RUN_SEND_CAP = 2000

export interface SendCaps {
  perUser: number
  perLedger: number
  perRun: number
}

export const DEFAULT_SEND_CAPS: SendCaps = {
  perUser: PER_USER_SEND_CAP,
  perLedger: PER_LEDGER_SEND_CAP,
  perRun: PER_RUN_SEND_CAP,
}

/** Who a PushTokens row belongs to, keyed by row id. */
export interface RowOwner {
  userId: string
  groupId: string
}

export interface SendPlan {
  /** In send order: fair across ledgers, so a deadline cut-off is fair too. */
  targets: PushTarget[]
  skippedByCap: number
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Interleave several queues: first of each, then second of each, … */
function interleave<T>(queues: readonly (readonly T[])[]): T[] {
  const out: T[] = []
  const longest = Math.max(0, ...queues.map((q) => q.length))
  for (let i = 0; i < longest; i++) {
    for (const q of queues) if (i < q.length) out.push(q[i])
  }
  return out
}

export function planSends(
  targets: readonly PushTarget[],
  owners: ReadonlyMap<string, RowOwner>,
  caps: SendCaps = DEFAULT_SEND_CAPS,
): SendPlan {
  // ledger → user → target indexes (input order kept within a user).
  const ledgers = new Map<string, Map<string, number[]>>()
  targets.forEach((t, i) => {
    const seen = new Set<string>()
    for (const id of t.ids) {
      const o = owners.get(id)
      if (!o || !o.userId || !o.groupId) continue
      const key = `${o.groupId}\u0000${o.userId}`
      if (seen.has(key)) continue
      seen.add(key)
      let users = ledgers.get(o.groupId)
      if (!users) ledgers.set(o.groupId, (users = new Map()))
      let list = users.get(o.userId)
      if (!list) users.set(o.userId, (list = []))
      list.push(i)
    }
  })

  type Entry = { target: number; user: string }
  const queues: { ledger: string; entries: Entry[]; next: number; count: number }[] = [...ledgers.keys()]
    .sort(byString)
    .map((ledger) => {
      const users = ledgers.get(ledger)!
      const perUser = [...users.keys()].sort(byString).map((user) => users.get(user)!.map((target) => ({ target, user })))
      return { ledger, entries: interleave(perUser), next: 0, count: 0 }
    })

  const planned = new Set<number>()
  const order: number[] = []
  const userCount = new Map<string, number>()
  let active = queues.filter((q) => q.entries.length > 0)

  while (active.length > 0 && order.length < caps.perRun) {
    for (const q of active) {
      if (order.length >= caps.perRun) break
      while (q.next < q.entries.length && q.count < caps.perLedger) {
        const { target, user } = q.entries[q.next++]
        if (planned.has(target)) continue
        const used = userCount.get(user) ?? 0
        if (used >= caps.perUser) continue
        planned.add(target)
        order.push(target)
        userCount.set(user, used + 1)
        q.count++
        break
      }
    }
    active = active.filter((q) => q.next < q.entries.length && q.count < caps.perLedger)
  }

  return {
    targets: order.map((i) => targets[i]),
    skippedByCap: targets.length - order.length,
  }
}
