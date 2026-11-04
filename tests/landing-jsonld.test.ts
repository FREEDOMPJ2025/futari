import { describe, it, expect } from 'vitest'
import { isValidElement, type ReactNode } from 'react'
import RootPage from '@/app/[locale]/page'
import { APP_STORE_URL, PLAY_STORE_URL } from '@/lib/visitorPlatform'
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales-meta'

// #1901 — the landing's SoftwareApplication JSON-LD must describe the native
// apps (no "PWA" wording) and link both stores. Walks the element tree that
// RootPage returns without rendering it, so no client components run.
function collectJsonLd(node: ReactNode, out: Record<string, unknown>[] = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectJsonLd(n, out))
  } else if (isValidElement(node)) {
    const props = node.props as {
      type?: string
      dangerouslySetInnerHTML?: { __html: string }
      children?: ReactNode
    }
    if (node.type === 'script' && props.type === 'application/ld+json' && props.dangerouslySetInnerHTML) {
      out.push(JSON.parse(props.dangerouslySetInnerHTML.__html))
    }
    collectJsonLd(props.children, out)
  }
  return out
}

describe('landing SoftwareApplication JSON-LD (#1901)', () => {
  it.each(SUPPORTED_LOCALES)('%s: native OS list and both store links', async (locale) => {
    const tree = await RootPage({ params: Promise.resolve({ locale }) })
    const app = collectJsonLd(tree).find((n) => n['@type'] === 'SoftwareApplication')
    expect(app).toBeDefined()
    expect(app!.operatingSystem).toBe('Web, iOS, Android')
    expect(String(app!.operatingSystem)).not.toMatch(/PWA/i)
    expect(app!.installUrl).toEqual([APP_STORE_URL, PLAY_STORE_URL])
    expect(app!.downloadUrl).toEqual([APP_STORE_URL, PLAY_STORE_URL])
    expect(PLAY_STORE_URL).toMatch(/^https:\/\/play\.google\.com\/store\/apps\/details\?id=/)
  })
})
