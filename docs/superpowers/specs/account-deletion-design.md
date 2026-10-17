---
last_updated: 2026-10-17
status: shipped
first_shipped_in: v1.5.1
related_specs: [native-auth, product]
related_issues: ["#923", "#848", "#1604", "#1618", "#1619", "#1701"]
---

# Account Deletion（帳號刪除）

## 這是什麼

讓使用者**在 app 內發起刪除自己的帳號**，並由後台在承諾的期限內真正移除資料。

這是 App Store / Play Store 上架的硬性 blocker：Apple Guideline 5.1.1(v) 與 Google Play 都要求「有註冊功能就必須提供 app 內可發起的帳號刪除」。現況只有登出（`actions/auth.ts#signOut`），沒有刪除——而且隱私政策已白紙黑字承諾「可透過設定頁刪除帳號、14 個工作天內移除」（[zh-TW.ts](../../../lib/i18n/locales/zh-TW.ts) `sectionRightsTitle` / `sectionRightsBody` / `sectionRetentionTitle` / `sectionRetentionBody`），等於目前是空頭支票。

給誰看：實作這個 feature、或日後維護刪除/匿名化邏輯的人。

## 為什麼這樣設計

### 為什麼是「請求制 + 後台處理」，不是按下去同步刪光

審核要的是 app 內能**發起**刪除，**不要求**按下當下就同步把整串共享帳本連動清乾淨。所以拆成兩段，把複雜度留在後台：

- **App 內（輕）**：標記「我要刪」+ 登出。零前置條件。
- **後台（重）**：每日 cron 在 14 天後處理，跑真正破壞性的刪除 / 匿名化。

這同時換到一個 grace period：14 天內可取消，是 Google / GitHub 等帳號刪除的標準安全網，防誤刪與惡意刪。

### 為什麼刪除入口零前置條件

刪除是 store 強制的權利，不能被「先把 balance 結清」「member_a 要先 swap」這類關卡擋住——任何障礙都可能被審核判不合格。所有前置複雜度（NOT NULL 的 member_a、未結 balance）都移到後台處理時解。

### 為什麼配對情境用「匿名化刪除者、另一半保留完整歷史」

這是兩人共享的帳本，很多交易是兩人共同的記錄；產品哲學是「陪伴 / 生命光譜 / 過去章節 read-only」。若因一方離開就掏空或摧毀另一半的記錄，違背核心立場。所以：

- 刪除者的交易 / 愛物**留在 group**，成為另一半保留的共享帳本。
- 移除刪除者真正的 PII（登入、email、provider 身分、顯示名、頭像）。
- 共享交易上的人名顯示為「已離開的夥伴」。
  - 自 #1619 起，「已離開的夥伴」**不再等於帳號已刪除**：離開帳本的人可以自己選擇，把自己在已離開帳本的已關閉章節裡的名字換成同一個字樣，帳號仍在（見 [after-leaving](after-leaving-design.md)「人：停在當時」）。判斷帳號是否刪除要看 `auth.users`（`public.profile_is_live`），不能看這個名字。
    - 失效的樣子：沒有任何錯誤；某段程式或文案把「名字是已離開的夥伴」當成「帳號已刪除」，對一個還在的人做了只該對已刪除帳號做的事。

**不採用**的替代方案：

- *沿用 `leaveGroup` 拆分後刪掉刪除者那份* — 重用既有邏輯、代碼少，但另一半只剩自己的交易，共享歷史被掏空。與哲學衝突。（自 #1611 起 `leaveGroup` 本身也不再拆分紀錄，見下。）

**自願離開之後的刪除（#1611 → #1701，2026-10-15 擁有者定案）**：自願離開不再搬走紀錄，兩人的共同章節完整留在留下那一方的帳本。因此：

- 留下的人（D）之後在單人狀態刪除帳號：D 一個人時記下的東西刪除，但**共同章節留給離開的人（X）回看**，直到 X 也刪除帳號（或所有仍活著的離開者都刪除）才一起刪。這本沒有任何現任成員、只為離開的人留著的帳本稱為**孤兒帳本**（orphan ledger）。
- 離開的人之後刪除帳號，只刪他的新帳本；他在共同章節記下的紀錄留在對方帳本，名字顯示為「已離開的夥伴」。
- 隱私權政策 `sectionRetentionItems` 的第 1、2 項、服務條款的刪除條款、刪除確認對話框各補一句說明（文案 #1688）。
- 失效的樣子：若離開時把離開者的已確認定期卡片（`resolved_tx_id`）跟著規則搬走，而交易留在原帳本，留下那一方的刪除會在 `_delete_group_cascade` 撞外鍵，每天一筆 WARNING、帳號永遠刪不掉（#1377 的症狀）。`leaveGroup` 因此在離開時刪掉那些已確認卡片。

