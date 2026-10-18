/**
 * Header names of the sources that have a dedicated mapper but export their
 * column titles in the app's UI language (#1791). One table feeds both the
 * detector (which source is this file?) and the mapper (which column is the
 * amount?), so the two cannot disagree about what a header means.
 *
 * Matching is the whole trimmed, lowercased header — never a substring.
 * Substring matching is how `To` would swallow `Total`, and how a CWMoney-style
 * `日期` check ended up claiming AndroMoney's zh-TW header. The failure is
 * silent: the file is read by the wrong mapper and comes out as 0 rows or as
 * every row an expense.
 *
 * Everything here is lowercase because `normalizeHeader` lowercases.
 */

export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase()
}

/**
 * AndroMoney: 14 columns, `Amount` always positive, direction from which of
 * the two account columns is filled. The title row is localised to the app
 * language (German sample: `Ausgaben` / `Einnahmen`), which is why the mapper
 * also falls back to the column position when the file is exactly 14 wide.
 */
export const ANDROMONEY_HEADERS = {
  amount: ['amount', '金額', '金额'],
  category: ['category', '分類', '分类'],
  subCategory: ['sub-category', '子分類', '子分类'],
  date: ['date', '日期'],
  out: ['expense(transfer out)', '付款(轉出)', '付款(转出)'],
  in: ['income(transfer in)', '收款(轉入)', '收款(转入)'],
  note: ['note', 'remark', '備註', '备注'],
  currency: ['currency', '幣別', '币别'],
} as const

export const ANDROMONEY_WIDTH = 14
/** Column positions of the documented layout. */
export const ANDROMONEY_POSITION = {
  currency: 1, amount: 2, category: 3, subCategory: 4, date: 5, out: 6, in: 7, note: 8,
} as const

/**
 * まねーぼ (Manebo): 8 columns, `Amount` positive, direction from `Type`
 * (`income` / `expense` / `transfer`, English in every language).
 * Titles from the official help page: ja, en, zh-Hant, pt. Matched by name
 * only — no position fallback, so a file whose `Type` column was renamed or
 * dropped is reported as missing it instead of being read blind.
 */
export const MANEBO_HEADERS = {
  date: ['日付', 'date', '日期', 'data'],
  type: ['種別', 'type', '類型', 'tipo'],
  amount: ['金額', 'amount', 'valor'],
  category: ['カテゴリ', 'category', '類別', 'categoria'],
  subCategory: ['サブカテゴリ', 'sub category', '子類別', 'subcategoria'],
  account: ['アカウント / 振込元', 'account / from', '帳戶 / 來源', 'conta / de'],
  to: ['振替先', 'to', '目的地', 'para'],
  note: ['メモ', 'note', '備註', 'nota'],
} as const

/** Splitwise's own export is English. */
export const SPLITWISE_HEADERS = {
  date: ['date'],
  description: ['description'],
  category: ['category'],
  cost: ['cost'],
  currency: ['currency'],
} as const

// ──────────────────── Naming a missing column (#1799) ────────────────────

/** The language a file's title row is written in. */
export type HeaderLang = 'en' | 'ja' | 'zh-TW' | 'zh-CN' | 'pt'

type Labels = Partial<Record<HeaderLang, string>>

/**
 * The name each language's export gives a column, keyed like the tables above.
 * Only used to say which column is missing: `findColumn` never reads this, it
 * matches on the alias tables. Every value must also be an alias there (a test
 * holds that), otherwise the message would name a header the mapper does not
 * accept.
 */
export const ANDROMONEY_LABELS: Record<keyof typeof ANDROMONEY_HEADERS, Labels> = {
  amount: { en: 'Amount', 'zh-TW': '金額', 'zh-CN': '金额' },
  category: { en: 'Category', 'zh-TW': '分類', 'zh-CN': '分类' },
  subCategory: { en: 'Sub-Category', 'zh-TW': '子分類', 'zh-CN': '子分类' },
  date: { en: 'Date', 'zh-TW': '日期', 'zh-CN': '日期' },
  out: { en: 'Expense(Transfer Out)', 'zh-TW': '付款(轉出)', 'zh-CN': '付款(转出)' },
  in: { en: 'Income(Transfer In)', 'zh-TW': '收款(轉入)', 'zh-CN': '收款(转入)' },
  note: { en: 'Note', 'zh-TW': '備註', 'zh-CN': '备注' },
  currency: { en: 'Currency', 'zh-TW': '幣別', 'zh-CN': '币别' },
}

export const MANEBO_LABELS: Record<keyof typeof MANEBO_HEADERS, Labels> = {
  date: { ja: '日付', en: 'Date', 'zh-TW': '日期', pt: 'Data' },
  type: { ja: '種別', en: 'Type', 'zh-TW': '類型', pt: 'Tipo' },
  amount: { ja: '金額', en: 'Amount', 'zh-TW': '金額', pt: 'Valor' },
  category: { ja: 'カテゴリ', en: 'Category', 'zh-TW': '類別', pt: 'Categoria' },
  subCategory: { ja: 'サブカテゴリ', en: 'Sub Category', 'zh-TW': '子類別', pt: 'Subcategoria' },
  account: { ja: 'アカウント / 振込元', en: 'Account / From', 'zh-TW': '帳戶 / 來源', pt: 'Conta / De' },
  to: { ja: '振替先', en: 'To', 'zh-TW': '目的地', pt: 'Para' },
  note: { ja: 'メモ', en: 'Note', 'zh-TW': '備註', pt: 'Nota' },
}

/**
 * The language of a title row, judged by which language's names the file
 * actually contains: the language with the most matching headers wins. `null`
 * when nothing matches or two languages tie (`日期` alone is both zh-TW and
 * zh-CN) — guessing there would name a column the user cannot find.
 */
export function detectHeaderLang(
  headers: readonly string[],
  labels: Record<string, Labels>,
): HeaderLang | null {
  const seen = new Set(headers.map(normalizeHeader))
  const score = new Map<HeaderLang, number>()
  for (const byLang of Object.values(labels)) {
    for (const [lang, name] of Object.entries(byLang) as [HeaderLang, string][]) {
      if (seen.has(normalizeHeader(name))) score.set(lang, (score.get(lang) ?? 0) + 1)
    }
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return null
  if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) return null
  return ranked[0]![0]
}

/**
 * How a missing column is shown: the English name, plus the name in the file's
 * own language when that differs — `Type（種別）`. The English name stays
 * because the message is in the app's language, which need not be the file's
 * (an English UI reading a Japanese file), and it is the one name that never
 * changes between languages. With no language detected, or an English file,
 * the English name alone.
 */
export function describeMissing(
  key: string,
  labels: Record<string, Labels>,
  lang: HeaderLang | null,
): string {
  const english = labels[key]?.en ?? key
  const local = lang === null || lang === 'en' ? undefined : labels[key]?.[lang]
  return local === undefined || local === english ? english : `${english}（${local}）`
}
