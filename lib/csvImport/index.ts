/**
 * `lib/csvImport/` — the unified CSV layer (issue #623) that backs both the
 * authenticated import wizard and the anonymous /migrate preview pages.
 *
 * Composes the sub-modules into one entrypoint: a `File` goes in, structured
 * `ImportRow[]` + stats + per-row errors come out. Pure async — no DB, no
 * React, no UI. The import action and the preview UI both consume this output.
 *
 * Auto-detect uses the shared header sniffer in `detector.ts`; when the file
 * doesn't match a known source it falls through to `'generic'` and the caller
 * is expected to supply a `HeaderMap` via the mapping wizard. A caller-supplied
 * `'generic'` is still sniffed for the `futari_generic` signature — see
 * `resolveSource` below for why that one label is not taken at face value.
 *
 * OFX / QIF take a separate codepath: `detectFormat` sniffs the decoded text
 * for `OFXHEADER:` / `<OFX>` / `!Type:`, and the file skips the CSV parser
 * to go straight to `ofxParser` / `qifParser` (issue #586).
 */

export type { DetectedSource, KnownCsvSource, MigrateSource } from './detector'
export type {
  DecodeOptions,
  DecodeResult,
  DetectedEncoding,
  ParseOptions,
  ParsedCsv,
  Separator,
  SourceParseHints,
} from './parser'
export type { CsvRow, CsvStats } from './stats'
export type {
  HeaderMap,
  ImportPaidBy,
  ImportRow,
  ImportRowType,
  ImportSplitType,
  PartialImportRow,
  RowError,
  ValidationResult,
} from './types'

export {
  decodeBytes,
  detectEncoding,
  detectSeparator,
  parseCsvBuffer,
  parseCsvText,
  parseHintsFor,
} from './parser'
export { DETECTED_SOURCES, detectCsvSource, detectFormat, detectSource } from './detector'
export { CSV_ONLY_ACCEPT, IMPORT_ACCEPT } from './accept'
export { computeStats } from './stats'
export {
  mapAndromoney,
  mapCategory,
  mapCwmoney,
  mapFutariGeneric,
  mapGeneric,
  mapHoneydue,
  mapManebo,
  mapSpendee,
  mapSplitwise,
  parseAmount,
  parseDate,
  resolveAndromoneyColumns,
  resolveManeboColumns,
  resolveSplitwiseColumns,
} from './mapper'
export { parseOfx } from './ofxParser'
export { parseQif } from './qifParser'
export { validateRow } from './validator'

import { decodeBytes, parseCsvText, parseHintsFor } from './parser'
import {
  KNOWN_CSV_SOURCES,
  detectCsvSource,
  detectFormat,
  detectSource,
  type DetectedSource,
  type MigrateSource,
} from './detector'
import { CATEGORY_KEYS, computeStats, type CsvRow, type CsvStats } from './stats'
import {
  mapAndromoney,
  mapCwmoney,
  mapFutariGeneric,
  mapGeneric,
  mapHoneydue,
  mapManebo,
  mapSpendee,
  mapSplitwise,
  resolveAndromoneyColumns,
  resolveManeboColumns,
  resolveSplitwiseColumns,
} from './mapper'
import { parseOfx } from './ofxParser'
import { parseQif } from './qifParser'
import { validateRow } from './validator'
import type {
  HeaderMap,
  ImportRow,
  PartialImportRow,
  RowError,
} from './types'

export interface ProcessOptions {
  /** Force a specific source. Skips header sniffing — except for `'generic'`,
   *  which is a "no signature, use my headerMap" marker rather than a source
   *  and is re-sniffed for `futari_generic` (see `resolveSource`). */
  source?: DetectedSource
  /** Required when source resolves to `'generic'`. */
  headerMap?: HeaderMap
}

export interface ProcessStats {
  total: number
  valid: number
  invalid: number
  dateRange: { from: Date; to: Date } | null
  topCategories: { key: string; count: number }[]
}

