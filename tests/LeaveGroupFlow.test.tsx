import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import { I18nWrapper } from './_mocks/i18n'

const refresh = vi.fn()
const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push }),
}))

// Spy on the membership server actions; these run only when the user reaches
// the corresponding exit, so a test that never gets there should never fire one.
const proposeSwap = vi.fn()
const leaveGroup = vi.fn()
vi.mock('@/actions/membership', () => ({
  proposeSwap: () => proposeSwap(),
  leaveGroup: () => leaveGroup(),
  cancelSwap: vi.fn(),
  confirmSwap: vi.fn(),
}))

import { LeaveGroupFlow } from '@/app/(dashboard)/settings/_components/LeaveGroupFlow'
import { MemberProvider, type MemberContextValue } from '@/app/(dashboard)/_components/MemberContext'
import type { CurrencyCode } from '@/lib/currency'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'

const member = (baseCurrency: CurrencyCode): MemberContextValue => ({
  group: { id: 'g1', name: 'G', baseCurrency },
  viewer: { id: 'v', initial: 'V', displayName: 'V', avatarUrl: null, defaultSplitType: 'half', who: 'M' },
  partner: null, viewerIsA: false, isSolo: false, isPast: false, canAccessGuardian: false,
  epochStartedAt: '2026-01-01', epochEndedAt: null,
})
const wrap = (ui: React.ReactElement, base: CurrencyCode = 'twd') =>
  render(<I18nWrapper><MemberProvider value={member(base)}>{ui}</MemberProvider></I18nWrapper>)

beforeEach(() => {
  proposeSwap.mockReset()
  leaveGroup.mockReset()
  refresh.mockReset()
  push.mockReset()
})

