import '@testing-library/jest-dom'

// #1860 — Node 25+ ships its own global `localStorage` / `sessionStorage`
// (Web Storage, on by default). Without `--localstorage-file` the getter
// returns `undefined`, and because the global already exists, vitest's jsdom
// environment does not copy jsdom's Storage over it. Failure looks like:
// `Cannot read properties of undefined (reading 'clear')` in every test that
// touches localStorage, only on Node ≥ 25 (CI pins .nvmrc, so CI stays green).
// Point both back at jsdom's window so every Node version tests the same thing.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom
if (dom) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    if (globalThis[key] !== dom.window[key]) {
      Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
    }
  }
}
