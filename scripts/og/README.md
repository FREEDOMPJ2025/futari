# Futari OG image renderer

Renders the OG / social-share images for the Futari landing from a single
`template.html` source (Editorial direction — 「兩個人，**一本帳**。」).

## What gets generated

| File | Size | Where it goes | Use |
|---|---|---|---|
| `og-image.png` | 1200 × 630 | `public/og-image.png` | Default OG — zh-TW (referenced via `lib/i18n/seo.ts#ogImage`) |
| `og-image-en.png` | 1200 × 630 | `public/og-image-en.png` | English OG |
| `og-image-ja.png` | 1200 × 630 | `public/og-image-ja.png` | Japanese OG |
| `og-image-zh-CN.png` | 1200 × 630 | `public/og-image-zh-CN.png` | Simplified Chinese OG |
| `og-line.png` | 1200 × 600 | `public/og-line.png` | LINE Talk share image (slightly shorter aspect) |
| `og-square.png` | 1200 × 1200 | `public/og-square.png` | Instagram / Threads square preview |

Outputs write to `../../public/` (i.e. `oikos/public/`).

## How to run

```bash
cd scripts/og
npm install        # one-time — downloads Chromium via Puppeteer (~170 MB)
node render.mjs
```

Outputs:

```
✓ og-image.png    → /path/to/futari/public/og-image.png      (1200×630 px)
✓ og-line.png     → /path/to/futari/public/og-line.png       (1200×600 px)
✓ og-square.png   → /path/to/futari/public/og-square.png     (1200×1200 px)
```

## How it works

- `template.html` is a single self-contained renderer driven by URL query
  params (`?w=1200&h=630&s=1&layout=wide`). It loads Fraunces + Noto Sans TC
  from Google Fonts and sets `window.__OG_READY__ = true` after
  `document.fonts.ready` resolves.
- `render.mjs` opens each target in a fresh Puppeteer page, sets the
  viewport to the exact target size (with `deviceScaleFactor` for retina),
  waits for `__OG_READY__`, then screenshots a `clip` rect of exactly W×H
  CSS pixels. The PNG comes out at `W * dsr` × `H * dsr` actual pixels.

## Adjusting the design

Edit `template.html`. The wide layout uses `--s` (scale) so every dimension
scales proportionally — if you want bigger text on retina you can pass a
different `s` value, but the default `s=1` + `deviceScaleFactor=2` already
gives clean 2× output.

## Preview without rendering

Open `template.html?w=1200&h=630&s=1&layout=wide` directly in a browser to
preview the design without running the script.

## Store screenshots (App Store / Play)

The store assets live in this folder too, but write to `docs/store-assets/`,
not `public/`. Full workflow, language rules and file naming are in
[docs/store-assets/README.md](../../docs/store-assets/README.md); this is the
index.

| Script | What it does | Locale option |
|---|---|---|
| `capture-screens.mjs` | Device screenshots from the local dev server (needs a logged-in demo ledger) | `--locale=<zh-TW\|zh-CN\|en\|ja>` sets the app's `lang` cookie, switches to that locale's demo ledger (zh-CN/en/ja), writes to `screenshots/` (zh-TW) or `screenshots/<locale>/`, and records the plant's day count in `demo-data/<locale>.capture.json` |
| `render-store-screens.mjs` + `store-screens.html` | Illustration-first story images | `--locale=…`; fills the copy's `{name}` placeholders from `demo-data/`, refuses while one is missing; `proposal: true` copy renders with a one-line note; `pending` copy (none today) needs `--allow-pending-copy` and writes `*-DRAFT-*.png` |
| `seed-demo-ledgers.ts` | **Dev DB only.** Creates / removes the en, zh-CN, ja demo ledgers and switches which one the app shows; dry-run by default. Run from the repo root with `npx tsx` | `--locale=en,zh-CN,ja`; `--apply`, `--remove`, `--activate=<locale\|zh-TW>` |
| `demo-data.mjs` | Shared reader/writer for `demo-data/<locale>.json` and `.capture.json`, and the app's day count | — |
| `asc-screenshots.mjs` | Upload story images to App Store Connect; dry-run by default | Per ASC localization (`zh-Hant`, `zh-Hans`, `en-US`, `ja`); `--local` lists local files offline |
| `check-store-pngs.mjs` | Exact size per format + no alpha, for any PNG or folder | — |
| `store-locales.mjs` | Shared table: locale → file names, screenshot folder, ASC code | — |
| `render-store.mjs` + `store-graphic.html` | Play feature graphic, four locales | (renders all four) |

Every locale defaults to zh-TW, and the zh-TW output names are the same as
before #1904 (`story/0N-zh-<format>.png`, `screenshots/<name>-<format>.png`).

`render-store-screens.mjs` and `capture-screens.mjs` run `check-store-pngs.mjs`
on what they wrote. To check everything:

```bash
cd scripts/og
node check-store-pngs.mjs                 # docs/store-assets/story + screenshots, all locales
node asc-screenshots.mjs --local          # what each ASC localization would get, offline
```

Puppeteer uses the Chromium in `~/.cache/puppeteer`. If launching fails with
`spawn Unknown system error -88`, that copy was only partly unpacked (the
folder is a few hundred KB next to its `.zip`); point
`PUPPETEER_EXECUTABLE_PATH` at a complete Chromium instead.
