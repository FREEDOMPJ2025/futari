import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * #968 — Firebase / Google credentials never enter the repo.
 *
 * The repo is public. Android push needs two Firebase files: the client config
 * `google-services.json` (copied from the vault into android/app/ only for a
 * release build) and the FCM service-account key (vault + Supabase secrets
 * only). `.gitignore` covers both, but `git add -f`, a renamed file, or a key
 * pasted into source bypasses it.
 *
 * Failure looks like: nothing. The commit goes through, CI is green, the app
 * keeps working — the key just sits in public git history from then on, and
 * the only fix is rotating it. This test is the red light that otherwise
 * doesn't exist.
 *
 * It scans what git tracks (index included, so a staged-but-uncommitted file
 * is caught too), not the working tree, because only tracked content ships.
 */

const ROOT = join(__dirname, '..')

// Leak shapes. Built from pieces so this file doesn't contain them literally
// and can be scanned like every other file (no self-exemption).
const PEM_HEADER = '-----BEGIN ' + 'PRIVATE KEY-----'
const LEAK_SHAPES: [string, RegExp][] = [
  ['a service-account JSON "type" field', new RegExp('"type"\\s*:\\s*"service' + '_account"')],
  ['a "private_key" JSON key', new RegExp('"private' + '_key"\\s*:')],
  ['a PEM private-key header', new RegExp('-----BEGIN (RSA )?' + 'PRIVATE KEY-----')],
]

/**
 * Lines that legitimately match a leak shape. Each entry pins one exact
 * (trimmed) line in one file, so a real key added anywhere else — including
 * elsewhere in the same file — still fails. Entries that no longer match
 * anything fail too, so the list can't silently outgrow its reasons.
 */
// Empty since #968 S4b: send-recurring-push strips PEM armour with a generic
// pattern (pem.ts), so no tracked line spells out a private-key header.
const ALLOWED_LINES: { path: string; line: string; reason: string }[] = []

const MAX_BYTES = 2 * 1024 * 1024

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter(Boolean)
}

/** Text content of a tracked file, or null for symlinks, missing, large or binary files. */
function readText(rel: string): string | null {
  const abs = join(ROOT, rel)
  let st
  try {
    st = lstatSync(abs)
  } catch {
    return null // tracked but deleted in the working tree
  }
  if (!st.isFile() || st.size > MAX_BYTES) return null
  const buf = readFileSync(abs)
  if (buf.subarray(0, 8000).includes(0)) return null // binary
  return buf.toString('utf8')
}

describe('no Firebase / Google credentials tracked by git (#968)', () => {
  const files = trackedFiles()

  it('sees the tracked tree (guards against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('android/app/build.gradle')
  })

  it('tracks no google-services.json anywhere', () => {
    const hits = files.filter((f) => basename(f).toLowerCase() === 'google-services.json')
    expect(hits, 'google-services.json is tracked — untrack it (git rm --cached) and keep it in the vault').toEqual([])
  })

  it('tracks no file containing service-account or private-key material', () => {
    const hits: string[] = []
    const allowedSeen = new Set<number>()
    for (const rel of files) {
      const text = readText(rel)
      if (text === null) continue
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        for (const [label, re] of LEAK_SHAPES) {
          if (!re.test(lines[i])) continue
          const allowed = ALLOWED_LINES.findIndex((a) => a.path === rel && a.line === lines[i].trim())
          if (allowed === -1) hits.push(`${rel}:${i + 1} — ${label}`)
          else allowedSeen.add(allowed)
        }
      }
    }
    expect(hits, 'credential material is tracked — remove it, purge it from history, and rotate the key').toEqual([])
    const stale = ALLOWED_LINES.filter((_, i) => !allowedSeen.has(i)).map((a) => `${a.path}: ${a.line}`)
    expect(stale, 'allow-list entries that no longer match anything — delete them').toEqual([])
  })
})
