import { describe, it, expect } from 'vitest'
import { nativeCallbackUrl, safeSameOriginUrl } from '@/lib/auth/nativeRedirect'
import { AUTH_PLATFORM_PARAM, authPathFromHint, buildAuthCallbackUrl } from '@/lib/analytics/attribution'

const ORIGINS = ['https://futari.southern-light.dev', 'http://localhost:3000']
const SCHEME = 'dev.southernlight.futari'

describe.each(ORIGINS)('safeSameOriginUrl (%s)', (origin) => {
  it('passes root-relative paths through on the same origin', () => {
    expect(safeSameOriginUrl(origin, '/dashboard')).toBe(`${origin}/dashboard`)
    expect(safeSameOriginUrl(origin, '/invite/abc?x=1')).toBe(`${origin}/invite/abc?x=1`)
  })

  // Pre-#1214 `${APP_ORIGIN}${next}` with next=`@evil.com/x` produced
  // `https://futari.southern-light.dev@evil.com/x` — a userinfo URL on evil.com.
  it.each(['@evil.com/x', '.evil.com/', '//evil.com', '/\\evil.com', 'https://evil.com', '', 'dashboard'])(
    'falls back to /dashboard for %j',
    (path) => {
      expect(safeSameOriginUrl(origin, path)).toBe(`${origin}/dashboard`)
    },
  )

  it('never throws', () => {
    for (const path of ['/\t/evil.com', '/%', '\0', '/\n/evil.com', undefined as unknown as string]) {
      expect(() => safeSameOriginUrl(origin, path)).not.toThrow()
      expect(new URL(safeSameOriginUrl(origin, path)).origin).toBe(origin)
    }
  })
})

describe.each(ORIGINS)('nativeCallbackUrl (%s)', (origin) => {
  it('maps the OAuth callback deep link onto the current origin', () => {
    expect(
      nativeCallbackUrl(origin, `${SCHEME}://login-callback/auth/callback?code=x&next=%2Fdashboard`, SCHEME),
    ).toBe(`${origin}/auth/callback?code=x&next=%2Fdashboard`)
  })

  it.each([
    `${SCHEME}://login-callback@evil.com/x`,
    `${SCHEME}://login-callback/evil`,
    `${SCHEME}://foo/auth/callback?code=x`,
    `${SCHEME}://login-callback//evil.com/auth/callback?`,
    // #1769: the platform hint changes nothing about what is rejected.
    `${SCHEME}://login-callback@evil.com/x?p=android_native`,
    `${SCHEME}://foo/auth/callback?code=x&p=android_native`,
    `${SCHEME}://login-callback//evil.com/auth/callback?p=ios_browser`,
  ])('ignores %s', (link) => {
    expect(nativeCallbackUrl(origin, link, SCHEME)).toBeNull()
  })

  // #1769 — the hint rides through the deep link untouched, so the callback
  // route sees it. GoTrue appends `code` to redirect_to's query.
  it.each(['android_native', 'ios_browser'] as const)('carries p=%s through to the callback', (hint) => {
    const redirectTo = buildAuthCallbackUrl(`${SCHEME}://login-callback`, {
      next: '/dashboard',
      from: 'landing',
      anonId: 'anon-1',
      platformHint: hint,
    })
    const target = nativeCallbackUrl(origin, `${redirectTo}&code=x`, SCHEME)
    expect(target).toBe(`${origin}/auth/callback?next=%2Fdashboard&from=landing&aid=anon-1&p=${hint}&code=x`)
    const params = new URL(target!).searchParams
    expect(authPathFromHint(params.getAll(AUTH_PLATFORM_PARAM))).toBe(hint)
    expect(params.get('code')).toBe('x')
    expect(params.get('next')).toBe('/dashboard')
  })
})
