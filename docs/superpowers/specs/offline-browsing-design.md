---
last_updated: 2026-10-15
status: shipped
first_shipped_in: v0.14.0
updates:
  - v0.15.0: 重新上線 / PWA 回前景自動 refresh（解 iOS PWA standalone 沒下拉刷新、弱網後 NetworkFirst 卡舊資料的問題，closes #126）
  - v1.5.14: 使用中斷線提示與 toggle 脫鉤，對所有人顯示；toggle 只決定文案（#1206）
  - v1.5.15: 斷線提示加顯示門檻（換網不再閃一下），並補上 spec 從 v0.14.0 就寫著、實作一直沒有的 fade out（#1244）
  - v1.7.3: 關閉／登出／刪除帳號一律完整關閉並清乾淨（SW、所有 cache、serwist-expiration 紀錄）；SW 寫入閘門（同意標記）、綁定開啟的使用者、登入頁 sweep、校準只往下、其他分頁 reload；撤回「per device、登出不變」（#1673）
  - v1.7.3: web 上沒開離線瀏覽的人也有 Futari 離線頁：基本 SW `/sw-basic.js` 只存一頁自我包含的離線頁、不存任何帳本資料；kill switch 回滾；撤回「沒開就不註冊任何 SW」（#1674）
related_specs: [realtime, product]
related_issues: ["#19", "#126", "#1206", "#1225", "#1244", "#1672", "#1673", "#1674"]
---

# 離線瀏覽 / PWA Cache

> 讓使用者在無網路時能瀏覽最近的記錄與首頁，不阻塞日常瀏覽。
> **Read-only offline**；不含離線寫入、編輯、realtime。

---

## 背景與動機

Oikos 是 mobile-first PWA：`public/manifest.json` 已宣告 `display: standalone`、`start_url: /dashboard`，使用者可從手機加到主畫面、看似 app。但目前**沒有任何 Service Worker**，斷網時主畫面點下去只會看到瀏覽器離線頁——對「家庭日常記帳」這類隨時想翻一下歷史的場景體感不好（捷運上、地下停車場、出國漫遊等都會踩到）。

需求面只要求「瀏覽」，不要求「寫入」。離線寫入會帶來 conflict resolution、雙人 race、加密欄位（v0.10.0 才剛上欄位級靜態加密）的安全疑慮，**全部不在本 spec 範圍**。

此外，把 PII（金額、姓名、遮罩 ID）cache 在裝置上是**裝置端的隱私決定**，不是純技術功能。v0.10.0 剛把身分證／健保卡做欄位級靜態加密，呼應「使用者控制自己資料」的基調，本功能採 **opt-in**：預設關閉，使用者到 Settings 主動開啟才會註冊 SW、開始 cache。共用裝置、低可信任環境、儲存吃緊的舊機都可以選擇不開。

---

## Scope

### In

- Settings 頁「離線瀏覽」開關（**預設關閉**；存在這台裝置的 localStorage，並綁定開啟時登入的使用者；登出、刪除帳號會把它關掉，#1673）
- Service Worker 安裝與生命週期管理（Serwist + `@serwist/next`）：完整 SW `/sw.js` **僅在 toggle 開啟時 register**；toggle 關的 web 使用者改註冊**基本 SW** `/sw-basic.js`（只存離線頁，見「基本 SW」，#1674）
- App shell precache（`_next/static/**`、icons、manifest）
- Runtime cache：`/dashboard`、`/records`、`/assets`、`/assets/[id]`、`/assets/[id]/*` 的 RSC HTML，network-first + 3s timeout
- `/offline` fallback 頁（完整 SW）；`/offline-basic.html` 自我包含離線頁（基本 SW，#1674）
- Online / offline banner（`navigator.onLine` 偵測；v1.5.14 起**不論 toggle 都顯示**，toggle 只決定文案，見「Offline banner」）
- Toggle 關閉、登出、刪除帳號都走同一個**完整關閉**：刪同意標記 → pref 關 → unregister 所有 SW → 廣播 → 刪所有 cache → 清 `serwist-expiration`（#1673）
- SW 寫入閘門：只在同意標記存在時寫 `dynamic-v1`（#1673）
- 登入頁 sweep、使用者綁定、dashboard 掛載時的 sweep（防 PII 跨使用者外洩，#1673）
- 重新上線 / PWA 回前景自動 refresh（v0.15.0 加入）

### Out

- **離線寫入 / 編輯**：AddSheet、Settlement confirm、IncomeSheet、recurring pending confirm 全要連線
- **IndexedDB shadow store**：不引入 client-side 資料層；不為「離線多頁瀏覽」鋪 IDB
- **背景同步（Background Sync API）**
- **Push notification**
- **Settings / Invite / Auth flows / `/setup`**：這些頁不 cache（需即時資料、含敏感操作）
- **Server actions cache**：所有 server action 走 POST，預設不 cache，也**不該** cache（reveal 身分證／健保卡為高敏感）
- **i18n / locale switching cache**：locale 走 `lang` cookie + `router.refresh()`，SW 不額外處理

