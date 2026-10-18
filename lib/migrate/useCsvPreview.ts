'use client'

import { useCallback, useState } from 'react'
import {
  computePreview,
  decodeBytes,
  detectCsvSource,
  parseCsvText,
  parseHintsFor,
  type CsvRow,
  type CsvStats,
  type DetectedEncoding,
  type MigrateSource,
} from '@/lib/csvImport'

export type CsvPreviewStatus = 'idle' | 'parsing' | 'ready' | 'error'

export interface CsvPreviewState {
  status: CsvPreviewStatus
  file: File | null
  headers: string[]
  rows: CsvRow[]
  detectedSource: MigrateSource
  encoding: DetectedEncoding | null
  stats: CsvStats | null
  error: string | null
}

/** `error` for a file that parsed but has no usable rows; also the `reason`
 *  of the `migrate_preview_failed` event, so it reads apart from a thrown message. */
export const NO_USABLE_ROWS = 'no_usable_rows'

const INITIAL: CsvPreviewState = {
  status: 'idle',
  file: null,
  headers: [],
  rows: [],
  detectedSource: 'unknown',
  encoding: null,
  stats: null,
  error: null,
}

/**
 * Parses an uploaded CSV file fully in the browser. No bytes leave the device —
 * the /migrate pages are anonymous SEO entries; account creation + the real
 * import flow live behind auth. `hint` lets the caller bias the page towards
 * a known source (e.g. /migrate/honeydue passes 'honeydue') when the header
 * sniffer can't tell, and selects that source's decode / banner hints.
 *
 * A file that parses but yields no usable row (no date and amount the source's
 * mapper can read) ends in `status: 'error'`, not 'ready' (#1528 A6).
 */
export function useCsvPreview({ hint = 'unknown' }: { hint?: MigrateSource } = {}) {
  const [state, setState] = useState<CsvPreviewState>(INITIAL)

  const load = useCallback(async (file: File) => {
    setState({ ...INITIAL, status: 'parsing', file })
    try {
      const buffer = await file.arrayBuffer()
      // The page's own source declares how its file is read (AndroMoney: skip
      // the banner line; まねーぼ: Shift_JIS fallback) — same hints as the
      // wizard, so the preview and the import see the same columns. Other pages
      // get no hints and parse exactly as before.
      const hints = parseHintsFor(hint)
      const { text, encoding } = decodeBytes(buffer, hints)
      const { headers, rows } = parseCsvText(text, hints)
      const detectedSource = detectCsvSource(headers) ?? hint
      const { stats, usableRows } = computePreview(headers, rows, hint)
      // Nothing an import could use (#1528 A6): same terminal state as a file
      // that throws, so the page shows its error and no import button.
      if (usableRows === 0) {
        setState({ ...INITIAL, status: 'error', file, error: NO_USABLE_ROWS })
        return
      }
      setState({
        status: 'ready',
        file,
        headers,
        rows,
        detectedSource,
        encoding,
        stats,
        error: null,
      })
    } catch (err) {
      setState({
        ...INITIAL,
        status: 'error',
        file,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [hint])

  const reset = useCallback(() => setState(INITIAL), [])

  return { ...state, load, reset }
}
