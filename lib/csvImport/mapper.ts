/**
 * Per-source field mappers: raw CSV row → `PartialImportRow`.
 *
 * Mappers are *permissive* — they normalise whatever they can and leave the
 * rest as `undefined` for the validator to flag. Amount sign is consumed here
 * (negative → `type: 'expense'`, positive → `'income'`) and stored as a
 * positive integer to match Futari's schema (CashTransactions /
 * IncomeTransactions both store positive integers; the table choice carries
 * the sign).
 */

import { isWritableExpenseCategory } from '@/lib/categories'
import {
  ANDROMONEY_HEADERS,
  ANDROMONEY_LABELS,
  ANDROMONEY_POSITION,
  ANDROMONEY_WIDTH,
  MANEBO_HEADERS,
  MANEBO_LABELS,
  SPLITWISE_HEADERS,
  describeMissing,
  detectHeaderLang,
  normalizeHeader,
  type HeaderLang,
} from './headerAliases'
import type {
  HeaderMap,
  ImportRowType,
  PartialImportRow,
} from './types'

// ──────────────────────────── Date parsing ────────────────────────────

const RE_DASH    = /^(\d{4})-(\d{1,2})-(\d{1,2})$/
const RE_SLASH   = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/
const RE_US      = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/      // Honeydue ships US M/D/YYYY
const RE_COMPACT = /^(\d{4})(\d{2})(\d{2})$/
const RE_NUM     = /^\d+$/                                 // CWMoney i_date = Unix ms

function mkLocalDate(y: number, m: number, d: number): Date | null {
  // Construct via UTC then adjust — JS `new Date(y, m, d)` uses local TZ which
  // is fine but rolls over for invalid days (e.g. Feb 30 → Mar 2). Validate.
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const result = new Date(y, m - 1, d)
  if (result.getFullYear() !== y || result.getMonth() !== m - 1 || result.getDate() !== d) {
    return null
  }
  return result
}

