import type { Locale } from '@/lib/i18n/locales-meta'

/**
 * Futari launch celebration film on the public landing (#1910): 16:9, 17.2 s,
 * no voice, music only, Chinese captions burned into the picture. Shown under
 * the hero CTA on zh-TW only (the film is Chinese only); other locales render
 * nothing and emit no VideoObject.
 */
export function showsLaunchFilm(locale: Locale): boolean {
  return locale === 'zh-TW'
}

const DIR = '/videos/futari-launch'

/** Public paths (under `public/`). Don't re-encode or move these files. */
export const LAUNCH_FILM = {
  /** 1280×720 — phones (`PHONE_QUERY`). */
  src720: `${DIR}/futari-launch-film-zh-720p30.mp4`,
  /** 1920×1080 — everything else. */
  src1080: `${DIR}/futari-launch-film-zh-1080p30.mp4`,
  poster: `${DIR}/futari-launch-film-zh-poster.jpg`,
  /** zh-Hant subtitles for assistive tech; the captions are already burned in. */
  captions: `${DIR}/futari-launch-film-zh-Hant.vtt`,
} as const

/** Viewports that get the 720p file. */
export const PHONE_QUERY = '(max-width: 767px)'

/** The one file the <video> plays: 720p on a phone-width viewport, else 1080p. */
export function pickLaunchFilmSrc(isPhone: boolean): string {
  return isPhone ? LAUNCH_FILM.src720 : LAUNCH_FILM.src1080
}

/**
 * VideoObject name/description from Vera's videoobject.json (#1910). The name
 * doubles as the `<video>` aria-label; not an i18n string (the film is zh-Hant only).
 */
export const LAUNCH_FILM_NAME = 'Futari · 雙人記帳：iPhone 和 Android 都上架了'
export const LAUNCH_FILM_DESCRIPTION = 'iPhone 和 Android，現在都能一起記。不同手機，同一本帳。'

export function launchFilmJsonLd(appUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: LAUNCH_FILM_NAME,
    description: LAUNCH_FILM_DESCRIPTION,
    thumbnailUrl: `${appUrl}${LAUNCH_FILM.poster}`,
    contentUrl: `${appUrl}${LAUNCH_FILM.src1080}`,
    uploadDate: '2026-11-04',
    duration: 'PT17S',
    inLanguage: 'zh-Hant',
  }
}