---

## Locked decisions

| 維度 | 決定 | 理由 |
|---|---|---|
| 啟用模式 | **opt-in via Settings 開關**，預設關閉；存 localStorage `offline-browsing-enabled`。關著的 web 使用者有基本 SW（不存帳本資料，#1674） | Cache PII 是裝置端隱私決定（v0.10.0 才剛以欄位級靜態加密保護敏感欄位）；尊重「使用者控制自己資料」基調。opt-in 的對象是「帳本頁面存在裝置上」，不是「有沒有 SW」 |
| Toggle 持久化位置 | **localStorage（這台裝置／瀏覽器）＋綁定使用者**：開啟時存 `offline-browsing-owner` = 登入者 user id 的 SHA-256 hex（取自瀏覽器端 Supabase client 的 `auth.getSession()`，不取頁面 payload——cache 住的頁面帶的是 cache 當時那個人的 id）。不存 Supabase user prefs | SW 是裝置能力，同帳號跨裝置要分別 opt-in；但 cache 的內容是某個人的帳本，所以同一台裝置換人時要清掉（#1673，見下方撤回紀錄） |
| Toggle off 行為 | **完整關閉**（`turnOfflineBrowsingOff`）：遞增 `offline-off-epoch` → 刪同意標記 `offline-consent-v1` → pref 關、清 owner → unregister 所有 SW → `BroadcastChannel('futari-offline')` 廣播 → 刪所有 Cache Storage → 清空並刪除 `serwist-expiration`。每一步 best-effort、不丟錯 | 使用者關閉是主動撤回信任，不只 bypass cache 還要把已存資料抹乾淨；標記先刪，所有還活著的 SW 立刻停寫 |
| SW framework | **Serwist (`@serwist/next`)** | next-pwa 維護停滯、Next 16 / App Router 兼容回報差；Serwist 為其精神後繼 |
| Cache 分層 | **L1 precache（靜態） + L2 runtime（HTML），跳過 L3（API）** | Oikos 沒有 GET API；server actions 為 POST 不 cache；L3 對需求面零價值且高風險（PII） |
| 靜態資源策略 | **cache-first** | 不變、按 hash key、cache hit 即可離線啟動 |
| HTML 策略 | **network-first, 3s timeout, fallback cache** | 金額正確性 > 首屏 100ms；3s timeout 兜離線；不用 SWR 因為會跟 Next.js `revalidatePath` 打架 |
| 資料 cache 路徑 | **純頁面 cache，不引入 IndexedDB** | 需求是「能看最近的」，純頁面 cache 完全對應；IDB 等到要做離線寫入再評估 |
| 多頁瀏覽限制 | **只能看「最後一次線上開過的頁」** | Records 第二、三頁離線無資料時顯示 empty state「再多紀錄需連線取得」 |
| Per-user 隔離 | **登出、刪除帳號走完整關閉；dashboard 掛載時核對 owner，不同人就完整關閉；登入頁 sweep** | SW 預設按 URL key、不認 cookie；多使用者共用裝置時必須清。只清 `dynamic-v1` 不夠：SW 還在、toggle 還開著，舊分頁會再寫回去（#1673） |
| SW 寫入閘門 | **`dynamic-v1` 只在同意標記（Cache Storage `offline-consent-v1`，一筆不含 PII 的小項目）存在時寫入**。兩個 plugin：pre-check 放第一個（標記不在就 `cacheWillUpdate` 回 null，連 cache 都不開）；post-check 放在 ExpirationPlugin 之後（寫完再查一次，標記沒了就用 `ExpirationPlugin.deleteCacheAndMetadata()` 把這筆和它的 IndexedDB 紀錄一起收回）。邏輯在 `lib/offline/swGate.ts` | 隱私不能押在 reload 的時機上：關閉後還被舊 SW 控制的分頁（含 Android 殼唯一的 WebView），在 reload 之前標記已經沒了，寫不進去。`static-v1`（icons／og，無 PII）不設閘 |
| 誰能把 pref 打開 | **只有使用者在 Settings 按開**；校準與錯誤路徑只會往下（關） | 舊的校準 `active || stored` 會因為「還有 SW 註冊著」把關掉的裝置自己打開（#1673 F4） |
| Cache 寫入條件 | **只在 200 OK + 已登入態下寫入；redirect 到 `/sign-in` 不寫** | 防止把「未登入畫面」cache 進去蓋掉登入態頁 |
| Offline UI | **`/offline` fallback 頁（toggle 開）／`/offline-basic.html`（toggle 關、web）+ 斷線 banner** | banner 讓使用者知道目前離線；toggle 開時另外說明資料是 cache；toggle 關的 web 使用者斷線或網路卡住時看到 Futari 的離線頁，而不是瀏覽器的（#1674） |
| Realtime 行為 | **離線時靜音 reconnect retry** | 避免無限 reconnect log noise；上線時恢復訂閱 |
| SW 更新策略 | **`skipWaiting + clientsClaim`** | chunk hash 變動時新版立刻接管，不要使用者關 tab 重開 |
| Dev / Prod | **prod-only build**（dev 不啟用 SW） | 避免干擾 Turbopack HMR |

