/**
 * #1672 — 殼內看門狗 + 自我返回離線頁的規則。
 *
 * 失效的樣子：沒有任何錯誤。規則錯了，使用者看到的是「空白等很久」或「離線頁與
 * app 來回閃」。所以這裡除了逐條驗純函式，還用一個小模擬器把看門狗升級、離線頁探測
 * 排程、失敗返回上限接在一起跑，驗證計畫裡的有界結果。
 *
 * Java / Swift 鏡射的是 watchdogTimeoutMs 等規則（見 scripts/native-offline-logic.ts）；
 * 原生端沒有單元測試，改規則時要三處一起改，並跑計畫的 acceptance。
 */
import { describe, it, expect } from 'vitest'
import {
  ESCALATION_RESET_BACKGROUND_MS,
  ESCALATION_RESET_SHOWN_MS,
  isFragmentOnlyNavigation,
  loadPageLogic,
  shouldResetEscalationAfterBackground,
  shouldResetEscalationAfterShown,
  watchdogTimeoutMs,
} from '../scripts/native-offline-logic.ts'

const logic = loadPageLogic()
const INF = Number.POSITIVE_INFINITY

describe('離線頁：探測排程與失敗返回上限', () => {
  it('探測逾時 4 → 8 → 16 → 30 秒，之後維持 30 秒', () => {
    expect([0, 1, 2, 3, 4, 10].map(logic.probeAbortMs)).toEqual([4000, 8000, 16000, 30000, 30000, 30000])
  })

  it('固定 5 秒間隔、上限 2 次、視窗 120 秒', () => {
    expect(logic.PROBE_INTERVAL_MS).toBe(5000)
    expect(logic.MAX_FAILED_RETURNS).toBe(2)
    expect(logic.FAILED_RETURN_WINDOW_MS).toBe(120000)
  })

  it('120 秒內再次進入算一次失敗；超過或沒有紀錄歸零', () => {
    const now = 1_000_000
    expect(logic.nextFailedReturns(0, null, now)).toBe(0)
    expect(logic.nextFailedReturns(1, null, now)).toBe(0)
    expect(logic.nextFailedReturns(0, now - 1000, now)).toBe(1)
    expect(logic.nextFailedReturns(1, now - 119_999, now)).toBe(2)
    expect(logic.nextFailedReturns(1, now - 120_000, now)).toBe(0)
    expect(logic.nextFailedReturns(1, now - 500_000, now)).toBe(0)
    // 時鐘倒退不算失敗
    expect(logic.nextFailedReturns(1, now + 5000, now)).toBe(0)
  })

  it('失敗 2 次就不再自動返回', () => {
    expect(logic.canAutoReturn(0)).toBe(true)
    expect(logic.canAutoReturn(1)).toBe(true)
    expect(logic.canAutoReturn(2)).toBe(false)
    expect(logic.canAutoReturn(5)).toBe(false)
  })
})

describe('原生看門狗：升級與歸零', () => {
  it('6 → 15 → 30 秒，之後維持 30 秒，永不關閉', () => {
    expect([0, 1, 2, 3, 9].map(watchdogTimeoutMs)).toEqual([6000, 15000, 30000, 30000, 30000])
    expect(watchdogTimeoutMs(-1)).toBe(6000)
  })

  it('commit 後顯示滿 60 秒且沒有 fire 才歸零', () => {
    expect(ESCALATION_RESET_SHOWN_MS).toBe(60_000)
    expect(shouldResetEscalationAfterShown(59_999, false)).toBe(false)
    expect(shouldResetEscalationAfterShown(60_000, false)).toBe(true)
    expect(shouldResetEscalationAfterShown(120_000, true)).toBe(false)
  })

  it('背景超過 5 分鐘歸零', () => {
    expect(ESCALATION_RESET_BACKGROUND_MS).toBe(300_000)
    expect(shouldResetEscalationAfterBackground(300_000)).toBe(false)
    expect(shouldResetEscalationAfterBackground(300_001)).toBe(true)
  })
})

