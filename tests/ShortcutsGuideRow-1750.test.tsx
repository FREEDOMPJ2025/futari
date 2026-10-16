import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

let locale = 'zh-TW'
vi.mock('@/lib/i18n/client', () => ({
  useTranslations: () => ({ settings: { shortcutsGuide: '用捷徑記帳' } }),
  useLocale: () => locale,
}))

import { ShortcutsGuideRow } from '@/app/(dashboard)/settings/_components/ShortcutsGuideRow'

function setNative(platform: 'android' | 'ios' | null) {
  if (platform === null) delete (window as { Capacitor?: unknown }).Capacitor
  else (window as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => platform }
}

afterEach(() => {
  cleanup()
  setNative(null)
  locale = 'zh-TW'
})

describe('ShortcutsGuideRow (#1750)', () => {
  it('links to the guide in the viewer locale (zh-TW unprefixed)', async () => {
    render(<ShortcutsGuideRow />)
    const link = await screen.findByRole('link', { name: /用捷徑記帳/ })
    expect(link.getAttribute('href')).toBe('/features/shortcuts')
    cleanup()
    locale = 'en'
    render(<ShortcutsGuideRow />)
    expect((await screen.findByRole('link')).getAttribute('href')).toBe('/en/features/shortcuts')
  })

  it('shows in the iOS shell', async () => {
    setNative('ios')
    render(<ShortcutsGuideRow />)
    expect(await screen.findByRole('link')).toBeTruthy()
  })

  it('is hidden in the Android shell (no Shortcuts app there)', async () => {
    setNative('android')
    render(<ShortcutsGuideRow />)
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull())
  })
})
