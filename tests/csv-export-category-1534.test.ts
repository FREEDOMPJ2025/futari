import { describe, it, expect } from 'vitest'
import { buildTransactionsCsv, exportLabelsFor, type ExportLedgerRow } from '@/lib/csv/transactions'
import { zhTW } from '@/lib/i18n/locales/zh-TW'

// #1534 — the CSV export looked up the category label with `t[key] ?? raw`.
// For an inherited key the lookup hit Object.prototype, so the category cell
// held function source ("function Object() { [native code] }") instead of a
// label. Unknown values are meant to pass through unchanged. #1460 added
// income rows, whose categories have their own label map and the same guard.
const labels = exportLabelsFor(zhTW)

function row(kind: 'expense' | 'income', category: string): ExportLedgerRow {
  return {
    kind,
    date: '2026-09-21',
    description: '午餐',
    amount: 120,
    currency: 'twd',
    originalAmount: null,
    originalCurrency: null,
    category,
    personName: '小明',
    toName: undefined,
    shares: null,
    status: null,
    notes: null,
    chapter: { startDate: '2026-01-01', endDate: null, partnerName: '小華' },
  }
}

function categoryCell(kind: 'expense' | 'income', category: string): string {
  const csv = buildTransactionsCsv([row(kind, category)], labels)
  const dataLine = csv.split('\r\n')[1]!
  // type, date, description, amount, currency, original amount, original
  // currency, category, … — no field up to here contains a comma.
  return dataLine.split(',')[7]!
}

describe('CSV export category cell with an inherited-key category', () => {
  for (const kind of ['expense', 'income'] as const) {
    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(`${kind}: %s passes through as the raw value`, (category) => {
      const cell = categoryCell(kind, category)
      expect(cell).toBe(`"${category}"`)
      expect(cell).not.toMatch(/function|native code|\[object/)
    })
  }

  it('a real expense category still exports its label', () => {
    expect(categoryCell('expense', 'dining')).toBe(`"${zhTW.category.dining}"`)
  })

  it('a real income category exports the income label, not an expense one', () => {
    expect(categoryCell('income', 'salary')).toBe(`"${zhTW.incomeCategory.salary}"`)
    // 'other' exists in both maps; an income row reads the income map.
    expect(categoryCell('income', 'other')).toBe(`"${zhTW.incomeCategory.other}"`)
  })
})