export function parseDate(raw: string): Date | null {
  const s = raw.trim()
  if (!s) return null
  let m: RegExpMatchArray | null
  if ((m = s.match(RE_DASH))    !== null) return mkLocalDate(+m[1]!, +m[2]!, +m[3]!)
  if ((m = s.match(RE_SLASH))   !== null) return mkLocalDate(+m[1]!, +m[2]!, +m[3]!)
  if ((m = s.match(RE_COMPACT)) !== null) return mkLocalDate(+m[1]!, +m[2]!, +m[3]!)
  if ((m = s.match(RE_US))      !== null) return mkLocalDate(+m[3]!, +m[1]!, +m[2]!)
  if (RE_NUM.test(s)) {
    const n = parseInt(s, 10)
    // > 10^11 ≈ year 1973 in seconds; treat as milliseconds. Otherwise seconds.
    const ms = n > 1e11 ? n : n * 1000
    const d = new Date(ms)
    return isNaN(d.getTime()) ? null : d
  }
  // Last resort — let JS try. Returns Invalid Date for unparseable strings.
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

// ──────────────────────────── Amount parsing ────────────────────────────

export interface AmountParse {
  value: number      // absolute integer (rounded if input had decimals)
  isNegative: boolean
}

export function parseAmount(raw: string): AmountParse | null {
  const s = raw.replace(/,/g, '').trim()
  if (!s) return null
  const isNegative = s.startsWith('-') || (s.startsWith('(') && s.endsWith(')'))
  const cleaned = s
    .replace(/^[+-]/, '')
    .replace(/^\((.*)\)$/, '$1')
    .replace(/[$¥€£NT$]/g, '')
    .trim()
  const n = Number(cleaned)
  if (!isFinite(n)) return null
  return { value: Math.round(Math.abs(n)), isNegative }
}

// ──────────────────────────── Category mapping ────────────────────────────

/**
 * Best-effort synonym table for non-Futari category strings. Keyed by lowercase
 * trimmed value. Unmapped strings fall through to 'other' so import never
 * blocks on an unknown category — the mapping wizard UI can refine later.
 */
const CATEGORY_SYNONYMS: Record<string, string> = {
  // Honeydue / Spendee English
  'food & dining':           'dining',
  'food & drinks':           'dining',
  'food and drink':          'dining',
  'food and drinks':         'dining',
  'restaurants':             'dining',
  'groceries':               'dining',
  'dining':                  'dining',
  'shopping':                'clothing',
  'clothing':                'clothing',
  'apparel':                 'clothing',
  'home':                    'housing',
  'rent':                    'housing',
  'mortgage':                'housing',
  'utilities':               'housing',
  'housing':                 'housing',
  // Spendee canonical: "Transportation" / "Vehicle"
  'transportation':          'transit',
  'transport':               'transit',
  'vehicle':                 'transit',
  'auto':                    'transit',
  'gas':                     'transit',
  'fuel':                    'transit',
  'transit':                 'transit',
  'entertainment':           'entertainment',
  // Spendee canonical: "Life & Entertainment"
  'life & entertainment':    'entertainment',
  'life and entertainment':  'entertainment',
  'travel':                  'entertainment',
  'recreation':              'entertainment',
  'health':                  'health',
  'medical':                 'health',
  'healthcare':              'health',
  'education':               'education',
  'school':                  'education',
  'tuition':                 'education',
  'fees':                    'financial',
  'bank':                    'financial',
  'financial':               'financial',
  // Spendee canonical: "Financial expenses" / "Communication"
  'financial expenses':      'financial',
  'insurance':               'financial',
  'investments':             'financial',
  'communication':           'financial',
  'others':                  'other',
  'other':                   'other',
  // CWMoney 繁中
  '飲食':            'dining',
  '餐飲':            'dining',
  '吃飯':            'dining',
  '伙食':            'dining',
  '服飾':            'clothing',
  '衣服':            'clothing',
  '購物':            'clothing',
  '居住':            'housing',
  '房租':            'housing',
  '水電':            'housing',
  '家居':            'housing',
  '交通':            'transit',
  '油資':            'transit',
  '通勤':            'transit',
  '教育':            'education',
  '學費':            'education',
  '娛樂':            'entertainment',
  '休閒':            'entertainment',
  '旅遊':            'entertainment',
  '醫療':            'health',
  '保健':            'health',
  '金融':            'financial',
  '保險':            'financial',
}

export function mapCategory(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return 'other'
  if (isWritableExpenseCategory(trimmed)) return trimmed
  const lower = trimmed.toLowerCase()
  // Own keys only: CATEGORY_SYNONYMS is a plain object, so 'constructor'
  // would otherwise return the Object function (#1534).
  if (Object.hasOwn(CATEGORY_SYNONYMS, lower)) return CATEGORY_SYNONYMS[lower]!
  if (Object.hasOwn(CATEGORY_SYNONYMS, trimmed)) return CATEGORY_SYNONYMS[trimmed]!
  return 'other'
}

// ──────────────────────────── Mappers ────────────────────────────

function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    if (k in row && row[k] !== undefined && row[k] !== '') return row[k]!
  }
  return ''
}

function typeFromString(s: string): ImportRowType | null {
  const t = s.trim().toLowerCase()
  if (t === 'expense' || t === '支出' || t === 'debit' || t === 'out')   return 'expense'
  if (t === 'income'  || t === '收入' || t === 'credit' || t === 'in')   return 'income'
  return null
}

/** Honeydue exports: `Date, Name, Category, Amount, Account` with US M/D/YYYY
 *  dates and negative amounts for expenses. */
export function mapHoneydue(row: Record<string, string>): PartialImportRow {
  const date = parseDate(pick(row, 'Date', 'date'))
  const amt = parseAmount(pick(row, 'Amount', 'amount'))
  const out: PartialImportRow = {
    category: mapCategory(pick(row, 'Category', 'category')),
    description: pick(row, 'Name', 'Description', 'Memo', 'name', 'description').trim(),
    paidBy: 'viewer',
    splitType: 'half',
  }
  if (date) out.date = date
  if (amt) {
    out.amount = amt.value
    out.type = amt.isNegative ? 'expense' : 'income'
  }
  return out
}

