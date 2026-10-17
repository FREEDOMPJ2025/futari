'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { getCapacitorPlatform } from '@/components/KofiWidget'
import { useLocale, useTranslations } from '@/lib/i18n/client'
import { isLocale } from '@/lib/i18n/locales-meta'
import { localizedHref } from '@/lib/i18n/path'

/**
 * Settings rows for iPhone Shortcuts: the public guide (#1750) and the
 * personal shortcut key page (#1536).
 *
 * The guide only works with the iOS Shortcuts app, so the row is hidden inside
 * the Android shell. The gate is runtime (see KofiWidget): one deployment serves
 * every shell. Failure looks like: Android users seeing a link to a guide they
 * cannot follow, with no error. Nothing renders before mount so SSR and the
 * first client render agree.
 */
export function ShortcutsGuideRow() {
  const t = useTranslations()
  const raw = useLocale()
  const locale = isLocale(raw) ? raw : 'zh-TW'
  const [show, setShow] = useState(false)

  useEffect(() => {
    setShow(getCapacitorPlatform() !== 'android')
  }, [])

  if (!show) return null

  return (
    <>
      <div className="mt-3" />
      <Link
        href={localizedHref('/features/shortcuts', locale)}
        className="w-full flex items-center justify-between px-5 py-4 rounded-card text-left cursor-pointer no-underline bg-surface border border-hairline"
      >
        <div className="text-sm font-medium text-ink">{t.settings.shortcutsGuide}</div>
        <span className="text-sm shrink-0 text-ink-3" aria-hidden="true">›</span>
      </Link>
      {/* #1536 — the personal key a Shortcut sends to put a card in 待確認.
        * Same gate as the guide: the iOS Shortcuts app is its only consumer. */}
      <div className="mt-3" />
      <Link
        href="/settings/shortcut-key"
        className="w-full flex items-center justify-between px-5 py-4 rounded-card text-left cursor-pointer no-underline bg-surface border border-hairline"
      >
        <div className="text-sm font-medium text-ink">{t.settings.shortcutKey.navLabel}</div>
        <span className="text-sm shrink-0 text-ink-3" aria-hidden="true">›</span>
      </Link>
    </>
  )
}
