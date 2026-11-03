import { renderSVG } from 'uqr'
import type { Translations } from '@/lib/i18n/locales/zh-TW'
import type { Locale } from '@/lib/i18n/locales-meta'
import { QR_REDIRECT_PATH } from '@/lib/visitorPlatform'
import { AppStoreBadge } from './AppStoreBadge'
import { PlayStoreBadge } from './PlayStoreBadge'

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
  t: Pick<Translations['landing'], 'appStoreBadgeAlt' | 'playBadgeAlt' | 'downloadQrCaption' | 'downloadQrAlt'>
  locale: Locale
  className?: string
}

/**
 * Desktop (`md` and up) download block under the hero CTA row (#1906, layout
 * per Daphne): row 1 the App Store and Google Play badges side by side, row 2
 * a small card with a QR code that phones scan to reach their store.
 *
 * Server-rendered, QR included, so there is no client JS for it and no layout
 * shift. Hidden below `md` (the mobile hero keeps its own Play badge and the
 * device-aware CTA, #1413) and in both native shells before first paint via
 * `[html[data-native-shell]_&]:hidden` (`lib/playLaunch.ts`; Apple 3.1.1 and
 * 2.3.10). The iPad shell is wider than `md`, so the shell class is what keeps
 * it out of the iOS app there. Failure looks like: store badges showing inside
 * the iPad app, which only App Review would notice.
 */
export function DesktopDownloadBlock({ t, locale, className }: Props) {
  return (
    <div
      data-testid="desktop-download-block"
      className={`hidden md:block [html[data-native-shell]_&]:hidden ${className ?? ''}`.trim()}
    >
      <div className="flex items-center gap-2">
        <AppStoreBadge locale={locale} alt={t.appStoreBadgeAlt} />
        <PlayStoreBadge locale={locale} alt={t.playBadgeAlt} />
      </div>
      {/* mt-2 / p-2 (not mt-3 / p-2.5): 8 px tighter in every locale so ja's QR card fits a
          1440×900 first screen once the launch banner is gone (Daphne, #1919
          issuecomment-6612350572). */}
      <div className="mt-2 inline-flex items-center gap-3 p-2 rounded-xl border border-hairline bg-bg">
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
