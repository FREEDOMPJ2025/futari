// #1674 — the kill switch for the web's basic service worker (`/sw-basic.js`).
//
// 'basic': signed-in web users who have NOT turned on offline browsing get a
//          worker that serves one self-contained offline page and caches no
//          ledger data.
// 'kill':  the rollback. The generated `/sw-basic.js` becomes a worker that
//          deletes its `offline-basic-*` caches and unregisters itself (it never
//          navigates or reloads clients), and every off path on the client runs
//          the full off and never registers `/sw-basic.js`.
//
// A plain revert is NOT a rollback: an installed worker survives a 404 on its
// own script and keeps answering navigations. Flip this constant instead, and
// ship it; the browsers' update check on the next navigation installs the kill
// worker. Both the generator (scripts/build-web-offline-basic.ts, run by
// `prebuild`) and the client (lib/offline/lifecycle.ts) import this file, so one
// line changes both sides.
//
// Keep this file import-free: Node runs the generator with native type
// stripping, which does not resolve `@/` paths.

export type SwBasicMode = 'basic' | 'kill'

export const SW_BASIC_MODE: SwBasicMode = 'kill'
