import { requireViewerOrRedirect } from '@/lib/auth/viewer'
import { getActiveShortcutKeySummary } from '@/lib/db/queries/shortcutKey'
import { getLocale } from '@/lib/i18n/t'
import { BottomNavSkeleton } from '@/app/(dashboard)/_components/BottomNavSkeleton'
import { ShortcutKeyContent, type ShortcutKeyView } from './_components/ShortcutKeyContent'

// Per-user, never prerendered or cached. Reading the session cookie already
// makes it dynamic (`private, no-store`); stated so it stays that way if the
// auth read ever moves. The service worker does not cache /settings/* either
// (app/sw.ts runtimeCaching lists /dashboard, /records, /assets only).
export const dynamic = 'force-dynamic'

/** Taipei wall-clock time (TW-only product, same zone as the rest of the app). */
function formatTaipei(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d)
}

/**
 * #1536 — 捷徑金鑰. The props below are the page's whole RSC payload for this
 * route: last 4 characters and two times, formatted here so SSR and hydration
 * cannot disagree. The plaintext key never comes through here; the client
 * component holds it in state after the generate action returns it.
 */
export default async function ShortcutKeyPage() {
  const { user } = await requireViewerOrRedirect()
  const [summary, locale] = await Promise.all([
    getActiveShortcutKeySummary(user.id),
    getLocale(),
  ])

  const current: ShortcutKeyView | null = summary
    ? {
        hint: summary.hint,
        createdLabel: formatTaipei(summary.createdAt, locale),
        lastUsedLabel: summary.lastUsedAt ? formatTaipei(summary.lastUsedAt, locale) : null,
      }
    : null

  return (
    <div className="relative min-h-dvh pb-[var(--bottom-nav-offset)]">
      <ShortcutKeyContent current={current} />
      <BottomNavSkeleton hideFab />
    </div>
  )
}
