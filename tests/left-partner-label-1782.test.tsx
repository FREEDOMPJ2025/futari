import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'

// ─── #1782 — readers show the viewer's label for a MARKED slot only ─────────
//
// en / ja renders of the surfaces a chapter's or outing's names reach. A slot
// marked as the left label (deletion, #1619, a tombstone) reads in the
// viewer's language, with the system style (neutral avatar, no letter;
// secondary ink in the outing lists). A person who named themself
// 「已離開的夥伴」 has no marker: their name is shown as written, with their
// own letter and colour, in every language.
// Failure looks like: nothing errors; an English viewer reads 已離開的夥伴, or
// a person's chosen name is replaced by the label.
// The database side (markers written, readers through the real queries) is
// __tests__/actions/leftLabelMarker1782.test.ts.
// ──────────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/x',
}))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (p: { src: string; alt?: string }) => <img src={p.src} alt={p.alt ?? ''} />,
}))
vi.mock('@/app/(dashboard)/_components/AvatarMenuProvider', () => ({ useAvatarMenu: () => ({ open: vi.fn() }) }))
vi.mock('@/app/(dashboard)/dashboard/_components/BrandHeaderHint', () => ({ BrandHeaderHint: () => null }))
vi.mock('@/app/(dashboard)/outings/_components/ExpenseSheet', () => ({ ExpenseSheet: () => null }))
vi.mock('@/actions/outing', () => ({}))
vi.mock('@/app/(dashboard)/outings/[id]/_components/AddParticipantSheet', () => ({ AddParticipantSheet: () => null }))
vi.mock('@/app/(dashboard)/outings/[id]/_components/SettleSheet', () => ({ SettleSheet: () => null }))
vi.mock('@/app/(dashboard)/outings/[id]/_components/EndOutingSheet', () => ({ EndOutingSheet: () => null }))
vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))

import { TranslationsProvider } from '@/lib/i18n/client'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'
import type { Translations } from '@/lib/i18n/locales/zh-TW'
import { MemberProvider, type MemberContextValue } from '@/app/(dashboard)/_components/MemberContext'
import { buildChapterIdentity } from '@/lib/chapterIdentity'
import { leftAwareName, localizeChapterMembers, type ChapterNameSlots } from '@/lib/leftPartnerLabel'
import { resolveReviewPayerName } from '@/lib/monthlyReview'
import { Avatar } from '@/app/(dashboard)/_components/Avatar'
import { CompactRow, type CompactRowProps } from '@/app/(dashboard)/dashboard/_components/CompactRow'
import { BrandHeader } from '@/app/(dashboard)/dashboard/_components/BrandHeader'
import { PastMessages } from '@/app/(dashboard)/review/[month]/_components/PastMessages'
import { OutingDetailClient } from '@/app/(dashboard)/outings/[id]/_components/OutingDetailClient'
import { OutingParticipantView } from '@/app/[locale]/outing/_components/OutingParticipantView'
import { buildTransactionsCsv, exportLabelsFor } from '@/lib/csv/transactions'
import { resolveExportRows, type ExportChapter } from '@/lib/db/queries/export'

const LITERAL = '已離開的夥伴'
const AMY = 'u-amy'
const BEN = 'u-ben'

const LOCALES: [string, Translations][] = [['en', en], ['ja', ja]]

/** Ben's slot: marked (deleted / hid his name) or a name he chose that reads the literal. */
const slots = (marked: boolean): ChapterNameSlots => ({
  memberAId: AMY, memberBId: BEN,
  memberAName: { name: 'Amy', isLeftLabel: false },
  memberBName: { name: LITERAL, isLeftLabel: marked },
})

