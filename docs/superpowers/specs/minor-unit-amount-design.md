---
last_updated: 2026-11-20
status: planned
related_specs: [domain-model, locale-currency, product, transactions, income, recurring, csv-import, csv-export, shortcut-pending, trip-multi-currency, group-outing, insurance, monthly-review, offline-browsing, realtime, observability, epoch-readonly]
depends_on: [domain-model, locale-currency]
related_issues: ["#1920", "#1399", "#1582", "#1482"]
---

# 金額存「該幣別的最小單位整數」

> **狀態：提案，尚未核准。** 方向是 Ray 定的（2026-11-19，見下面「決定」），這份只把方向落成設計，不重新討論方向。文中標「要 Ray 決定」的項目，Ray 回覆前都不算定案；每項都附建議與 Ray 沒回時的預設值。
>
> **這份跟 INDEX 寫作原則的差異**：INDEX 說 spec 不寫 PR 拆分。這份是給 Ray 拍板用的決策檔，所以「分階段計畫」一節暫時放在這裡；Ray 決定後，那一節搬去 plan，本檔只留決定與理由。
>
> **版本**：第 2 版（2026-11-20），回應第 1 輪獨立審查（REFUTED @`03e9c924`，PR #1947 的審查留言）。對照表在 §0。
>
> **行號**：repo 檔案以 `origin/main` `14dfe57`（2026-11-20）核對；`99e66d3..14dfe57` 沒有改到本文引用的任何檔案，所以第 1 版在 `99e66d3` 核對的行號仍然成立。Next.js 內部檔案以 `next@16.2.4`（`package.json:49` 鎖定）的 `node_modules/next/` 核對。

## 名詞（全文一致）

- **最小單位整數**：該幣別最小單位的整數。TWD／JPY 的 `1000` 是 1000 元；USD／CNY 的 `1000` 是 10.00。
- **整數元**：現在的做法。不分幣別，存的是使用者打的整數（USD 的 `45` 是 $45）。
- **小數位數（p）**：某幣別顯示與輸入時的小數位數（TWD 0、USD 2）。最小單位整數 ＝ 顯示值 × 10^p。
- **兩位小數帳本**：base currency 的 p 是 2 的帳本（現在是 USD、CNY）。
- **舊欄**：現有的金額欄（例如 `CashTransactions.amount`）。本設計保留它，語意永遠是「整數元」。
- **新欄**：本設計新增的 `*_minor` 欄（例如 `amount_minor`，型別 `bigint`），語意是最小單位整數。
- **舊 JS**：第 3 階段（§7）部署前就載入、還沒重整的前端程式（分頁、PWA、iOS／Android 殼的 WebView）。
- **舊伺服器程式**：第 3 階段之前的 server 程式。只有 Vercel 把舊頁面的請求導回舊部署時才會執行（§4.1）。
- **開放小數**：第 4 階段的開關。打開後，兩位小數帳本才能輸入、顯示小數。

---

## 0. 第 1 輪審查的回應

| 審查項目 | 這版怎麼改 | 位置 |
|---|---|---|
| P1 舊讀取放大 100 倍（Realtime 推新值給舊 JS） | 不再「就地 ×100」。改成**雙欄**：舊欄永遠是整數元，新欄是最小單位。舊 JS 只認得舊欄（Realtime payload 也是），所以讀不到最小單位；新 JS 只讀新欄。拿掉「帳本已切換」旗標（值的單位由欄名決定），所以也沒有「balance 先到、旗標後到」的混用。第 4 階段的「開放小數」開關只管輸入與顯示，不決定欄位單位 | §4 |
| P1 轉換與回滾缺不變條件 | 欄位 × 階段的讀寫表；所有寫入共用同一個鎖（帳本列）並在交易內換算；回填只讀舊欄、只寫空的新欄，重跑不會重乘；舊欄保留到第 5 階段，在那之前回滾只要退程式；新欄用 `bigint`，加總先轉 `bigint` | §3.4–§3.8、§4.4 |
| P1 歷史幣別未知不可推定 TWD | 撤回「推定 TWD」。逐範圍列幣別來源與可信度，只轉高可信度；不確定的列新欄留 NULL，畫面照今天的樣子顯示；附對帳不變量與停止條件 | §3.2、§3.3、§3.6 |
| P2 尾差探針漏算加權偶數 | 撤回 `odd_split_rows`。改用與 `recalcGroupBalance` 同條件的帳本級比較（附錄 A Q4）。建議切換前的列沿用舊的進位單位，切換當下 balance 完全不變 | §5.3、附錄 A |
| P2 CSV 重匯與各入口 | 逐入口寫單位與相容方式；捷徑待處理沒有帳本，改成「確認時依目的帳本轉一次」；CSV 一律是顯示單位；去重 hash 程式裡沒有實作 | §5.5–§5.7 |
| 上線範圍：第 0 階段只濾句點會保留原錯 | 第 0 階段改成「整筆拒絕會產生小數的輸入、保留原值」，逐鍵、貼上、全形句點、IME 都算 | §7 |
| 待決的優先順序 | D 系列重排並新增 D12、D13 | §8 |

---

## 1. 決定與取代

**Ray 原話（2026-11-19）**：「不是這樣 資料庫存整數　但在顯示層 如果幣別是 twd 那就是整數　如果是 usd / 或其他有小數的幣別 就用兩位小數 例如 1000 當作 10.00」

**理解**（Paula 記在 #1920 的「## 決定」留言，與原話分開）：DB 仍存整數，單位改成該幣別的最小單位。TWD／JPY：1000＝1000；USD／CNY：1000＝10.00，使用者可以輸入兩位小數。這取代 #1399 決定 (a) 與 #1582 的「一律整數元」。

**為什麼要改**：外部回報（#1920 開頭）要輸入小數。現在主記帳的金額框把小數點吃掉：打 `12.5` 會變成 `125`（Dev B 在 #1920 的查證留言；原因在 `app/(dashboard)/_components/AmountInput.tsx:121` 的 `replace(/[^0-9]/g, '')`），等於多記 10 倍，而且沒有錯誤。

### 被取代的句子

下表是現在 repo 裡寫著「一律整數元」的地方。**這些句子在第 4 階段（開放小數）合併前都還是真的**（描述現況），所以這份提案不改它們；第 4 階段的 PR 要同時改。

