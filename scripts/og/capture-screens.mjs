// 擷取商店螢幕截圖 —— 從本機 dev server 的實際畫面截，輸出到
// ../../docs/store-assets/screenshots/。
//
// 為什麼要獨立 profile：puppeteer 預設開全新瀏覽器，沒有登入狀態；
// 而本 app 只支援 Google / Apple OAuth，無法用程式取得 session。
// 所以用一個專用的 userDataDir，人工登入一次後重複使用。
//
//   cd scripts/og
//   node capture-screens.mjs --login       # 首次：開視窗，你手動登入
//   node capture-screens.mjs               # 之後：headless 截全部尺寸
//   node capture-screens.mjs --only=ipad-13  # 只補某一組，不動已驗過的圖
//   node capture-screens.mjs --locale=en     # 英文介面（#1904），輸出到 screenshots/en/
//
// --locale=<zh-TW|zh-CN|en|ja>（預設 zh-TW）：截圖前在 BASE 網域設定 app 的語系
// cookie `lang`（lib/i18n/locales-meta.ts LOCALE_COOKIE；dashboard 由
// lib/i18n/t.ts getLocale() 讀它，<html lang> 也來自它），截完把 cookie 還原成
// 原本的值。zh-TW 寫到 screenshots/ 本身（沿用 2026-08 起的路徑），其他語系寫到
// screenshots/<locale>/，檔名相同。路徑規則集中在 store-locales.mjs。
//
// zh-CN／en／ja 另外會切到該語系的示範帳本（seed-demo-ledgers.ts 建的，資料在
// demo-data/<locale>.json）。app 沒有「目前帳本」的 cookie，看的是哪本帳由 DB 決定
// （getActiveGroupForUser：current_epoch_started_at 最新的那本），所以截圖前跑
// `seed-demo-ledgers.ts --activate=<locale>`、截完（含失敗）跑 `--activate=zh-TW`
// 切回去。這兩步會寫 dev DB，腳本自己會拒絕非 dev 的目標。旅行內頁用該語系的
// trip id。截完 /assets 會把植物卡上的天數記進 demo-data/<locale>.capture.json，
// 故事圖第 4 張的 {days} 就用這個數字。zh-TW 的帳本與 trip id 不變。
// 每張圖截之前核對 /dashboard 上的帳本名稱：切換沒生效的樣子不是報錯，是截到另一本帳。
//
// 各組尺寸不能共用：
//   App Store 6.7" 必須正好 1290×2796（比例 2.167:1）
//   App Store 13" iPad 必須正好 2064×2752（或 2048×2732）—— 宣告支援 iPad 就是必填
//   Play 手機截圖長邊不得超過短邊 2 倍 —— 2.167 會被退，故另出 1080×1920

import puppeteer from 'puppeteer'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { localeArg, shotsDirFor, DEFAULT_LOCALE } from './store-locales.mjs'
import { readDemoData, writeCapture, demoDataPath, DEMO_DATA_DIR } from './demo-data.mjs'
import { checkPaths } from './check-store-pngs.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOCALE = localeArg()
const OUT_DIR = shotsDirFor(LOCALE)
const PROFILE = join(homedir(), '.futari-shots-profile')
const BASE = process.env.BASE_URL || 'http://localhost:3000'
const LOGIN_MODE = process.argv.includes('--login')
// 連上一個已經在跑、而且已經登入的 Chrome（例：superpowers-chrome 的 CDP endpoint），
// 取代 --login 那套專用 profile。deviceScaleFactor 走 CDP 的 Emulation 覆寫，
// 所以輸出像素仍然精確，不受實體螢幕 DPI 影響。
//   node capture-screens.mjs --connect=http://127.0.0.1:9222
const CONNECT = (process.argv.find((a) => a.startsWith('--connect=')) || '').replace('--connect=', '')

