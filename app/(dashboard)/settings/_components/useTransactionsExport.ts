'use client'

import { useState, useTransition } from 'react'

/**
 * The one CSV export entry: `GET /api/export/transactions` for the viewer's
 * current ledger, saved as a download. Shared by /settings/trust and the
 * leave flow's export-first hint (#1611) so both start exactly the same
 * export — same route, same scope (the viewer's chapters of this ledger,
 * expenses only: listAllActiveCashTransactionsForExport), same filename.
 *
 * Copy that points at it must say expenses (支出) only until the export
 * covers income and settlements (#1460).
 */
export function useTransactionsExport(failedMessage: string) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const start = () => {
    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch('/api/export/transactions', { credentials: 'same-origin' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        const disposition = res.headers.get('Content-Disposition') ?? ''
        const match = /filename="?([^";]+)"?/i.exec(disposition)
        const filename = match?.[1] ?? 'futari-transactions.csv'

        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      } catch {
        setError(failedMessage)
      }
    })
  }

  return { start, pending, error }
}
