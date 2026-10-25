/**
 * Read every row of a PostgREST query, page by page (#1827 S1, review F-F).
 *
 * Why: a plain `select()` returns at most the project's "Max rows" setting
 * (1000 by default) and says nothing about the rest. The sender read due
 * ledgers and their tokens that way, so past that many rows the remainder was
 * silently never pushed. Failure looks like: no error; the families whose rows
 * sort last stop getting 「有待確認的定期收支」 once the table grows.
 *
 * Keyset paging, not offset (`.range()`): the caller's query is ordered by a
 * unique-enough key and filtered `> after`. Each page that returns anything
 * moves `after` forward, and the loop ends only on an EMPTY page — never on a
 * "short" page — so a server cap smaller than our page size cannot end it
 * early. With a non-unique key (group_id), rows sharing the last key of a page
 * are skipped; callers that use one only need the distinct keys.
 *
 * Fails closed: a page error, a page whose last key does not move forward (a
 * filter the server ignored would loop forever), or more than `maxPages`
 * pages stops the loop and reports a short code; rows read so far are
 * returned with it.
 *
 * Pure (no Deno APIs) so vitest can run it: tests/push-send-plan-1827.test.ts.
 */

/** Rows asked for per page; smaller than Supabase's default max rows (1000). */
export const PAGE_SIZE = 500
/** Group ids per `.in()` filter, keeping the request URL short (~3.7 kB). */
export const GROUP_ID_CHUNK = 100

export interface PageResponse<R> {
  data: R[] | null
  error: { code?: string } | null
}

export interface KeysetResult<R> {
  rows: R[]
  /** null when every page was read. */
  errorCode: string | null
}

export async function keysetPages<R>(
  fetchPage: (after: string | null) => PromiseLike<PageResponse<R>>,
  keyOf: (row: R) => string,
  maxPages = 10_000,
): Promise<KeysetResult<R>> {
  const rows: R[] = []
  let after: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await fetchPage(after)
    if (error) return { rows, errorCode: error.code || 'none' }
    if (!data || data.length === 0) return { rows, errorCode: null }
    const last = keyOf(data[data.length - 1])
    if (after !== null && !(last > after)) return { rows, errorCode: 'no_progress' }
    rows.push(...data)
    after = last
  }
  return { rows, errorCode: 'too_many_pages' }
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