**撤回紀錄（#1701）**：2026-10-13 曾接受一個取捨——「留下的人刪帳號，整本連共同章節一起刪，離開的人之後無法再回看」，理由是實作單純（solo 分支直接 cascade）。2026-10-15 擁有者推翻：自願離開之後，共同章節是離開的人「過去的時光」與匯出的來源，只因對方刪帳號就消失，等於把一段兩人共有的歷史單方面抹掉，與「陪伴／過去章節 read-only」的立場衝突，也和上面「配對情境」保留共享歷史的理由同源。下一個重新推導這件事的人，很可能會再得出「solo 就全刪最單純」這個結論——它在實作上單純，但失效的樣子是：沒有任何錯誤；離開的人打開「過去的時光」，那段章節不見了。引用過舊規則的地方（隱私權政策、服務條款、刪除確認對話框、本檔決策 #7、`leaveGroup` 與 `account-deletion` 相關 spec）已一併掃過更新。

- *整個 group 一起刪* — 對另一半最傷，全部資料消失。

### 為什麼用既有 privacy 頁當 Google 的 web 刪除 URL

Google 另要求一個免登入、可達的 web 頁描述刪除途徑。現有 `/[locale]/privacy`（landing footer 連出、公開）已含刪除說明，直接拿來填 Play Console 的 deletion URL 欄位即可，**不另開頁**（YAGNI）。唯一前提：把「設定頁刪除帳號」做出來後，該段文案就從承諾變成真的。

## 設計決策（locked）

1. **請求標記**：`Profiles.deletion_requested_at`（nullable timestamptz）。`NULL` = 無待刪除；有值 = 自該時刻排程刪除。取消 = 設回 `NULL`。一 user 最多一筆待刪除，天然 idempotent，不開新表。
2. **發起 / 取消**：兩個 server action（`requestAccountDeletion` / `cancelAccountDeletion`），solo 與配對通用，無前置條件。發起後登出。
3. **設定頁入口**：`LogoutButton` 區附近一個「刪除帳號」入口 + ConfirmModal（說明 14 個工作天內移除、期限內可取消）。
4. **Grace banner**：dashboard 偵測到 viewer 有 `deletion_requested_at` → 常駐、**非阻斷式** banner，顯示移除日期 + 取消鈕。符合「燈 / 陪伴、不挾持」調性，可照常使用到被處理為止。
5. **處理期限**：後台處理 `deletion_requested_at < now() − 14 日曆天`。14 日曆天 ≤「14 工作天」承諾上界，所以一定不跳票；同時即為取消窗口。
6. **後台執行**：Edge Function + pg_cron 每日跑，比照既有 cron（定期收支 / 月度回顧 / soft-delete 物理刪除）。**兩個 Supabase project（prod + dev）都要部署**。也可手動觸發。
7. **Solo group 處理（#1701）**：D 的 solo 帳本是否整本刪除，取決於有沒有「活著、已離開、且還能回看該章節」的前成員 X（`auth.users` 有列即算活著，待刪除中也算）。
   - 沒有 → 整個 group 連同所有子資料 hard delete → 刪 `Profiles` → 刪 `auth.users`（同今日行為）。
   - 有 → 關閉 D 的 open epoch，**帳本轉為孤兒帳本、只保留 X 看得到的部分**；D 的 `auth.users` 照刪，D 的名字槽改為「已離開的夥伴」。
   - **按章節修剪**：多位離開者（P1、P2）共用同一本孤兒帳本時，每位的刪除只讓「再沒有任何活著的人能看」的章節消失；某章節只要還有一位活著的前成員是其成員就保留，全部沒了才整本刪。核心是 `public._prune_ledger(group, deleter)`（idempotent，內部重驗前提並鎖列），所有路徑共用。
   - **保留章節裡仍會刪的東西**（離開者回看用不到、現任成員不存在就沒人讀得到）：愛物的明細（車／房／孩子／寵物／植物／保險）、加密欄位（`*_encrypted`）、愛物備註與範本欄位、發票匯入與 CSV 匯入檔、幣別匯率、出遊分享連結（朋友已認領的名額不變）、邀請連結、夥伴問答、推播裝置、未處理的定期卡片；保留的定期規則暫停；章節外的交易／愛物／旅行／出遊刪除；帳本名改為「家計簿」、餘額歸零。
   - **孤兒帳本是「每個 group 只有一個 open epoch」的允許例外**（F13）：孤兒沒有任何現任成員，因此沒有 open epoch，只有已關閉章節。依賴「一個 group 恆有一個 open epoch」的程式（含新寫的 cron、查詢）要先判斷是不是孤兒。
   - **兜底掃描**：`public.sweep_orphan_ledgers()` 對每個孤兒帳本逐一跑 `_prune_ledger`（各自 sub-block，一本失敗不影響其他）。`process_account_deletions()` 結尾會呼叫，並另設獨立 pg_cron job `sweep-orphan-ledgers`（每日 15:00 UTC，避開 16:00–17:30 的其他 job），即使處理器本體被 rollback 孤兒也會收斂。
   - 失效的樣子（三種，都沒有錯誤畫面）：
     - 規則寫得太緊或護欄退化：沒有任何錯誤；離開的人打開「過去的時光」，那段章節不見了。
     - 掃描沒在跑：沒有任何錯誤；沒人看得到的帳本一直留在資料庫。偵測：維運不變式「沒有活著前成員的孤兒 = 0」。
     - `_prune_ledger` 在 solo 分支 raise：D 的整個區塊 rollback（刻意不 fallback 成 cascade，否則會毀掉 X 的章節）——沒有任何錯誤畫面；D 的帳號過了 14 天還在，每天一筆 `process_account_deletions: failed for` WARNING（#1377 的症狀）。偵測：維運不變式「待刪除請求超過 15 天 = 0」（[ops-runbook](../ops-runbook.md)「真正還原」第 8 步）。
