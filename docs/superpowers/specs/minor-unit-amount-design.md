---
last_updated: 2026-11-19
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
> 行號以 2026-11-19 的 `origin/main`（`99e66d3`）為準。

## 名詞（全文一致）

- **最小單位整數**：DB 裡存的整數，單位是該幣別的最小單位。TWD／JPY 的 `1000` 是 1000 元；USD／CNY 的 `1000` 是 10.00。
- **整數元**：現在的做法。不分幣別，存的是使用者打的整數（USD 的 `45` 是 $45）。
- **小數位數**：某幣別顯示與輸入時的小數位數（TWD 0、USD 2）。最小單位整數 ＝ 顯示值 × 10^小數位數。
- **兩位小數帳本**：base currency 的小數位數是 2 的帳本（現在是 USD、CNY）。只有這種帳本的資料要轉換。
- **切換**：把一個帳本的資料從整數元轉成最小單位整數、並從此用新語意讀寫的那一刻。

---

## 1. 決定與取代

**Ray 原話（2026-11-19）**：「不是這樣 資料庫存整數　但在顯示層 如果幣別是 twd 那就是整數　如果是 usd / 或其他有小數的幣別 就用兩位小數 例如 1000 當作 10.00」

**理解**（Paula 記在 #1920 的「## 決定」留言，與原話分開）：DB 仍存整數，單位改成該幣別的最小單位。TWD／JPY：1000＝1000；USD／CNY：1000＝10.00，使用者可以輸入兩位小數。這取代 #1399 決定 (a) 與 #1582 的「一律整數元」。

**為什麼要改**：外部回報（#1920 開頭）要輸入小數。現在主記帳的金額框把小數點吃掉：打 `12.5` 會變成 `125`（Dev B 在 #1920 的查證留言；原因在 `app/(dashboard)/_components/AmountInput.tsx:121` 的 `replace(/[^0-9]/g, '')`），等於多記 10 倍，而且沒有錯誤。

### 被取代的句子

下表是現在 repo 裡寫著「一律整數元」的地方。**這些句子在切換那個 PR 合併前都還是真的**（描述現況），所以這份提案不改它們；切換的 PR 要同時改。

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

**撤回的連帶**：#1582 留下的警告「Do not reintroduce a precision-aware converter on a ledger path」（`lib/currency.ts:120-124`）也一起失效。它擋的錯是「單位混用」，新設計要擋的是同一種錯，只是方向反過來：**全部金額都用最小單位，任何地方再把它當整數元，就差 100 倍**。失效的樣子跟 #1582 一樣：沒有錯誤，USD 帳本記 $45 顯示成 $0.45，或 $12.50 顯示成 $1,250。

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
| GroupBalance | `balance`（153） | **是** | 帳本 base（現在） |
| GroupBalance | `version`（154） | 否 | — |
| CurrencyRates | `rate`（170，numeric 10,3） | 否（匯率） | 已棄用，只留給舊旅行 |
| CashTransactions | `amount`（207） | **是** | 帳本 base |
| CashTransactions | `split_ratio_a`（209） | 否（百分比） | — |
| CashTransactions | `original_amount`（225） | **是** | **`original_currency`**（不是 base） |
| CashTransactions | `rate_snapshot`（226，numeric 10,3） | 否（匯率） | — |
| Settlements | `amount`（238） | **是** | 帳本 base |
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
| IncomeTransactions | `amount`（444） | **是** | 帳本 base |
| IncomeTransactions | `original_amount`（454） | **是** | **`original_currency`** |
| IncomeTransactions | `rate_snapshot`（455，numeric） | 否 | — |
| RecurringIncomeRules | `amount`（466） | **是** | 帳本 base |
| RecurringIncomeRules | `interval_months`（470）、`day_of_month`（471） | 否 | — |
| PendingIncomeOccurrences | `proposed_amount`（485） | **是** | 帳本 base |
| RecurringExpenseRules | `amount`（496） | **是** | 帳本 base |
| RecurringExpenseRules | `split_ratio_a`（498）、`interval_months`（502）、`day_of_month`（503） | 否 | — |
| PendingExpenseOccurrences | `proposed_amount`（517） | **是** | 帳本 base |
| PendingExpenseOccurrences | `proposed_split_ratio_a`（522） | 否 | — |
| MonthlyReviewSnapshots | `year`（537）、`month`（538） | 否 | — |
| MonthlyReviewSnapshots | `top_category_total`（543）、`largest_expense_amount`（546）、`recurring_total_income`（558）、`recurring_total_expense`（559） | **是**（凍結的彙總） | 帳本 base（當月） |
| Trips | `budget_amount`（619） | **是** | **`budget_currency`**（自由文字） |
| TripExpenses | `amount`（638） | **是** | 帳本 base |
| TripExpenses | `original_amount`（642） | **是** | **`original_currency`**（自由文字） |
| TripExpenses | `split_ratio`（645） | 否 | — |
| Outings | `fold_amount`（676） | **是** | **出遊 `currency`**（666）；現在已是最小單位 |
| OutingExpenses | `amount`（708） | **是** | 出遊 `currency`；USD 已是分，CNY 還是整數元 |
| OutingExpenseShares | `share_amount`（722） | **是** | 同上 |
| OutingSettlements | `amount`（731） | **是** | 同上 |
| ImportBatches | 四個計數（747-750） | 否 | — |
| ImportErrors | `row_number`（762） | 否 | — |
| MonthlyReviewMessages | `year`（775）、`month`（776） | 否 | — |
| ShortcutPendingExpenses | `amount`（835） | **是** | 帳本 base |

