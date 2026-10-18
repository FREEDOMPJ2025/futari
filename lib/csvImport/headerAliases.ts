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