/** Spendee exports: `Date, Wallet, Type, Category name, Amount, Currency, Note`.
 *  `Type` column is authoritative for expense/income (amounts are always positive
 *  in Spendee). Spendee also emits a third type — `Transfer` — for inter-wallet
 *  transfers; we leave those rows with `type === undefined` so the validator
 *  flags them and the preview UI lets the user drop them (Futari has no
 *  transfer concept; see csv-import-design.md "Out of scope"). */
export function mapSpendee(row: Record<string, string>): PartialImportRow {
  const date = parseDate(pick(row, 'Date', 'date'))
  const amt = parseAmount(pick(row, 'Amount', 'amount'))
  const typeStr = pick(row, 'Type', 'type').trim()
  const explicitType = typeFromString(typeStr)
  const currency = pick(row, 'Currency', 'currency').trim()
  const out: PartialImportRow = {
    category: mapCategory(pick(row, 'Category name', 'Category', 'category')),
    description: pick(row, 'Note', 'Description', 'note', 'description').trim(),
    paidBy: 'viewer',
    splitType: 'half',
  }
  if (date) out.date = date
  if (amt) {
    out.amount = amt.value
    // Type column wins when present; fall back to amount sign only when Type
    // is missing entirely. If Type is present but unrecognised (e.g.
    // "Transfer"), leave `type` undefined so the validator surfaces the row
    // as an error rather than silently mis-classifying it.
    if (explicitType) {
      out.type = explicitType
    } else if (!typeStr) {
      out.type = amt.isNegative ? 'expense' : 'income'
    }
  }
  if (currency) {
    out.originalCurrency = currency.toUpperCase()
    if (amt) out.originalAmount = amt.value
  }
  return out
}

/** CWMoney exports: 中文 headers (`日期, 類別, 項目, 金額, 帳戶`) or the raw
 *  `i_date / i_kind / i_money / i_note` schema from VIP exports. */
export function mapCwmoney(row: Record<string, string>): PartialImportRow {
  const date = parseDate(pick(row, '日期', 'Date', 'i_date', 'date'))
  const amt = parseAmount(pick(row, '金額', 'Amount', 'i_money', 'amount'))
  // CWMoney's i_type is '0' for expense, '1' for income (per research notes).
  const rawType = pick(row, 'i_type', '類型', 'Type', 'type').trim()
  let explicitType: ImportRowType | null = null
  if (rawType === '0') explicitType = 'expense'
  else if (rawType === '1') explicitType = 'income'
  else explicitType = typeFromString(rawType)
  const out: PartialImportRow = {
    category: mapCategory(pick(row, '類別', 'Category', 'i_kind', 'category')),
    description: pick(row, '項目', '備註', 'Note', 'i_note', 'description').trim(),
    paidBy: 'viewer',
    splitType: 'half',
  }
  if (date) out.date = date
  if (amt) {
    out.amount = amt.value
    // CWMoney rarely uses negative amounts (it has i_type); fall back to sign
    // only when i_type is absent. Default-default is 'expense' (most rows).
    out.type = explicitType ?? (amt.isNegative ? 'expense' : 'expense')
  }
  return out
}

/**
 * futari_generic: the canonical CSV produced by the screenshot→ChatGPT→CSV
 * workflow (#839 P2). Fixed headers:
 *   `date,category,amount,description,currency,kind`
 * ChatGPT occasionally title-cases the headers, so each column is picked
 * case-insensitively. `kind` (expense/income) is authoritative for the row
 * type — never the amount sign — so a stray "-" the model emitted can't flip
 * an income row. `currency` defaults to TWD; only a non-TWD value emits the
 * multi-currency tuple (the import action drops it in MVP and treats the raw
 * amount as base, mirroring the Spendee currency path).
 */
