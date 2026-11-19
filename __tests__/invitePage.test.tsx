import { renderToString } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import InvitePage from '@/app/invite/[token]/page'
import { previewInvite } from '@/actions/invite'
import { zhTW } from '@/lib/i18n/locales/zh-TW'

vi.mock('@/actions/invite', () => ({ previewInvite: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ getCurrentUser: async () => ({ id: 'viewer' }) }))
vi.mock('@/lib/i18n/t', () => ({ getTranslations: async () => zhTW }))
vi.mock('@/app/invite/[token]/InviteConfirm', () => ({ InviteConfirm: () => null }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))

function renderInvitePage() {
  return InvitePage({ params: Promise.resolve({ token: 'A'.repeat(43) }) })
}

it('redirects a member to the dashboard before rendering an error card', async () => {
  vi.mocked(previewInvite).mockResolvedValue({ ok: true, data: { ok: false, error: 'already_member' } })
  await expect(renderInvitePage()).rejects.toThrow('NEXT_REDIRECT /dashboard')
})

it('renders the existing error title and message for a used link opened by a non-member', async () => {
  vi.mocked(previewInvite).mockResolvedValue({ ok: true, data: { ok: false, error: 'already_used' } })
  const html = renderToString(await renderInvitePage())
  expect(html).toContain(zhTW.invite.errorTitle)
  expect(html).toContain(zhTW.invite.errors.alreadyUsed)
})
