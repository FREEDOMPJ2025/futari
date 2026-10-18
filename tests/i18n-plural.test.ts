import { describe, it, expect } from 'vitest'
import { pickPlural } from '@/lib/i18n/plural'
import { en } from '@/lib/i18n/locales/en'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { ja } from '@/lib/i18n/locales/ja'

const forms = { one: 'ONE', other: 'OTHER' }

describe('pickPlural', () => {
  it('en: 1 -> one, 0 / 2 / many -> other', () => {
    expect(pickPlural('en', 1, forms)).toBe('ONE')
    expect(pickPlural('en', 0, forms)).toBe('OTHER')
    expect(pickPlural('en', 2, forms)).toBe('OTHER')
    expect(pickPlural('en', 20, forms)).toBe('OTHER')
  })

  it.each(['zh-TW', 'zh-CN', 'ja'])('%s: always the single (other) form', (locale) => {
    for (const n of [0, 1, 2, 5]) expect(pickPlural(locale, n, forms)).toBe('OTHER')
  })
})

describe('outing plural strings', () => {
  it('en reads naturally at 1 and 2', () => {
    const tag = (n: number) => pickPlural('en', n, en.outing.splitCountTag).replace('{count}', String(n))
    expect(tag(1)).toBe('1 person')
    expect(tag(3)).toBe('3 people')
    expect(pickPlural('en', 1, en.outing.share.unpicked).replace('{n}', '1')).toBe('1 name not picked yet')
    expect(pickPlural('en', 4, en.outing.share.unpicked).replace('{n}', '4')).toBe('4 names not picked yet')
    expect(pickPlural('en', 1, en.outingList.countTag)).toBe('1 person')
    const solo = (n: number) => pickPlural('en', n, en.dashboard.soloHero.countLabel).replace('{count}', String(n))
    expect(solo(1)).toBe('1 entry')
    expect(solo(7)).toBe('7 entries')
  })

  it.each([['zh-TW', zhTW], ['zh-CN', zhCN], ['ja', ja]] as const)('%s: one and other are identical', (_l, d) => {
    expect(d.outing.share.unpicked.one).toBe(d.outing.share.unpicked.other)
    expect(d.outing.splitCountTag.one).toBe(d.outing.splitCountTag.other)
    expect(d.outingList.countTag.one).toBe(d.outingList.countTag.other)
    expect(d.dashboard.soloHero.countLabel.one).toBe(d.dashboard.soloHero.countLabel.other)
  })
})
