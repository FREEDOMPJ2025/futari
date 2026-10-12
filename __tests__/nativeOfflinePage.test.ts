/**
 * #1225 — 護欄：殼內離線頁（`server.errorPath`）。
 *
 * 這頁只有在「原生殼 + 沒網路 + 冷啟動」時才會被讀到，所以它壞掉的時候沒有任何
 * 紅燈：web 部署全綠、`cap sync` 成功、Sentry 收不到（那個情境根本沒有 JS 在跑）。
 * 唯一能在 CI 抓到的時機就是這裡，所以檢查的是「三個檔案有沒有對齊」與「產物有沒有
 * 依賴網路」，而不是渲染結果好不好看。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ANDROID_OFFLINE_HINT_ENABLED,
  OFFLINE_PAGE_FILENAME,
  PROD_SERVER_URL,
  WEB_DIR,
  renderOfflinePage,
  resolveServerUrl,
} from '../scripts/build-native-offline-page.ts'
import { SUPPORTED_LOCALES } from '../lib/i18n/locales-meta'
import { zhTW } from '../lib/i18n/locales/zh-TW'
import { zhCN } from '../lib/i18n/locales/zh-CN'
import { en } from '../lib/i18n/locales/en'
import { ja } from '../lib/i18n/locales/ja'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { FutariMark } from '../components/FutariMark'
import { LANTERN_PARTS } from '../lib/lanternMark'

const repoRoot = resolve(__dirname, '..')
const capacitorConfig = readFileSync(resolve(repoRoot, 'capacitor.config.ts'), 'utf8')
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> }

const html = renderOfflinePage(PROD_SERVER_URL)

describe('native offline page — 與 capacitor.config.ts 對齊', () => {
  it('errorPath 指向產生出來的檔名', () => {
    expect(capacitorConfig).toContain(`errorPath: '${OFFLINE_PAGE_FILENAME}'`)
  })

  it('webDir 就是 script 寫入的目錄', () => {
    expect(capacitorConfig).toContain(`webDir: '${WEB_DIR}'`)
  })

  it('重試按鈕的預設目的地與 shell 載入的 prod URL 同一個', () => {
    // 兩邊各自寫死（見 script 檔頭：不跨 Capacitor CLI 的 loader 邊界 import），
    // 所以改了其中一個而忘了另一個，症狀是「重試按鈕把人帶到舊網址」。
    expect(capacitorConfig).toContain(`const PROD_SERVER_URL = '${PROD_SERVER_URL}'`)
  })

  it('cap copy 之前一定會重新產生這個檔', () => {
    // `cap copy` 每次都會砍掉並重建原生的 public/，所以檔案不能只產生一次。
    expect(packageJson.scripts['capacitor:copy:before']).toBeTruthy()
    expect(packageJson.scripts['cap:offline-page']).toContain(
      'scripts/build-native-offline-page.ts',
    )
  })
})

describe('native offline page — 自我包含', () => {
  it('沒有外部樣式表或外部 script', () => {
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/<script[^>]+\bsrc\s*=/i)
    expect(html).not.toMatch(/@import/i)
  })

  it('唯一的絕對網址是 serverUrl 與探測目標 serverUrl + "/"（#1672）', () => {
    const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0])
    expect(new Set(urls)).toEqual(new Set([PROD_SERVER_URL, `${PROD_SERVER_URL}/`]))
  })

  it('CAP_SERVER_URL override 也會帶進重試目的地（#990 的 dev 殼）', () => {
    expect(resolveServerUrl({ CAP_SERVER_URL: 'http://localhost:3000' })).toBe(
      'http://localhost:3000',
    )
    expect(resolveServerUrl({})).toBe(PROD_SERVER_URL)
    expect(renderOfflinePage('http://localhost:3000')).toContain(
      'href="http://localhost:3000"',
    )
  })
})

describe('native offline page — 品牌提燈（#1423）', () => {
  // 離線頁曾留著手寫的舊檯燈 SVG，品牌換成提燈兩週都沒人發現（沒有任何紅燈）。
  const svg = html.match(/<svg class="lamp"[\s\S]*?<\/svg>/)?.[0] ?? ''

  it('SVG 含 FutariMark 的每一條提燈路徑／矩形', () => {
    expect(svg).not.toBe('')
    const ds = LANTERN_PARTS.map((p) => p.attrs.d).filter(Boolean)
    expect(ds.length).toBe(3)
    for (const d of ds) expect(svg).toContain(`d="${d}"`)
    expect(svg.match(/<rect /g)).toHaveLength(2)
  })

  it('FutariMark 與離線頁渲染出同一組形狀屬性', () => {
    const react = renderToStaticMarkup(createElement(FutariMark))
    const geometry = (m: string, skip: number) =>
      [...m.matchAll(/(?<![-\w])(?:d|x|y|width|height|rx|stroke-width)="([^"]+)"/g)].map((x) => x[1]).slice(skip)
    // react 先略過 <svg width/height>（FutariMark 的 size）；離線頁的 svg 尺寸走 CSS
    expect(geometry(svg, 0).join('|')).toBe(geometry(react, 2).join('|'))
  })

  it('舊檯燈的路徑已移除', () => {
    expect(svg).not.toContain('M19 9 H29 L36 25 H12 Z')
    expect(svg).not.toContain('viewBox="0 0 48 48"')
  })
})

describe('native offline page — 四語', () => {
  const dictionaries = {
    'zh-TW': zhTW.nativeOfflinePage,
    'zh-CN': zhCN.nativeOfflinePage,
    en: en.nativeOfflinePage,
    ja: ja.nativeOfflinePage,
  }

  it('支援語系與 app 的 SUPPORTED_LOCALES 一致', () => {
    // 加了第五語卻沒動這個檔，症狀不是缺字，是那個語系的使用者看到**整頁空白**
    // （CSS 只讓對得上 <html lang> 的區塊顯示）。
    expect(Object.keys(dictionaries).sort()).toEqual([...SUPPORTED_LOCALES].sort())
  })

  for (const [locale, copy] of Object.entries(dictionaries)) {
    it(`${locale}：文案有烤進 HTML，且有對應的顯示規則`, () => {
      for (const text of [copy.title, copy.body, copy.retry, copy.status, copy.stalled]) {
        expect(html).toContain(text)
      }
      expect(html).toContain(`data-l="${locale}"`)
      expect(html).toContain(`html[lang="${locale}"] [data-l="${locale}"]`)
      expect(html).toContain(JSON.stringify(copy.documentTitle).slice(1, -1))
    })

    it(`${locale}：文案沒有驚嘆號（品牌文案準則）`, () => {
      for (const text of [
        copy.title,
        copy.body,
        copy.retry,
        copy.status,
        copy.stalled,
        copy.offlineBrowsingHint,
      ]) {
        expect(text).not.toMatch(/[!！]/)
        expect(text).not.toMatch(/管理|追蹤|监控|監控|追踪/)
      }
    })
  }
})

describe('native offline page — Android 離線瀏覽提示（旗標預設關）', () => {
  it('預設不出貨：HTML 裡沒有任何一語的提示文字', () => {
    for (const copy of [zhTW, zhCN, en, ja].map((d) => d.nativeOfflinePage)) {
      expect(html).not.toContain(copy.offlineBrowsingHint)
    }
    expect(ANDROID_OFFLINE_HINT_ENABLED).toBe(false)
    expect(html).not.toContain('class="hint"')
  })

  it('旗標打開：四語都烤進去，且只在 data-android 分支顯示', () => {
    const on = renderOfflinePage(PROD_SERVER_URL, { androidOfflineHint: true })
    for (const copy of [zhTW, zhCN, en, ja].map((d) => d.nativeOfflinePage)) {
      expect(on).toContain(copy.offlineBrowsingHint)
    }
    expect(on).toContain('.hint { display: none; }')
    expect(on).toContain('html[data-android="1"] .hint { display: block; }')
    expect(on).toContain('/Android/.test(navigator.userAgent')
  })
})

describe('native offline page — 自動返回的硬化（#1672）', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const controller = scripts[scripts.length - 1]

  it('controller 在 body 之後，且與語系挑選是不同的 script', () => {
    expect(scripts).toHaveLength(2)
    expect(html.indexOf(controller)).toBeGreaterThan(html.indexOf('</main>'))
  })

  it('從不讀 location.search / hash，也不讀 document.URL 之類的外部輸入', () => {
    for (const script of scripts) {
      expect(script).not.toMatch(/location\.(search|hash|href|pathname)/)
      expect(script).not.toMatch(/document\.(URL|referrer|cookie)/)
    }
  })

  it('不寫 innerHTML / outerHTML / insertAdjacentHTML / eval，文字只來自烤好的區塊', () => {
    for (const script of scripts) {
      expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/)
    }
  })

  it('沒有 inline 事件屬性，按鈕用 addEventListener', () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(controller).toContain("addEventListener('click'")
  })

  it('離開頁面的目的地只有 serverUrl；探測請求的選項固定', () => {
    expect(controller).toContain('location.replace(SERVER)')
    expect(controller.match(/location\.replace\(/g)).toHaveLength(1)
    expect(controller).toContain('var SERVER = "https://futari.southern-light.dev";')
    expect(controller).toContain('var PROBE_URL = "https://futari.southern-light.dev/";')
    expect(controller).toContain(
      "{ mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }",
    )
  })

  it('serverUrl 帶斜線結尾也不會變成 //', () => {
    const page = renderOfflinePage('http://localhost:3999/')
    expect(page).toContain('var PROBE_URL = "http://localhost:3999/";')
  })
})

describe('native offline page — 依裝置語系挑語言', () => {
  // 頁面上唯一的邏輯。它挑錯的樣子不是報錯，是日文使用者看到中文；它整段沒跑的
  // 樣子是所有人都看到 zh-TW（<html lang> 的靜態預設值）。
  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)![1]

  function runPicker(languages: readonly string[]): string {
    document.documentElement.lang = 'zh-TW'
    Object.defineProperty(window.navigator, 'languages', {
      value: languages,
      configurable: true,
    })
    Object.defineProperty(window.navigator, 'language', {
      value: languages[0] ?? '',
      configurable: true,
    })
    new Function(inlineScript)()
    return document.documentElement.lang
  }

  it.each([
    [['zh-TW'], 'zh-TW'],
    [['zh-Hant-TW'], 'zh-TW'],
    [['zh-HK'], 'zh-TW'],
    [['zh-Hant'], 'zh-TW'],
    [['zh-CN'], 'zh-CN'],
    [['zh-Hans-CN'], 'zh-CN'],
    [['zh'], 'zh-CN'],
    [['ja-JP'], 'ja'],
    [['en-US'], 'en'],
    // 第一個對不上就往下找，全部對不上就留在預設語系。
    [['ko-KR', 'ja-JP'], 'ja'],
    [['ko-KR'], 'zh-TW'],
    [[], 'zh-TW'],
  ])('%j → %s', (languages, expected) => {
    expect(runPicker(languages)).toBe(expected)
  })

  it('挑中的語系也會換掉 document.title', () => {
    runPicker(['ja-JP'])
    expect(document.title).toBe(ja.nativeOfflinePage.documentTitle)
  })
})

describe('native offline page — controller 實際執行（#1672）', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const controller = scripts[scripts.length - 1]

  function makeStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial))
    return {
      data,
      getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    }
  }

  function run(opts: {
    storage: ReturnType<typeof makeStorage>
    fetchImpl: (url: string, init: Record<string, unknown>) => Promise<unknown>
  }) {
    document.documentElement.setAttribute('data-state', 'checking')
    document.body.innerHTML = '<a id="retry" href="x"></a>'
    const replace: string[] = []
    const fetched: string[] = []
    new Function('location', 'fetch', 'sessionStorage', controller)(
      { replace: (u: string) => replace.push(u) },
      (u: string, init: Record<string, unknown>) => {
        fetched.push(u)
        return opts.fetchImpl(u, init)
      },
      opts.storage,
    )
    return { replace, fetched }
  }

  it('探測通了：記下 lastAutoReturnAt，然後只 replace 到 serverUrl', async () => {
    const storage = makeStorage()
    const { replace, fetched } = run({ storage, fetchImpl: () => Promise.resolve({}) })
    await new Promise((r) => setTimeout(r, 0))
    expect(fetched).toEqual([`${PROD_SERVER_URL}/`])
    expect(replace).toEqual([PROD_SERVER_URL])
    expect(storage.data.has('futari.lastAutoReturnAt')).toBe(true)
  })

  it('已經失敗返回 2 次：不探測、不返回，顯示 stalled', async () => {
    const storage = makeStorage({
      'futari.failedReturns': '1',
      'futari.lastAutoReturnAt': String(Date.now() - 1000),
    })
    const { replace, fetched } = run({ storage, fetchImpl: () => Promise.resolve({}) })
    await new Promise((r) => setTimeout(r, 0))
    expect(fetched).toEqual([])
    expect(replace).toEqual([])
    expect(document.documentElement.getAttribute('data-state')).toBe('stalled')
  })

  it('離開超過 120 秒再進來：歸零，照常返回', async () => {
    const storage = makeStorage({
      'futari.failedReturns': '5',
      'futari.lastAutoReturnAt': String(Date.now() - 200_000),
    })
    const { replace } = run({ storage, fetchImpl: () => Promise.resolve({}) })
    await new Promise((r) => setTimeout(r, 0))
    expect(replace).toEqual([PROD_SERVER_URL])
    expect(storage.data.get('futari.failedReturns')).toBe('0')
  })

  it('沒有網路（fetch 立刻 reject）：不返回，也不寫 lastAutoReturnAt', async () => {
    const storage = makeStorage()
    const { replace } = run({ storage, fetchImpl: () => Promise.reject(new TypeError('offline')) })
    await new Promise((r) => setTimeout(r, 0))
    expect(replace).toEqual([])
    expect(storage.data.has('futari.lastAutoReturnAt')).toBe(false)
  })

  it('手動按「再試一次」：歸零並清掉 lastAutoReturnAt', async () => {
    const storage = makeStorage({ 'futari.failedReturns': '2', 'futari.lastAutoReturnAt': '1' })
    run({ storage, fetchImpl: () => new Promise(() => {}) })
    document.getElementById('retry')!.dispatchEvent(new Event('click'))
    expect(storage.data.get('futari.failedReturns')).toBe('0')
    expect(storage.data.has('futari.lastAutoReturnAt')).toBe(false)
  })

  it('sessionStorage 壞掉：寧可不自動返回', async () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {},
    }
    document.documentElement.setAttribute('data-state', 'checking')
    document.body.innerHTML = '<a id="retry"></a>'
    const replace: string[] = []
    new Function('location', 'fetch', 'sessionStorage', controller)(
      { replace: (u: string) => replace.push(u) },
      () => Promise.resolve({}),
      broken,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(replace).toEqual([])
    expect(document.documentElement.getAttribute('data-state')).toBe('stalled')
  })
})
