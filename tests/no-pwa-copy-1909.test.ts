import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { dictionaries } from '@/lib/i18n/t'
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales-meta'

// #1909 — user-facing copy describes the platforms (iPhone, Android, web),
// never "PWA". Walks every string value of each dictionary (titles,
// descriptions, og, srTagline, JSON-LD, FAQ, migrate pages); key names such as
// `trustPwa` are identifiers and are not checked.
function stringValues(node: unknown, trail: string, out: { at: string; text: string }[] = []) {
  if (typeof node === 'string') out.push({ at: trail, text: node })
  else if (Array.isArray(node)) node.forEach((v, i) => stringValues(v, `${trail}[${i}]`, out))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) stringValues(v, `${trail}.${k}`, out)
  }
  return out
}

describe('no "PWA" in user-facing copy (#1909)', () => {
  it.each(SUPPORTED_LOCALES)('%s: no dictionary string mentions PWA', (locale) => {
    const hits = stringValues(dictionaries[locale], locale).filter((s) => /PWA/i.test(s.text))
    expect(hits.map((h) => h.at)).toEqual([])
  })

  it.each(SUPPORTED_LOCALES)('%s: landing title, description and og carry no PWA', (locale) => {
    const { landing, signIn } = dictionaries[locale].seo
    for (const text of [landing.title, landing.description, landing.ogDescription, signIn.description, signIn.ogDescription]) {
      expect(text).not.toMatch(/PWA/i)
    }
  })

  it('zh-TW and zh-CN landing titles lead with the keyword (Ray 11-04, option A)', () => {
    expect(dictionaries['zh-TW'].seo.landing.title).toBe('伴侶共享記帳 App｜Futari · 兩個人，一本帳')
    expect(dictionaries['zh-CN'].seo.landing.title).toBe('情侣共享记账 App｜Futari · 两个人，一本账')
  })

  // Aria's approved sentences (#1909 comment 6975044371, section 3; Ray: "#1909 desc ok"), verbatim.
  it('zh-CN and ja landing descriptions are Aria\'s approved sentences (verbatim)', () => {
    expect(dictionaries['zh-CN'].seo.landing.description).toBe('Futari 是为夫妻、情侣设计的共同记账 App，iPhone、Android 和网页版都能用。两个人一起记账、自动分摊花费、AA 结算，从日常开销到旅行、爱车与资产，看见两个人的生活全貌。')
    expect(dictionaries.ja.seo.landing.description).toBe('Futari（ふたり）は、カップル・夫婦のための共同家計簿アプリ。iPhone・Android・Web で使えます。一緒に記録、自動按分、精算、愛車の燃費まで、ふたりの暮らしをまるごと見える化。')
  })

  it('llms.txt has no PWA wording', () => {
    const body = readFileSync(path.join(process.cwd(), 'public', 'llms.txt'), 'utf8')
    expect(body).not.toMatch(/PWA|Progressive Web App/i)
  })

  it('llms-full.txt has no PWA wording anywhere', () => {
    const body = readFileSync(path.join(process.cwd(), 'public', 'llms-full.txt'), 'utf8')
    expect(body).not.toMatch(/PWA|Progressive Web App/i)
  })

  it('llms-full.txt: intro, section 12 and the Honeydue line have no PWA wording', () => {
    const body = readFileSync(path.join(process.cwd(), 'public', 'llms-full.txt'), 'utf8')
    const lines = body.split('\n')
    expect(lines[2]).not.toMatch(/PWA/i)
    const s12 = body.slice(body.indexOf('### 12.'), body.indexOf('### 13.'))
    expect(s12).toContain('### 12. iPhone, Android and the web')
    expect(s12).not.toMatch(/PWA|Progressive Web App|queue locally/i)
    expect(lines.find((l) => l.startsWith('- **vs. Honeydue**'))).not.toMatch(/PWA/i)
  })
})
