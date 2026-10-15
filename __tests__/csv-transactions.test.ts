import { describe, it, expect } from 'vitest'
import {
  buildExportFilename,
  buildTransactionsCsv,
  exportLabelsFor,
  type ExportLedgerRow,
} from '@/lib/csv/transactions'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'

const ZH_LABELS = exportLabelsFor(zhTW)
const EN_LABELS = exportLabelsFor(en)

const BOM = '﻿'

// 2026-05-09 00:00 UTC = 2026-05-09 08:00 Asia/Taipei → '2026-05-09'
const SAMPLE = new Date('2026-05-09T00:00:00.000Z')
// 2026-05-09 23:00 UTC = 2026-05-10 07:00 Asia/Taipei → '2026-05-10' (proves TZ logic)
const SAMPLE_LATE_UTC = new Date('2026-05-09T23:00:00.000Z')

const expense = (over: Partial<ExportLedgerRow> = {}): ExportLedgerRow => ({
  kind: 'expense',
  date: '2026-05-09',
  description: 'coffee',
  amount: 120,
  currency: 'twd',
  originalAmount: null,
  originalCurrency: null,
  category: 'dining',
  personName: 'Ray',
  toName: undefined,
  shares: { mine: 50, theirs: 50 },
  status: 'settled',
  notes: null,
  chapter: { startDate: '2026-01-01', endDate: '2026-05-01', partnerName: 'Pat' },
  ...over,
})

// Column positions, in the order of csvExport.columns.
const COL = {
  type: 0, date: 1, description: 2, amount: 3, currency: 4, originalAmount: 5,
  originalCurrency: 6, category: 7, person: 8, settlementTo: 9, myShare: 10,
  theirShare: 11, status: 12, notes: 13, chapter: 14,
} as const

/** Parse the CSV body (after the header) into rows of cells, RFC 4180. */
function parse(csv: string): string[][] {
  const text = csv.slice(BOM.length)
  const rows: string[][] = []
  let row: string[] = []
  let i = 0
  while (i < text.length) {
    let v = ''
    if (text[i] === '"') {
      i++
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') { v += '"'; i += 2 }
        else if (text[i] === '"') { i++; break }
        else { v += text[i]; i++ }
      }
    } else {
      while (i < text.length && text[i] !== ',' && text[i] !== '\r') { v += text[i]; i++ }
    }
    row.push(v)
    if (text[i] === ',') { i++; continue }
    if (text[i] === '\r' && text[i + 1] === '\n') { rows.push(row); row = []; i += 2; continue }
  }
  return rows.slice(1)
}

describe('buildTransactionsCsv — shape', () => {
  it('starts with UTF-8 BOM so Excel detects encoding', () => {
    expect(buildTransactionsCsv([], ZH_LABELS).startsWith(BOM)).toBe(true)
  })

  it('emits the header row even when there is nothing to export, in column order', () => {
    const out = buildTransactionsCsv([], ZH_LABELS).slice(BOM.length)
    const c = zhTW.csvExport.columns
    const q = (v: string) => `"${v}"`
    expect(out).toBe(`${[
      c.type, c.date, c.description, c.amount, c.currency, c.originalAmount, c.originalCurrency,
      c.category, c.person, c.settlementTo, c.myShare, c.theirShare, c.status, c.notes, c.chapter,
    ].map(q).join(',')}\r\n`)
    expect(out).toBe('"類型","日期","說明","金額","幣別","原幣金額","原幣別","分類","付款／收款人","給誰（結算）","我的分攤","對方分攤","狀態","備註","章節"\r\n')
  })

  it('uses CRLF line endings', () => {
    const lines = buildTransactionsCsv([expense()], ZH_LABELS).slice(BOM.length).split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('')
  })

  it('an expense line: generated cells plain, text cells quoted', () => {
    const line = buildTransactionsCsv([expense()], ZH_LABELS).slice(BOM.length).split('\r\n')[1]
    expect(line).toBe(
      `"支出",2026-05-09,"coffee",120,"TWD",,"","${zhTW.category.dining}","Ray","",50%,50%,"${zhTW.addSheet.statusSettled}","","2026-01-01 – 2026-05-01・跟 Pat"`,
    )
  })

  it('preserves the order of rows as supplied (the query sorts)', () => {
    const rows = parse(buildTransactionsCsv([
      expense({ description: 'a', date: '2026-01-01' }),
      expense({ description: 'b', date: '2026-02-01' }),
    ], ZH_LABELS))
    expect(rows.map((r) => r[COL.description])).toEqual(['a', 'b'])
  })

  it('does not include a UUID column (only names)', () => {
    const out = buildTransactionsCsv([expense()], ZH_LABELS)
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })
})

