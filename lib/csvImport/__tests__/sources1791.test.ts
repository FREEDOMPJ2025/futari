/**
 * #1791 — dedicated mappers for AndroMoney, まねーぼ (Manebo) and Splitwise.
 *
 * Every file under fixtures/1791 is a sample in the documented shape of that
 * app's export (see the research notes in the issue), run through the real
 * `processFile` the wizard calls. Before this, all of them ended in 0 valid
 * rows or in every row imported as an expense.
 *
 * What a failure here looks like in production: no error. An opening balance,
 * a transfer or a Splitwise settle-up is imported as spending, or a whole file
 * lands in the "no rows we can import" message with no hint of why.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decodeBytes,
  detectCsvSource,
  detectSource,
  parseCsvText,
  parseHintsFor,
  processFile,
  type DetectedSource,
  type ProcessResult,
} from '@/lib/csvImport'
import {
  ANDROMONEY_HEADERS,
  ANDROMONEY_LABELS,
  MANEBO_HEADERS,
  MANEBO_LABELS,
  normalizeHeader,
} from '@/lib/csvImport/headerAliases'

const FIXTURES = resolve(__dirname, 'fixtures/1791')

function bytesOf(name: string): Buffer {
  return readFileSync(resolve(FIXTURES, name))
}

async function run(name: string, source: DetectedSource): Promise<ProcessResult> {
  return processFile(new File([new Uint8Array(bytesOf(name))], name, { type: 'text/csv' }), { source })
}

async function runText(text: string, source: DetectedSource, name = 'x.csv'): Promise<ProcessResult> {
  return processFile(new File([text], name, { type: 'text/csv' }), { source })
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The parts of a row the user would notice. */
interface Brief { date: string; amount: number; type: string; cur?: string }
function brief(r: ProcessResult): Brief[] {
  return r.rows.map((x) => ({
    date: ymd(x.date),
    amount: x.amount,
    type: x.type,
    ...(x.originalCurrency ? { cur: x.originalCurrency } : {}),
  }))
}

const ANDRO_ROWS = [
  { date: '2026-09-15', amount: 120, type: 'expense' },
  { date: '2026-09-05', amount: 45000, type: 'income' },
  // 18.5 EUR: the shared `parseAmount` rounds to a whole number, same as every other source.
  { date: '2026-09-17', amount: 19, type: 'expense', cur: 'EUR' },
]
const ANDRO_ERRORS = [
  { rowIndex: 0, errors: ['row 1: opening balance rows are not imported'] },
  { rowIndex: 3, errors: ['row 4: transfer rows are not imported'] },
]
const MANEBO_ROWS = [
  { date: '2026-09-12', amount: 100000, type: 'income' },
  { date: '2026-09-15', amount: 1200, type: 'expense' },
]
const MANEBO_ERRORS = [{ rowIndex: 2, errors: ['row 3: transfer rows are not imported'] }]
const SPLITWISE_ROWS_RECENT = [
  { date: '2026-09-02', amount: 60, type: 'expense' },
  { date: '2026-09-05', amount: 900, type: 'expense' },
  { date: '2026-09-12', amount: 15000, type: 'expense' },
]
const SPLITWISE_ERRORS_RECENT = [
  { rowIndex: 2, errors: ['row 3: settle-up (Payment) rows are not imported'] },
  { rowIndex: 4, errors: ['row 5: Total balance row is not imported'] },
]
const SPLITWISE_ROWS_2018 = [
  { date: '2018-07-31', amount: 60, type: 'expense' },
  { date: '2018-08-05', amount: 900, type: 'expense' },
]

