import { track } from '@/lib/analytics/track'

/**
 * #1723 — `outing_link_shared`, the member's step in the outing funnel:
 * … → `outing_created` (server, actions/outing.ts) → `outing_link_shared` → `outing_joined` → …
 *
 * Carries `method` and nothing else: no outing id, name, share token or URL.
 * The token is a bearer secret (anyone holding it can join) and the name is
 * the household's own text. A typed helper rather than an inline `track()` so
 * a new share surface (#1727: system share sheet, QR) cannot add a property by
 * accident.
 *
 * What failure looks like: nothing errors. A property added here would simply
 * show up in PostHog's event table; `tests/outing-analytics-1723.test.tsx`
 * pins the exact property set.
 */
export type OutingShareMethod = 'share' | 'copy' | 'qr'

/**
 * After the link actually left the app: `copy` once the clipboard write
 * resolved, `share` once the share sheet resolved (not cancelled), `qr` when
 * the code is shown to be scanned.
 */
export function trackOutingLinkShared(method: OutingShareMethod): void {
  track('outing_link_shared', { method })
}
