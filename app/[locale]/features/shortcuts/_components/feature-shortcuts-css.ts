/*
 * Page-only styles for /features/shortcuts (#1921), inlined and named the way
 * feature-outing-css.ts is, and kept out of brand-inner.ts so the other brand
 * pages' bytes do not change.
 *
 * No new tokens and no colour literals: every value is a var(--*) or a mix of
 * one, so the diagrams follow dark mode and the coming brand page (#1669).
 *
 * Motion rules (PRODUCT.md / DESIGN.md): transform and opacity only,
 * cubic-bezier(0.22, 1, 0.36, 1), at most 600 ms for any one move, nothing
 * bounces, nothing loops. The timeline is 4.6 s and runs once; with the 300 ms
 * fade in front of it a page that opens with this in view moves for 4.9 s, under
 * the 5 s that would call for a pause control (WCAG 2.2.2).
 *
 * Two failure modes this file is built around, both silent:
 * - The resting state of every animated element is its FINAL frame. Motion
 *   only applies when a script has set data-phase (flow) or
 *   data-reveal="armed" (cards). No script, or reduced motion, shows the
 *   finished picture; the reverse would leave blank boxes.
 * - The first frame is already on screen when the run starts, so only a replay,
 *   whose phone is new, fades it in. Fading it on the first run would drop what
 *   the reader is looking at to nothing for a moment.
 * - The @media (prefers-reduced-motion: reduce) block at the end strips every
 *   animation and undoes data-phase. A new rule added without a line there
 *   still moves for people who asked it not to.
 */
export const FS_NAMES = [
  'action',
  'amount',
  'base',
  'card',
  'cardPath',
  'cardRow',
  'cardTitle',
  'cat',
  'cats',
  'check',
  'ctl',
  'ctlBtn',
  'dashed',
  'desc',
  'field',
  'flow',
  'hot',
  'label',
  'layout',
  'mark',
  'mono',
  'phone',
  'phoneWrap',
  'reveal',
  'ring',
  'row',
  'rule',
  'save',
  'search',
  'searchIcon',
  'sheet',
  'sheetBar',
  'sheetBody',
  'step',
  'steps',
  'toggle',
  'toggleOn',
] as const
type Name = (typeof FS_NAMES)[number]

/** Class names as `fs.flow` etc., so JSX reads like a CSS module. */
export const fs = Object.fromEntries(FS_NAMES.map((n) => [n, `fs-${n}`])) as Record<Name, string>

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