另外未查證：`Assets.template_fields`（jsonb，`lib/db/schema.ts:192`）的 `number` 欄位可能被使用者當金額用（`TemplateAssetDetailClient.tsx:119` 直接 `toLocaleString`）。那是使用者自訂的純文字紀錄，不帶幣別，建議不轉換。

### 要補的一個欄位：章節的幣別

**現在沒有地方記「某一段章節當時的 base currency」**。`GroupEpochs`（`lib/db/schema.ts` 的 `groupEpochs`）沒有幣別欄；`setBaseCurrency` 只檢查「目前章節有沒有紀錄」（`actions/currency.ts:48`），所以一個帳本可以在上一段章節用 TWD、離開重來後改成 USD。CSV 匯出已經寫明這個缺口（`csv-export-design.md:106`：「舊章節的金額若是在另一個 base currency 下記的，檔案裡會標錯幣別」）。

整數元時代，這只是符號標錯。改成最小單位後，**同一個錯會變成差 100 倍**：過去章節的 NT$4,500 用 USD 的小數位數顯示成 $45.00。所以建議在第 2 階段（§7）加 `GroupEpochs` 的幣別快照（關章節時寫入，跟 `member_a_name` 一樣由 DB 函式凍結），過去章節一律用自己的幣別顯示。既有資料的處理見 §3。

---

## 3. 既有資料轉換

### 規模

**規模：未取得（沒有唯讀存取）。** 本 session 沒有 PostHog 連接器，也刻意不使用任何需要憑證的 prod 路徑。

可參考的歷史數字只有一筆，已公開在 #1582（2026-10-07 唯讀查詢）：當時 USD 帳本是**個位數**，TWD 帳本是**兩位數**，沒有列 CNY。這是一個多月前的數字，只能當參考，不能當現在的規模。

可用的 proxy（給之後有 PostHog 存取的人；本 session 沒跑）：
- `setup_completed` 帶 `base_currency`（`actions/group.ts:79-80`，server 事件）：建帳本時的幣別。是**下限也是上限都不準**的 proxy：建帳本後改幣別不會反映。
- `base_currency_changed` 帶 `from_currency`／`to_currency`（`actions/currency.ts:63-66`）：改過幣別的次數。只能看筆數分布，不能當帳本數（同一本可改多次）。
- 兩者都只做 `count` 依幣別分組，不看個人。照 `observability-design.md` 第 0 條，用之前再 grep 一次發送點。

**給有權限的人跑的唯讀 SQL**（SELECT only；只回傳級距，不輸出帳本 id 或使用者；連線方式由 Ray 決定，這份不寫）：

```sql
-- 只回傳級距，不回傳個別帳本。
SELECT 'groups' AS what, g.base_currency::text AS cur,
       CASE WHEN count(*) < 10 THEN '1-9' WHEN count(*) < 100 THEN '10-99' ELSE '100+' END AS bucket
  FROM "OikosGroups" g GROUP BY g.base_currency
UNION ALL
SELECT 'cash_rows', g.base_currency::text,
       CASE WHEN count(*) < 10 THEN '1-9' WHEN count(*) < 100 THEN '10-99'
            WHEN count(*) < 1000 THEN '100-999' ELSE '1000+' END
  FROM "CashTransactions" t JOIN "OikosGroups" g ON g.id = t.group_id
 WHERE g.base_currency IN ('usd','cny') GROUP BY g.base_currency
UNION ALL
-- 過去章節有紀錄的兩位小數帳本：這些帳本的舊紀錄可能是別的幣別記的（§2）
SELECT 'groups_with_closed_epoch_rows', g.base_currency::text,
       CASE WHEN count(DISTINCT g.id) = 0 THEN '0' WHEN count(DISTINCT g.id) < 10 THEN '1-9' ELSE '10+' END
  FROM "OikosGroups" g JOIN "GroupEpochs" e ON e.group_id = g.id AND e.ended_at IS NOT NULL
 WHERE g.base_currency IN ('usd','cny')
   AND EXISTS (SELECT 1 FROM "CashTransactions" t WHERE t.group_id = g.id AND t.created_at < e.ended_at)
 GROUP BY g.base_currency
UNION ALL
-- ×100 後會超過 int4 的列數（應為 0；不是 0 就要先決定怎麼處理）
SELECT 'overflow_risk_rows', NULL,
       CASE WHEN count(*) = 0 THEN '0' WHEN count(*) < 10 THEN '1-9' ELSE '10+' END
  FROM "InsuranceDetails" i WHERE i.currency IN ('usd','cny')
   AND greatest(coalesce(i.sum_insured,0), coalesce(i.coverage_amount,0),
                coalesce(i.expected_maturity_amount,0), coalesce(i.account_value,0)) > 21474836
UNION ALL
-- 奇數金額的平分／依比例分支出：轉換後重算 balance 會有幾分錢的差（§5.3）
SELECT 'odd_split_rows', g.base_currency::text,
       CASE WHEN count(*) = 0 THEN '0' WHEN count(*) < 10 THEN '1-9' WHEN count(*) < 100 THEN '10-99' ELSE '100+' END
  FROM "CashTransactions" t JOIN "OikosGroups" g ON g.id = t.group_id
 WHERE g.base_currency IN ('usd','cny') AND t.split_type IN ('half','weighted') AND t.amount % 2 = 1
 GROUP BY g.base_currency
UNION ALL
SELECT 'outings', o.currency::text,
       CASE WHEN count(*) = 0 THEN '0' WHEN count(*) < 10 THEN '1-9' ELSE '10+' END
  FROM "Outings" o WHERE o.currency = 'cny' GROUP BY o.currency
UNION ALL
SELECT 'trip_original_codes', upper(te.original_currency),
       CASE WHEN count(*) < 10 THEN '1-9' WHEN count(*) < 100 THEN '10-99' ELSE '100+' END
  FROM "TripExpenses" te WHERE te.original_currency IS NOT NULL GROUP BY upper(te.original_currency);
```

