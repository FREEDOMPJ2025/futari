/**
 * #1728 — after an outing ends, the friend's view offers one quiet card:
 * Futari is also for two people's everyday spending. Never on an active
 * outing, never for a signed-in viewer who already has a ledger; closing it
 * keeps it closed for that outing. Sign-in is tagged `from=outing`, so
 * signed_up reads entry_source=outing. Events carry no properties.
 *
 * What failure looks like: nothing errors. The card interrupts an outing in
 * progress, nags someone who already uses Futari, comes back after being
 * closed, or the sign-up is counted as `direct`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { I18nWrapper } from './_mocks/i18n'
import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { dictionaries } from '@/lib/i18n/t'
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales-meta'
import { entrySourceFromParam } from '@/lib/analytics/attribution'

const m = vi.hoisted(() => ({
  getOutingFullView: vi.fn(),
  resolveReader: vi.fn(),
  getActiveGroupForUser: vi.fn(),
}))
vi.mock('@/lib/db/queries/outingPublic', () => ({ getOutingFullView: m.getOutingFullView, getOutingLanding: vi.fn() }))
vi.mock('@/lib/db/queries/group', () => ({ getActiveGroupForUser: m.getActiveGroupForUser }))
vi.mock('@/lib/outing/access', () => ({ resolveReader: m.resolveReader }))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}))
vi.mock('@/actions/outing', () => ({}))
const track = vi.hoisted(() => vi.fn())
vi.mock('@/lib/analytics/track', () => ({ track }))

const { default: ResumePage } = await import('@/app/[locale]/outing/r/[outingId]/page')
const { OutingParticipantView } = await import('@/app/[locale]/outing/_components/OutingParticipantView')
const { LedgerInviteCard, ledgerInviteDismissKey } = await import('@/app/[locale]/outing/_components/LedgerInviteCard')

const ID = '0b0e7d3c-6b7e-4c8e-9a51-2f7d3c6b7e4c'
const c = zhTW.outingPublic

function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement(node)) return null
  if (node.type === type) return node as ReactElement<Record<string, unknown>>
  const children = (node.props as { children?: ReactNode }).children
  for (const child of ([] as ReactNode[]).concat(children ?? [])) {
    const hit = find(child, type)
    if (hit) return hit
  }
  return null
}

const view = (status: string) => ({
  outing: { id: ID, name: '綠島', currency: 'twd', status },
  youParticipantId: 'p1', isAdmin: false,
  participants: [], expenses: [], settlements: [], transfers: [],
})
const resumeAs = async (status: string, actor: Record<string, unknown>, locale = 'zh-TW') => {
  m.resolveReader.mockResolvedValue({ outing: { id: ID, groupId: 'g', epochId: 'e', status, name: '綠島', currency: 'twd' }, actor })
  m.getOutingFullView.mockResolvedValue(view(status))
  const out = await ResumePage({ params: Promise.resolve({ locale, outingId: ID }) })
  return find(out, OutingParticipantView)!.props.ledgerInviteHref as string | null
}
const anon = { kind: 'participant', via: 'cookie', userId: null, participantId: 'p1' }
const signedIn = { kind: 'participant', via: 'session', userId: 'u2', participantId: 'p1' }

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe('who is offered the card (page)', () => {
  it('never on an active outing, and the ledger is not even looked up', async () => {
    expect(await resumeAs('active', anon)).toBeNull()
    expect(await resumeAs('active', signedIn)).toBeNull()
    expect(m.getActiveGroupForUser).not.toHaveBeenCalled()
  })

  it('signed out, ended → sign-in tagged from=outing, landing on onboarding; counted as entry_source=outing', async () => {
    const href = await resumeAs('ended', anon, 'ja')
    expect(href).toBe('/ja/sign-in?next=/onboarding&from=outing')
    expect(entrySourceFromParam(new URL(href!, 'https://x').searchParams.get('from'))).toBe('outing')
    expect(m.getActiveGroupForUser).not.toHaveBeenCalled()
  })

  it('signed in without a ledger → straight to onboarding', async () => {
    m.getActiveGroupForUser.mockResolvedValue(null)
    expect(await resumeAs('ended', signedIn)).toBe('/onboarding')
    expect(m.getActiveGroupForUser).toHaveBeenCalledWith('u2')
  })

  it('signed in with a ledger → no card', async () => {
    m.getActiveGroupForUser.mockResolvedValue({ id: 'g-own' })
    expect(await resumeAs('ended', signedIn)).toBeNull()
  })
})

const wrap = (ui: React.ReactElement) => render(<I18nWrapper>{ui}</I18nWrapper>)
const HREF = '/zh-TW/sign-in?next=/onboarding&from=outing'

describe('the card', () => {
  it('shows on an ended outing in the friend view, with the link; never on an active one', () => {
    const props = { needsBind: false, signedIn: false, signInHref: '/x', ledgerInviteHref: HREF }
    const { unmount } = wrap(<OutingParticipantView view={view('active') as never} {...props} />)
    expect(screen.queryByText(c.ledgerInviteTitle)).toBeNull()
    unmount()
    wrap(<OutingParticipantView view={view('ended') as never} {...props} />)
    expect(screen.getByText(c.ledgerInviteTitle)).toBeTruthy()
    expect(screen.getByRole('link', { name: c.ledgerInviteCta }).getAttribute('href')).toBe(HREF)
  })

  it('view and click fire with no properties', () => {
    wrap(<LedgerInviteCard outingId={ID} href={HREF} />)
    expect(track).toHaveBeenCalledWith('outing_ledger_invite_viewed')
    fireEvent.click(screen.getByRole('link', { name: c.ledgerInviteCta }))
    expect(track).toHaveBeenCalledWith('outing_ledger_invite_clicked')
    for (const call of track.mock.calls) expect(call).toHaveLength(1)
  })

  it('closing keeps it closed for this outing only', () => {
    const { unmount } = wrap(<LedgerInviteCard outingId={ID} href={HREF} />)
    fireEvent.click(screen.getByRole('button', { name: c.ledgerInviteDismiss }))
    expect(screen.queryByText(c.ledgerInviteTitle)).toBeNull()
    expect(window.localStorage.getItem(ledgerInviteDismissKey(ID))).toBe('1')
    unmount()
    track.mockClear()
    const again = wrap(<LedgerInviteCard outingId={ID} href={HREF} />)
    expect(screen.queryByText(c.ledgerInviteTitle)).toBeNull()
    expect(track).not.toHaveBeenCalled()
    again.unmount()
    wrap(<LedgerInviteCard outingId="another-outing" href={HREF} />)
    expect(screen.getByText(c.ledgerInviteTitle)).toBeTruthy()
  })

  it('blocked storage: still shows, and closing still hides it for the visit', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    wrap(<LedgerInviteCard outingId={ID} href={HREF} />)
    expect(screen.getByText(c.ledgerInviteTitle)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: c.ledgerInviteDismiss })) })
    expect(screen.queryByText(c.ledgerInviteTitle)).toBeNull()
    get.mockRestore()
    set.mockRestore()
  })
})

describe('copy', () => {
  it.each([...SUPPORTED_LOCALES])('%s: no conversion words, no partner or gender assumed', (locale) => {
    const o = dictionaries[locale].outingPublic
    for (const v of [o.ledgerInviteTitle, o.ledgerInviteBody, o.ledgerInviteCta, o.ledgerInviteDismiss]) {
      expect(v).not.toMatch(/[!！]|立即|免費試用|免费试用|開始|开始|free trial|start now|今すぐ|無料/i)
      expect(v).not.toMatch(/伴侶|伴侣|另一半|男友|女友|老公|老婆|partner|boyfriend|girlfriend|spouse|恋人|彼氏|彼女|夫|妻/i)
    }
  })
})
