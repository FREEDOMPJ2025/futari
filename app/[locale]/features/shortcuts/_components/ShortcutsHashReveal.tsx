'use client'

import { useEffect } from 'react'

/** Open the target itself and every enclosing disclosure before scrolling. */
export function revealShortcutsHash() {
  if (!window.location.hash) return
  let id: string
  try {
    id = decodeURIComponent(window.location.hash.slice(1))
  } catch {
    return
  }
  const target = document.getElementById(id)
  if (!target) return
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) node.open = true
  }
  target.scrollIntoView()
}

export function ShortcutsHashReveal() {
  useEffect(() => {
    revealShortcutsHash()
    window.addEventListener('hashchange', revealShortcutsHash)
    return () => window.removeEventListener('hashchange', revealShortcutsHash)
  }, [])
  return null
}
