/**
 * #1921 - replaying the animation. `key` swaps the phone on every replay, so an
 * observer on the phone itself loses its target, reports off-screen and pauses
 * the run. Nothing errors: the animation just stands still.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ShortcutFlow } from '@/app/[locale]/features/shortcuts/_components/ShortcutFlow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.unstubAllGlobals())

describe('ShortcutFlow', () => {
  it('watches an element that survives a replay', async () => {
    const observed: Element[] = []
    let report: (entry: { isIntersecting: boolean }) => void = () => {}
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) { report = (entry) => cb([entry]) }
      observe(el: Element) { observed.push(el) }
      disconnect() {}
    })
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<ShortcutFlow phone={<span className="fs-ring" />} steps={<ol />} playLabel="Play" />)
    })
    await act(async () => { report({ isIntersecting: false }) })
    await act(async () => { report({ isIntersecting: true }) })
    expect(host.querySelector('.fs-flow')!.getAttribute('data-phase')).toBe('live')

    await act(async () => {
      // React picks the prefixed name in jsdom, which has no `animation` style.
      const ring = host.querySelector('.fs-ring')!
      ring.dispatchEvent(new Event('animationend', { bubbles: true }))
      ring.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true }))
    })
    const play = host.querySelector('button')!
    expect(play.textContent).toBe('Play')
    await act(async () => { play.click() })

    expect(host.querySelector('.fs-flow')!.getAttribute('data-phase')).toBe('live')
    expect(observed).toHaveLength(1)
    expect(observed[0].isConnected, 'the observed element is still on the page').toBe(true)
    await act(async () => root.unmount())
    host.remove()
  })
})
