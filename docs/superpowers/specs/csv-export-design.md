---
last_updated: 2026-10-14
status: shipped
first_shipped_in: v0.12.0
updates:
  - v1.6.3: 範圍改為「viewer 待過的章節」（不再是整個 group 的全部章節）；文字欄一律加引號、像公式的開頭加 `'`；group 反查改走 `getActiveGroupForUser`；每次匯出記一筆 `transactions_exported`（#1290）
  - v1.7.3: 範圍改為「viewer 能回看的每一段章節」，跨帳本；加入進帳與結算、幣別與原幣欄、我的／對方分攤、狀態與章節欄；名字取自該列章節；不再需要目前有帳本，沒有帳本的人從 /onboarding/past-times 匯出（#1460）
related_specs: [csv-import, transactions, epoch-readonly, trip-multi-currency, authorization, observability, after-leaving]
related_issues: ["#37", "#48", "#1290", "#1460", "#1612"]
---

# CSV 匯出

> 讓使用者把自己待過的每一段章節裡的支出、進帳與結算帶走。落在「信任宣示」頁而不是設定選單裡，因為它要回答的不是「我怎麼匯出」，是「我的資料到底是不是我的」。

---

## 為什麼

換 app 最大的障礙是「多年的資料怎麼辦」——這件事對留下來的人一樣重要。**能隨時帶走**是願意把家庭財務交出去的前提，不是離開時才用得到的功能。

所以入口不在 `/settings` 的功能清單，在 `/settings/trust`（信任宣示頁，#48）。另外兩個入口用同一支 hook（`useTransactionsExport`）、同一個範圍：離開流程第 3 張卡的「先匯出」（#1611），以及沒有任何帳本的人在 `/onboarding/past-times` 的匯出鈕（#1460——dashboard layout 會把沒有帳本的人送去 /onboarding，他們到不了信任頁）。同一頁講的是加密、資料歸屬、不賣資料；匯出鈕是那些宣稱的可驗證版本——說「你的資料是你的」，旁邊就放一個把它拿走的按鈕。

這也是 [csv-import](csv-import-design.md) 的鏡像：匯入接住從別的 app 來的人，匯出保證從這裡離開的人不會被扣住。兩邊都成立，「不鎖住使用者」才不是一句話。

## 範圍

`GET /api/export/transactions` → 一份 CSV，涵蓋 **viewer 能回看的每一段章節**（跨帳本）裡的三種紀錄：

- **支出**：active `CashTransactions`，含 pending（附狀態），含旅行結束時折進主帳的摘要列；**不含** `TripExpenses`（摘要列已經代表它們，兩者都匯會重複計算）。
- **進帳**：active `IncomeTransactions`。
- **結算**：active `Settlements`（含出遊結束時折進主帳的那一筆，`note` 是出遊名稱）。

每張表都只取 `deleted_at IS NULL`：編輯是 soft delete + insert，舊版本不能出現。

實作落地：`app/api/export/transactions/route.ts`（路由 + 信任邊界）、`lib/db/queries/export.ts#getLedgerExportForViewer`（範圍、每列的章節、名字）、`lib/exportShares.ts`（分攤欄）、`lib/csv/transactions.ts`（CSV 組裝）、`app/(dashboard)/settings/_components/useTransactionsExport.ts`（三個入口共用）。

十五個欄位：類型（支出／進帳／結算）、日期、說明、金額、幣別、原幣金額、原幣別、分類、付款／收款人、給誰（結算）、我的分攤、對方分攤、狀態、備註、章節。欄位名與所有顯示值都走 i18n（`csvExport.*`），跟著使用者當前語言走。

- 說明：支出是描述，進帳是來源（`source`），結算留空；結算的 `note` 放備註。
- 分類：支出走 `t.category`，進帳走自己的 `t.incomeCategory`（兩套詞彙，`other` 兩邊都有）；兩者都只認自有鍵（`Object.hasOwn`，#1534），不認得的值原樣輸出。
- 狀態：只有支出有（已付清／待結算）。
- 章節：「開始 – 結束（進行中寫「至今」）・跟 對方／一個人」。
- 不輸出任何 id。

## 刻意不做的