// --connect 拿掉了「這一定是專用 profile」這個保證：連到哪個瀏覽器，就截到那個
// 瀏覽器當下登入的帳本。指到日常 Chrome 就會把真實帳本渲染進公開 repo 與商店頁。
// 失效的樣子不是報錯，是截圖看起來完全正常、只是內容是別人的生活。
// 這個檢查要的是「示範帳本的樣子」：頭像是首字圓圈（沒有 <img>），不是真人照片。
async function assertDemoLedger(page) {
  const real = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img[src]'))
    return imgs.filter((i) => /googleusercontent|gravatar|\/avatars?\//.test(i.src)).length
  })
  if (real > 0) {
    throw new Error(
      `畫面上有 ${real} 張真人頭像 —— 這個瀏覽器登入的不是示範帳本。\n` +
      '把示範帳號的 profile 設成 avatar_hidden（#1328），或改用 --login 的專用 profile。',
    )
  }
}
// 語系 cookie 的寫法與 lib/i18n/LanguageSwitcher.tsx 相同（path=/、一年、Lax）。
// 沒設好的樣子不是報錯，是整批截圖還是上一次用過的語言——所以截完還有
// checkLocale() 對 <html lang> 與底部導覽的文字做核對。
const LOCALE_COOKIE = 'lang'
const localeCookie = (value) => ({
  name: LOCALE_COOKIE,
  value,
  url: BASE,
  path: '/',
  sameSite: 'Lax',
  expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
})