describe('buildTransactionsCsv — the three kinds', () => {
  it('income: its own type label, the source as description, the recipient, income category label, no shares, no status', () => {
    const [r] = parse(buildTransactionsCsv([expense({
      kind: 'income', description: '公司薪水', category: 'salary', personName: '小明',
      shares: null, status: null,
    })], ZH_LABELS))
    expect(r[COL.type]).toBe('進帳')
    expect(r[COL.description]).toBe('公司薪水')
    expect(r[COL.category]).toBe(zhTW.incomeCategory.salary)
    expect(r[COL.person]).toBe('小明')
    expect(r[COL.settlementTo]).toBe('')
    expect([r[COL.myShare], r[COL.theirShare], r[COL.status]]).toEqual(['', '', ''])
  })

  it('settlement: from → to, the note, no category / shares / status', () => {
    const [r] = parse(buildTransactionsCsv([expense({
      kind: 'settlement', description: null, category: null, personName: '小明', toName: '小華',
      shares: null, status: null, notes: '六月結清',
    })], ZH_LABELS))
    expect(r[COL.type]).toBe('結算')
    expect(r[COL.description]).toBe('')
    expect(r[COL.category]).toBe('')
    expect(r[COL.person]).toBe('小明')
    expect(r[COL.settlementTo]).toBe('小華')
    expect(r[COL.notes]).toBe('六月結清')
  })

  it('pending expense shows the pending status label', () => {
    const [r] = parse(buildTransactionsCsv([expense({ status: 'pending' })], ZH_LABELS))
    expect(r[COL.status]).toBe(zhTW.addSheet.statusPending)
  })

  it('a person the chapter recorded no name for shows 「對方」, never blank', () => {
    const [r] = parse(buildTransactionsCsv([expense({
      kind: 'settlement', personName: null, toName: null, shares: null, status: null,
      chapter: { startDate: '2026-01-01', endDate: null, partnerName: null },
    })], ZH_LABELS))
    expect(r[COL.person]).toBe(zhTW.common.partner)
    expect(r[COL.settlementTo]).toBe(zhTW.common.partner)
    expect(r[COL.chapter]).toBe(`2026-01-01 – 至今・跟 ${zhTW.common.partner}`)
  })

  it('unknown shares are blank cells, not 0', () => {
    const [r] = parse(buildTransactionsCsv([expense({ shares: null })], ZH_LABELS))
    expect([r[COL.myShare], r[COL.theirShare]]).toEqual(['', ''])
  })

  it('shares are percents, mine then theirs', () => {
    const [r] = parse(buildTransactionsCsv([expense({ shares: { mine: 30, theirs: 70 } })], ZH_LABELS))
    expect([r[COL.myShare], r[COL.theirShare]]).toEqual(['30%', '70%'])
  })

  it('currency columns: base currency and original currency as upper-case codes, original amount plain', () => {
    const line = buildTransactionsCsv([expense({ originalAmount: 3000, originalCurrency: 'jpy' })], ZH_LABELS)
      .slice(BOM.length).split('\r\n')[1]
    expect(line).toContain(',"TWD",3000,"JPY",')
  })

  it('a solo chapter shows the solo label', () => {
    const [r] = parse(buildTransactionsCsv([expense({
      chapter: { startDate: '2026-01-01', endDate: '2026-02-01', partnerName: undefined },
    })], ZH_LABELS))
    expect(r[COL.chapter]).toBe(`2026-01-01 – 2026-02-01・${zhTW.pastTimes.soloLabel}`)
  })

  it('a name holding replacement patterns ($&, $1) is written literally', () => {
    const [r] = parse(buildTransactionsCsv([expense({
      chapter: { startDate: '2026-01-01', endDate: null, partnerName: 'A$&B$1' },
    })], ZH_LABELS))
    expect(r[COL.chapter]).toBe('2026-01-01 – 至今・跟 A$&B$1')
  })

  it('every locale has a label for every column and type', () => {
    for (const t of [zhTW, zhCN, en, ja]) {
      for (const v of Object.values(t.csvExport.columns)) expect(v.trim()).not.toBe('')
      for (const v of Object.values(t.csvExport.types)) expect(v.trim()).not.toBe('')
      expect(t.csvExport.chapter).toContain('{start}')
      expect(t.csvExport.chapter).toContain('{end}')
      expect(t.csvExport.chapter).toContain('{who}')
    }
  })
})

