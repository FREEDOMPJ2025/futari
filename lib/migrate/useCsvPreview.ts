'use client'

import { useCallback, useState } from 'react'
import {
  computeStats,
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
      const stats = computeStats(rows)
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
