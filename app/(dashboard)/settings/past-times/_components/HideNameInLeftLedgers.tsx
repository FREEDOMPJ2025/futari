'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/Toast'
import { ConfirmModal } from '@/app/(dashboard)/_components/ConfirmModal'
import { hideMyNameInLeftLedgers } from '@/actions/profile'
import { unwrapAction } from '@/lib/action-errors'
import { describeError } from '@/lib/errors'
import { useTranslations } from '@/lib/i18n/client'

/**
 * #1619 — 「我在已離開帳本裡的名字」: one tap renames the viewer to
 * 「已離開的夥伴」 in the closed chapters of the ledgers they left, and on those
 * chapters' outing lists. One-way, so it goes through a ConfirmModal that
 * names the scope, says it cannot be undone, and shows how many places change.
 *
 * Rendered by both entry points — /settings/past-times (has a ledger) and
 * /onboarding/past-times (no ledger: the dashboard layout sends them away
 * from settings) — which pass the server-side count. Nothing to change → the
 * row is not shown at all; after a run the refresh brings back 0 / 0 and the
 * row disappears.
 *
 * Copy rule (#1191's lesson): say the scope only. Never 「移除」「徹底」
 * 「所有地方」, and never the viewer's own name.
 */
export function HideNameInLeftLedgers({ chapters, outings }: { chapters: number; outings: number }) {
  const t = useTranslations()
  const copy = t.pastTimes.hideName
  const router = useRouter()
  const { showToast } = useToast()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)

  if (chapters + outings === 0) return null

  async function handleConfirm() {
    setPending(true)
    try {
      unwrapAction(await hideMyNameInLeftLedgers())
      setConfirming(false)
      showToast(copy.done)
      router.refresh()
    } catch (e) {
      setConfirming(false)
      showToast(describeError(e, copy.failed, t.common.offlineError, t.errors.actions))
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="px-4 mt-6" aria-labelledby="hide-name-left-ledgers-title">
      <h2 id="hide-name-left-ledgers-title" className="text-sm font-medium text-ink">{copy.title}</h2>
      <p className="text-sm mt-1 mb-3 text-ink-3">{copy.hint}</p>
      <Button variant="secondary" fullWidth onClick={() => setConfirming(true)} disabled={pending}>
        {pending ? copy.pending : copy.cta}
      </Button>
      <ConfirmModal
        open={confirming}
        title={copy.confirmTitle}
        description={copy.confirmBody}
        confirmLabel={copy.confirmLabel}
        pending={pending}
        onCancel={() => setConfirming(false)}
        onConfirm={handleConfirm}
      >
        <p className="text-sm text-ink-2">
          {copy.confirmCount
            .replace('{chapters}', String(chapters))
            .replace('{outings}', String(outings))}
        </p>
      </ConfirmModal>
    </section>
  )
}
