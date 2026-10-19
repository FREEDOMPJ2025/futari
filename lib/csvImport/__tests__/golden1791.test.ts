/**
 * #1791 — adding AndroMoney / まねーぼ / Splitwise (new sniff signatures that
 * run BEFORE the CWMoney check, new parse hints, a new branch in the row loop)
 * must not change what any existing source's file produces.
 *
 * `golden1791.expected.json` was recorded by running these same inputs through
 * the csvImport code as it was at b824dd6, before this work. Failure looks like:
 * nothing breaks loudly — a Honeydue or CWMoney file imports as a different
 * number of rows, a different type or a different day.
 */
import { describe, it, expect } from 'vitest'
import { detectSource, processBuffer } from '@/lib/csvImport'
import { GOLDEN_CASES, GOLDEN_HEADERS } from './golden1791.cases'
import expected from './golden1791.expected.json'

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function toBuffer(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s)
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

describe('existing sources are unchanged (#1791 golden)', () => {
  it.each(GOLDEN_CASES.map((c) => [c.name, c] as const))('%s', (name, c) => {
    const r = processBuffer(toBuffer(c.csv), { source: c.source, headerMap: c.headerMap })
    const got = {
      source: r.source,
      rows: r.rows.map((x) => ({ ...x, date: ymd(x.date) })),
      errors: r.errors,
      warnings: r.warnings,
      stats: {
        ...r.stats,
        dateRange: r.stats.dateRange && { from: ymd(r.stats.dateRange.from), to: ymd(r.stats.dateRange.to) },
      },
    }
    // JSON round-trip drops `undefined` fields exactly as the recorded file did.
    expect(JSON.parse(JSON.stringify(got))).toEqual((expected.cases as Record<string, unknown>)[name])
    expect(r.missingColumns).toBeUndefined()
  })

  it('detectSource gives the same label for the pre-#1791 header sets', () => {
    expect(GOLDEN_HEADERS.map((h) => detectSource(h))).toEqual(expected.headers)
  })
})
