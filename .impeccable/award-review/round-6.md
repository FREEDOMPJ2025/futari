# Round 6 — 2026-10-19

```
Round: 6   Rubric: v2.1 (pass = weighted ≥ 7.4, every dimension ≥ 7.0, all gates)   Overlay: .impeccable/award-rubric.md@68017d2
Reviewer: fresh pilotfish:verifier (Playwright, Chromium headless + WebKit, headless, no sign-in)
Build: origin/main 68017d2, production `next start` on :3100; G1 over a local HTTP/2 proxy on :3443
Gates: G1 pass  G2 pass  G3 pass  G4 pass  G5 pass  WCAG manual pass
D 7.50   U 7.50   C 7.08 (7.0833)   T 7.88 (7.875)   Weighted 7.4542   Min dimension C 7.08
PASS: weighted 7.4542 ≥ 7.4, every dimension ≥ 7.0, all gates pass.
Δ vs round 5: D +0.17, U ±0, C ±0, T ±0, weighted +0.0667 (7.3875 → 7.4542)
```

Only one change landed between rounds 5 and 6: PR #1814, independently verified. It did two things:

- **N1.** The desktop phone mock now appears from 1280 px, up from 1024. At 1024–1279 the illustration shows in full, and the dots rise from the couple's phone.
- **Watermark.** The faint 520 px FutariMark watermark is removed, an owner decision.

D4 and D5 were re-scored up. Every other check is carried or re-scored at the same value. Either re-score on its own gives 7.4208, which still passes.

**Owner decision (2026-10-19):** close the award work at round 6. The remaining polish goes to a follow-up issue for the v2.0.0 順心堂 visual redo.

The evidence stayed in the session scratchpad only: `r6-shots/`, `r6-scripts/` and `lh-r6/`.

## Gates

### G1 (Lighthouse 13.5, mobile, simulated throttling, HTTP/2, 1 warm-up + 10 runs per page) — pass

| page | perf | a11y | bp | seo | LCP median (max) | runs ≤ 2.5 s | CLS | TBT |
|---|---|---|---|---|---|---|---|---|
| /zh-TW | 99 | 100 | 100 | 100 | 2254 (2255) | 10/10 | 0.005 | 36 |
| sign-in | 100 | 100 | 100 | 100 | 1653 (1954) | 10/10 | 0.023 | 22 |
| use-case | 99 | 100 | 100 | 100 | 1952 (1953) | 10/10 | 0 | 22 |
| use-case/cohabitation | 99 | 100 | 100 | 100 | 1952 (2103) | 10/10 | 0 | 21 |
| migrate | 99 | 100 | 100 | 100 | 1953 (2024) | 10/10 | 0 | 33 |
| migrate/honeydue | 98 | 100 | 100 | 100 | 2253 (2404) | 10/10 | 0 | 39 |
| migrate/cwmoney | 98 | 100 | 100 | 100 | 2252 (2253) | 10/10 | 0 | 39 |

These are local runs, not prod. Re-measure on prod after the release: #1586 is the Lighthouse LCP follow-up.

### G2–G5 and WCAG manual

- **G2 pass.**
  - 7 pages × 2 viewports × Chromium and WebKit, plus the landing at 900, 1024, 1150, 1279, 1280 and 1440.
  - The CSV flow was also checked with valid, garbage, two-column and header-only files.
  - 0 CSP events, 0 errors, 0 responses ≥ 400.
- **G3 pass.** `getAnimations()` is empty everywhere, including the landing at 1024–1280.
- **G4 pass.**
  - The landing dot beat at 390, 1024, 1150, 1280 and 1440, and the inner ember scroll, all ran at 59.9 fps median with 0 long tasks at 4× CPU.
  - No dot overlaps the h1 or the CTA at any of those widths. At 1280, with the `max()` clamp gone, the dots still land inside the illustration.
- **G5 pass.** No overflow on all 7 pages: Chromium every 10 px from 320 to 1920, WebKit every 40 px.
- **WCAG manual pass.**
  - Every Tab stop has a visible ring except the Ko-fi iframe (A8). The ink rings measure 8.57–13.58:1.
  - 0 targets in `main` are under 44 px.
  - Text over the lamp peak is ≥ 4.96:1.
  - No-JS rendering works on all 7 pages.

## Findings

| Finding | Status | Evidence |
|---|---|---|
| N1 couple hidden at 1024–1279 | FIXED | The mock is `display:none` at 1024–1279 and the couple is visible at 1024, 1150 and 1279. At ≥ 1280 the mock covers ≤ 41 % of the illustration, in both engines |
| F3 header CTA | holds | ≥ 98 % clickable across 1024–1920, in both engines |
| S4 emitter invariant | holds | 3 emitters at all 166 Chromium widths and all 46 WebKit widths. The emitter type always matches whether the mock is shown |
| N2 (P3, new; existed before #1814) | open → follow-up | At 1280–1300 the tilted mock covers 51–60 % of the woman's head-to-shoulder region. That falls to 29 % at 1350 and ≤ 8 % from 1400. The N1 criterion still passes |
| A1 no CSP, A2 sign-in fade long tasks, A7 static ember in the dev-log summary, A8 Ko-fi iframe ring, A9 two-column CSV preview | carried | |

## Scores

"c" = carried, "rs" = re-scored at the same value.

| Check | R5 | R6 | Note |
|---|---|---|---|
| D1 World | 7.5 | 7.5 rs | Removing the watermark costs nothing. The table, dropzone and error box are still cards |
| D2 Type | 7.5 | 7.5 c | |
| D3 Colour & light | 7.5 | 7.5 rs | Closest to 8 |
| D4 Composition | 7.0 | **7.5** | Each breakpoint has its own composition; the N1 blocker is gone; −0.5 for N2 |
| D5 Illustration | 7.0 | **7.5** | The couple is intact below 1280 with the beat over it; −0.5 for the single artwork, little imagery on inner pages, and N2 |
| D6 Motion | 7.5 | 7.5 rs | The emitter switch stays in step with the mock |
| U1–U6 | 7.5 | 7.5 | Carried or re-scored at the same value; F3 holds |
| C1 Concept | 7.0 | 7.0 c | |
| C2 Signature | 7.5 | 7.5 rs | |
| C3 State | 6.5 | 6.5 c | Lowest check |
| C4 Domain | 7.0 | 7.0 c | |
| C5 Tech | 7.5 | 7.5 c | |
| C6 Overall | 7.0 | 7.0 rs | |
| T1–T3 | 8.0 | 8.0 c | |
| T4 Media | 7.5 | 7.5 rs | |

## Remaining polish (follow-up issue, v2.0.0)

1. **N2:** keep the woman visible at 1280–1300. D4 and D5, about +0.03.
2. **Bring the remaining cards into the world:** the comparison table, the dropzone and the error box. D1 and U5, about +0.06.
3. **Make the inner ember beat visible**, and give A7 a timeline. D6, C2 and C1, about +0.02–0.05.
4. **C3, the lowest check:** stage real state on the inner pages. About +0.02.
5. **ja phrase breaks at 320.** D2, about +0.03.

## Owner questions

- **Margin:** answered 2026-10-19. Accept the 0.054 margin and close at round 6.
- **N2:** answered. Accepted for now; it goes to the follow-up issue.
- **Still open:** U1 wording on phones, the en sign-in dev log and idiom, and A1 (no CSP on brand pages).
