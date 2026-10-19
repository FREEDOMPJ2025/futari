'use client'

import { useState } from 'react'
import { PendingShortcutCard } from './PendingShortcutCard'
import { useTranslations } from '@/lib/i18n/client'
import type { ShortcutPendingView } from '@/lib/db/queries/shortcutPending'

export interface PendingShortcutStackProps {
  pendings: ShortcutPendingView[]
  onEdit: (pending: ShortcutPendingView) => void
}

export function PendingShortcutStack({ pendings, onEdit }: PendingShortcutStackProps) {
  const t = useTranslations()
  const copy = t.dashboard.shortcutPending
  const [expanded, setExpanded] = useState(false)
  if (pendings.length === 0) return null

  const visible = expanded ? pendings : pendings.slice(0, 2)
  const stacked = !expanded && pendings.length > 1

  return (
    <section className="mb-4 space-y-3">
      <div className="text-[var(--fs-xs)]" style={{ color: 'var(--ink-3)' }}>
        {copy.sectionLabel}
      </div>
      <div className="space-y-3">
        {visible.map((p, i) => (
          <div
            key={p.id}
            className={stacked && i > 0 ? '-mt-2 scale-[0.98]' : ''}
            style={{
              transformOrigin: 'top center',
              transition: 'transform 0.2s ease',
            }}
          >
            <PendingShortcutCard pending={p} onEdit={onEdit} />
          </div>
        ))}
      </div>
      {pendings.length > 2 && (
        <button
          type="button" onClick={() => setExpanded(!expanded)}
          className="w-full rounded-full py-2 text-[var(--fs-sm)]"
          style={{ border: '1px solid var(--hairline)', color: 'var(--ink-3)' }}
        >
          {expanded ? copy.collapse : copy.expandAll.replace('{n}', String(pendings.length - 2))}
        </button>
      )}
    </section>
  )
}