### v0.15.0 增量：自動 refresh

iOS PWA standalone 沒有下拉刷新；Router Cache + Serwist NetworkFirst 在弱網後會卡舊資料、需要關掉 app 重開才恢復。`ReconnectRefresh` 元件監聽 `online` 與 `visibilitychange`：

- 重新上線時**無條件** `router.refresh()`
- PWA 從背景回前景且距上次 refresh 超過 30s 時補一次 refresh

### 不採用

- ❌ **預設啟用（離線瀏覽）**：cache PII 在裝置上是隱私決定，需明確同意。基本 SW 預設就有，但它不存任何帳本資料，不是「預設啟用離線瀏覽」（#1674）
- ❌ **Toggle 存 Supabase user preferences（跨裝置同步）**：SW / cache 是裝置能力，跨裝置同步可能造成「我在朋友家用過一次的瀏覽器自動開了 cache」這種反直覺結果
- ❌ **首次安裝後彈 modal 邀請開啟**：MVP 不做主動推銷；toggle 放在 Settings 等使用者主動發現
- ❌ **next-pwa**：維護停滯、Next 16 / App Router 兼容問題多
- ❌ **自製 SW**：要自處理 precache hashing、版本切換、navigation preload，工時 vs 價值不成比例
- ❌ **Stale-while-revalidate (SWR) on HTML**：Oikos 寫入路徑會 `revalidatePath`，SW 層 SWR 不認；剛新增完一筆 expense 回 dashboard 會看到舊 cache，體感像 bug
- ❌ **IndexedDB shadow store**：對「能瀏覽最近的」需求是 over-engineering
- ❌ **`Vary: Cookie` 處理多使用者**：cookie 內容變動頻繁、cache key 會爆炸；改用登出時完整關閉＋使用者綁定（#1673）

---

## Cache 層級

```
L1 · App Shell（precache, cache-first）
  _next/static/**（Next 自動 hash） / manifest / icons / og-image / /offline

L2 · Dynamic HTML（runtime, network-first）
  /dashboard, /records, /assets, /assets/[id], /assets/[id]/*
  策略：3s timeout → fallback cache
  寫入條件：200 OK + 非 redirect + 同意標記存在（SW 寫入閘門）
  關閉、登出、刪除帳號、換人時清空（連同 serwist-expiration 紀錄）

→ 全失敗 fallback → /offline（純靜態：「離線中，以下資料為快取」）
```

---

## UX 細節

### Settings 頁開關

- 預設：**關**
- 開啟描述：「無網路時可看最近一次連線時的記錄。資料只存在這台裝置；登出時會一併關閉並清除，重新登入後需要再開啟一次。」（#1673；zh-CN／en／ja 待審）
- Toggle 切換進行中（register / unregister）UI disable + spinner，避免連點造成半 cache 狀態。開啟要等到 `/sw.js` 真的是 active 且 `activated`（不是 `serviceWorker.ready`——任何 SW 在 scope `/` active 它就會 resolve），上限 15s；逾時或出錯就完整關閉並顯示錯誤。排在 OFF 後面等的時候，「處理中」最多可能顯示 15s（接受）
- 顯示的狀態 = **pref（且 owner 相符）**，不看「有沒有 SW」。校準只會往下：pref 關、`/sw.js` 卻還在 → 跑掛載 sweep，pref 保持關；**任何路徑都不會因為校準或錯誤寫入 true**
- 帳號登出、刪除帳號時 toggle **關閉並清除**；重新登入後要自己再開（#1673，撤回舊的「per device、登出不變」，見撤回紀錄）
- 每個分頁一條序列化佇列：掛載、開、關、reload 判斷依序跑；每個序列記住「預期的 pref」（自己的寫入會更新它），在每次 register／unregister／刪 cache／完整關閉之前重讀 pref，只有被別人改掉時才中止。登出和刪除帳號**插隊**，不排在 15s 的等待後面

### Offline banner