| 不做 | 為什麼 |
|---|---|
| **不只當前章節**——匯出 viewer 能回看的所有章節，不套 `epochClause` | 「帶走自己的資料」的對象是這個人的歷史，不是當前這段關係。`/records`、stats、balance 都只看當前章節（[epoch-readonly](epoch-readonly-design.md)），匯出跨章節是**刻意的**——但只跨 viewer 能回看的章節，見下一節 |
| **跨帳本**——不只目前這本 | 自 #1611 起離開不搬紀錄，那段章節完整留在舊帳本；離開或被移除的人能唯讀回看它（#1612），匯出跟著同一條規則。v1.6.3 時「不跨帳本」是因為範圍綁在 `getActiveGroupForUser`，離開的人帶不走舊章節（見撤回紀錄） |
| **含 pending**——不過濾 `status` | pending 不進 balance，但它是使用者記下的東西。匯出的語意是「我記了什麼」，不是「帳算成什麼」 |
| 不含月回顧留言 | 留言的回看規則（#1685）與寫入鎖（#1695）另有議題；產品決定這版不匯出（2026-10-14） |
| 不含旅行中尚未結束的支出（`TripExpenses`）、出遊明細、愛物 | 旅行結束時才折成主帳的摘要列；出遊明細與愛物不是帳本紀錄。所以文案只說「支出、進帳、結算」，不說「所有紀錄」 |
| 不含 `asset_id` / `trip_id` / 任何 id | 這些是 app 內的關聯，對「用 Excel 打開看」沒有意義。要做資料遷移用的完整 dump 是另一個需求 |
| 不做排程 / 定期寄送 | 匯出是使用者主動的動作。背景自動寄檔案違反「不侵略」 |
| 不限次數 | 兩個人用的 app；未來真的被濫用再說 |

## 範圍：viewer 能回看的章節

> **撤回紀錄（v1.6.3，#1290）**：這份 spec 原本寫「匯出跨所有 epoch……看到這裡沒有 epoch 條件時不要『修好』它」。那句話只設想了「同一段關係的舊章節」，沒有涵蓋帳本換過成員的情形。「帶走自己的資料」這個理由支持的範圍是「viewer 待過的章節」，不是「整本帳的所有章節」。之後若又想把匯出放寬回整本帳，要先回答「viewer 沒待過的章節算不算他的資料」。
>
> **撤回紀錄（v1.7.3，#1460）**：v1.6.3 的版本寫「不跨帳本，只匯出 viewer 目前這本（`getActiveGroupForUser`）」。那是當時範圍的實作邊界，不是產品立場：它讓離開的人帶不走自己待過的章節，被移除且沒有帳本的人則拿到 404。現在範圍改用 #1612 的回看規則，跨帳本。不要因為「信任邊界原本是 `getActiveGroupForUser`」就把它改回去。

一段章節可以匯出，當且僅當（#1612 的規則，與 `listEpochsForViewer`／`pinAcceptable` 同一條，在 `getLedgerExportForViewer` 的 SQL 裡由 viewer id 自己算出）：

- viewer 名列在那段章節（`GroupEpochs.member_a_id` / `member_b_id`——當時的成員，不是 `OikosGroups` 的現任成員；swap 不開新章節、也不影響結果）；
- 那本帳還存在；
- viewer 現在仍是那本帳的成員，**或**那段章節已經關閉。

所以：離開或被移除的人拿得到他待過的已關閉章節；他不在的帳本的「進行中」章節（例如有人偽造出一列點名他的 open chapter）拿不到；之後才加入的人拿不到他加入前的章節。

一筆紀錄屬於哪段章節：

- 看 `created_at`（與 balance / `/records` 同一個定義）落在哪段 `[started_at, ended_at)`。
- **帳本最早章節之前的紀錄，算進最早那個章節。** 這是 `viewerChaptersClause` 的規則，**逐帳本**套用（「最早章節」是那本帳全部章節裡最早的，不是 viewer 能匯出的章節裡最早的）。所以每筆紀錄最多落在一段章節、最多匯出一次；它所屬的章節 viewer 不能匯出，它就不在檔案裡。資料庫端同一條規則 `public.viewer_in_chapter`（0080，RLS）也有這個例外。
  - 失效的樣子：若把這條拿掉、只看各章節的 `[started_at, ended_at)`，舊帳本最早的紀錄會安靜地從匯出檔消失；若對每段章節各套一次，最早的紀錄會重複出現。都沒有任何錯誤。
  - **撤回紀錄（#1611）**：這條原本的理由是「離開者會把自己的紀錄帶進新帳本」。#1611 起離開不再搬紀錄。程式保留（上面的情形仍依賴它），但不要再用「離開者帶過來的紀錄」來推論它的必要性，也不要只因為 #1611 就把它拿掉。
