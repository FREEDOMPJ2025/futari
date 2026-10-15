'use client'

import { useEffect, useState } from 'react'
import { track } from '@/lib/analytics/track'
import { useTranslations } from '@/lib/i18n/client'
import { Button } from '@/components/ui/Button'
import { Card, SectionTitle } from './OutingPublicChrome'

/** Per-outing dismissal; the key holds the outing id, never the share token. */
export const ledgerInviteDismissKey = (outingId: string) => `futari:outing-ledger-invite-dismissed:${outingId}`

function isDismissed(outingId: string): boolean {
  try {
    return window.localStorage.getItem(ledgerInviteDismissKey(outingId)) === '1'
  } catch {
    return false // unreadable storage: show the card; closing still hides it for this visit
  }
}

/**
 * #1728 — once an outing is over, one quiet card for the friend: Futari is
 * also for two people's everyday spending. The page decides who may see it
 * (ended outing, viewer not a signed-in user with a ledger); this component
 * only handles the per-outing dismissal and the two events.
 *
 * Nothing renders before mount: the dismissal lives in localStorage, so the
 * server render and the first client render agree on "no card". Events carry
 * no properties: no outing id, name, token or URL.
 * Failure looks like: nothing errors. A closed card reappearing on the same
 * outing means the key changed or storage is blocked (then it hides only for
 * the visit, by design).
 */
export function LedgerInviteCard({ outingId, href }: { outingId: string; href: string }) {
  const t = useTranslations()
  const c = t.outingPublic
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (isDismissed(outingId)) return
    setShow(true)
    track('outing_ledger_invite_viewed')
  }, [outingId])

  if (!show) return null

  const dismiss = () => {
    setShow(false)
    try {
      window.localStorage.setItem(ledgerInviteDismissKey(outingId), '1')
    } catch {
      // unwritable: hidden for this visit only
    }
  }

  return (
    <Card>
      <SectionTitle>{c.ledgerInviteTitle}</SectionTitle>
      <p className="text-sm text-ink-3 mb-3">{c.ledgerInviteBody}</p>
      <div className="flex gap-2.5">
        <a
          href={href}
          rel="noreferrer"
          onClick={() => track('outing_ledger_invite_clicked')}
          className="flex-1 inline-flex items-center justify-center rounded-bubble font-medium h-[var(--control-md)] px-5 text-base bg-[var(--btn-secondary-bg)] text-[var(--btn-secondary-text)] border border-[var(--btn-secondary-border)]"
        >
          {c.ledgerInviteCta}
        </a>
        <Button variant="ghost" onClick={dismiss}>{c.ledgerInviteDismiss}</Button>
      </div>
    </Card>
  )
}