- 位置：dashboard 的 `ContextStrip` 最高優先分支（不擋內容；目前只在 `/dashboard` 渲染，不是全站）
- 顯示條件：`navigator.onLine === false` **且已持續 2s**，**不論 toggle 開關**（v1.5.14 #1206；2s 門檻 v1.5.15 #1244，見下）
- 文案依 toggle 分兩種：
  - toggle 開：「離線中・顯示最近一次連線的資料」（`offlineBanner.text`）
  - toggle 關：「離線中・恢復連線後會自動更新」（`offlineBanner.textNoCache`）——沒有帳本 cache（web 上只有基本 SW，它不存帳本頁面，#1674），畫面上只是斷線前已載入的頁面，「顯示快取」的說法不成立；「會自動更新」由 `ReconnectRefresh` 的 online 事件無條件 `router.refresh()` 兌現
- 播報：`role="status"` + `aria-live="polite"`

**為什麼原本只對 toggle 開啟者顯示、後來改掉**：v0.14.0 時 banner 只有一句描述 cache 的文案，對沒開 toggle 的人是假話，所以用 toggle 擋掉——在只有一種文案的前提下這是合理解。代價是 toggle 預設關，等於**幾乎所有人斷線時什麼提示都沒有**，直到送出記帳失敗才發現（#1206，Android 實機回報）。解法是加第二種文案，而不是讓錯的文案顯示給所有人。

**失效的樣子**：dev server / Vercel preview 永遠有網路，測不到；要在瀏覽器 DevTools 切 Offline 或殼內開飛航模式，而且要在**已載入 dashboard 之後**才斷線。冷啟動就沒網路是另一回事——web 程式碼根本不會執行，banner 無從出現，那屬於原生殼的 `server.errorPath`（#1225），不是本 spec。

- 顏色：中性 muted（不要紅 / 警告色，銀行 app 風格不符 Futari「陪伴」基調）
- **顯示前先等 `OFFLINE_ANNOUNCE_DELAY_MS`（現為 2s，`lib/hooks/useOnlineStatus.ts`）**：Wi-Fi → 行動網路切換時 `offline` / `online` 大約隔一秒接連觸發，沒有門檻的話每次換網所有人都會看到 banner 閃一下（#1244）。門檻的兩端都有依據——下界是換網本身的耗時，上界是 `app/sw.ts` 的 `networkTimeoutSeconds: 3`（App 自己放棄等網路、改讀 cache 的時間點，banner 必須在那之前就位）。**2s 是初始值，repo 內沒有任何實測換網耗時的資料**，要用真機在弱訊號邊緣校正過才算定案。
  - 只延後「斷線」那一邊，「恢復」立刻反映：blip 永遠不被播報，復原永遠不被拖延。
  - 這個延遲只給 banner 用（`useDelayedOnlineStatus`）。`TransactionFeed` 仍讀未延遲的 `useOnlineStatus`——它是在換頁請求失敗的當下讀連線狀態來決定要不要說「再多紀錄需連線取得」，用兩秒前的狀態解釋眼前的失敗會說錯話。
- 重新上線時 fade out（0.5s 收合，`.strip-fading`；`prefers-reduced-motion` 下直接移除，不做「留著淡掉」那套——banner 收掉時已經沒有訊息要傳達，留 500ms 只是把版面跳動延後 500ms）。收合期間 ContextStrip 不讓下一順位的 banner 進場，維持「一次只有一條」
  - v0.14.0 寫下這行時的括號是「不刷新整頁，避免使用者正在看的東西消失」。前半段已被 v0.15.0 的 `ReconnectRefresh` 取代（重新上線無條件 `router.refresh()`，是 soft refresh 不是整頁重載）；留下來的意思是後半段：banner 不要用瞬間消失去撞下面的內容。
  - **這行從 v0.14.0 寫到 v1.5.14 都沒有對應實作**（當時的 `OfflineBanner`、以及併入 ContextStrip 之後都是直接 unmount），#1244 才補上。不是回歸，是一直沒做。

### Cached 頁面上的寫入互動

cached HTML 上的編輯、刪除、settlement confirm 按鈕**不在 client 端預先 disable**：

- 點擊 → 走既有 server action → 離線時 fetch 失敗 → 既有錯誤處理顯示「網路不穩，再試一次」
- 不在 SW 層攔截寫入路徑

理由：(1) `navigator.onLine` 不可信（會誤判 captive portal、弱訊號），預先 disable 反而擋掉真的通的請求；(2) 寫入的 source of truth 是 server action 的 response，不是 SW 狀態。

### Records 換頁離線

下拉到底要載第二頁時偵測 `navigator.onLine === false` → 顯示 inline empty state「再多紀錄需連線取得」（不彈 toast、不跳 modal）。

### Sign-out flow（登出、刪除帳號）

```
client click 登出／刪除帳號
  ↓ 完整關閉 0–2：遞增 off epoch → 刪同意標記 → pref 關、清 owner → unregister 所有 SW
  ↓ server action：signOut()／requestAccountDeletion()（含推播 token 處理；失敗也繼續往下）
  ↓ 完整關閉 3–5：廣播 → 刪所有 cache → 清 serwist-expiration
  ↓ location.replace('/')
```

