import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isValidElement, type ReactNode } from 'react'

vi.mock('@/lib/analytics/track', () => ({ track: () => {} }))
const getSession = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession } }),
}))

import RootPage from '@/app/[locale]/page'
import { Landing } from '@/app/[locale]/_landing/Landing'
import { LaunchFilm } from '@/app/[locale]/_landing/LaunchFilm'
import { LAUNCH_FILM, LAUNCH_FILM_NAME, PHONE_QUERY, pickLaunchFilmSrc, showsLaunchFilm } from '@/lib/launchFilm'
import { NATIVE_SHELL_ATTR } from '@/lib/playLaunch'
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n/locales-meta'
import { dictionaries } from '@/lib/i18n/t'

// #1910 — launch film under the landing hero CTA (zh-TW only, hidden in the shells).

const w = window as unknown as Record<string, unknown>
const html = () => document.documentElement

/** Captures observers so a test can fire an intersection by hand. */
let observers: { cb: IntersectionObserverCallback; options?: IntersectionObserverInit }[] = []
class FakeIO {
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    observers.push({ cb, options })
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
function intersect() {
  act(() => {
    for (const o of observers) {
      o.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    }
  })
}

beforeEach(() => {
  observers = []
  html().removeAttribute(NATIVE_SHELL_ATTR)
  getSession.mockResolvedValue({ data: { session: null } })
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})
afterEach(() => {
  cleanup()
  html().removeAttribute(NATIVE_SHELL_ATTR)
  delete w.Capacitor
  delete w.androidBridge
  delete w.webkit
  delete w.IntersectionObserver
  vi.unstubAllGlobals()
})

describe('launch film source by viewport (#1910)', () => {
  it('a phone-width viewport plays the 720p file, a wider one the 1080p file', () => {
    expect(pickLaunchFilmSrc(true)).toBe(LAUNCH_FILM.src720)
    expect(pickLaunchFilmSrc(false)).toBe(LAUNCH_FILM.src1080)
    expect(PHONE_QUERY).toBe('(max-width: 767px)')
  })

  it('mounts the 720p source when matchMedia reports a phone', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q === PHONE_QUERY,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    delete w.IntersectionObserver
    const { container } = render(<LaunchFilm />)
    const sources = container.querySelectorAll('video source')
    expect(sources).toHaveLength(1)
    expect(sources[0].getAttribute('src')).toBe(LAUNCH_FILM.src720)
  })
})

describe('showsLaunchFilm', () => {
  it('is true only for zh-TW', () => {
    expect(showsLaunchFilm('zh-TW')).toBe(true)
    for (const l of ['zh-CN', 'en', 'ja'] as const) expect(showsLaunchFilm(l)).toBe(false)
  })
})

describe('Landing renders the film only on zh-TW', () => {
  const renderLanding = (locale: Locale) => {
    const d = dictionaries[locale]
    return render(
      <Landing
        t={d.landing}
        locale={locale}
        showLaunchBanner={false}
        signInHref="/sign-in"
        dashboardHref="/dashboard"
        checkingLabel={d.signIn.signingIn}
        useCaseHrefs={{ cohabitation: '/a', newlyweds: '/b', petOwners: '/c', hub: '/d' }}
        migrateHrefs={{ honeydue: '/e', spendee: '/f', cwmoney: '/g', hub: '/h' }}
        featureOutingHref="/i"
        legalLinks={{ termsHref: '/t', termsLabel: 't', privacyHref: '/p', privacyLabel: 'p' }}
      />,
    )
  }

  it.each(SUPPORTED_LOCALES)('%s', (locale) => {
    const { container } = renderLanding(locale)
    const box = container.querySelector('[data-testid="launch-film"]')
    if (locale === 'zh-TW') {
      expect(box).not.toBeNull()
      // inside the hero copy column, after the Play badge
      expect(box!.closest('#landing-hero')).not.toBeNull()
    } else {
      expect(box).toBeNull()
      expect(container.querySelector('video')).toBeNull()
    }
  })
})