8. **配對 group 處理（匿名化）**：
   - 刪除者的交易 / 愛物留在 group。
   - group 轉 solo 給另一半：刪除者是 member_a → 另一半從 B 升 A，並比照 `confirmSwap` 翻轉 `split_ratio_a` / `default_split_ratio_a` 並 recalc balance；刪除者是 member_b → 直接 `member_b = NULL`。
   - 關閉雙人 epoch、開另一半的 solo epoch、bump `current_epoch_started_at`（比照 `leaveGroup`）。
   - 刪 `auth.users`（移除登入 / email / provider 這些真正 PII），但**保留一個洗白的 `Profiles` 墓碑列**（displayName→「已離開的夥伴」、avatar→NULL），讓 `paid_by` / `recipient_id` 等 FK 仍解析得到。
   - 已關閉的章節各自保存了兩人在關閉當時的名字（#1604，migration 0088）。刪除時，刪除者在**所有**帳本、所有章節裡的這個名字一律換成「已離開的夥伴」，包括很久以前離開的帳本，以及寬限期內被對方關掉的章節。墓碑列本身不夠：章節不再讀 `Profiles` 的名字。
     - 失效的樣子：沒有任何錯誤；對方打開舊章節，看到的仍是刪除者的真名。
     - 同一個字樣也會由 #1619 寫入（離開的人自己選擇，帳號仍在），所以章節裡的「已離開的夥伴」不代表該帳號已刪除。
   - 月回顧快照的「最大筆支出」不存名字，只存付款人 id（#1618，migration 0089）；頁面以該章節兩人的章節名字解析，所以刪除後同樣顯示「已離開的夥伴」，刪除流程不需要額外步驟。0089 把既有快照裡的名字全部清成 NULL；從 0089 之前的備份還原時要重跑這一步（[ops-runbook](../ops-runbook.md)「真正還原」第 7 步）。
     - 失效的樣子：沒有任何錯誤；對方打開刪除者付過最大一筆的那個月，看到的仍是真名。
   - 帳本名不取自任何人的名字（#1622，migration 0090）：`leaveGroup` 為離開者新建的帳本改用中性預設名（`postLeave.newLedgerName`，zh-TW「家計簿」），不再是「{displayName} 的家計簿」；0090 把既有這類帳本一次改名為「家計簿」。刪除流程不需要額外步驟，`process_account_deletions` 不動帳本名。
     - 失效的樣子：沒有任何錯誤；對方（或之後的伴侶）在設定看到的帳本名仍帶著刪除者的真名。
   - 不涵蓋（殘留，不改寫）：
     - 使用者自己打的文字：帳本名、交易描述與備註、出遊／旅行／愛物名稱等，裡面可能寫了某個人的名字。這是使用者內容，刪除帳號時不會改寫。
     - 加密的每日備份（#1549）在保存期限到之前仍留著舊的帳本名。從 0090 之前的備份還原時要重跑 0090（[ops-runbook](../ops-runbook.md)「真正還原」第 7 步）。
   - 未結 balance 在刪除時視為勾消（因不檔 settlement）；recalc 後 solo = 0。