describe('per-sample results through processFile (the numbers a user sees)', () => {
  const cases: {
    file: string
    source: DetectedSource
    total: number
    rows: Brief[]
    errors: { rowIndex: number; errors: string[] }[]
  }[] = [
    ...['andromoney_googledocs_utf8_zh', 'andromoney_googledocs_utf8_en', 'andromoney_winexcel_big5_zh', 'andromoney_winexcel_big5_en'].map(
      (f) => ({ file: `${f}.csv`, source: 'andromoney' as const, total: 5, rows: ANDRO_ROWS, errors: ANDRO_ERRORS }),
    ),
    ...['manebo_en_utf8', 'manebo_ja_utf8', 'manebo_ja_sjis', 'manebo_zhHant_utf8'].map(
      (f) => ({ file: `${f}.csv`, source: 'manebo' as const, total: 3, rows: MANEBO_ROWS, errors: MANEBO_ERRORS }),
    ),
    ...['splitwise_recent', 'splitwise_recent_crlf_bom'].map(
      (f) => ({ file: `${f}.csv`, source: 'splitwise' as const, total: 5, rows: SPLITWISE_ROWS_RECENT, errors: SPLITWISE_ERRORS_RECENT }),
    ),
    {
      // Blank lines are dropped by the parser: header, [blank], 3 rows, [blank], Total balance.
      file: 'splitwise_2018_blankline.csv',
      source: 'splitwise',
      total: 4,
      rows: SPLITWISE_ROWS_2018,
      errors: [
        { rowIndex: 2, errors: ['row 3: settle-up (Payment) rows are not imported'] },
        { rowIndex: 3, errors: ['row 4: Total balance row is not imported'] },
      ],
    },
    {
      // `,,,,,,` is a row of empty cells, not a blank line: it counts, and fails on its own.
      file: 'splitwise_2018_commarow.csv',
      source: 'splitwise',
      total: 5,
      rows: SPLITWISE_ROWS_2018,
      errors: [
        {
          rowIndex: 0,
          errors: [
            'row 1: missing or unparseable date',
            'row 1: missing or unparseable amount',
            'row 1: missing transaction type (expense/income)',
          ],
        },
        { rowIndex: 3, errors: ['row 4: settle-up (Payment) rows are not imported'] },
        { rowIndex: 4, errors: ['row 5: Total balance row is not imported'] },
      ],
    },
  ]

  it.each(cases)('$file as $source', async ({ file, source, total, rows, errors }) => {
    const r = await run(file, source)
    expect(r.source).toBe(source)
    expect(r.missingColumns).toBeUndefined()
    expect(r.stats.total).toBe(total)
    expect(r.stats.valid).toBe(rows.length)
    expect(r.stats.invalid).toBe(errors.length)
    expect(brief(r)).toEqual(rows)
    expect(r.errors).toEqual(errors)
  })

  it('keeps the descriptions the files carry (full-width comma, kana, Chinese)', async () => {
    expect((await run('andromoney_googledocs_utf8_zh.csv', 'andromoney')).rows.map((x) => x.description))
      .toEqual(['便當，加蛋', '薪水', 'Pasta'])
    expect((await run('manebo_ja_sjis.csv', 'manebo')).rows.map((x) => x.description)).toEqual(['', 'ランチ'])
  })

  it('maps a Chinese food category to dining via the existing synonyms', async () => {
    const r = await run('manebo_zhHant_utf8.csv', 'manebo')
    expect(r.rows[1]!.category).toBe('dining')
  })
})