describe('LaunchFilm', () => {
  it('reserves a 16:9 box and mounts nothing before intersection, then the video after', () => {
    vi.stubGlobal('IntersectionObserver', FakeIO)
    const { container } = render(<LaunchFilm />)
    const box = container.querySelector('[data-testid="launch-film"]')!
    expect(box.className).toContain('aspect-video')
    expect(container.querySelector('video')).toBeNull()
    expect(container.innerHTML).not.toContain(LAUNCH_FILM.poster)
    expect(observers[0].options?.rootMargin).toBe('200px')
    intersect()
    expect(container.querySelector('video')).not.toBeNull()
  })

  it('mounts immediately when IntersectionObserver is missing', () => {
    delete w.IntersectionObserver
    const { container } = render(<LaunchFilm />)
    expect(container.querySelector('video')).not.toBeNull()
  })

  it('video attributes, sources and track', () => {
    delete w.IntersectionObserver
    const { container } = render(<LaunchFilm />)
    const v = container.querySelector('video')!
    expect(v.getAttribute('preload')).toBe('none')
    expect(v.muted).toBe(true)
    expect(v.hasAttribute('playsinline')).toBe(true)
    expect(v.hasAttribute('controls')).toBe(true)
    expect(v.hasAttribute('autoplay')).toBe(false)
    expect(v.autoplay).toBe(false)
    expect(v.hasAttribute('loop')).toBe(false)
    expect(v.getAttribute('poster')).toBe(LAUNCH_FILM.poster)
    expect(LAUNCH_FILM.poster).toMatch(/\.jpg$/)
    expect(v.getAttribute('aria-label')).toBe(LAUNCH_FILM_NAME)
    // matchMedia is stubbed to "not a phone" in beforeEach: one 1080p source.
    const sources = v.querySelectorAll('source')
    expect(sources).toHaveLength(1)
    expect(sources[0].getAttribute('src')).toBe(LAUNCH_FILM.src1080)
    expect(sources[0].getAttribute('type')).toBe('video/mp4')
    expect(sources[0].hasAttribute('media')).toBe(false)
    const track = v.querySelector('track')!
    expect(track.getAttribute('kind')).toBe('subtitles')
    expect(track.getAttribute('srclang')).toBe('zh-Hant')
    expect(track.getAttribute('src')).toBe(LAUNCH_FILM.captions)
    expect(track.hasAttribute('default')).toBe(false)
  })

  const shells: [string, () => void][] = [
    ['androidBridge', () => (w.androidBridge = {})],
    ['webkit.messageHandlers.bridge', () => (w.webkit = { messageHandlers: { bridge: {} } })],
    ['Capacitor.isNativePlatform()', () => (w.Capacitor = { isNativePlatform: () => true })],
  ]
  it.each(shells)('native shell (%s): hide variant, <html> marked, no video', (_name, setup) => {
    setup()
    delete w.IntersectionObserver
    const { container } = render(<LaunchFilm />)
    const box = container.querySelector('[data-testid="launch-film"]')!
    expect(box.className).toContain('[html[data-native-shell]_&]:hidden')
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(true)
    expect(container.querySelector('video')).toBeNull()
  })

  it('web Capacitor (isNativePlatform() false) still mounts the video', () => {
    w.Capacitor = { isNativePlatform: () => false }
    delete w.IntersectionObserver
    const { container } = render(<LaunchFilm />)
    expect(html().hasAttribute(NATIVE_SHELL_ATTR)).toBe(false)
    expect(container.querySelector('video')).not.toBeNull()
  })
})

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

describe('launch film VideoObject JSON-LD', () => {
  it.each(SUPPORTED_LOCALES)('%s', async (locale) => {
    const tree = await RootPage({ params: Promise.resolve({ locale }) })
    const video = collectJsonLd(tree).find((n) => n['@type'] === 'VideoObject')
    if (locale !== 'zh-TW') {
      expect(video).toBeUndefined()
      return
    }
    expect(video).toMatchObject({
      '@context': 'https://schema.org',
      name: LAUNCH_FILM_NAME,
      description: 'iPhone 和 Android，現在都能一起記。不同手機，同一本帳。',
      uploadDate: '2026-11-04',
      duration: 'PT17S',
      inLanguage: 'zh-Hant',
    })
    for (const key of ['thumbnailUrl', 'contentUrl'] as const) {
      expect(String(video![key])).toMatch(/^https?:\/\/[^/]+\/videos\/futari-launch\//)
    }
    expect(String(video!.thumbnailUrl).endsWith(LAUNCH_FILM.poster)).toBe(true)
    expect(String(video!.contentUrl).endsWith(LAUNCH_FILM.src1080)).toBe(true)
  })

  it('every referenced public file exists', () => {
    for (const p of Object.values(LAUNCH_FILM)) {
      expect(existsSync(join(process.cwd(), 'public', p)), p).toBe(true)
    }
  })
})