describe('原生看門狗：頁內錨點不啟動（#1680，只有 Swift 鏡射）', () => {
  const O = 'https://futari.example'

  it('case 1：首頁的錨點 #sec → 略過', () => {
    expect(isFragmentOnlyNavigation(`${O}/#sec`, `${O}/`, false)).toBe(true)
  })

  it('case 2：pushState 到 /b 之後，/b 上的錨點 → 略過（current 是 webView.url，不是啟動時的網址）', () => {
    expect(isFragmentOnlyNavigation(`${O}/b#sec`, `${O}/b`, false)).toBe(true)
  })

  it('case 3：/a#x → /a（拿掉 fragment 是真的重新載入）→ 啟動', () => {
    expect(isFragmentOnlyNavigation(`${O}/a`, `${O}/a#x`, false)).toBe(false)
  })

  it('case 4：/#x 上 reload → 啟動（即使網址帶 fragment）', () => {
    expect(isFragmentOnlyNavigation(`${O}/#x`, `${O}/#x`, true)).toBe(false)
  })

  it('case 5：跨頁導覽 → 啟動（含跨頁且帶 fragment）', () => {
    expect(isFragmentOnlyNavigation(`${O}/a`, `${O}/`, false)).toBe(false)
    expect(isFragmentOnlyNavigation(`${O}/a#sec`, `${O}/`, false)).toBe(false)
  })

  it('fragment 換成另一個 fragment（#x → #y）→ 略過', () => {
    expect(isFragmentOnlyNavigation(`${O}/a#y`, `${O}/a#x`, false)).toBe(true)
  })

  it('query 不同 → 啟動', () => {
    expect(isFragmentOnlyNavigation(`${O}/a?p=2#sec`, `${O}/a?p=1`, false)).toBe(false)
  })

  it('不同 origin（host / scheme / port）→ 啟動', () => {
    expect(isFragmentOnlyNavigation(`https://other.example/#sec`, `${O}/`, false)).toBe(false)
    expect(isFragmentOnlyNavigation(`http://futari.example/#sec`, `${O}/`, false)).toBe(false)
    expect(isFragmentOnlyNavigation(`${O}:8443/#sec`, `${O}/`, false)).toBe(false)
  })

  it('目前網址未知（nil）→ 啟動：寧可多盯一次，不要漏掉真正的載入', () => {
    expect(isFragmentOnlyNavigation(`${O}/#sec`, null, false)).toBe(false)
  })

  it('沒有 fragment 的同網址（重新導覽同一頁）→ 啟動', () => {
    expect(isFragmentOnlyNavigation(`${O}/a`, `${O}/a`, false)).toBe(false)
  })
})

/**
 * 端到端模擬（毫秒）。一輪：
 *   原生載入 → 主文件在 mainLatency 內回來就進 app；否則看門狗在 watchdogTimeoutMs(fires) fire，
 *   進離線頁（或 mainLatency === 'bounce'：Android 5xx，立刻進離線頁、不計 fire）。
 *   離線頁：先算失敗返回；到達上限就停。否則以 probe 排程探測，probeLatency 內回來就 replace。
 *   離線頁上的時間不計入看門狗歸零。
 */
type MainOutcome = number | 'bounce'
interface World {
  main: MainOutcome
  probe: number
  /** 探測要等網路才有結果：true 表示 probe 在 maxProbeWaitMs 內都不會通 */
}
interface Result {
  end: 'app' | 'stalled' | 'absent'
  fires: number
  autoReturns: number
  offlineRounds: number
  /** 每次載入所用的看門狗逾時 */
  timeouts: number[]
  elapsedMs: number
}

