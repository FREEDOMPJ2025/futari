// #1674 — response headers for the web's offline page and basic worker.
//
// `/offline-basic.html` is served by `next start` / Vercel from `public/`, and
// the basic worker copies these headers onto its cached copy, so they hold for
// the page the user actually sees offline too:
//   - CSP `default-src 'none'`: the page needs no network except its same-origin
//     probe (`connect-src 'self'`); its two inline scripts are allowed only by
//     their `sha256-` hashes, inline style by 'unsafe-inline' (no script
//     reads or writes styles from data);
//   - `frame-ancestors 'none'` + `X-Frame-Options: DENY`;
//   - `Referrer-Policy: no-referrer`;
//   - `no-store`, so the browser always byte-compares a fresh copy.
//
// The hashes come from a gitignored build artifact that `prebuild`
// (scripts/build-web-offline-basic.ts) writes BEFORE `next build` loads
// next.config.ts. A production build with no artifact fails instead of
// shipping the page without its CSP (next.config.ts). Failure looks like: the
// offline page renders blank, or the console shows "Refused to execute inline
// script" — the hashes no longer match the served page. Check the header hash
// against the served page on a deploy (`curl -sI`), not only in tests.
//
// Keep this file import-free: Node runs the generator with native type
// stripping, which does not resolve `@/` paths.

export const OFFLINE_BASIC_PAGE_SOURCE = '/offline-basic.html'
export const OFFLINE_BASIC_WORKER_SOURCE = '/sw-basic.js'

/** Written by `prebuild`, read by next.config.ts; relative to the repo root. */
export const OFFLINE_BASIC_BUILD_ARTIFACT = '.offline-basic.build.json'

export interface OfflineBasicBuildArtifact {
  /** `sha256-<base64>` of each inline `<script>` in the served page. */
  scriptHashes: string[]
  /** SHA-256 hex of the page bytes (also in the worker and its cache name). */
  pageHash: string
  mode: 'basic' | 'kill'
}

export function offlineBasicCsp(scriptHashes: readonly string[]): string {
  const scripts = scriptHashes.length
    ? scriptHashes.map((h) => `'${h}'`).join(' ')
    : "'none'"
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export function offlineBasicPageHeaders(scriptHashes: readonly string[]) {
  return [
    { key: 'Content-Security-Policy', value: offlineBasicCsp(scriptHashes) },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Cache-Control', value: 'no-store, max-age=0' },
  ]
}

export const OFFLINE_BASIC_WORKER_HEADERS = [
  { key: 'Cache-Control', value: 'no-store, max-age=0' },
]
