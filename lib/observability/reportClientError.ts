/**
 * Fire-and-forget Sentry report for client-side catch paths (#1767).
 *
 * The SDK is reached through a dynamic import on purpose (#1520): a static
 * import of `sentryClient` from an error boundary or any layout-level module
 * puts the whole SDK back in the first load. Same shape as app/global-error.tsx.
 *
 * Never throws and never blocks: if the Sentry chunk is unavailable (often the
 * very reason the caller is failing) the report is lost, with no other symptom.
 *
 * Tags only — no emails, names or file contents.
 */
export type ClientErrorTags = {
  area: 'route-error' | 'import' | 'push'
  route?: string
  op?: string
  digest?: string
}

export function reportClientError(error: unknown, tags: ClientErrorTags): void {
  try {
    const clean = Object.fromEntries(
      Object.entries(tags).filter(([, v]) => v !== undefined),
    )
    import('@/lib/observability/sentryClient')
      .then((m) => m.captureException(error, { tags: clean }))
      .catch(() => {})
  } catch {
    // import() itself failing synchronously: nothing to do.
  }
}
