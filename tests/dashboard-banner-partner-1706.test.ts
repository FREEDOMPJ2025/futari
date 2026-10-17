// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactElement } from 'react'

// #1706 (from #1695, mutation M3) — the home banner quotes the open chapter's
// partner BY ID, not "any row that is not the viewer's".
//
// The loader already keeps the banner's rows to the chapter's two people
// (`inArray(memberId, [A, B])`, covered by
// __tests__/review-messages-chapter-1684-1685.test.ts), so through the real
// loader a non-partner, non-viewer row can never reach the banner. That is
// exactly why the by-id lookup is a second fence nothing exercised: swap it for
// `memberId !== user.id` and every state a database can produce still passes.
// Here the loader is mocked to hand the page such a row, so the page's own
// check is the only thing between it and the quote.
//
// What it looks like when this regresses: nothing errors. The banner quietly
// quotes words written by someone who is not the viewer's partner.

const ME = 'a0a0a0a0-0000-4000-8000-0000000000a0'
const PARTNER = 'b0b0b0b0-0000-4000-8000-0000000000b0'
const STRANGER = 'c0c0c0c0-0000-4000-8000-0000000000c0'

const CHAPTER = { startedAt: new Date('2020-01-01T00:00:00Z'), endedAt: null, epochId: 'e1', isPast: false }
const DUO = { id: 'g1', memberA: ME, memberB: PARTNER, guardianBetaEnabled: false, defaultSplitRatioA: null, baseCurrency: 'twd' }

let viewer = ME
let rows: { memberId: string; body: string }[] = []

vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock('@/lib/supabase/server', () => ({ getCurrentUser: async () => ({ id: viewer }) }))
vi.mock('@/lib/db/queries/epoch', () => ({
  resolveViewerEpochContext: async () => ({ group: DUO, window: CHAPTER }),
  getLatestPriorClosedEpoch: async () => null,
  getEpochMembers: async () => null,
}))
vi.mock('@/lib/db/queries/insuranceView', () => ({ loadMemberLinkScope: async () => ({ memberA: ME, memberB: PARTNER }) }))
vi.mock('@/lib/db/queries/recurringView', () => ({
  listIncomePendingsForViewer: async () => [],
  listExpensePendingsForViewer: async () => [],
}))
vi.mock('@/lib/db/queries/shortcutPending', () => ({ listShortcutPendingsForViewer: async () => [] }))
vi.mock('@/lib/i18n/t', () => ({ getTranslations: async () => ({}), getLocale: async () => 'zh-TW' }))
vi.mock('@/lib/db/client', () => ({ db: {} }))
vi.mock('@/lib/db/queries/balance', () => ({ getGroupBalance: async () => 0, getGroupPendingBalanceDelta: async () => 0 }))
vi.mock('@/lib/db/queries/transactions', () => ({ listTransactionsPaged: async () => [], monthlyStatsByCategory: async () => [] }))
vi.mock('@/lib/db/queries/incomes', () => ({
  listIncomeMonthSummary: async () => ({ total: 0, count: 0 }),
  listIncomesPaged: async () => [],
}))
vi.mock('@/lib/db/queries/trips', () => ({ listActiveTrips: async () => [] }))
vi.mock('@/lib/db/queries/currencyRates', () => ({ listRatesForGroup: async () => [] }))
vi.mock('@/lib/db/queries/monthlyReview', () => ({
  // Last month's snapshot, undismissed: the banner shows.
  loadMonthlyReviewSnapshot: async () => ({
    bannerDismissedByMemberAAt: null,
    bannerDismissedByMemberBAt: null,
  }),
  listMonthlyReviewMonths: async () => [],
  loadChapterReviewMessages: async () => rows,
}))
vi.mock('@/lib/today-server', () => ({ getTodayYMD: async () => '2026-10-07' }))
vi.mock('@/app/(dashboard)/dashboard/_components/Dashboard', () => ({ Dashboard: () => null }))
vi.mock('@/app/(dashboard)/dashboard/_components/PartnerLeftCard', () => ({ PartnerLeftCard: () => null }))
vi.mock('@/app/(dashboard)/dashboard/_components/WelcomeSoloCard', () => ({ WelcomeSoloCard: () => null }))
vi.mock('@/app/(dashboard)/dashboard/_components/MonthlyReviewBanner', () => ({ MonthlyReviewBanner: () => null }))

const { default: DashboardPage } = await import('@/app/(dashboard)/dashboard/page')
const { MonthlyReviewBanner } = await import('@/app/(dashboard)/dashboard/_components/MonthlyReviewBanner')

async function bannerQuote(): Promise<string | null> {
  const frag = (await DashboardPage()) as ReactElement<{ children: unknown[] }>
  const kids = (frag.props.children as unknown[]).flat().filter(Boolean) as ReactElement<{ quote: string | null }>[]
  const banner = kids.find((k) => k.type === MonthlyReviewBanner)
  expect(banner, 'the banner renders for last month').toBeDefined()
  return banner!.props.quote
}

beforeEach(() => { viewer = ME; rows = [] })

describe('home banner quote (#1706, #1684)', () => {
  it("quotes the partner's row, not a stranger's that comes first", async () => {
    rows = [
      { memberId: STRANGER, body: 'STRANGER' },
      { memberId: PARTNER, body: 'PARTNER' },
      { memberId: ME, body: 'OWN' },
    ]
    expect(await bannerQuote()).toBe('PARTNER')
  })

  it("with no partner row, falls back to the viewer's own, never the stranger's", async () => {
    rows = [
      { memberId: STRANGER, body: 'STRANGER' },
      { memberId: ME, body: 'OWN' },
    ]
    expect(await bannerQuote()).toBe('OWN')
  })

  it('same for the chapter\'s member_b viewing: the partner is member_a', async () => {
    viewer = PARTNER
    rows = [
      { memberId: STRANGER, body: 'STRANGER' },
      { memberId: ME, body: 'PARTNER_OF_VIEWER' },
      { memberId: PARTNER, body: 'OWN' },
    ]
    expect(await bannerQuote()).toBe('PARTNER_OF_VIEWER')
  })
})
