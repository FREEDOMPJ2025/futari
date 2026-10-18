/**
 * Inputs for the #1791 golden test: files from the sources that already had a
 * mapper before the AndroMoney / まねーぼ / Splitwise work. The expected output
 * was recorded from the code as it stood BEFORE that work (b824dd6) and is
 * pinned in golden1791.test.ts, so adding the new sources cannot change what an
 * existing source's file produces.
 */
import type { DetectedSource } from '../detector'

export interface GoldenCase {
  name: string
  /** What the wizard passes (`undefined` = auto-detect, as the preview does). */
  source: DetectedSource | undefined
  csv: string
  headerMap?: { date: string; amount: string; category?: string; description?: string; type?: string; currency?: string }
}

export const GOLDEN_CASES: GoldenCase[] = [
  {
    name: 'honeydue, picked',
    source: 'honeydue',
    csv: [
      'Date,Name,Category,Amount,Account',
      '1/15/2026,Costco,Groceries,-250,Joint',
      '1/16/2026,Coffee,Food & Dining,-80.5,Joint',
      '1/20/2026,Salary,Income,4000,Joint',
      '1/21/2026,,Shopping,(30),Joint',
      'not-a-date,Bad,Home,-10,Joint',
    ].join('\n'),
  },
  {
    name: 'honeydue, auto-detected',
    source: undefined,
    csv: ['Date,Name,Category,Amount,Account', '2/3/2026,Rent,Rent,-9000,Joint'].join('\n'),
  },
  {
    name: 'spendee, picked (transfer row, currency)',
    source: 'spendee',
    csv: [
      'Date,Wallet,Type,Category name,Amount,Currency,Note',
      '2026-01-15,Cash,Expense,Coffee,120,TWD,latte',
      '2026-02-01,Bank,Income,Salary,40000,TWD,5-month',
      '2026-02-02,Bank,Transfer,Transfer,5000,TWD,to cash',
      '2026-02-03,Bank,Expense,Travel,25.4,EUR,train',
    ].join('\n'),
  },
  {
    name: 'cwmoney, picked (中文 headers)',
    source: 'cwmoney',
    csv: [
      '日期,類別,項目,金額,帳戶',
      '2026/03/01,飲食,午餐,120,現金',
      '20260302,交通,捷運,35,現金',
      '2026-03-03,居住,房租,12000,銀行',
    ].join('\n'),
  },
  {
    name: 'cwmoney, auto-detected (日期 + 金額)',
    source: undefined,
    csv: ['日期,類別,項目,金額,帳戶', '2026-03-05,娛樂,電影,300,現金'].join('\n'),
  },
  {
    name: 'cwmoney, i_* schema',
    source: 'cwmoney',
    csv: ['i_date,i_kind,i_money,i_note,i_type', '1772323200000,飲食,150,晚餐,0', '1772409600000,薪水,50000,月薪,1'].join('\n'),
  },
  {
    name: 'futari_generic via generic button',
    source: 'generic',
    headerMap: { date: 'Date', amount: 'Amount' },
    csv: [
      'date,category,amount,description,currency,kind',
      '2026-04-01,dining,200,lunch,TWD,expense',
      '2026-04-02,other,900,bonus,TWD,income',
      '2026-04-03,dining,15,snack,USD,expense',
      '2026-04-04,other,300,moved,TWD,transfer',
    ].join('\n'),
  },
  {
    name: 'generic with a headerMap',
    source: 'generic',
    headerMap: { date: 'When', amount: 'How much', description: 'What', category: 'Kind' },
    csv: ['When,How much,What,Kind', '2026-05-01,-45,tea,dining', '2026-05-02,1000,gift,other'].join('\n'),
  },
  {
    name: 'a file with a banner line, picked as CWMoney (no skip for other sources)',
    source: 'cwmoney',
    csv: [
      '"Google Documents","AndroMoney","20261001"',
      '"Id","幣別","金額","分類","子分類","日期","付款(轉出)","收款(轉入)","備註"',
      '"1","TWD","5000","SYSTEM","INIT_AMOUNT","10100101","","現金",""',
      '"2","TWD","120","飲食","午餐","20260915","現金","","便當"',
    ].join('\n'),
  },
  {
    name: 'header row only',
    source: 'spendee',
    csv: 'Date,Wallet,Type,Category name,Amount,Currency,Note',
  },
]

/** Header lists and what `detectSource` said for each before #1791. */
export const GOLDEN_HEADERS: string[][] = [
  ['Date', 'Name', 'Category', 'Amount', 'Account'],
  ['Date', 'Wallet', 'Type', 'Category name', 'Amount', 'Currency', 'Note'],
  ['日期', '類別', '項目', '金額', '帳戶'],
  ['date', 'category', 'amount', 'description', 'currency', 'kind'],
  ['Date', 'Amount', 'Description', 'Account'],
  ['Date', 'Amount', 'Currency'],
  ['foo', 'bar', 'baz'],
  [],
]
