// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// #1675: legacy `?lang=<locale>` on public localized paths → 308 to the
// locale-prefixed URL. Failure is silent (old links keep showing zh-TW).

const h = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ data: { user: null } })),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: h.getUser } })),
}))

import { proxy } from '@/proxy'

const ORIGIN = 'https://futari.southern-light.dev'

const run = (path: string) => proxy(new NextRequest(`${ORIGIN}${path}`))

beforeEach(() => vi.clearAllMocks())

describe('#1675 legacy ?lang= redirect', () => {
  it.each([
    ['/?lang=ja', '/ja'],
    ['/?lang=zh-TW', '/'],
    ['/?lang=zh-CN', '/zh-CN'],
    ['/migrate/spendee?lang=en&utm_source=x', '/en/migrate/spendee?utm_source=x'],
    ['/migrate/spendee?a=1&lang=en&b=2', '/en/migrate/spendee?a=1&b=2'],
    ['/ja?lang=en', '/en'],
    ['/en/use-case/travel?lang=zh-TW', '/use-case/travel'],
  ])('%s -> 308 %s', async (from, to) => {
    const res = await run(from)
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe(`${ORIGIN}${to}`)
    expect(res.headers.get('location')).not.toContain('lang=')
  })

  it.each(['/?lang=xx', '/?lang=', '/?lang=JA', '/en?lang=xx'])(
    'invalid lang does not redirect: %s',
    async (p) => {
      const res = await run(p)
      expect(res.status).toBeLessThan(300)
      expect(res.headers.get('location')).toBeNull()
    },
  )

  it('non-public path is not touched by this rule', async () => {
    const res = await run('/dashboard?lang=ja')
    expect(res.status).not.toBe(308)
    expect(res.headers.get('location') ?? '').not.toMatch(/\/ja/)
  })
})
