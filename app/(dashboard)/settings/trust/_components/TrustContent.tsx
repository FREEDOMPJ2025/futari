'use client'

import { useTranslations } from '@/lib/i18n/client'
import { SubpageHeader } from '@/app/(dashboard)/_components/SubpageHeader'
import { TrustCommitments } from './TrustCommitments'
import { useTransactionsExport } from '@/app/(dashboard)/settings/_components/useTransactionsExport'

export function TrustContent() {
  const t = useTranslations()

  // Same entry the leave flow's export-first hint starts (#1611).
  const { start: handleExport, pending: exportPending, error: exportError } =
    useTransactionsExport(t.csvExport.failed)

  return (
    <>
      <SubpageHeader title={t.trust.title} backLabel={t.trust.back} />

      <div className="px-5 pt-6 pb-8">
        <h1
          className="text-page leading-tight"
          style={{ color: 'var(--ink)', fontWeight: 500 }}
        >
          {t.trust.pageHeading}
        </h1>
        <p className="text-sm mt-3" style={{ color: 'var(--ink-2)' }}>
          {t.trust.pageSubtitle}
        </p>
      </div>

      <div className="px-4 pb-6">
        <button
          type="button"
          onClick={handleExport}
          disabled={exportPending}
          className="w-full flex items-center justify-between px-5 py-4 rounded-card text-left bg-transparent cursor-pointer disabled:cursor-default disabled:opacity-50"
          style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
        >
          <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
            {exportPending ? t.csvExport.preparing : t.settings.exportData}
          </div>
          <span className="text-sm shrink-0" style={{ color: 'var(--ink-3)' }} aria-hidden="true">›</span>
        </button>
        {exportError && (
          <div className="text-xs mt-2 px-1" style={{ color: 'var(--debit-text)' }}>
            {exportError}
          </div>
        )}
      </div>

      <div className="px-4 pb-12">
        <TrustCommitments t={t.trust} />
      </div>
    </>
  )
}
