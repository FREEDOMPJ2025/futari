/**
 * Pick the singular/plural form of a string for `locale` (#1738).
 * Uses `Intl.PluralRules`, so en gets `one` only for n = 1; zh and ja have
 * only the `other` category, so both forms should carry the same text.
 * Without this, en shows "1 people" / "1 names".
 */
export function pickPlural(
  locale: string,
  n: number,
  forms: { one: string; other: string },
): string {
  return new Intl.PluralRules(locale).select(n) === 'one' ? forms.one : forms.other
}
