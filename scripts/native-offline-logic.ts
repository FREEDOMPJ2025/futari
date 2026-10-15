// #1672 — 殼內離線頁的自動重連規則，以及原生看門狗的升級規則（純函式）。
//
// 為什麼獨立成檔
// --------------
// 這些規則決定「會不會有一段看不見的載入」與「會不會無限彈跳」，失效時沒有任何
// 錯誤訊息（畫面空白，或離線頁與 app 來回閃）。所以它們是純函式，由
// `__tests__/nativeOfflineLogic.test.ts` 連同模擬器一起驗。
//
// 兩半：
// 1. `PAGE_LOGIC_SOURCE`：離線頁 inline script 用的 ES5 原始碼（字串）。離線頁是
//    自我包含的單一 HTML，沒有 bundler，所以以字串烤進去；測試用 `new Function`
//    取出同一份函式來跑，因此測到的就是出貨的那份。
// 2. `watchdogTimeoutMs` 等：原生看門狗的規則。Java
//    （android/.../FutariWebViewClient.java）與 Swift
//    （ios/App/App/FutariBridgeViewController.swift）各自鏡射一份，數值與條件必須
//    與這裡逐條一致；改這裡就要改那兩邊。

// ---- 1. 離線頁（瀏覽器端，ES5）-------------------------------------------

export const PAGE_LOGIC_SOURCE = `
var PROBE_ABORT_MS = [4000, 8000, 16000, 30000];
var PROBE_INTERVAL_MS = 5000;
var FAILED_RETURN_WINDOW_MS = 120000;
var MAX_FAILED_RETURNS = 2;

// 第 attempt 次（0 起算）探測的逾時：4 → 8 → 16 → 30 秒，之後維持 30 秒。
function probeAbortMs(attempt) {
  return PROBE_ABORT_MS[Math.min(Math.max(attempt, 0), PROBE_ABORT_MS.length - 1)];
}

// 進入離線頁時更新「失敗的自動返回」次數。距離上一次自動返回不到 120 秒就又回到
// 這裡，代表上次返回沒成功（探測通了、真正的頁面卻沒回來，或 Android 把 5xx 轉成
// 錯誤頁）。離開超過 120 秒、或沒有上次紀錄，歸零。
function nextFailedReturns(prevFailed, lastAutoReturnAt, now) {
  if (!lastAutoReturnAt) return 0;
  var elapsed = now - lastAutoReturnAt;
  if (elapsed >= 0 && elapsed < FAILED_RETURN_WINDOW_MS) return (prevFailed || 0) + 1;
  return 0;
}

// 失敗達 2 次就不再自動返回，只剩手動按鈕。
function canAutoReturn(failedReturns) {
  return failedReturns < MAX_FAILED_RETURNS;
}
`

export interface PageLogic {
  probeAbortMs(attempt: number): number
  nextFailedReturns(prevFailed: number, lastAutoReturnAt: number | null, now: number): number
  canAutoReturn(failedReturns: number): boolean
  PROBE_INTERVAL_MS: number
  FAILED_RETURN_WINDOW_MS: number
  MAX_FAILED_RETURNS: number
}

export function loadPageLogic(): PageLogic {
  return new Function(
    `${PAGE_LOGIC_SOURCE}
     return { probeAbortMs, nextFailedReturns, canAutoReturn, PROBE_INTERVAL_MS, FAILED_RETURN_WINDOW_MS, MAX_FAILED_RETURNS };`,
  )() as PageLogic
}

// ---- 2. 原生看門狗規則（Java / Swift 鏡射）----------------------------------

/** 連續第 `consecutiveFires` 次（0 起算）載入的逾時：6 → 15 → 30 秒，之後維持 30 秒，永不關閉。 */
export function watchdogTimeoutMs(consecutiveFires: number): number {
  const steps = [6000, 15000, 30000]
  return steps[Math.min(Math.max(consecutiveFires, 0), steps.length - 1)]
}

/** 一個 server-origin 文件 commit 並顯示滿這麼久、期間沒有 fire，計數歸零。離線頁上的時間不算。 */
export const ESCALATION_RESET_SHOWN_MS = 60_000

/** 背景超過這麼久回來，計數歸零。 */
export const ESCALATION_RESET_BACKGROUND_MS = 5 * 60_000

export function shouldResetEscalationAfterShown(shownMs: number, firedSinceCommit: boolean): boolean {
  return !firedSinceCommit && shownMs >= ESCALATION_RESET_SHOWN_MS
}

export function shouldResetEscalationAfterBackground(backgroundMs: number): boolean {
  return backgroundMs > ESCALATION_RESET_BACKGROUND_MS
}
