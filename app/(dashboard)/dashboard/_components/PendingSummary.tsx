'use client'

import { useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from '@/lib/i18n/client'
import { pickPlural } from '@/lib/i18n/plural'

// Open/closed for as long as this app session lives (#1851): a module-level
// value survives client navigations but not a reload or a relaunch, which is
// the "remember while the app is open, no cookie" the spec asks for. A fresh
// load always starts collapsed, so SSR and hydration agree.
let openThisSession = false

/**
 * One line standing in for the pending stacks (expense, shortcut, income) on
 * the dashboard (#1851): an Ember dot, 「N 筆待確認」 and a chevron. Tapping it
 * opens the unchanged card stacks in place, below the line; tapping again folds
 * them. The count is always on screen, so nothing waiting is hidden. Renders
 * nothing when there is nothing to confirm.
 */
export function PendingSummary({ count, children }: { count: number; children: ReactNode }) {
  const t = useTranslations()
  const locale = useLocale()
  const [open, setOpen] = useState(openThisSession)
  if (count <= 0) return null
  const toggle = () => {
    openThisSession = !open
    setOpen(!open)
  }
  return (
    <>
      <div className="px-5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="w-full min-h-11 flex items-center gap-2 text-sm text-ink text-left bg-transparent border-0 p-0 cursor-pointer"
        >
          <span
            aria-hidden="true"
            className="inline-block rounded-full shrink-0"
            style={{ width: 8, height: 8, background: 'var(--accent)' }}
          />
          <span className="flex-1 min-w-0">{pickPlural(locale, count, t.dashboard.pendingSummary).replace('{n}', String(count))}</span>
          <svg
            width="8" height="13" viewBox="0 0 8 13" fill="none" aria-hidden="true"
            className={`shrink-0 text-ink-3 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          >
            <path d="M1.5 1.5L6.5 6.5L1.5 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {open && children}
    </>
  )
}