- 先停 SW 再登出：標記一刪、SW 一停，還有效的 session 在登出前抓的任何頁面都寫不進 cache（#1673 M2）。清除放在登出之後，其他分頁收到廣播 reload 時已經是登出狀態。
- 登出、刪除帳號插隊，不排在每分頁佇列裡等 `/sw.js` 啟用（最多 15s）——#1617 修掉的「登出卡住」不能因此回來。
- **off epoch**：開啟流程或 pref 開的掛載在寫 pref、owner、標記之前都會重讀 `offline-off-epoch`；登出期間它變了，就三樣都不寫，開啟流程改以完整關閉收尾。所以登出時剛好有一個開啟在等，也不會留下「開著」。
- Precache 也一起刪（舊版保留 app shell）：完整關閉就是全部清空，下次開啟再重新下載。

### 其他分頁：reload 規則

- 每個 dashboard 分頁（`OfflineLifecycle`）聽四種訊號：pref 的 `storage` 事件、`futari-offline` 廣播、`pageshow`（bfcache）、`visibilitychange` → visible。
- 訊號來時重讀 pref：pref 關、而且目前的 controller 是 `/sw.js` → `location.reload()`，放掉舊 SW 的控制。
  - `getRegistrations()` 裡還有 `/sw.js`（對方還沒 unregister）時，reload 回來還是被控制，所以**略過、不消耗防迴圈護欄**；unregister 之後的廣播會再觸發一次。沒有 `BroadcastChannel` 的環境 1s 後自己再查一次。
  - 防迴圈：sessionStorage 存一個時間戳（不存 URL），10s 內最多 reload 一次；只有真的 reload 才設。
- 關閉的那個分頁自己在完整關閉之後也跑同一條規則（inline，不進佇列）——Android 殼只有一個 WebView，靠這條放掉控制。
- `ReconnectRefresh` 在 `router.refresh()` 前套同樣的判斷，成立就 reload 取代 refresh。
- 隱私不靠 reload 的時機：寫入閘門已經先擋住了；reload 只是結束控制。

### 基本 SW（web，toggle 關，#1674）

toggle 關的 web 使用者（不含 iOS／Android 殼：那裡由 #1672 的看門狗＋殼內 `offline.html` 負責，iOS 殼也沒有 SW），dashboard 掛載時註冊 `/sw-basic.js`。它只做一件事：導覽失敗或卡住時，在原本的網址回應一頁 Futari 的離線頁。

- **產生方式**：`prebuild`（`scripts/build-web-offline-basic.ts`）用殼內離線頁同一個 renderer 的 web target 產生 `public/offline-basic.html`，算出它的 SHA-256，寫進 `public/sw-basic.js` 的 bytes 與 cache 名 `offline-basic-<hash>`；兩檔都 gitignore。文案一改，worker bytes 就變，瀏覽器下次更新檢查就裝新的。殼內的 `out/offline.html` 逐 byte 不變（測試守）。
- **離線頁**：四語烤進同一份 HTML（語系先看 `lang` cookie 的四語白名單，再看 `navigator.languages`）；探測同源 `/api/ping`，只有 `204 && !redirected` 算通，通了 `location.reload()`；探測節奏與「失敗的自動返回 2 次就停」沿用殼內那份規則。只在支援 SW、且 pref 不是開時顯示「下次連上網路後，可以到『設定 › 離線瀏覽』打開」。文字只來自烤進去的區塊，script 只切換屬性；不讀 `location` 的任何欄位。回應標頭：CSP `default-src 'none'`、inline script 只靠 `sha256-` hash（hash 由 `prebuild` 寫進 `.offline-basic.build.json`，`next build` 讀不到就直接失敗）、`connect-src 'self'`、`frame-ancestors 'none'`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`no-store`。
- **worker 規則**（`scripts/sw-basic-worker.ts`）：
  - install：只在拿到 200、`text/html`、沒被轉址、bytes 的 hash 對得上時才存；否則 install 失敗（sign-in 頁、captive portal 永遠不會變成「離線頁」）。
  - activate：刪掉自己以外的所有 cache（舊 `/sw.js` 的 `dynamic-v1`、`static-v1`、precache、同意標記）、刪 `serwist-expiration`、關 navigation preload、`clients.claim()`。
  - fetch：只回應同源 GET 導覽。`/auth/*`、`/sign-in`、`/<locale>/sign-in`、非 GET 導覽、所有非導覽請求**都不 `respondWith`**，原封不動到網路。GET 導覽與 8s 賽跑，網路錯誤或逾時就給離線頁。
  - 防迴圈：因**逾時**給了離線頁的導覽，記下 pathname 的 SHA-256（不含查詢字串、不存網址）與時間；2 分鐘內再導覽到同一 pathname 就不設逾時、等網路。用到的網路回應會清掉這筆。慢但會通的頁面第二次一定進得去。
  - 從不 `cache.put` 網路回應；cache 被別人刪掉後也不會重建它。
