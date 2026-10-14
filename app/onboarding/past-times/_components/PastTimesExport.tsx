'use client'

import { Button } from '@/components/ui/Button'
import { useTransactionsExport } from '@/app/(dashboard)/settings/_components/useTransactionsExport'

/**
 * #1460 — export for a person with no ledger (a removed partner): they cannot
 * reach /settings/trust (the dashboard layout sends them to /onboarding), so
 * the standalone past-times list offers the same export. Same hook, same
 * route, same scope as /settings/trust and the leave flow.
 */
export function PastTimesExport({
  hint,
  cta,
  preparing,
  failed,
}: {
  hint: string
  cta: string
  preparing: string
  failed: string
}) {
  const { start, pending, error } = useTransactionsExport(failed)

  return (
    <div className="px-4 mt-6">
      <p className="text-sm mb-3 text-ink-3">{hint}</p>
      <Button variant="secondary" fullWidth onClick={start} disabled={pending}>
        {pending ? preparing : cta}
      </Button>
      {error && (
        <p className="text-xs mt-2 px-1 text-[var(--debit-text)]" role="alert">{error}</p>
      )}
    </div>
  )
}