function member(t: Translations, marked: boolean): MemberContextValue {
  const amy = { id: AMY, displayName: 'Amy', initial: 'A', avatarUrl: null, defaultSplitType: 'half' as const, who: 'M' as const }
  return {
    group: { id: 'g1', name: 'Home', baseCurrency: 'twd' },
    viewer: amy,
    partner: null,
    isSolo: true,
    viewerIsA: true,
    isPast: true,
    canAccessGuardian: false,
    epochStartedAt: '2025-01-01T00:00:00.000Z',
    epochEndedAt: '2025-06-01T00:00:00.000Z',
    chapter: buildChapterIdentity(localizeChapterMembers(slots(marked), t.common.leftPartnerLabel), AMY, t.common.partner),
  }
}

function wrap(t: Translations, locale: string, value?: MemberContextValue) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const inner = value ? <MemberProvider value={value}>{children}</MemberProvider> : children
    return <TranslationsProvider value={t} locale={locale as 'en'}>{inner}</TranslationsProvider>
  }
}

const row = (over: Partial<CompactRowProps['tx']> = {}): CompactRowProps['tx'] => ({
  id: 'r1', amount: 1000, splitType: 'half', splitRatioA: null, description: 'Dinner', category: 'food',
  paidBy: BEN, transactedAt: '2025-03-01T00:00:00.000Z', kind: 'transaction', ...over,
})

describe('leftAwareName / localizeChapterMembers', () => {
  it('the marker decides, never the text', () => {
    expect(leftAwareName({ name: LITERAL, isLeftLabel: true }, en.common.leftPartnerLabel)).toBe('a partner who left')
    expect(leftAwareName({ name: LITERAL, isLeftLabel: false }, en.common.leftPartnerLabel)).toBe(LITERAL)
    expect(leftAwareName({ name: null, isLeftLabel: false }, en.common.leftPartnerLabel)).toBeNull()
    expect(localizeChapterMembers({ ...slots(true), memberBId: null }, 'x'))
      .toMatchObject({ memberBName: null, memberBIsLeftLabel: false })
  })
})

describe('Avatar neutral', () => {
  it('an empty disc in the neutral fill: no letter, no photo', () => {
    const { container } = render(<Avatar memberRole="b" initial="已" src="https://example.test/x.png" neutral />)
    const disc = container.firstElementChild as HTMLElement
    expect(disc.textContent).toBe('')
    expect(container.querySelector('img')).toBeNull()
    expect(disc.style.background).toBe('var(--ink-3)')
  })
  it('a member avatar keeps its colour and letter', () => {
    const { container } = render(<Avatar memberRole="b" initial="已" />)
    const disc = container.firstElementChild as HTMLElement
    expect(disc.textContent).toBe('已')
    expect(disc.style.background).toBe('var(--accent)')
  })
})