describe('AndroMoney details', () => {
  it('reads a file whose banner line was already removed', async () => {
    const text = bytesOf('andromoney_googledocs_utf8_en.csv').toString('utf8').split('\n').slice(1).join('\n')
    const r = await runText(text, 'andromoney')
    expect(r.stats.total).toBe(5)
    expect(brief(r)).toEqual(ANDRO_ROWS)
  })

  it('falls back to column position when the titles are in another app language (German sample)', async () => {
    const header =
      '"Id","Währungsorte","Betrag","Kategorie","Unterkategorie","Datum","Ausgaben","Einnahmen","Bemerkung","Periodic","Projekt","Payer/Zahlungsempfänger","uid","Zeit"'
    const lines = bytesOf('andromoney_googledocs_utf8_en.csv').toString('utf8').split('\n')
    const r = await runText([lines[0], header, ...lines.slice(2)].join('\n'), 'andromoney')
    expect(r.missingColumns).toBeUndefined()
    expect(brief(r)).toEqual(ANDRO_ROWS)
  })

  it('imports a 1000+ amount written with a thousands separator', async () => {
    const lines = bytesOf('andromoney_googledocs_utf8_en.csv').toString('utf8').split('\n')
    const row = '"9","TWD","1,250","Food","Lunch","20260920","Cash","","","","","","u",""'
    const r = await runText([lines[0], lines[1], row].join('\n'), 'andromoney')
    expect(brief(r)).toEqual([{ date: '2026-09-20', amount: 1250, type: 'expense' }])
  })

  it('leaves a row with neither account filled to the validator', async () => {
    const lines = bytesOf('andromoney_googledocs_utf8_en.csv').toString('utf8').split('\n')
    const row = '"9","TWD","100","Food","Lunch","20260920","","","","","","","u",""'
    const r = await runText([lines[0], lines[1], row].join('\n'), 'andromoney')
    expect(r.rows).toEqual([])
    expect(r.errors[0]!.errors).toContain('row 1: missing transaction type (expense/income)')
  })

  it('reports the missing columns of a file that is not an AndroMoney export, and maps nothing', async () => {
    const r = await runText('Date,Cost,Currency,Alice\n2026-01-01,10,TWD,5\n', 'andromoney')
    expect(r.missingColumns).toEqual(['Amount', 'Expense(Transfer Out)', 'Income(Transfer In)'])
    expect(r.rows).toEqual([])
    expect(r.errors).toEqual([])
  })
})

describe('the CWMoney button on an AndroMoney file fails safe', () => {
  it.each([
    'andromoney_googledocs_utf8_zh.csv',
    'andromoney_googledocs_utf8_en.csv',
    'andromoney_winexcel_big5_zh.csv',
    'andromoney_winexcel_big5_en.csv',
  ])('%s: 0 valid rows, so no opening balance, income or transfer becomes an expense', async (f) => {
    const r = await run(f, 'cwmoney')
    expect(r.source).toBe('cwmoney')
    expect(r.stats.valid).toBe(0)
    expect(r.rows).toEqual([])
  })
})

describe('missing required columns are named, not swallowed into "no valid rows"', () => {
  it('まねーぼ file whose 種別 column was renamed', async () => {
    const text = bytesOf('manebo_ja_utf8.csv').toString('utf8').replace('種別', '区分')
    const r = await runText(text, 'manebo')
    // The file is Japanese, so the column is named the way the file would name it (#1799).
    expect(r.missingColumns).toEqual(['Type（種別）'])
    expect(r.rows).toEqual([])
    expect(r.errors).toEqual([])
  })

  it('AndroMoney 繁中 file without the two account columns: names them in 繁中', async () => {
    const r = await runText('Id,幣別,金額,日期\n1,TWD,5,20260901\n', 'andromoney')
    expect(r.missingColumns).toEqual([
      'Expense(Transfer Out)（付款(轉出)）',
      'Income(Transfer In)（收款(轉入)）',
    ])
  })

  it('AndroMoney 简中 file: names them in 简中, not 繁中', async () => {
    const r = await runText('Id,币别,金额,日期\n1,TWD,5,20260901\n', 'andromoney')
    expect(r.missingColumns).toEqual([
      'Expense(Transfer Out)（付款(转出)）',
      'Income(Transfer In)（收款(转入)）',
    ])
  })

  it('AndroMoney English file: English names only', async () => {
    const r = await runText('Id,Currency,Amount,Date\n1,TWD,5,20260901\n', 'andromoney')
    expect(r.missingColumns).toEqual(['Expense(Transfer Out)', 'Income(Transfer In)'])
  })

  it('まねーぼ 繁中 file: names the missing column in 繁中', async () => {
    const text = bytesOf('manebo_zhHant_utf8.csv').toString('utf8').replace('類型', '種類')
    const r = await runText(text, 'manebo')
    expect(r.missingColumns).toEqual(['Type（類型）'])
  })

  it('a title row whose language cannot be told apart keeps the English names', async () => {
    // 日期 is both 繁中 and 简中; 金額 is both 日本語 and 繁中 — nothing decides.
    expect((await runText('日期\n2026-01-01\n', 'andromoney')).missingColumns)
      .toEqual(['Amount', 'Expense(Transfer Out)', 'Income(Transfer In)'])
    expect((await runText('金額\n100\n', 'manebo')).missingColumns).toEqual(['Date', 'Type'])
  })

  it('a title row in a language we have no names for keeps the English names', async () => {
    const r = await runText('Datum,Typ,Betrag\n2026-01-01,x,1\n', 'manebo')
    expect(r.missingColumns).toEqual(['Date', 'Type', 'Amount'])
  })

  it('Splitwise picked for a file with no Cost column', async () => {
    const r = await runText('Date,Description,Amount\n2026-01-01,x,10\n', 'splitwise')
    expect(r.missingColumns).toEqual(['Cost'])
  })

  it('a header-only file is still the plain empty result', async () => {
    const r = await runText('日付,区分,金額\n', 'manebo')
    expect(r.missingColumns).toBeUndefined()
    expect(r.stats.total).toBe(0)
  })

  it('no source other than the three new ones ever sets missingColumns', async () => {
    const r = await runText('foo,bar\n1,2\n', 'cwmoney')
    expect(r.missingColumns).toBeUndefined()
  })
})

