# #1854 — 套用新主視覺（手機帶狀區＋桌面欄）

素材來自 PR #1855（分支 `design/inbox/1854-hero`），這裡是套用後的驗證證據。畫面都是本機 `next build` + `next start` 的 `/zh-TW`，headless Chromium（Playwright），沒有登入任何帳號；PostHog、Sentry、Supabase、GA 的請求都擋掉了，所以不會送出任何事件。

- `before-*` ＝ main（5e2ebcf）；`after-*` ＝ 這個分支。
- `before-390.png` / `after-390.png`：390×844，DPR 3，縮成 780 寬。
- `before-1440.png` / `after-1440.png`：1440×900，DPR 1。
- `after-dots-{390,768,1024,1279}.png`：光點動畫凍結在 12%（不透明、還在起點）時，只截插畫區。390 是手機帶狀區，768 以上是右欄。1280 以上改由手機 mock 發光點，插畫上的三顆是 `display: none`，所以沒有 1440 那張。
- `{before,after}-signin-{390,1440}.png`：`/zh-TW/sign-in` 的開發日誌插畫（`BlogSection` 也用 `illustration-hero.png`，換檔後它跟著變）。
- `network-{before,after}.json`：各寬度的圖片請求（CDP `encodedDataLength` ＝ 實際傳輸 bytes）。

數字與解讀在 PR 內文。