（欄位名以 `lib/db/schema.ts` 為準，未在真的 DB 上跑過，**未查證能否直接執行**。soft delete 的列也算進去。）

### 要轉換的資料

只轉**兩位小數帳本**，以及**幣別欄本身是兩位小數的列**。TWD／JPY 帳本一列都不動。

| 表與欄 | 條件 | 轉換 |
|---|---|---|
| CashTransactions `amount`、IncomeTransactions `amount`、Settlements `amount`、TripExpenses `amount` | 帳本 base 是 USD／CNY，且列屬於「幣別確定是現在 base」的章節 | ×100 |
| CashTransactions／IncomeTransactions `original_amount` | `original_currency` 是 USD／CNY（不看帳本 base） | ×100 |
| TripExpenses `original_amount`、Trips `budget_amount` | 幣別代碼在 §2 表中是 2 位（要 Ray 決定 D2） | ×100 |
| RecurringIncomeRules／RecurringExpenseRules `amount`、Pending*Occurrences `proposed_amount`、ShortcutPendingExpenses `amount` | 帳本 base 是 USD／CNY | ×100 |
| MonthlyReviewSnapshots 四個金額欄 | 帳本 base 是 USD／CNY，且月份屬於現在 base 的章節 | ×100 |
| GroupBalance `balance` | 帳本 base 是 USD／CNY | **不直接 ×100**：轉完上面的列後用 `lib/balance.ts` 的規則重算（理由見 §5.3） |
| OutingExpenses／OutingExpenseShares／OutingSettlements、Outings `fold_amount` | 出遊 `currency` 是 CNY | ×100（USD 出遊已經是分，**不動**） |
| CarDetails／HouseDetails `purchase_price`、PetDetails `purchase_cost`、PlantDetails `cost` | 帳本 base 是 USD／CNY | ×100（要 Ray 決定 D6） |
| InsuranceDetails 金額欄 | 保單 `currency` 是 USD／CNY（不看帳本 base） | ×100（要 Ray 決定 D6） |

**「幣別確定」的判斷**：現在沒有章節幣別快照（§2），所以 USD／CNY 帳本在**已結束章節**裡的列，不能確定當時是什麼幣別。建議：
1. 先跑上面的 SQL 看 `groups_with_closed_epoch_rows`。
2. 如果是 0，全部列都屬於現在的 base，直接轉。
3. 如果不是 0，這幾本由 Ray 個別決定（§8 D4）；預設是「已結束章節的列不轉、章節幣別快照填 `twd`」，因為帳本預設幣別是 TWD（`lib/db/schema.ts:79`），改成 USD／CNY 的人比較可能是從 TWD 改過來。這是推測，**未查證**。

### 相依的 DB 物件

