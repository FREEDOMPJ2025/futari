import type { Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'
import { HIDDEN_IN_APP, landingPrePaintScript } from '@/lib/playLaunch'
import { appStoreUrlForCampaign } from '@/lib/visitorPlatform'
import { AppStoreBadge } from './AppStoreBadge'
import { PlayStoreBadge } from './PlayStoreBadge'

/**
 * The landing's store badge row (#1930) for the inner pages that point search
 * visitors at the apps (#1933: /migrate/<source>, /features/shortcuts). Same
 * badges, same device split (iPhone: App Store only; Android: Google Play
 * only; elsewhere both) and same hiding inside the native shells and installed
 * PWAs as the hero. The App Store link carries `ct=<campaign>` so ASC counts
 * the page apart from the landing; the Play link is the one `PLAY_STORE_URL`
 * (it has no campaign parameter anywhere in the app).
 *
 * Carries its own copy of the landing's pre-paint script: the device split and
 * the in-app hiding are decided by attributes on `<html>`, and on a full load
 * the hooks inside the badges only set them after hydration. Without the script
 * an iOS-shell visitor would see the badges until then (Apple 3.1.1), with no
 * error anywhere. The script is idempotent, so a client-side navigation from
 * the landing is fine too.
 */
export function StoreBadgeRow({ locale, campaign }: { locale: Locale; campaign: string }) {
  const t = dictionaries[locale].landing
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${HIDDEN_IN_APP}`}>
      <script dangerouslySetInnerHTML={{ __html: landingPrePaintScript() }} />
      <AppStoreBadge locale={locale} alt={t.appStoreBadgeAlt} href={appStoreUrlForCampaign(campaign)} />
      <PlayStoreBadge locale={locale} alt={t.playBadgeAlt} />
    </div>
  )
}
