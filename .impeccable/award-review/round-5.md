# Round 5 — 2026-10-19

```
Round: 5   Rubric: v2.1 (pass = weighted ≥ 7.4, every dimension ≥ 7.0, all gates)   Overlay: .impeccable/award-rubric.md@58940c2
Reviewer: fresh pilotfish:verifier (Playwright, Chromium headless shell + WebKit, headless, no sign-in)
Build: origin/main d720b82, production `next start` on :3100; G1 over a local HTTP/2 proxy on :3443
Gates: G1 pass  G2 pass  G3 pass  G4 pass  G5 pass  WCAG manual pass
D 7.33   U 7.50   C 7.08   T 7.88   Weighted 7.39 (7.3875)   Min dimension C 7.08
FAIL (score), short by 0.0125. All gates pass, and every dimension is ≥ 7.0.
Δ vs round 4: D +0.50, U +0.58, C +0.17, T ±0, weighted +0.41 (6.98 → 7.39)
```

Between rounds 4 and 5, four PRs merged, each independently verified: S1 #1809, S2 #1811, S3 #1812 and S4 #1813. Every round-4 finding is now fixed or carried as an advisory. The reviewer did not move any score to reach the bar.

**Owner decision (2026-10-19):** don't count 7.3875 as 7.4. Fix N1 instead and score round 6. Evidence stays in the session scratchpad only (`r5-shots/`, `r5-scripts/`, `lh-r5/`).

## Gates

### G1 (Lighthouse 13.5, mobile, simulated throttling, HTTP/2, 1 warm-up + 10 runs per page) — pass

| page | perf | a11y | bp | seo | LCP median (max) | runs ≤ 2.5 s | CLS | TBT |
|---|---|---|---|---|---|---|---|---|
| /zh-TW | 99 | 100 | 100 | 100 | 2253 (2257) | 10/10 | 0.005 | 34 |
| sign-in | 100 | 100 | 100 | 100 | 1655 (1954) | 10/10 | 0.023 | 16 |
| use-case | 99 | 100 | 100 | 100 | 1953 (1956) | 10/10 | 0 | 12 |
| use-case/cohabitation | 99 | 100 | 100 | 100 | 1954 (1962) | 10/10 | 0 | 13 |
| migrate | 99 | 100 | 100 | 100 | 1953 (1956) | 10/10 | 0 | 12 |
| migrate/honeydue | 98 | 100 | 100 | 100 | 2253 (2259) | 10/10 | 0 | 28 |
| migrate/cwmoney | 98 | 100 | 100 | 100 | 2253 (2266) | 10/10 | 0 | 27 |

- honeydue went from 2103 to 2253 ms and now sits with landing and cwmoney, about 240 ms under the gate.
- These runs are local, not prod.

### G2–G5 and WCAG manual

- **G2 pass.** 7 pages × 2 viewports × Chromium and WebKit, plus the CSV flow: valid, garbage, two-column, header-only, empty and `.txt` files. 0 CSP events, 0 errors, 0 responses ≥ 400. A1 still applies: brand pages send no CSP.
- **G3 pass.** `getAnimations()` is empty everywhere. At rest, the landing dots are hidden, the halos are lit, and the inner embers are lit.
- **G4 pass.** All motion runs at 59.9 fps median with 0 long tasks at 4× CPU:
  - the landing dot beat at 390, 1024 and 1440;
  - the landing halos and lamps;
  - the inner ember beat on use-case, migrate, honeydue and sign-in.

  There are 3 emitters at every width from 320 to 1920, and a dot never overlaps the h1 or the CTA. Only opacity and transform are animated.
- **G5 pass.** No overflow on all 7 pages: Chromium every 10 px from 320 to 1920, WebKit every 40 px.
- **WCAG manual pass.**
  - Every Tab stop shows a ring: ink at 10–13.6:1, two-tone on ink-filled controls, and the dropzone outline at 10.93:1.
  - Forced-colors focus is visible.
  - 2.5.8: 0 targets under 44 px in `main`.
  - Text over the lamp peak is ≥ 4.96:1.
  - The pages render without JS, and landscape 844×390 works.

## Findings

### Round-4 rechecks