describe('buildTransactionsCsv — escaping', () => {
  it('escapes commas, quotes and newlines per RFC 4180', () => {
    const line = buildTransactionsCsv([expense({ description: 'bread, butter', notes: 'said "thanks"\nand smiled' })], ZH_LABELS)
      .slice(BOM.length).split('\r\n').slice(1).join('\r\n')
    expect(line).toContain('"bread, butter"')
    expect(line).toContain('"said ""thanks""\nand smiled"')
  })

  const leading = ['=', '+', '-', '@', '＝', '＋', '－', '＠']
  const prefixes = ['', ' ', '  ', '\t', '\n', '\r\n', ' ', '　', '​', '﻿', '  \n ']

  for (const ch of leading) {
    for (const pre of prefixes) {
      const value = `${pre}${ch}SUM(1,2)`
      it(`prefixes ' to ${JSON.stringify(value)} in every text column of every kind`, () => {
        const rows: ExportLedgerRow[] = [
          expense({ description: value, notes: value, personName: value, category: value,
            chapter: { startDate: '2026-01-01', endDate: null, partnerName: value } }),
          // income: the source is the description
          expense({ kind: 'income', description: value, category: value, personName: value, shares: null, status: null }),
          // settlement: the note (an outing's fold carries its name here), both people
          expense({ kind: 'settlement', description: null, category: null, notes: value, personName: value,
            toName: value, shares: null, status: null }),
        ]
        const [e, i, s] = parse(buildTransactionsCsv(rows, EN_LABELS))
        for (const cell of [e[COL.description], e[COL.notes], e[COL.person], e[COL.category], i[COL.description],
          i[COL.category], i[COL.person], s[COL.notes], s[COL.person], s[COL.settlementTo]]) {
          expect(cell).toBe(`'${value}`)
        }
        // The chapter cell starts with a date; the name inside it is not at the start.
        expect(e[COL.chapter].startsWith('2026-01-01')).toBe(true)
      })
    }
  }

  it('a chapter cell that would start with a formula character is neutralised', () => {
    const labels = { ...EN_LABELS, chapter: { ...EN_LABELS.chapter, template: '{who} {start}' } }
    const [r] = parse(buildTransactionsCsv([expense({
      chapter: { startDate: '2026-01-01', endDate: null, partnerName: 'x' },
    })], { ...labels, chapter: { ...labels.chapter, withPartner: '=HYPERLINK("{partner}")' } }))
    expect(r[COL.chapter].startsWith("'=")).toBe(true)
  })

  it('prefixes a cell that starts with a tab or CR even without a formula character', () => {
    const [r] = parse(buildTransactionsCsv([expense({ description: '\tplain', notes: '\rplain' })], EN_LABELS))
    expect(r[COL.description]).toBe("'\tplain")
    expect(r[COL.notes]).toBe("'\rplain")
  })

  it('leaves ordinary text alone — including a minus in the middle', () => {
    const [r] = parse(buildTransactionsCsv([expense({ description: 'A-B trip', notes: 'x = y' })], EN_LABELS))
    expect(r[COL.description]).toBe('A-B trip')
    expect(r[COL.notes]).toBe('x = y')
  })

  it('a malformed date is treated as text, not left raw', () => {
    const [r] = parse(buildTransactionsCsv([expense({ date: '=1+1' })], EN_LABELS))
    expect(r[COL.date]).toBe("'=1+1")
  })

  it('escapes quotes inside a neutralised cell', () => {
    const line = buildTransactionsCsv([expense({ description: '=CONCAT("a")' })], EN_LABELS).slice(BOM.length)
    expect(line).toContain(`"'=CONCAT(""a"")"`)
  })
})

describe('buildExportFilename', () => {
  it('appends Asia/Taipei date in YYYY-MM-DD form', () => {
    expect(buildExportFilename('futari-transactions', SAMPLE)).toBe('futari-transactions-2026-05-09.csv')
  })

  it('uses Taipei calendar date for late-UTC instants', () => {
    expect(buildExportFilename('futari-transactions', SAMPLE_LATE_UTC)).toBe('futari-transactions-2026-05-10.csv')
  })
})