export function mapFutariGeneric(row: Record<string, string>): PartialImportRow {
  const date = parseDate(pick(row, 'date', 'Date'))
  const amt = parseAmount(pick(row, 'amount', 'Amount'))
  const explicitType = typeFromString(pick(row, 'kind', 'Kind'))
  const currency = pick(row, 'currency', 'Currency').trim().toUpperCase()
  const out: PartialImportRow = {
    category: mapCategory(pick(row, 'category', 'Category')),
    description: pick(row, 'description', 'Description', 'note', 'Note').trim(),
    paidBy: 'viewer',
    splitType: 'half',
  }
  if (date) out.date = date
  if (amt) {
    out.amount = amt.value
    // kind is authoritative; leave type undefined when it's blank or an
    // unrecognized value (e.g. "transfer") so the validator surfaces the row.
    if (explicitType) out.type = explicitType
  }
  // TWD (and blank) are treated as the base currency — no tuple. Anything else
  // is captured so the preview/import can surface it.
  if (currency && currency !== 'TWD') {
    out.originalCurrency = currency
    if (amt) out.originalAmount = amt.value
  }
  return out
}

/** User-provided `HeaderMap` for arbitrary CSV layouts. */
export function mapGeneric(
  row: Record<string, string>,
  headerMap: HeaderMap,
): PartialImportRow {
  const date = parseDate(row[headerMap.date] ?? '')
  const amt = parseAmount(row[headerMap.amount] ?? '')
  const explicitType = headerMap.type
    ? typeFromString(row[headerMap.type] ?? '')
    : null
  const currency = headerMap.currency
    ? (row[headerMap.currency] ?? '').trim()
    : ''
  const out: PartialImportRow = {
    category: mapCategory(headerMap.category ? row[headerMap.category] : ''),
    description: (headerMap.description ? row[headerMap.description] ?? '' : '').trim(),
    paidBy: 'viewer',
    splitType: 'half',
  }
  if (date) out.date = date
  if (amt) {
    out.amount = amt.value
    out.type = explicitType ?? (amt.isNegative ? 'expense' : 'income')
  }
  if (currency) {
    out.originalCurrency = currency.toUpperCase()
    if (amt) out.originalAmount = amt.value
  }
  return out
}

// ──────────────────── Dedicated mappers (#1791) ────────────────────
//
// AndroMoney / まねーぼ / Splitwise. Unlike the mappers above these resolve
// their columns from the title row first (`resolve…Columns`), because the
// titles are localised and a column can be absent: when a required column is
// missing the file is not read at all and `processFile` reports which ones,
// instead of mapping every row to nothing and ending in the generic
// "no rows we can import".

/**
 * The header text of the column called any of `aliases`; failing that, the one
 * at `position` — but only when the file is exactly as wide as the documented
 * layout, so a differently shaped file is never read by position.
 */
function findColumn(
  headers: readonly string[],
  aliases: readonly string[],
  position?: number,
  width?: number,
): string | undefined {
  const i = headers.findIndex(h => aliases.includes(normalizeHeader(h)))
  if (i !== -1) return headers[i]
  if (position !== undefined && width !== undefined && headers.length === width) {
    return headers[position]
  }
  return undefined
}

function cell(row: Record<string, string>, column: string | undefined): string {
  return column === undefined ? '' : (row[column] ?? '').trim()
}

/** Non-base currencies carry the original tuple; TWD (or blank) does not. */
function withCurrency(out: PartialImportRow, currency: string, amount: number | undefined): void {
  const code = currency.trim().toUpperCase()
  if (code && code !== 'TWD') {
    out.originalCurrency = code
    if (amount !== undefined) out.originalAmount = amount
  }
}

export interface ColumnResolution<C> {
  /** `null` when a required column is missing. */
  columns: C | null
  /** The required columns that were not found, named for the user: the English
   *  name, plus the file's own language when it can be told (`Type（種別）`). */
  missing: string[]
}

