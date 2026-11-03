// Render the illustration-first store screenshots from store-screens.html.
//
// Each frame is laid out at 430×932 CSS px and rendered at deviceScaleFactor 3
// → 1290×2796, the App Store 6.7" size. Output has no alpha (omitBackground
// false), which both stores require.
//
// Usage:
//   cd scripts/og
//   node render-store-screens.mjs                      # zh-TW, iPhone 6.7", all frames
//   node render-store-screens.mjs --format=ipad-13     # 13" iPad
//   node render-store-screens.mjs --frames=1,3
//   node render-store-screens.mjs --locale=en
//
// --locale=<zh-TW|zh-CN|en|ja>  (default zh-TW). Picks the story copy and the
//   device screenshots of that locale (screenshots/ for zh-TW,
//   screenshots/<locale>/ for the others; see store-locales.mjs).
//   zh-CN / en / ja copy has {name} placeholders for demo-ledger facts. They
//   are filled from demo-data/<locale>.json (seed-demo-ledgers.ts --apply) and
//   {days} from demo-data/<locale>.capture.json (capture-screens.mjs, the day
//   count the plant card showed). A placeholder without a value refuses the
//   whole run before any file is written. zh-TW has no placeholders.
//   Copy marked `proposal: true` (not approved yet) renders normally and
//   prints one line saying so.
// --allow-pending-copy  render a locale whose copy is a placeholder
//   (`pending: true` in store-screens.html; no locale is, today). Without it
//   such a locale is refused. Drafts are written as
//   <NN>-<token>-DRAFT-<format>.png, a name asc-screenshots.mjs never uploads.
// --lang=zh  old spelling of --locale=zh-TW, still accepted.
//
// Default output: ../../docs/store-assets/story/<NN>-<token>-<format>.png,
// token = `zh` for zh-TW (the pre-#1904 names), the locale code otherwise:
//   01-zh-ios-6.7.png, 01-zh-CN-ios-6.7.png, 01-en-ios-6.7.png, 01-ja-ios-6.7.png
// Every written PNG is then run through check-store-pngs.mjs (size + alpha).

import puppeteer from 'puppeteer'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative } from 'node:path'
import { STORY_DIR, assertLocale, storyFileName, DEFAULT_LOCALE } from './store-locales.mjs'
import { checkPaths } from './check-store-pngs.mjs'
import { readDemoData, readCapture, daysSince, demoDataPath, capturePath } from './demo-data.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = resolve(__dirname, 'store-screens.html')
const TEMPLATE = `file://${TEMPLATE_PATH}`

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const legacyLang = arg('lang', null)
const locale = assertLocale(arg('locale', legacyLang === 'zh' ? 'zh-TW' : legacyLang || DEFAULT_LOCALE))
const allowPending = process.argv.includes('--allow-pending-copy')
// Store sizes. iPhone 6.7" is 430×932 @3x; the 13" iPad is 1032×1376 @2x —
// the only sizes App Store Connect accepts for APP_IPHONE_67 /
// APP_IPAD_PRO_3GEN_129 (see docs/app-store-submission-runbook.md §I).
const FORMATS = {
  'ios-6.7': { w: 430, h: 932, dsr: 3 },
  'ipad-13': { w: 1032, h: 1376, dsr: 2 },
}
const formatKey = arg('format', 'ios-6.7')
const fmt = FORMATS[formatKey]
if (!fmt) { console.error(`unknown --format=${formatKey}; use ${Object.keys(FORMATS).join(' | ')}`); process.exit(1) }
const frames = arg('frames', '1,2,3,4,5').split(',')
const outDir = resolve(arg('out', STORY_DIR))

const urlFor = (frame) =>
  `${TEMPLATE}?frame=${frame}&locale=${encodeURIComponent(locale)}&w=${fmt.w}&h=${fmt.h}`

// Values for the {name} placeholders of the story copy. zh-TW: none.
// {days} must be the number the captured plant card shows, so it comes from
// the capture record, and is checked against the app's own day count for the
// sprout date on the capture date. A mismatch means the screenshot and the
// headline would show two different numbers.
async function storeVars() {
  if (locale === DEFAULT_LOCALE) return { vars: {}, problems: [] }
  const problems = []
  const demo = readDemoData(locale)
  const capture = readCapture(locale)
  if (!demo) problems.push(`no ${relative(process.cwd(), demoDataPath(locale))}: seed the ${locale} demo ledger first (seed-demo-ledgers.ts --apply)`)
  if (!capture) problems.push(`no ${relative(process.cwd(), capturePath(locale))}: capture /assets in ${locale} first (capture-screens.mjs --locale=${locale})`)
  const vars = { ...(demo?.copyVars || {}) }
  if (demo && capture) {
    if (capture.groupId !== demo.groupId) {
      problems.push(`${locale}.capture.json was taken on group ${capture.groupId}, the demo data names ${demo.groupId}; capture again`)
    }
    const expected = await daysSince(demo.plantSproutedAt, capture.capturedOn)
    if (capture.plantDaysShown !== expected) {
      problems.push(`plant card showed ${capture.plantDaysShown} days on ${capture.capturedOn}, but ${demo.plantSproutedAt} → ${capture.capturedOn} is ${expected}; capture again`)
    } else {
      vars.days = capture.plantDaysShown
    }
  }
  return { vars, problems }
}

