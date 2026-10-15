/**
 * #1727 — sending an outing's link: the system share sheet with a prefilled
 * message (copy of message + link where there is no share sheet), a QR code for
 * friends at the same table, and a 「還有幾個名字沒人選」 line with a re-share
 * entry. Each send fires `outing_link_shared` with only `method`.
 *
 * What failure looks like: nothing errors. On iPhone the share button silently
 * does nothing (navigator.share refused for running outside the tap); in the
 * Android shell nothing reaches the clipboard; or the event carries the token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderSVG } from 'uqr'
import { I18nWrapper } from './_mocks/i18n'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { en } from '@/lib/i18n/locales/en'
import { ja } from '@/lib/i18n/locales/ja'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/outings/o1',
}))
const track = vi.hoisted(() => vi.fn())
vi.mock('@/lib/analytics/track', () => ({ track }))
const actions = vi.hoisted(() => ({
  getOutingShareLink: vi.fn(),
  resetOutingShareLink: vi.fn(),
  releaseOutingSlot: vi.fn(),
  deactivateOutingParticipant: vi.fn(),
  renameOuting: vi.fn(),
  addOutingExpense: vi.fn(),
  editOutingExpense: vi.fn(),
  deleteOutingExpense: vi.fn(),
  deleteOutingSettlement: vi.fn(),
  addOutingParticipant: vi.fn(),
  recordOutingSettlement: vi.fn(),
  endOuting: vi.fn(),
}))
vi.mock('@/actions/outing', () => actions)
vi.mock('@/app/(dashboard)/_components/MemberContext', () => ({ useMember: () => ({ isPast: false }) }))
vi.mock('@/app/(dashboard)/_components/BottomNav', () => ({ BottomNav: () => null }))
vi.mock('@/app/(dashboard)/outings/_components/OutingSheet', () => ({ OutingSheet: () => null }))
vi.mock('@/app/(dashboard)/outings/[id]/_components/EndOutingSheet', () => ({ EndOutingSheet: () => null }))

import { ShareLinkCard } from '@/app/(dashboard)/outings/[id]/_components/ShareLinkCard'
import { OutingDetailClient, type OutingDetailParticipant } from '@/app/(dashboard)/outings/[id]/_components/OutingDetailClient'

const ok = <T,>(data: T) => ({ ok: true as const, data })
const wrap = (ui: React.ReactElement) => render(<I18nWrapper>{ui}</I18nWrapper>)
const origin = window.location.origin
const URL1 = `${origin}/zh-TW/outing/tok1`
const NAME = '墾丁三天兩夜'
const MESSAGE = zhTW.outing.share.message.replace('{name}', NAME)

const writeText = vi.fn()
let share: ReturnType<typeof vi.fn> | undefined

beforeEach(() => {
  vi.clearAllMocks()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  actions.getOutingShareLink.mockResolvedValue(ok({ token: 'tok1' }))
})
afterEach(() => {
  delete (navigator as { share?: unknown }).share
  share = undefined
})
const withShareSheet = (impl: () => Promise<void> = async () => {}) => {
  share = vi.fn(impl)
  Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true })
}
const shareButton = () => screen.getByRole('button', { name: zhTW.outing.share.shareCta })
/** The QR as the browser serializes it, so markup compares like for like. */
const qrOf = (url: string) => { const d = document.createElement('div'); d.innerHTML = renderSVG(url, { ecc: 'M', border: 2 }); return d.innerHTML }
const sharedEvents = () => track.mock.calls.filter(([e]) => e === 'outing_link_shared')

describe('with a share sheet (iPhone, iOS shell, phone browsers)', () => {
  it('fetches the link up front and opens the sheet inside the tap, with the prefilled message', async () => {
    withShareSheet()
    wrap(<ShareLinkCard outingId="o1" outingName={NAME} />)
    await screen.findByText(URL1) // prefetched on mount
    expect(actions.getOutingShareLink).toHaveBeenCalledTimes(1)

    fireEvent.click(shareButton())
    // Synchronous: called before any await, so Safari keeps the gesture.
    expect(share).toHaveBeenCalledWith({ title: NAME, text: MESSAGE, url: URL1 })
    await waitFor(() => expect(sharedEvents()).toEqual([['outing_link_shared', { method: 'share' }]]))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('closing the sheet sends nothing and says nothing', async () => {
    withShareSheet(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) })
    wrap(<ShareLinkCard outingId="o1" outingName={NAME} />)
    await screen.findByText(URL1)
    await act(async () => { fireEvent.click(shareButton()) })
    expect(sharedEvents()).toEqual([])
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('a refused share points at the link on screen and is not counted', async () => {
    withShareSheet(async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }) })
    wrap(<ShareLinkCard outingId="o1" outingName={NAME} />)
    await screen.findByText(URL1)
    await act(async () => { fireEvent.click(shareButton()) })
    expect(screen.getByRole('status').textContent).toBe(zhTW.outing.share.copyFailed)
    expect(sharedEvents()).toEqual([])
  })

  it('re-reads the link when the tab comes back (the partner may have reset it)', async () => {
    withShareSheet()
    wrap(<ShareLinkCard outingId="o1" outingName={NAME} />)
    await screen.findByText(URL1)
    actions.getOutingShareLink.mockResolvedValue(ok({ token: 'tok2' }))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await screen.findByText(`${origin}/zh-TW/outing/tok2`)
    fireEvent.click(shareButton())
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/zh-TW/outing/tok2` }))
  })

  it('before the link has arrived, the tap copies the message instead of sharing late', async () => {
    withShareSheet()
    let resolve!: (v: unknown) => void
    actions.getOutingShareLink.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    wrap(<ShareLinkCard outingId="o1" outingName={NAME} />)
    fireEvent.click(shareButton())
    expect(share).not.toHaveBeenCalled()
    await act(async () => { resolve(ok({ token: 'tok1' })) })
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${MESSAGE}\n${URL1}`))
  })
})