- 章節清單與紀錄在同一個 REPEATABLE READ 唯讀交易裡讀，描述的是同一個時刻。

沒有任何可匯出的章節（例如從來沒有帳本的人）⇒ 200，檔案只有標頭（fail closed）。

## 名字：人停在當時

付款／收款人、結算的「給誰」、章節欄裡的對方，都取自**該列所屬章節**（[after-leaving](after-leaving-design.md)「人停在當時」）：

- 已關閉的章節：關閉當時凍結的名字（`GroupEpochs.member_*_name`，0088；刪除帳號的人是「已離開的夥伴」）。沒有凍結到的，顯示「對方」（`t.common.partner`）。**絕不**讀 `Profiles` 的現在名字。
- 進行中的章節：現在的名字。
- 不在那段章節裡的人（理論上不會發生）：「對方」。

失效的樣子：沒有任何錯誤，離開的人匯出的舊章節出現對方之後改的名字。

## 分攤欄（我的分攤／對方分攤）

只有支出有，以百分比寫，從 viewer 的角度。

- `half` / `all_mine` / `all_theirs`：照 `lib/balance.ts#transactionDelta` 的語意對著**存下來的付款人**解讀（half 50/50；all_mine 付款人 100%；all_theirs 對方 100%），不牽涉身份位置。
- `weighted`：`split_ratio_a` 是「**現在**佔 a 位置的人」的比例。swap 與刪除帳號的升格會把整本帳的比例翻過來，同時對調仍在帳本裡的人的位置；離開（只有 member_b 能離開）與重新加入（acceptInvite 把人放在 member_b）只改位置、不翻比例。所以一個人**現在的位置**只有在他從該列的章節一路到進行中的章節都沒斷過（每一段章節都名列其中），而且現在仍有位置時，才能說明那一列的比例方向。
  - 該列章節的兩人中，有人符合 ⇒ 用他的位置推出兩邊的百分比（兩人都符合時必然一致）。
  - 都不符合（離開過、斷過再回來、刪除了帳號、升格後兩人都不在）⇒ **兩格留白**。不從章節序列去推。
  - 失效的樣子：照「現在誰是 member_a」直接讀比例時，離開的人在對方 swap 之後、或被重新邀回之後，會在自己的檔案看到對方的比例當成自己的——沒有任何錯誤。
  - 停止條件：如果之後有任何寫入路徑翻了 `split_ratio_a` 卻沒對調位置，或對調了仍在帳本裡的人的位置卻沒翻比例，這個推論就不成立，要先改這裡。

## 已知限制

- **幣別是那本帳現在的 base currency。** base currency 可以改（有紀錄時鎖住，但空章節之後可改），沒有歷史；舊章節的金額若是在另一個 base currency 下記的，檔案裡會標錯幣別。原幣欄（`original_currency` / `original_amount`）照存的寫。
- 留下的人之後在單人狀態刪除帳號，那段共同章節仍留給離開的人（孤兒帳本，#1701），可繼續匯出，直到離開的人也刪除帳號為止。保留章節裡明細、加密欄位與備註已去除，匯出內容（支出、進帳、結算）不受影響；名字顯示為「已離開的夥伴」。（2026-10-13 曾寫「整本刪除、離開的人再也匯不到」，2026-10-15 撤回，見 [account-deletion](account-deletion-design.md)。）建議離開前先匯出仍是好習慣，但不再是必要提醒。
- 旅行中尚未結束的支出、出遊明細、月回顧留言不在檔案裡（見上表）。
- Capacitor WebView 裡的 blob 下載未在真機驗證。

## 相容性決定