| 出處 | 原句（節錄） | 取代成 |
|---|---|---|
| #1399 決定 (a)（2026-09-27 留言） | 「主帳本維持整數元，但依幣別顯示不同：資料與寫入路徑都不變，不需要 migration」 | 主帳本存最小單位整數；需要資料轉換（§3） |
| #1582「要做的」 | 「帳本欄位（CashTransactions／TripExpenses／Settlements）一律存整數元」 | 一律存該幣別的最小單位整數 |
| `docs/superpowers/specs/domain-model-design.md:21` | 「主帳本金額（交易、收入、結算、旅行）一律存「整數單位」，不分幣別（USD 存 $45 就是 `45`）；Outing 三張表……才用最小單位（USD 為分），只在 outing 結束 fold 成 Settlement 時換算成整數單位。」 | 主帳本與出遊都存最小單位整數；fold 不再換算單位 |
| `docs/superpowers/specs/locale-currency-design.md:242` | 「（帳本金額一律整數單位、不顯示小數；USD 2 位小數只用在出遊，見 #1582）」 | 小數位數依幣別（§2 的表），帳本與出遊相同 |
| `docs/superpowers/specs/product-design.md:76` | 「主帳本一律存整數單位（USD $45 = `45`，不存分）；只有 outing 表用最小單位……`currencyPrecision()` 只用於 outing」 | 同上；小數位數函式用在所有金額 |
| `docs/superpowers/specs/csv-import-design.md:117` | 「拒收 `1.50`（主帳本一律存整數單位，USD 也不存分；匯入一律整數……）」 | 依帳本幣別：兩位小數帳本收 `1.50`；零位小數帳本仍拒收（§5.6） |
| `docs/superpowers/specs/group-outing-design.md:77` | 「主帳本是整數單位，兩者不同，只在 outing 結束 fold 成 Settlement 時由 `minorToWhole` 換算」 | 兩者相同；fold 直接寫入，不換算 |
| `docs/superpowers/specs/trip-multi-currency-design.md:349` | 「主帳本與旅行金額一律整數單位：`convertWholeUnits`……outing 才用最小單位，fold 時走 `minorToWhole`」 | 換算改成「最小單位進、最小單位出」並考慮兩邊小數位數差（§5.8） |
| `docs/superpowers/specs/insurance-design.md:56` | 「上列四個金額欄位（含 `annual_premium`）都是這個幣別的整數單位」 | 要 Ray 決定（§8 D6）；建議同樣改成最小單位 |
| `lib/currency.ts:21-25`（`currencyPrecision` 的註解） | 「Main-ledger amounts are whole units for every currency (#1582)」 | 程式註解，跟著實作 PR 改 |
| `lib/currency.ts:87-94`（`formatLedgerAmountParts` 的註解） | 「never divided by 100 and shown without decimals……(#1399 decision (a))」 | 同上 |

**撤回的連帶**：#1582 留下的警告「Do not reintroduce a precision-aware converter on a ledger path」（`lib/currency.ts:120-124`）也一起失效。它擋的錯是「單位混用」，新設計要擋的是同一種錯。雙欄的好處是**欄名就帶著單位**：`amount` 一定是整數元、`amount_minor` 一定是最小單位，漏改的讀取點讀到 `amount` 只會少掉小數（差不到 1 元），不會差 100 倍；真正會差 100 倍的只剩「讀 `amount_minor` 卻當整數元顯示」，這個要靠型別與測試擋（§5.4）。

---

## 2. 資料模型

### 每個幣別的小數位數

| 幣別 | 小數位數 | 現況 | 備註 |
|---|---|---|---|
| `twd` | 0 | 0 | Ray 原話：TWD 是整數。ISO 4217 寫 2，刻意不照 |
| `jpy` | 0 | 0 | ISO 也是 0 |
| `usd` | 2 | 帳本 0、出遊 2 | |
| `cny` | 2 | 0（帳本與出遊都是） | 出遊的 CNY 也要轉換（§3） |

**放哪裡**：`lib/currency.ts` 已經有 `currencyPrecision`（`lib/currency.ts:26`），現在只認 USD、只給出遊用。建議把它改成這張表的唯一來源，所有格式化、輸入解析、換算都從這裡取。不另開檔，因為主帳本幣別清單 `CURRENCIES` 也在同一檔（`lib/currency.ts:4`）。

**日後加幣別**：在表裡加一列，同時決定小數位數。**一個幣別的小數位數一旦有資料就不能改**：改了等於整批資料差 10^n 倍，要再做一次 §3 的轉換。失效的樣子：有人把 TWD 改成 ISO 的 2 位，所有 TWD 帳本的 NT$1,000 瞬間顯示成 NT$10.00，沒有錯誤。所以表要附一行註解寫明「有資料後不可改」，並有測試把現有四個值釘住。

**旅行的自由文字幣別**：`Trips.default_currency`／`budget_currency`、`TripExpenses.original_currency` 是自由文字（`lib/db/schema.ts:618-620`、`641`），可以是 VND、EUR 等。表裡沒有的代碼怎麼處理，要 Ray 決定（§8 D2）。

### `lib/db/schema.ts` 的整數欄位

`integer` 欄位共 68 個（含非金額）。下表逐一標記；「幣別來源」一欄說明這個金額是哪個幣別，**不是帳本幣別的特別標出**。`numeric` 的匯率與公升數一併列出，因為換算會用到。

| 表 | 欄位（行號） | 金額？ | 幣別來源 |
|---|---|---|---|
| OikosGroups | `default_split_ratio_a`（66） | 否（百分比） | — |
| GroupBalance | `balance`（153） | **是** | 帳本 base（目前章節） |
| GroupBalance | `version`（154） | 否 | — |
| CurrencyRates | `rate`（170，numeric 10,3） | 否（匯率） | 已棄用，只留給舊旅行 |
| CashTransactions | `amount`（207） | **是** | 列所屬章節的 base |
| CashTransactions | `split_ratio_a`（209） | 否（百分比） | — |
| CashTransactions | `original_amount`（225） | **是** | **`original_currency`**（不是 base） |
| CashTransactions | `rate_snapshot`（226，numeric 10,3） | 否（匯率） | — |
| Settlements | `amount`（238） | **是** | 列所屬章節的 base |
| CarDetails | `purchase_price`（252） | **是** | 隱含帳本 base（沒有幣別欄） |
| CarDetails | `year`（256）、`initial_odometer`（259） | 否 | — |
| FuelLogs | `liters`（265，numeric）、`odometer`（267） | 否 | — |
| HouseDetails | `purchase_price`（282） | **是** | 隱含帳本 base |
| ChildDetails | `height_cm`（294）、`weight_g`（295） | 否 | — |
| PetDetails | `purchase_cost`（305） | **是** | 隱含帳本 base |
| PetDetails | `weight_g`（306） | 否 | — |
| PlantDetails | `cost`（316） | **是** | 隱含帳本 base |
| PlantDetails | `water_every`（317） | 否 | — |
| InsuranceDetails | `coverage_amount`（324） | **是**（未查證是否顯示為金額） | **保單 `currency`**（344） |
| InsuranceDetails | `payment_date`（325）、`term_years`（335）、`reminder_days_before`（347） | 否 | — |
| InsuranceDetails | `annual_premium`（332）、`sum_insured`（336）、`expected_maturity_amount`（338）、`account_value`（341） | **是** | **保單 `currency`**（344） |
| InvoiceImportSnapshots | `imported_amount`（383） | **是** | 電子發票，一律 TWD（雲端發票仍 blocked） |
| InvoiceImportRuns | 四個 `*_count`（415-418） | 否 | — |
| IncomeTransactions | `amount`（444） | **是** | 列所屬章節的 base |
| IncomeTransactions | `original_amount`（454） | **是** | **`original_currency`** |
| IncomeTransactions | `rate_snapshot`（455，numeric） | 否 | — |
| RecurringIncomeRules | `amount`（466） | **是** | 帳本 base（今天的排程與畫面都這樣解讀） |
| RecurringIncomeRules | `interval_months`（470）、`day_of_month`（471） | 否 | — |
| PendingIncomeOccurrences | `proposed_amount`（485） | **是** | 帳本 base |
| RecurringExpenseRules | `amount`（496） | **是** | 帳本 base |
| RecurringExpenseRules | `split_ratio_a`（498）、`interval_months`（502）、`day_of_month`（503） | 否 | — |
| PendingExpenseOccurrences | `proposed_amount`（517） | **是** | 帳本 base |
| PendingExpenseOccurrences | `proposed_split_ratio_a`（522） | 否 | — |
| MonthlyReviewSnapshots | `year`（537）、`month`（538） | 否 | — |
| MonthlyReviewSnapshots | `top_category_total`（543）、`largest_expense_amount`（546）、`recurring_total_income`（558）、`recurring_total_expense`（559） | **是**（凍結的彙總） | 該月所屬章節的 base |
| MonthlyReviewSnapshots | `recurring_events`（557，jsonb，每個元素的 `amount`）、`asset_breakdown`（562，jsonb，每個元素的 `total`） | **是**（jsonb 裡的數字） | 同上；寫入點 `drizzle/0093_review_snapshot_chapter.sql:194-232` |
| Trips | `budget_amount`（619） | **是** | **`budget_currency`**（自由文字） |
| TripExpenses | `amount`（638） | **是** | 旅行所屬章節的 base |
| TripExpenses | `original_amount`（642） | **是** | **`original_currency`**（自由文字） |
| TripExpenses | `split_ratio`（645） | 否 | — |
| Outings | `fold_amount`（676） | **是** | **出遊 `currency`**（666）；現在已是最小單位 |
| OutingExpenses | `amount`（708） | **是** | 出遊 `currency`；USD 已是分，CNY 還是整數元 |
| OutingExpenseShares | `share_amount`（722） | **是** | 同上 |
| OutingSettlements | `amount`（731） | **是** | 同上 |
| ImportBatches | 四個計數（747-750） | 否 | — |
| ImportErrors | `row_number`（762） | 否 | — |
| MonthlyReviewMessages | `year`（775）、`month`（776） | 否 | — |
| ShortcutPendingExpenses | `amount`（835） | **是** | **沒有帳本也沒有幣別**：這張表只有 `user_id`（`lib/db/schema.ts:831-841`）；值是捷徑送來的顯示單位。**不轉**（§5.5） |

另外未查證：`Assets.template_fields`（jsonb，`lib/db/schema.ts:192`）的 `number` 欄位可能被使用者當金額用（`TemplateAssetDetailClient.tsx:119` 直接 `toLocaleString`）。那是使用者自訂的純文字紀錄，不帶幣別，建議不轉換。

### 要補的欄位：章節的幣別

**現在沒有地方記「某一段章節當時的 base currency」**。`GroupEpochs`（`lib/db/schema.ts:92-110`）沒有幣別欄。CSV 匯出已經寫明這個缺口（`csv-export-design.md:106`：「舊章節的金額若是在另一個 base currency 下記的，檔案裡會標錯幣別」）。

建議第 2 階段（§7）加兩欄：

- `GroupEpochs.currency`：該章節的幣別。關章節時由 DB 函式凍結（跟 `member_a_name` 同一種做法）；目前章節的值跟著帳本 base。
- `GroupEpochs.currency_source`：值是 `closed_snapshot`（關章節時寫入）、`current`（目前章節）、`evidence_high`（§3.2 的高可信度證據回填）、`unknown`。`unknown` 時 `currency` 是 NULL。

既有章節怎麼填，見 §3.2。

> 照 `lib/db/schema.ts:106-108` 的規矩：新欄的 migration 必須先上 prod，認得新欄的程式才能部署；否則 `db.select().from(groupEpochs)` 會因為欄位不存在讓整個 dashboard 報錯。反過來，**舊程式不受新欄影響**：Drizzle 只會列出它認得的欄位。§3、§4 的雙欄設計就是靠這一點讓舊程式繼續跑。

---

## 3. 既有資料轉換

### 3.1 規模：未知

本設計**沒有使用任何 prod 資料**。帳本數、列數、歷史幣別分布、balance 差額都是**未知**。#1582 在 2026-10-07 公開過一筆舊的級距（當時 USD 帳本是個位數），一個多月前的數字，只能當參考。

需要 prod 唯讀查詢才答得出的問題、為什麼要查、答案會改變哪個決定、只回傳級距的 SQL，都整理在**附錄 A**，由 Paula 決定誰去查。

### 3.2 每一列的幣別從哪裡來

**先講一個可以證明的事實**：同一個章節裡，**未刪除**的現金、收入、結算列和進行中的出遊，一定是同一個幣別。

- 改 base 的動作 `setBaseCurrency` 在同一個交易裡鎖帳本列（`actions/currency.ts:35-57`），只要目前章節有任何一筆未刪除的現金、收入、結算或進行中的出遊就擋下（`actions/currency.ts:48` → `lib/db/queries/epoch.ts:98-123`）。
- 所以一筆列從建立到章節結束都還沒被刪，它活著的期間 base 不可能變。同一章節所有未刪除列都在同一段 base 下寫入。

**這個證明不涵蓋的**（審查 P1-3 指出的漏洞，第 1 版的探針只看現金表）：

- **已刪除的列**：檢查只數 `deleted_at IS NULL`（`lib/db/queries/epoch.ts:102,107,112,118`）。使用者把章節裡的帳全刪掉後可以改幣別，舊幣別的已刪除列留在同一章節。
- **檢查沒數到的表**：旅行與旅行支出、定期規則、待確認卡、月度快照、愛物購入價、捷徑待處理。它們可能是在上一個 base 下建立的。
- **已結束的章節**：知道「章節內未刪除列同幣別」，但不知道是哪個幣別——章節結束後 base 可以再改。
- **兩個方向都要查**：目前是 USD／CNY、過去是 TWD／JPY 的帳本；以及目前是 TWD／JPY、過去是 USD／CNY 的帳本。後者如果照目前 base 處理，過去的 $45 會一直被當 NT$45。

**每個範圍的幣別來源與可信度**：

| 範圍 | 幣別來源 | 可信度 | 第 2 階段怎麼處理 |
|---|---|---|---|
| 目前章節，現金／收入／結算／出遊的**未刪除列** | 帳本目前 base | **高**（上面的證明） | 轉 |
| 原幣欄 `original_amount`（現金、收入） | 該列的 `original_currency` | **高**（幣別就寫在同一列） | 依該列幣別轉，不看章節 |
| 出遊三表與 `fold_amount` | `Outings.currency` | **高**：建立出遊時從鎖住的帳本列抄 base（`actions/outing.ts:191`），fold 時幣別不同就擋（`actions/outing.ts:542`） | 依出遊幣別轉（USD 已是分，不動） |
| 保險金額欄 | 保單 `currency`（`lib/db/schema.ts:344`） | **高** | 依保單幣別轉（D6） |
| 已結束章節，章節內有 fold 出來的結算（出遊 `epoch_id` 指向該章節、`fold_amount` 非 NULL） | 該出遊的 `currency` | **高**：fold 結算是章節內的未刪除列，而 fold 當下出遊幣別必須等於 base（`actions/outing.ts:542`） | 轉；`currency_source = evidence_high` |
| 目前章節，定期規則、待確認卡、旅行與旅行支出、愛物購入價 | 帳本目前 base | **中**：可能在上一個 base 下建立，但**今天的畫面、排程與換算都已經當目前 base 用**（排程照抄 `r.amount`，`drizzle/0064_recurring_cron_taipei_date.sql:68`） | 照目前 base 轉。理由：轉換後使用者看到的數字和今天一樣；它們本來就以目前 base 繼續產生新紀錄，不轉會壞掉 |
| 已結束章節，只有其他出遊（沒有 fold） | 出遊建立當下的 base | **中**：只證明章節內某個時間點的 base | 不自動轉，列入 D4 |
| 已結束章節，有原幣列 | `rate_snapshot` 的量級（例：JPY→TWD 約 0.2、JPY→USD 約 0.007） | **中**：匯率是使用者自己填的，可能打錯 | 不自動轉，列入 D4 |
| 已結束章節，沒有以上證據 | 無 | **未知** | 不轉 |
| 任何章節的**已刪除列** | 無 | **未知** | 不轉（畫面本來就不顯示已刪除列；保留期滿由 pg_cron 物理刪除） |
| 月度快照（四個純量欄＋兩個 jsonb） | 該月所屬章節的幣別 | 同該章節；**月份跨兩個章節時是未知** | 跟著章節；jsonb 每個元素加 `amountMinor`／`totalMinor` |
| 捷徑待處理 | 無帳本、無幣別 | — | 不轉；它是顯示單位（§5.5） |

可以用的外部證據，但**不拿來自動轉**：PostHog 的 `base_currency_changed` 帶 from／to（`actions/currency.ts:63-66`），但它是以使用者送出、不帶帳本 id，而且只在 production build 才送，不完整。只能拿來估「改幣別常不常見」（附錄 A Q7）。

### 3.3 不確定時怎麼處理

**原則：不確定就保留原值，畫面照今天的樣子顯示，不猜。**

- 新欄留 NULL，章節的 `currency_source = unknown`。舊欄一個字都不動。
- 讀取規則：新欄是 NULL 時，用舊欄的整數、不加小數、照今天的方式顯示（今天已結束章節都用帳本目前的幣別符號，`csv-export-design.md:106` 記的那個缺口）。**結果和今天一模一樣**，不會更好，也不會更壞。
- 這些列都在已結束章節裡，章節是唯讀的（epoch-readonly），不會再被編輯，也不進目前章節的 balance（`lib/db/queries/balance.ts:96,109` 只算目前章節）。所以「未知」不會擴散到新資料。
- **不擋目前章節開放小數**：目前章節的幣別是高可信度。未知只影響過去章節的顯示與匯出。
- 中可信度的章節要不要轉、要不要問使用者，是 D4。問使用者需要新畫面與新文案，另開票。
- 以後補到證據（例如 Ray 決定採用中可信度證據），對那些章節跑同一個回填即可：回填只寫 NULL 的新欄，不會碰已轉的列。

### 3.4 要轉換的欄位（雙欄）

**不改舊欄**。每個金額欄旁邊加一個 `bigint` 的新欄，由回填與之後的寫入填滿。為什麼雙欄、而不是就地 ×100，見 §4.2 的選項比較。

| 表與欄 | 新欄 | 新欄的值 |
|---|---|---|
| CashTransactions／IncomeTransactions／Settlements／TripExpenses `amount` | `amount_minor` | 舊欄 × 10^p(列所屬章節幣別)；章節未知時 NULL |
| CashTransactions／IncomeTransactions `original_amount` | `original_amount_minor` | 舊欄 × 10^p(`original_currency`) |
| TripExpenses `original_amount`、Trips `budget_amount` | 同上命名 | 依 D2；表外代碼預設 p = 0 |
| RecurringIncomeRules／RecurringExpenseRules `amount`、Pending*Occurrences `proposed_amount` | `amount_minor`／`proposed_amount_minor` | 舊欄 × 10^p(帳本目前 base) |
| MonthlyReviewSnapshots 四個純量欄 | 各加 `_minor` | 舊欄 × 10^p(該月章節幣別)；未知時 NULL |
| MonthlyReviewSnapshots jsonb | 每個元素加 `amountMinor`／`totalMinor` 鍵 | 同上 |
| GroupBalance `balance` | `balance_minor` | **不是** ×100；由 §5.3 的規則從新欄重算。採 D7 建議時，回填當下必定等於 `balance × 10^p` |
| OutingExpenses／OutingExpenseShares／OutingSettlements、Outings `fold_amount` | 各加 `_minor` | USD：等於舊欄（已是分）；CNY：舊欄 × 100 |
| 愛物購入價、保險金額欄 | 各加 `_minor` | 依 D6 |
| ShortcutPendingExpenses `amount` | **不加** | 顯示單位，見 §5.5 |

另外加：

- `CashTransactions.split_round_unit`（`smallint`）：分帳進位的單位，見 §5.3。值是「開放小數之前寫入的列＝10^p，之後＝1」：回填時，兩位小數帳本的列填 100、零位小數帳本填 1；第 3 階段的新程式照同一條規則寫；寫入者沒給值時（舊伺服器程式）由 INSERT trigger 照同一條規則補。
- `GroupEpochs.currency`、`currency_source`（§2）。

**新欄用 `bigint` 的原因**：最大單筆 `MAX_AMOUNT = 9_999_999`（`lib/validators.ts:22`）×100 還在 int4 內，但加總與中間值會溢位。現在的 balance SQL 先在 int4 裡乘再除：`CEIL(amount * (100 - split_ratio_a) / 100.0)::int`（`lib/db/queries/balance.ts:82,88`）；`amount` 是 999,999,900 分時乘 99 就超過 int4，整筆寫入失敗。月度快照的 `SUM(...)::integer`（`drizzle/0093_review_snapshot_chapter.sql:125,204-205,212`）與保險、愛物欄位（沒有上限，`lib/validators.ts:812-848` 只擋負數）也一樣。新欄、`balance_minor` 與所有加總都用 `bigint`；JS 端 `bigint` 在 2^53 以內可以安全當 `number`。

### 3.5 寫入閘門與回填

**所有寫入走同一個閘門**：在交易裡先鎖帳本列（`OikosGroups`，`FOR SHARE`），在交易**裡面**讀 base 並換算。

- 這個鎖已經存在：`setBaseCurrency` 用 `FOR UPDATE`（`actions/currency.ts:44`），`createOuting` 用 `FOR SHARE`（`actions/outing.ts:111-121`）。寫入也拿 `FOR SHARE` 之後，「改 base」和「寫入」一定排成先後，不會交錯。
- 現在的現金新增在交易**外**就用 base 算好金額（`actions/transaction.ts:99-113`，交易從 122 行才開始；編輯路徑 260、277 同樣）。第 3 階段要把換算搬進交易，或在交易內重讀 base、不一致就重試。

**DB 的保險：插入時的 trigger**。新欄在 INSERT 時如果是 NULL（代表寫入者不認得新欄，例如舊伺服器程式），trigger 以 `FOR SHARE` 讀帳本 base，填 `舊欄 × 10^p`。新程式一律兩欄都寫，trigger 不介入。

- 這讓舊伺服器程式寫的整數金額在任何時候都正確。
- 限制：舊程式只能寫整數元。開放小數後，舊程式「編輯」一筆 $12.50 會寫回 13，trigger 補成 1300，小數不見而且沒有錯誤。所以開放小數的前置條件是舊伺服器程式已經不可能被執行（§7 第 4 階段）。
- GroupBalance 也一樣：舊程式只更新 `balance` 時，trigger 呼叫同一個 DB 函式補算 `balance_minor`。

**改幣別時**：目前章節沒有未刪除的帳才能改幣別，但定期規則、旅行、愛物購入價等可能還在（§3.2）。`setBaseCurrency` 要在同一個交易裡，把這些列的新欄改成 `舊欄 × 10^p(新幣別)`，維持今天「數字不變、換個幣別解讀」的行為。開放小數之後，這些列可能有小數，舊欄是四捨五入值，重算會掉小數；所以建議開放小數後，**小數位數會變的改幣別**在這些列存在時擋下（沿用既有錯誤 `base_currency_locked`，不用新字串）。要 Ray 決定（D13）。

**回填**（第 2 階段，一個帳本一個交易）：

1. 鎖帳本列（`FOR UPDATE`），這段時間該帳本的寫入會等。
2. 依 §3.2 決定每個範圍的幣別，寫 `GroupEpochs.currency`／`currency_source`。
3. `UPDATE … SET amount_minor = amount * 10^p WHERE amount_minor IS NULL AND <範圍條件>`。
4. 算 `balance_minor`，並在交易內驗證 §3.6 的 I2、I4；不成立就 `RAISE`，只回滾這一本。
5. 提交，換下一本。

**為什麼不會重乘**：回填只讀舊欄、只寫 NULL 的新欄。舊欄永遠不被修改，重跑多少次結果都一樣；已經有值的新欄不會再被碰。回填期間的新寫入由程式或 trigger 填好新欄，回填直接跳過。

**時段**：避開 pg_cron 的 15:00–16:45 UTC 與每月 1 日（各排程見 §3.7）。

### 3.6 對帳（遷移前後）

對帳全部用聚合查詢，**只輸出 0／非 0 或真／假**，不看任何一筆使用者資料。

| # | 不變量 | 怎麼查 | 期望 |
|---|---|---|---|
| I1 | 舊欄沒有被改 | 回填開始時間 t0 之前建立的列，每張表 `md5(string_agg(id::text || ':' || amount::text, ',' ORDER BY id))` 回填前後相同 | 真 |
| I2 | 已知列的新欄＝舊欄 × 10^p（第 4 階段前；之後小數列的舊欄是四捨五入值，改成只查整數列） | `count(*) WHERE amount_minor IS NOT NULL AND amount_minor <> amount::bigint * 10^p` | 0 |
| I3 | 已知範圍沒有漏轉、未知範圍沒有誤轉 | 目前章節未刪除列 `amount_minor IS NULL` 的筆數；`currency_source = unknown` 章節裡新欄非 NULL 的筆數 | 兩者都 0 |
| I4 | balance 沒有跳動 | `count(*) WHERE balance_minor <> balance::bigint * 10^p`（採 D7 建議時，從回填到第 4 階段前一直成立；若 Ray 選 D7 (a)，改看附錄 A Q4 的分布） | 0 |
| I5 | 月度快照 jsonb | 每個 jsonb 元素：已知章節 `amountMinor = amount × 10^p`，未知章節沒有 `amountMinor` | 0 筆不符 |
| I6 | 沒有溢位、沒有超過 JS 安全整數 | `count(*) WHERE amount_minor > 9007199254740991`；CHECK 由 DB 自己擋 | 0 |
| I7 | 回填可重跑 | 同一批再跑一次回填，更新列數 | 0 |

**抽樣**：不在 prod 抽看使用者資料。抽樣做在 dev：用附錄 B 的假資料情境，對每個情境截圖比對回填前後的畫面（首頁 balance、紀錄、統計、月度回顧、CSV 匯出），差異只能出現在附錄 B 列為「預期改變」的地方。

**停止條件**：

- 單一帳本的 I2 或 I4 不成立：該帳本的交易 `RAISE` 回滾，其他帳本繼續；結束後回報失敗帳本數的級距。
- 任何一本失敗、或全量 I1–I7 有任何一項不符：**不進第 3 階段**。查原因、修回填、重跑（I7 保證可重跑）。
- 溢位（I6 不是 0）：停止，回頭檢查哪個欄位漏了 `bigint`。

### 3.7 相依的 DB 物件

| 物件 | 位置 | 影響 |
|---|---|---|
| `CHECK (amount > 0)` 等 | `drizzle/0012_income_transactions.sql:11`、`0016_recurring_income.sql:26,53`、`0021_recurring_expense.sql:21,49`、`0066_outing_tables.sql:59,73,82`；`ShortcutPendingExpenses_amount_positive`（`lib/db/schema.ts:841`） | 舊欄的 CHECK 保留。新程式寫舊欄時用「四捨五入、正數至少 1」，例如 $0.40 的舊欄寫 1，避免違反 CHECK。新欄加同樣的 `> 0` CHECK |
| balance 計算 | `lib/db/queries/balance.ts:70-115` | 改成一個 DB 函式，同時算 `balance`（舊規則、舊欄）與 `balance_minor`（§5.3、新欄），中間值一律 `bigint` |
| `SUM(amount)::integer` | 月度快照函式（`drizzle/0093_review_snapshot_chapter.sql:125,204-205,212`） | 第 2 階段改成同時寫純量 `_minor` 欄與 jsonb 的 `amountMinor`／`totalMinor`，用 `bigint` |
| 定期規則產生待確認 | `generate-pending-income`／`generate-pending-expense`，每天 16:00 UTC（`drizzle/0064_recurring_cron_taipei_date.sql:65,90`），把 `r.amount` 原樣抄進 `proposed_amount`（同檔 68） | 第 2 階段改成兩欄都抄。**必須在開放小數前完成**：不然有小數的規則產生的卡，新欄會被 trigger 從四捨五入後的舊欄補，掉小數 |
| 其他排程 | `sweep-orphan-ledgers` 15:00 UTC（`0096...sql:660`）、`monthly-review-snapshot` 每月 1 日 16:05 UTC（`0096...sql:667`）、`notify-recurring-push` 16:10 UTC（`0100...sql:78`）、`process-account-deletions` 16:30 UTC（`0059...sql:9`）、`cleanup-shortcut-pending` 19:20 UTC（`0098...sql:111`）、`cleanup-soft-deleted` 週日 03:00 UTC（`0097...sql:54`） | 回填避開 15:00–16:45 UTC 與每月 1 日 |
| Realtime | `RealtimeProvider.tsx:81-177` 訂閱的表 | 新欄會出現在 payload。舊 JS 的解析器用寬鬆物件、多的欄位直接丟掉（`lib/realtime/payload-schema.ts:13-15`），只讀舊欄（§4.1） |
| 備份 | 每日備份約保留 60 天；**prod 是 Free plan，沒有 PITR**（`docs/superpowers/ops-runbook.md:122-123`） | 從備份還原最多掉一天的資料。所以回滾設計成「不用還原資料」（§3.8） |
| generated column、金額 trigger | grep `drizzle/*.sql` 未找到跟金額有關的 generated column 或 trigger | 無；本設計新增的 trigger 是第一個 |

### 3.8 回滾

| 層級 | 做法 | 什麼時候可用 | 代價 |
|---|---|---|---|
| R1 關掉「開放小數」 | 關開關；輸入回到整數 | 第 4 階段之後隨時 | 無資料變動；已記的小數照樣顯示 |
| R2 退回舊程式 | 部署第 3 階段之前的版本，它只讀寫舊欄 | **第 5 階段之前隨時**（舊欄一直同步） | 小數列在舊程式裡顯示成四捨五入的整數元；舊 balance 是舊規則算的，自身一致。新欄完整保留，重新部署新程式就回來 |
| R3 從每日備份還原 | 還原整個 DB | 只在新欄或舊欄被寫壞時 | 最多掉一天的資料（沒有 PITR） |

**R2 期間的資料**：舊程式寫的列，新欄由 trigger 補（整數 ×10^p，正確）。只有一種會失真：R2 期間有人編輯一筆小數列，小數會掉。可以用 `created_at` 介於 R2 起訖的列數（只看級距）評估影響。R2 期間愈短愈好。

**可逆回滾什麼時候停止**：第 5 階段刪掉舊欄之後，R2 就不存在，只剩 R3。所以第 5 階段要等 Ray 確認（D12）。

---

## 4. 新舊版並存

web、PWA、iOS／Android 殼都載入同一個 prod URL（`capacitor.config.ts:23,57-58`：`server.url` 預設是 prod）。所以**殼不用發新版**就會拿到新前端；但「已經載入的舊 JS」會繼續跑，殼在背景時可能很多天。

### 4.1 舊 JS 從哪裡拿到金額

| 管道 | 舊 JS 實際會怎樣（已查證） | 雙欄設計下的結果 |
|---|---|---|
| 頁面切換、`router.refresh()` | 回應的 build id 跟自己不同時，Next.js 直接整頁重新載入（`node_modules/next/dist/client/components/router-reducer/fetch-server-response.js:160-162`）。不需要設定 `deploymentId` | 重新載入後就是新 JS。安全 |
| Realtime | 舊 JS 自己訂閱表的變更，收到 `GroupBalance` 就直接 dispatch `balance`（`RealtimeProvider.tsx:106-112`），**不經過 server，也不會觸發重新載入**。審查 P1-1 指的就是這條 | 舊 JS 只讀 `balance`（舊欄，整數元）。新欄在 payload 裡被解析器丟掉（`lib/realtime/payload-schema.ts:13-15,109-112`）。最多差不到 1 元（小數被四捨五入），不會差 100 倍 |
| Server Action | action id 每次 build 會重算、最多快取 14 天（`node_modules/next/dist/docs/01-app/02-guides/data-security.md:276,281`）。id 對不上時 client 丟 `UnrecognizedActionError`（`.../router-reducer/reducers/server-action-reducer.js:75-78`），寫入失敗、看得到錯誤。id 對得上時跑新 server 程式 | 新 server 依欄位名分辨：只有 `amount`（沒有 `amountMinor`）就是舊 JS 送的整數元，在交易內 ×10^p。回傳給 client 的資料，`amount` 也維持整數元 |
| 舊伺服器程式（Vercel Skew Protection） | 若專案開了 Skew Protection，舊頁面的請求會被導回**舊部署**，跑舊伺服器程式。有沒有開、保留多久：**未知**（不在 repo 設定裡；附錄 A Q8） | 舊伺服器程式只寫舊欄，trigger 補新欄（§3.5），整數金額正確。開放小數前要等它不可能再被執行（§7 第 4 階段） |
| PWA 離線快取 | `/dashboard`、`/records`、`/assets` 的 HTML 用 NetworkFirst（3 秒逾時）存在 `dynamic-v1`（`app/sw.ts:68-84`）；新 SW 立刻接手（`app/sw.ts:53-54`） | 快取的 HTML 是舊程式用舊欄畫的，頁面本身一致，只是舊。上線後網路優先，會換新 |
| iOS 捷徑、快速記帳 URL | 永遠送整數（`ios/App/App/QuickAddIntent.swift:60-62` 把 Double 四捨五入成 Int） | 對外介面維持顯示單位（§5.5） |

### 4.2 選項

| | A：就地 ×100＋帳本旗標＋Realtime 隔離 | **B：雙欄（建議）** | C：硬切（維護時段） |
|---|---|---|---|
| 做法 | 每本帳在一個交易裡把舊欄 ×100、標「已切換」。Realtime 改走新的 broadcast topic（例如 DB trigger 推到 `group:{id}:v2`），切換前把金額表移出 `postgres_changes` publication；舊 JS 收不到任何事件 | 舊欄維持整數元，新增 `*_minor`。舊 JS 讀舊欄、新 JS 讀新欄；DB trigger 保證兩欄同步 | 停機公告；關 Realtime；撤銷所有兩位小數帳本成員的登入；就地 ×100；開機 |
| server 怎麼分辨 client | payload 欄位名（`amountMinor` vs `amount`）＋帳本旗標 | payload 欄位名；不需要「已切換」旗標（「開放小數」開關只管輸入與顯示） | 不需要（舊 client 全部被登出） |
| Realtime | 要新建 broadcast 通道與授權（`realtime.messages` 的 RLS）；Supabase Free plan 是否支援 DB broadcast：**未查證** | 不用改；舊 JS 讀舊欄 | 停用期間沒有 Realtime |
| 已開著的分頁 | 收不到事件，畫面停在舊值，直到切頁時整頁重載 | 照常運作，小數四捨五入 | 被登出；但 access token 到期前（預設約 1 小時，**未查證**本專案設定）仍可能收到事件 |
| 新 JS 的混用風險 | 有：旗標與 balance 從不同管道到達時會混用（審查 P1-1），要在同一個 payload 帶單位 | 沒有：值的單位由欄名決定 | 沒有 |
| 回滾 | ÷100 在有人輸入小數後就不可逆；之後只能從每日備份還原，**最多掉一天**（沒有 PITR） | 第 5 階段前退程式即可（§3.8 R2），不動資料 | 同 A |
| 主要風險 | balance 規則變化與旗標競態；Realtime 改造是新東西；回滾代價高 | 欄位數加倍（約 30 個）、每個讀取點都要改成讀新欄、trigger 是新的維運面；漏改的讀取點會顯示四捨五入的整數（差 <1 元） | 使用者被登出（殼裡的 Apple 登入要重來）、要停機、回滾同 A |
| 成本 | 中 | 中偏大（多一倍欄位與寫入，但不用改 Realtime） | 小（程式）＋營運成本高 |

**建議 B**。理由：它是唯一讓「舊 JS 讀到的值」在 DB 層就保證是整數元的做法，不靠時間差、不靠使用者重整；而且在第 5 階段之前回滾不用碰資料。要 Ray 決定（D5）。

### 4.3 B 的時序

時序、每階段的進入條件與退出條件放在 §7 的表，這裡只講順序的理由：

1. **先加欄、後上程式**（第 2 → 3 階段）：認得新欄的程式不能比 migration 早（`lib/db/schema.ts:106-108`）。
2. **先讓所有程式讀新欄、但仍只收整數**（第 3 階段）：使用者看不到任何變化，可以觀察一段時間。
3. **最後才開放小數**（第 4 階段）：小數一進來，舊欄就只剩四捨五入值。所以開放前要確定舊伺服器程式不會再跑（Skew Protection 保留期已過）、定期規則的排程已經兩欄都抄。
4. **刪舊欄是最後、而且可以不做**（第 5 階段）：刪了就失去 R2。

**要不要強制舊頁面重整**：B 不需要。可以在第 3 階段順手加「server 回報的 build 和自己不同就整頁重整」（例如 `visibilitychange` 時檢查），讓第 5 階段之前舊 JS 消失得更快。這不是任何階段的前置條件。

### 4.4 欄位 × 階段的讀寫表

「金額欄」指 §3.4 表裡的所有欄，捷徑待處理除外。

| 階段 | 舊欄的值 | 新欄的值 | 誰寫舊欄 | 誰寫新欄 | 舊 JS 讀 | 新 JS 讀 |
|---|---|---|---|---|---|---|
| 第 2 階段後 | 整數元 | 已知範圍：舊欄 × 10^p；未知：NULL | 現行程式 | 回填；trigger（INSERT 時 NULL 就補） | 舊欄 | （還沒有） |
| 第 3 階段後 | 整數元 | 同上 | 新程式（兩欄都寫，值相同）；舊伺服器程式 | 新程式；trigger 只補舊伺服器程式的寫入 | 舊欄 | 新欄（NULL 時用舊欄，§3.3）；顯示不帶小數 |
| 第 4 階段後 | 新寫入：新欄四捨五入成整數元，正數至少 1 | 精確值 | 新程式 | 新程式 | 舊欄（最多差 <1 元） | 新欄；兩位小數帳本顯示兩位 |
| 第 5 階段後 | 刪除 | 精確值 | — | 新程式 | 解析器缺 `amount` 欄，事件被丟掉（`payload-schema.ts` 的必填欄位），畫面停住直到重整 | 新欄 |

`GroupBalance.balance` 在第 2～4 階段由同一個 DB 函式用舊規則從舊欄算；`balance_minor` 用 §5.3 的規則從新欄算。兩者各自一致。

---

## 5. 邏輯與邊界

### 5.1 金額輸入（`AmountInput`）

現況：`inputMode="numeric"`（`AmountInput.tsx:112`），送出前去掉所有非數字（121），顯示用 `parseInt(...).toLocaleString`（74）。各 sheet 再 `parseInt`：`AddSheet.tsx:394`、`IncomeSheet.tsx:194`、`SettlementSheet.tsx:70`、`RecurringRuleSheet.tsx:419`。

設計：
- 元件要知道幣別（或小數位數）。開放小數後，兩位小數帳本用 `inputMode="decimal"`，零位小數帳本維持 `numeric`。
- **會產生小數的輸入，整筆拒絕、保留原值**（不是只把 `.` 濾掉——只濾句點，`12.5` 還是會變 `125`，就是 #1920 的原錯）。涵蓋：逐鍵輸入 `.`、貼上 `12.5`、全形句點 `．`、日文 IME 的 `。`。零位小數帳本永遠如此；兩位小數帳本在開放小數前也如此（第 0 階段）。若要顯示提示，需要新字串，屬於 needs-copy／UX，這份不寫字串。
- 超過小數位數（例如 `12.345`）：要 Ray 決定（D3）。建議**不接受第三位**（打不進去），不要四捨五入，因為使用者看不到被改掉的那一位。
- 要處理的輸入：全形數字與全形句點、IME 的 `。`、千分位逗號、開頭是 `.`（`.5`）、結尾是 `.`（`12.`）、空字串。全形數字的處理 `lib/quickAdd.ts` 已經有（`FULLWIDTH_DIGIT_RE`），可以共用。
- 小數點符號：四個語系（`lib/i18n/locales/` 的 en、ja、zh-CN、zh-TW）都用 `.`，不處理 `,` 當小數點的語系。

### 5.2 字串 → 最小單位整數

**不得用浮點數**。`Math.round(12.35 * 100)` 在 JS 是 1235，但 `1.005 * 100` 是 100.49999…，結果會少一分。做法是字串拆整數與小數部分，小數補零到小數位數，再組成整數字串。

現在已經有用浮點數的地方，第 3 階段要一起改：
- 出遊支出：`ExpenseSheet.tsx:102`（`Number(amountRaw)`）、`117`（`Math.round(parsedAmount * 100)`）；`inputMode="decimal"`（181）。這就是 #1920 指的 `ExpenseSheet.tsx:178` 附近，USD 出遊現在就是這樣收小數、存分。
- 出遊還款：`SettleSheet.tsx:33,39`。
- CSV 匯入：`lib/csvImport/mapper.ts:78-89`（`Math.round(Math.abs(n))`，直接丟掉小數）、`lib/csvImport/ofxParser.ts:81`。

伺服器驗證：`validateAmount`（`lib/validators.ts:29-36`）只檢查正整數，單位無感，可以保留；但上限要依小數位數放大（§5.4）。

### 5.3 分帳、尾差與 balance

**尾差歸誰（規則不變）**：付錢的人多拿那一個最小單位。平分 `ceil(金額 / 2)`、依比例 `ceil(金額 × 對方比例 / 100)`，都對「付款人應收」取 ceil（`lib/balance.ts:16-34`，註解「payer benefits from odd cents」）。改成最小單位後，規則一字不改，只是尾差從「1 元」變成「1 個最小單位」：

| 小數位數 | 最小單位 | 尾差上限（每筆） | 例 |
|---|---|---|---|
| 0（TWD、JPY） | 1 元 | 1 元 | NT$45 平分：付款人應收 23。新舊算法相同（×1） |
| 2（USD、CNY） | 1 分 | 1 分 | $45.00 平分：應收 2250 分（$22.50）；$10.01 平分：應收 501 分 |
| 其他（目前沒有；例如 3 位的幣別） | 10^-p | 1 個最小單位 | 規則相同，不需要特例 |

旅行支出用外幣記時，先換算成帳本 base 的最小單位再分帳（§5.8），所以分帳永遠在帳本幣別上做。出遊的平均分（`lib/outing/split.ts:17-22`）把餘數一個最小單位一個最小單位分給前面的人，規則不變；分攤結果存在 `OutingExpenseShares`，轉換時直接換單位，不重算。

**跟舊算法差在哪**（審查 P2-4 的反例）：兩位小數帳本在整數元時代是「以 1 元為單位取 ceil」，轉成分之後若直接用新規則重算，結果不同：

- $45 平分：舊 23 元 → 新 2250 分（$22.50），差 $0.50。
- $10 依比例 33%：舊 `ceil(3.3)` = 4 元 → 新 330 分（$3.30），差 $0.70。**金額是偶數也會差**，所以第 1 版只數奇數金額的探針（`odd_split_rows`）會漏，已撤回。
- 每筆最多差不到 1 元；一本帳的總差額是各筆差額的加減，可能相抵，也可能累積。

**選項**（要 Ray 決定，D7）：

- (a) 照新規則全部重算，差額照實顯示。最簡單。失效的樣子：兩人上週剛結清，開放小數那天首頁出現「你欠對方 $1.50」，沒有任何紀錄解釋它。差額分布要用附錄 A Q4 查。
- (b) 每本帳寫一筆系統結算抵銷差額。帳一致，但多一筆使用者沒記過的紀錄，要新 UI 字串。
- (c) **切換前的列沿用舊的進位單位（建議）**：`CashTransactions.split_round_unit` 記「這筆在哪個單位取 ceil」。開放小數之前寫入的列（回填的舊列，以及第 3 階段新寫的列）在兩位小數帳本填 100，其他填 1；開放小數之後的新列填 1。應收 ＝ `u × ceil(amount_minor × 比例 / (100 × u))`，u 是 `split_round_unit`。$45 平分的舊列：`100 × ceil(4500 / 200)` = 2300 分，和今天的 $23 一樣。
  - 結果：從回填到第 4 階段前，每本帳的 `balance_minor` 必定等於 `balance × 100`（§3.6 I4 可以全量、每天驗證），使用者看到的 balance 一分不差。
  - 第 4 階段之後編輯一筆舊列（＝刪除＋新增）時，新列用 u = 1，該筆的分攤會變成精確值。差額出現在那筆被編輯的紀錄上，有紀錄可以解釋。
  - 顯示單筆分攤的地方（紀錄明細、`lib/tripSummary.ts:50,58,140`）要用同一個函式，不然單筆與總額對不起來。
- (d) `GroupBalance` 直接 ×100、不重算。**不可行**：下一次寫入就全量重算（`domain-model-design.md:23`），差額照樣出現，只是延後、更難解釋。

建議 (c)：唯一讓「已結清」維持結清、又不新增紀錄的做法；代價是一個欄位和 balance 函式裡的一個乘數。若 Ray 選 (a)，先看 Q4 的分布再決定。

**結算快選**：`lib/settlement.ts:15-19` 的「整數」快選四捨五入到 100。要改成「100 個顯示單位」（兩位小數帳本是 10,000）；否則 USD 的「整數」快選變成 $1。

**fold**：`actions/outing.ts:546` 的 `minorToWhole` 在開放小數後拿掉，出遊與帳本單位相同，直接寫入。第 3 階段仍照舊四捨五入到整數元（新欄＝舊欄 × 100），讓使用者在第 4 階段前看不到變化。

### 5.4 格式化

- `formatLedgerAmount*`（`lib/currency.ts:95-109`）改成讀新欄、依小數位數除以 10^n。第 3 階段一律不顯示小數；第 4 階段兩位小數帳本顯示固定兩位。`formatAmount*`（75-85，現在只給出遊）可以跟它合併。用到 `formatLedgerAmount*` 的檔案共 31 個，分類：首頁與 sheet（`app/(dashboard)/dashboard/_components/`，8）、愛物與保險（`assets/`，15）、紀錄與統計（`records/`，2）、旅行、定期、月度回顧、共用元件各 1、`lib/` 1、i18n 註解 1。
- **型別擋單位混用**：新欄在 TypeScript 用獨立的 branded type（例如 `Minor`），格式化函式只收 `Minor`。讀到舊欄（`number`）卻丟給格式化函式會編譯失敗。
- **繞過格式化函式的地方**（風險較高，因為不會跟著改）：直接 `toLocaleString` 的金額大約十幾處，例如 `MonthlyStatsBars.tsx:207`、`MonthlyStatsPieChart.tsx:203`、`PendingCard.tsx:143`、`CompactRow.tsx:29,180`、`SettlementForm.tsx:155`、`LeaveGroupFlow.tsx:578`、`StepConfirm.tsx:76`、保險的 `SavingsHero.tsx:13`、`MaturedAwaitingPrompt.tsx:47,65`、`InsuranceDetailClientLegacy.tsx:120`。失效的樣子：首頁對了，但統計圖的數字或待確認卡還是 4500。實作時要 grep `toLocaleString` 逐一處理，並加一個測試擋新的直接呼叫。
- 錯誤訊息的上限：`AddSheet.tsx:376`、`IncomeSheet.tsx:198`、`lib/validators.ts:34` 把 `MAX_AMOUNT` 直接顯示。建議上限定義成「顯示單位」再乘 10^n，讓各幣別的上限數字相同。

### 5.5 舊入口的單位與相容

**原則：對外入口一律是顯示單位（元／$），在邊界只轉一次成最小單位。** 整數輸入在任何階段都是「整數元」，所以舊捷徑、舊 URL、舊 CSV 永遠是對的。

| 入口 | 現況（已查證） | 設計 | 怎麼驗「不重乘」 |
|---|---|---|---|
| 快速記帳 URL（`#add=expense&amount=120`、`dev.southernlight.futari://add?amount=120`） | 只收正整數，單位是整數元（`lib/quickAdd.ts:41-52`）；只是預填 AddSheet，不寫入 | 預填到金額框的是**顯示字串** `120`，送出時由金額框解析成最小單位，只轉一次 | USD 帳本開 `amount=120`：框裡顯示 120，存 12000，顯示 $120.00 |
| 捷徑 JSON（`app/api/shortcut/pending/route.ts`） | `parseQuickAddJson` 只收整數（`lib/quickAdd.ts:135-161`），寫進捷徑待處理 | 維持整數顯示單位（D10）。之後若要收 `"12.50"`，在同一個邊界加字串解析，與舊格式相容 | 送 `{"amount": 120}`，待處理卡顯示 120 |
| 捷徑待處理 → 確認 | 表只有 `user_id`，**沒有帳本與幣別**（`lib/db/schema.ts:831-841`）；確認時用 `o.amount ?? card.amount`（`actions/shortcutPending.ts:99`）跑同一個驗證後寫入（116） | **表不轉、不加新欄**。確認時在交易內鎖目的帳本、讀 base，`× 10^p` 一次。開放小數前就存在的卡也一樣，因為它們本來就是顯示單位 | 同一張卡確認到 USD 帳本存 12000；確認到 TWD 帳本存 120 |
| iOS App Intent | 把 Double 四捨五入成 Int 再組 URL（`QuickAddIntent.swift:40,60-62`） | 不改（改它要發 App 新版） | 同 URL |
| 定期規則 → 待確認卡 | DB 排程照抄金額（`drizzle/0064_recurring_cron_taipei_date.sql:68`） | 第 2 階段改成兩欄都抄（§3.7）；確認待確認卡時用新欄 | 有 $12.50 的規則（第 4 階段後）產生的卡，新欄是 1250 |
| 出遊 fold | `minorToWhole` 四捨五入（`actions/outing.ts:546`） | 第 3 階段照舊，第 4 階段直接寫最小單位（§5.3） | USD 出遊淨額 1234 分，第 4 階段後結算存 1234 |
| CSV | 見 §5.6 | 一律顯示單位 | 見 §5.6 |

**第 5 階段也保留**：上面這些入口的「整數＝顯示單位」契約不隨第 5 階段移除。使用者存好的捷徑、教學頁（`app/[locale]/features/shortcuts/`）與 `docs/shortcuts/linepay-quick-add.md` 的範例都寫 `amount=120`。

失效的樣子（若把入口改成最小單位）：iPhone 捷徑送 `{"amount": 120}`，USD 帳本的待確認卡顯示 $1.20。

### 5.6 CSV 匯入與匯出

**檔案裡的金額一律是顯示單位**，跟入口相同。所以舊匯出檔（`45`）和新匯出檔（`45.00`）在 USD 帳本都是 $45，不需要分辨檔案新舊。

- **匯出**：`lib/csv/transactions.ts:142,144` 寫 `String(r.amount)`。改成依該列的幣別把新欄寫成顯示值（`12.50`），原幣欄依 `original_currency`。過去章節依 `GroupEpochs.currency`；章節幣別未知時，照今天的寫法輸出舊欄整數與目前的幣別（§3.3，和今天相同）。
- **匯入（Futari 通用格式與手動對欄）**：現在的 parser 會四捨五入小數（`lib/csvImport/mapper.ts:78-89`），驗證器只收整數（`lib/csvImport/validator.ts:55-63`）。改成：兩位小數帳本以字串解析、保留最多兩位；零位小數帳本**沿用今天的行為**（四捨五入）。注意 `csv-import-design.md:117` 寫「拒收 `1.50`」，但程式其實是四捨五入，spec 與程式已經不一致；本案不改零位小數帳本的行為，那句 spec 由第 4 階段的 PR 一起改成描述實際行為。
- **匯入（競品格式）**：零位小數帳本維持四捨五入（競品的 TWD 資料偶爾帶 `.00`，拒收會讓整份匯入失敗）；兩位小數帳本保留兩位。
- **round-trip 的範圍**（審查要求定義）：Futari 匯出 → 同一個帳本匯入，**支出與收入的金額**原樣回來（兩位小數帳本到分）。不在範圍內、維持現狀：結算列（匯入只寫支出與收入，`actions/import.ts:227,246`）、原幣組合（匯入時丟掉，`actions/import.ts:217-224`）、混幣別章節（匯入一律寫進目前章節）。
- **去重 hash**：`csv-import-design.md:202-212` 寫了用 `amount(integer)` 的 hash，但程式裡 grep 不到 hash 的計算或欄位，只有一個沒用到的錯誤類型 `'duplicate'`（`actions/import.ts:79`）。**目前沒有實作，所以沒有 45／4500 相容問題**。日後實作時用最小單位算 hash，並在 spec 註明。

### 5.7 定期規則、待確認卡

規則存的是金額（§2），排程把它原樣抄成待確認卡。第 2 階段排程改成兩欄都抄（§3.7）；`RecurringRuleSheet.tsx:419` 的 `parseInt` 換成 §5.2 的解析。

### 5.8 匯率換算

- 主帳本記外幣：`actions/transaction.ts:113,260`、旅行：`actions/tripExpense.ts:111,120`、預覽：`AddSheet.tsx:683`（經 `lib/trip-currency.ts:120-143`）。都用 `convertWholeUnits`（`lib/currency.ts:126`）。
- 匯率的語意是「1 個顯示單位換多少顯示單位」（`lib/db/schema.ts:164`）。改成最小單位後，換算要乘上 10^(目標小數位數 − 來源小數位數)。例：USD 帳本記 ¥1000、匯率 0.0067 → 1000 × 0.0067 × 100 = 670 分。忘了這個係數就差 100 倍。
- 第 3 階段換算結果仍取整數元（新欄＝整數元 × 100），第 4 階段才保留到分，理由同 fold。
- 「正數至少為 1」的規則（`convertWholeUnits` 的契約）保留，單位變成 1 個最小單位。
- **匯率精度**：`rate_snapshot` 是 `numeric(10,3)`（`lib/db/schema.ts:226,455`）。JPY→USD 0.0067 只能存成 0.007（差約 4%）。整數元時代被四捨五入蓋過，顯示到分之後看得出來。建議另開一項評估放寬精度（D8），不擋本案。

### 5.9 其他檢查

| 項目 | 結果 |
|---|---|
| 統計、月檢視 | 走 `formatLedgerAmount*`，加上 §5.4 列出的直接 `toLocaleString`。`DailyTrendChart` 的 `toFixed` 是座標，不是金額 |
| 收入（`income-design.md`） | 該檔沒有寫金額單位（grep「整數」無結果）；程式路徑同支出（`IncomeSheet.tsx:194`、`lib/validators.ts:199`） |
| 月度回顧 | 快照凍結金額（§2），四個純量欄與兩個 jsonb 都要有新欄或新鍵；回顧卡用 `CardShell.tsx` 的格式化 |
| 推播 | `supabase/functions/send-recurring-push/` grep 不到金額，推播內文不含金額 |
| email | grep 不到寄信的程式路徑 |
| PostHog | `settlement_created` 帶 `amount_bucket`（`actions/settlement.ts:65`），門檻是原始整數。改成依顯示單位分級距，並在 `observability-design.md` 註明部署日前後不可比 |
| Sentry | 捷徑 API 明定金額不外送（`route.ts:52`），`actions/shortcutPending.ts:22` 同；其他路徑未逐一查證 |

---

## 6. 方向的選項比較

（§4.2 是「怎麼上線」的選項；這裡是「存什麼」的選項。）

| 選項 | 內容 | 成本 | 風險 | 失效的樣子 |
|---|---|---|---|---|
| **① 最小單位整數（Ray 的決定）** | 本檔的設計 | 大：雙欄、回填、約 31＋十幾個顯示點、輸入解析、匯率換算、CSV | 回填範圍判斷錯誤；漏改的讀取點 | 讀新欄卻當整數元顯示，4500 分顯示成 $4,500 |
| ② 維持整數元、放寬輸入 | 收小數，但四捨五入成整數元存 | 小 | 使用者打 $12.50 存成 $13，帳永遠對不上收據 | 不會報錯，只是每筆差幾毛，月底對不起來 |
| ③ 改 `numeric` 欄位 | DB 存小數 | 最大：所有欄位型別、Drizzle 讀出來是字串、所有運算要改 decimal 函式庫 | JS 浮點誤差回到計算裡 | `0.1 + 0.2` 類型的一分錢誤差散在 balance |

① 是 Ray 的決定；② 與 ③ 列在這裡只為說明為什麼不採用。

---

## 7. 分階段計畫

每個 PR 都可以單獨合併。**第 0～3 階段上線後，使用者看不到任何變化**（第 0 階段除外：打 `.` 不再變成多 10 倍）。**第 4 階段是使用者第一次看到小數的時候。**

| # | 範圍 | 進入條件 | 退出條件（做到才算完成） | 回滾 |
|---|---|---|---|---|
| 0 | `AmountInput`：會產生小數的輸入整筆拒絕、保留原值（逐鍵、貼上、全形句點、IME `。`），所有帳本 | 無 | 單元測試：每種輸入都保留原值；`1,200` 仍是 1200 | revert PR |
| 1 | 小數位數表、字串→最小單位解析、最小單位格式化（不接到任何畫面或寫入路徑） | 無 | 單元測試：全形、`.5`、`12.`、`1.005`、上限、四個幣別的 p 被釘住 | revert PR |
| 2 | migration：新欄（`bigint`）、`GroupEpochs.currency`／`currency_source`、`split_round_unit`、INSERT trigger、balance 與月度快照與排程改成兩欄都寫；回填高可信度範圍（§3.5） | 第 0、1 階段合併；附錄 A 的 Q1–Q3 有答案（決定 D4 範圍）；dev 用附錄 B 演練全過；Ray 指定回填時段 | §3.6 的 I1–I7 全部成立 | 新欄與 trigger 留著無害（舊程式不讀）；必要時 `DROP TRIGGER` |
| 3 | 程式改讀新欄、兩欄都寫；action payload 加 `amountMinor`，只有 `amount` 時當整數元；寫入閘門（交易內鎖帳本、換算）；Realtime 解析器讀 `balance_minor`；輸入與顯示仍是整數；`toLocaleString` 掃描測試；PostHog 級距 | 第 2 階段完成；dev 驗證 Realtime payload 裡 `bigint` 是數字還是字串（**未查證**；解析器兩種都要收） | 觀察期（D9）內 Sentry 沒有單位相關錯誤；每日跑 I2、I4 為 0 | 退回第 2 階段的程式（舊欄一直同步） |
| 4 | 開放小數：兩位小數帳本的輸入、兩位顯示、fold 與換算保留到分、CSV 小數；改 §1 表中的 spec 句子 | 第 3 階段部署後，超過 Vercel Skew Protection 的保留時間（未知，附錄 A Q8；若沒開則不用等）且滿 D9 的等待期；I2、I4 為 0；Ray 指定時間 | 一段期間內沒有回報；R1、R2 都演練過 | R1 關開關；R2 退回第 3 階段之前的程式（§3.8） |
| 5 | 收尾：停寫舊欄、刪舊欄與 trigger；**保留**入口的顯示單位契約（§5.5） | Ray 確認不再需要 R2（D12） | 回歸測試 | **不可逆**：只能從每日備份還原，最多掉一天 |

規模：**大**（第 3 階段跨數十個檔；第 2 階段動 prod 資料）。

里程碑建議：
- **v1.10.1 放得進**：第 0、1 階段。理由：不動資料、不改畫面上的金額、可以單獨回退；第 0 階段直接修掉 #1920 回報的「多記 10 倍」。
- **v1.10.1 放不進**：第 2～5 階段。理由：v1.10.1 的主題是商店文案與殼發版（milestone 說明），且第 2 階段要先有附錄 A 的答案與 dev 演練、第 3 階段需要獨立驗證、第 4 階段需要等待期。確切版號要 Ray 決定（D9）。

---

## 8. 要 Ray 決定

依審查建議的順序排。「技術門檻」欄是不論 Ray 怎麼選都必須先做到的事。

| # | 問題 | 選項 | 建議 | Ray 沒回時的預設 | 技術門檻 |
|---|---|---|---|---|---|
| D5 | 新舊版並存方案（§4.2） | A 就地 ×100＋Realtime 隔離／B 雙欄／C 硬切 | **B** | B | 舊 JS 讀不到最小單位（B 由欄名保證） |
| D4 | 幣別不確定的歷史資料（§3.2、§3.3） | (a) 只轉高可信度，其餘保留原值、畫面同今天 (b) 中可信度也轉 (c) 請使用者確認（要新畫面與文案） (d) 未知數不是 0 就延後整案 | **(a)**：不猜、不比今天差；之後有證據再補轉 | (a) | 未知範圍的新欄必須是 NULL（I3） |
| D7 | 兩位小數帳本切換前的分帳尾差（§5.3） | (a) 照新規則重算 (b) 系統結算抵銷 (c) 切換前的列沿用舊進位單位 | **(c)**：balance 一分不差，不加紀錄 | (c) | 選 (a) 前先看附錄 A Q4 |
| D9 | 里程碑、觀察期、回填時段 | — | 0、1 進 v1.10.1；2、3 一個小版；4 再下一版。第 3 階段觀察期至少一週；回填避開 15:00–16:45 UTC 與每月 1 日 | 同建議，時段由 Ray 指定 | 第 4 階段前 Skew Protection 保留期已過 |
| D12（新） | 第 5 階段（刪舊欄）什麼時候做 | (a) 第 4 階段後一個版本週期 (b) 不刪，一直保留 | (b) 先不刪：舊欄只多一點儲存，換到的是隨時可以退程式 | (b) | 刪之前確認不再需要 R2 |
| D13（新） | 開放小數後，改幣別的鎖要不要擴大（§3.5） | (a) 小數位數會變、且有定期規則／旅行等金額列時擋下（沿用 `base_currency_locked`） (b) 不擋，重算這些列 | (a)：重算會掉小數，而且不會報錯 | (a) | — |
| D2 | 旅行自由文字幣別（VND、EUR…）的小數位數 | (a) 不在表中的一律 0，舊資料不動 (b) 照 ISO 4217 建表並轉換舊資料 | (a)：先只處理主帳本四個幣別 | (a) | — |
| D6 | 愛物與保險的金額欄要不要一起轉 | (a) 一起轉 (b) 維持整數元，用另一個格式化函式 | (a)：同一個格式化函式、同一條規則 | (a) | 用 `bigint`（保險、愛物沒有上限） |
| D1 | 四個幣別的小數位數 | 照 §2 表／其他 | 照表 | 照表 | — |
| D3 | 輸入超過小數位數（`12.345`、TWD 打 `.`） | (a) 打不進去 (b) 四捨五入 (c) 顯示錯誤 | (a)；若要提示文字，另開 needs-copy 並確認 UX | (a) | 第 0 階段的「整筆拒絕」不論選哪個都要做 |
| D8 | 匯率精度 `numeric(10,3)` | 放寬／維持 | 另開票評估，不擋本案 | 維持，另開票 | — |
| D10 | 快速記帳 URL／捷徑 API 的金額單位 | (a) 維持顯示單位 (b) 改最小單位 | (a)（§5.5） | (a) | — |
| D11 | 以後加幣別的規則 | — | 加列時同時定小數位數；有資料後不可改 | 同建議 | — |

---

## 驗收（第 4 階段完成後）

- USD 帳本輸入 `12.50`：`amount_minor` 存 1250、顯示 $12.50；`amount` 存 13。TWD 帳本打不進 `.`，`1000` 存 1000、顯示 NT$1,000。
- 回填前記的 USD $45 顯示 $45.00（`amount_minor` 4500，`amount` 仍是 45）。
- 回填當下，每本兩位小數帳本 `balance_minor = balance × 100`（採 D7 (c)）。
- 舊 JS（第 3 階段前載入）收到 Realtime 的 balance 更新：顯示整數元，和新 JS 的顯示最多差不到 1 元；不會出現 100 倍。
- 舊 JS 送 `{ amount: 45 }` 到 USD 帳本：存 4500。
- 捷徑送 `{"amount": 120}`，確認到 USD 帳本：存 12000、顯示 $120.00。
- USD 帳本匯出 CSV 再匯入同一個帳本，支出與收入的金額原樣回來（到分）。
- 幣別未知的過去章節，顯示與今天完全相同。
- grep 不到繞過格式化函式直接 `toLocaleString` 的金額。

## 不做的事

- 不改 `numeric`。
- 不支援以 `,` 當小數點的語系。
- 不做本檔以外的幣別新增。
- 推播、email 不含金額，不處理。
- 不轉換捷徑待處理表（§5.5）。
- 不猜幣別不確定的歷史資料（§3.3）。

## 後續（不在本案）

- 過去章節的幣別標示：未知章節今天用目前幣別的符號，是既有缺口（`csv-export-design.md:106`）。要不要改成標「幣別未確認」需要新文案，另開票。
- 請使用者確認過去章節幣別的畫面（D4 (c)）。
- 匯率精度（D8）。
- 去重 hash 實作時用最小單位（§5.6）。

---

## 附錄 A：需要 prod 唯讀查詢的問題

**規則**：只 `SELECT`；只回傳級距或真／假，不輸出帳本 id、使用者、絕對金額；連線方式與誰去查由 Paula 決定，本檔不寫。下面的 SQL **沒有在任何 DB 上跑過**，欄位名以 `lib/db/schema.ts` 為準，執行前要先在 dev 跑一次確認語法。查不到某個組合時那一列不會出現，代表 0。

| # | 要查什麼 | 為什麼 | 答案會怎麼改變設計 |
|---|---|---|---|
| Q1 | 兩位小數帳本有幾本（級距） | 決定整案的急迫性與第 2 階段的回填量 | 0 本：第 2～4 階段只為新帳本鋪路，可以延後；很多本：觀察期加長 |
| Q2 | 有已結束章節、且章節內有任何金額列的帳本，依「目前的小數位數」分組 | P1-2 的範圍 | 兩組都是 0：D4 不用決定；不是 0：照 §3.3 處理，看 Q3 |
| Q3 | 上述章節的證據種類分布，以及證據顯示的小數位數與目前是否不同 | 判斷有多少章節能高可信度轉換 | 「沒有證據」很多：D4 (c) 的價值變高；「證據與目前不同」不是 0：反方向的問題真的存在 |
| Q4 | 兩位小數帳本若用新規則全部重算（D7 (a)），balance 差額的分布；目前已結清的帳本中有多少會出現差額 | D7 | 差額全是 0 或很小：(a) 也可以接受；有結清帳本會跳動：維持建議 (c) |
| Q5 | 保險、愛物金額欄 ×100 後超過 int4 的筆數（0 或非 0） | 確認 `bigint` 是必要還是保險 | 不影響建議（仍用 `bigint`），只決定測試資料要不要涵蓋 |
| Q6 | 兩位小數帳本有沒有定期規則、旅行支出、愛物購入價、USD／CNY 保單、CNY 出遊；旅行原幣代碼的種類 | D6、D2、D13 的範圍 | 某類是 0：該類可以晚一點做 |
| Q7 | PostHog `base_currency_changed` 事件總數的級距（不分使用者） | 改幣別常不常見 | 很少：未知章節的問題小 |
| Q8 | Vercel 專案的 Skew Protection 有沒有開、保留多久（看設定，不是 SQL） | 第 4 階段的等待時間 | 沒開：第 4 階段不用等這一項 |

```sql
-- 共用的級距寫法：CASE WHEN n = 0 THEN '0' WHEN n < 10 THEN '1-9' WHEN n < 100 THEN '10-99' ELSE '100+' END

-- Q1：各小數位數的帳本數
WITH c AS (
  SELECT CASE WHEN base_currency IN ('usd','cny') THEN 'p2' ELSE 'p0' END AS cls, count(*) AS n
    FROM "OikosGroups" GROUP BY 1
)
SELECT cls, CASE WHEN n = 0 THEN '0' WHEN n < 10 THEN '1-9' WHEN n < 100 THEN '10-99' ELSE '100+' END AS ledgers
  FROM c;

-- Q2 + Q3：已結束、且有金額列的章節，依目前小數位數 × 證據種類（含已刪除列）
WITH closed AS (
  SELECT e.id, e.group_id, e.started_at, e.ended_at,
         CASE WHEN g.base_currency IN ('usd','cny') THEN 'p2' ELSE 'p0' END AS now_cls
    FROM "GroupEpochs" e JOIN "OikosGroups" g ON g.id = e.group_id
   WHERE e.ended_at IS NOT NULL
), with_rows AS (
  SELECT c.* FROM closed c
   WHERE EXISTS (SELECT 1 FROM "CashTransactions" t   WHERE t.group_id = c.group_id AND t.created_at >= c.started_at AND t.created_at < c.ended_at)
      OR EXISTS (SELECT 1 FROM "IncomeTransactions" t WHERE t.group_id = c.group_id AND t.created_at >= c.started_at AND t.created_at < c.ended_at)
      OR EXISTS (SELECT 1 FROM "Settlements" t        WHERE t.group_id = c.group_id AND t.created_at >= c.started_at AND t.created_at < c.ended_at)
      OR EXISTS (SELECT 1 FROM "Trips" tr   WHERE tr.epoch_id = c.id)
      OR EXISTS (SELECT 1 FROM "Outings" o  WHERE o.epoch_id = c.id)
), ev AS (
  SELECT w.now_cls,
         CASE
           WHEN EXISTS (SELECT 1 FROM "Outings" o WHERE o.epoch_id = w.id AND o.fold_amount IS NOT NULL) THEN 'outing_fold'
           WHEN EXISTS (SELECT 1 FROM "Outings" o WHERE o.epoch_id = w.id) THEN 'outing_other'
           WHEN EXISTS (SELECT 1 FROM "CashTransactions" t WHERE t.group_id = w.group_id
                          AND t.created_at >= w.started_at AND t.created_at < w.ended_at
                          AND t.original_currency IS NOT NULL) THEN 'rate'
           ELSE 'none'
         END AS evidence,
         (SELECT bool_or(o.currency IN ('usd','cny')) FROM "Outings" o WHERE o.epoch_id = w.id) AS outing_says_p2
    FROM with_rows w
)
SELECT now_cls, evidence,
       CASE WHEN outing_says_p2 IS NULL THEN 'n/a'
            WHEN outing_says_p2 = (now_cls = 'p2') THEN 'same' ELSE 'differs' END AS outing_vs_now,
       CASE WHEN count(*) < 10 THEN '1-9' WHEN count(*) < 100 THEN '10-99' ELSE '100+' END AS epochs
  FROM ev GROUP BY 1, 2, 3;
-- 未查證：fold_amount 是否只在真的 fold 出結算時才非 NULL（淨額為 0 時的行為）。

-- Q4：D7 (a) 的差額分布（與 lib/db/queries/balance.ts:70-115 同條件，改成以分計算）
WITH g AS (
  SELECT id, member_a, current_epoch_started_at FROM "OikosGroups"
   WHERE base_currency IN ('usd','cny') AND member_b IS NOT NULL
), cash AS (
  SELECT t.group_id,
         SUM(CASE WHEN t.paid_by = g.member_a THEN 1 ELSE -1 END *
             CASE t.split_type
               WHEN 'all_mine'   THEN 0
               WHEN 'all_theirs' THEN t.amount::bigint * 100
               WHEN 'half'       THEN CEIL(t.amount::bigint * 100 / 2.0)
               WHEN 'weighted'   THEN CEIL(t.amount::bigint * 100
                                      * (CASE WHEN t.paid_by = g.member_a THEN 100 - t.split_ratio_a ELSE t.split_ratio_a END) / 100.0)
             END) AS new_minor
    FROM "CashTransactions" t JOIN g ON g.id = t.group_id
   WHERE t.deleted_at IS NULL AND t.status = 'settled' AND t.created_at >= g.current_epoch_started_at
   GROUP BY t.group_id
), st AS (
  SELECT s.group_id, SUM(CASE WHEN s.paid_by = g.member_a THEN 1 ELSE -1 END * s.amount::bigint * 100) AS new_minor
    FROM "Settlements" s JOIN g ON g.id = s.group_id
   WHERE s.deleted_at IS NULL AND s.created_at >= g.current_epoch_started_at
   GROUP BY s.group_id
), d AS (
  SELECT gb.balance::bigint * 100 AS old_minor,
         COALESCE(c.new_minor, 0) + COALESCE(st.new_minor, 0) AS new_minor
    FROM g JOIN "GroupBalance" gb ON gb.group_id = g.id
    LEFT JOIN cash c ON c.group_id = g.id
    LEFT JOIN st ON st.group_id = g.id
)
SELECT (old_minor = 0) AS settled_now,
       CASE WHEN new_minor = old_minor THEN '0'
            WHEN abs(new_minor - old_minor) <= 100  THEN '1-100 分'
            WHEN abs(new_minor - old_minor) <= 1000 THEN '101-1000 分'
            ELSE '1000 分以上' END AS diff,
       CASE WHEN count(*) < 10 THEN '1-9' WHEN count(*) < 100 THEN '10-99' ELSE '100+' END AS ledgers
  FROM d GROUP BY 1, 2;

-- Q5：×100 後超過 int4（只回答 0 或非 0）
SELECT 'insurance' AS what,
       CASE WHEN count(*) = 0 THEN '0' ELSE '1+' END AS rows_over
  FROM "InsuranceDetails" i
 WHERE i.currency IN ('usd','cny')
   AND greatest(coalesce(i.sum_insured,0), coalesce(i.coverage_amount,0), coalesce(i.annual_premium,0),
                coalesce(i.expected_maturity_amount,0), coalesce(i.account_value,0))::bigint * 100 > 2147483647
UNION ALL
SELECT 'car_house_price', CASE WHEN count(*) = 0 THEN '0' ELSE '1+' END
  FROM (SELECT purchase_price AS v FROM "CarDetails" UNION ALL SELECT purchase_price FROM "HouseDetails") x
 WHERE x.v::bigint * 100 > 2147483647;

-- Q6：兩位小數帳本的各類金額列有沒有（只回答 0 或非 0）；旅行原幣代碼種類
SELECT 'recurring_expense' AS what, CASE WHEN count(*) = 0 THEN '0' ELSE '1+' END AS present
  FROM "RecurringExpenseRules" r JOIN "OikosGroups" g ON g.id = r.group_id WHERE g.base_currency IN ('usd','cny')
UNION ALL
SELECT 'recurring_income', CASE WHEN count(*) = 0 THEN '0' ELSE '1+' END
  FROM "RecurringIncomeRules" r JOIN "OikosGroups" g ON g.id = r.group_id WHERE g.base_currency IN ('usd','cny')
UNION ALL
SELECT 'trips', CASE WHEN count(*) = 0 THEN '0' ELSE '1+' END
  FROM "Trips" tr JOIN "OikosGroups" g ON g.id = tr.group_id WHERE g.base_currency IN ('usd','cny')
UNION ALL
SELECT 'insurance_usd_cny', CASE WHEN count(*) = 0 THEN '0' ELSE '1+' END
  FROM "InsuranceDetails" i WHERE i.currency IN ('usd','cny')
UNION ALL
SELECT 'cny_outings', CASE WHEN count(*) = 0 THEN '0' ELSE '1+' END
  FROM "Outings" o WHERE o.currency = 'cny';

SELECT upper(te.original_currency) AS code,
       CASE WHEN count(*) < 10 THEN '1-9' WHEN count(*) < 100 THEN '10-99' ELSE '100+' END AS rows
  FROM "TripExpenses" te WHERE te.original_currency IS NOT NULL GROUP BY 1;
```

## 附錄 B：dev 演練的假資料情境

第 2 階段的回填與第 3、4 階段的程式，先在 dev 用假資料跑完以下情境，§3.6 的 I1–I7 全部成立、畫面截圖只在「預期改變」的地方不同，才進 prod。

| # | 情境 | 預期 |
|---|---|---|
| 1 | TWD 帳本、只有目前章節 | 新欄＝舊欄；畫面不變 |
| 2 | USD 帳本、只有目前章節，含平分 $45 與依比例 33% 的 $10 | 新欄 ×100；`balance_minor = balance × 100`（D7 (c)）；畫面不變（第 3 階段）／顯示兩位（第 4 階段，預期改變） |
| 3 | 目前 USD、過去章節 TWD，章節內只有收入與結算 | 過去章節未知，新欄 NULL，畫面同今天 |
| 4 | 目前 TWD、過去章節 USD，章節內有 fold 出來的 USD 出遊結算 | 過去章節 `evidence_high`，依 USD 轉；畫面該章節改標 $（預期改變，D4） |
| 5 | 目前章節有已刪除的舊幣別列（刪光後改幣別） | 已刪除列新欄 NULL；畫面不變 |
| 6 | USD 帳本有定期規則與待確認卡，回填當天 16:00 UTC 排程照常跑 | 卡的兩欄一致；I2 成立 |
| 7 | 回填中途同一帳本有寫入 | 寫入等鎖；新列由程式或 trigger 填新欄；I7 成立 |
| 8 | 舊伺服器程式（第 2 階段前的 build）寫入一筆 | trigger 補新欄＝舊欄 × 10^p |
| 9 | 舊 JS 開著，另一邊記一筆 $12.50（第 4 階段） | 舊 JS 的 balance 顯示整數元，差 <1 元；沒有 100 倍 |
| 10 | 月度快照跨章節的月份 | 未知章節的 jsonb 沒有 `amountMinor` |
| 11 | 保險 USD 保單金額接近上限 | 新欄 `bigint` 不溢位；I6 成立 |
| 12 | R2：第 4 階段後退回舊程式，編輯一筆整數列、一筆小數列，再部署回新程式 | 整數列正確；小數列小數掉了（已知限制，§3.8） |