| 物件 | 位置 | 影響 |
|---|---|---|
| `CHECK (amount > 0)` 等 | `drizzle/0012_income_transactions.sql:11`、`0016_recurring_income.sql:26,53`、`0021_recurring_expense.sql:21,49`、`0066_outing_tables.sql:59,73,82`；`ShortcutPendingExpenses_amount_positive`（`lib/db/schema.ts:841`） | ×100 不會讓正數變成非正數，不用改 |
| int4 上限 2,147,483,647 | 所有金額欄是 `integer` | 單筆上限 `MAX_AMOUNT = 9_999_999`（`lib/validators.ts:22`）×100 還在範圍內；保險與資產欄位沒有上限（`lib/validators.ts:812-848` 只擋負數），×100 可能溢位。轉換 migration 遇到溢位會整批失敗並回滾，不會寫壞資料；SQL 的 `overflow_risk_rows` 先查 |
| `SUM(amount)::integer` | 月度回顧快照函式（最新定義在 `drizzle/0093_review_snapshot_chapter.sql:68`） | 單位無感；兩位小數帳本一個月要超過 $21,474,836 才會溢位 |
| 定期規則產生待確認 | `generate-pending-income`／`generate-pending-expense`，每天 16:00 UTC（`drizzle/0064_recurring_cron_taipei_date.sql:65,90`），把 `r.amount` 原樣抄進 `proposed_amount`（同檔 68） | 規則與待確認卡必須在**同一個 transaction** 轉換；不然轉換中途產生的卡是舊單位 |
| 其他排程 | `sweep-orphan-ledgers` 15:00 UTC（`0096...sql:660`）、`monthly-review-snapshot` 每月 1 日 16:05 UTC（`0096...sql:667`）、`notify-recurring-push` 16:10 UTC（`0100...sql:78`）、`process-account-deletions` 16:30 UTC（`0059...sql:9`）、`cleanup-shortcut-pending` 19:20 UTC（`0098...sql:111`）、`cleanup-soft-deleted` 週日 03:00 UTC（`0097...sql:54`） | 轉換避開 15:00–16:45 UTC 與每月 1 日 |
| Realtime | `CashTransactions`、`Settlements`、`GroupBalance`、`OikosGroups` 的 `postgres_changes`（`app/(dashboard)/_components/RealtimeProvider.tsx:81-122`） | 轉換的每一列 UPDATE 都會推給開著的分頁；`GroupBalance` 的新值會直接進 balance 畫面（同檔 111）。舊前端會把新值當整數元顯示（§4） |
| 備份 | 備份用的 view 在 `drizzle/0082_backup_auth_views.sql`；備份內容與還原流程**未查證** | 轉換前要有一份可還原的快照（§7 回滾） |
| generated column、金額 trigger | grep `drizzle/*.sql` 未找到跟金額有關的 generated column 或 trigger | 無 |

### 轉換步驟（概念，不是 runbook）

1. 前置：第 1～3 階段已上線並穩定（§7）。前端已經會依「帳本是否已切換」讀寫。
2. 備份快照。
3. 在 15:00–16:45 UTC 以外、不是每月 1 日的時段，一個帳本一個 transaction：鎖帳本列 → 轉換上表的列 → 重算 `GroupBalance` → 把帳本標成「已切換」。一本失敗只回滾那一本。
4. 跑一次只回傳級距的驗證 SQL（轉換前後各帳本 balance 差額的分布、未轉換的兩位小數帳本數應為 0）。

### 回滾

- **轉換後、還沒有人輸入小數之前**：每本 ÷100、清掉「已切換」標記，可以完全還原（重算後的 balance 也會回到原值）。
- **有人輸入小數之後**：÷100 會得到非整數，**不可逆**。只能從快照還原，切換後新記的帳會遺失。所以「不可逆點」是「切換後第一筆非整數元的輸入」，不是 migration 本身。

---

## 4. 新舊版並存

web、PWA、iOS／Android 殼都載入同一個 prod URL（`capacitor.config.ts:23,57-58`：`server.url` 預設是 prod）。所以**殼不用發新版**就會拿到新前端；但「已經載入的舊 JS」會繼續跑一陣子。

會拿著舊 JS 的情況：

| 情況 | 舊 JS 會做什麼 | 失效的樣子 |
|---|---|---|
| 開著沒重整的分頁、背景中的殼 | 用整數元送出；把收到的金額當整數元顯示 | 收到 Realtime 的新 balance（已 ×100），顯示「對方欠你 $4,500」，實際是 $45.00 |
| PWA 離線快取（opt-in，`offline-browsing-design.md:38-40`） | 離線時顯示快取的舊頁面，HTML 與 JS 是同一版 | 舊頁面配舊資料，本身一致；上線後頁面 network-first（3 秒逾時，同檔 39）會換新。風險低 |
| Server Action 的 deploy skew | 舊頁面呼叫 server action，送 `{ amount: 45 }` | 新 server 若把 `amount` 當最小單位，存成 $0.45；**沒有錯誤** |
| iOS 捷徑、快速記帳 URL | 永遠送整數元（`ios/App/App/QuickAddIntent.swift:60-62` 把 Double 四捨五入成 Int） | 新 server 若當最小單位，記 $1.20 |
| 定期規則排程 | DB 內 SQL，只抄數字 | 轉換跟產生卡不在同一個 transaction 時，卡的單位跟規則不一樣 |

repo 裡沒有「最低前端版本」或強制重整的機制（grep `skew`／`deploymentId`／`minVersion` 只找到 `NEXT_PUBLIC_BUILD_ID`，`next.config.ts:212`，給 SW 用）。Vercel 的 Skew Protection 有沒有開：**未查證**（不在 repo 設定裡）。Next.js 的 server action id 跨部署是否不變：**未查證**。

### 建議：先雙讀雙寫，再切換

1. **server 端永遠能分辨單位**：action 的輸入改用新欄位名（例如帶明確的單位標記）。舊前端送的舊欄位一律當**整數元**，在 server ×10^小數位數 後寫入。這樣舊分頁、捷徑、快速記帳 URL 送來的金額在切換前後都是對的。零位小數帳本兩者相同，不影響 TWD／JPY 使用者。
   - 失效的樣子（若不做）：切換後，舊分頁記的每一筆 USD 都少 100 倍，帳上看起來是 $0.45，沒有錯誤。
