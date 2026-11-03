import { after, type NextRequest } from 'next/server'
import { captureServer } from '@/lib/analytics/server'
import {
  PLAY_STORE_URL,
  QR_SCAN_BUCKET_ID,
  appStoreUrl,
  resolveQrRedirect,
  type QrRedirectTarget,
} from '@/lib/visitorPlatform'

/**
 * `/get` — where the desktop landing's QR code points (#1906, Daphne's option
 * B). One QR for both phones: iPhone/iPad → App Store (`ct=landing-qr`, kept
 * apart from the desktop badge's `landing-desktop` in ASC), Android → Google
 * Play, anything else → the landing. See `resolveQrRedirect` for why an
 * iPadOS "Macintosh" UA lands on the landing rather than the App Store.
 *
 * Not localized (outside app/[locale]; proxy.ts lets it past the auth gate),
 * `noindex`, not in the sitemap, and never cached: the answer depends on the
 * User-Agent, so a shared cache serving one phone's redirect to another would
 * send Android users to the App Store. Failure looks like: a scan opening the
 * sign-in page (proxy auth gate) or the wrong store; nothing errors.
 *
 * Tracking: one server-side `landing_cta_clicked` (`cta_location=qr`) per
 * scan, under a shared anonymous bucket id like the auth callback's failure
 * bucket: the scanning phone has no PostHog identity yet (the landing's
 * client is cookieless), so only counts by `target` are meaningful, not
 * person-level maths. Sent in `after()` so the redirect isn't held up.
 */

export const dynamic = 'force-dynamic'

function destination(target: QrRedirectTarget, request: NextRequest): string {
  if (target === 'app_store') return appStoreUrl('landing-qr')
  if (target === 'play_store') return PLAY_STORE_URL
  return new URL('/', request.url).toString()
}

export function GET(request: NextRequest) {
  const target = resolveQrRedirect(request.headers.get('user-agent') ?? '')

  after(() => captureServer(QR_SCAN_BUCKET_ID, 'landing_cta_clicked', { cta_location: 'qr', target }))

  return new Response(null, {
    status: 302,
    headers: {
      Location: destination(target, request),
      'Cache-Control': 'no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
      Vary: 'User-Agent',
    },
  })
}
