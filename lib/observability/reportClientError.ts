import { sanitizeAnalyticsUrl } from '@/lib/analytics/urlSanitizer'

/**
 * Fire-and-forget Sentry report for client-side catch paths (#1767).
 *
 * The SDK is reached through a dynamic import on purpose (#1520): a static
 * import of `sentryClient` from an error boundary or any layout-level module
 * puts the whole SDK back in the first load. `urlSanitizer` is a small pure
 * module (only the global `URL`), so importing it statically costs nothing.
 *
 * Never throws and never blocks: if the Sentry chunk is unavailable (often the
 * very reason the caller is failing) the report is lost, with no other symptom.
 *
 * Tags only — no emails, names or file contents.
 *
 * `route` (#1768): when it looks like a path (starts with `/`) it goes through
 * `sanitizeAnalyticsUrl` here, whatever the caller already did. A raw path can
 * carry a bearer secret (`/invite/<token>`, `/<locale>/outing/<token>`), and the
 * Sentry `beforeSend` scrub only rewrites tag keys that look like URLs
 * (`url`, `*_url`, `target`, … — see `isUrlKey` in sentryScrub.ts); `route` is
 * not one of them, so a token in it would reach Sentry as-is. Failure looks
 * like nothing at all: the event arrives, the tag simply holds a live invite
 * link. Non-path values (the dashboard boundaries pass bare names such as
 * `'records'`) pass through unchanged.
 */
export type ClientErrorTags = {
  area: 'route-error' | 'import' | 'push' | 'global-error'
  route?: string
  op?: string
  digest?: string
}

export function reportClientError(error: unknown, tags: ClientErrorTags): void {
  try {
    const safe: ClientErrorTags =
      typeof tags.route === 'string' && tags.route.startsWith('/')
        ? { ...tags, route: sanitizeAnalyticsUrl(tags.route) || undefined }
        : tags
    const clean = Object.fromEntries(
      Object.entries(safe).filter(([, v]) => v !== undefined),
    )
    import('@/lib/observability/sentryClient')
      .then((m) => m.captureException(error, { tags: clean }))
      .catch(() => {})
  } catch {
    // import() itself failing synchronously: nothing to do.
  }
}
