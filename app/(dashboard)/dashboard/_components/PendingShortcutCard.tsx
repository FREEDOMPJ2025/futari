'use client'

import { getCategory } from '@/lib/categories'
import { confirmShortcutPending, skipShortcutPending } from '@/actions/shortcutPending'
import { useTranslations } from '@/lib/i18n/client'
import type { ShortcutPendingView } from '@/lib/db/queries/shortcutPending'
import { PendingCard } from './PendingCard'

export interface PendingShortcutCardProps {
  pending: ShortcutPendingView
  onEdit: (pending: ShortcutPendingView) => void
}

/**
 * A card an iOS Shortcut left in 待確認 (#1536). Same chrome as the recurring
 * cards (PendingCard); what differs is the content and the rule that a card
 * with no note has no one-tap confirm — the record needs a description and we
 * do not invent one. The note is rendered as text only (React escapes it;
 * nothing here turns it into a link).
 */
export function PendingShortcutCard({ pending, onEdit }: PendingShortcutCardProps) {
  const t = useTranslations()
  const copy = t.dashboard.shortcutPending
  // A null / unknown category reads and records as 「其他」.
  const cat = getCategory(pending.category ?? 'other')
  const categoryLabel = t.category[cat.id] ?? cat.label
  const note = pending.note?.trim() ? pending.note : null

  return (
    <PendingCard
      cat={cat}
      gradientAlpha="45"
      title={note ?? categoryLabel}
      date={pending.day}
      amount={pending.amount}
      meta={note ? categoryLabel : copy.noNoteHint}
      confirmLabel={note ? copy.primaryAction : undefined}
      editLabel={note ? copy.editAction : copy.editOnlyAction}
      skipLabel={copy.skipAction}
      primaryDisabledClass="disabled:opacity-50 disabled:cursor-not-allowed"
      secondaryDisabledClass="disabled:opacity-50 disabled:cursor-not-allowed"
      onConfirm={note ? () => confirmShortcutPending(pending.id) : undefined}
      onSkip={() => skipShortcutPending(pending.id)}
      confirmErrorFallback={t.common.error}
      skipErrorFallback={t.common.error}
      skipModalTitle={copy.skipConfirmTitle}
      skipModalDescription={copy.skipConfirmDescription}
      onEdit={() => onEdit(pending)}
    />
  )
}
