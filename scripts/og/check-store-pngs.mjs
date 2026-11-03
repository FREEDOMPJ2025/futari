// Check store screenshots before they go anywhere near App Store Connect or
// Play Console: exact pixel size for the format in the file name, and no alpha.
//
//   cd scripts/og
//   node check-store-pngs.mjs                     # story/ + screenshots/ (all locales)
//   node check-store-pngs.mjs ../../docs/store-assets/story/01-en-ios-6.7.png
//   node check-store-pngs.mjs some/dir other/dir  # directories are walked recursively
//
// Why both checks: Apple only accepts the exact sizes below for the display
// types we upload, and rejects PNGs that carry an alpha channel. Both are
// rejected asynchronously, after asc-screenshots.mjs --apply has already
// deleted the old images, so the store can end up with fewer (or no)
// screenshots. Play is laxer, but asks for opaque images too.
//
// The format comes from the file name's last `-<format>.png` token, e.g.
// `01-en-ios-6.7.png` → ios-6.7, `en/02-records-play.png` → play. A PNG whose
// name matches no format is reported as an error rather than skipped, so a
// renamed file can't slip through unchecked.
//
// Exit code 1 if any file fails. No dependencies: reads the PNG chunks directly.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.resolve(__dirname, '..', '..', 'docs', 'store-assets')

export const STORE_PNG_FORMATS = {
  'ios-6.7': [1290, 2796], // App Store APP_IPHONE_67
  'ipad-13': [2064, 2752], // App Store APP_IPAD_PRO_3GEN_129
  play: [1080, 1920], //      Play phone
  tablet: [1080, 1920], //    Play 7" / 10" tablet
}

export function formatOf(file) {
  const base = path.basename(file)
  return Object.keys(STORE_PNG_FORMATS).find((k) => base.endsWith(`-${k}.png`)) || null
}

/** Reads IHDR and walks chunks up to IDAT looking for tRNS. */
export function pngInfo(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 33 || buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const colorType = buf[25]
  // Color types 4 (gray+alpha) and 6 (RGBA) carry an alpha channel; a tRNS
  // chunk adds transparency to types 0/2/3. Puppeteer screenshots with
  // omitBackground:false come out as type 2 (RGB), which is what we want.
  let hasTrns = false
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    if (type === 'tRNS') hasTrns = true
    if (type === 'IDAT' || type === 'IEND') break
    off += 12 + len
  }
  return { width, height, colorType, alpha: colorType === 4 || colorType === 6 || hasTrns }
}

/** @returns {string[]} problems; empty when the file is fine. */
export function checkPng(file) {
  const fmt = formatOf(file)
  if (!fmt) return [`file name matches no format (${Object.keys(STORE_PNG_FORMATS).join(' | ')})`]
  let info
  try {
    info = pngInfo(file)
  } catch (e) {
    return [e.message]
  }
  const problems = []
  const [w, h] = STORE_PNG_FORMATS[fmt]
  if (info.width !== w || info.height !== h) problems.push(`${info.width}×${info.height}, ${fmt} needs ${w}×${h}`)
  if (info.alpha) problems.push(`has alpha (PNG color type ${info.colorType}${info.colorType === 4 || info.colorType === 6 ? '' : ' + tRNS'})`)
  return problems
}

function walk(p) {
  const st = fs.statSync(p)
  if (st.isFile()) return p.endsWith('.png') ? [p] : []
  return fs.readdirSync(p).sort().flatMap((name) => walk(path.join(p, name)))
}

/** Checks files/directories, prints one line per file, returns the failure count. */
export function checkPaths(paths, { quiet = false } = {}) {
  const files = paths.flatMap((p) => {
    if (!fs.existsSync(p)) {
      console.error(`✗ ${p}: does not exist`)
      return [null]
    }
    return walk(p)
  })
  let failures = 0
  for (const file of files) {
    if (file === null) { failures++; continue }
    const problems = checkPng(file)
    const rel = file.startsWith(ASSETS + path.sep) ? path.relative(ASSETS, file)
      : file.startsWith(process.cwd() + path.sep) ? path.relative(process.cwd(), file) : file
    if (problems.length) {
      failures++
      console.error(`✗ ${rel}: ${problems.join('; ')}`)
    } else if (!quiet) {
      console.log(`✓ ${rel}`)
    }
  }
  if (!files.length) {
    console.error('✗ no PNG files found')
    failures++
  }
  return failures
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const paths = args.length ? args.map((a) => path.resolve(a)) : [path.join(ASSETS, 'story'), path.join(ASSETS, 'screenshots')]
  const failures = checkPaths(paths)
  console.log(failures ? `\n${failures} file(s) failed.` : '\nAll PNGs OK (exact size, no alpha).')
  process.exit(failures ? 1 : 0)
}
