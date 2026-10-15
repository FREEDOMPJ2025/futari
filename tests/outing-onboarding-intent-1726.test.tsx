/**
 * #1726 — someone who signs up from /features/outing keeps that intent through
 * /onboarding and /setup and ends on the new-outing sheet; every other entry
 * keeps the ordinary flow. `intent` is a closed set mapped to fixed paths, so
 * nothing from the URL becomes a redirect target.
 *
 * What failure looks like: nothing errors. The visitor is walked through the
 * philosophy cards and an invite-your-partner screen to /dashboard, and the
 * outing they came for is never mentioned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const push = vi.fn()
const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn() }),
  usePathname: () => '/outings',
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))
vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }))
vi.mock('@/actions/group', () => ({ createGroup: vi.fn() }))
vi.mock('@/actions/invite', () => ({ createInvite: vi.fn() }))
vi.mock('@/lib/share', () => ({ shareInviteLink: vi.fn() }))
vi.mock('@/lib/install-guide', async (orig) => ({ ...(await orig<object>()), isStandalone: () => false }))

const user = { id: 'u1' }
let groupRows: unknown[] = []
vi.mock('@/lib/supabase/server', () => ({ getCurrentUser: async () => user }))
vi.mock('@/lib/db/client', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => groupRows }) }) }) },
}))
vi.mock('@/lib/db/queries/epoch', () => ({ hasClosedChapterForViewer: async () => false }))
vi.mock('@/lib/i18n/t', async () => {
  const { zhTW } = await import('@/lib/i18n/locales/zh-TW')
  return { getTranslations: async () => zhTW }
})

import { zhTW } from '@/lib/i18n/locales/zh-TW'
import { en as enUS } from '@/lib/i18n/locales/en'
import { zhCN } from '@/lib/i18n/locales/zh-CN'
import { ja } from '@/lib/i18n/locales/ja'
import OnboardingPage from '@/app/onboarding/page'
import SetupPage from '@/app/setup/page'
import SetupForm from '@/app/setup/SetupForm'
import { createGroup } from '@/actions/group'
import { createInvite } from '@/actions/invite'
import { INTENT_DESTINATION, parseOnboardingIntent } from '@/lib/onboarding/intent'

const sp = (o: { intent?: string | string[] }) => ({ searchParams: Promise.resolve(o) })

beforeEach(() => {
  push.mockClear()
  replace.mockClear()
  groupRows = []
  localStorage.clear()
})

describe('parseOnboardingIntent', () => {
  it('accepts only the exact closed-set value', () => {
    expect(parseOnboardingIntent('outing')).toBe('outing')
    for (const v of [undefined, '', 'Outing', 'outing ', ['outing'], ['outing', 'outing'], '/outings', 'https://evil.example', '//evil.example', 'dashboard']) {
      expect(parseOnboardingIntent(v)).toBeNull()
    }
  })

  it('maps every intent to a fixed same-origin app path', () => {
    for (const dest of Object.values(INTENT_DESTINATION)) {
      expect(dest.startsWith('/')).toBe(true)
      expect(dest.startsWith('//')).toBe(false)
    }
    expect(INTENT_DESTINATION.outing).toBe('/outings?create=1')
  })
})

describe('/onboarding', () => {
  it('outing intent, no ledger → straight to /setup?intent=outing (no philosophy cards)', async () => {
    await expect(OnboardingPage(sp({ intent: 'outing' }))).rejects.toThrow('NEXT_REDIRECT /setup?intent=outing')
  })
  it('outing intent, has a ledger → /outings (as before #1726)', async () => {
    groupRows = [{ id: 'g1' }]
    await expect(OnboardingPage(sp({ intent: 'outing' }))).rejects.toThrow('NEXT_REDIRECT /outings')
  })
  it('no / unknown intent → unchanged: cards render, or /dashboard with a ledger', async () => {
    for (const params of [{}, { intent: 'evil' }, { intent: ['outing', 'x'] }]) {
      await expect(OnboardingPage(sp(params))).resolves.toBeTruthy()
    }
    await expect(OnboardingPage({})).resolves.toBeTruthy()
    groupRows = [{ id: 'g1' }]
    await expect(OnboardingPage(sp({ intent: 'nope' }))).rejects.toThrow('NEXT_REDIRECT /dashboard')
  })
})

describe('/setup', () => {
  it('with a ledger: outing intent → /outings, otherwise /dashboard', async () => {
    groupRows = [{ id: 'g1' }]
    await expect(SetupPage(sp({ intent: 'outing' }))).rejects.toThrow('NEXT_REDIRECT /outings')
    await expect(SetupPage(sp({}))).rejects.toThrow('NEXT_REDIRECT /dashboard')
  })
})

async function driveToInvite(intent: 'outing' | null) {
  vi.mocked(createGroup).mockResolvedValue({ ok: true, data: { id: 'g1', name: '我們倆' } } as never)
  vi.mocked(createInvite).mockResolvedValue({ ok: true, data: 'https://futari.example/invite/tok' } as never)
  render(<SetupForm t={zhTW} intent={intent} />)
  const reason = screen.queryByText(zhTW.setup.name.outingReason)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '我們倆' } })
  fireEvent.click(screen.getByText(zhTW.setup.name.next))
  fireEvent.click(await screen.findByText(zhTW.trust.bilateral.inviter.cta))
  await screen.findByText(zhTW.setup.invite.heading)
  return { reason }
}

describe('SetupForm', () => {
  it('outing intent: says why on the name step, skip goes straight to the new-outing sheet (3 steps)', async () => {
    const { reason } = await driveToInvite('outing')
    expect(reason).not.toBeNull()
    expect(screen.queryByText(zhTW.setup.invite.skip)).toBeNull()
    expect(screen.getByText(zhTW.setup.invite.outingHint)).toBeTruthy()
    fireEvent.click(screen.getByText(zhTW.setup.invite.skipToOuting))
    expect(push).toHaveBeenCalledWith('/outings?create=1')
  })

  it('no intent: unchanged copy, skip opens the install guide, then /dashboard', async () => {
    const { reason } = await driveToInvite(null)
    expect(reason).toBeNull()
    expect(screen.queryByText(zhTW.setup.invite.skipToOuting)).toBeNull()
    expect(screen.queryByText(zhTW.setup.invite.outingHint)).toBeNull()
    fireEvent.click(screen.getByText(zhTW.setup.invite.skip))
    expect(push).not.toHaveBeenCalled()
  })
})

describe('copy', () => {
  it.each([['zh-TW', zhTW], ['zh-CN', zhCN], ['en', enUS], ['ja', ja]] as const)('%s: new strings exist, no exclamation, no 還在等', (_l, d) => {
    for (const s of [d.setup.name.outingReason, d.setup.invite.skipToOuting, d.setup.invite.outingHint]) {
      expect(s.length).toBeGreaterThan(0)
      expect(s).not.toMatch(/[!！]|還在等|还在等|管理|追蹤|追踪|監控|他還|她還/)
    }
  })
})


describe('next survives the OAuth round trip', () => {
  it('buildAuthCallbackUrl encodes the query-bearing next; the callback reads it back same-origin', async () => {
    const { buildAuthCallbackUrl } = await import('@/lib/analytics/attribution')
    const { safeSameOriginUrl } = await import('@/lib/auth/nativeRedirect')
    const { OUTING_ONBOARDING_NEXT } = await import('@/lib/onboarding/intent')
    const origin = 'https://futari.example'
    const cb = new URL(buildAuthCallbackUrl(origin, { next: OUTING_ONBOARDING_NEXT, from: 'feature-outing', anonId: 'a1' }))
    expect(cb.searchParams.get('next')).toBe('/onboarding?intent=outing')
    expect(cb.searchParams.get('from')).toBe('feature-outing')
    expect(safeSameOriginUrl(origin, cb.searchParams.get('next')!)).toBe(`${origin}/onboarding?intent=outing`)
  })
})
