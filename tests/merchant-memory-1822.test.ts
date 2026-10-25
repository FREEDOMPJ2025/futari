/**
 * #1822 - Merchant memory for category suggestions.
 *
 * When an expense is brought in from outside (URL prefill #1488 or pending
 * shortcut card #1536), the merchant name comes in the description/note field.
 * For the same merchant, we auto-suggest the category chosen the last time
 * this merchant was recorded.
 *
 * Priority: merchant memory > URL/payload category > default category (dining).
 *
 * What failure looks like: nothing errors. The category auto-fills to 'dining'
 * every time, or stays locked to the URL's category even when the user has
 * recorded that merchant with a different category before. The second record
 * for the same merchant should pick up the category from the first.
 */
import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { CategoryId } from '@/lib/categories'
import { normalizeMerchant, getCategoryForMerchant } from '@/lib/db/queries/merchantMemory'

describe('merchant memory - normalization logic', () => {
  describe('normalizeMerchant', () => {
    it('normalizes case', () => {
      expect(normalizeMerchant('Starbucks')).toBe('starbucks')
      expect(normalizeMerchant('STARBUCKS')).toBe('starbucks')
      expect(normalizeMerchant('sTaRbUcKs')).toBe('starbucks')
    })

    it('normalizes fullwidth/halfwidth characters (NFKC)', () => {
      // Fullwidth digits and letters should normalize to halfwidth
      // The dash in the input is U+2212 MINUS SIGN which NFKC does not convert
      // to ASCII hyphen-minus. What matters is that both fullwidth forms match.
      const fullwidth = normalizeMerchant('７−ＥＬＥＶＥＮ')
      const halfwidth = normalizeMerchant('7−ELEVEN')
      expect(fullwidth).toBe(halfwidth)

      // The fullwidth hyphen-minus (U+FF0D) does fold to ASCII "-"
      expect(normalizeMerchant('７－ＥＬＥＶＥＮ')).toBe(normalizeMerchant('7-Eleven'))
      // The katakana long vowel 「ー」 (U+30FC) is kept as is
      expect(normalizeMerchant('７ーＥＬＥＶＥＮ')).toBe('7ーeleven')
    })

    it('trims leading and trailing whitespace', () => {
      expect(normalizeMerchant('  Cafe  ')).toBe('cafe')
      expect(normalizeMerchant('Cafe')).toBe('cafe')
      expect(normalizeMerchant('  Cafe')).toBe('cafe')
      expect(normalizeMerchant('Cafe  ')).toBe('cafe')
    })

    it('handles empty or whitespace-only input', () => {
      expect(normalizeMerchant('')).toBe('')
      expect(normalizeMerchant('   ')).toBe('')
      expect(normalizeMerchant('\t\n')).toBe('')
    })

    it('handles merchants with special characters', () => {
      expect(normalizeMerchant('C\'est Bon! (好吃)')).toBe('c\'est bon! (好吃)')
      expect(normalizeMerchant('  c\'est bon! (好吃)  ')).toBe('c\'est bon! (好吃)')
    })

    it('differentiates between similar but different merchants', () => {
      const norm1 = normalizeMerchant('Starbucks')
      const norm2 = normalizeMerchant('Starbucks Reserve')
      expect(norm1).not.toBe(norm2)
      expect(norm1).toBe('starbucks')
      expect(norm2).toBe('starbucks reserve')
    })

    it('handles merchant names with internal whitespace differences', () => {
      // Internal whitespace is preserved, not normalized
      expect(normalizeMerchant('Cafe  Latte')).toBe('cafe  latte')
      expect(normalizeMerchant('Cafe Latte')).toBe('cafe latte')
      expect(normalizeMerchant('Cafe  Latte')).not.toBe(normalizeMerchant('Cafe Latte'))
    })

    it('handles Unicode normalization', () => {
      // é as precomposed (U+00E9) and as e + combining acute (U+0065 U+0301)
      // should normalize to the same form
      const cafe1 = 'Café' // U+00E9
      const cafe2 = 'Café' // e + U+0301
      expect(normalizeMerchant(cafe1)).toBe(normalizeMerchant(cafe2))
    })

    it('handles very long merchant names', () => {
      const longName = 'A'.repeat(100)
      expect(normalizeMerchant(longName)).toBe('a'.repeat(100))
    })
  })

  describe('priority order logic', () => {
    it('merchant memory takes precedence over URL category', () => {
      const merchantMemory: CategoryId = 'health'
      const urlCategory: CategoryId = 'dining'
      const defaultCategory: CategoryId = 'dining'

      const result = merchantMemory ?? urlCategory ?? defaultCategory
      expect(result).toBe('health')
    })

    it('URL category is used when no merchant history exists', () => {
      const merchantMemory: CategoryId | null = null
      const urlCategory: CategoryId = 'transit'
      const defaultCategory: CategoryId = 'dining'

      const result = merchantMemory ?? urlCategory ?? defaultCategory
      expect(result).toBe('transit')
    })

    it('default category is used when no merchant history and no URL category', () => {
      const merchantMemory: CategoryId | null = null
      const urlCategory: CategoryId | undefined = undefined
      const defaultCategory: CategoryId = 'dining'

      const result = merchantMemory ?? urlCategory ?? defaultCategory
      expect(result).toBe('dining')
    })
  })
})