// 語系的示範帳本。zh-TW 是 2026-08 起截圖用的那本（3a896cf2-…），名稱與 trip 寫死；
// 其他語系來自 seed-demo-ledgers.ts --apply 寫的 demo-data/<locale>.json。
const ZH_TW_LEDGER = { groupId: '3a896cf2-fe3c-4525-b5d6-789ce17e3e4e', groupName: '我們的帳本', tripId: '0eeb2477-aee5-47d9-bcb2-74699abecb9a' }
const DEMO = LOCALE === DEFAULT_LOCALE ? ZH_TW_LEDGER : readDemoData(LOCALE)
if (!DEMO && !process.argv.includes('--login')) {
  console.error(`✗ ${LOCALE} 還沒有示範帳本（缺 ${demoDataPath(LOCALE)}）。先在 repo 根目錄跑：\n` +
    `    npx tsx scripts/og/seed-demo-ledgers.ts --apply --locale=${LOCALE}`)
  process.exit(1)
}
const REPO = resolve(__dirname, '..', '..')
// 有任何語系帳本存在時才需要切換；只有 zh-TW、從沒 seed 過時不碰 DB。
const seededAny = ['zh-CN', 'en', 'ja'].some((l) => existsSync(demoDataPath(l)))
function activate(locale) {
  console.log(`切換示範帳本 → ${locale}（seed-demo-ledgers.ts --activate，寫 dev DB）`)
  const r = spawnSync('npx', ['tsx', 'scripts/og/seed-demo-ledgers.ts', `--activate=${locale}`], { cwd: REPO, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`seed-demo-ledgers.ts --activate=${locale} 失敗（exit ${r.status}）`)
}

// 底部導覽的字串直接從 app 的語系檔讀（Node 26 可直接 import .ts；語系檔只有
// `import type`，型別剝除後沒有其他依賴）。這樣 app 改了文案，這裡不會跟著過時。
async function localeStrings(locale) {
  const exportName = { 'zh-TW': 'zhTW', 'zh-CN': 'zhCN', en: 'en', ja: 'ja' }[locale]
  const listeners = process.listeners('warning')
  process.removeAllListeners('warning') // 吞掉「Reparsing as ES module」那幾行提示
  try {
    const mod = await import(resolve(__dirname, '..', '..', 'lib', 'i18n', 'locales', `${locale}.ts`))
    return mod[exportName]
  } finally {
    // 提示是在下一輪 event loop 才送出的，等它過去再把 listener 接回來。
    await new Promise((r) => setTimeout(r, 0))
    listeners.forEach((l) => process.on('warning', l))
  }
}

// 截完每張圖之後的語系核對。分兩級：
//   錯誤：<html lang> 不是要的語系 —— 代表 cookie 沒被讀到，整張圖都是錯的語言。
//   警告：畫面文字「看起來」混了別的語系。這是啟發式，會有誤報：示範帳本的紀錄
//         名稱是使用者資料，不會跟著介面翻譯（例如 en 介面裡的「貓砂和飼料」），
//         所以警告是要人去看圖，不是擋下來。
// 啟發式本身：
//   - 有底部導覽的頁面：nav 的 aria-label 與四個分頁名稱要等於該語系檔的
//     bottomNav（介面外框最穩定的一組字串）。
//   - en：統計漢字與假名數量（介面本身不該有任何 CJK）。
//   - ja：整頁沒有任何平假名／片假名，多半是截到中文介面。
//   - zh-CN／zh-TW：用一小組只在其中一邊出現的常用字（們/们、這/这…）找另一邊的字。
//     日文漢字與繁簡字形交錯，ja 不做這一項。
const TRAD_ONLY = '們個這筆紀錄帳說時點結為會與過錢還開關設頁傳記讓'
const SIMP_ONLY = '们个这笔纪录账说时点结为会与过钱还开关设页传记让'
async function checkLocale(page, locale, nav) {
  const found = await page.evaluate(() => {
    const navEl = document.querySelector('nav[aria-label]')
    return {
      htmlLang: document.documentElement.lang,
      text: document.body.innerText,
      navLabel: navEl ? navEl.getAttribute('aria-label') : null,
      navText: navEl ? navEl.innerText : null,
    }
  })
  if (found.htmlLang !== locale) {
    throw new Error(`<html lang="${found.htmlLang}">，預期 ${locale} —— 語系 cookie 沒有生效`)
  }
  const warnings = []
  if (found.navLabel !== null) {
    if (found.navLabel !== nav.navAriaLabel) warnings.push(`底部導覽 aria-label 是「${found.navLabel}」，預期「${nav.navAriaLabel}」`)
    const missing = [nav.home, nav.records, nav.assets, nav.settings].filter((l) => !found.navText.includes(l))
    // 已離開的成員看不到「設定」分頁（BottomNav 留空位），少一個不算錯。
    if (missing.length > 1 || (missing.length === 1 && missing[0] !== nav.settings)) {
      warnings.push(`底部導覽缺少：${missing.join('、')}`)
    }
  }
  const sample = (re) => [...new Set(found.text.match(re) || [])].slice(0, 12).join('')
  if (locale === 'en') {
    const cjk = (found.text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length
    if (cjk) warnings.push(`畫面有 ${cjk} 個漢字／假名（例：${sample(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)}）—— 可能是帳本資料，也可能是漏翻`)
  }
  if (locale === 'ja' && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(found.text)) {
    warnings.push('整頁沒有任何假名 —— 看起來不是日文介面')
  }
  if (locale === 'zh-CN') {
    const hit = sample(new RegExp(`[${TRAD_ONLY}]`, 'g'))
    if (hit) warnings.push(`出現繁體字：${hit} —— 可能是帳本資料，也可能是漏翻`)
  }
  if (locale === 'zh-TW') {
    const hit = sample(new RegExp(`[${SIMP_ONLY}]`, 'g'))
    if (hit) warnings.push(`出現簡體字：${hit} —— 可能是帳本資料，也可能是漏翻`)
  }
  return warnings
}

// 只截某幾組尺寸，例：--only=ipad-13。不給就全部重截。
// 存在的理由：已上架那幾組是用整理過的 dev 帳本截的，重跑會整批覆寫；
// 補一個新尺寸時沒有理由連帶重截已驗過的圖。
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '')
  .replace('--only=', '')
  .split(',')
  .filter(Boolean)

// 敘事順序（見 docs/app-store-listing.md §8）：說故事，不是功能清單。
const SCREENS = [
  { name: '01-dashboard', path: '/dashboard', label: '餘額一覽' },
  { name: '02-records', path: '/records', label: '紀錄與分攤' },
  // 旅行截內頁而非 /trips 清單：清單只有幾行標題然後一大片空白，
  // 多幣別與分攤這些真正的賣點都在內頁。大阪7日有 11 筆支出 + 3 種匯率。
  // trip id 依語系：zh-TW 沿用大阪7日，其他語系取 demo-data/<locale>.json。
  { name: '03-trip', path: `/trips/${DEMO?.tripId}`, label: '旅行帳本' },
  { name: '04-assets', path: '/assets', label: '愛物' },
]

// 月度回顧（/review/[month]）暫不收進商店截圖：2026-07 的 snapshot 沒有花費
// 紀錄，卡片只會顯示「這個月沒留下花費紀錄」，留言區也是空的。等真的累積了
// 資料再補 —— 商店截圖隨時可換。

// deviceScaleFactor 乘上 viewport 得到實際輸出像素。
const FORMATS = [
  { key: 'ios-6.7', width: 430, height: 932, dsr: 3 },      // → 1290×2796
  { key: 'play', width: 360, height: 640, dsr: 3 },         // → 1080×1920
  // Play 的平板欄位（7 吋 / 10 吋）也要求 16:9 或 9:16，所以輸出像素與手機同為
  // 1080×1920；差別在 CSS viewport 給 720px 寬，版面是用平板寬度算出來的。
  { key: 'tablet', width: 720, height: 1280, dsr: 1.5, tablet: true }, // → 1080×1920
  // App Store 13" iPad：project.pbxproj 的 TARGETED_DEVICE_FAMILY = "1,2" 宣告支援
  // iPad，App Store Connect 就強制要這格。1032×1376pt @2x 正是 13" iPad Pro 的
  // logical size，乘 2 得到 Apple 唯一接受的 2064×2752。
  { key: 'ipad-13', width: 1032, height: 1376, dsr: 2, tablet: true }, // → 2064×2752
]

async function login() {
  // Google 會擋「宣告自己被自動化控制」的瀏覽器（「這個瀏覽器或應用程式可能有安全疑慮」），
  // 即使登入的是使用者自己的帳號。所以改用系統安裝的 Chrome，並拿掉 automation 旗標。
  const browser = await puppeteer.launch({
    headless: false,
    channel: 'chrome',
    userDataDir: PROFILE,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--window-size=480,900',
      '--disable-blink-features=AutomationControlled',
    ],
  })
  const [page] = await browser.pages()
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })

  console.log('\n瀏覽器已開啟。請在視窗裡用 Google 帳號登入。')
  console.log('登入完成、看到 dashboard 之後，這支程式會自己往下走（最多等 5 分鐘）。\n')

  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    if (page.url().includes('/dashboard')) {
      // 多等一下讓 auth cookie 確實落盤
      await new Promise((r) => setTimeout(r, 3000))
      console.log('✓ 登入成功，profile 已保存：' + PROFILE)
      await browser.close()
      return true
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.error('✗ 等待逾時，沒有偵測到 /dashboard。')
  await browser.close()
  return false
}

