import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nWrapper } from './_mocks/i18n'
import { PendingSummary } from '@/app/(dashboard)/dashboard/_components/PendingSummary'
import { DashboardFilterRow } from '@/app/(dashboard)/dashboard/_components/DashboardFilterRow'
import { zhTW } from '@/lib/i18n/locales/zh-TW'

// #1851 — the dashboard's pending stacks behind one 「N 筆待確認」 line, and the
// 篩選 row heading the records list.
describe('PendingSummary (#1851)', () => {
  it('renders nothing when there is nothing to confirm', () => {
    const { container } = render(<I18nWrapper><PendingSummary count={0}><p>stack</p></PendingSummary></I18nWrapper>)
    expect(container.textContent).toBe('')
  })

  it('always shows the count; the stack opens in place and folds again, with aria-expanded', () => {
    render(<I18nWrapper><PendingSummary count={3}><p>stack</p></PendingSummary></I18nWrapper>)
    const line = screen.getByRole('button', { name: '3 筆待確認' })
    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('stack')).toBeNull()
    fireEvent.click(line)
    expect(line.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('stack')).toBeInTheDocument()
    fireEvent.click(line)
    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('stack')).toBeNull()
    expect(screen.getByRole('button', { name: '3 筆待確認' })).toBeInTheDocument()
  })

  it('remembers being open for the app session (a remount opens it again)', () => {
    const ui = <I18nWrapper><PendingSummary count={1}><p>stack</p></PendingSummary></I18nWrapper>
    const first = render(ui)
    fireEvent.click(screen.getByRole('button', { name: '1 筆待確認' }))
    first.unmount()
    render(ui)
    expect(screen.getByRole('button', { name: '1 筆待確認' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '1 筆待確認' }))
  })

  it('every locale has the summary with its {n}', async () => {
    const { en } = await import('@/lib/i18n/locales/en')
    const { zhCN } = await import('@/lib/i18n/locales/zh-CN')
    const { ja } = await import('@/lib/i18n/locales/ja')
    for (const t of [zhTW, zhCN, en, ja]) expect(t.dashboard.pendingSummary).toContain('{n}')
  })
})

describe('DashboardFilterRow as the records header (#1851)', () => {
  const base = { onPayerChange: () => {}, onSplitChange: () => {}, viewerIsA: true, t: zhTW }

  it('puts the list title and the unchanged chip on one row, toggles on the next', () => {
    render(<DashboardFilterRow {...base} payerFilter="me" splitFilter="all" title={<span>最近紀錄</span>} />)
    const chip = screen.getByRole('button', { name: zhTW.dashboard.filterAriaLabel })
    expect(chip.parentElement).toBe(screen.getByText('最近紀錄').parentElement)
    expect(chip.style.background).toBe('var(--ink)')
    const toggles = chip.parentElement!.nextElementSibling!
    expect(toggles.querySelectorAll('button')).toHaveLength(4)
    expect(toggles.className).toContain('overflow-x-auto')
  })
})
