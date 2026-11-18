// @vitest-environment node
/**
 * #1910 — the launch film's files skip the auth proxy. Without the `mp4|vtt`
 * exclusion in `proxy.ts`'s matcher, `/videos/futari-launch/*.mp4` and the
 * `.vtt` track were 307'd to /sign-in: the <video> received an HTML page, so
 * the film never played and the captions never loaded, with no error shown.
 */
import { describe, it, expect, vi } from 'vitest'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: vi.fn(async () => ({ data: { user: null } })) } })),
}))

import { config } from '@/proxy'
import { LAUNCH_FILM } from '@/lib/launchFilm'

const ORIGIN = 'https://futari.southern-light.dev'
const matches = (path: string) => unstable_doesMiddlewareMatch({ config, url: `${ORIGIN}${path}` })

describe('proxy matcher lets the launch film through (#1910)', () => {
  it.each(Object.values(LAUNCH_FILM))('%s skips the proxy', (p) => {
    expect(matches(p)).toBe(false)
  })

  it.each(['/dashboard', '/zh-TW', '/videos/futari-launch/'])('%s still goes through the proxy', (p) => {
    expect(matches(p)).toBe(true)
  })
})