2. **帳本層的「已切換」標記**：新前端依標記決定讀法，所以 migration 跟部署的先後不會造成空窗。CLAUDE.md 的發版規矩是「prod 先套用 migration、再 merge」（`CLAUDE.md:144`），沒有標記的話，中間那幾分鐘舊程式會讀新資料。
3. **新前端偵測自己過期**：在雙讀那一版加上「server 回報的 build 和自己不同就整頁重整」。這只能保護雙讀之後才載入的頁面，所以**雙讀上線後要等一段時間再切換**（等待多久要 Ray 決定，§8 D5）。
4. **不需要 API 版本**：唯一的外部 API 是捷徑待處理（`app/api/shortcut/pending/route.ts`），建議維持整數元（§5.5），所以不必分版本。

是否「硬性擋舊版」（舊欄位直接回錯、要使用者重整）：要 Ray 決定（§8 D5）。建議不擋寫入（第 1 點已經讓它正確），只靠第 3 點讓舊頁面重整。

---

## 5. 邏輯與邊界

### 5.1 金額輸入（`AmountInput`）

現況：`inputMode="numeric"`（`AmountInput.tsx:112`），送出前去掉所有非數字（121），顯示用 `parseInt(...).toLocaleString`（74）。各 sheet 再 `parseInt`：`AddSheet.tsx:394`、`IncomeSheet.tsx:194`、`SettlementSheet.tsx:70`、`RecurringRuleSheet.tsx:419`。

設計：
- 元件要知道幣別（或小數位數）。兩位小數帳本用 `inputMode="decimal"`，零位小數帳本維持 `numeric`。
- 零位小數帳本打 `.`：不能再把後面的數字併進去（這就是 #1920 的「12.5 變 125」）。建議直接不接受 `.`（輸入不會出現）。若要顯示提示，需要新字串，屬於 needs-copy，這份不寫字串。
- 超過小數位數（例如 `12.345`）：要 Ray 決定（§8 D3）。建議**不接受第三位**（打不進去），不要四捨五入，因為使用者看不到被改掉的那一位。
- 要處理的輸入：全形數字與全形句點 `．`、日文 IME 的 `。`、千分位逗號、開頭是 `.`（`.5`）、結尾是 `.`（`12.`）、空字串。全形數字的處理 `lib/quickAdd.ts` 已經有（`FULLWIDTH_DIGIT_RE`），可以共用。
- 小數點符號：四個語系（`lib/i18n/locales/` 的 en、ja、zh-CN、zh-TW）都用 `.`，不處理 `,` 當小數點的語系。

### 5.2 字串 → 最小單位整數

**不得用浮點數**。`Math.round(12.35 * 100)` 在 JS 是 1235，但 `1.005 * 100` 是 100.49999…，結果會少一分。做法是字串拆整數與小數部分，小數補零到小數位數，再組成整數字串。

現在已經有用浮點數的地方，切換時要一起改：
- 出遊支出：`ExpenseSheet.tsx:102`（`Number(amountRaw)`）、`117`（`Math.round(parsedAmount * 100)`）；`inputMode="decimal"`（181）。這就是 #1920 指的 `ExpenseSheet.tsx:178` 附近，USD 出遊現在就是這樣收小數、存分。
- 出遊還款：`SettleSheet.tsx:33,39`。
- CSV 匯入：`lib/csvImport/mapper.ts:89`（`Math.round(Math.abs(n))`，直接丟掉小數）、`lib/csvImport/ofxParser.ts:81`。

伺服器驗證：`validateAmount`（`lib/validators.ts:29-36`）只檢查正整數，單位無感，可以保留；但上限要依小數位數放大（§5.4）。

### 5.3 分帳、餘數與 balance

規則本身不用改，因為它們都是整數運算，只是單位變小：

| 位置 | 規則 | 改成最小單位後 |
|---|---|---|
| `lib/balance.ts:19,28-31` | 平分 `ceil(amount/2)`；依比例 `ceil(amount × 比例 / 100)` | 同一條規則；奇數的差從 1 元變成 1 分 |
| `lib/tripSummary.ts:50,58,140` | 同上（`ceil`） | 同上 |
| `lib/outing/split.ts:17-22` | 平均分，餘數一個最小單位一個最小單位分給前面的人 | 不變；CNY 出遊的餘數從 1 元變成 1 分 |
| `actions/outing.ts:546` | fold 時 `minorToWhole`（四捨五入成整數元） | **拿掉**：出遊與帳本單位相同，直接寫入，不再丟掉零頭 |
| `lib/settlement.ts:15-19` | 結算快選「整數」：四捨五入到 100 | 要改成「100 個顯示單位」（兩位小數帳本是 10,000）；否則 USD 的「整數」快選變成 $1 |

