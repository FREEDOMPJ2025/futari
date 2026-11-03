// One table for the store-asset locales, shared by capture-screens.mjs,
// render-store-screens.mjs and asc-screenshots.mjs (#1904).
//
// Locale codes are the app's (lib/i18n/locales-meta.ts SUPPORTED_LOCALES), so
// the same value goes into the `lang` cookie when capturing.
//
// File naming:
//   screenshots/<name>-<format>.png            zh-TW (unchanged since 2026-08)
//   screenshots/<locale>/<name>-<format>.png   zh-CN, en, ja
//   story/<NN>-zh-<format>.png                 zh-TW (unchanged; `zh` predates #1904)
//   story/<NN>-<locale>-<format>.png           zh-CN, en, ja  (e.g. 01-zh-CN-ios-6.7.png)
//   story/<NN>-<token>-DRAFT-<format>.png      rendered with --allow-pending-copy; never uploaded
// zh-TW keeps its old names so existing commands, docs and ASC history keep
// pointing at the same files.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ASSETS_DIR = path.resolve(__dirname, '..', '..', 'docs', 'store-assets')
export const STORY_DIR = path.join(ASSETS_DIR, 'story')
export const SHOTS_DIR = path.join(ASSETS_DIR, 'screenshots')

export const DEFAULT_LOCALE = 'zh-TW'

export const STORE_LOCALES = {
  // asc: App Store Connect appStoreVersionLocalization.locale
  'zh-TW': { storyToken: 'zh', shotsSubdir: '', asc: 'zh-Hant' },
  'zh-CN': { storyToken: 'zh-CN', shotsSubdir: 'zh-CN', asc: 'zh-Hans' },
  en: { storyToken: 'en', shotsSubdir: 'en', asc: 'en-US' },
  ja: { storyToken: 'ja', shotsSubdir: 'ja', asc: 'ja' },
}

export function assertLocale(locale) {
  if (!STORE_LOCALES[locale]) {
    console.error(`unknown locale "${locale}"; use ${Object.keys(STORE_LOCALES).join(' | ')}`)
    process.exit(1)
  }
  return locale
}

/** Directory holding the raw device screenshots for a locale. */
export const shotsDirFor = (locale) => path.join(SHOTS_DIR, STORE_LOCALES[locale].shotsSubdir)

/**
 * story/ file name for a frame, e.g. storyFileName('en', 1, 'ios-6.7') → 01-en-ios-6.7.png.
 * Drafts rendered from pending (unapproved) copy get `-DRAFT` after the locale
 * token — 01-en-DRAFT-ios-6.7.png — which storyFilePattern never matches, so
 * asc-screenshots.mjs cannot pick them up for upload.
 */
export const storyFileName = (locale, frame, format, { draft = false } = {}) =>
  `${String(frame).padStart(2, '0')}-${STORE_LOCALES[locale].storyToken}${draft ? '-DRAFT' : ''}-${format}.png`

/**
 * Regex matching one locale's story files for a format. Anchored on the frame
 * number so `zh` never matches `zh-CN` files: 01-zh-ios-6.7.png vs 01-zh-CN-ios-6.7.png.
 */
export const storyFilePattern = (locale, format) =>
  new RegExp(`^\\d{2}-${STORE_LOCALES[locale].storyToken.replace(/-/g, '\\-')}-${format.replace(/\./g, '\\.')}\\.png$`)

/** App locale for an App Store Connect locale code, or null. */
export const localeForAsc = (asc) => Object.keys(STORE_LOCALES).find((l) => STORE_LOCALES[l].asc === asc) || null

export const localeArg = (argv = process.argv) => {
  const hit = argv.find((a) => a.startsWith('--locale='))
  return assertLocale(hit ? hit.slice('--locale='.length) : DEFAULT_LOCALE)
}
