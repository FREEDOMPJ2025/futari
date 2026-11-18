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

/** React picks the prefixed event name in jsdom, which has no `animation` style. */
function finish(el: Element) {
  for (const type of ['animationend', 'webkitAnimationEnd']) {
    el.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { animationName: 'fs-mark3' }))
  }
}

function media() {
  return { matches: false, addEventListener: () => {}, removeEventListener: () => {} }
}

describe('ShortcutFlow', () => {
  it('watches an element that survives a replay', async () => {
    const observed: Element[] = []
    let report: (entry: { isIntersecting: boolean }) => void = () => {}
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) { report = (entry) => cb([entry]) }
      observe(el: Element) { observed.push(el) }
      disconnect() {}
    })
    window.matchMedia = media as unknown as typeof window.matchMedia

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<ShortcutFlow phone={<span />} steps={<span className="fs-mark" />} playLabel="Play" />)
    })
    await act(async () => { report({ isIntersecting: false }) })
    await act(async () => { report({ isIntersecting: true }) })
    expect(host.querySelector('.fs-flow')!.getAttribute('data-phase')).toBe('live')
    expect(host.querySelector('.fs-flow')!.hasAttribute('data-replay'), 'the first run keeps frame 1 up').toBe(false)

    await act(async () => {
      finish(host.querySelector('.fs-mark')!)
    })
    const play = host.querySelector('button')!
    expect(play.textContent).toBe('Play')
    await act(async () => { play.click() })

    expect(host.querySelector('.fs-flow')!.getAttribute('data-phase')).toBe('live')
    expect(host.querySelector('.fs-flow')!.hasAttribute('data-replay')).toBe(true)
    expect(observed).toHaveLength(1)
    expect(observed[0].isConnected, 'the observed element is still on the page').toBe(true)
    await act(async () => root.unmount())
    host.remove()
  })

  it('stops where the CSS already is when reduced motion comes on part-way', async () => {
    let change = () => {}
    const mq = { matches: false, addEventListener: (_: string, cb: () => void) => { change = cb }, removeEventListener: () => {} }
    window.matchMedia = (() => mq) as unknown as typeof window.matchMedia
    let report: (entry: { isIntersecting: boolean }) => void = () => {}
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) { report = (entry) => cb([entry]) }
      observe() {}
      disconnect() {}
    })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<ShortcutFlow phone={<span />} steps={<ol />} playLabel="Play" />)
    })
    await act(async () => { report({ isIntersecting: false }) })
    await act(async () => { report({ isIntersecting: true }) })
    expect(host.querySelector('.fs-flow')!.getAttribute('data-phase')).toBe('live')
    mq.matches = true
    await act(async () => { change() })
    expect(host.querySelector('.fs-flow')!.hasAttribute('data-phase')).toBe(false)
    expect(host.querySelector('button')).toBeNull()
    await act(async () => root.unmount())
    host.remove()
  })
})