export interface ProcessResult {
  source: DetectedSource
  rows: ImportRow[]
  errors: RowError[]
  warnings: RowError[]
  stats: ProcessStats
  /** Only the dedicated mappers that read their columns by title set this
   *  (AndroMoney / まねーぼ / Splitwise), and only when a required column is
   *  not in the file. Then nothing was mapped: `rows` and `errors` are empty.
   *  Callers check it BEFORE the "no valid rows" case — both look like an empty
   *  result, but only this one names what to fix. Absent for every other source. */
  missingColumns?: string[]
}

type RowMapper = (r: Record<string, string>) => PartialImportRow

/** A row mapper, or the required columns the file lacks. */
type MapperPick = { map: RowMapper; missing?: undefined } | { map?: undefined; missing: string[] }

function fromColumns<C>(
  resolved: { columns: C | null; missing: string[] },
  map: (r: Record<string, string>, c: C) => PartialImportRow,
): MapperPick {
  const { columns } = resolved
  return columns === null ? { missing: resolved.missing } : { map: (r) => map(r, columns) }
}

function pickMapper(
  source: DetectedSource,
  headers: readonly string[],
  headerMap?: HeaderMap,
): MapperPick {
  switch (source) {
    case 'honeydue': return { map: (r) => mapHoneydue(r) }
    case 'spendee':  return { map: (r) => mapSpendee(r) }
    case 'cwmoney':  return { map: (r) => mapCwmoney(r) }
    case 'futari_generic': return { map: (r) => mapFutariGeneric(r) }
    case 'andromoney': return fromColumns(resolveAndromoneyColumns(headers), mapAndromoney)
    case 'manebo':     return fromColumns(resolveManeboColumns(headers), mapManebo)
    case 'splitwise':  return fromColumns(resolveSplitwiseColumns(headers), mapSplitwise)
    case 'generic':
      if (!headerMap) {
        throw new Error('headerMap is required when source is "generic"')
      }
      return { map: (r) => mapGeneric(r, headerMap) }
    case 'ofx':
    case 'qif':
      throw new Error(`${source} does not use the CSV mapper path`)
  }
}

function isComplete(row: PartialImportRow): row is ImportRow {
  return (
    row.date instanceof Date &&
    typeof row.amount === 'number' &&
    typeof row.type === 'string' &&
    typeof row.category === 'string' &&
    typeof row.description === 'string' &&
    typeof row.paidBy === 'string' &&
    typeof row.splitType === 'string'
  )
}

export async function processFile(
  file: File,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const buffer = await file.arrayBuffer()
  // Filename hint: .ofx / .qif extensions force the format even if the
  // content sniff misses (e.g. unusual encoding stripped the header line).
  //
  // It deliberately overrides a caller-supplied *CSV* source too. The import
  // wizard always passes one (the source buttons are a required choice), so
  // gating this on `!options.source` made the hint dead code on the only path
  // that has a filename at all — a header-mangled .ofx picked in the wizard
  // would have fallen through to the CSV mapper and produced junk rows rather
  // than an error (#1088). An explicit ofx/qif from the caller is left alone.
  if (options.source !== 'ofx' && options.source !== 'qif') {
    const name = file.name.toLowerCase()
    if (name.endsWith('.ofx')) options = { ...options, source: 'ofx' }
    else if (name.endsWith('.qif')) options = { ...options, source: 'qif' }
  }
  return processBuffer(buffer, options)
}

/** Buffer-level entry — useful for tests and for callers that already hold bytes. */
export function processBuffer(
  buffer: ArrayBuffer,
  options: ProcessOptions = {},
): ProcessResult {
  // A source the user chose may declare how its bytes are read (まねーぼ →
  // Shift_JIS); with no source the Big5 fallback is unchanged.
  const { text } = decodeBytes(buffer, parseHintsFor(options.source))
  // Format dispatch: explicit option wins, then content sniff.
  const format =
    options.source === 'ofx' || options.source === 'qif'
      ? options.source
      : detectFormat(text)
  if (format === 'ofx') return runNonCsv(parseOfx(text), 'ofx')
  if (format === 'qif') return runNonCsv(parseQif(text), 'qif')
  return runCsv(text, options)
}