- **client**（`lib/offline/lifecycle.ts › ensureBasicWorker`）：pref 關的掛載先跑掛載 sweep（保留基本 SW 與 `offline-basic-*`），只有在沒有任何註冊的 active worker 是 `/sw-basic.js` 時才 register，等 `activated`（上限 10s）。不只信 activation：刪掉 `offline-basic-*` 以外的 cache、清 `serwist-expiration`、確認 cache 裡真的有離線頁；沒有就 `registration.update()` 一次，還是沒有就完整關閉——使用者不會比 #1674 之前更糟。register 失敗或逾時同樣完整關閉。每一步都先重讀 pref（S1 的佇列規則），使用者這時按下的「開」不會被它推翻。
  - Settings 關閉：完整關閉（連基本 SW 一起清）→ reload 規則 → 重新註冊基本 SW。
  - Settings 開啟：`/sw.js` 取代基本 SW（同一個 scope），看到 `/sw.js` activated 之後刪掉 `offline-basic-*`。`/sw.js` 本身不變。
  - 登出的「unregister 所有 SW」也會拿掉基本 SW；下一次 dashboard 掛載再註冊回來。登入頁 sweep 不動它。
  - 被基本 SW 控制的分頁不受 reload 規則影響（規則只看 `/sw.js`）。toggle 顯示的狀態仍然只看 pref，不看 scriptURL。
- **kill switch（回滾）**：`lib/offline/swBasicMode.ts` 改成 `'kill'` 並部署。產生的 `/sw-basic.js` 變成刪掉自己的 cache、unregister 自己、**不導覽也不 reload 任何分頁**的 worker；client 端所有關閉路徑改走完整關閉，不再註冊 `/sw-basic.js`。**單純 revert 不是回滾**：已安裝的 SW 在自己的 script 404 時仍會繼續存在、繼續回應導覽。
  - **失效的樣子**：revert 之後一切看起來正常（部署綠、新使用者沒有 SW），但已經裝了基本 SW 的人斷線時照樣看到離線頁，而且這頁的文案再也不會更新。
- **`/api/ping`**：GET／HEAD 回 204、`no-store`；不驗身分、不碰 DB。proxy 以完全相等（`===`）放行、在任何 `getUser()` 之前；`/api/ping/x` 仍受保護。proxy matcher 排除 `sw-basic\.js$`、`offline-basic\.html$`（錨定，`/sw-basic.jsx` 這類仍經過 proxy）。

### 掛載 sweep 與登入頁 sweep

- **pref 關的 dashboard 掛載**跑 `sweepOfflineLedgerData()`：先刪同意標記 → unregister 除了 `/sw-basic.js`（#1674）以外的 SW → 刪除了 `offline-basic-*` 以外的 cache → 清 serwist-expiration；不廣播、不動 pref。reload 前漏寫的任何東西，下一次掛載就清掉。web 上接著確保基本 SW（見上一節）；kill mode 時改跑完整關閉。
- **pref 開的 dashboard 掛載**先做使用者綁定：有 session 且 hash ≠ owner → 完整關閉＋reload；pref 開但沒有 owner（#1673 之前開啟的人）→ 清一次 `dynamic-v1`、`static-v1` 與紀錄，再綁定目前的人、pref 保持開；**沒有 session**（離線且 token 過期）→ 什麼都不做（猜錯會清掉正當使用者的離線資料，交給登入頁 sweep 處理下一個人）。owner 相符（或剛綁定）之後才重建同意標記，再 register `/sw.js`；逾時不寫 pref、不完整關閉，下次掛載再試。
- **登入頁 sweep**（`app/[locale]/sign-in/OfflineSignInSweep.tsx`，不改 `SignInButton.tsx`）：到登入頁的人（包括沒登出就過期的 session）先刪同意標記，再刪 `dynamic-v1` 與 serwist-expiration 紀錄；保留 precache、SW 與 pref，登入後由綁定決定、也只有它會重建標記。仍登入、已開啟的人打開 `/sign-in` 也會被清掉 `dynamic-v1`，之後逛 dashboard 會再補回（接受）。

---

## 實作落地點

