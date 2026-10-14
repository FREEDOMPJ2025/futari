// CSV 匯出的欄位取捨與 Excel 相容性決定（BOM、CRLF、台北時區日期）見
// docs/superpowers/specs/csv-export-design.md。注意這支是「匯出」，匯入在
// lib/csvImport/。
import type { ExportLedgerRow } from '@/lib/db/queries/export'
import type { Translations } from '@/lib/i18n/locales/zh-TW'

// UTF-8 BOM (﻿). Excel needs this to detect UTF-8 and avoid mojibake on CJK fields.
const BOM = '﻿'
const CRLF = '\r\n'

/** RFC 4180: wrap fields containing comma/quote/CR/LF in double quotes; escape inner quotes by doubling. */
function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * A text cell a spreadsheet would read as a formula: its first visible
 * character is `=` `+` `-` `@` (or the full-width forms), possibly after
 * leading whitespace — `\s` covers space, tab, CR, LF, NBSP, U+3000 and
 * U+FEFF; the zero-width characters are listed explicitly. A cell that
 * itself starts with a tab or CR is also treated as unsafe.
 */
const FORMULA_LIKE = /^[\s\u200B-\u200D\u2060]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r]/

/**
 * Text cells come from what people typed (description, notes, names) or
 * from labels, so they are made spreadsheet-safe: a formula-looking cell
 * gets a leading `'`, which spreadsheets treat as "this is text", and every
 * text cell is quoted. The generated cells — date and integer amount — are
 * left as they are so they still open as a date and a number.
 */
function textField(value: string): string {
  const safe = FORMULA_LIKE.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}

/** YYYY-MM-DD in Asia/Taipei (TW-only product; matches the rest of the codebase). */
const TAIPEI_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function toTaipeiYmd(d: Date): string {
  // en-CA emits YYYY-MM-DD already; safer than manual offset arithmetic.
  return TAIPEI_FORMATTER.format(d)
}

export type { ExportLedgerRow } from '@/lib/db/queries/export'

export interface ExportLabels {
  columns: Translations['csvExport']['columns']
  types: Translations['csvExport']['types']
  category: Translations['category']
  incomeCategory: Translations['incomeCategory']
  /** Expense status cell: t.addSheet.statusSettled / statusPending. */
  status: { settled: string; pending: string }
  /** Shown for a person the chapter recorded no name for (t.common.partner). */
  partner: string
  /** 章節 cell: `{start}` `{end}` `{who}`; `ongoing` stands in for an open
   *  chapter's end; `withPartner` (`{partner}`) / `solo` fill `{who}`. */
  chapter: { template: string; ongoing: string; withPartner: string; solo: string }
}

/** The labels a locale's translations give the export. */
export function exportLabelsFor(t: Translations): ExportLabels {
  return {
    columns: t.csvExport.columns,
    types: t.csvExport.types,
    category: t.category,
    incomeCategory: t.incomeCategory,
    status: { settled: t.addSheet.statusSettled, pending: t.addSheet.statusPending },
    partner: t.common.partner,
    chapter: {
      template: t.csvExport.chapter,
      ongoing: t.csvExport.chapterOngoing,
      withPartner: t.pastTimes.withPartner,
      solo: t.pastTimes.soloLabel,
    },
  }
}

/** Own keys only, or 'constructor' would export function source (#1534). */
function ownLabel(map: Record<string, string>, raw: string): string {
  return Object.hasOwn(map, raw) ? map[raw] : raw
}

function categoryLabel(row: ExportLedgerRow, labels: ExportLabels): string {
  if (row.category === null) return ''
  // Expense ids map 1:1 to t.category keys, income ids to t.incomeCategory;
  // unknown values pass through.
  if (row.kind === 'expense') return ownLabel(labels.category, row.category)
  if (row.kind === 'income') return ownLabel(labels.incomeCategory, row.category)
  return ''
}

/** Replace `{key}` placeholders. Function replacers, so a `$&` in a name stays literal. */
function fill(template: string, values: Record<string, string>): string {
  let out = template
  for (const [k, v] of Object.entries(values)) out = out.replace(`{${k}}`, () => v)
  return out
}

function chapterLabel(row: ExportLedgerRow, labels: ExportLabels): string {
  const c = labels.chapter
  const who = row.chapter.partnerName === undefined
    ? c.solo
    : fill(c.withPartner, { partner: row.chapter.partnerName ?? labels.partner })
  return fill(c.template, {
    start: row.chapter.startDate,
    end: row.chapter.endDate ?? c.ongoing,
    who,
  })
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** A generated cell (date / integer / percent) — plain so it opens as a value. */
function valueField(value: string): string {
  return escapeField(value)
}

/**
 * Build a UTF-8 CSV string (with BOM + CRLF) for the ledger export: expenses,
 * income and settlements in one table (#1460). Pure — no I/O.
 *
 * Every text cell (anything typed by a person, any label, any name) goes
 * through `textField`; only the date, integer amounts and share percentages
 * are left unquoted.
 */
export function buildTransactionsCsv(rows: readonly ExportLedgerRow[], labels: ExportLabels): string {
  const c = labels.columns
  const header = [
    c.type, c.date, c.description, c.amount, c.currency, c.originalAmount, c.originalCurrency,
    c.category, c.person, c.settlementTo, c.myShare, c.theirShare, c.status, c.notes, c.chapter,
  ].map(textField).join(',')
  const body = rows.map((r) => [
    textField(labels.types[r.kind]),
    YMD.test(r.date) ? valueField(r.date) : textField(r.date),
    textField(r.description ?? ''),
    valueField(String(r.amount)),
    textField(r.currency.toUpperCase()),
    r.originalAmount === null ? '' : valueField(String(r.originalAmount)),
    textField(r.originalCurrency ? r.originalCurrency.toUpperCase() : ''),
    textField(categoryLabel(r, labels)),
    textField(r.personName ?? labels.partner),
    textField(r.toName === undefined ? '' : (r.toName ?? labels.partner)),
    r.shares ? valueField(`${r.shares.mine}%`) : '',
    r.shares ? valueField(`${r.shares.theirs}%`) : '',
    textField(r.status === null ? '' : labels.status[r.status]),
    textField(r.notes ?? ''),
    textField(chapterLabel(r, labels)),
  ].join(','))
  return BOM + [header, ...body].join(CRLF) + CRLF
}

/** Filename stem + today's local date (Asia/Taipei) → e.g. `futari-transactions-2026-05-09.csv` */
export function buildExportFilename(prefix: string, now: Date = new Date()): string {
  return `${prefix}-${toTaipeiYmd(now)}.csv`
}
