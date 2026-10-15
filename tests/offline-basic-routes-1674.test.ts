// @vitest-environment node
/**
 * #1674 — the routes the web offline page depends on: the proxy lets the
 * worker and the page through (and nothing that merely looks like them), the
 * probe `/api/ping` answers 204 without ever asking Supabase who the user is,
 * and the page's response headers carry a CSP whose hashes match the page.
 *
 * Failure looks like: `/sw-basic.js` 307s to sign-in (registration silently
 * fails, MIME mismatch), the probe redirects to sign-in so the page never
 * returns by itself, or the offline page renders blank under its own CSP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match'

const h = vi.hoisted(() => ({ getUser: vi.fn(async () => ({ data: { user: null } })) }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: h.getUser } })),
}))

import { proxy, config } from '@/proxy'
import { GET, HEAD } from '@/app/api/ping/route'
import { headerRules, OFFLINE_BASIC_RULES } from '@/next.config'
import { offlineBasicCsp, offlineBasicPageHeaders } from '@/lib/offline/offlineBasicHeaders'
import { buildOfflineBasic } from '../scripts/build-web-offline-basic.ts'

const ORIGIN = 'https://futari.southern-light.dev'

beforeEach(() => {
  h.getUser.mockClear()
})

describe('proxy matcher (#1674, P4b)', () => {
  const matches = (path: string) => unstable_doesMiddlewareMatch({ config, url: `${ORIGIN}${path}` })

  it.each(['/sw-basic.js', '/offline-basic.html', '/sw.js'])('%s skips the proxy', (p) => {
    expect(matches(p)).toBe(false)
  })

  it.each(['/sw-basic.jsx', '/sw-basic.js.map', '/offline-basic.html.bak', '/offline-basic.htmlx', '/dashboard', '/api/ping'])(
    '%s still goes through the proxy',
    (p) => {
      expect(matches(p)).toBe(true)
    },
  )
})

describe('/api/ping is public, exact, and never calls getUser (#1674)', () => {
  it('/api/ping → passes through without getUser', async () => {
    const res = await proxy(new NextRequest(`${ORIGIN}/api/ping`))
    expect(res.headers.get('location')).toBeNull()
    expect(h.getUser).not.toHaveBeenCalled()
  })

  it.each(['/api/ping/', '/api/ping/x', '/api/pingx', '/api/ping.json'])('%s stays protected (getUser + redirect)', async (p) => {
    const res = await proxy(new NextRequest(`${ORIGIN}${p}`))
    expect(h.getUser).toHaveBeenCalled()
    expect(res.status).toBe(307)
  })

  it('GET and HEAD → 204, no body, no-store', async () => {
    for (const handler of [GET, HEAD]) {
      const res = handler()
      expect(res.status).toBe(204)
      expect(res.headers.get('cache-control')).toBe('no-store, max-age=0')
      expect(await res.text()).toBe('')
    }
  })
})

describe('offline page headers (#1674, S2.4)', () => {
  function headersFor(pathname: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const rule of headerRules) {
      const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, sensitive: false })
      if (match(pathname)) for (const x of rule.headers) out[x.key.toLowerCase()] = x.value
    }
    return out
  }

  it('the CSP allows exactly the page inline scripts, by hash, and nothing remote', () => {
    const { page, artifact } = buildOfflineBasic('basic')
    const csp = offlineBasicCsp(artifact.scriptHashes)
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    for (const s of scripts) {
      expect(csp).toContain(`'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`)
    }
    expect(csp).toBe(
      `default-src 'none'; script-src ${artifact.scriptHashes.map((x) => `'${x}'`).join(' ')}; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    )
    expect(csp).not.toMatch(/unsafe-eval|https?:|\*/)
  })

  it('without the build artifact the CSP allows no script at all', () => {
    expect(offlineBasicCsp([])).toContain("script-src 'none'")
  })

  it('next.config applies the page headers and worker no-store', () => {
    const page = headersFor('/offline-basic.html')
    const expected = offlineBasicPageHeaders(
      OFFLINE_BASIC_RULES[0].headers
        .find((x) => x.key === 'Content-Security-Policy')!
        .value.match(/'sha256-[^']+'/g)?.map((x) => x.slice(1, -1)) ?? [],
    )
    for (const { key, value } of expected) expect(page[key.toLowerCase()]).toBe(value)
    expect(page['x-content-type-options']).toBe('nosniff')
    expect(headersFor('/sw-basic.js')['cache-control']).toBe('no-store, max-age=0')
  })
})