function simulate(world: World, maxLoads = 12, maxWaitMs = 10 * 60_000): Result {
  let t = 0
  let fires = 0
  let autoReturns = 0
  let rounds = 0
  let failedReturns = 0
  let lastAuto: number | null = null
  const timeouts: number[] = []
  for (let load = 0; load < maxLoads; load++) {
    const limit = watchdogTimeoutMs(fires)
    timeouts.push(limit)
    if (world.main !== 'bounce' && world.main <= limit) {
      return { end: 'app', fires, autoReturns, offlineRounds: rounds, timeouts, elapsedMs: t + world.main }
    }
    if (world.main === 'bounce') {
      t += 200
    } else {
      t += limit
      fires++
    }
    rounds++
    // 離線頁
    failedReturns = logic.nextFailedReturns(failedReturns, lastAuto, t)
    lastAuto = null
    if (!logic.canAutoReturn(failedReturns)) {
      return { end: 'stalled', fires, autoReturns, offlineRounds: rounds, timeouts, elapsedMs: t }
    }
    // 探測
    let attempt = 0
    const entered = t
    let returned = false
    while (t - entered < maxWaitMs) {
      const abort = logic.probeAbortMs(attempt)
      if (world.probe <= abort) {
        t += world.probe
        returned = true
        break
      }
      // 無窮大（網路不存在）：fetch 立刻 reject，不用等逾時；否則等滿逾時才 abort
      if (world.probe !== INF) t += abort
      t += logic.PROBE_INTERVAL_MS
      attempt++
    }
    if (!returned) {
      return { end: 'absent', fires, autoReturns, offlineRounds: rounds, timeouts, elapsedMs: t }
    }
    lastAuto = t
    autoReturns++
  }
  throw new Error('simulation did not terminate')
}

describe('端到端模擬（計畫的有界結果）', () => {
  it('9 秒回應者：最多一輪離線，第二次載入以 15 秒盯著，進 app', () => {
    const r = simulate({ main: 9000, probe: 9000 })
    expect(r.end).toBe('app')
    expect(r.fires).toBe(1)
    expect(r.offlineRounds).toBe(1)
    expect(r.timeouts).toEqual([6000, 15000])
  })

  it('20 秒回應者：最多兩輪離線，第三次以 30 秒盯著，進 app，逾時沒有退回 6 秒', () => {
    const r = simulate({ main: 20_000, probe: 20_000 })
    expect(r.end).toBe('app')
    expect(r.fires).toBe(2)
    expect(r.offlineRounds).toBe(2)
    expect(r.autoReturns).toBe(2)
    expect(r.timeouts).toEqual([6000, 15000, 30000])
  })

  it('探測立刻通、主文件永遠不回應：最多 2 次自動返回，每次載入都有看門狗，最後停在 stalled', () => {
    const r = simulate({ main: INF, probe: 0 })
    expect(r.end).toBe('stalled')
    expect(r.autoReturns).toBe(2)
    expect(r.fires).toBe(3)
    expect(r.timeouts).toEqual([6000, 15000, 30000])
    // 沒有任何一段空白超過目前的看門狗上限（≤ 30 秒）
    expect(Math.max(...r.timeouts)).toBeLessThanOrEqual(30_000)
  })

  it('完全沒有網路：第一次就在 6 秒出離線頁，且永不自動返回', () => {
    const r = simulate({ main: INF, probe: INF })
    expect(r.end).toBe('absent')
    expect(r.autoReturns).toBe(0)
    expect(r.fires).toBe(1)
    expect(r.timeouts[0]).toBe(6000)
  })

  it('5xx 彈跳（Android）：正好 2 次自動返回，然後 stalled，沒有 fire', () => {
    const r = simulate({ main: 'bounce', probe: 0 })
    expect(r.end).toBe('stalled')
    expect(r.autoReturns).toBe(2)
    expect(r.fires).toBe(0)
  })

  it('比 30 秒更慢的伺服器：探測（上限 30 秒）也通不過，留在離線頁，不會有無人看守的載入', () => {
    const r = simulate({ main: 45_000, probe: 45_000 })
    expect(r.end).toBe('absent')
    expect(r.autoReturns).toBe(0)
    expect(r.fires).toBe(1)
  })

  it('一般載入（5 秒內）從不出現離線頁', () => {
    const r = simulate({ main: 4000, probe: 0 })
    expect(r.end).toBe('app')
    expect(r.fires).toBe(0)
    expect(r.offlineRounds).toBe(0)
  })

  it('手動重試歸零：再給兩次機會', () => {
    // 手動重試等於 failedReturns = 0、lastAuto = null：下一次進入從 0 起算
    expect(logic.nextFailedReturns(0, null, 5_000_000)).toBe(0)
    expect(logic.canAutoReturn(logic.nextFailedReturns(0, null, 5_000_000))).toBe(true)
  })
})