describe('detectCsvSource / detectSource (new signatures run before CWMoney)', () => {
  const ANDRO_ZH = ['Id', '幣別', '金額', '分類', '子分類', '日期', '付款(轉出)', '收款(轉入)', '備註', '週期', '專案', '商家(公司)', 'uid', '時間']
  const ANDRO_EN = ['Id', 'Currency', 'Amount', 'Category', 'Sub-Category', 'Date', 'Expense(Transfer Out)', 'Income(Transfer In)', 'Note', 'Periodic', 'Project', 'Payee/Payer', 'uid', 'Time']
  const MANEBO_JA = ['日付', '種別', '金額', 'カテゴリ', 'サブカテゴリ', 'アカウント / 振込元', '振替先', 'メモ']
  const MANEBO_EN = ['Date', 'Type', 'Amount', 'Category', 'Sub Category', 'Account / From', 'To', 'Note']
  const MANEBO_ZH = ['日期', '類型', '金額', '類別', '子類別', '帳戶 / 來源', '目的地', '備註']
  const MANEBO_PT = ['Data', 'Tipo', 'Valor', 'Categoria', 'Subcategoria', 'Conta / De', 'Para', 'Nota']

  it('AndroMoney zh-TW and en', () => {
    expect(detectCsvSource(ANDRO_ZH)).toBe('andromoney')
    expect(detectSource(ANDRO_ZH)).toBe('andromoney')
    expect(detectCsvSource(ANDRO_EN)).toBe('andromoney')
  })

  it('AndroMoney zh-TW is not CWMoney even though it has 日期 and 金額', () => {
    expect(detectCsvSource(ANDRO_ZH)).not.toBe('cwmoney')
  })

  it.each([
    ['ja', MANEBO_JA], ['en', MANEBO_EN], ['zh-Hant', MANEBO_ZH], ['pt', MANEBO_PT],
  ])('まねーぼ %s', (_l, h) => {
    expect(detectCsvSource(h)).toBe('manebo')
  })

  it('まねーぼ zh-Hant is not CWMoney even though it has 日期 and 金額', () => {
    expect(detectCsvSource(MANEBO_ZH)).not.toBe('cwmoney')
  })

  it('Splitwise needs Cost + Currency and no Amount', () => {
    expect(detectCsvSource(['Date', 'Description', 'Category', 'Cost', 'Currency', 'Alice', 'Bob'])).toBe('splitwise')
    expect(detectCsvSource(['Date', 'Description', 'Cost', 'Currency', 'Amount'])).toBeNull()
  })

  it('CWMoney keeps its own headers', () => {
    expect(detectCsvSource(['日期', '類別', '項目', '金額', '帳戶'])).toBe('cwmoney')
    expect(detectSource(['日期', '類別', '項目', '金額', '帳戶'])).toBe('cwmoney')
  })

  it('whole-header comparison: To / Total, and a lone Type, do not make a まねーぼ', () => {
    expect(detectCsvSource(['Date', 'Type', 'Amount', 'Total', 'Account / From'])).toBeNull()
    expect(detectCsvSource(['Date', 'Type', 'Amount', 'To'])).toBeNull()
    // Spendee has a Type column and must stay Spendee.
    expect(detectCsvSource(['Date', 'Wallet', 'Type', 'Category name', 'Amount', 'Currency', 'Note'])).toBe('spendee')
  })

  it('headers are compared trimmed and lowercased', () => {
    expect(detectCsvSource([' DATE ', ' type', 'AMOUNT', ' account / from ', 'TO'])).toBe('manebo')
  })
})