describe.each(LOCALES)('%s viewer, past chapter Amy + Ben', (locale, t) => {
  const label = t.common.leftPartnerLabel

  it('marked: CompactRow and BrandHeader read the label, with the neutral avatar', () => {
    const { container } = render(<><CompactRow tx={row()} isLast /><BrandHeader /></>, { wrapper: wrap(t, locale, member(t, true)) })
    expect(container.textContent).toContain(label)
    expect(container.textContent).not.toContain(LITERAL)
    expect(container.textContent).not.toMatch(/已/)
    const neutral = [...container.querySelectorAll<HTMLElement>('div.rounded-full')]
      .filter((d) => d.style.background === 'var(--ink-3)')
    expect(neutral.length).toBe(2) // the row's payer avatar and the header's partner avatar
    for (const d of neutral) expect(d.textContent).toBe('')
  })

  it('unmarked literal name: shown as written, with its own letter and colour', () => {
    const { container } = render(<><CompactRow tx={row()} isLast /><BrandHeader /></>, { wrapper: wrap(t, locale, member(t, false)) })
    expect(container.textContent).toContain(LITERAL)
    expect(container.textContent).not.toContain(label)
    const discs = [...container.querySelectorAll<HTMLElement>('div.rounded-full')]
    expect(discs.some((d) => d.style.background === 'var(--ink-3)')).toBe(false)
    expect(discs.some((d) => d.textContent === '已')).toBe(true)
  })

  it('monthly review: payer name and the past message author read the label', () => {
    const c = localizeChapterMembers(slots(true), label)
    expect(resolveReviewPayerName(BEN, c, [])).toBe(label)
    expect(resolveReviewPayerName(BEN, localizeChapterMembers(slots(false), label), [])).toBe(LITERAL)
    const { container } = render(
      <PastMessages
        messages={[{ id: 'm1', memberId: BEN, body: 'hi' }]}
        viewer={{ id: AMY, displayName: 'Amy', avatarUrl: null }}
        partner={{ id: BEN, displayName: label, avatarUrl: null, isLeftLabel: true }}
      />,
      { wrapper: wrap(t, locale, member(t, true)) },
    )
    expect(container.textContent).toContain(label)
    const disc = [...container.querySelectorAll<HTMLElement>('div.rounded-full')].find((d) => d.style.background === 'var(--ink-3)')
    expect(disc?.textContent).toBe('')
  })

  it('outing list (dashboard): the marked slot in secondary ink; a typed literal in the normal ink', () => {
    const p = (id: string, displayName: string, isLeftLabel = false) =>
      ({ id, displayName, isLeftLabel, active: true, claim: 'claimed' as const, releasable: false, isMember: false })
    render(
      <OutingDetailClient
        outing={{ id: 'o1', name: 'Trip', currency: 'twd', status: 'ended' }}
        view={{ participants: [{ id: 'U', displayName: label, net: 0 }, { id: 'G', displayName: LITERAL, net: 0 }], transfers: [], coupleNet: 0 }}
        foldPreview={0}
        canManage={false}
        canEnd={false}
        expenses={[]}
        participants={[p('U', label, true), p('G', LITERAL)]}
      />,
      { wrapper: wrap(t, locale) },
    )
    expect(screen.getByText(label).className).toContain('text-ink-2')
    expect(screen.getByText(LITERAL).className).toContain('text-ink')
    expect(screen.getByText(LITERAL).className).not.toContain('text-ink-2')
  })

  it('public outing page: the marked slot in secondary ink', () => {
    render(
      <OutingParticipantView
        view={{
          outing: { id: 'o1', name: 'Trip', currency: 'twd', status: 'ended' },
          youParticipantId: 'F',
          participants: [
            { id: 'U', displayName: label, isLeftLabel: true, claim: 'claimed', active: true, net: 100 },
            { id: 'F', displayName: 'Friend', isLeftLabel: false, claim: 'claimed', active: true, net: -100 },
          ],
          expenses: [], settlements: [], transfers: [],
        }}
        needsBind={false}
        signedIn={false}
        signInHref="/en/sign-in"
      />,
      { wrapper: wrap(t, locale) },
    )
    const name = screen.getAllByText(label).find((el) => el.tagName === 'SPAN')!
    expect(name.className).toContain('text-ink-2')
    expect(within(name.parentElement!).queryByText(LITERAL)).toBeNull()
  })

  it('CSV: the chapter and person columns carry the export locale\'s label', () => {
    const chapter: ExportChapter = {
      id: 'c1', groupId: 'g1', startDate: '2025-01-01', endDate: '2025-06-01',
      memberAId: AMY, memberBId: BEN, memberAName: 'Amy', memberBName: label,
      memberASlotNow: 'a', memberBSlotNow: null, baseCurrency: 'twd',
    }
    const rows = resolveExportRows([{
      kind: 'expense', id: 'x1', groupId: 'g1', chapterId: 'c1', date: '2025-03-01', description: 'Dinner',
      amount: 1000, originalAmount: null, originalCurrency: null, category: 'food', personId: BEN,
      splitType: 'half', splitRatioA: null, status: 'settled', notes: null,
    }], [chapter], AMY)
    const csv = buildTransactionsCsv(rows, exportLabelsFor(t))
    expect(csv.split(label).length - 1).toBe(2) // person + chapter
    expect(csv).not.toContain(LITERAL)
  })
})