/**
 * Which mapper the file actually gets.
 *
 * `'generic'` is the one caller-supplied source that is still sniffed, because
 * it isn't a source: it means "I have no signature for this file, use my
 * headerMap". The screenshot→ChatGPT→CSV output (#839 P2) lands there — the
 * wizard has no button for `futari_generic` (it is meant to be *recognised*,
 * not picked), so the file arrived labelled `'generic'` and went through
 * `mapGeneric` with the wizard's hardcoded `{ date: 'Date', amount: 'Amount' }`
 * map. Those headers are lowercase, `mapGeneric`'s lookup is case-sensitive,
 * and the result was zero valid rows behind the generic「沒有有效資料」
 * message — no error, nothing naming the real cause, so nobody reported it as
 * this bug (#1094).
 *
 * Only the `futari_generic` upgrade happens here. A user who picks the generic
 * wizard for a Honeydue/Spendee/CWMoney export still gets their headerMap
 * honoured, and the forced sources (incl. ofx / qif) are never second-guessed.
 */
function resolveSource(
  headers: readonly string[],
  requested: DetectedSource | undefined,
): DetectedSource {
  if (!requested) return detectSource(headers)
  if (requested !== 'generic') return requested
  return detectSource(headers) === 'futari_generic' ? 'futari_generic' : 'generic'
}

function runCsv(text: string, options: ProcessOptions): ProcessResult {
  // The banner skip (AndroMoney) applies only when the user chose that source.
  // A CWMoney button on an AndroMoney file therefore still reads the banner as
  // the header and ends with 0 valid rows — never an opening balance imported
  // as an expense.
  const { headers, rows } = parseCsvText(text, parseHintsFor(options.source))
  return mapRows(headers, rows, options)
}

/** The mapping + validation half of `runCsv`, for callers that already hold the
 *  parsed table (the /migrate preview parses once for its own table). */
function mapRows(
  headers: readonly string[],
  rawRows: readonly CsvRow[],
  options: ProcessOptions,
): ProcessResult {
  const source = resolveSource(headers, options.source)
  // Empty file: nothing to map. Bail before requiring a headerMap so callers
  // can probe the file shape without committing to a mapper choice.
  if (rawRows.length === 0) {
    return {
      source,
      rows: [],
      errors: [],
      warnings: [],
      stats: { total: 0, valid: 0, invalid: 0, dateRange: null, topCategories: [] },
    }
  }
  const picked = pickMapper(source, headers, options.headerMap)
  if (picked.missing) {
    return {
      source,
      rows: [],
      errors: [],
      warnings: [],
      stats: { total: 0, valid: 0, invalid: 0, dateRange: null, topCategories: [] },
      missingColumns: picked.missing,
    }
  }
  const partials = rawRows.map(r => picked.map(r))
  return validatePartials(partials, source)
}

function runNonCsv(partials: PartialImportRow[], source: DetectedSource): ProcessResult {
  return validatePartials(partials, source)
}

function validatePartials(
  partials: PartialImportRow[],
  source: DetectedSource,
): ProcessResult {
  const rows: ImportRow[] = []
  const errors: RowError[] = []
  const warnings: RowError[] = []
  const catCounts = new Map<string, number>()
  let dateMin: Date | null = null
  let dateMax: Date | null = null

  for (let i = 0; i < partials.length; i++) {
    const partial = partials[i]!
    if (partial.skipReason) {
      errors.push({ rowIndex: i, errors: [`row ${i + 1}: ${partial.skipReason}`] })
      continue
    }
    const result = validateRow(partial, i)
    if (result.warnings.length > 0) {
      warnings.push({ rowIndex: i, errors: result.warnings })
    }
    if (!result.ok || !isComplete(partial)) {
      errors.push({ rowIndex: i, errors: result.errors })
      continue
    }
    rows.push(partial)
    const key = partial.category
    catCounts.set(key, (catCounts.get(key) ?? 0) + 1)
    if (dateMin === null || partial.date < dateMin) dateMin = partial.date
    if (dateMax === null || partial.date > dateMax) dateMax = partial.date
  }

  const topCategories = Array.from(catCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => ({ key, count }))

  return {
    source,
    rows,
    errors,
    warnings,
    stats: {
      total: partials.length,
      valid: rows.length,
      invalid: errors.length,
      dateRange: dateMin && dateMax ? { from: dateMin, to: dateMax } : null,
      topCategories,
    },
  }
}