| Finding | Status | Evidence |
|---|---|---|
| F3 header CTA | FIXED | ≥ 98 % of the CTA is clickable from 1024 to 1920; a centre click navigates in both engines |
| F4 outing row | FIXED | Same box as the sibling `.bi-link` rows: 840 wide at ≥ 1280, 648 at 1024 (the content rail's own width) |
| F1 dropzone focus | FIXED | 2 px ink outline, 10.93:1 |
| F2 zh mid-word breaks | FIXED for zh | 0 in zh-TW (both engines) and zh-CN. ja has 4 at 320, the same as the S2 baseline |
| A1 no CSP | carried | |
| A2 sign-in fade long tasks | carried | |
| A3 brand ring contrast | resolved | |
| A4 template link | FIXED | 106×44 |
| A5 dots at 768–1279 | FIXED | |
| A6 unreadable file | FIXED | |

### New

- **N1 (P3; existed before this round):** at 1024–1279 px the phone mock covers 41–72 % of the hero illustration (72 % at 1024, 59 % at 1100, 52 % at 1150) and hides the couple. From 1280 up it covers ≤ 41 %. Recheck: the couple is visible at 1024 and coverage is ≤ 45 %.
- **A7 (P4):** the ember in sign-in's 「開發日誌」 `<summary>` is outside a `.bi-row` / `.bi-link` / `.bi-pill`. It has no timeline, so it stays statically lit.
- **A8 (P4):** the Ko-fi iframe is a Tab stop and shows no ring on the frame element.
- **A9 (P4, by design):** a two-column CSV with unknown headers still previews, because the signed-in wizard maps columns by hand.

## Scores

"c" = carried, "rs" = re-scored at the same value.

| Check | R4 | R5 | Note |
|---|---|---|---|
| D1 World | 7.0 | 7.5 | The honeydue intro/CTA and landing migrate rows are now hairline rows, and inner rows light up. Still cards: the comparison table, the dropzone, the error box |
| D2 Type | 6.5 | 7.5 | 0 zh mid-word breaks; F4 is gone; 4 ja breaks remain at 320 |
| D3 Colour & light | 7.5 | 7.5 rs | Dots read as *the* light; embers light the inner rows. This check is closest to 8 |
| D4 Composition | 6.0 | 7.0 | F3 and F4 are gone; new 768–1023 composition; sticky rail. Held back by N1 |
| D5 Illustration | 7.0 | 7.0 rs | N1 hides the couple at 1024–1150 |
| D6 Motion | 7.0 | 7.5 | One easing for the landing and inner beats, at every width. The inner beat is barely visible |
| U1 Primary task | 7.0 | 7.5 | Both CTAs work with a pointer at every width |
| U2 Wayfinding | 7.5 | 7.5 rs | Sticky heads at ≥ 1024 |
| U3 Affordance | 6.5 | 7.5 | Pointer, touch and keyboard all work; the error is announced |
| U4 A11y in use | 7.0 | 7.5 | F1, A3 and A4 fixed; forced colors works. No screen-reader pass |
| U5 Robustness | 6.0 | 7.5 | G5 clean, A6 error state, landscape and forced colors work. The error box is not styled in-world |
| U6 Perceived perf | 7.5 | 7.5 rs | |
| C1 Concept | 7.0 | 7.0 rs | |
| C2 Signature | 7.0 | 7.5 | Plays at every width and reads clearly; still plays once |
| C3 State | 6.5 | 6.5 c | |
| C4 Domain | 7.0 | 7.0 c | |
| C5 Tech | 7.5 | 7.5 rs | |
| C6 Overall | 6.5 | 7.0 | The desktop seams are gone |
| T1–T3 | 8.0 | 8.0 | carried, or re-scored at the same value |
| T4 Media | 7.5 | 7.5 rs | |

## Top fixes, ranked by weighted gain

Any one of these clears 7.4.

| # | Fix | Checks it lifts | Est. gain |
|---|---|---|---|
| 1 | Keep the couple visible at 1024–1150 (N1) | D4, D5, T4 | about +0.05–0.08 |
| 2 | Bring the comparison table, dropzone and error box into the world | D1, U5 | about +0.06 |
| 3 | Make the inner ember beat visible: a longer range or a larger glow, plus a timeline for the A7 row | D6, C2, C1 | about +0.02–0.05 |
| 4 | Fix the ja phrase breaks at 320 | D2 | about +0.03 |

## Owner questions

- **Bar rounding:** answered 2026-10-19. The owner chose to fix N1 rather than count 7.3875 as 7.4.
- **F4 recheck criterion:** from now on, recheck rows against their sibling rows' box rather than a fixed width.
- **U1 on phones, en sign-in dev log and idiom, A1 no CSP:** still open.
