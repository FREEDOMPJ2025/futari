import { describe, it, expect, vi, beforeEach } from 'vitest'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { ActionError } from '@/lib/action-errors'
import { validateRecurringExpenseRuleInput, validateRecurringIncomeRuleInput } from '@/lib/validators'
import { setMockUser } from './_mocks/supabase'
import { resetDbMocks } from './_mocks/db'
import { createRule as createExpenseRule } from '@/actions/recurringExpense'
import { createRule as createIncomeRule } from '@/actions/recurringIncome'

// #1837 (PRJ-FUTARI-T) — an end date before the start date used to throw a raw
// Chinese Error that production strips to a generic failure. The server now
// answers with a localized code (the sheet side is recurring-ends-before-start-sheet-1837).

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() })),
}))

const base = { amount: 1000, category: 'housing', intervalMonths: 1, dayOfMonth: 1, startsOn: '2026-05-10', endsOn: '2026-05-09' }

describe('validators raise the localized code', () => {
  it('expense', () => {
    let err: unknown
    try { validateRecurringExpenseRuleInput({ ...base, paidBy: 'u', splitType: 'half', description: 'x' }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ActionError)
    expect((err as ActionError).code).toBe('recurring_ends_before_start')
  })
  it('income', () => {
    let err: unknown
    try { validateRecurringIncomeRuleInput({ ...base, category: 'salary', recipientId: 'u' }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ActionError)
    expect((err as ActionError).code).toBe('recurring_ends_before_start')
  })
  it('equal dates are still accepted', () => {
    expect(() => validateRecurringExpenseRuleInput({ ...base, endsOn: base.startsOn, paidBy: 'u', splitType: 'half', description: 'x' })).not.toThrow()
  })
})

describe('the code survives action() as a returned failure', () => {
  beforeEach(() => { resetDbMocks(); setMockUser({ id: 'user-a', email: 'a@example.com' }) })
  it('expense createRule', async () => {
    expect(await createExpenseRule({ ...base, paidBy: 'user-a', splitType: 'half', description: 'x' }))
      .toEqual({ ok: false, code: 'recurring_ends_before_start' })
  })
  it('income createRule', async () => {
    expect(await createIncomeRule({ ...base, category: 'salary', recipientId: 'user-a' }))
      .toEqual({ ok: false, code: 'recurring_ends_before_start' })
  })
  it('has a message in every locale', () => {
    for (const l of [zhTW, zhCN, en, ja]) expect(l.errors.actions.recurring_ends_before_start).toBeTruthy()
  })
})