/** Names a missing column in the language the file's title row is written in. */
function missingNamer<L extends Record<string, Partial<Record<HeaderLang, string>>>>(
  headers: readonly string[],
  labels: L,
): (key: keyof L & string) => string {
  const lang = detectHeaderLang(headers)
  return (key) => describeMissing(key, labels, lang)
}

// ── AndroMoney ──

export interface AndromoneyColumns {
  date: string
  amount: string
  /** `Expense(Transfer Out)` — the paying account. */
  out: string
  /** `Income(Transfer In)` — the receiving account. */
  in: string
  category?: string
  subCategory?: string
  note?: string
  currency?: string
}

export function resolveAndromoneyColumns(headers: readonly string[]): ColumnResolution<AndromoneyColumns> {
  const H = ANDROMONEY_HEADERS
  const P = ANDROMONEY_POSITION
  const W = ANDROMONEY_WIDTH
  const date = findColumn(headers, H.date, P.date, W)
  const amount = findColumn(headers, H.amount, P.amount, W)
  const out = findColumn(headers, H.out, P.out, W)
  const inn = findColumn(headers, H.in, P.in, W)
  const name = missingNamer(headers, ANDROMONEY_LABELS)
  const missing: string[] = []
  if (date === undefined) missing.push(name('date'))
  if (amount === undefined) missing.push(name('amount'))
  if (out === undefined) missing.push(name('out'))
  if (inn === undefined) missing.push(name('in'))
  if (date === undefined || amount === undefined || out === undefined || inn === undefined) {
    return { columns: null, missing }
  }
  return {
    missing,
    columns: {
      date, amount, out, in: inn,
      category: findColumn(headers, H.category, P.category, W),
      subCategory: findColumn(headers, H.subCategory, P.subCategory, W),
      note: findColumn(headers, H.note, P.note, W),
      currency: findColumn(headers, H.currency, P.currency, W),
    },
  }
}

/**
 * AndroMoney: `Amount` is always positive; the direction is which account
 * column is filled (paying → expense, receiving → income). Both filled is a
 * transfer between the user's own accounts; `SYSTEM` / `INIT_AMOUNT` is the
 * account's opening balance (dated 10100101). Neither is a record Futari has a
 * place for, so both are skipped with their own reason.
 */
export function mapAndromoney(row: Record<string, string>, c: AndromoneyColumns): PartialImportRow {
  const category = cell(row, c.category)
  const subCategory = cell(row, c.subCategory)
  const payFrom = cell(row, c.out)
  const payTo = cell(row, c.in)
  const out: PartialImportRow = {
    category: mapCategory(category),
    description: cell(row, c.note) || subCategory,
    paidBy: 'viewer',
    splitType: 'half',
  }
  if (category.toUpperCase() === 'SYSTEM' || subCategory.toUpperCase() === 'INIT_AMOUNT') {
    out.skipReason = 'opening balance rows are not imported'
    return out
  }
  if (payFrom && payTo) {
    out.skipReason = 'transfer rows are not imported'
    return out
  }
  const date = parseDate(row[c.date] ?? '')
  const amt = parseAmount(row[c.amount] ?? '')
  if (date) out.date = date
  if (amt) {
    out.amount = amt.value
    if (payFrom) out.type = 'expense'
    else if (payTo) out.type = 'income'
    withCurrency(out, cell(row, c.currency), amt.value)
  }
  return out
}

// ── まねーぼ (Manebo) ──

export interface ManeboColumns {
  date: string
  type: string
  amount: string
  category?: string
  subCategory?: string
  note?: string
}

