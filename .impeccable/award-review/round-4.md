# Round 4 — 2026-10-18

```
Round: 4   Rubric: v2   Overlay: .impeccable/award-rubric.md@e59ec03   Reviewer: fresh pilotfish:verifier (Playwright, bundled Chromium headless shell + WebKit, headless, no sign-in)
Build: origin/main e59ec03, production build served by `next start` on :3100; G1 over a local HTTP/2 TLS proxy on :3443
Gates: G1 pass  G2 pass  G3 pass  G4 pass (A2 carried)  G5 pass  WCAG manual pass (F1 2.4.7 still open)
D 6.83   U 6.92   C 6.92   T 7.88   Weighted 6.98   Min D 6.83   FAIL (score). All gates pass.
Δ vs round 3: D +0.25, U −0.25, C +0.58, T +0.13, weighted +0.15
```

Second consecutive round under +0.2, so the skill's plateau stop applied and the result went to the owner. Owner decision (2026-10-19): lower the weighted bar to 7.4 (rubric v2.1, see the overlay's decisions log) and do fixes 1–6 below before v1.8.0.

Evidence (screenshots `r4-shots/`, scripts `r4-scripts/`, Lighthouse JSON `lh-r4/`) was kept in the session scratchpad only.

## Gates

### G1 (Lighthouse 13.5, mobile, simulated throttling, HTTP/2, 1 warm-up + 10 runs per page) — pass

| page | perf | a11y | bp | seo | LCP median (max) | runs ≤2.5 s | CLS | TBT |
|---|---|---|---|---|---|---|---|---|
| /zh-TW | 99 | 100 | 100 | 100 | 2254 (2258) | 10/10 | 0.005 | 27 |
| sign-in | 99 | 100 | 100 | 100 | 1953 (2105) | 10/10 | 0.023 | 14 |
| use-case | 99 | 100 | 100 | 100 | 1953 | 10/10 | 0 | 13 |
| use-case/cohabitation | 99 | 100 | 100 | 100 | 1953 | 10/10 | 0 | 10 |
| migrate | 99 | 100 | 100 | 100 | 1953 (2026) | 10/10 | 0 | 12 |
| migrate/honeydue | 99 | 100 | 100 | 100 | 2103 | 10/10 | 0 | 27 |
| migrate/cwmoney | 98 | 100 | 100 | 100 | 2253 | 10/10 | 0 | 28 |

- **LCP is unimodal over HTTP/2.** Round 3's ~2.0 / ~4.2 s split does not appear. This confirms #1586: the bimodality came from HTTP/1.1 connection assignment that Lantern replays.
- **How it was served:** Vercel previews sit behind SSO, so headless Lighthouse can't reach them. The build was put behind a ~30-line Node `http2.createSecureServer` proxy with a self-signed certificate, and Chrome ran with `--ignore-certificate-errors`.
- **Caveat:** this is local, not prod. Landing and cwmoney have about 250 ms of margin.

### G2–G5 and WCAG manual

- **G2 pass.**
  - 7 pages × 2 viewports × Chromium and WebKit, plus CSV uploads on migrate (valid Honeydue, valid CWMoney, a garbage file).
  - 0 CSP violations, 0 console or page errors, 0 responses ≥ 400.
  - A1 still applies: brand pages send no CSP.
