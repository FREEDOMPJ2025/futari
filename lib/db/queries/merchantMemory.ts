import { db } from '@/lib/db/client'
import { cashTransactions } from '@/lib/db/schema'
import { and, eq, desc, isNull, sql, type SQL } from 'drizzle-orm'
import { PICKABLE_CATEGORIES, type CategoryId } from '@/lib/categories'
import { viewerChaptersClause } from './_predicates'

/**
 * #1822 — merchant memory for category suggestions.
 *
 * Finds the most recent transaction (by created_at, then transacted_at) in the
 * ledger whose description matches the merchant after normalization (NFKC,
 * lowercase, trimmed), and returns its category — or undefined when there is
 * no match.
 *
 * Which rows: active (non-deleted) rows of `groupId`, drawn only from the
 * chapters `viewerId` belonged to (`viewerChaptersClause`, the same scope as
 * `listDescriptionSuggestions`). A partner who joined later does not learn
 * what the earlier partner bought where. Failure looks like: nothing errors;
 * the new partner's quick add or shortcut card silently pre-picks a category
 * taken from a record they cannot see in their own feed.
 *
 * Normalized matching: "ＳＴＡＲＢＵＣＫＳ　" (fullwidth letters, ideographic
 * space) matches "starbucks", and "７－ＥＬＥＶＥＮ" (fullwidth hyphen-minus
 * U+FF0D) matches "7-Eleven". NFKC does NOT fold U+2212 MINUS SIGN or the
 * katakana long vowel 「ー」 to "-", so "７−ＥＬＥＶＥＮ" (U+2212) does not
 * match "7-eleven". Internal whitespace is kept as is.
 */

/**
 * Characters `normalizeMerchant` trims that can survive NFKC: ASCII
 * whitespace plus the few Unicode spaces / line terminators NFKC leaves alone
 * (U+1680, U+2028, U+2029, U+FEFF). Every other space JS `trim()` removes
 * (U+00A0, U+2000–U+200A, U+202F, U+205F, U+3000) is folded to U+0020 by NFKC
 * first. Passed to SQL `btrim` so both sides trim the same set.
 */
const MERCHANT_TRIM_CHARS = ' \t\n\v\f\r   ﻿'

/**
 * Normalize a merchant name for matching: NFKC (fullwidth/halfwidth), lowercase, trim.
 * The SQL twin is `merchantKeySql`; tests check the two agree.
 */
export function normalizeMerchant(merchant: string): string {
  return merchant.normalize('NFKC').toLowerCase().trim()
}

/**
 * SQL twin of `normalizeMerchant`. Applied to BOTH the stored description and
 * the incoming merchant, so the comparison never depends on JS `toLowerCase`
 * and Postgres `lower()` agreeing (they can differ on rare letters; using the
 * same function on both sides means such a letter still matches itself).
 * `normalize(…, NFKC)` needs a UTF8 database, which Supabase is.
 */
export function merchantKeySql(expr: SQL): SQL {
  return sql`lower(btrim(normalize(${expr}, NFKC), ${MERCHANT_TRIM_CHARS}::text))`
}

export async function getCategoryForMerchant(
  groupId: string,
  viewerId: string,
  merchant: string,
  dbOrTx: Pick<typeof db, 'select'> = db,
): Promise<CategoryId | undefined> {
  // Nothing to look up: skip the query entirely.
  if (!normalizeMerchant(merchant)) return undefined

  // The match runs in SQL over the whole ledger (no recency window), so a
  // merchant recorded long ago is still found. No index on the normalized
  // value: this runs only on quick-add open and shortcut POST, scoped to one
  // ledger, and a stored normalized column would duplicate every description.
  const [row] = await dbOrTx
    .select({ category: cashTransactions.category })
    .from(cashTransactions)
    .where(and(
      eq(cashTransactions.groupId, groupId),
      isNull(cashTransactions.deletedAt),
      sql`${merchantKeySql(sql`${cashTransactions.description}`)} = ${merchantKeySql(sql`${merchant}::text`)}`,
      viewerChaptersClause('"CashTransactions"."created_at"', groupId, viewerId),
    ))
    .orderBy(desc(cashTransactions.createdAt), desc(cashTransactions.transactedAt))
    .limit(1)
  if (!row) return undefined

  // Only return the category if it's still a pickable id; if the category was
  // removed from PICKABLE_CATEGORIES since the record was written, treat it as
  // no match (the caller falls back to the URL/payload category or default).
  return PICKABLE_CATEGORIES.find((c) => c.id === row.category)?.id
}
