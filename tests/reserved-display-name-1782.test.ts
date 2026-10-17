import { describe, it, expect } from 'vitest'
import { RESERVED_LEFT_LABELS, isReservedDisplayName, normalizeForReservedCheck } from '@/lib/reservedDisplayName'
import { memberParticipantName, normalizeParticipantName } from '@/lib/outing/validate'
import { ActionError } from '@/lib/action-errors'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'

// ─── #1782 (a) — the system's left label is not a name a person can take ────
//
// Secondary control (the main one is the system style only a marker can
// set). Every normaliser bypass named in the plan has a case here; so does
// every name that must still pass (a ZWJ emoji, a name that only CONTAINS
// the label, a look-alike — the accepted residual).
// Failure looks like: nothing errors; someone names themself 「已離​開的夥伴」
// (with a zero-width space) and reads exactly like the system label.
// ──────────────────────────────────────────────────────────────────────────

describe('RESERVED_LEFT_LABELS', () => {
  it('is exactly each dictionary\'s common.leftPartnerLabel (the copy and the check cannot drift)', () => {
    expect([...RESERVED_LEFT_LABELS]).toEqual([
      zhTW.common.leftPartnerLabel, zhCN.common.leftPartnerLabel, en.common.leftPartnerLabel, ja.common.leftPartnerLabel,
    ])
  })
})

describe('isReservedDisplayName — blocked after normalisation', () => {
  const cases: [string, string][] = [
    ['zh-TW', '已離開的夥伴'],
    ['zh-CN', '已离开的伙伴'],
    ['en', 'a partner who left'],
    ['ja', '退出したパートナー'],
    // every traditional / simplified mix of 離/离, 開/开, 夥/伙
    ...['離開夥', '離開伙', '離开夥', '離开伙', '离開夥', '离開伙', '离开夥', '离开伙'].map(
      ([a, b, c]) => [`mix ${a}${b}${c}`, `已${a}${b}的${c}伴`] as [string, string]),
    ['zero-width space', '已離​開的夥伴'],
    ['zero-width joiner', '已‍離開的夥伴'],
    ['zero-width non-joiner', '已離開‌的夥伴'],
    ['word joiner', '已離開的⁠夥伴'],
    ['BOM', '﻿已離開的夥伴'],
    ['soft hyphen', '已離開的夥伴­'],
    ['bidi override', '‮已離開的夥伴‬'],
    ['bidi isolate', '⁦a partner who left⁩'],
    ['LRM / RLM', '‎a partner who left‏'],
    ['variation selector', '已️離開的夥伴'],
    ['tag character', '已離開的夥伴\u{E0041}'],
    ['ideographic space + padding', '　已離開的夥伴 '],
    ['collapsed whitespace + case', '  A   Partner\twho  LEFT '],
    ['fullwidth latin (NFKC)', 'ａ ｐａｒｔｎｅｒ ｗｈｏ ｌｅｆｔ'],
    ['halfwidth katakana (NFKC)', '退出したﾊﾟｰﾄﾅｰ'],
    ['non-breaking space', 'a partner who left'],
  ]
  it.each(cases)('%s', (_label, name) => {
    expect(isReservedDisplayName(name)).toBe(true)
  })
})

describe('isReservedDisplayName — allowed', () => {
  const cases: [string, string][] = [
    ['ZWJ emoji', '👨‍💻'],
    ['name with a ZWJ emoji', 'Ray 👩‍👩‍👧'],
    ['contains the label', '已離開的夥伴們'],
    ['label plus a name', '已離開的夥伴 小明'],
    ['en label in a sentence', 'not a partner who left'],
    // Accepted residual: look-alikes. The system style is what tells these apart.
    ['look-alike 己', '己離開的夥伴'],
    ['look-alike 巳', '巳離開的夥伴'],
    ['Cyrillic а', 'а partner who left'],
    ['ordinary name', 'Futari'],
  ]
  it.each(cases)('%s', (_label, name) => {
    expect(isReservedDisplayName(name)).toBe(false)
  })

  it('the comparison form is never what gets stored: normalising a ZWJ emoji drops the joiner', () => {
    expect(normalizeForReservedCheck('👨‍💻')).toBe('👨💻')
  })
})

describe('participant names (lib/outing/validate.ts)', () => {
  const code = (fn: () => unknown) => {
    try { fn() } catch (e) { return e instanceof ActionError ? e.code : String(e) }
    return null
  }

  it('normalizeParticipantName refuses a reserved name with display_name_reserved', () => {
    expect(code(() => normalizeParticipantName('已離開的夥伴'))).toBe('display_name_reserved')
    expect(code(() => normalizeParticipantName(' 已離​開的伙伴 '))).toBe('display_name_reserved')
    expect(code(() => normalizeParticipantName('A Partner Who Left'))).toBe('display_name_reserved')
  })

  it('normalizeParticipantName keeps an accepted name exactly as typed (trimmed only)', () => {
    expect(normalizeParticipantName(' 小美 👩‍🍳 ')).toBe('小美 👩‍🍳')
    expect(normalizeParticipantName('已離開的夥伴們')).toBe('已離開的夥伴們')
  })

  it('memberParticipantName falls back to the generic name for a reserved profile name, never rejects', () => {
    expect(memberParticipantName('已離開的夥伴', '成員')).toBe('成員')
    expect(memberParticipantName('退出したパートナー', 'メンバー')).toBe('メンバー')
    expect(memberParticipantName('Ray 👨‍💻', '成員')).toBe('Ray 👨‍💻')
  })
})
