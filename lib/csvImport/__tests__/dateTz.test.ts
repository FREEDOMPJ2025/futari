/**
 * #1793 — the calendar date in the file is the calendar date that gets sent.
 *
 * The mappers return LOCAL-midnight Dates (`new Date(y, m - 1, d)`). The wizard
 * used to turn them into the submit string with `toISOString().slice(0, 10)`,
 * which reads the UTC day: in UTC+8 local midnight 2026-09-15 is
 * 2026-09-14T16:00Z, so every row went out a day early, and 10-01 went out as
 * 09-30 (the previous month). Failure looks like: no error anywhere, the
 * confirm screen and the ledger both show the earlier day.
 *
 * How the zone is chosen: Node re-reads `process.env.TZ` when it is assigned,
 * and vitest runs each test file in its own forked process, so assigning it per
 * test is enough (no TZ=... on the command line, same result locally and in CI).
 * `useZone` asserts the offset it ended up with, so a runtime that ignored the
 * assignment fails loudly instead of passing for the wrong reason.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { processBuffer } from '@/lib/csvImport'
import { localYmd } from '@/lib/local-date'

// [zone, getTimezoneOffset() on 2026-09-15 in minutes]
const ZONES: [string, number][] = [
  ['Asia/Taipei', -480],
  ['Asia/Tokyo', -540],
  ['UTC', 0],
  ['America/Los_Angeles', 420],
]

const originalTz = process.env.TZ
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

function useZone(zone: string, offset: number) {
  process.env.TZ = zone
  expect(new Date(2026, 8, 15).getTimezoneOffset()).toBe(offset)
}

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

/** What ImportContent.buildBatchInput sends for each row. */
const payloadDates = (csv: string, source: Parameters<typeof processBuffer>[1] = {}) =>
  processBuffer(bytes(csv), source).rows.map((r) => localYmd(r.date))

describe.each(ZONES)('import dates in %s (#1793)', (zone, offset) => {
  it('Honeydue M/D/YYYY keeps its calendar day, month starts included', () => {
    useZone(zone, offset)
    const csv = 'Date,Name,Category,Amount,Account\n09/15/2026,A,Groceries,-100,J\n10/01/2026,B,Groceries,-100,J\n01/01/2027,C,Groceries,-100,J\n'
    expect(payloadDates(csv, { source: 'honeydue' })).toEqual(['2026-09-15', '2026-10-01', '2027-01-01'])
  })

  it('Spendee YYYY-MM-DD keeps its calendar day', () => {
    useZone(zone, offset)
    const csv = 'Date,Wallet,Type,Category name,Amount,Currency,Note\n2026-09-15,Cash,Expense,Food,102,TWD,a\n2026-10-01,Cash,Expense,Food,103,TWD,b\n'
    expect(payloadDates(csv, { source: 'spendee' })).toEqual(['2026-09-15', '2026-10-01'])
  })

  it('CWMoney YYYY/MM/DD keeps its calendar day', () => {
    useZone(zone, offset)
    const csv = '日期,類別,項目,金額,帳戶\n2026/09/15,餐飲,a,104,現金\n2026/10/01,餐飲,b,105,現金\n'
    expect(payloadDates(csv, { source: 'cwmoney' })).toEqual(['2026-09-15', '2026-10-01'])
  })

  it('CWMoney Unix ms is the day in the user zone, not the UTC day', () => {
    useZone(zone, offset)
    // 09:30 local on 2026-09-15 and local midnight on 2026-10-01, as instants.
    const morning = new Date(2026, 8, 15, 9, 30).getTime()
    const midnight = new Date(2026, 9, 1).getTime()
    const csv = `i_date,i_kind,i_money,i_type,i_note\n${morning},餐飲,100,0,a\n${midnight},餐飲,100,0,b\n`
    expect(payloadDates(csv, { source: 'cwmoney' })).toEqual(['2026-09-15', '2026-10-01'])
  })

  it('futari_generic (screenshot -> ChatGPT -> CSV) keeps its calendar day', () => {
    useZone(zone, offset)
    const csv = 'date,category,amount,description,currency,kind\n2026-09-15,飲食,150,a,TWD,expense\n2026-10-01,薪水,50000,b,TWD,income\n'
    const out = processBuffer(bytes(csv), { source: 'generic', headerMap: { date: 'Date', amount: 'Amount' } })
    expect(out.source).toBe('futari_generic')
    expect(out.rows.map((r) => localYmd(r.date))).toEqual(['2026-09-15', '2026-10-01'])
  })

  it('OFX and QIF keep their calendar day', () => {
    useZone(zone, offset)
    const ofx = [
      'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '',
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001120000<TRNAMT>-100.00<FITID>1<NAME>x</STMTTRN>',
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n')
    expect(payloadDates(ofx, { source: 'ofx' })).toEqual(['2026-10-01'])
    const qif = '!Type:Bank\nD10/01/2026\nT-100.00\nPx\n^\n'
    expect(payloadDates(qif, { source: 'qif' })).toEqual(['2026-10-01'])
  })
})

describe('localYmd', () => {
  it('formats the local calendar day, zero-padded', () => {
    process.env.TZ = 'Asia/Taipei'
    expect(localYmd(new Date(2026, 0, 5))).toBe('2026-01-05')
    // The shape of the bug: the UTC day of local midnight is the day before.
    expect(new Date(2026, 8, 15).toISOString().slice(0, 10)).toBe('2026-09-14')
    expect(localYmd(new Date(2026, 8, 15))).toBe('2026-09-15')
  })
})
