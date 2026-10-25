/**
 * Sending with bounded concurrency and a run deadline (#1827 S1).
 *
 * Why: the sender used to await each push in turn. With APNs having no fetch
 * timeout, one hanging connection held the whole run, and a long target list
 * ran past the Edge Function's wall-clock limit — the runtime then kills the
 * function before the stale-token deletes at the end ever run. Failure looks
 * like: the cron call times out or returns 5xx in net._http_response, the
 * function log stops mid-run, and dead tokens are never cleaned up, so the
 * next night is just as slow.
 *
 * `runWithDeadline` keeps at most `concurrency` workers busy and stops
 * STARTING new items once `now() >= deadlineAt`. Items in flight finish (each
 * send has its own 10 s fetch timeout), so the branch returns by about
 * deadline + one timeout, and the caller still runs its stale-row delete.
 * Items never started are counted as skipped by deadline. A worker that throws
 * is counted as errored and does not stop the others.
 *
 * Pure (no Deno APIs) so vitest can run it: tests/push-send-plan-1827.test.ts.
 */

/** Per platform; APNs and FCM run side by side, so up to 2× this at once. */
export const SEND_CONCURRENCY = 8
/**
 * Stop starting sends this long after the run began. Leaves room under the
 * Edge Function wall-clock limit (150 s on the free plan) for in-flight sends
 * (≤ 10 s each) and the stale-row deletes.
 */
export const RUN_DEADLINE_MS = 100_000
/** Per APNs request, the same bound FCM_FETCH_TIMEOUT_MS gives each FCM send. */
export const APNS_FETCH_TIMEOUT_MS = 10_000

export interface PoolOptions {
  concurrency: number
  deadlineAt: number
  now?: () => number
}

export interface PoolResult<R> {
  /** Results of the items that completed, in input order. */
  results: R[]
  started: number
  skippedByDeadline: number
  errored: number
}

export async function runWithDeadline<T, R>(
  items: readonly T[],
  opts: PoolOptions,
  worker: (item: T) => Promise<R>,
): Promise<PoolResult<R>> {
  const now = opts.now ?? Date.now
  const slots: ({ ok: true; value: R } | { ok: false } | undefined)[] = new Array(items.length)
  let next = 0
  let started = 0
  let errored = 0

  async function lane(): Promise<void> {
    while (next < items.length && now() < opts.deadlineAt) {
      const i = next++
      started++
      try {
        slots[i] = { ok: true, value: await worker(items[i]) }
      } catch {
        errored++
        slots[i] = { ok: false }
      }
    }
  }

  const lanes = Math.max(0, Math.min(opts.concurrency, items.length))
  await Promise.all(Array.from({ length: lanes }, () => lane()))

  const results: R[] = []
  for (const s of slots) if (s && s.ok) results.push(s.value)
  return { results, started, skippedByDeadline: items.length - started, errored }
}
