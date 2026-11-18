import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import MigrateSourcePage from '@/app/[locale]/migrate/[source]/page'
import FeatureShortcutsPage from '@/app/[locale]/features/shortcuts/page'
import { MIGRATE_SOURCES } from '@/lib/migrate/sources'
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales-meta'
import { APP_STORE_URL, PLAY_STORE_URL, appStoreUrlForCampaign } from '@/lib/visitorPlatform'

const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'))

describe('#1933 store links on /migrate/* and /features/shortcuts', () => {
  it('appStoreUrlForCampaign only swaps ct', () => {
    expect(appStoreUrlForCampaign('web-x')).toBe(APP_STORE_URL.replace('ct=landing&', 'ct=web-x&'))
    expect(appStoreUrlForCampaign('web-x')).toContain('pt=128976951')
  })

  it('every migrate page links App Store with ct=web-migrate-<slug>, Play, and keeps the sign-in CTA', async () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const slug of Object.keys(MIGRATE_SOURCES)) {
        const el = await MigrateSourcePage({ params: Promise.resolve({ locale, source: slug }) })
        const links = hrefs(renderToStaticMarkup(el))
        expect(links).toContain(appStoreUrlForCampaign(`web-migrate-${slug}`))
        expect(links).toContain(PLAY_STORE_URL)
        expect(links.some((h) => h.includes('/sign-in') && h.includes(`from=${slug}`))).toBe(true)
      }
    }
  })

  it('shortcuts page links App Store with ct=web-shortcuts and Play, in every locale', async () => {
    for (const locale of SUPPORTED_LOCALES) {
      const el = await FeatureShortcutsPage({ params: Promise.resolve({ locale }) })
      const links = hrefs(renderToStaticMarkup(el))
      expect(links).toContain(appStoreUrlForCampaign('web-shortcuts'))
      expect(links).toContain(PLAY_STORE_URL)
    }
  })
})
