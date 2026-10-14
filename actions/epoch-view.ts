'use server'

import { cookies } from 'next/headers'
import { PAST_EPOCH_COOKIE } from '@/lib/db/queries/epoch'
import { revalidateAfterEpochViewChange } from '@/lib/revalidate'
import { action } from '@/lib/action-errors'
import { isUuid } from '@/lib/outing/validate'

/**
 * Pin the viewer to a historical epoch for the rest of the browser session.
 * The cookie has no `expires`, so it's a session cookie — closes when the
 * browser closes (matches the "per-session ritual" UX intent).
 *
 * Only the id's SHAPE is checked here (#1699): a non-uuid value is refused and
 * no cookie is written. The UI only ever sends ids from `listEpochsForViewer`,
 * so this is a plain throw, not a user-facing code. Whether the viewer may see
 * that chapter is decided on every read by `resolveViewerEpochContext`
 * (`pinAcceptable`), not here — membership can change after the cookie is set,
 * so a write-time check would not stay true. A uuid the viewer may not see,
 * and any non-uuid value that reaches the cookie some other way, fall back to
 * the viewer's current chapter.
 */
export const enterPastEpoch = action(async (epochId: string): Promise<void> => {
  if (!isUuid(epochId)) throw new Error('Invalid past-epoch id')
  const jar = await cookies()
  jar.set(PAST_EPOCH_COOKIE, epochId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  })
  // Trigger a re-render of the navigation surfaces that read the cookie.
  revalidateAfterEpochViewChange()
})

export const exitPastEpoch = action(async (): Promise<void> => {
  const jar = await cookies()
  jar.delete(PAST_EPOCH_COOKIE)
  revalidateAfterEpochViewChange()
})

/**
 * Server-side helper for layouts/pages to read the current pin without
 * pulling in `cookies()` everywhere.
 */
export const getPinnedEpochId = action(async (): Promise<string | null> => {
  const jar = await cookies()
  return jar.get(PAST_EPOCH_COOKIE)?.value ?? null
})
