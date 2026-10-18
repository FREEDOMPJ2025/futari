/**
 * #1801 — the anonymous /migrate preview card reads its numbers through the
 * same mapper the import wizard uses, instead of guessing from raw columns.
 *
 * Failure looks like: the card for an AndroMoney / まねーぼ / Splitwise file says
 * 約 0 筆支出, shows a range starting in the year 1010 (or none), or lists
 * "SYSTEM" / "Payment" as a favourite category. Nothing errors; the numbers are
 * just wrong.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderHook, act, waitFor } from '@testing-library/react'
import { NOT_A_CSV_TABLE, useCsvPreview } from '@/lib/migrate/useCsvPreview'
import { processBuffer, type DetectedSource, type MigrateSource } from '@/lib/csvImport'
import { GOLDEN_CASES } from '@/lib/csvImport/__tests__/golden1791.cases'
import before from '@/lib/csvImport/__tests__/previewGolden1801.before.json'

const FIXTURES = resolve(__dirname, '../lib/csvImport/__tests__/fixtures/1791')

async function preview(bytes: Uint8Array<ArrayBufferLike> | string, hint: MigrateSource) {
  const { result } = renderHook(() => useCsvPreview({ hint }))
  await act(async () => { await result.current.load(new File([bytes as BlobPart], 'export.csv', { type: 'text/csv' })) })
  await waitFor(() => expect(result.current.status).toBe('ready'))
  return { source: result.current.detectedSource, stats: result.current.stats! }
}

/** For files expected to end in the error state (#1528 A6). */
async function previewError(bytes: Uint8Array<ArrayBufferLike> | string, hint: MigrateSource) {
  const { result } = renderHook(() => useCsvPreview({ hint }))
  await act(async () => { await result.current.load(new File([bytes as BlobPart], 'export.csv', { type: 'text/csv' })) })
  await waitFor(() => expect(result.current.status).toBe('error'))
  return result.current
}

interface Expected {
  total: number
  expense: number
  range: { first: string; last: string } | null
  categories: [string, number][]
}

// What the wizard would import from each file (see tests/import-sources-1791):
// AndroMoney drops the opening balance and the transfer; まねーぼ drops the
// transfer; Splitwise drops the settle-up and the Total balance footer.
const ANDRO: Expected = {
  total: 5, expense: 2,
  range: { first: '2026-09-05', last: '2026-09-17' },
  categories: [['飲食', 1], ['收入', 1], ['Food', 1]],
}
const MANEBO = (salary: string, food: string): Expected => ({
  total: 3, expense: 1,
  range: { first: '2026-09-12', last: '2026-09-15' },
  categories: [[salary, 1], [food, 1]],
})
const SPLIT = (total: number, range: Expected['range'], cats: [string, number][]): Expected =>
  ({ total, expense: cats.length, range, categories: cats })

const FIXTURE_CASES: [string, MigrateSource, Expected][] = [
  ['andromoney_googledocs_utf8_zh.csv', 'andromoney', ANDRO],
  ['andromoney_googledocs_utf8_en.csv', 'andromoney', ANDRO],
  ['andromoney_winexcel_big5_zh.csv', 'andromoney', ANDRO],
  ['andromoney_winexcel_big5_en.csv', 'andromoney', ANDRO],
  ['manebo_en_utf8.csv', 'manebo', MANEBO('Salary', 'Food')],
  ['manebo_ja_utf8.csv', 'manebo', MANEBO('給料', '食費')],
  ['manebo_ja_sjis.csv', 'manebo', MANEBO('給料', '食費')],
  ['manebo_zhHant_utf8.csv', 'manebo', MANEBO('薪水', '飲食')],
  ['splitwise_recent.csv', 'splitwise',
    SPLIT(5, { first: '2026-09-02', last: '2026-09-12' }, [['Groceries', 1], ['Dining out', 1], ['Rent', 1]])],
  ['splitwise_recent_crlf_bom.csv', 'splitwise',
    SPLIT(5, { first: '2026-09-02', last: '2026-09-12' }, [['Groceries', 1], ['Dining out', 1], ['Rent', 1]])],
  // 2018 exports write M/D/YY; as strings "8/5/18" sorts before "7/31/18".
  ['splitwise_2018_blankline.csv', 'splitwise',
    SPLIT(4, { first: '2018-07-31', last: '2018-08-05' }, [['Groceries', 1], ['Dining out', 1]])],
  ['splitwise_2018_commarow.csv', 'splitwise',
    SPLIT(5, { first: '2018-07-31', last: '2018-08-05' }, [['Groceries', 1], ['Dining out', 1]])],
]

