# 順心堂系列套件

有種智慧實驗室「順心堂系列」iOS App 共用的世界觀、主視覺、UX 慣例與程式元件。
開新 App 時，把 `Support/` 整包放進專案，再照 `Templates/` 改寫開場、開箱介紹、關於頁。

已出的作品：

| App | 這攤在做什麼 | 三兄弟的擔當 |
|---|---|---|
| Catch-22 順心堂 | 兩難時幫你喬事：滑動記下好處／顧慮，時間到開堂結算 | 阿正＝衝鋒、角頭＝把關、阿和＝和事佬 |
| 生活盲盒 | 無聊、沒力、焦慮時抽一個五感小任務，玩更無聊的小事，學會「懂活」 | 阿正＝動手、角頭＝眼力、阿和＝陪伴 |

---

## 1. 世界觀

- **順心堂**：三兄弟開的「堂口」，專門陪人處理生活裡卡住的事。每個 App 是堂口開的一攤新生意。
- **出品**：有種智慧實驗室　*Kind of wisdom, kind of love.*
- 三兄弟的名字、造型、顏色固定不變；擔當與台詞可依 App 調整。

| 成員 | 造型 | 顏色 | 個性 |
|---|---|---|---|
| 阿正 | 番茄橘方塊，有手有腳 | `#F0643F` | 個性直、手比腦袋快、衝第一 |
| 角頭 | 鈷藍三角，一字瞇眼（另外兩位是圓點眼） | `#3A5BD9` | 話不多、眼很利、負責把關 |
| 阿和 | 芥末黃星芒 | `#F4C23C` | 和事佬、最會陪人、會講好聽話 |

三兄弟一起出場時的排列：**角頭在左、阿和在中間（較小、略高）、阿正在右**（`CritterGang`）。

## 2. 主視覺

**剪紙拼貼＋蠟筆紋理**：所有形狀都是手剪紙片（`PaperShape`，邊緣帶一點不規則），角色上有斜向蠟筆筆觸，動畫時邊緣會輕微抖動（line boil）。

### 色票（`Support/Palette.swift`，淺色／深色）

| 用途 | 淺色 | 深色 |
|---|---|---|
| 背景（紙） | `#F4EFE6` | `#141414` |
| 卡片 | `#FFFCF6` | `#232220` |
| 墨（主文字） | `#161616` | `#F4EFE6` |
| 次要文字 | `#5E5850` | `#A9A39A` |
| 主按鈕（墨黑貼紙） | `#161616` | `#F4EFE6` |
| 番茄橘（阿正） | `#F0643F` | `#FF7650` |
| 鈷藍（角頭） | `#3A5BD9` | `#6F8BFF` |
| 芥末黃（阿和） | `#F4C23C` | `#FFD04F` |
| 草綠 | `#2E9E5E` | `#45C27B` |
| 梅紫 | `#A64CA6` | `#C76BC7` |

- **不用警告紅**表示錯誤或負面：顧慮、沒完成都不是錯。刪除動作例外。
- 文字放在黃色上用深墨，放在其他角色色上用紙白（`CritterKind.onColor`）。

### 字體

系統字（SF Pro／蘋方），**不用圓體**。標題用 `.black`／`.heavy`，內文用 `.medium`／`.semibold`，次要說明用 `inkSoft`。

### 形狀與元件

- 卡片：`.softCard(seed:)`，紙色剪紙片＋一圈淡墨線（`Palette.hairline`）。
- 按鈕：`CalmButtonStyle()` 墨黑貼紙（主要）、`.paper` 紙色貼紙（次要）、`.quiet` 純文字（最輕）。
- 小名牌：`.paperTag(fill:foreground:)`。
- 背景：`PageBackground()`，紙色加邊緣的彩色剪紙碎片與墨點，中間保持乾淨。
- 慶祝：`ShapeBurst(trigger:)` 幾何彩紙噴發。
- 對話：`SpeechBubble(line:)`，角色＋名牌＋剪紙泡泡。
- **錯位陰影的決定**：Catch-22 原本用墨色錯位陰影；從生活盲盒起改為**平貼＋淡墨線**，新 App 沿用平貼版（`Support/Palette.swift` 已是平貼版）。

### App Icon