**轉換時 balance 會變一點（重大風險）**：舊資料用整數元算 `ceil`，轉換後用分算，結果不同。例：USD 帳本一筆 $45 平分，舊算法對方欠 $23；轉換成 4500 分後重算是 2250 分（$22.50）。每一筆奇數金額的平分或依比例分支出，差最多 1 個舊單位以內（$0.50～$0.99）。失效的樣子：兩人上週剛結清，切換後首頁出現「你欠對方 $1.50」，沒有任何紀錄解釋它。

選項（要 Ray 決定，§8 D7）：
- (a) 接受重算，差額照實顯示。最簡單；差額大小先用 §3 SQL 的 `odd_split_rows` 估。
- (b) 每本帳寫一筆系統結算抵銷差額。帳一致，但多一筆使用者沒記過的紀錄，且要新 UI 字串。
- (c) `GroupBalance` 直接 ×100 不重算。**不可行**：下一次寫入就全量重算（`domain-model-design.md:23`），差額照樣出現，只是延後、更難解釋。

建議 (a)，前提是 SQL 顯示差額很小；若某本差額明顯，改 (b)。

### 5.4 格式化

- `formatLedgerAmount*`（`lib/currency.ts:95-109`）改成依小數位數除以 10^n 並顯示固定位數；`formatAmount*`（75-85，現在只給出遊）可以跟它合併。用到 `formatLedgerAmount*` 的檔案共 31 個，分類：首頁與 sheet（`app/(dashboard)/dashboard/_components/`，8）、愛物與保險（`assets/`，15）、紀錄與統計（`records/`，2）、旅行、定期、月度回顧、共用元件各 1、`lib/` 1、i18n 註解 1。
- **繞過格式化函式的地方**（風險較高，因為不會跟著改）：直接 `toLocaleString` 的金額大約十幾處，例如 `MonthlyStatsBars.tsx:207`、`MonthlyStatsPieChart.tsx:203`、`PendingCard.tsx:143`、`CompactRow.tsx:29,180`、`SettlementForm.tsx:155`、`LeaveGroupFlow.tsx:578`、`StepConfirm.tsx:76`、保險的 `SavingsHero.tsx:13`、`MaturedAwaitingPrompt.tsx:47,65`、`InsuranceDetailClientLegacy.tsx:120`。失效的樣子：首頁對了，但統計圖的數字或待確認卡還是 4500。實作時要 grep `toLocaleString` 逐一處理，並加一個測試擋新的直接呼叫。
- 錯誤訊息的上限：`AddSheet.tsx:376`、`IncomeSheet.tsx:198`、`lib/validators.ts:34` 把 `MAX_AMOUNT` 直接顯示。`MAX_AMOUNT` 若維持 9,999,999 個最小單位，USD 上限從 $9,999,999 變成 $99,999.99。建議上限定義成「顯示單位」再乘 10^n，讓各幣別的上限數字相同。

### 5.5 快速記帳 URL 與捷徑 API

現況：快速記帳 URL（`lib/quickAdd.ts:10-11`）與捷徑待處理 API（`app/api/shortcut/pending/route.ts:8`，經 `parseQuickAddJson`，298）只收正整數，單位是整數元（`lib/quickAdd.ts:41-52`）。iOS App Intent 把 `Double` 四捨五入成 Int 再組 URL（`QuickAddIntent.swift:40,60-62`）。

建議：**對外介面維持「顯示單位」（元／$），在邊界轉成最小單位**。理由：
- 使用者已經存好的捷徑、教學頁（`app/[locale]/features/shortcuts/`）與 `docs/shortcuts/linepay-quick-add.md` 的範例都寫 `amount=120`；改成最小單位會讓 USD 使用者的舊捷徑少記 100 倍，而且沒有錯誤。
- 原生 App Intent 在殼裡，改它要發 App 新版；維持整數元就不用。
- 之後若要支援 `12.50`，在同一個邊界加上小數解析即可，與舊格式相容（整數仍是整數元）。

失效的樣子（若改成最小單位）：iPhone 捷徑送 `{"amount": 120}`，USD 帳本的待確認卡顯示 $1.20。

### 5.6 CSV 匯入與匯出

- **匯出**：`lib/csv/transactions.ts:142,144` 寫 `String(r.amount)`。切換後要依該列的幣別寫成顯示值（`12.50`），原幣欄依 `original_currency`。不改的話，匯出檔的 USD 金額全部是 100 倍。過去章節依章節幣別快照（§2）。
- **匯入（Futari 格式）**：`csv-import-design.md:117` 拒收 `1.50`。改成：兩位小數帳本接受最多兩位小數；零位小數帳本仍拒收小數（不四捨五入，理由同 §5.1）。匯出再匯入要能原樣回來，這是驗收條件。
- **匯入（競品格式）**：`mapper.ts:89` 把小數四捨五入成整數。兩位小數帳本改成字串解析保留兩位；零位小數帳本維持四捨五入（競品的 TWD 資料偶爾帶 `.00`，拒收會讓整份匯入失敗）。
- 匯入的上限與重複判斷：上限見 §5.4；重複判斷的 hash 用 `amount(integer)`（`csv-import-design.md:209`），切換前匯入的批次與切換後的檔案會判不出重複。影響小，記下即可。

### 5.7 定期規則、待確認卡