describe('preview card stats come from the source mapper (#1801)', () => {
  it.each(FIXTURE_CASES)('%s on the %s page', async (name, hint, want) => {
    const { source, stats } = await preview(readFileSync(resolve(FIXTURES, name)), hint)
    expect(source).toBe(hint)
    expect(stats.totalRows).toBe(want.total)
    expect(stats.estimatedExpenseRows).toBe(want.expense)
    expect(stats.dateRange).toEqual(want.range)
    expect(stats.topCategories.map((c) => [c.name, c.count])).toEqual(want.categories)
  })

  it.each(FIXTURE_CASES)('%s: never a range from the 1010 opening-balance sentinel', async (name, hint) => {
    const { stats } = await preview(readFileSync(resolve(FIXTURES, name)), hint)
    expect(JSON.stringify(stats.dateRange)).not.toMatch(/10100101|\b1010/)
  })

  it.each(FIXTURE_CASES)('%s: expense count, range and row count match what the wizard would import', async (name, hint) => {
    const bytes = readFileSync(resolve(FIXTURES, name))
    const { stats } = await preview(bytes, hint)
    const wizard = processBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { source: hint as DetectedSource })
    expect(stats.estimatedExpenseRows).toBe(wizard.rows.filter((r) => r.type === 'expense').length)
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(stats.dateRange).toEqual({ first: ymd(wizard.stats.dateRange!.from), last: ymd(wizard.stats.dateRange!.to) })
    expect(stats.totalRows).toBe(wizard.stats.total)
  })

  it('a mapper row that still carries the sentinel date is counted but never starts the range', async () => {
    const csv = [
      '"Id","Currency","Amount","Category","Sub-Category","Date","Expense(Transfer Out)","Income(Transfer In)","Note"',
      '"1","TWD","100","Food","","10100101","Cash","",""',
      '"2","TWD","200","Food","","20260915","Cash","",""',
    ].join('\n')
    const { stats } = await preview(csv, 'andromoney')
    expect(stats.estimatedExpenseRows).toBe(2)
    expect(stats.dateRange).toEqual({ first: '2026-09-15', last: '2026-09-15' })
  })

  it('a file missing a required column reports its row count and nothing it cannot know', async () => {
    const csv = readFileSync(resolve(FIXTURES, 'manebo_en_utf8.csv'), 'utf8').replace('Type', 'Kind')
    const { stats } = await preview(csv, 'manebo')
    expect(stats).toEqual({ totalRows: 3, estimatedExpenseRows: 0, dateRange: null, topCategories: [] })
  })
})

// #1528 A6: the error state is only for what is not a table at all (one column,
// or no data rows). Failure looks like a preview card over plain text, or, the
// other way, an error for a real CSV the signed-in wizard could have mapped by hand.
describe('only non-tables end in the error state (#1528 A6)', () => {
  it.each(['honeydue', 'cwmoney', 'unknown'] as const)('two plain text lines on the %s page', async (hint) => {
    const state = await previewError('hello there\nthis is not a ledger', hint)
    expect(state.error).toBe(NOT_A_CSV_TABLE)
  })

  it('an empty file', async () => {
    await previewError('', 'honeydue')
  })

  it('a header row and no records', async () => {
    await previewError('Date,Wallet,Type,Category name,Amount,Currency,Note', 'spendee')
  })

  it('a two-column CSV with headers nobody recognises still previews (the wizard can map columns)', async () => {
    const { stats } = await preview(['Foo,Bar', 'a,1', 'b,2'].join('\n'), 'honeydue')
    expect(stats.totalRows).toBe(2)
    expect(stats.estimatedExpenseRows).toBe(0)
  })
})

// Existing sources: what the card said before this change, recorded from the
// code at e44d691 (legacy column-name heuristic) for every golden1791 input,
// once per page that can receive it. Anything not listed in IMPROVED must be
// byte-identical to that recording.
const hintFor = (source: string | undefined): MigrateSource =>
  source === 'honeydue' || source === 'spendee' || source === 'cwmoney' ? source : 'unknown'

type Snapshot = { source: string; stats: unknown }
const recorded = before as unknown as Record<string, Snapshot>