`next.config.ts`（Serwist 設定、離線頁標頭與 build 守門）/ `app/sw.ts`（runtime caching rules + precache manifest）/ `scripts/build-web-offline-basic.ts`、`scripts/sw-basic-worker.ts`、`scripts/build-native-offline-page.ts`（web target）/ `lib/offline/{swBasicMode,offlineBasicHeaders}.ts` / `app/api/ping/route.ts` / `proxy.ts`/ `lib/offline/preference.ts` / `lib/offline/swControl.ts`（完整關閉、sweep、佇列、reload 規則） / `lib/offline/swGate.ts`（SW 寫入閘門） / `lib/offline/lifecycle.ts`（掛載、開、關、使用者綁定） / `app/[locale]/sign-in/OfflineSignInSweep.tsx`（登入頁 sweep） / `app/(dashboard)/settings/_components/{LogoutButton,DeleteAccountButton}.tsx` / `lib/hooks/useOnlineStatus.ts` / `app/(dashboard)/settings/_components/OfflineBrowsingToggle.tsx` / `app/(dashboard)/_components/{OfflineLifecycle,ReconnectRefresh}.tsx` / `app/(dashboard)/_components/ContextStrip.tsx`（離線橫幅已併入 ContextStrip 的 priority-1 分支，沒有獨立的 OfflineBanner 元件） / `app/offline/page.tsx`

---

## 風險與已知限制

1. **iOS Safari standalone 模式 SW 行為**：iOS 16.4+ 才較完整支援 SW 在 standalone 模式下；更舊版本加到主畫面後 SW 不啟動 — graceful degrade（使用者就是看不到 cache、跟現況一樣）
2. **Chunk hash 變動 → 強制更新**：`skipWaiting + clientsClaim` 確保新版 SW 立刻接管；使用者正在編輯 AddSheet 時若 SW 強更會丟掉未送出的 form state（記帳 form 體積小、重打成本低，可接受）
3. **Cookie-based auth + SW cache**：HTML 含 PII；登出／刪除帳號的完整關閉、使用者綁定、登入頁 sweep、SW 寫入閘門是防線；測試矩陣必含「同裝置連續登入兩個帳號」與「沒登出就換人」場景
4. **使用者刪了 PWA 但 SW 還在原網站**：PWA 移除不會 unregister origin 上的 SW；下次進 dashboard 時，pref 關就由掛載 sweep 移除（不會反過來把 toggle 打開）
5. **已接受的殘餘風險（#1673）**
   - 離線時，拿到一台已開啟的裝置的人，不需要 session 就能打開它 cache 住的頁面。這是離線瀏覽本身的性質。
   - 跨分頁：A 分頁在等 `/sw.js` 啟用（最多 15s，pref 還沒寫）時，B 分頁 pref 關的掛載可能把 A 正在安裝的註冊 unregister 掉；A 逾時、完整關閉並顯示錯誤。這是往關的方向失敗，不留東西，使用者重開一次即可。
   - 過渡期：已開啟的使用者在 SW 更新到有閘門的版本之前（release 後第一次進 dashboard 的幾秒內），關閉只有 reload 與 sweep 兩道保護；reload 後的掛載 sweep 會清掉這段期間寫入的東西。
   - 仍登入、已開啟的人打開 `/sign-in`，`dynamic-v1` 會被登入頁 sweep 清掉，之後再補回。

---

## Acceptance criteria

