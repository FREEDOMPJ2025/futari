import { describe, it, expect } from 'vitest'
import { splitPhrases, phraseHtml, phraseTextHtml } from '@/lib/i18n/phrase'

// #1522 follow-up: Safari / WKWebView break CJK per character, so headings need
// <wbr> at phrase boundaries. The failures this guards are silent and Apple-only:
// 「資／料」 / 「ありませ／ん。」 splits that Chrome never shows.

/** True when no phrase boundary falls inside any of `words`. */
function keepsTogether(text: string, words: string[]) {
  const parts = splitPhrases(text) ?? [text]
  return words.every((w) => parts.some((p) => p.includes(w)))
}

describe('splitPhrases', () => {
  it('round-trips: joining the phrases gives the text back', () => {
    for (const t of [
      '你的 Honeydue 資料，可以帶走',
      '把記過的帳，一起搬到 Futari',
      'ふたりで、ひとつの家計簿。',
      '移さなくても、今日から始められます',
      '兩個人，一本帳。',
    ]) {
      expect((splitPhrases(t) ?? [t]).join('')).toBe(t)
    }
  })

  it('does not split the words from the issue', () => {
    expect(keepsTogether('你的 Honeydue 資料，可以帶走', ['資料'])).toBe(true)
    expect(keepsTogether('這是什麼。', ['什麼'])).toBe(true)
    expect(keepsTogether('今のところ問題はありません。', ['ありません。'])).toBe(true)
    expect(keepsTogether('把記過的帳，一起搬到 Futari', ['一起'])).toBe(true)
    expect(keepsTogether('新婚夫妻的生活費怎麼分攤才不傷感情？', ['生活費', '怎麼', '分攤', '感情'])).toBe(true)
    expect(keepsTogether('ひとつの家計簿、ふたりの暮らし', ['ふたりの', '家計簿'])).toBe(true)
  })

  it('breaks at clause marks and between ja phrases', () => {
    expect(splitPhrases('ふたりで、ひとつの家計簿。')).toEqual(['ふたりで、', 'ひとつの', '家計簿。'])
    expect(splitPhrases('移さなくても、今日から始められます')).toEqual(['移さなくても、', '今日から', '始められます'])
  })

  it('leaves Latin-only text alone', () => {
    expect(splitPhrases('Two of you, one ledger.')).toBeNull()
    expect(phraseHtml('Two of you,<br />one ledger.')).toBe('Two of you,<br />one ledger.')
  })

  it('phraseHtml keeps tags and only inserts <wbr> in text', () => {
    const out = phraseHtml('ふたりで、<br />ひとつの家計簿。')
    expect(out).toBe('ふたりで、<br />ひとつの<wbr>家計簿。')
    expect(out.replace(/<wbr>/g, '')).toBe('ふたりで、<br />ひとつの家計簿。')
  })
})

// #1528 F2: body and row text. zh gets phrase breaks; ja keeps relying on
// Chromium's `auto-phrase` and must come out untouched, or the ja body text
// (clean today) would pick up `.ph` + `keep-all` for nothing.
describe('zhOnly (body text)', () => {
  const zh = '一筆一筆共同記下，自動分攤，可以對半也可以依比例。'
  const ja = 'ふたりで、ひとつの家計簿。家計簿その もの。'

  it('splits zh like a heading', () => {
    expect(splitPhrases(zh, true)).toEqual(splitPhrases(zh))
    expect(keepsTogether('毛孩的每一筆費用都值得被記住，清楚看見兩個人的心意。', ['值得被', '記住', '清楚', '看見'])).toBe(true)
  })

  it('leaves text with kana alone, in every helper', () => {
    expect(splitPhrases(ja, true)).toBeNull()
    expect(phraseTextHtml(ja, true)).toBeNull()
    expect(phraseHtml('ふたりで、<br />ひとつの家計簿。', true)).toBe('ふたりで、<br />ひとつの家計簿。')
    // headings still get ja phrases
    expect(splitPhrases(ja)).not.toBeNull()
  })

  it('leaves Latin text alone', () => {
    expect(splitPhrases('Two of you, one ledger.', true)).toBeNull()
    expect(phraseTextHtml('Two of you, one ledger.', true)).toBeNull()
  })

  it('phraseHtml(zhOnly) keeps tags and splits only the zh text', () => {
    const out = phraseHtml('為伴侶與夫妻設計的共同記帳。<br />日子一天天記下來，回頭看會很暖。', true)
    expect(out).toContain('<br />')
    expect(out).toContain('<wbr>')
    expect(out.replace(/<wbr>/g, '')).toBe('為伴侶與夫妻設計的共同記帳。<br />日子一天天記下來，回頭看會很暖。')
  })

  it('never breaks between the halves of 「——」 or 「……」', () => {
    for (const t of ['房租、水電、生活用品——同居支出很零碎', '等了很久……終於記下來了']) {
      for (const p of splitPhrases(t, true) ?? []) expect(p).not.toMatch(/^[—…]/)
    }
    expect(splitPhrases('app——有的介面很漂亮', true)?.join('|')).toContain('app——')
  })

  it('phraseTextHtml escapes markup and round-trips', () => {
    const text = '搬到 A&B <新>：用「轉換模板」整理成 CSV，再上傳到 Futari。'
    const html = phraseTextHtml(text, true)!
    expect(html).toContain('<wbr>')
    expect(html).not.toMatch(/<(?!wbr>)/)
    expect(html.replace(/<wbr>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')).toBe(text)
  })
})