describe('encoding and banner hints apply only to the source the user chose', () => {
  it('parseHintsFor knows exactly two sources', () => {
    expect(parseHintsFor('andromoney')).toEqual({ skipBanner: true })
    expect(parseHintsFor('manebo')).toEqual({ legacyEncoding: 'shift_jis' })
    for (const s of ['cwmoney', 'honeydue', 'spendee', 'splitwise', 'generic', 'constructor', undefined, null]) {
      expect(parseHintsFor(s)).toEqual({})
    }
  })

  it('Shift_JIS bytes decode as Shift_JIS with the まねーぼ hint, and as Big5 mojibake without it', () => {
    const buf = new Uint8Array(bytesOf('manebo_ja_sjis.csv')).buffer
    const withHint = decodeBytes(buf, parseHintsFor('manebo'))
    expect(withHint.encoding).toBe('shift_jis')
    expect(withHint.text.startsWith('日付,種別,金額')).toBe(true)
    const without = decodeBytes(buf)
    expect(without.encoding).toBe('big5')
    expect(without.text.startsWith('日付,種別')).toBe(false)
  })

  it('the hint does not touch UTF-8 or Big5 files', () => {
    const utf8 = new Uint8Array(bytesOf('manebo_ja_utf8.csv')).buffer
    expect(decodeBytes(utf8, parseHintsFor('manebo')).encoding).toBe('utf-8')
    const big5 = new Uint8Array(bytesOf('andromoney_winexcel_big5_zh.csv')).buffer
    expect(decodeBytes(big5, parseHintsFor('andromoney')).encoding).toBe('big5')
  })

  it('the banner line is skipped only when asked, and only if it is the AndroMoney banner', () => {
    const text = bytesOf('andromoney_googledocs_utf8_en.csv').toString('utf8')
    expect(parseCsvText(text).headers).toEqual(['Google Documents', 'AndroMoney', '20261001'])
    expect(parseCsvText(text, { skipBanner: true }).headers[1]).toBe('Currency')
    const plain = 'Date,Amount\n2026-01-01,5\n'
    expect(parseCsvText(plain, { skipBanner: true })).toEqual(parseCsvText(plain))
    // A different first line is not a banner: nothing is dropped.
    expect(parseCsvText('"Windows Excel","Other","1"\nA,B,C\n', { skipBanner: true }).headers[0]).toBe('Windows Excel')
  })
})

describe('the names used to report a missing column are names the mapper accepts (#1799)', () => {
  it.each([
    ['AndroMoney', ANDROMONEY_LABELS, ANDROMONEY_HEADERS],
    ['まねーぼ', MANEBO_LABELS, MANEBO_HEADERS],
  ] as const)('%s: every label is one of the aliases of its column', (_n, labels, headers) => {
    expect(Object.keys(labels).sort()).toEqual(Object.keys(headers).sort())
    for (const [key, byLang] of Object.entries(labels)) {
      const aliases = (headers as Record<string, readonly string[]>)[key]!
      for (const name of Object.values(byLang as Record<string, string>)) {
        expect(aliases, `${key}: ${name}`).toContain(normalizeHeader(name))
      }
    }
  })
})