| 平台 | 場景 | 期望 |
|---|---|---|
| Web（非殼） | 第一次進 dashboard（toggle 預設關） | 只註冊 `/sw-basic.js`；`caches.keys()` 只有 `offline-basic-<hash>`；斷線再導覽看到 Futari 離線頁（含「設定 › 離線瀏覽」提示）（#1674） |
| Web（非殼） | toggle 關、網路卡住（連得上但不回應） | 約 8s 內出現離線頁；網路恢復後約 5s 內自己 reload 回原頁 |
| Web（非殼） | toggle 關、某頁固定 12s 才回 | 最多一次離線頁，之後進得去，不反覆 reload |
| Web（非殼） | toggle 關、`/auth/callback`、`/sign-in`、POST 導覽 | 基本 SW 不回應，8s 之後仍到網路 |
| Web（非殼） | toggle 關 → Settings 開啟 | `/sw.js` 接手；沒有 `offline-basic-*` cache；toggle 開、無錯誤 |
| Web（非殼） | kill switch 部署後 | 沒有任何註冊、沒有 `offline-basic-*`；下一次導覽到網路；不 reload |
| iOS／Android 殼 | toggle 關 | 不註冊任何 SW（殼內離線頁由 #1672 負責） |
| 任意平台 | Settings 開啟 toggle | SW register 成功；開始 cache |
| 任意平台 | Settings 關閉 toggle | SW unregister；所有 cache 與 serwist-expiration 紀錄清空；其他還被 `/sw.js` 控制的分頁 reload 一次，reload 後的掛載 sweep 之後 DevTools 看不到 cache 與紀錄 |
| 任意平台 | 切換進行中連點 | 第二次點擊被 disable，無中間態殘留 |
| 任意平台 | 手動清 localStorage 後進 settings 頁 | toggle 顯示關（pref 是唯一依據）；掛載 sweep 移除殘留的 SW 與 cache，**不會**把 toggle 打開 |
| 任意平台 | toggle 關、已開 dashboard 後斷線 | 顯示「離線中・恢復連線後會自動更新」；恢復連線後 banner 收合消失並 refresh |
| 任意平台 | 斷線不到 2s 就恢復（Wi-Fi ↔ 行動網路切換） | banner 完全不出現 |
| Chrome desktop | toggle 開、飛航模式開已 cache 頁 | 顯示 cache + offline banner |
| Chrome desktop | toggle 開、飛航模式開未 cache 頁 | 顯示 empty state |
| iOS 16.4+ Safari（standalone） | toggle 開、飛航模式開 dashboard | 顯示 cache + offline banner |
| iOS 16.3 以下 | toggle 開、飛航模式 | 看到瀏覽器離線頁（graceful degrade） |
| 任意平台 | toggle 開、A 登出 → B 登入 → 開 dashboard | 看到 B 的資料，無 A 的 PII 殘影；登出時 pref 已關、無 cache、無紀錄、無 SW 註冊；toggle 顯示**關**（#1673） |
| 任意平台 | toggle 開、A 的 session 沒登出就失效 → B 在同一瀏覽器登入 | 登入頁 sweep 清掉 A 的 `dynamic-v1` 與紀錄；B 的第一次 dashboard 載入因 owner 不符完整關閉，toggle 顯示關 |
| 任意平台 | 登入頁 | 刪同意標記、`dynamic-v1`、serwist-expiration 紀錄；precache、SW、pref 不動 |
| 任意平台 | toggle 開、線上 → 拔網路 → 重整 dashboard | 3s 後顯示 cache + banner |
| 任意平台 | iOS PWA：弱網後切背景 30s+ 回前景 | 自動 `router.refresh()`，不卡舊資料 |

---

## 撤回紀錄

**「toggle 是 per device、跟登入帳號脫鉤，登出時不變」——v0.14.0 寫下，#1673（v1.7.3）撤回。**

原本的推論：SW 是裝置能力，所以開關屬於裝置；登出只清 `dynamic-v1` 就能防止下一個人看到上一個人的頁面。這條推論在「SW 只有在使用者明確開著時才會寫」的前提下成立，但前提不成立：

- 登出只刪 `dynamic-v1`，SW 還註冊著、pref 還開著，舊分頁、`ReconnectRefresh`、Android 殼唯一的 WebView 都還被同一個 SW 控制，登出前後抓的頁面又被寫回去；
- `serwist-expiration` 的 IndexedDB 一直留著完整 URL（含查詢字串）；
- Settings 的校準把「還有 SW」當成「開著」，關掉的裝置會自己把 toggle 打開。

**失效的樣子**：沒有任何錯誤。關掉離線瀏覽或登出的裝置，`dynamic-v1` 在背景裡安靜地被補回來，下次打開 Settings 甚至顯示「已開啟」。只有打開 DevTools 看 Cache Storage 才看得出來。

所以現在：開關仍存在這台裝置上，但綁定開啟它的使用者；登出、刪除帳號一律完整關閉；寫入受同意標記控制。引用舊規則的段落（Scope、Locked decisions、Settings 頁開關、Sign-out flow、風險、Acceptance）都已同步改寫——下次有人從「SW 是裝置能力」重新推出「登出不用關」，就是這條撤回在擋的那個錯。

**「toggle 關就不註冊任何 SW」——v0.14.0 寫下，#1674（v1.7.3）撤回。**

原本的推論：cache PII 是裝置端的隱私決定，所以沒開的人不該有 SW。前半句仍然成立，後半句把「有 SW」和「存帳本頁面」綁在一起了。基本 SW 只存一頁不含任何個人資料的靜態離線頁，而且在 activate 時主動刪掉 opt-in 的 cache——它讓沒開的人斷線時看到 Futari 而不是瀏覽器的錯誤頁，不改變誰的帳本會留在裝置上。

**失效的樣子**：之前沒有錯誤，只有體驗：沒開離線瀏覽的 web 使用者（幾乎所有人）斷線時看到瀏覽器的「沒有網際網路」，網路卡住時則是一頁白、等很久。

所以現在：「有沒有開離線瀏覽」仍然只看 pref；有沒有 SW 不再是它的代理指標。

---

## 未來擴展

- **離線寫入**：AddSheet / IncomeSheet 在離線時暫存 IndexedDB queue，上線後 Background Sync 補送
- **IndexedDB shadow store**：完整同步 transactions / incomes 到 client，離線可分頁可搜尋
- **Push notification**：定期收入 pending 到期、settlement reminder
- **iOS 16.3 以下退場補強**：用 localStorage 暫存核心資料 fallback 顯示（如果統計顯示 user base 還有顯著比例）