async function capture() {
  await mkdir(OUT_DIR, { recursive: true })
  // 與 login() 用同一個 channel —— profile 由 Chrome stable 建立，
  // 換成 puppeteer 自帶的 Chromium 可能因版本不符而讀不到。
  const browser = CONNECT
    ? await puppeteer.connect({ browserURL: CONNECT, defaultViewport: null })
    : await puppeteer.launch({
        headless: 'new',
        channel: 'chrome',
        userDataDir: PROFILE,
      })
  const results = []
  const warnings = []
  const strings = await localeStrings(LOCALE)
  const nav = strings.bottomNav

  const formats = ONLY.length ? FORMATS.filter((f) => ONLY.includes(f.key)) : FORMATS
  if (!formats.length) {
    throw new Error(
      `--only=${ONLY.join(',')} 沒有對應的 format。可用：${FORMATS.map((f) => f.key).join(', ')}`
    )
  }

  // 先記下原本的語系 cookie，結束時還原：--connect 連的是別人的瀏覽器，
  // 不還原的話對方之後打開 dashboard 會變成截圖用的語言。
  const cookiePage = await browser.newPage()
  const previous = (await cookiePage.cookies(BASE)).find((c) => c.name === LOCALE_COOKIE)
  await cookiePage.setCookie(localeCookie(LOCALE))
  await cookiePage.close()

  let plantRecord = null
  try {
    if (seededAny) activate(LOCALE)
    for (const fmt of formats) {
      for (const screen of SCREENS) {
        const page = await browser.newPage()
        await page.setViewport({
          width: fmt.width,
          height: fmt.height,
          deviceScaleFactor: fmt.dsr,
          // 平板不宣告 isMobile，讓版面走桌機/寬螢幕分支（若 app 有的話）。
          isMobile: !fmt.tablet,
          hasTouch: true,
        })
        const res = await page.goto(`${BASE}${screen.path}`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        })

        // 沒有這道檢查的話，404 會被當成正常畫面存成一張全黑的圖 —— 實際發生過。
        if (res && res.status() >= 400) {
          throw new Error(`${screen.path} 回應 HTTP ${res.status()}，路由可能錯了`)
        }

        // 被導去登入頁 = profile 沒有有效 session，直接中止比截出一堆
        // 登入頁截圖有用。
        if (/sign-in/.test(page.url())) {
          throw new Error(
            `未登入（${screen.path} 被導向 ${page.url()}）。先跑 node capture-screens.mjs --login`
          )
        }

        // 登入了不等於登入的是示範帳本（--connect 尤其如此，見檔頭）。
        await assertDemoLedger(page)
        // 而且要是這個語系的那一本：首頁標頭是帳本名稱。
        if (screen.name === '01-dashboard') {
          const text = await page.evaluate(() => document.body.innerText)
          if (!text.includes(DEMO.groupName)) {
            throw new Error(`首頁沒有看到帳本名稱「${DEMO.groupName}」—— 現在顯示的不是 ${LOCALE} 的示範帳本（切換沒生效？）`)
          }
        }

        // 隱藏捲軸 + Next.js dev overlay 的浮標 + 等動畫與字體收斂。
        // dev indicator 那顆黑色「N」是 dev server 才有的東西，2026-08 那批截圖
        // 沒擋掉，在 *-play.png 裡直接壓住「首頁」tab 圖示。
        await page.addStyleTag({
          content:
            '*::-webkit-scrollbar{display:none!important}' +
            'nextjs-portal,[data-nextjs-toast],#__next-build-watcher{display:none!important}',
        })
        await page.evaluate(() => document.fonts.ready)
        await new Promise((r) => setTimeout(r, 1200))

        const file = `${screen.name}-${fmt.key}.png`
        for (const w of await checkLocale(page, LOCALE, nav)) warnings.push(`${file}: ${w}`)

        // 故事圖第 4 張的 {days}：記下植物卡當下顯示的天數（zh-TW 的文案是固定字，不記）。
        if (screen.name === '04-assets' && LOCALE !== DEFAULT_LOCALE && !plantRecord) {
          plantRecord = await readPlantDays(page, DEMO.plantName, strings.assetListItem.plantCompanionDays)
        }

        const buf = await page.screenshot({ type: 'png' })
        await writeFile(join(OUT_DIR, file), buf)
        const px = `${fmt.width * fmt.dsr}×${fmt.height * fmt.dsr}`
        console.log(`✓ ${file}  (${px})  ${screen.label}`)
        results.push(file)
        await page.close()
      }
    }
  } finally {
    if (seededAny && LOCALE !== DEFAULT_LOCALE) {
      try { activate(DEFAULT_LOCALE) } catch (e) { console.error(`✗ 沒能切回 zh-TW 帳本：${e.message}\n  手動跑：npx tsx scripts/og/seed-demo-ledgers.ts --activate=zh-TW`) }
    }
    const restore = await browser.newPage()
    if (previous) {
      await restore.setCookie({ ...localeCookie(previous.value), expires: previous.expires })
    } else {
      await restore.deleteCookie({ name: LOCALE_COOKIE, url: BASE })
    }
    await restore.close()
    // 連上別人的 Chrome 時只中斷連線，不要把使用者的視窗關掉。
    if (CONNECT) await browser.disconnect()
    else await browser.close()
  }

  console.log(`\n共 ${results.length} 張（${LOCALE}）→ ${OUT_DIR}`)
  if (plantRecord) {
    writeCapture(LOCALE, { locale: LOCALE, groupId: DEMO.groupId, plantName: DEMO.plantName, ...plantRecord })
    console.log(`植物卡：${DEMO.plantName} ${plantRecord.plantDaysShown} 天（${plantRecord.capturedOn}）→ ${relativeToRepo(join(DEMO_DATA_DIR, `${LOCALE}.capture.json`))}`)
  }

  if (warnings.length) {
    console.warn(`\n⚠ 語系核對有 ${warnings.length} 則警告（啟發式，請打開圖確認）：`)
    warnings.forEach((w) => console.warn(`  ${w}`))
  }

  console.log('\n尺寸／alpha 檢查：')
  if (checkPaths(results.map((f) => join(OUT_DIR, f)))) process.exitCode = 1
}

