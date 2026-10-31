# #1852 — 首頁範例小卡（LandingExampleCard）

- 畫面：`/zh-TW`、`/zh-CN`、`/en`、`/ja` 首頁 hero，「登入」下方的一筆支出加分攤結果
- 檔案：`375-<locale>-scrolled.png`（捲到整張卡片進入畫面）、`375-zh-TW-first-screen.png`（第一屏，按鈕位置不變）、`768-zh-TW.png`、`1024-zh-TW.png`（卡片在文案欄裡）、`1280-zh-TW.png`（不出現）
- 來源：本機 `next build` + `next start`，Playwright headless Chromium，375×667 @2x（768、1024、1280 為 @1x）。卡片裡是示範資料，不是真實使用者的紀錄。
- 文案是 #1858 規格的四語建議版，待 Aria 定稿。

Issue：https://github.com/FREEDOMPJ2025/futari/issues/1852