describe('LeaveGroupFlow — member_b path (can leave directly)', () => {
  it('walks 1 → 2 → 3 → 4 then reveals final-confirm with the type-to-confirm input', () => {
    wrap(
      <LeaveGroupFlow
        open
        onClose={() => {}}
        viewerIsMemberA={false}
        viewerName="小明"
        partnerName="小華"
        groupBalance={0}
      />,
    )

    // Step 1: viewer is the secondary holder.
    expect(screen.getByText('你目前是這本帳本的「副帳號」')).toBeTruthy()
    fireEvent.click(screen.getByText('下一步'))
    // Step 2: explanation of member_a leaving (the partner here is member_a).
    expect(screen.getByText(/小華（主帳號）離開會發生什麼/)).toBeTruthy()
    fireEvent.click(screen.getByText('下一步'))
    // Step 3: explanation of member_b leaving (the viewer is member_b).
    expect(screen.getByText(/小明（副帳號）離開會發生什麼/)).toBeTruthy()
    fireEvent.click(screen.getByText('下一步'))
    // Step 4: yes/no decision.
    fireEvent.click(screen.getByText('是的，我要離開'))

    // Now in final-confirm. Balance is 0, so the type-to-confirm input shows.
    expect(screen.getByText('帳目已結清，可以離開')).toBeTruthy()
    expect(proposeSwap).not.toHaveBeenCalled()
    expect(leaveGroup).not.toHaveBeenCalled()
  })

  it('disables the leave button until the user types the magic word', () => {
    wrap(
      <LeaveGroupFlow
        open
        onClose={() => {}}
        viewerIsMemberA={false}
        viewerName="小明"
        partnerName="小華"
        groupBalance={0}
      />,
    )
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('是的，我要離開'))

    const leaveBtn = screen.getByText('確定離開') as HTMLButtonElement
    expect(leaveBtn.disabled).toBe(true)

    const input = screen.getByPlaceholderText('離開') as HTMLInputElement
    fireEvent.change(input, { target: { value: '離開' } })
    expect(leaveBtn.disabled).toBe(false)
  })

  it('blocks the user with a settle CTA when balance ≠ 0', () => {
    wrap(
      <LeaveGroupFlow
        open
        onClose={() => {}}
        viewerIsMemberA={false}
        viewerName="小明"
        partnerName="小華"
        groupBalance={1234}
      />,
    )
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('是的，我要離開'))

    expect(screen.getByText(/還有 NT\$ 1,234 沒結清/)).toBeTruthy()
    // The type-to-confirm input is hidden when blocked.
    expect(screen.queryByPlaceholderText('離開')).toBeNull()
    fireEvent.click(screen.getByText('前往主畫面結算'))
    expect(push).toHaveBeenCalledWith('/dashboard')
    expect(leaveGroup).not.toHaveBeenCalled()
  })

  it('USD base: the outstanding balance reads $ 1,234, never NT$ (#1584)', () => {
    wrap(
      <LeaveGroupFlow
        open
        onClose={() => {}}
        viewerIsMemberA={false}
        viewerName="小明"
        partnerName="小華"
        groupBalance={-1234}
      />,
      'usd',
    )
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('是的，我要離開'))
    expect(screen.getByText(/還有 \$ 1,234 沒結清/)).toBeTruthy()
    expect(screen.queryByText(/NT\$/)).toBeNull()
  })

  it('calls leaveGroup when the user types the magic word and confirms', async () => {
    leaveGroup.mockResolvedValue({ ok: true, data: { groupId: 'new-grp', epochId: 'new-epoch' } })
    wrap(
      <LeaveGroupFlow
        open
        onClose={() => {}}
        viewerIsMemberA={false}
        viewerName="小明"
        partnerName="小華"
        groupBalance={0}
      />,
    )
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('是的，我要離開'))
    fireEvent.change(screen.getByPlaceholderText('離開'), { target: { value: '離開' } })
    fireEvent.click(screen.getByText('確定離開'))

    await waitFor(() => expect(leaveGroup).toHaveBeenCalledTimes(1))
    expect(push).toHaveBeenCalledWith('/dashboard')
  })

  // ─── #1125: the welcome flag is epoch-keyed, matching WelcomeSoloCard ──────

  it('writes the just-left flag under the new EPOCH id, not the group id', async () => {
    // The other half of the pair pinned in tests/WelcomeSoloCard.test.tsx. The
    // writer and the reader have to agree on the key space; if only one of them
    // moves, the card silently never appears (writer moved) or already-dismissed
    // cards come back (reader moved).
    window.localStorage.clear()
    leaveGroup.mockResolvedValue({ ok: true, data: { groupId: 'new-grp', epochId: 'new-epoch' } })
    wrap(
      <LeaveGroupFlow
        open
        onClose={() => {}}
        viewerIsMemberA={false}
        viewerName="小明"
        partnerName="小華"
        groupBalance={0}
      />,
    )
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('是的，我要離開'))
    fireEvent.change(screen.getByPlaceholderText('離開'), { target: { value: '離開' } })
    fireEvent.click(screen.getByText('確定離開'))

    await waitFor(() =>
      expect(window.localStorage.getItem('futari_just_left_new-epoch')).toBe('1'),
    )
    expect(window.localStorage.getItem('futari_just_left_new-grp')).toBeNull()
  })

  it('writes no flag at all when the action comes back without an epoch id', async () => {
    // Mirrors RemovePartnerFlow's guard. An empty id would build
    // `futari_just_left_` — a key shared by every group on the device.
    window.localStorage.clear()
    leaveGroup.mockResolvedValue({ ok: true, data: { groupId: 'new-grp', epochId: '' } })
    wrap(
      <LeaveGroupFlow
        open
        onClose={() => {}}
        viewerIsMemberA={false}
        viewerName="小明"
        partnerName="小華"
        groupBalance={0}
      />,
    )
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('是的，我要離開'))
    fireEvent.change(screen.getByPlaceholderText('離開'), { target: { value: '離開' } })
    fireEvent.click(screen.getByText('確定離開'))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'))
    expect(Object.keys(window.localStorage)).toEqual([])
  })
})

describe('LeaveGroupFlow — member_a path (must swap first)', () => {
  it("card 4's affirmative for member_a fires proposeSwap, not leaveGroup", async () => {
    proposeSwap.mockResolvedValue({ ok: true, data: { ok: true } })
    wrap(
      <LeaveGroupFlow
        open
        onClose={() => {}}
        viewerIsMemberA={true}
        viewerName="小明"
        partnerName="小華"
        groupBalance={0}
      />,
    )
    // Card 1 reflects role A.
    expect(screen.getByText('你目前是這本帳本的「主帳號」')).toBeTruthy()
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    // Card 4: affirmative is the swap button, not the direct-leave button.
    fireEvent.click(screen.getByText('是的，先發起身份互換'))

    await waitFor(() => expect(proposeSwap).toHaveBeenCalledTimes(1))
    expect(leaveGroup).not.toHaveBeenCalled()
    // After success the user lands on the swap-sent confirmation card.
    expect(screen.getByText('已送出互換邀請')).toBeTruthy()
  })

  it('surfaces a localized error if proposeSwap fails with a known code', async () => {
    // #1223: an expected error is a RETURN value now, not a rejection.
    proposeSwap.mockResolvedValue({ ok: false, code: 'swap_already_pending' })
    wrap(
      <LeaveGroupFlow
        open
        onClose={() => {}}
        viewerIsMemberA={true}
        viewerName="小明"
        partnerName="小華"
        groupBalance={0}
      />,
    )
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('是的，先發起身份互換'))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/已經有一個身份互換提議了/))
  })
})