// ──────────────────────────── /migrate preview ────────────────────────────

/** Which mapper reads the preview's file, or null when none does. The header
 *  signature wins (it is what the card's source label shows); the page's own
 *  source only decides when the sniffer cannot tell. */
function previewMapperSource(
  headers: readonly string[],
  hint: MigrateSource,
): DetectedSource | null {
  const known = detectCsvSource(headers)
  if (known) return known
  if ((KNOWN_CSV_SOURCES as readonly string[]).includes(hint)) return hint as DetectedSource
  return detectSource(headers) === 'futari_generic' ? 'futari_generic' : null
}

/** The column the card's category chips read, as the file spells it. */
function previewCategoryColumn(source: DetectedSource, headers: readonly string[]): string | undefined {
  switch (source) {
    case 'andromoney': return resolveAndromoneyColumns(headers).columns?.category
    case 'manebo':     return resolveManeboColumns(headers).columns?.category
    case 'splitwise':  return resolveSplitwiseColumns(headers).columns?.category
    default:           return CATEGORY_KEYS.find((k) => headers.includes(k))
  }
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** AndroMoney dates its opening-balance rows 10100101. Those are skipped by the
 *  mapper, but a row that slips past it must not turn the range into "1010 →". */
const EARLIEST_PLAUSIBLE_YEAR = 1900

/**
 * Stats for the anonymous /migrate card, read through the same mapper and
 * validator the import wizard uses (#1801), so the numbers are what an import
 * would actually do: income vs expense from the mapper (not the amount sign),
 * dates parsed (not compared as strings), and rows the mapper skips or the
 * validator rejects (opening balance, transfer, settle-up, Total balance, bad
 * rows) counted in neither the totals below nor the range and categories.
 *
 * `totalRows` stays the file's row count. Files with no mapper fall back to the
 * column-name guesses in `computeStats`.
 */
export function computePreviewStats(
  headers: readonly string[],
  rows: readonly CsvRow[],
  hint: MigrateSource = 'unknown',
): CsvStats {
  const source = rows.length === 0 ? null : previewMapperSource(headers, hint)
  if (source === null) return computeStats(rows)

  const result = mapRows(headers, rows, { source })
  // A required column is missing: the wizard names it and imports nothing; the
  // card can only say how many rows the file has.
  if (result.missingColumns) {
    return { totalRows: rows.length, estimatedExpenseRows: 0, dateRange: null, topCategories: [] }
  }

  const skipped = new Set(result.errors.map((e) => e.rowIndex))
  const categoryColumn = previewCategoryColumn(source, headers)
  const catCounts = new Map<string, number>()
  if (categoryColumn !== undefined) {
    rows.forEach((row, i) => {
      if (skipped.has(i)) return
      const c = (row[categoryColumn] ?? '').trim()
      if (c) catCounts.set(c, (catCounts.get(c) ?? 0) + 1)
    })
  }

  let first: Date | null = null
  let last: Date | null = null
  for (const { date } of result.rows) {
    if (date.getFullYear() < EARLIEST_PLAUSIBLE_YEAR) continue
    if (first === null || date < first) first = date
    if (last === null || date > last) last = date
  }

  return {
    totalRows: rows.length,
    estimatedExpenseRows: result.rows.filter((r) => r.type === 'expense').length,
    dateRange: first && last ? { first: ymd(first), last: ymd(last) } : null,
    topCategories: Array.from(catCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count })),
  }
}