墨黑底 `#161616`＋剪紙蠟筆風的三兄弟，加上邊緣幾顆灰色小紙屑。主體要大、一眼看得懂這個 App 在做什麼，例如生活盲盒是阿正從藍色禮物盒裡頂開蓋子。

## 3. UX 慣例（系列一致）

| 項目 | 做法 |
|---|---|
| 開場 | 三兄弟依序彈出來、一起跳一下，約 2 秒後淡出（`Templates/SplashView.swift`） |
| 首次開啟 | 開場後約 2.4 秒自動出現介紹頁：三兄弟各一頁＋結尾頁，可「略過」，選單可重看（`Templates/OnboardingView.swift`） |
| 導覽 | 單一 `NavigationStack`，不用底部分頁 |
| 主選單 | **左上 `ellipsis.circle.fill`**：外觀（跟隨系統／淺色／深色）、音效、分隔線、重看介紹、關於本 App |
| 主要動作 | 右上（Catch-22 是「＋」、生活盲盒是「收藏」） |
| 輸入 | sheet；「取消」在左上、「完成」在右上 |
| 儀式／慶祝 | 全螢幕（結算、相信直覺、完成撒花） |
| 關於頁 | sheet：主視覺（三兄弟＋App 名＋「順心堂出品」名牌＋標語）、段落卡、堂口成員、玩法、規則一條、外觀與音效、重看介紹、出品資訊（`Templates/AboutView.swift`） |
| 外觀 | `.appAppearance()` 套在根畫面，也要套在每個 sheet／fullScreenCover |
| 音效 | 系統音效、跟著靜音開關、選單可關閉（`Support/SoundFX.swift`） |
| 觸覺 | `.sensoryFeedback`：選擇用 `.selection`、完成用 `.success` |
| 語系 | 繁體中文（台灣）；`.environment(\.locale, Locale(identifier: "zh_Hant_TW"))`；日期用 `Date.twShort` 等，週一為一週開始 |
| 無障礙 | 角色 `accessibilityHidden`；泡泡合併成「某某說：……」；不能只靠滑動，要有按鈕替代 |

## 4. 版面與文案原則

- **一個畫面最多三個閱讀重點**。引導性文字寧少勿多，同一畫面不要好幾個地方都在講話。
- **不給壓力**：不倒數、不扣分、沒有連續紀錄懲罰、隨時可以離開；不顯示即時分數。
- **台灣口語**：「早安」「午安，吃飽了沒？」「今天辛苦了」，避免「下午好」「視頻」「質量」這類中國用語。
- **語氣**：溫馨，帶一點點任性的台式幹話，力道不用太大。
  - 「這 3 分鐘沒有生產力，所以特別珍貴。」
  - 「今天的 KPI：做一件沒用的事。已達成。」
  - 「擔心不丟臉，講出來就對了。」
- **規則一條**：每個 App 的關於頁都有一條「堂規／盒規」，最後拍板的永遠是使用者。
- 操作指示要一個動作、不讓使用者再做選擇（不出現「或」）。

## 5. 技術

- Swift 5.9+／SwiftUI／SwiftData，iOS 17 以上，iPhone 直式。
- Xcode 16「資料夾同步」專案格式；權限說明放在專案最外層的實體 `Info.plist`（`INFOPLIST_FILE = Info.plist`），避免舊設定蓋掉造成閃退。
- 資料只存在手機裡，不上傳。

## 6. 套件內容

```
Support/
├─ Palette.swift        色票、PaperShape、softCard、paperTag、CalmButtonStyle（平貼版）
├─ Critter.swift        三兄弟的繪製與動畫、CritterGang
├─ PlayfulShapes.swift  幾何形狀、背景剪紙碎片、ShapeBurst 彩紙
├─ Appearance.swift     外觀切換
├─ SoundFX.swift        系統音效＋開關（效果清單依 App 調整）
├─ Story.swift          世界觀常數、三兄弟名字與擔當、SpeechBubble（新 App 改這裡）
└─ Components.swift     PageBackground、分享面板、Haptics、台灣日期格式
Templates/
├─ SplashView.swift      開場
├─ OnboardingView.swift  首次介紹（生活盲盒版文案，改成新 App 的）
└─ AboutView.swift       關於頁（生活盲盒版文案，改成新 App 的）
```
