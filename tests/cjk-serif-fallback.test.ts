import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * #1849 — Fraunces covers Latin only, so CJK glyphs in serif headings fall
 * through to the platform default unless `--font-fraunces` lists explicit
 * per-locale system CJK families after `'Fraunces', 'Fraunces Fallback'`.
 */

const REPO_ROOT = process.cwd()
const frauncesCss = readFileSync(join(REPO_ROOT, 'app/fonts/fraunces.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const globalsCss = readFileSync(join(REPO_ROOT, 'app/globals.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const fontScript = readFileSync(join(REPO_ROOT, 'scripts/fetch-google-fonts.mjs'), 'utf8')

function frauncesStackFor(lang: string): string {
  const escaped = lang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\.font-fraunces:lang\\(${escaped}\\)[^{]*\\{\\s*--font-fraunces\\s*:\\s*([^;}]+)`)
  const m = frauncesCss.match(re)
  if (!m) throw new Error(`no --font-fraunces rule found for :lang(${lang})`)
  return m[1].trim()
}

describe('CJK serif heading fallback stack (#1849)', () => {
  it('keeps the base .font-fraunces stack unchanged for English / Latin routes', () => {
    expect(frauncesCss).toMatch(
      /\.font-fraunces\s*\{\s*--font-fraunces:\s*'Fraunces',\s*'Fraunces Fallback';\s*\}/,
    )
  })

  it('appends Traditional Chinese system fonts after Fraunces for zh-TW', () => {
    for (const lang of ['zh-TW']) {
      const stack = frauncesStackFor(lang)
      expect(stack.startsWith("'Fraunces','Fraunces Fallback'")).toBe(true)
      for (const fam of ['PingFang TC', 'Microsoft JhengHei', 'Noto Sans CJK TC', 'Noto Sans TC', 'sans-serif']) {
        expect(stack).toContain(fam)
      }
    }
  })

  it('appends Simplified Chinese system fonts after Fraunces for zh-CN', () => {
    for (const lang of ['zh-CN']) {
      const stack = frauncesStackFor(lang)
      expect(stack.startsWith("'Fraunces','Fraunces Fallback'")).toBe(true)
      for (const fam of ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', 'sans-serif']) {
        expect(stack).toContain(fam)
      }
    }
  })

  it('appends Japanese system fonts after Fraunces for ja', () => {
    const stack = frauncesStackFor('ja')
    expect(stack.startsWith("'Fraunces','Fraunces Fallback'")).toBe(true)
    for (const fam of [
      'Hiragino Sans',
      'Hiragino Kaku Gothic ProN',
      'Yu Gothic',
      'Meiryo',
      'Noto Sans CJK JP',
      'Noto Sans JP',
      'sans-serif',
    ]) {
      expect(stack).toContain(fam)
    }
  })

  it('keeps scripts/fetch-google-fonts.mjs in sync with app/fonts/fraunces.css', () => {
    for (const lang of ['zh-TW', 'zh-CN', 'ja']) {
      expect(fontScript).toContain(`.font-fraunces:lang(${lang})`)
      expect(fontScript).toContain(frauncesStackFor(lang))
    }
  })

  it('sets CJK serif heading weight (500), default line-height, and line-breaking in globals.css without overriding utilities', () => {
    expect(globalsCss).toMatch(
      /@layer base\{:is\(h1,h2,h3\)\.font-serif:is\(:lang\(zh\),:lang\(ja\)\)\{font-weight:500;line-height:1\.35\}\}/,
    )
    expect(globalsCss).toMatch(
      /:is\(\.brand,\.font-serif\):lang\(zh\),:is\(\.brand,\.font-serif\):lang\(ja\)\{line-break:strict;word-break:auto-phrase;font-synthesis-style:none\}/,
    )
  })
})