- **UTF-8 BOM + CRLF**：Excel 沒有 BOM 就會把中文顯示成亂碼；RFC 4180 要求 CRLF。兩者都是為了「雙擊打開就是對的」，不是為了規格漂亮。
- **日期用台北時區的 `YYYY-MM-DD`**：`transacted_at` 存的是 timestamp，直接輸出會讓跨日的紀錄看起來差一天。固定 `Asia/Taipei` 而不是使用者 locale——匯出的是紀錄本身，不該因為在國外打開就換一個日期。
- **排序**：事件日期（支出 `transacted_at`、結算 `settled_at` 的台北日期；進帳 `occurred_at`）遞減，同日再依 `created_at` 遞減。三種紀錄混排。
- **`Cache-Control: no-store`**：財務資料不進任何快取層。
- **試算表安全的文字欄**：說明（含進帳來源）、備註（含結算 note／出遊名稱）、類型、幣別、分類、人名、狀態、章節與標頭一律加雙引號；開頭（略過前導空白、換行、NBSP、全形空白與零寬字元之後）是 `=` `+` `-` `@`（含全形）的儲存格，或以 tab／CR 開頭的儲存格，前面加一個 `'`，讓試算表當成文字而不是公式。日期、金額與分攤百分比是程式產生的固定格式，不加引號，打開仍是日期與數字（日期若不是 `YYYY-MM-DD` 就當文字處理）。代價是這類儲存格在試算表裡看得到那個 `'`，而且再匯入 Futari 時 `'` 會留在文字裡。

## 信任邊界

範圍**只**由登入者的 id 決定，在查詢裡用 SQL 算出（上面「範圍」那一節）。route 不收任何參數，不從 request 拿 group id，也不從 `OikosGroups` 的現任成員推（那會把 viewer 沒待過的章節、或他已經不在的帳本的進行中章節帶出去）。也不再需要「目前有帳本」：沒有帳本的人（被移除者）拿到自己能回看的已關閉章節，什麼都沒有的人拿到只有標頭的檔案。

`getLedgerExportForViewer(viewerId)` 只能用登入者自己的 id 呼叫；它沒有別的授權檢查。見 [authorization](authorization-design.md)。

## 觀測

每次成功匯出送一筆 server 事件 `transactions_exported`（`captureServer`，distinct_id = viewer），屬性是 `row_count`、`expense_count`、`income_count`、`settlement_count`、`chapter_count`、`group_count`，**不帶任何紀錄內容，也不帶 id**（跨帳本之後，那些帳本可能是別人現在在用的）。它是稽核用途（誰、何時、匯出了多少），不是使用量指標；低數字是預期的。沒有匯出次數限制。

- 和所有 server 事件一樣，只在 prod 部署送出（見 [observability](observability-design.md)），而且 `captureServer` 失敗時不會擋下匯出。所以它是盡力而為的紀錄：**事件查不到，不代表沒有人匯出過。**

## Acceptance

真實資料庫的案例在 `__tests__/actions/exportChapterScope.test.ts`（本機 throwaway Postgres）。

- 雙人帳本的任一方匯出，拿到的是章節裡**兩人**的紀錄，不是只有自己付的
- viewer 待過的過去章節在檔案裡；viewer 加入之前、或離開之後的章節不在
- 離開的人：舊帳本裡他待過的那段已關閉章節，和他自己的新帳本，都在同一份檔案；留下的人之後的章節（單人、和新伴侶的）不在
- 被移除且沒有任何帳本的人：200，拿到他待過的已關閉章節
- 從沒待過任何章節的人：200，只有標頭；未登入 → 401
- 別人的帳本、點名 viewer 的「進行中」章節（viewer 不在那本帳）不在
- 軟刪除的版本不出現；帳本最早章節之前的紀錄出現且只出現一次
- 進帳、結算各自帶類型、人與標籤；pending 帶狀態
- 已關閉章節的名字是關閉當時的，之後改的名字不出現
- 分攤：A 70／B 30 的 weighted 列——(a) B 離開、C 加入、A 與 C swap 後 B 的檔案是 30%／70%；(c) A 的檔案是 70%／30%；(b) A（member_a）刪除帳號、C 升格後 B 的檔案留白；(d) A、C swap 後 A 離開、C 重新邀回 B，B 的檔案留白；(e) 接著 B swap 到 a，B 與 A 的檔案仍留白
- 文字欄以 `=` `+` `-` `@` 開頭（含前導空白）的儲存格，在試算表中顯示為文字；中文在 Excel 直接打開不是亂碼
