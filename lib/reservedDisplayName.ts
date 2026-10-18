/**
 * #1782 (a) — names a person may not give themself: the system's left label
 * in each language (`common.leftPartnerLabel`). The secondary control; the
 * main one is the system style that only a marker can trigger
 * (lib/leftPartnerLabel.ts). This only stops exact and near-exact copies:
 * look-alike characters (已/己/巳, Cyrillic а/е/о) still pass, which is why
 * the style exists.
 *
 * Checked where a person's or participant's name is written:
 *   - updateDisplayName (actions/profile.ts)          → rejects (display_name_reserved)
 *   - normalizeParticipantName (lib/outing/validate.ts: addOutingParticipant,
 *     the signed-out joinOuting)                      → rejects (display_name_reserved)
 *   - memberParticipantName (createOuting copies a member's profile name)
 *                                                     → falls back to the generic name
 *   - handle_new_user (db/triggers/handle_new_user.sql, sign-up copies the
 *     OAuth full_name)                                → falls back to the email,
 *     with the same normalisation written in SQL.
 * Never inside the shared `validateName` (lib/validators.ts): ledger and
 * asset names use it, and those may say anything.
 *
 * The comparison runs on a normalised copy; the name is stored exactly as
 * typed. Zero-width characters are removed only for the comparison, so a
 * ZWJ emoji name (👨‍💻) is accepted unchanged, while 已離​開的夥伴 (with a ZWSP)
 * is still refused.
 *
 * Kept as literals, not read from the dictionaries: lib/outing/validate.ts is
 * imported by a client component, and the four dictionaries must not ride
 * along. tests/reserved-display-name-1782.test.ts asserts these equal each
 * dictionary's `common.leftPartnerLabel`. LEGACY_RESERVED_LABELS is the one
 * exception: retired wording, kept refused.
 */
export const RESERVED_LEFT_LABELS = [
  '已離開的夥伴', // zh-TW
  '已离开的伙伴', // zh-CN
  'Partner who left', // en
  '退出したパートナー', // ja
] as const

/**
 * Earlier labels, no longer shown but still refused: they exist in saved data
 * and old screens, so a person must not be able to take them either. (en was
 * 'a partner who left' until the #1787 copy review.)
 */
const LEGACY_RESERVED_LABELS = ['a partner who left'] as const

/** Traditional → simplified for the characters the zh labels differ in, so every mix (離/离, 開/开, 夥/伙) folds to one form. */
const TRAD_TO_SIMP: Record<string, string> = { 離: '离', 開: '开', 夥: '伙' }

const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu

/**
 * The comparison form: NFKC → drop default-ignorable and format characters →
 * collapse whitespace → lower case → fold the traditional/simplified pairs.
 * Never stored.
 */
export function normalizeForReservedCheck(name: string): string {
  return name
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/[離開夥]/gu, (c) => TRAD_TO_SIMP[c] ?? c)
}

const RESERVED = new Set([...RESERVED_LEFT_LABELS, ...LEGACY_RESERVED_LABELS].map(normalizeForReservedCheck))

/** True when `name`, normalised, IS one of the system's left labels. Containing one is fine. */
export function isReservedDisplayName(name: string): boolean {
  return RESERVED.has(normalizeForReservedCheck(name))
}
