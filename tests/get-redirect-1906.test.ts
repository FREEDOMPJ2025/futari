// @vitest-environment node
/**
 * #1906 — `/get`, the desktop QR's UA redirect: iPhone/iPad and any
 * Macintosh UA → App Store (`ct=landing-qr`; iPadOS's default Safari UA says
 * Macintosh and a desktop Mac doesn't scan a QR, so a real Mac reaching the
 * App Store page is an accepted trade-off), Android → Google Play, everything
 * else (Windows/Linux desktop, no UA) → the landing;
 * 302, never cached, noindex; one server-side `landing_cta_clicked`
 * (`cta_location=qr`) per scan. The proxy lets it past the auth gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  captureServer: vi.fn(async () => {}),
  getUser: vi.fn(async () => ({ data: { user: null } })),
}))

vi.mock('@/lib/analytics/server', () => ({ captureServer: h.captureServer }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: h.getUser } })),
}))
// `after()` needs a live request scope; run the callback inline instead.
vi.mock('next/server', async (orig) => {
  const actual = await orig<typeof import('next/server')>()
  return { ...actual, after: (cb: () => unknown) => void cb() }
})

import { GET } from '@/app/get/route'
import { proxy } from '@/proxy'
import { PLAY_STORE_URL, QR_SCAN_BUCKET_ID, appStoreUrl, resolveQrRedirect } from '@/lib/visitorPlatform'

const ORIGIN = 'https://futari.southern-light.dev'

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipad:
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  // iPadOS default ("desktop website"): indistinguishable from a Mac by UA.
  ipadosDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  // Chrome on a real Mac: also sent to the App Store (accepted trade-off).
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
}

const hit = (ua?: string) =>
  GET(new NextRequest(`${ORIGIN}/get`, { headers: ua ? { 'user-agent': ua } : {} }))

beforeEach(() => {
  h.captureServer.mockClear()
  h.getUser.mockClear()
})

describe('/get redirect (#1906)', () => {
  it.each([
    ['iPhone', UA.iphone, appStoreUrl('landing-qr'), 'app_store'],
    ['iPad', UA.ipad, appStoreUrl('landing-qr'), 'app_store'],
    ['Android', UA.android, PLAY_STORE_URL, 'play_store'],
    ['iPadOS default Safari (Macintosh UA)', UA.ipadosDesktop, appStoreUrl('landing-qr'), 'app_store'],
    ['Chrome on a real Mac (accepted trade-off)', UA.macChrome, appStoreUrl('landing-qr'), 'app_store'],
    ['Windows desktop', UA.windows, `${ORIGIN}/`, 'landing'],
    ['Linux desktop', UA.linux, `${ORIGIN}/`, 'landing'],
    ['no UA', undefined, `${ORIGIN}/`, 'landing'],
  ])('%s → 302 to the right place, no-cache, noindex, one qr event', (_name, ua, location, target) => {
    const res = hit(ua)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(location)
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
    expect(res.headers.get('x-robots-tag')).toMatch(/noindex/)
    expect(res.headers.get('vary')).toMatch(/User-Agent/i)
    expect(h.captureServer).toHaveBeenCalledTimes(1)
    expect(h.captureServer).toHaveBeenCalledWith(QR_SCAN_BUCKET_ID, 'landing_cta_clicked', {
      cta_location: 'qr',
      target,
    })
  })

  it('App Store link keeps the provider token and swaps only the campaign', () => {
    const url = new URL(appStoreUrl('landing-qr'))
    expect(url.origin + url.pathname).toBe('https://apps.apple.com/app/id6779264784')
    expect(url.searchParams.get('pt')).toBe('128976951')
    expect(url.searchParams.get('mt')).toBe('8')
    expect(url.searchParams.get('ct')).toBe('landing-qr')
    expect(new URL(appStoreUrl('landing-desktop')).searchParams.get('ct')).toBe('landing-desktop')
  })

  it('resolveQrRedirect matches the iPod too', () => {
    expect(resolveQrRedirect('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)')).toBe('app_store')
  })
})

describe('proxy lets /get through (#1906)', () => {
  it('/get → no auth redirect, no locale rewrite, no getUser', async () => {
    const res = await proxy(new NextRequest(`${ORIGIN}/get`))
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
    expect(h.getUser).not.toHaveBeenCalled()
  })

  it.each(['/get/x', '/getx'])('%s stays behind the auth gate (exact match only)', async (p) => {
    const res = await proxy(new NextRequest(`${ORIGIN}${p}`))
    expect(h.getUser).toHaveBeenCalled()
    expect(res.status).toBe(307)
  })
})
