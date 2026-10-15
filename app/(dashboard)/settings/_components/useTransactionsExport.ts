'use client'

import { useState, useTransition } from 'react'

/**
 * The one CSV export entry: `GET /api/export/transactions`, saved as a
 * download. Shared by /settings/trust, the leave flow's export-first hint
 * (#1611) and the standalone past-times list for a person with no ledger
 * (#1460), so all three start exactly the same export — same route, same
 * scope (every chapter the viewer may look back at, in any ledger: expenses,
 * income and settlements — lib/db/queries/export.ts), same filename.
 *
 * Copy that points at it names what the file holds (支出、進帳、結算); never
 * messages, unfinished trips or "everything".
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
