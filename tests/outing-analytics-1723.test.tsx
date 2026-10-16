/**
 * #1723 — `outing_link_shared` (the member's share step in the outing funnel).
 * Fires once per share, only after the link really left the app, and carries
 * nothing that identifies the outing: no id, name, token or URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nWrapper } from './_mocks/i18n'
import { zhTW } from '@/lib/i18n/locales/zh-TW'

const track = vi.hoisted(() => vi.fn())
vi.mock('@/lib/analytics/track', () => ({ track }))

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push, prefetch: vi.fn() }),
  usePathname: () => '/outings',
}))

const actions = vi.hoisted(() => ({
  createOuting: vi.fn(),
  getOutingShareLink: vi.fn(),
  resetOutingShareLink: vi.fn(),
}))
vi.mock('@/actions/outing', () => actions)

import { OutingSheet } from '@/app/(dashboard)/outings/_components/OutingSheet'
import { ShareLinkCard } from '@/app/(dashboard)/outings/[id]/_components/ShareLinkCard'

const ok = <T,>(data: T) => ({ ok: true as const, data })
const fail = (code: string) => ({ ok: false as const, code })
const wrap = (ui: React.ReactElement) => render(<I18nWrapper>{ui}</I18nWrapper>)

const OUTING_ID = '11111111-2222-4333-8444-555555555555'
const TOKEN = 'tok_1723_secret_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const NAME = '九份兩日'

const writeText = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

/** Every outing event sent so far, with nothing identifying in it. */
function expectNothingIdentifying() {
  for (const [, props] of track.mock.calls) {
    const s = JSON.stringify(props ?? {})
    expect(s).not.toContain(TOKEN)
    expect(s).not.toContain(OUTING_ID)
    expect(s).not.toContain(NAME)
    expect(s).not.toMatch(/outing\//)
    expect(s).not.toMatch(/https?:/)
  }
}

// outing_created is server-side (actions/outing.ts, see
// __tests__/actions/outing-created-event-1723.test.ts). The sheet must not
// send a client copy of it: that would count every outing twice, once under
// an anonymous per-page-load id.
describe('OutingSheet sends no client outing event', () => {
  it('stays silent on a successful create', async () => {
    actions.createOuting.mockResolvedValue(ok({ id: OUTING_ID }))
    wrap(<OutingSheet open onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(zhTW.outing.form.namePlaceholder), { target: { value: NAME } })
    fireEvent.click(screen.getByRole('button', { name: zhTW.outing.form.saveCreate }))
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/outings/${OUTING_ID}`))
    expect(track).not.toHaveBeenCalled()
  })
})

describe('outing_link_shared', () => {
  const copy = () => {
    wrap(<ShareLinkCard outingId={OUTING_ID} />)
    fireEvent.click(screen.getByRole('button', { name: zhTW.outing.share.copy }))
  }

  it('fires with method=copy once the clipboard write resolved, and nothing else', async () => {
    actions.getOutingShareLink.mockResolvedValue(ok({ token: TOKEN }))
    copy()
    await screen.findByText(zhTW.outing.share.copied)
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('outing_link_shared', { method: 'copy' })
    expect(Object.keys(track.mock.calls[0][1])).toEqual(['method'])
    expectNothingIdentifying()
  })

  it('fires again on a second copy (each send is a share)', async () => {
    actions.getOutingShareLink.mockResolvedValue(ok({ token: TOKEN }))
    copy()
    await screen.findByText(zhTW.outing.share.copied)
    fireEvent.click(await screen.findByRole('button', { name: zhTW.outing.share.copy }))
    await waitFor(() => expect(track).toHaveBeenCalledTimes(2))
    expectNothingIdentifying()
  })

  it('does not fire when the clipboard refuses', async () => {
    actions.getOutingShareLink.mockResolvedValue(ok({ token: TOKEN }))
    writeText.mockRejectedValue(new Error('NotAllowedError'))
    copy()
    await screen.findByText(zhTW.outing.share.copyFailed)
    expect(track).not.toHaveBeenCalled()
  })

  it('does not fire when the server refuses the link', async () => {
    actions.getOutingShareLink.mockResolvedValue(fail('outing_admin_only'))
    copy()
    await screen.findByRole('alert')
    expect(track).not.toHaveBeenCalled()
  })

  it('does not fire on reset (a new link is not a share)', async () => {
    actions.resetOutingShareLink.mockResolvedValue(ok({ token: TOKEN }))
    wrap(<ShareLinkCard outingId={OUTING_ID} />)
    fireEvent.click(screen.getByRole('button', { name: zhTW.outing.share.reset }))
    fireEvent.click(await screen.findByRole('button', { name: zhTW.outing.share.resetConfirm }))
    await screen.findByText(zhTW.outing.share.resetDone)
    expect(track).not.toHaveBeenCalled()
  })
})