9. **Web 刪除 URL**：沿用 `/[locale]/privacy`，Play Console deletion URL 指向它；確保其刪除段落與實際 flow 一致（可選加 anchor 利於審核員尋找）。

## 需要先驗證的實作前提

- **`Profiles.id → auth.users(id)` 的 FK 行為**：若是 `ON DELETE CASCADE`，刪 `auth.users` 會連帶刪掉墓碑 `Profiles` 列，匿名化方案失效。實作前先查 `lib/db/schema.ts` + 對應 migration；若是 cascade，需把該 FK 改為 `SET NULL` / `RESTRICT` 或調整關聯，讓墓碑列能在 auth user 刪除後存活。
- **雙方同時待刪除**：兩人都按了刪除 → 各自到期後依序處理。先處理的一方使 group 變另一半 solo（含墓碑）；後處理另一半時 group 已是 solo → 走 solo 全刪路徑。最終整個 group 清空，收斂正確。

## Acceptance Criteria

- 設定頁有「刪除帳號」入口；按下 → ConfirmModal → 確認後登出，帳號進入待刪除狀態。
- 待刪除期間重新登入 → 看到可取消的 banner（含移除日期）；取消後帳號完全恢復如常。
- 後台處理到期的 solo 帳號 → 該 user 的 group、所有子資料、`Profiles`、`auth.users` 全數消失；無孤兒列。
- 後台處理到期的配對帳號 → 另一半登入後：自己的 group 仍在且轉為 solo、**自己與共享的交易 / 愛物歷史完整**、刪除者顯示為「已離開的夥伴」、balance 為 0；刪除者已無法登入、其 email / provider 身分 / 顯示名 / 頭像不復存在。
- 留下的人（D）在單人狀態刪除帳號、且有活著的前成員 X → X 的「過去的時光」仍可回看該章節（交易、旅行、出遊、月回顧、愛物名稱與該章節金額、匯出），D 的名字顯示為「已離開的夥伴」；D 的明細、加密欄位、備註、匯入檔、匯率、分享連結已刪。
- 隱私政策頁可免登入到達，含與實際 flow 一致的刪除說明，足以作為 Play Console deletion URL。
- 新增文案 4 語同步（zh-TW 主稿）。

## 驗收場景

1. Solo 使用者刪除 → 14 天後資料全清，無法登入。
2. 待刪除期間取消 → 恢復如常，後台不再處理。
3. member_b 刪除 → member_a 的 group 轉 solo、歷史完整、對方成「已離開的夥伴」。
4. member_a 刪除 → member_b 升為 A、split / balance 正確翻轉、歷史完整。
5. 雙方都刪除 → 先後處理後整個 group 清空。
6. 待刪除使用者仍可照常使用 app 直到被處理（banner 常駐、非阻斷）。
7. （#1701）D 離開後單人，X 還活著，D 刪除 → X 看得到該章節，D 離開後記下的紀錄與章節外的愛物已刪；孤兒帳本無 open epoch。
8. X 先前已刪除帳號，之後 D 刪除 → 同今日，整本 cascade。
9. 上述 7 之後 X 也刪除 → 孤兒帳本整本刪除，墓碑 Profiles 在無引用時一併移除。
10. 雙方都在待刪除，不論處理順序 → 最終整本清空。
11. 兩位離開者 P1、P2 都還活著，D 刪除；P1 再刪除 → P1 的章節消失、P2 的不變；P2 也刪除 → 整本刪除（兩種順序皆然）。
12. 保留章節內：被保留交易標記的旅行、被保留交易引用的 CSV 匯入、解析後的定期卡片等外鍵關聯，刪除全程無 WARNING、保留列完整。
13. 在 `_prune_ledger` 注入失敗 → X 的刪除仍完成，修復後下一次掃描收斂。
14. 重跑（idempotent）不改變任何資料；rollback 0096 後 `sweep-orphan-ledgers` job 仍在。

## 概念連結

- 身分 / auth：[native-auth](native-auth-design.md)（`Profiles` mirror `auth.users`、刪 auth user 的服務端權限）。
- 既有的「一方離開、epoch 換章」語意：`actions/membership.ts#leaveGroup`（自 #1611 起只搬會動的東西——名下的愛物、定期規則與未處理的卡片、發票載具、推播裝置；紀錄留在原帳本）與 `#confirmSwap`（A/B 翻轉 + balance recalc）——本 feature 的匿名化處理借用其 epoch / ratio / balance 規則，同樣**不搬移**紀錄。
- 上架脈絡：[app-store-submission-runbook](../../app-store-submission-runbook.md)（本 feature 是 iOS + Android 送審的 blocker B1）。