// ─── #1611 — export first, on card 3 ─────────────────────────────────────────
//
// After a leave the records stay in this ledger, so card 3 offers a copy of
// one's own before leaving. It must start the SAME export as /settings/trust
// (GET /api/export/transactions — no new route, no new scope), and its copy
// must name what the file holds: expenses, income and settlements (#1460).
describe('LeaveGroupFlow — card 3 export-first hint (#1611)', () => {
  const toCard3 = () => {
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
  }

  for (const viewerIsMemberA of [false, true]) {
    it(`renders the hint and button on card 3 (viewerIsMemberA=${viewerIsMemberA})`, () => {
      wrap(
        <LeaveGroupFlow open onClose={() => {}} viewerIsMemberA={viewerIsMemberA}
          viewerName="小明" partnerName="小華" groupBalance={0} />,
      )
      expect(screen.queryByText('先匯出支出、進帳和結算')).toBeNull() // not before card 3
      toCard3()
      expect(screen.getByText(zhTW.settings.dangerZone.flow.card3.exportHint)).toBeTruthy()
      expect(screen.getByRole('button', { name: '先匯出支出、進帳和結算' })).toBeTruthy()
      expect(screen.getByText('收支、結算和月回顧留言會完整留在這本帳本，離開後仍能回頭查看')).toBeTruthy()
      expect(screen.queryByText(/誰付的／誰收的/)).toBeNull()
    })
  }

  it('the button starts the existing export (GET /api/export/transactions) and never a membership action', async () => {
    const fetchMock = vi.fn(async () => new Response('a,b\n', {
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="futari-transactions-2026-10-13.csv"' },
    }))
    const createObjectURL = vi.fn(() => 'blob:x')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const urlStatics = URL as unknown as { createObjectURL: unknown; revokeObjectURL: unknown }
    const saved = { create: urlStatics.createObjectURL, revoke: urlStatics.revokeObjectURL }
    urlStatics.createObjectURL = createObjectURL
    urlStatics.revokeObjectURL = revokeObjectURL
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      wrap(
        <LeaveGroupFlow open onClose={() => {}} viewerIsMemberA={false}
          viewerName="小明" partnerName="小華" groupBalance={0} />,
      )
      toCard3()
      fireEvent.click(screen.getByRole('button', { name: '先匯出支出、進帳和結算' }))
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith('/api/export/transactions', { credentials: 'same-origin' })
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(leaveGroup).not.toHaveBeenCalled()
      expect(proposeSwap).not.toHaveBeenCalled()
      // Still on card 3: exporting does not advance or close the flow.
      expect(screen.getByRole('button', { name: '先匯出支出、進帳和結算' })).toBeTruthy()
    } finally {
      click.mockRestore()
      urlStatics.createObjectURL = saved.create
      urlStatics.revokeObjectURL = saved.revoke
      vi.unstubAllGlobals()
    }
  })

  it('a failed export shows the existing export error and stays on card 3', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    try {
      wrap(
        <LeaveGroupFlow open onClose={() => {}} viewerIsMemberA={false}
          viewerName="小明" partnerName="小華" groupBalance={0} />,
      )
      toCard3()
      fireEvent.click(screen.getByRole('button', { name: '先匯出支出、進帳和結算' }))
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(zhTW.csvExport.failed))
      expect(leaveGroup).not.toHaveBeenCalled()
      // The error is set inside the transition; the label returns from
      // 「準備中…」 when it settles, which under load can be a tick later.
      expect(await screen.findByRole('button', { name: '先匯出支出、進帳和結算' })).toBeTruthy()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('#1611 / #1460 copy: the export-first strings name what the export holds, in every locale', () => {
  // Each locale must name expenses, income and settlements (what the file
  // holds), and must not imply messages or "everything / all records" go too.
  const rules = {
    'zh-TW': { must: [/支出/, /進帳/, /結算/], mustNot: /留言|所有|全部|整批|整包|整本/ },
    'zh-CN': { must: [/支出/, /进账/, /结算/], mustNot: /留言|所有|全部|整批|整包|整本/ },
    en: { must: [/expense/i, /income/i, /settlement/i], mustNot: /message|\ball\b|everything|records/i },
    ja: { must: [/支出/, /収入/, /精算/], mustNot: /メッセージ|すべて|全部|まるごと/ },
  } as const
  for (const [locale, dict] of Object.entries({ 'zh-TW': zhTW, 'zh-CN': zhCN, en, ja })) {
    it(locale, () => {
      const c = dict.settings.dangerZone.flow.card3
      const r = rules[locale as keyof typeof rules]
      for (const s of [c.exportHint, c.exportCta]) {
        for (const must of r.must) expect(s).toMatch(must)
        expect(s).not.toMatch(r.mustNot)
        expect(s).not.toMatch(/[!！]/)
      }
    })
  }
})