- **G3 pass.** `getAnimations()` is empty under reduced motion on every page, viewport and engine. In the landing's resting state the dots are hidden and the halos are fully lit.
- **G4 pass.** The point-of-light beat (#1527) runs at 59.9 fps median with 0 long tasks at 4× CPU, at both widths. The scroll-driven halos and lamps run at 59.9 fps. Only transform and opacity are animated. The `view()` timelines bind to the document scroller (0af2a67). A2 (sign-in fade overlapping hydration long tasks) is carried as an advisory.
- **G5 pass.** 0 overflow from 320 to 1920 px. Chromium was swept in 10 px steps, WebKit in 40 px steps.
- **WCAG manual pass.**
  - 2.4.11 is partial only (see F3). 2.5.8 passes on the spacing exception (A4).
  - 1.4.11: the default ring is 4.51:1. Text over the lamp peak is ≥ 4.96:1.
  - The no-JS render works on all 7 pages. Forced colors and landscape 844×390 work.

## Findings

- **F4 (P2, new; regression from #1724 / 654f3e7):** at ≥ 1024 px the outing row on `/use-case` is squeezed into the 240 px left rail. It measures 240×512 in zh-TW, 240×369 in en and 240×798 in ja, with the description wrapping one character per line.
  - Cause: the row's `s.band` section has no `<h2>`, so in the two-column `.bi-band` grid the lone `ul` lands in the heading column (`app/[locale]/use-case/page.tsx`).
  - `/migrate/splitwise` and `/use-case/travel` show the same thing.
  - Recheck: `a[href*="/features/outing"].bi-link` on `/{zh-TW,en,ja}/use-case` at 1024, 1280, 1440 and 1920 should be ≥ 700 px wide and ≤ 90 px tall.
- **F3 (P2; carried, upgraded from P3):** at 1024–1580 px the landing header 「一起記錄」 is mostly unclickable with a mouse.
  - Cause: the phone-mockup wrapper (`div.hidden.lg:block.absolute.right-[-8px].bottom-6.z-10`) wins hit-testing.
  - Clickable share of the CTA: 3–5 % at 1040–1400, 23 % at 1440, ≥ 98 % from 1600.
  - A centre click does not navigate at 1024, 1280 or 1440, in Chromium or WebKit.
  - Recheck: the clickable share is ≥ 95 % at every width from 1024 to 1920, and a centre click navigates at 1280 and 1440 in both engines.
- **F1 (P2, carried):** the CSV dropzone has no visible keyboard focus (2.4.7) on migrate/honeydue and cwmoney.
- **F2 (P3, carried):** zh-TW body and row text still breaks mid-word, because Chromium applies `word-break: auto-phrase` only to `ja`.
  - Landing: 8 breaks at 320, 2 at 390, 4 at 1440.
  - honeydue: 17 / 9 / 0.
  - sign-in: 11 / 7 / 5.
  - ja is clean.
- **Advisories:**
  - **A1 (P4):** no CSP on brand pages.
  - **A2 (P3):** the sign-in fade overlaps hydration long tasks.
  - **A3 (P4):** the brand focus ring is about 1.45:1, carried by the skip-link pill.
  - **A4 (P3):** 「下載轉換模板」 is 106×20 px.
  - **A5 (P3, new):** the light-dot beat doesn't render from 768 to 1279 px (3 emitters at 390–767, 0 at 768–1279, 3 at ≥ 1280).
  - **A6 (P3, new):** a non-CSV text file on the honeydue dropzone shows a preview 「1 筆紀錄 · 約 0 筆支出」 with the import CTA, instead of an error.

## Scores

"c" = carried, "rs" = re-scored at the same value.

| Check | R3 | R4 | Note |
|---|---|---|---|
| D1 World | 7.0 | 7.0 rs | Lamps behind three landing section heads; honeydue intro/CTA and landing migrate cards still white cards |
| D2 Type | 7.0 | 6.5 | F2 unchanged; F4 wraps one character per line at ≥ 1024 |
| D3 Colour & light | 7.0 | 7.5 | Lamps and halos stage the page in scroll order |
| D4 Composition | 6.5 | 6.0 | F4 strip at 1440; F3 overlap; awkward landscape hero crop |
| D5 Illustration | 6.5 | 7.0 | Light points leave the couple's phone into the ribbon |
| D6 Motion | 5.5 | 7.0 | One easing, compositor-only, full reduced-motion branch; landing only, small dots, none at 768–1279 |
| U1 Primary task | 7.5 | 7.0 | Hero CTA solid; header CTA dead at 1024–1580 (F3) |
| U2 Wayfinding | 7.5 | 7.5 c | |
| U3 Affordance | 7.0 | 6.5 | Pointer fails on the header CTA at common laptop widths |
| U4 A11y in use | 7.0 | 7.0 c | F1, A4 open |
| U5 Robustness | 6.5 | 6.0 | F4 layout break at 1440; no error state for an unreadable file (A6) |
| U6 Perceived perf | 7.5 | 7.5 rs | Unimodal LCP 1.95–2.25 s; local only |
| C1 Concept | 6.5 | 7.0 | Records-become-light is literal on landing |
| C2 Signature | 6.0 | 7.0 | One clear moment; subtle, plays once, missing at 768–1279 |
| C3 State | 6.0 | 6.5 | Light answers scroll; nothing driven by real state |
| C4 Domain | 7.0 | 7.0 c | |
| C5 Tech | 6.5 | 7.5 | Named view-timeline + animation-range inside `@supports` |
| C6 Overall | 6.0 | 6.5 | Landing has a moment; F3/F4 are desktop seams |
| T1 Voice | 8.0 | 8.0 c | |
| T2 Depth | 8.0 | 8.0 rs | #1801 preview stats faithful on valid files; A6 offsets |
| T3 Newcomer | 8.0 | 8.0 c | |
| T4 Media | 7.0 | 7.5 | Hero illustration is part of the story beat |

## Top fixes, ranked by weighted gain

| # | Fix | Checks it lifts | Est. gain |
|---|---|---|---|
| 1 | Make the signature stronger and wider. Dots more legible, rendered at 768–1279 (A5), plus one light-point beat on the inner pages. | C2, C1, C6, D6 | about +0.10 |
| 2 | Put the outing row back on the content rail (F4), on use-case, splitwise and travel. | D2, D4, U5 | about +0.09 |
| 3 | Let clicks reach the header CTA and clear the visual overlap (F3). | U1, U3, D4 | about +0.08 |
| 4 | De-card honeydue's intro/CTA and the landing migrate cards. | D1, D4 | about +0.05 |
| 5 | zh phrase segmentation for body and row text (F2). | D2 | about +0.03–0.07 |
| 6 | F1 focus ring, a 44 px template link, an error state for unreadable files (A6). | U4, U5 | about +0.03–0.04 |

Fixes 1–6 together come to about 7.35–7.40.

## Owner questions

- **U1 on phones (open):** should U1 be worded per platform?
- **en sign-in (open):** dev-log entries show in zh-TW, and the "losing track" idiom is still there.
- **A1:** is having no CSP on brand pages acceptable?
- **A5:** are the missing dots at 768–1279 intended? *Answered 2026-10-19: no. Fix 1 includes those widths.*
- **A6:** should an unreadable CSV show an error? *Answered 2026-10-19: yes, in S1.*
