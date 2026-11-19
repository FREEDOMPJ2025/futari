import { describe, expect, it, vi } from 'vitest'
import { previewInvite } from '@/actions/invite'
import { captureServer } from '@/lib/analytics/server'
import { requireViewer } from '@/lib/auth/viewer'
import { db } from '@/lib/db/client'
import { groupInvites, oikosGroups } from '@/lib/db/schema'

vi.mock('@/lib/auth/viewer', () => ({ requireViewer: vi.fn() }))
vi.mock('@/lib/analytics/server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/db/client', () => ({ db: { select: vi.fn() } }))
vi.mock('@/lib/db/queries/group', () => ({ getActiveGroupForUser: vi.fn() }))

const token = 'A'.repeat(43)
const group = { id: 'ledger', memberA: 'inviter', memberB: 'partner' }
const invite = { groupId: group.id, invitedBy: group.memberA, acceptedAt: new Date() }

describe('previewInvite for an accepted invite', () => {
  it.each([
    ['inviter', 'already_member', ['inviter', 'invite_link_reopened_by_member']],
    ['partner', 'already_member', ['partner', 'invite_link_reopened_by_member']],
    ['outsider', 'already_used', ['outsider', 'invite_preview_failed', { code: 'already_used' }]],
  ])('returns the expected result and telemetry for %s', async (id, error, capture) => {
    vi.clearAllMocks()
    vi.mocked(requireViewer).mockResolvedValue({ user: { id } } as Awaited<ReturnType<typeof requireViewer>>)
    const select = {
      from: (table: typeof groupInvites | typeof oikosGroups) => ({
        where: () => ({ limit: async () => [table === groupInvites ? invite : group] }),
      }),
    }
    vi.mocked(db.select).mockReturnValue(select as unknown as ReturnType<typeof db.select>)

    expect(await previewInvite(token)).toEqual({ ok: true, data: { ok: false, error } })
    expect(vi.mocked(captureServer).mock.calls).toEqual([capture])
  })
})
