// @vitest-environment node
/**
 * #1536 S3 — the parts of `POST /api/shortcut/pending` that need no database:
 *
 *   - proxy.ts lets exactly `/api/shortcut/pending` through without asking
 *     Supabase who the user is (a Shortcut has no cookie); every look-alike
 *     stays behind the auth gate.
 *   - the route rejects a missing / malformed key, and every non-POST
 *     method, before any query runs, with `no-store` and a fixed body.
 *   - parseQuickAddJson's type gate (what the body may contain).
 *   - Sentry's text scrub masks a shortcut key.
 *
 * The database paths (201 / 401 revoked / 409 / 429 / concurrency) are in
 * __tests__/actions/shortcutPendingRoute1536.test.ts (stand-in Postgres).
 *
 * HTTP-level note (plan R1-4): a request for `/api/shortcut/pending/` never
 * reaches the proxy as that path in production — Next 308s a trailing slash
 * to `/api/shortcut/pending` first (trailingSlash: false), and that exact
 * path still needs the bearer key. The proxy-level test below only proves
 * the slash form is not treated as public on its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import type { Event } from '@sentry/nextjs'

const h = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ data: { user: null } })),
  dbTouched: vi.fn(),
}))
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: h.getUser } })),
}))
// Any query at all fails the test: the 401 / 405 paths must not reach it.
vi.mock('@/lib/db/client', () => ({
  db: new Proxy({}, { get: () => { h.dbTouched(); throw new Error('db must not be touched') } }),
}))
// The route must never consult the cookie session.
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => { throw new Error('cookie session used') },
  getCurrentUser: () => { throw new Error('cookie session used') },
}))

import { proxy, config } from '@/proxy'
import * as route from '@/app/api/shortcut/pending/route'
import { parseQuickAddJson, parseQuickAddHash } from '@/lib/quickAdd'
import { scrubSentryEvent } from '@/lib/observability/sentryScrub'
import { MAX_AMOUNT } from '@/lib/validators'

const ORIGIN = 'https://futari.southern-light.dev'
const PATH = '/api/shortcut/pending'
const KEY = `fts_sk_${'A'.repeat(43)}`

beforeEach(() => {
  h.getUser.mockClear()
  h.dbTouched.mockClear()
})

describe('proxy: the shortcut endpoint is public, exact (#1536 F9)', () => {
  it('the path goes through the proxy matcher (so the exception below is what lets it in)', () => {
    expect(unstable_doesMiddlewareMatch({ config, url: `${ORIGIN}${PATH}` })).toBe(true)
  })

  it(`${PATH} → passes through without getUser or a redirect`, async () => {
    const res = await proxy(new NextRequest(`${ORIGIN}${PATH}`, { method: 'POST' }))
    expect(res.headers.get('location')).toBeNull()
    expect(h.getUser).not.toHaveBeenCalled()
  })

  it.each([
    '/api/shortcut',
    '/api/shortcut/',
    '/api/shortcut/pending/',
    '/api/shortcut/pending/x',
    '/api/shortcut/pendingx',
    '/api/shortcut/pending.json',
    '/api/shortcut//pending',
    '/api/shortcut/%70ending',
    '/api/shortcut%2Fpending',
    '/api/shortcut/pending%2F',
    '/api/shortcut/pending%00',
    '/API/shortcut/pending',
    '/api/Shortcut/Pending',
    '/api/shortcut/PENDING',
  ])('%s stays protected (getUser + redirect to sign-in)', async (p) => {
    const res = await proxy(new NextRequest(`${ORIGIN}${p}`, { method: 'POST' }))
    expect(h.getUser).toHaveBeenCalled()
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toMatch(/\/sign-in$/)
  })
})

function post(headers: Record<string, string>, body = '{"amount":120}') {
  return new Request(`${ORIGIN}${PATH}`, { method: 'POST', headers, body })
}

async function expectUniform401(res: Response) {
  expect(res.status).toBe(401)
  expect(res.headers.get('cache-control')).toBe('no-store, max-age=0')
  expect(res.headers.get('www-authenticate')).toBe('Bearer')
  expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' })
}

describe('route: no usable key → 401 before any query (#1536 F2, F8)', () => {
  it.each([
    ['no Authorization header', {}],
    ['empty Bearer', { authorization: 'Bearer ' }],
    ['wrong scheme', { authorization: `Basic ${KEY}` }],
    ['token without scheme', { authorization: KEY }],
    ['42-char body', { authorization: `Bearer ${KEY.slice(0, -1)}` }],
    ['44-char body', { authorization: `Bearer ${KEY}A` }],
    ['wrong prefix', { authorization: `Bearer fts_xx_${'A'.repeat(43)}` }],
    ['invalid character', { authorization: `Bearer fts_sk_${'A'.repeat(42)}+` }],
    ['two tokens', { authorization: `Bearer ${KEY} ${KEY}` }],
    ['key in a custom header only', { 'x-api-key': KEY }],
  ])('%s → 401, DB untouched', async (_label, headers) => {
    await expectUniform401(await route.POST(post({ 'content-type': 'application/json', ...headers })))
    expect(h.dbTouched).not.toHaveBeenCalled()
  })

  it('key only in the query string → 401, DB untouched', async () => {
    const res = await route.POST(new Request(`${ORIGIN}${PATH}?key=${KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"amount":1}',
    }))
    await expectUniform401(res)
    expect(h.dbTouched).not.toHaveBeenCalled()
  })

  it('key only in the body → 401, and the body is not read', async () => {
    const req = post({ 'content-type': 'application/json' }, JSON.stringify({ amount: 1, key: KEY }))
    await expectUniform401(await route.POST(req))
    expect(req.bodyUsed).toBe(false)
    expect(h.dbTouched).not.toHaveBeenCalled()
  })

  it('a session cookie alone → 401 (the cookie session is never consulted)', async () => {
    await expectUniform401(await route.POST(post({
      'content-type': 'application/json',
      cookie: 'sb-cxbnlahuhdvrbwcnzoqo-auth-token=base64-eyJhbGciOi',
    })))
  })
})

describe('route: methods and route config (#1536 F13)', () => {
  it('is force-dynamic', () => {
    expect(route.dynamic).toBe('force-dynamic')
  })

  it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)('%s → 405, Allow: POST, no-store', async (m) => {
    const res = route[m]()
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
    expect(res.headers.get('cache-control')).toBe('no-store, max-age=0')
    expect(h.dbTouched).not.toHaveBeenCalled()
  })

  it('exports nothing Next would reject as a route field', () => {
    const allowed = new Set(['dynamic', 'POST', 'GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    expect(Object.keys(route).filter((k) => !allowed.has(k))).toEqual([])
  })
})

describe('parseQuickAddJson — the body type gate (#1536 F5)', () => {
  it.each([
    [{ amount: 120 }, { amount: 120 }],
    [{ amount: '120' }, { amount: 120 }],
    [{ amount: '１,２００' }, { amount: 1200 }],
    [{ amount: 120, category: 'dining', note: '午餐' }, { amount: 120, category: 'dining', description: '午餐' }],
    [{ amount: 120, category: 'nope' }, { amount: 120 }],
    [{ amount: 120, category: '__proto__' }, { amount: 120 }],
    [{ amount: 120, category: 'settle' }, { amount: 120 }],
    [{ amount: 120, note: '  ' }, { amount: 120 }],
    [{ amount: 120, note: 'a‮b' }, { amount: 120, description: 'ab' }],
    [{ amount: 120, payer: 'x', group_id: 'y', user_id: 'z' }, { amount: 120 }],
    [{ amount: MAX_AMOUNT }, { amount: MAX_AMOUNT }],
  ])('%j → ok %j', (body, prefill) => {
    expect(parseQuickAddJson(body)).toEqual({ ok: true, prefill })
  })

  it.each([
    ['missing amount', {}],
    ['zero', { amount: 0 }],
    ['negative', { amount: -5 }],
    ['fraction', { amount: 1.5 }],
    ['over MAX_AMOUNT', { amount: MAX_AMOUNT + 1 }],
    ['unsafe integer', { amount: 2 ** 53 }],
    ['exponent string', { amount: '1e5' }],
    ['array amount', { amount: ['120'] }],
    ['object amount', { amount: { toString: '120' } }],
    ['boolean amount', { amount: true }],
    ['null amount', { amount: null }],
    ['number category', { amount: 1, category: 3 }],
    ['null category', { amount: 1, category: null }],
    ['array note', { amount: 1, note: ['x'] }],
    ['object note', { amount: 1, note: {} }],
    ['array body', [{ amount: 1 }]],
    ['null body', null],
    ['string body', '120'],
    ['number body', 120],
    ['inherited amount', Object.create({ amount: 120 })],
  ])('%s → invalid', (_l, body) => {
    expect(parseQuickAddJson(body)).toEqual({ ok: false })
  })

  it('the URL parser keeps its lenient behaviour (#1488 unchanged)', () => {
    expect(parseQuickAddHash('#add=expense&amount=abc&category=dining')).toEqual({ category: 'dining' })
  })
})

describe('Sentry scrub masks a shortcut key in text (#1536 F10)', () => {
  it('message, exception value and breadcrumb', () => {
    const event = {
      message: `request failed for ${KEY}`,
      exception: { values: [{ type: 'Error', value: `bad key ${KEY} here` }] },
      breadcrumbs: [{ message: `Authorization: Bearer ${KEY}` }],
    } as unknown as Event
    const out = JSON.stringify(scrubSentryEvent(event, {}))
    expect(out).not.toContain(KEY.slice(7))
    expect(out).toContain('fts_sk_[Filtered]')
  })

  it('a truncated key is masked too', () => {
    const out = JSON.stringify(scrubSentryEvent({ message: 'k=fts_sk_abc-_9' } as Event, {}))
    expect(out).not.toContain('abc-_9')
    expect(out).toContain('fts_sk_[Filtered]')
  })
})
