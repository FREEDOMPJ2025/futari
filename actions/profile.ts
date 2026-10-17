'use server'

import { db } from '@/lib/db/client'
import { profiles } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { requireViewer } from '@/lib/auth/viewer'
import { revalidateAfterProfileMutation } from '@/lib/revalidate'
import { validateName } from '@/lib/validators'
import type { SplitType } from '@/lib/balance'
import { action, actionError } from '@/lib/action-errors'
import { revalidatePath } from 'next/cache'
import { captureServer } from '@/lib/analytics/server'
import { hideNameInLeftLedgers, type LeftLedgerNameCounts } from '@/lib/db/queries/epoch'

export const updateDisplayName = action(async (name: string): Promise<{ ok: true }> => {
  const { user } = await requireViewer()

  const trimmed = validateName(name, '顯示名稱')

  const result = await db
    .update(profiles)
    .set({ displayName: trimmed })
    .where(eq(profiles.id, user.id))
    .returning({ id: profiles.id })

  if (result.length === 0) throw actionError('profile_not_found')

  // Display name shows in headers / rows across the app.
  revalidateAfterProfileMutation()
  return { ok: true }
})

const VALID_SPLIT_TYPES: ReadonlyArray<SplitType> = ['all_mine', 'all_theirs', 'half']

export const updateDefaultSplitType = action(async (splitType: SplitType): Promise<{ ok: true }> => {
  const { user } = await requireViewer()

  if (!VALID_SPLIT_TYPES.includes(splitType)) {
    throw actionError('split_type_invalid')
  }

  const result = await db
    .update(profiles)
    .set({ defaultSplitType: splitType })
    .where(eq(profiles.id, user.id))
    .returning({ id: profiles.id })

  if (result.length === 0) throw actionError('profile_not_found')

  revalidateAfterProfileMutation()
  return { ok: true }
})

/**
 * #1328 — owner-only: hides/shows the viewer's own avatar. `requireViewer()`
 * scopes the write to `user.id`, so there's no way to toggle a partner's
 * flag from here. The read side (dashboard layout, settings, review pages,
 * asset queries) checks this flag before ever returning avatarUrl, for BOTH
 * members — this action only flips the bit.
 */
export const updateAvatarHidden = action(async (hidden: boolean): Promise<{ ok: true }> => {
  const { user } = await requireViewer()

  const result = await db
    .update(profiles)
    .set({ avatarHidden: hidden })
    .where(eq(profiles.id, user.id))
    .returning({ id: profiles.id })

  if (result.length === 0) throw actionError('profile_not_found')

  revalidateAfterProfileMutation()
  return { ok: true }
})

/**
 * #1619 — one-way, on request: in the ledgers the viewer has left, their name
 * in the closed chapters and on those chapters' outing lists becomes
 * 「已離開的夥伴」. Takes no id — the session decides whose name changes
 * (`requireViewer()` re-validates it), so there is no way to rename anyone
 * else. Only chapters closed now; a second run changes nothing (0 / 0).
 * See `hideNameInLeftLedgers` for the locking and the predicates.
 */
export const hideMyNameInLeftLedgers = action(async (): Promise<LeftLedgerNameCounts> => {
  const { user } = await requireViewer()

  const counts = await hideNameInLeftLedgers(user.id)

  // Counts only: never a ledger, chapter or name.
  await captureServer(user.id, 'left_ledger_name_hidden', {
    chapters: counts.chapters,
    outings: counts.outings,
  })
  revalidatePath('/settings/past-times')
  revalidatePath('/onboarding/past-times')
  return counts
})
