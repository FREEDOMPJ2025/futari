import { describe, it, expect, beforeEach, vi } from 'vitest'

// #1699 — enterPastEpoch writes the past-chapter cookie. A value that is not
// uuid-shaped must not reach the cookie: the read side used to pass it straight
// to Postgres (22P02) and every dashboard page 500'd until it was cleared.

const cookieStore = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (key: string) => {
      const value = cookieStore.get(key)
      return value === undefined ? undefined : { value }
    },
    set: (key: string, value: string) => { cookieStore.set(key, value) },
    delete: (key: string) => { cookieStore.delete(key) },
  })),
}))

const revalidate = vi.fn()
vi.mock('@/lib/revalidate', () => ({ revalidateAfterEpochViewChange: () => revalidate() }))

import { enterPastEpoch } from '@/actions/epoch-view'
import { PAST_EPOCH_COOKIE } from '@/lib/db/queries/epoch'

const EPOCH = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

beforeEach(() => {
  cookieStore.clear()
  revalidate.mockClear()
})

describe('enterPastEpoch (#1699)', () => {
  it.each([
    ['not-a-uuid', 'not-a-uuid'],
    ['empty', ''],
    ['over-long', `${EPOCH}${'0'.repeat(4096)}`],
    ['uuid with trailing junk', `${EPOCH}'--`],
  ])('refuses %s and writes no cookie', async (_label, raw) => {
    await expect(enterPastEpoch(raw)).rejects.toThrow('Invalid past-epoch id')
    expect(cookieStore.has(PAST_EPOCH_COOKIE)).toBe(false)
    expect(revalidate).not.toHaveBeenCalled()
  })

  it('a uuid is written as the pin (uppercase too)', async () => {
    expect((await enterPastEpoch(EPOCH)).ok).toBe(true)
    expect(cookieStore.get(PAST_EPOCH_COOKIE)).toBe(EPOCH)
    expect((await enterPastEpoch(EPOCH.toUpperCase())).ok).toBe(true)
    expect(cookieStore.get(PAST_EPOCH_COOKIE)).toBe(EPOCH.toUpperCase())
    expect(revalidate).toHaveBeenCalledTimes(2)
  })
})
