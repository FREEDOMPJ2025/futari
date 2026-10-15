// #1674 — `prebuild`: the web's offline page and basic service worker.
//
// Writes (all gitignored, regenerated on every build, like `public/sw.js`):
//   - public/offline-basic.html — renderOfflinePage's web target;
//   - public/sw-basic.js        — scripts/sw-basic-worker.ts, with the page's
//                                 SHA-256 in its bytes and its cache name;
//   - .offline-basic.build.json — the inline scripts' CSP hashes, read by
//                                 next.config.ts when `next build` loads it.
//
// Runs as `prebuild` (npm runs it before `build`, on Vercel too), with Node's
// native type stripping (Node ≥ 22.18; `.nvmrc` is 24). Failure looks like:
// `next build` stops with "missing .offline-basic.build.json" — or, if the
// hook itself never runs, the same error, never a silent deploy without the
// page's CSP. On a deploy, `/sw-basic.js` and `/offline-basic.html` answer 200
// and the CSP hash matches the page; check that with `curl -sI`.

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderWebOfflinePage } from './build-native-offline-page.ts'
import { renderBasicWorker } from './sw-basic-worker.ts'
import { SW_BASIC_MODE, type SwBasicMode } from '../lib/offline/swBasicMode.ts'
import { SUPPORTED_LOCALES } from '../lib/i18n/locales-meta.ts'
import {
  OFFLINE_BASIC_BUILD_ARTIFACT,
  type OfflineBasicBuildArtifact,
} from '../lib/offline/offlineBasicHeaders.ts'

/** `sha256-<base64>` for each inline `<script>…</script>` body, in page order. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    out.push(`sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}`)
  }
  return out
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface OfflineBasicBuild {
  page: string
  worker: string
  artifact: OfflineBasicBuildArtifact
}

export function buildOfflineBasic(mode: SwBasicMode = SW_BASIC_MODE): OfflineBasicBuild {
  const page = renderWebOfflinePage()
  const pageHash = sha256Hex(page)
  const worker = renderBasicWorker({ pageHash, mode, locales: SUPPORTED_LOCALES })
  return {
    page,
    worker,
    artifact: { scriptHashes: inlineScriptHashes(page), pageHash, mode },
  }
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const { page, worker, artifact } = buildOfflineBasic()
  const publicDir = join(repoRoot, 'public')
  mkdirSync(publicDir, { recursive: true })
  writeFileSync(join(publicDir, 'offline-basic.html'), page, 'utf8')
  writeFileSync(join(publicDir, 'sw-basic.js'), worker, 'utf8')
  writeFileSync(join(repoRoot, OFFLINE_BASIC_BUILD_ARTIFACT), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  console.log(`[offline-basic] mode=${artifact.mode} page=${artifact.pageHash.slice(0, 16)} → public/offline-basic.html, public/sw-basic.js`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