export function resolveManeboColumns(headers: readonly string[]): ColumnResolution<ManeboColumns> {
  const H = MANEBO_HEADERS
  const date = findColumn(headers, H.date)
  const type = findColumn(headers, H.type)
  const amount = findColumn(headers, H.amount)
  const name = missingNamer(headers, MANEBO_LABELS)
  const missing: string[] = []
  if (date === undefined) missing.push(name('date'))
  if (type === undefined) missing.push(name('type'))
  if (amount === undefined) missing.push(name('amount'))
  if (date === undefined || type === undefined || amount === undefined) {
    return { columns: null, missing }
  }
  return {
    missing,
    columns: {
      date, type, amount,
      category: findColumn(headers, H.category),
      subCategory: findColumn(headers, H.subCategory),
      note: findColumn(headers, H.note),
    },
  }
}

/**
 * まねーぼ: `金額` is positive; `種別` is `income` / `expense` / `transfer`
 * (English in every app language) and is the only thing that decides the
 * direction. A transfer is skipped; any other value leaves `type` unset so the
 * validator reports the row.
 */
export function mapManebo(row: Record<string, string>, c: ManeboColumns): PartialImportRow {
  const kind = cell(row, c.type).toLowerCase()
  const subCategory = cell(row, c.subCategory)
  const out: PartialImportRow = {
    category: mapCategory(cell(row, c.category)),
    description: cell(row, c.note) || subCategory,
    paidBy: 'viewer',
    splitType: 'half',
  }
  if (kind === 'transfer') {
    out.skipReason = 'transfer rows are not imported'
    return out
  }
  const date = parseDate(row[c.date] ?? '')
  const amt = parseAmount(row[c.amount] ?? '')
  if (date) out.date = date
  if (amt) {
    out.amount = amt.value
    if (kind === 'income' || kind === 'expense') out.type = kind
  }
  return out
}

// ── Splitwise ──

export interface SplitwiseColumns {
  date: string
  cost: string
  description?: string
  category?: string
  currency?: string
}

export function resolveSplitwiseColumns(headers: readonly string[]): ColumnResolution<SplitwiseColumns> {
  const H = SPLITWISE_HEADERS
  const date = findColumn(headers, H.date)
  const cost = findColumn(headers, H.cost)
  const missing: string[] = []
  if (date === undefined) missing.push('Date')
  if (cost === undefined) missing.push('Cost')
  if (date === undefined || cost === undefined) return { columns: null, missing }
  return {
    missing,
    columns: {
      date, cost,
      description: findColumn(headers, H.description),
      category: findColumn(headers, H.category),
      currency: findColumn(headers, H.currency),
    },
  }
}

const RE_US_SHORT = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/   // Splitwise 2018 exports: 7/31/18

function parseSplitwiseDate(raw: string): Date | null {
  const m = raw.trim().match(RE_US_SHORT)
  // Read M/D/YY here instead of letting `parseDate` fall through to `new Date()`:
  // the engine's two-digit-year window is the engine's, not ours.
  if (m !== null) return mkLocalDate(2000 + +m[3]!, +m[1]!, +m[2]!)
  return parseDate(raw)
}

/**
 * Splitwise: `Cost` is the whole bill, always positive, so every kept row is an
 * expense. The member columns (paid − owed per person) are not read: the wizard
 * assigns one payer to the whole batch. A `Payment` row is a settle-up between
 * members and the `Total balance` row is a footer; neither is an expense.
 */
export function mapSplitwise(row: Record<string, string>, c: SplitwiseColumns): PartialImportRow {
  const description = cell(row, c.description)
  const category = cell(row, c.category)
  const out: PartialImportRow = {
    category: mapCategory(category),
    description,
    paidBy: 'viewer',
    splitType: 'half',
  }
  if (description.toLowerCase() === 'total balance') {
    out.skipReason = 'Total balance row is not imported'
    return out
  }
  if (category.toLowerCase() === 'payment') {
    out.skipReason = 'settle-up (Payment) rows are not imported'
    return out
  }
  const date = parseSplitwiseDate(row[c.date] ?? '')
  const amt = parseAmount(row[c.cost] ?? '')
  if (date) out.date = date
  if (amt) {
    out.amount = amt.value
    out.type = 'expense'
    withCurrency(out, cell(row, c.currency), amt.value)
  }
  return out
}