/** key = `${case name}:${page hint}`. Each is a number that was wrong before. */
const IMPROVED: Record<string, { stats: Expected; why: string }> = {
  'honeydue, picked:honeydue': {
    why: 'raw-string range ran from "1/15/2026" to "not-a-date" and the invalid row\'s category was counted',
    stats: { total: 5, expense: 3, range: { first: '2026-01-15', last: '2026-01-21' },
      categories: [['Groceries', 1], ['Food & Dining', 1], ['Income', 1], ['Shopping', 1]] },
  },
  'honeydue, auto-detected:unknown': {
    why: 'same numbers; the range is now the parsed date (2026-02-03), not Honeydue\'s raw M/D/YYYY text',
    stats: { total: 1, expense: 1, range: { first: '2026-02-03', last: '2026-02-03' }, categories: [['Rent', 1]] },
  },
  'honeydue, auto-detected:icost': {
    why: 'same as above, on a screenshot-workflow page',
    stats: { total: 1, expense: 1, range: { first: '2026-02-03', last: '2026-02-03' }, categories: [['Rent', 1]] },
  },
  'spendee, picked (transfer row, currency):spendee': {
    why: 'Spendee amounts are positive (0 expenses before); the Transfer row is no longer a category',
    stats: { total: 4, expense: 2, range: { first: '2026-01-15', last: '2026-02-03' },
      categories: [['Coffee', 1], ['Salary', 1], ['Travel', 1]] },
  },
  'cwmoney, picked (中文 headers):cwmoney': {
    why: 'CWMoney amounts are positive (0 expenses before); range was "2026-03-03 ~ 20260302" by string compare',
    stats: { total: 3, expense: 3, range: { first: '2026-03-01', last: '2026-03-03' },
      categories: [['飲食', 1], ['交通', 1], ['居住', 1]] },
  },
  'cwmoney, auto-detected (日期 + 金額):unknown': {
    why: 'positive CWMoney amount was 0 expenses before',
    stats: { total: 1, expense: 1, range: { first: '2026-03-05', last: '2026-03-05' }, categories: [['娛樂', 1]] },
  },
  'cwmoney, auto-detected (日期 + 金額):icost': {
    why: 'positive CWMoney amount was 0 expenses before',
    stats: { total: 1, expense: 1, range: { first: '2026-03-05', last: '2026-03-05' }, categories: [['娛樂', 1]] },
  },
  'cwmoney, i_* schema:cwmoney': {
    why: 'i_date (Unix ms) and i_kind were not in the guessed column names: no range, no categories before',
    stats: { total: 2, expense: 1, range: { first: '2026-03-01', last: '2026-03-02' }, categories: [['飲食', 1], ['薪水', 1]] },
  },
  'futari_generic via generic button:unknown': {
    why: '`kind` decides expense/income (0 expenses before, from the amount sign); the transfer row is out',
    stats: { total: 4, expense: 2, range: { first: '2026-04-01', last: '2026-04-03' }, categories: [['dining', 2], ['other', 1]] },
  },
  'futari_generic via generic button:icost': {
    why: 'same file on a screenshot-workflow page',
    stats: { total: 4, expense: 2, range: { first: '2026-04-01', last: '2026-04-03' }, categories: [['dining', 2], ['other', 1]] },
  },
}

describe('existing sources keep their numbers, or get better ones (#1801 golden)', () => {
  const pages = (c: (typeof GOLDEN_CASES)[number]): MigrateSource[] => {
    const h = hintFor(c.source)
    return h === 'unknown' ? ['unknown', 'icost'] : [h]
  }
  const cases = GOLDEN_CASES.flatMap((c) => pages(c).map((hint) => [`${c.name}:${hint}`, c, hint] as const))

  it('recording covers every case', () => {
    expect(Object.keys(recorded).sort()).toEqual(cases.map(([k]) => k).sort())
  })

  it.each(cases)('%s', async (key, c, hint) => {
    if (key === 'header row only:spendee') {
      // No data rows: the error state (#1528 A6), not an empty preview card.
      await previewError(c.csv, hint)
      return
    }
    const { source, stats } = await preview(c.csv, hint)
    const was = recorded[key]!
    // The label on the card is not touched by this change.
    expect(source).toBe(was.source)
    const improved = IMPROVED[key]
    if (!improved) {
      expect(stats).toEqual(was.stats)
      return
    }
    expect(stats).not.toEqual(was.stats)
    expect(stats.totalRows).toBe(improved.stats.total)
    expect(stats.estimatedExpenseRows).toBe(improved.stats.expense)
    expect(stats.dateRange).toEqual(improved.stats.range)
    expect(stats.topCategories.map((x) => [x.name, x.count])).toEqual(improved.stats.categories)
  })
})
