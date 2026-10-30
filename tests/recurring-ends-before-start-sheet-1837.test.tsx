// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TranslationsProvider } from '@/lib/i18n/client'
import { en } from '@/lib/i18n/locales/en'
import { ToastProvider } from '@/components/Toast'
import type { RecurringIncomeRuleView, RecurringExpenseRuleView } from '@/lib/recurringMemberLink'

// #1837 — the rule sheet stops an end date before the start date up front.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

vi.mock('@/app/(dashboard)/_components/MemberContext', () => ({
  useMember: () => ({
    viewer: { id: 'u-1', initial: 'R', avatarUrl: null, defaultSplitType: 'half' },
    partner: { id: 'u-2', initial: 'S', avatarUrl: null, displayName: 'Sam' },
    viewerIsA: true,
    isSolo: false,
  }),
  whoToMemberRole: (w: 'M' | 'T') => (w === 'M' ? 'a' : 'b'),
  useBaseCurrency: () => 'twd',
}))
const incomeActions = vi.hoisted(() => ({ createRule: vi.fn(), updateRule: vi.fn(), pauseRule: vi.fn(), resumeRule: vi.fn(), softDeleteRule: vi.fn(), countPendingForRule: vi.fn() }))
const expenseActions = vi.hoisted(() => ({ createRule: vi.fn(), updateRule: vi.fn(), pauseRule: vi.fn(), resumeRule: vi.fn(), softDeleteRule: vi.fn(), countPendingForRule: vi.fn() }))
vi.mock('@/actions/recurringIncome', () => incomeActions)
vi.mock('@/actions/recurringExpense', () => expenseActions)
vi.mock('@/app/(dashboard)/dashboard/_components/AssetLinkField', () => ({ AssetLinkField: () => null }))

import { RecurringRuleSheet } from '@/app/(dashboard)/_components/RecurringRuleSheet'

const incomeRule: RecurringIncomeRuleView = {
  id: 'r1', recipientId: 'u-1', amount: 50000, category: 'salary', source: null, assetId: null,
  intervalMonths: 1, dayOfMonth: 5, startsOn: '2026-01-05', endsOn: null,
  nextOccurrenceAt: '2026-10-05', pausedAt: null,
  recipientIsFormer: false, formerLabel: false,
}
const expenseRule = {
  id: 'e1', paidBy: 'u-1', amount: 20000, splitType: 'half', splitRatioA: null, description: 'Rent',
  category: 'housing', assetId: null, intervalMonths: 1, dayOfMonth: 1, startsOn: '2026-01-01',
  endsOn: null, nextOccurrenceAt: '2026-10-01', pausedAt: null,
  paidByIsFormer: false, formerLabel: false,
} as RecurringExpenseRuleView

function En({ children }: { children: ReactNode }) {
  return (
    <TranslationsProvider value={en} locale="en">
      <ToastProvider>{children}</ToastProvider>
    </TranslationsProvider>
  )
}

afterEach(() => cleanup())

describe.each(['income', 'expense'] as const)('end date before start date (%s)', (type) => {
  const actions = type === 'income' ? incomeActions : expenseActions
  const sheet = () => render(
    <En>
      {type === 'income'
        ? <RecurringRuleSheet type="income" open onClose={() => {}} onMutated={() => {}} initial={incomeRule} insuranceAssets={[]} />
        : <RecurringRuleSheet type="expense" open onClose={() => {}} onMutated={() => {}} initial={expenseRule} />}
    </En>,
  )
  const endInput = () => screen.getByLabelText(en.recurringExpense.sheet.endsOnLabel) as HTMLInputElement
  const save = () => act(async () => { screen.getByRole('button', { name: en.common.save }).click() })

  it('the end-date picker starts at the start date', () => {
    sheet()
    expect(endInput().min).toBe((screen.getByLabelText(en.recurringExpense.sheet.startsOnLabel) as HTMLInputElement).value)
  })

  it('save is blocked and the localized message shows', async () => {
    sheet()
    fireEvent.change(endInput(), { target: { value: '2000-01-01' } })
    await save()
    expect(screen.getByText(en.errors.actions.recurring_ends_before_start)).toBeTruthy()
    expect(actions.updateRule).not.toHaveBeenCalled()
    expect(actions.createRule).not.toHaveBeenCalled()
  })

  it('an end date on or after the start date still saves', async () => {
    actions.updateRule.mockResolvedValue({ ok: true, data: { id: 'x', nextOccurrenceAt: '2026-11-05' } })
    sheet()
    fireEvent.change(endInput(), { target: { value: '2030-01-01' } })
    await save()
    expect(actions.updateRule).toHaveBeenCalledTimes(1)
  })
})