export const FEATURE_SHORTCUTS_CSS = `.fs-layout {
  display: grid;
  gap: 24px;
}
@media (min-width: 640px) {
  .fs-layout {
    grid-template-columns: 264px minmax(0, 1fr);
    gap: 40px;
    align-items: center;
  }
}
.fs-phoneWrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.fs-phone {
  position: relative;
  width: 264px;
  max-width: 100%;
  height: 360px;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-card);
  background: var(--surface-alt);
}
.fs-base {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px 20px 96px;
  color: var(--ink);
}
.fs-check {
  display: block;
  width: 44px;
  height: 44px;
  color: var(--credit);
}
.fs-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-tile);
  background: var(--surface);
  color: var(--ink);
  opacity: 0.4;
}
.fs-action {
  position: absolute;
  left: 50%;
  bottom: 40px;
  width: max-content;
  max-width: calc(100% - 40px);
  padding: 10px 14px;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink);
  text-align: center;
  transform: translateX(-50%);
}
.fs-sheet {
  position: absolute;
  inset: 16px 0 0;
  border-top: 1px solid var(--hairline);
  border-radius: var(--radius-card) var(--radius-card) 0 0;
  background: var(--surface);
  color: var(--ink);
}
.fs-sheetBar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
  padding: 12px 14px 8px;
}
.fs-sheetBar > :first-child {
  color: var(--ink-3);
}
.fs-save {
  position: relative;
  justify-self: end;
  color: var(--accent-text);
}
.fs-ring {
  position: absolute;
  inset: -5px -8px;
  border: 2px solid var(--accent-fill);
  border-radius: var(--radius-tile);
}
.fs-amount {
  padding: 22px 16px 26px;
  border-bottom: 1px solid var(--hairline);
  text-align: center;
}
.fs-label {
  margin: 0;
  color: var(--ink-3);
}
.fs-desc {
  padding: 16px 20px;
  border-bottom: 1px solid var(--hairline);
}
.fs-sheetBody .fs-field {
  margin: 0;
}
.fs-cats {
  display: flex;
  gap: 8px;
  overflow: hidden;
  padding: 8px 0 0 16px;
}
.fs-cat {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 12px 0 6px;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink);
}
.fs-cat[data-on] {
  border-color: var(--ink);
  background: var(--ink);
  color: var(--on-fill);
}
.fs-mono {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  min-height: 22px;
  border-radius: 7px;
}
.fs-ctl {
  display: flex;
  justify-content: center;
  min-height: 36px;
}
.fs-ctlBtn {
  padding: 6px 12px;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink-2);
  cursor: pointer;
}
.fs-steps {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.fs-step {
  position: relative;
  padding-left: 16px;
  overflow-wrap: anywhere;
}
.fs-mark {
  position: absolute;
  top: 0.15em;
  bottom: 0.15em;
  left: 0;
  width: 3px;
  border-radius: 2px;
  background: var(--accent-fill);
  opacity: 0;
}
.fs-step:last-child .fs-mark {
  opacity: 1;
}
.fs-flow[data-phase='armed'] .fs-sheet {
  opacity: 0;
}
.fs-flow[data-phase='armed'] .fs-row,
.fs-flow[data-phase='fading'] .fs-row {
  opacity: 1;
}
.fs-flow[data-phase='armed'] .fs-action,
.fs-flow[data-phase='fading'] .fs-action {
  opacity: 0;
}
.fs-flow[data-phase='fading'] .fs-sheet {
  opacity: 0;
  transition: opacity 300ms ${EASE};
}
.fs-flow[data-phase='live'][data-replay] .fs-base {
  animation: fs-in 300ms ${EASE} both;
}
.fs-flow[data-phase='live'] .fs-row {
  animation: fs-dim 400ms ${EASE} 1200ms both;
}
.fs-flow[data-phase='live'] .fs-action {
  animation: fs-rise 400ms ${EASE} 1200ms both;
}
.fs-flow[data-phase='live'] .fs-sheet {
  animation: fs-sheet 500ms ${EASE} 2600ms both;
}
.fs-flow[data-phase='live'] .fs-amount > * {
  animation: fs-in 300ms ${EASE} 3100ms both;
}
.fs-flow[data-phase='live'] .fs-desc > * {
  animation: fs-in 300ms ${EASE} 3300ms both;
}
.fs-flow[data-phase='live'] .fs-field {
  animation: fs-in 300ms ${EASE} 3500ms both;
}
.fs-flow[data-phase='live'] .fs-ring {
  animation: fs-in 300ms ${EASE} 4100ms both;
}
.fs-flow[data-phase='live'] .fs-step:nth-child(1) .fs-mark {
  animation: fs-mark1 4600ms linear both;
}
.fs-flow[data-phase='live'] .fs-step:nth-child(2) .fs-mark {
  animation: fs-mark2 4600ms linear both;
}
.fs-flow[data-phase='live'] .fs-step:nth-child(3) .fs-mark {
  animation: fs-mark3 4600ms linear both;
}
.fs-flow[data-paused] * {
  animation-play-state: paused !important;
}
@keyframes fs-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes fs-dim {
  from { opacity: 1; }
  to { opacity: 0.4; }
}
@keyframes fs-rise {
  from { opacity: 0; transform: translate(-50%, 16px); }
  to { opacity: 1; transform: translateX(-50%); }
}
@keyframes fs-sheet {
  from { opacity: 0; transform: translateY(40px); }
  to { opacity: 1; transform: none; }
}
@keyframes fs-mark1 {
  0% { opacity: 0; }
  6.5% { opacity: 1; }
  56.5% { opacity: 1; }
  63% { opacity: 0; }
  100% { opacity: 0; }
}
@keyframes fs-mark2 {
  0%, 56.5% { opacity: 0; }
  63% { opacity: 1; }
  89.1% { opacity: 1; }
  95.7% { opacity: 0; }
  100% { opacity: 0; }
}
@keyframes fs-mark3 {
  0%, 89.1% { opacity: 0; }
  95.7% { opacity: 1; }
  100% { opacity: 1; }
}
.fs-card {
  max-width: 420px;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-tile);
  background: var(--surface-alt);
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.fs-cardPath,
.fs-cardTitle {
  margin: 0;
  padding: 10px 12px;
  border-bottom: 1px solid var(--hairline);
}
.fs-cardPath {
  color: var(--ink-3);
}
.fs-cardTitle {
  color: var(--ink);
}
.fs-search {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 400;
}
.fs-searchIcon {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  color: var(--ink-3);
}
.fs-cardRow {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0;
  padding: 10px 12px;
  border-bottom: 1px solid var(--hairline);
}
.fs-cardRow:last-child {
  border-bottom: 0;
}
.fs-hot::after {
  content: '';
  position: absolute;
  inset: 3px;
  border: 2px solid var(--accent-fill);
  border-radius: 8px;
  pointer-events: none;
}
.fs-toggle {
  position: relative;
  flex-shrink: 0;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background: var(--hairline);
}
.fs-toggle::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--surface);
}
.fs-toggleOn {
  background: var(--credit);
}
.fs-toggleOn::after {
  left: 16px;
}
.fs-dashed {
  flex-shrink: 0;
  width: 72px;
  height: 22px;
  border: 1px dashed var(--ink-3);
  border-radius: 999px;
}
.fs-reveal[data-reveal='armed'] .fs-hot::after {
  opacity: 0;
}
.fs-reveal[data-reveal='in'] .fs-hot::after {
  animation: fs-in 400ms ${EASE} both;
}
@media (prefers-reduced-motion: reduce) {
  .fs-flow *,
  .fs-flow *::after,
  .fs-reveal *::after {
    animation: none !important;
    transition: none !important;
  }
  .fs-flow[data-phase] .fs-sheet,
  .fs-flow[data-phase] .fs-action,
  .fs-reveal[data-reveal='armed'] .fs-hot::after {
    opacity: 1;
  }
  .fs-flow[data-phase] .fs-row {
    opacity: 0.4;
  }
}
`