describe('without a share sheet (Android shell, most desktops)', () => {
  it('fetches nothing up front; the tap copies the message with the link', async () => {
    wrap(<ShareLinkCard outingId="o1" outingName={NAME} />)
    await act(async () => {})
    expect(actions.getOutingShareLink).not.toHaveBeenCalled()

    await act(async () => { fireEvent.click(shareButton()) })
    expect(writeText).toHaveBeenCalledWith(`${MESSAGE}\n${URL1}`)
    expect(await screen.findByText(zhTW.outing.share.messageCopied)).toBeTruthy()
    expect(sharedEvents()).toEqual([['outing_link_shared', { method: 'copy' }]])
  })

  it('複製連結 still copies the bare link', async () => {
    wrap(<ShareLinkCard outingId="o1" outingName={NAME} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zhTW.outing.share.copy })) })
    expect(writeText).toHaveBeenCalledWith(URL1)
  })
})

describe('QR code', () => {
  it('encodes the share link, counts as method=qr, and hides again', async () => {
    wrap(<ShareLinkCard outingId="o1" outingName={NAME} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zhTW.outing.share.qrShow })) })
    const qr = await screen.findByTestId('outing-qr')
    await waitFor(() => expect(qr.innerHTML).toBe(qrOf(URL1)))
    expect(qr.getAttribute('aria-label')).toBe(zhTW.outing.share.qrAlt)
    expect(sharedEvents()).toEqual([['outing_link_shared', { method: 'qr' }]])

    fireEvent.click(screen.getByRole('button', { name: zhTW.outing.share.qrHide }))
    expect(screen.queryByTestId('outing-qr')).toBeNull()
  })

  it('follows a reset', async () => {
    actions.resetOutingShareLink.mockResolvedValue(ok({ token: 'tok9' }))
    wrap(<ShareLinkCard outingId="o1" outingName={NAME} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zhTW.outing.share.qrShow })) })
    await screen.findByTestId('outing-qr')
    fireEvent.click(screen.getByRole('button', { name: zhTW.outing.share.reset }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zhTW.outing.share.resetConfirm })) })
    const url9 = `${origin}/zh-TW/outing/tok9`
    await waitFor(() => expect(screen.getByTestId('outing-qr').innerHTML).toBe(qrOf(url9)))
  })
})

const P = (over: Partial<OutingDetailParticipant> & { id: string; displayName: string }): OutingDetailParticipant => ({
  active: true, claim: 'unclaimed', releasable: false, isMember: false, ...over,
})
const detail = (people: OutingDetailParticipant[], over: { canManage?: boolean; status?: 'active' | 'ended' } = {}) => (
  <OutingDetailClient
    outing={{ id: 'o1', name: NAME, currency: 'twd', status: over.status ?? 'active' }}
    view={{ participants: people.map((p) => ({ id: p.id, displayName: p.displayName, net: 0 })), transfers: [], coupleNet: 0 }}
    foldPreview={0}
    canManage={over.canManage ?? true}
    canEnd
    expenses={[]}
    participants={people}
  />
)
const people = [
  P({ id: 'A', displayName: '我', claim: 'bound', isMember: true }),
  P({ id: 'B', displayName: '伴', claim: 'unclaimed', isMember: true }),
  P({ id: 'F', displayName: '阿傑' }),
  P({ id: 'G', displayName: '小芳' }),
  P({ id: 'H', displayName: '阿明', claim: 'claimed', releasable: true }),
  P({ id: 'X', displayName: '老王', active: false }),
]
const unpickedText = (n: number) => zhTW.outing.share.unpicked.replace('{n}', String(n))

describe('names nobody has picked yet', () => {
  it('counts active friends still unclaimed (not members, not removed) and offers a re-share', async () => {
    wrap(detail(people))
    expect(screen.getByText(unpickedText(2))).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zhTW.outing.share.reshare })) })
    expect(writeText).toHaveBeenCalledWith(`${MESSAGE}\n${URL1}`)
  })

  it('is hidden when every friend has picked, and on an outing the viewer cannot share', () => {
    const { unmount } = wrap(detail(people.filter((p) => !['F', 'G'].includes(p.id))))
    expect(screen.queryByRole('button', { name: zhTW.outing.share.reshare })).toBeNull()
    unmount()
    const r = wrap(detail(people, { canManage: false }))
    expect(screen.queryByText(unpickedText(2))).toBeNull()
    r.unmount()
    wrap(detail(people, { status: 'ended' }))
    expect(screen.queryByText(unpickedText(2))).toBeNull()
  })

  it('a viewer who cannot share never fetches the link, even with a share sheet', async () => {
    withShareSheet()
    wrap(detail(people, { canManage: false }))
    await act(async () => {})
    expect(actions.getOutingShareLink).not.toHaveBeenCalled()
  })
})

describe('copy', () => {
  it.each([['zh-TW', zhTW], ['zh-CN', zhCN], ['en', en], ['ja', ja]] as const)('%s: message names the outing; no exclamation or banned words', (_l, d) => {
    const s = d.outing.share
    expect(s.message).toContain('{name}')
    expect(s.unpicked).toContain('{n}')
    for (const v of [s.shareCta, s.message, s.messageCopied, s.qrShow, s.qrHide, s.qrHint, s.qrAlt, s.unpicked, s.reshare]) {
      expect(v).not.toMatch(/[!！]|管理|追蹤|追踪|監控|监控/)
    }
  })
})