const relativeToRepo = (p) => p.slice(REPO.length + 1)

// 從 /assets 的植物卡讀出天數。卡上的字是語系檔的 plantCompanionDays
// （例 en「{days} day(s) together」），所以用同一個模板反推出數字。
// 日期取瀏覽器的本地日期：卡片的天數是 daysSince(萌芽日, useToday())，
// useToday() 在 hydration 後讀的就是裝置時鐘。
async function readPlantDays(page, plantName, template) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const [before, after = ''] = template.split('{days}')
  const found = await page.evaluate((name) => {
    const link = [...document.querySelectorAll('a[href^="/assets/"]')].find((a) => a.innerText.split('\n')[0].trim() === name)
    const d = new Date()
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { text: link ? link.innerText : null, capturedOn: ymd }
  }, plantName)
  if (!found.text) throw new Error(`/assets 上找不到植物「${plantName}」的卡片`)
  const m = found.text.match(new RegExp(`${esc(before.trim())}\\s*([\\d,]+)\\s*${esc(after.trim())}`))
  if (!m) throw new Error(`植物卡上找不到天數（模板「${template}」）：${found.text.replace(/\n/g, ' / ')}`)
  return { plantDaysShown: Number(m[1].replace(/,/g, '')), capturedOn: found.capturedOn, capturedAt: new Date().toISOString() }
}

if (LOGIN_MODE) {
  const ok = await login()
  process.exit(ok ? 0 : 1)
} else {
  await capture()
}