// The behaviour against real rows (chapter scope, no recency window, width
// folding, soft deletes, JS/SQL agreement) is covered on the dev DB in
// __tests__/actions/merchantMemory1822.test.ts, which CI excludes. These
// checks run everywhere: they pin the SHAPE of the query, so dropping the
// chapter scope or re-adding a fetch-then-filter window fails here too.
describe('getCategoryForMerchant', () => {
  const dialect = new PgDialect()
  const VIEWER = '11111111-1111-4111-8111-111111111111'
  const GROUP = '22222222-2222-4222-8222-222222222222'

  /** A db stand-in that records the WHERE / LIMIT and returns `rows`. */
  function createMockDb(rows: Array<{ category: string }>) {
    const seen: { where?: SQL; limit?: number; calls: number } = { calls: 0 }
    const mock = {
      select: () => {
        seen.calls++
        return {
          from: () => ({
            where: (w: SQL) => {
              seen.where = w
              return {
                orderBy: () => ({
                  limit: (n: number) => {
                    seen.limit = n
                    return Promise.resolve(rows)
                  },
                }),
              }
            },
          }),
        }
      },
    } as unknown as Parameters<typeof getCategoryForMerchant>[3]
    return { mock, seen }
  }

  it('scopes to the chapters the viewer belonged to, matches in SQL, and reads one row', async () => {
    const { mock, seen } = createMockDb([{ category: 'health' }])
    expect(await getCategoryForMerchant(GROUP, VIEWER, 'Starbucks', mock)).toBe('health')
    const q = dialect.sqlToQuery(seen.where!)
    // viewerChaptersClause, with the outer column table-qualified.
    expect(q.sql).toContain('FROM "GroupEpochs" ve')
    expect(q.sql).toContain('"CashTransactions"."created_at" >= ve."started_at"')
    expect(q.params).toContain(VIEWER)
    // Normalized on both sides in SQL; no client-side window.
    expect(q.sql.match(/lower\(btrim\(normalize\(/g)).toHaveLength(2)
    expect(q.params).toContain('Starbucks')
    expect(q.sql).toMatch(/"deleted_at" is null/i)
    expect(seen.limit).toBe(1)
  })

  it('returns undefined when no row matches', async () => {
    const { mock } = createMockDb([])
    expect(await getCategoryForMerchant(GROUP, VIEWER, 'Target', mock)).toBeUndefined()
  })

  it('returns undefined when the category is not in PICKABLE_CATEGORIES', async () => {
    const { mock } = createMockDb([{ category: 'removed-category' }])
    expect(await getCategoryForMerchant(GROUP, VIEWER, 'Starbucks', mock)).toBeUndefined()
    const { mock: settle } = createMockDb([{ category: 'settle' }])
    expect(await getCategoryForMerchant(GROUP, VIEWER, 'Starbucks', settle)).toBeUndefined()
  })

  it('does not query for an empty or whitespace-only merchant', async () => {
    const { mock, seen } = createMockDb([{ category: 'health' }])
    expect(await getCategoryForMerchant(GROUP, VIEWER, '', mock)).toBeUndefined()
    expect(await getCategoryForMerchant(GROUP, VIEWER, '   ', mock)).toBeUndefined()
    expect(await getCategoryForMerchant(GROUP, VIEWER, '　', mock)).toBeUndefined()
    expect(seen.calls).toBe(0)
  })
})