規則存的是金額（§2），排程把它原樣抄成待確認卡。轉換時規則與卡同一個 transaction（§3）。`RecurringRuleSheet.tsx:419` 的 `parseInt` 要換成 §5.2 的解析。

### 5.8 匯率換算

- 主帳本記外幣：`actions/transaction.ts:113,260`、旅行：`actions/tripExpense.ts:111,120`、預覽：`AddSheet.tsx:683`（經 `lib/trip-currency.ts:120-143`）。都用 `convertWholeUnits`（`lib/currency.ts:126`）。
- 匯率的語意是「1 個顯示單位換多少顯示單位」（`lib/db/schema.ts:164`）。改成最小單位後，換算要乘上 10^(目標小數位數 − 來源小數位數)。例：USD 帳本記 ¥1000、匯率 0.0067 → 1000 × 0.0067 × 100 = 670 分。忘了這個係數就差 100 倍。
- 「正數至少為 1」的規則（`convertWholeUnits` 的契約）保留，單位變成 1 個最小單位。
- **匯率精度**：`rate_snapshot` 是 `numeric(10,3)`（`lib/db/schema.ts:226,455`）。JPY→USD 0.0067 只能存成 0.007（差約 4%）。整數元時代被四捨五入蓋過，顯示到分之後看得出來。建議另開一項評估放寬精度（§8 D8），不擋本案。

### 5.9 其他檢查

| 項目 | 結果 |
|---|---|
| 統計、月檢視 | 走 `formatLedgerAmount*`，加上 §5.4 列出的直接 `toLocaleString`。`DailyTrendChart` 的 `toFixed` 是座標，不是金額 |
| 收入（`income-design.md`） | 該檔沒有寫金額單位（grep「整數」無結果）；程式路徑同支出（`IncomeSheet.tsx:194`、`lib/validators.ts:199`） |
| 月度回顧 | 快照凍結金額（§2），要轉換；回顧卡用 `CardShell.tsx` 的格式化 |
| 推播 | `supabase/functions/send-recurring-push/` grep 不到金額，推播內文不含金額 |
| email | grep 不到寄信的程式路徑 |
| PostHog | `settlement_created` 帶 `amount_bucket`（`actions/settlement.ts:65`），門檻是原始整數，本來就不分幣別。切換後 USD 的級距會整體往上跳（$5 變成 500）。建議改成依顯示單位分級距，並在 `observability-design.md` 註明部署日前後不可比 |
| Sentry | 捷徑 API 明定金額不外送（`route.ts:52`），`actions/shortcutPending.ts:22` 同；其他路徑未逐一查證 |

---

## 6. 選項比較

| 選項 | 內容 | 成本 | 風險 | 失效的樣子 |
|---|---|---|---|---|
| **① 最小單位整數（Ray 的決定）** | 本檔的設計 | 大：資料轉換、約 31＋十幾個顯示點、輸入解析、匯率換算、CSV、新舊版並存 | 轉換與新舊版並存期間的 100 倍誤差；balance 重算差額（§5.3） | 任何一個漏改的顯示點把 4500 分當 $4,500 |
| ② 維持整數元、放寬輸入 | 收小數，但四捨五入成整數元存 | 小 | 使用者打 $12.50 存成 $13，帳永遠對不上收據 | 不會報錯，只是每筆差幾毛，月底對不起來 |
| ③ 改 `numeric` 欄位 | DB 存小數 | 最大：所有欄位型別、Drizzle 讀出來是字串、所有運算要改 decimal 函式庫 | JS 浮點誤差回到計算裡 | `0.1 + 0.2` 類型的一分錢誤差散在 balance |

① 是 Ray 的決定；② 與 ③ 列在這裡只為說明為什麼不採用。

---

## 7. 分階段計畫

每個 PR 都可以單獨合併。**第 1～3 階段上線後，使用者看不到任何變化**（所有帳本都還沒切換）。**第 4 階段是使用者第一次看到變化的時候**；第 4 階段之後有人輸入小數，就**不可逆**（§3 回滾）。

| # | 範圍 | 測試 | 風險 | 能單獨上線？ |
|---|---|---|---|---|
| 0 | 修 #1920 的直接陷阱：所有帳本打 `.` 都不再把後面的數字併進去（這時還沒有帳本支援小數，所以 USD／CNY 也一樣擋） | `AmountInput` 單元測試 | 低；要不要提示字串另開 needs-copy | 是。可進 v1.10.1 |
| 1 | 小數位數表、字串→最小單位解析、最小單位格式化函式（先不接到畫面） | 單元測試：全形、`.5`、`12.`、`1.005`、上限 | 低，沒有呼叫點 | 是。可進 v1.10.1 |
| 2 | `GroupEpochs` 章節幣別快照（加欄位＋關章節時寫入＋回填目前章節）；帳本「已切換」標記欄位，預設全部未切換 | migration 測試、epoch 測試 | 低；純加欄位。照發版規矩 prod 先套 migration | 是 |
| 3 | 雙讀雙寫：所有輸入、顯示、換算、CSV、fold、settlement 快選依「已切換」標記決定；server 收舊欄位當整數元；過期前端自動重整；PostHog 級距 | 每個顯示點在「已切換」與「未切換」各一個測試；`toLocaleString` 掃描測試；舊欄位相容測試 | 中：範圍大、改的檔多。未切換時行為必須與現在完全一樣 | 是（使用者看不到變化） |
| 4 | 資料轉換 migration（§3），逐本切換 | 在 dev DB 用假資料跑轉換與回滾；驗證 SQL | **高**；不可逆點在這之後 | 要先等第 3 階段穩定並過等待期 |
| 5 | 清理：拿掉「已切換」標記與舊路徑、改 §1 表中的 spec 句子 | 回歸測試 | 低 | 第 4 階段後一段時間 |

