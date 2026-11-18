import { renderSVG } from 'uqr'
import type { Translations } from '@/lib/i18n/locales/zh-TW'
import { HIDDEN_IN_APP } from '@/lib/playLaunch'
import { QR_REDIRECT_PATH } from '@/lib/visitorPlatform'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://futari.southern-light.dev'

/** Absolute URL the desktop QR encodes: the `/get` UA redirect (#1906). */
export const DOWNLOAD_QR_URL = new URL(QR_REDIRECT_PATH, APP_URL).toString()

/**
 * Generated once per server process: the URL is fixed, so there is nothing
 * per-request. Error correction M and a 4-module quiet zone (the QR spec's
 * minimum; uqr defaults to 1). uqr paints a white rect behind black modules
 * with literal colours, so the code stays black-on-white in dark mode too:
 * some scanners can't read an inverted QR.
 * `DOWNLOAD_QR_URL` is a build-time constant, never user input, so the markup
 * is safe for dangerouslySetInnerHTML.
 */
const DOWNLOAD_QR_SVG = renderSVG(DOWNLOAD_QR_URL, { ecc: 'M', border: 4 })

type Props = {
  t: Pick<Translations['landing'], 'downloadQrCaption' | 'downloadQrAlt'>
}

/**
 * Desktop (`md` and up) QR card under the hero's store-badge row (#1906,
 * layout per Daphne): a small card with a QR code that phones scan to reach
 * their store via `/get`. The badges themselves are #1930's row in
 * `Landing.tsx` (App Store + Google Play, one pair for every screen size);
 * this block adds only the QR card.
 *
 * Server-rendered, QR included, so there is no client JS for it and no layout
 * shift. Hidden below `md` (a phone has no use for a QR to itself), and, before
 * first paint, with the same pre-paint attributes the badges use
 * (`lib/playLaunch.ts`): in both native shells and installed PWAs
 * (`HIDDEN_IN_APP`; the iPad shell is wider than `md`), and in iPhone/iPad and
 * Android browsers (`data-visitor-platform`; a tablet that can open its own
 * store has no need to scan). These are the same classes the badges already
 * emit, so they add no CSS. Failure looks like: a QR card inside the iPad
 * app, which only App Review would notice.
 */
export function DesktopDownloadBlock({ t }: Props) {
  return (
    <div
      data-testid="desktop-download-block"
      className={`hidden md:block mt-2 ${HIDDEN_IN_APP} [html[data-visitor-platform=ios]_&]:hidden [html[data-visitor-platform=android]_&]:hidden`}
    >
      {/* mt-2 / p-2 (not mt-3 / p-2.5): 8 px tighter in every locale so ja's QR card fits a
          1440×900 first screen once the launch banner is gone (Daphne, #1919
          issuecomment-6612350572). */}
      <div className="inline-flex items-center gap-3 p-2 rounded-xl border border-hairline bg-bg">
        <div
          role="img"
          aria-label={t.downloadQrAlt}
          className="size-22 shrink-0 bg-white [&>svg]:block [&>svg]:size-full"
          dangerouslySetInnerHTML={{ __html: DOWNLOAD_QR_SVG }}
        />
        <p className="m-0 text-sm text-ink-2">{t.downloadQrCaption}</p>
      </div>
    </div>
  )
}