// A refusal (pending copy, missing screenshots): message already printed,
// exit 1 after the browser is closed. process.exit inside the try would skip
// the finally and leave Chromium running.
class Refusal extends Error {}

let draft = false
const { vars, problems: varProblems } = await storeVars()
// Before any of the page's own scripts run, so the template fills {name}.
const openPage = async () => {
  const page = await browser.newPage()
  await page.evaluateOnNewDocument((v) => { window.__STORE_VARS__ = v }, vars)
  return page
}
const browser = await puppeteer.launch({ headless: 'new', args: ['--allow-file-access-from-files'] })
const written = []

try {
  // Preflight on one page, before any file is written: copy approval and the
  // locale's device screenshots. Both are facts the template owns
  // (window.__STORE_META__), so this script never keeps a second list.
  {
    const page = await openPage()
    await page.goto(urlFor(frames[0]), { waitUntil: 'domcontentloaded', timeout: 30000 })
    const meta = await page.evaluate(() => window.__STORE_META__)
    await page.close()
    if (!meta) throw new Error('store-screens.html did not expose __STORE_META__')

    if (meta.pending) {
      if (!allowPending) {
        console.error(
          `✗ ${locale}: story copy is still a placeholder (pending: true in store-screens.html, #1904 needs-copy).\n` +
          '  The placeholder is the zh-TW text, so these images must not reach a store.\n' +
          '  Pass --allow-pending-copy to render a draft anyway.',
        )
        throw new Refusal()
      }
      draft = true
      const bar = '!'.repeat(72)
      console.warn(`\n${bar}\n!! ${locale}: RENDERING WITH PENDING COPY (zh-TW placeholder text).\n!! Draft only: written as *-DRAFT-*.png, which asc-screenshots.mjs never uploads. (#1904 needs-copy)\n${bar}\n`)
    }

    if (meta.proposal) console.log(`copy is a proposal (#1904), pending Ray`)

    if (meta.missingVars.length) {
      console.error(`✗ ${locale}: story copy needs values for ${meta.missingVars.map((n) => `{${n}}`).join(' ')}.`)
      varProblems.forEach((p) => console.error(`    ${p}`))
      throw new Refusal()
    }
    if (varProblems.length) {
      console.error(`✗ ${locale}: demo data and capture record disagree:`)
      varProblems.forEach((p) => console.error(`    ${p}`))
      throw new Refusal()
    }

    const missing = frames
      .filter((fr) => meta.shotsByFrame[fr])
      .map((fr) => resolve(dirname(TEMPLATE_PATH), meta.shotsByFrame[fr]))
      .filter((file, i, all) => all.indexOf(file) === i && !existsSync(file))
    if (missing.length) {
      console.error(`✗ ${locale}: device screenshots missing (the story frames crop these):`)
      missing.forEach((m) => console.error(`    ${relative(process.cwd(), m)}`))
      console.error(`  Capture them first: node capture-screens.mjs --locale=${locale} --only=ios-6.7`)
      throw new Refusal()
    }
  }

  await mkdir(outDir, { recursive: true })
  for (const frame of frames) {
    const page = await openPage()
    await page.setViewport({ width: fmt.w, height: fmt.h, deviceScaleFactor: fmt.dsr })
    await page.goto(urlFor(frame), {
      waitUntil: 'networkidle0',
      timeout: 30000,
    })
    // Without this wait the headline silently falls back to a system font.
    await page.waitForFunction(() => window.__OG_READY__ === true, { timeout: 15000 })
    const buf = await page.screenshot({ type: 'png', omitBackground: false })
    const name = storyFileName(locale, frame, formatKey, { draft })
    await writeFile(resolve(outDir, name), buf)
    written.push(resolve(outDir, name))
    console.log(`✓ ${name}`)
    await page.close()
  }
} catch (e) {
  if (!(e instanceof Refusal)) throw e
  process.exitCode = 1
} finally {
  await browser.close()
}
if (process.exitCode) process.exit()

console.log('\nChecking size / alpha:')
if (checkPaths(written)) process.exit(1)