規模：**大**（第 3 階段跨數十個檔；第 4 階段動 prod 資料）。

里程碑建議：
- **v1.10.1 放得進**：第 0、1 階段。理由：不動資料、不改畫面上的金額、可以單獨回退；第 0 階段直接修掉 #1920 回報的「多記 10 倍」。
- **v1.10.1 放不進**：第 2～5 階段。理由：v1.10.1 的主題是商店文案與殼發版（milestone 說明），且第 3 階段需要獨立驗證、第 4 階段需要 Ray 選時段與等待期。建議第 2、3 階段放 v2.0.0 之前的一個小版，第 4 階段在其後；確切版號要 Ray 決定（§8 D9）。

回滾計畫：
- 第 0～3 階段：revert PR 即可（第 2 階段的欄位留著無害）。
- 第 4 階段：見 §3「回滾」。切換前先備份；切換後到第一筆小數輸入前可 ÷100 還原；之後只能從備份還原。

---

## 8. 要 Ray 決定

| # | 問題 | 選項 | 建議 | Ray 沒回時的預設 |
|---|---|---|---|---|
| D1 | 四個幣別的小數位數 | 照 §2 表／其他 | 照表：TWD 0、JPY 0、USD 2、CNY 2 | 照表 |
| D2 | 旅行自由文字幣別（VND、EUR…）的小數位數 | (a) 不在表中的一律 0，舊資料不動 (b) 照 ISO 4217 建表並轉換舊資料 | (a)：先只處理主帳本四個幣別，日後要 EUR 小數再加列（加列時要轉該幣別舊資料） | (a) |
| D3 | 輸入超過小數位數（`12.345`、TWD 打 `.`） | (a) 打不進去 (b) 四捨五入 (c) 顯示錯誤 | (a)，使用者看得到的就是存的 | (a) |
| D4 | 過去章節幣別不確定的兩位小數帳本（§3） | (a) 舊章節列不轉、快照填 `twd` (b) 全部當現在的 base (c) 個別問使用者 | 先跑 SQL；是 0 就不用決定；不是 0 選 (a) | (a) |
| D5 | 新舊版並存期 | (a) 不擋舊版寫入、server 轉換、過期自動重整，等待期後切換 (b) 硬性擋舊版 | (a)；等待期至少一週（未查證殼在背景能留多久） | (a)，一週 |
| D6 | 愛物與保險的金額欄要不要一起轉 | (a) 一起轉 (b) 維持整數元，用另一個格式化函式 | (a)：同一個格式化函式、同一條規則，少一種單位混用 | (a) |
| D7 | 轉換後 balance 的分錢差額（§5.3） | (a) 照實重算 (b) 系統結算抵銷 | 看 SQL 結果；差額小選 (a) | (a) |
| D8 | 匯率精度 `numeric(10,3)` | 放寬／維持 | 另開票評估，不擋本案 | 維持，另開票 |
| D9 | 里程碑與轉換時段 | — | 0、1 進 v1.10.1；2、3 一個小版；4 在其後，避開 15:00–16:45 UTC 與每月 1 日 | 同建議，時段由 Ray 指定 |
| D10 | 快速記帳 URL／捷徑 API 的金額單位 | (a) 維持顯示單位 (b) 改最小單位 | (a)（§5.5） | (a) |
| D11 | 以後加幣別的規則 | — | 加列時同時定小數位數；有資料後不可改 | 同建議 |

---

## 驗收（切換完成後）

- USD 帳本輸入 `12.50` 存 1250、顯示 $12.50；TWD 帳本打不進 `.`，`1000` 存 1000、顯示 NT$1,000。
- 切換前記的 USD $45 切換後顯示 $45.00（存 4500）。
- 任何版本的舊分頁送整數元 45 到 USD 帳本，存 4500（寫入正確；只有雙讀之前的舊頁面「顯示」會錯，靠等待期處理，§4）。
- 捷徑送 `{"amount": 120}` 到 USD 帳本，待確認卡顯示 $120.00。
- USD 帳本匯出 CSV 再匯入，金額原樣回來。
- 過去章節（章節幣別 TWD）在目前 USD 的帳本裡仍顯示 NT$。
- grep 不到繞過格式化函式直接 `toLocaleString` 的金額。

## 不做的事

- 不改 `numeric`；不改成 bigint（溢位只在保險、資產欄位，先用 SQL 確認）。
- 不支援以 `,` 當小數點的語系。
- 不做本檔以外的幣別新增。
- 推播、email 不含金額，不處理。
