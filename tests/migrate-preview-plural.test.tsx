import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { en } from '@/lib/i18n/locales/en'
import { MigratePreviewCard } from '@/app/[locale]/migrate/_components/MigratePreviewCard'

// #1798 — the public /migrate preview showed "1 record(s)" and "~1 look like
// expenses" for a one-row file. Render the card at 1 and 2 in en.
function stats(totalRows: number, estimatedExpenseRows: number) {
  return { totalRows, estimatedExpenseRows, dateRange: null, topCategories: [] }
}

describe('MigratePreviewCard plural labels (en)', () => {
  it('reads singular at 1', () => {
    const { container } = render(
      <MigratePreviewCard t={en.migrate} locale="en" source="honeydue" encoding={null} stats={stats(1, 1)} />,
    )
    expect(container.textContent).toContain('1 record')
    expect(container.textContent).not.toContain('1 records')
    expect(container.textContent).toContain('~1 looks like an expense')
  })

  it('reads plural at 2', () => {
    const { container } = render(
      <MigratePreviewCard t={en.migrate} locale="en" source="honeydue" encoding={null} stats={stats(2, 2)} />,
    )
    expect(container.textContent).toContain('2 records')
    expect(container.textContent).toContain('~2 look like expenses')
  })
})
