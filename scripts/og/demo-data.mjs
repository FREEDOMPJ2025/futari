// Per-locale demo-ledger facts for the store screenshots (#1904), shared by
// seed-demo-ledgers.ts (writes <locale>.json), capture-screens.mjs (reads the
// group / trip, writes <locale>.capture.json) and render-store-screens.mjs
// (fills the {name} placeholders of the story copy).
//
//   demo-data/<locale>.json          written by `seed-demo-ledgers.ts --apply`:
//                                    group id and name, trip id, plant name and
//                                    sprout date, the copy variables
//   demo-data/<locale>.capture.json  written by `capture-screens.mjs --locale`
//                                    after it captured /assets: the day count
//                                    the plant card showed, and the date
//
// zh-TW has neither file: its ledger and its copy predate #1904 and stay as
// they are (group 3a896cf2-…, trip 0eeb2477-…, "285 天" in the copy).

import path from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEMO_DATA_DIR = path.join(__dirname, 'demo-data')

export const demoDataPath = (locale) => path.join(DEMO_DATA_DIR, `${locale}.json`)
export const capturePath = (locale) => path.join(DEMO_DATA_DIR, `${locale}.capture.json`)

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null)

/** The seeded ledger of a locale, or null (zh-TW, or not seeded yet). */
export const readDemoData = (locale) => readJson(demoDataPath(locale))
export const readCapture = (locale) => readJson(capturePath(locale))

export function writeCapture(locale, data) {
  mkdirSync(DEMO_DATA_DIR, { recursive: true })
  writeFileSync(capturePath(locale), JSON.stringify(data, null, 2) + '\n')
}

/**
 * Whole calendar days from `startYmd` to `todayYmd`, or null when either is
 * missing or the start is after today. The same composition as the app's
 * `daysSince` (lib/age.ts), built from the same two functions of
 * lib/local-date.ts, which is what the plant card's 陪伴 N 天 shows
 * (AibutsuCard.tsx PlantCard → daysSince(plantSproutedAt, useToday())).
 * lib/age.ts itself cannot be imported here: it imports './local-date'
 * without an extension, which plain Node does not resolve.
 */
export async function daysSince(startYmd, todayYmd) {
  const listeners = process.listeners('warning')
  process.removeAllListeners('warning') // the "Reparsing as ES module" notice
  try {
    const { parseLocalDate, daysBetween } = await import(path.resolve(__dirname, '..', '..', 'lib', 'local-date.ts'))
    const start = parseLocalDate(startYmd)
    const today = parseLocalDate(todayYmd)
    if (!start || !today) return null
    const days = daysBetween(start, today)
    return days < 0 ? null : days
  } finally {
    await new Promise((r) => setTimeout(r, 0))
    listeners.forEach((l) => process.on('warning', l))
  }
}
