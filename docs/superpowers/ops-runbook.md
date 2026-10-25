# Ops Runbook

> 營運層知識：migration 怎麼跑、cron 怎麼授權、外部服務設定的雷點。
> 這些事實原本散在單機的 agent memory，沉澱到 repo 讓所有 session（cloud／worktree／換機器）都拿得到。
> Schema 與程式的 WHAT 看程式碼；這裡只留 WHY 與操作程序。

---

## Drizzle Migrations

### 慣例：手寫 SQL + 手動 journal，0008+ 不產 snapshot

本 repo 的 migration 是**手寫 SQL 檔 + 手動 `_journal.json` entry**。snapshot 檔（`drizzle/meta/NNNN_snapshot.json`）自 `0007` 之後不再產生、不再維護。

**Why**：多數 schema 變更帶著 `drizzle-kit generate` 產不出來的自訂 SQL（RLS policies、realtime publication、pg_cron job、extensions），直接手寫比繞過 codegen 乾淨。

**新增 migration 步驟**：

1. 寫 `drizzle/NNNN_<name>.sql`，**必須 idempotent**（`CREATE TABLE IF NOT EXISTS`、先 `DROP POLICY IF EXISTS` 再 `CREATE POLICY`⋯⋯）
2. 在 `drizzle/meta/_journal.json` 的 `entries` 追加：`{ "idx": NNN, "version": "7", "when": <前一筆 when + 100000000>, "tag": "NNNN_<name>", "breakpoints": true }`
3. 不要建 snapshot 檔
4. 先對 dev 跑 `npm run db:migrate` 測試

**雷（#874）**：只寫 SQL 檔忘了 journal entry，`db:migrate` 會**默默跳過**該檔還回報成功。修復模式見 `git show 373efe5` / `bb1bc09`。

### Dev：跑完必須驗證資料效果

共用的 dev Supabase project（`oikos-dev`）的 `drizzle.__drizzle_migrations` 歷史已被污染——本機 worktree branch 各自對同一個 dev project 跑 migration，導致記錄筆數多於 journal。`drizzle-kit migrate` 以「journal 的 `when` vs 已記錄的最大 `created_at`」決定要跑什麼，所以新 migration 可能被**記錄為已套用、SQL 本體卻默默沒執行**——回報 "migrations applied successfully" 不可信。

**Implication**：dev 跑完 `db:migrate` 一律直接查資料驗證效果（Supabase MCP query）。被跳過時，手動經 MCP 執行 migration 本體（migration 都是 idempotent 的，重跑安全）。

### Prod：npm script 到不了，要手動指 env file

`npm run db:migrate` 寫死 `--env-file=.env.local`，指向 **dev**。要 migrate **prod**（`oikos`）：

```
node --env-file=.env.production node_modules/.bin/drizzle-kit migrate
```

`.env.production` 是**本機檔案**（被 `.gitignore` 的 `.env*` 擋住，不進版控），內含 prod DB 連線字串；新機器要從密碼管理器重建。

Caveats：

- `drizzle-kit migrate` 套用**所有** pending migrations，不是單一檔。跑 prod 前先確認 pending 清單。
- 直接讀 prod DB 需要使用者明確授權 prod 為目標（「跑 prod」算數）；migration 後的驗證查詢也要同一份授權。
- Prod 不被本機 worktree 碰，migration 正常照 journal 順序執行；但**歷史不是乾淨的**（見下）——仍然要驗證資料效果，不要只信成功訊息。

**修正（#1405）**：上一版這裡寫「歷史乾淨」，不成立。`0065`（`when` 為 `1782300000000`，加 `Profiles.avatar_hidden`）在 prod 上是欄位已經手動／繞過工具存在、但 `drizzle.__drizzle_migrations` 沒有對應紀錄；紀錄是在 v1.6.0 migrate（2026-09-22）時才補上——見 #1354 crew log「0065 補上紀錄（欄位本來就在，跳過），0066 建好出遊的 5 張表」，唯讀驗證從 pre-flight 的 65 筆變成 67 筆（`0065` 本體是 `ADD COLUMN IF NOT EXISTS`，重跑是 no-op，事後補紀錄無害）。之後 v1.6.1 的 `0067` 再讓筆數變成 68，那是另一批、不是這次修正的一部分。

**每次跑 prod migrate 前，先讀資料比對，不要只看 journal 檔案**：

```sql
select hash, created_at from drizzle.__drizzle_migrations order by created_at;
```

照 drizzle 實際判斷邏輯算出「這次會被套用的清單」——journal 裡 `when` 大於 DB 已記錄最大 `created_at` 的那些 entries——而不是單純比對總筆數。算出來的清單如果不完全等於這次 release 預期要跑的那幾個 migration，就先停，不要照跑。

**已知的基準差異，不算異常**：journal 目前有 67 筆 entries、`idx` 跳過 `51`（`drizzle/0051_cash_settlement_indexes.sql` 檔案本身存在，只是 idx 編號本來就不連續）；#1374 也記錄過早期幾筆 `created_at` 和目前 journal 的 `when` 不一致，是早期重新編號留下的痕跡。這些是健康 prod 也會出現的既有落差，只要它們都落在目前的 watermark 之下（不會被誤判成待跑），不必為此停下——**規則要抓的是「待套用清單」對不對，不是「文件和資料庫長得一不一樣」**，不然久了會學會忽略這個檢查。

**失效的樣子有兩種**：

1. 缺紀錄的那一筆在目前 watermark **之上**：待跑清單比預期多一筆，`drizzle-kit migrate` 不會為此報錯——它只看 journal 的 `when` 是否大於 DB 已記錄的最大 `created_at`，缺紀錄的那筆會被當成「還沒跑過」重新套用一次（`node_modules/drizzle-orm/pg-core/dialect.js:56-62`）。這就是 0065 的情況：因為是 `IF NOT EXISTS` 所以無害；換成一個不能重跑的 migration，就會在 prod 上直接失敗。
2. 缺紀錄的那一筆在目前 watermark **之下**：不會被重新套用，永遠被跳過，而且不會有任何錯誤或警告——這是 #1374 在 dev 上發現的 0060（epoch backfill）情況，該筆從未在 dev 上跑過，watermark 已經越過它，之後也不會自動補跑。症狀是「這個 migration 明明存在，效果卻永遠沒發生」，只有直接查資料才會發現。

兩個 Supabase 環境對照見 [CLAUDE.md §環境](../../CLAUDE.md)。

**0065 是怎麼在工具之外套用的**：PR #1332（`feat/1328-hide-avatar`）內文寫「dev 與 prod 都已套用（使用者 2026-09-20 明示同意兩邊一起跑）」，早於該 PR merge、也早於它自己的 journal entry 走一般流程被記錄；確切是手動 SQL 還是透過 Supabase MCP `apply_migration` 執行，repo 內找不到直接證據，沒有查清楚。

### `handle_new_user` 的手動套用（不在 migrations 裡）

`db/triggers/handle_new_user.sql`（註冊時建 `Profiles` 列的 trigger）不在 `drizzle/` 裡，`db:migrate` 不會套它。檔案改過就要在**兩個** Supabase project 各手動套一次，以 admin 身分（`DATABASE_URL_DIRECT`）：

```
psql "$DATABASE_URL_DIRECT" -1 -v ON_ERROR_STOP=1 -f db/triggers/handle_new_user.sql
```

- 先 dev，驗證後再 prod；prod 要使用者 OK。
- 套完核對（必須是 `{search_path=public, pg_temp}`、`t`、`f`、`f`）：
  `SELECT proconfig, prosecdef, has_function_privilege('anon', oid, 'EXECUTE'), has_function_privilege('authenticated', oid, 'EXECUTE') FROM pg_proc WHERE oid = 'public.handle_new_user()'::regprocedure;`
- 檔案裡的 `SET search_path` 與 REVOKE / GRANT 不能拿掉：`CREATE OR REPLACE` 會重設函式的 SET 子句，少了它，每次手動套用都會悄悄撤銷 0022 的加固。
- #1782（v1.8.0）：provider 給的 `full_name` 正規化後等於四語的「已離開的夥伴」標籤時，改用 email 當名字（跟沒有 `full_name` 時同一套 fallback）。
- 漏套的樣子：沒有任何錯誤；沒套的那個 project 上，provider 名字就是系統標籤的人會以那個名字註冊（看起來像系統標記，只差樣式）。

---

## 欄位級加密：本機沒有 prod 金鑰、金鑰輪替 runbook（#881 / #882 / #1287）

**陷阱**：本機與 Futari Secrets dmg 裡**每一份標成 prod 的 env 檔**（`.env.production`、dmg 的 `env/.env.production`、`reencrypt-prod.env`）裡的 `ENCRYPTION_KEY` 都是 **dev 的金鑰**。那些檔案裡的 prod DB 連線字串是對的，只有金鑰不對。prod 的 k1 從來只存在 Vercel 的 Sensitive 變數裡（`vercel env pull` 拿回來的是 `[SENSITIVE]`），本機從沒拿到過，2026-10-05 已經移除（見下方「現況」）。現役的 k2 有備份，唯一能用的本機副本是 secrets image 裡的 `prod-k2*` 檔，見下方「只含 k_new 的 env 檔」。

**失效的樣子**：拿這些檔案對 prod 跑 `scripts/reencrypt-pii.ts --target=prod`，所有 guard 都會通過（DB URL 確實是 prod），然後 **preflight 在每一列都失敗——包括 app 自己寫進去的列**——什麼都沒寫入（2026-09-27 dry-run：preflight 22/22 失敗）。這不是資料壞了，是金鑰拿錯了。#881 是同一個錯誤往寫入方向走的版本：backfill 用 dev 金鑰加密了 prod 資料，prod runtime 解不開。

**怎麼做**：需要 prod 金鑰的工作要在**持有 prod 金鑰的 runtime 裡**跑——Vercel **preview** deployment 連的是 prod DB、帶的是 prod keyring。

- 做法是一條一次性、token 保護的 admin route，放在**永遠不 merge** 的丟棄 branch 上，推上去讓 Vercel 建 preview，跑完刪 branch、刪該 branch 的所有 deployment、刪 token 變數。#882（修 #881）與 #1287（k2 輪替）都是這個模式。
- route 只呼叫 `lib/reencryptCore.ts`（腳本用的同一份 preflight／compare-and-swap 與 SQL），不自帶第二份演算法——#881 的根因就是第二份 cipher 實作。
- 動手寫入前，route 先證明 runtime 手上真的是 prod 金鑰：解開一筆由 production 寫入、指定好的 anchor 列（#882 的 pre-flight 檢查、#1287 的 anchor gate）。解不開就零寫入。
- 閘門依序全部在碰 DB／crypto 之前：`VERCEL_ENV === 'preview'` → `VERCEL_GIT_COMMIT_REF` 等於丟棄 branch → 寫死的到期時間 → token（SHA-256 後 `timingSafeEqual`）；Deployment Protection 保持開啟。回應與 log 只有計數。
- 動手寫之前，route 還要求帶一個「錨點」：一個由 production 寫入、指定好 table／column／pk 的既有列，且已經是目標 kid 的格式。錨點解不開、格式不符、或指到不允許的欄位，就零寫入——route 不自行判定「這是不是 production 寫的」，那個保證來自操作者（在 prod 網域上手動建立這筆錨點）加上「先清空舊部署再開 route」這兩件事疊起來。
- 這條 route 只活在丟棄 branch 上，**永遠不 merge 進 main**；跑完連 branch、該 branch 的所有部署、token 環境變數一起刪掉，一個都不留。失效的樣子不是報錯，是這條有 admin 權限、只靠一個 token 擋著的 route 一直活在某個 preview URL 上，被忘記的機率遠高於被發現。

**操作時會踩到的雷（generic，來自 2026-09-27 那次實際執行）：**

- Preview 環境變數如果綁定特定 branch（`--git-branch`），那個 branch 要先存在於遠端才能加變數，否則會回「branch not found」。順序要是：先 push branch → 再加變數 → 再重新部署一次那個 preview；漏了最後一步，該 preview 建置當下還沒有 token，route 只會回 404（看起來像「還沒生效」，其實是建置時序錯了，不是變數沒生效）。
- Deployment Protection 自己擋下的回應也是 401，格式是 Vercel 自己的 JSON（`{"error":{"code":"401","message":"Protected deployment"}, ...}`），容易和 route 自己的 token 檢查搞混——那一層是 Vercel 在 route 程式碼跑之前就擋掉的，跟 token 對不對無關，看到這個訊息就先確認 Deployment Protection bypass 有沒有帶對，再去查 token。
- Vercel 的 automation bypass（用來讓一次性 curl 繞過 Deployment Protection 的那個值）要透過 Vercel 的 API 直接寫進本機的 header 檔，不要從後台網頁複製再貼——貼上這種高熵字串很容易在畫面上漏選、多選或多按一次，拿到錯誤長度或空字串卻不會有任何提示。
- 驗證那份 header 檔時只看**長度與字元類型**（例如逐行印出「欄位名稱＋值的長度」），不要把值本身印出來確認——確認的目的達到了，也沒有把機密留在終端機 scrollback 裡。

- 完整的 #1287 操作步驟（產生 k2 進 dmg、Vercel 變數順序、rollback floor、teardown）見 issue #1287。

### 金鑰輪替（k_old → k_new）：規劃內，8 步

跟上面「一次性重新加密」是同一個底層動作，多了金鑰本身要換這一層。以下步驟順序是硬性的——尤其步驟 4 一定要在步驟 5 之前完成，否則會漏寫。

1. **產生 k_new，直接寫進已掛載的 secrets image**，不印在終端機、不放進任何指令列參數。失效的樣子：只要 key 出現在指令列或被 echo／printf 到畫面上，它就進了 shell history 與終端機 scrollback，之後任何翻歷史紀錄的動作都能撈到它——跟外洩沒有本質差別。
2. **把 k_new 加進每一個會解密該 DB 的環境的 `ENCRYPTION_KEYS`**（prod：Vercel Production **與** Preview，都標 Sensitive；dev：`.env.local`），redeploy／restart 後確認「顯示」（reveal）還正常。失效的樣子：漏掉某個環境（最常見是 Preview，或某台還在跑 `npm run dev` 但沒同步 `.env.local` 的機器）——那個環境當下看起來完全正常，直到它需要解一筆已經用 k_new 寫入的資料時才失敗，而失敗時間點跟漏改的時間點可能隔了很久，難以追溯。
3. **把 `ENCRYPTION_WRITE_KID` 指到 k_new**，同樣每個環境都要改，redeploy／restart。**從這個部署開始記錄 rollback floor**——回退／promote 都不能低於這個部署。失效的樣子：只改了 Production 沒改 Preview，之後任何在 Preview 上跑的一次性動作（包含本節的 runtime route）仍在用舊 write kid 寫入，跟步驟 4 的漏網部署是同一種錯。
4. **在重新加密之前，先刪除或停用「步驟 3 之前建立的每一個部署」**（Production 與 Preview 都要）。失效的樣子：漏刪的舊部署還能接到流量、還在用 k_old 寫入；重新加密跑完之後，這些新寫入又變成一批漏網的 k_old 資料——不會報錯，只會在下一次計數時對不起來，得再跑一次才會補齊，而且沒人會直覺知道要再跑一次。
5. **依環境跑重新加密（見下方「按環境跑」）**，只有在步驟 4 確認做完之後才開始。
6. **只看計數（count-only）**，確認每一欄都是 `v1:k_new:`，沒有殘留的舊格式或 legacy。跑一次在重新加密結束後、跑一次在下一步之前再驗一次。失效的樣子：計數裡混著 `v1:k_old:` 或 legacy 格式，代表某個環境沒切乾淨、或步驟 4 漏刪了部署，這時不要往下一步走。
7. **只有在步驟 6 的計數確認過、且 #1466（密文出現在 client payload）已經解決之後，才把 k_old 從環境變數移除**。失效的樣子：漏跑、漏刪部署造成的舊列還沒被步驟 5 覆蓋到就先移除 k_old，那些列從此解不開，但這時還沒到不可逆——把 k_old 從 secrets image 加回 `ENCRYPTION_KEYS` 就能救回來（見下方「回退」）；#1466 沒解決前，RSC payload 與瀏覽器快取裡可能還留著 k_old 的密文副本，輪替碰不到它們；拿到舊 key 的人仍解得開。這個失效沒有任何畫面或錯誤，只能靠 #1466 的 grep 驗收確認（見下方緊急輪替）。真正不可逆的是**步驟 8 把 k_old 銷毀之後**——一旦銷毀，就沒有辦法把 k_old 加回來了。
8. **k_old 移除後仍要留在 secrets image 裡離線保存**，直到「每日備份保留期、PITR window、任何操作者手動 `pg_dump`」這三者裡最晚的那個都過了才銷毀。失效的樣子：從備份或 PITR 還原出來的資料是舊快照，裡面的密文仍是 k_old 格式；如果 k_old 已經銷毀，還原出來的那份資料就永久解不開，備份形同白做。
   - **每日備份保留期（#1549）＝約 60 天**：Drive 上 30 份，加上被清掉之後在 Drive 垃圾桶的 30 天（見〈Prod backup (futari_backup)〉）。哪一份備份依賴哪些 kid，看該份 manifest 的 `## encrypted_kids`——k_old 要等到**最後一份含 `v1:k_old:` 的備份**被清出垃圾桶之後才能銷毀。
   - PITR：prod 是 Free plan，沒有。

**回退**：步驟 7 之前，把 write kid 指回 k_old（rollback floor 隨之調整回去）、重跑重新加密即可；步驟 7 之後，從 secrets image 把 k_old 加回 `ENCRYPTION_KEYS`（k_old 的位元組本身永遠沒被丟棄，只是先不在環境變數裡）。**例外：prod 的 k1 從沒匯出過 Vercel，secrets image 裡沒有它。** 對 k1 來說，從 Vercel 移除就等於銷毀（步驟 7 就是步驟 8），沒有加回來的路。所以 k1 一直留在 Vercel，等到備份、PITR、dump 三者的保留期條件都確認過、#1466 也完成，才在 2026-10-05 移除（見下方「現況」）。失效的樣子：提早移除 k1 之後，任何從保留期內備份還原的舊資料都永久解不開，而且不會有任何錯誤提醒你，直到真的要還原那天才發現。

  dmg 裡標成 prod 的 `ENCRYPTION_KEY` 檔**不是** k1 的備份，那是 dev 金鑰（見本節開頭「陷阱」）。把它當 k1 加回 Vercel，解不開任何 k1 密文。2026-10-05 移除當晚就有一段說明誤寫成「dmg 裡留著 k1 的備份，可以加回來」，這說法不成立。

**按環境跑（步驟 5 的細節）：**

- **dev**：

  ```
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/reencrypt-pii.ts \
    --target=dev --env-file=<secrets image 上的 dev env 檔>
  ```

  先 dry-run，確認 preflight 全過、`toRewrite` 數字合理，再加 `--apply`。腳本要求一定要帶 `--env-file`（沒帶會直接被參數解析擋掉），且 dev env 檔本身就同時放 k_old 與 k_new——本機拿得到 dev 的完整 keyring，preflight／apply 都能直接跑。
- **prod**：preflight（`lib/reencryptCore.ts` 的 `reencrypt`）會先解開每一列，任何 kid 不在 keyring 裡就被 `lib/crypto.ts` 丟出 `Unknown key id`、preflight 整批中止，所以 prod 步驟 5 用的 keyring **必須同時含 k_old 與 k_new**。
  - **k1 → k2 那次（2026-09）**：prod 的 k1 只活在 Vercel 裡（見本節開頭「陷阱」），當時本機與 dmg 裡標成 prod 的 env 檔放的都是 dev 金鑰——拿它們對 prod 跑腳本，preflight 會對每一列都失敗，不是資料壞了，是金鑰拿錯了。本機湊不出含 k1 的 keyring，所以用了上面「prod 重新加密：runtime route」那個模式。
  - **從 k2 開始**：k2 已經備份在 secrets image，下一次輪替（k2 → k_new）可以直接在本機用一份同時含 k2 與 k_new 的 keyring 跑腳本做步驟 5。runtime route 留作 k_old 不在離線備份裡時的備案。
  **只含 k_new 的 env 檔，只能用在重新加密**之後**的備份校驗**：在 k_new 已經備份進 secrets image、且步驟 5 已經把所有列轉成 `v1:k_new:` 之後，用一份只放 prod DB 連線字串、`ENCRYPTION_KEYS`（只有 k_new）與 `ENCRYPTION_WRITE_KID=k_new`（不放 `ENCRYPTION_KEY`）的 env 檔跑 dry-run，預期結果是全部 `current`、`preflight_failed=0`——這證明的是「secrets image 裡備份的 k_new 真的能解開全部 prod 資料」，不是在做步驟 5 本身；如果這時 DB 裡還混著任何 k_old 或 legacy 列，這份只含 k_new 的 keyring 一樣會在那些列上 preflight 失敗，因為它本來就解不開 k_old。

### 緊急輪替

順序跟上面規劃內的 8 步**完全一樣**（尤其步驟 4 一定要在重新加密之前做完），另外多這些：

- **同時輪替每一個跟這把加密金鑰放在一起的其他機密**：DB 密碼（`DATABASE_URL`／`DATABASE_URL_DIRECT`，包含所有本機 env 檔）、Supabase service key、其他 Vercel 機密、Vercel 團隊成員與 token。失效的樣子：只換了加密金鑰，其他放在同一份 dmg／同一個密碼管理器條目附近的機密沒有跟著換——攻擊者仍握有等價的存取路徑，輪替沒有真正把人趕出去。
- **唯讀的 persistence audit**：`pg_roles`、`cron.job`、`pg_proc`（找 SECURITY DEFINER functions）、triggers、RLS policies、`auth.users`／`auth.identities`。目的是找有沒有被植入的存取路徑，這一步全程唯讀，不要邊查邊改。失效的樣子：邊查邊改（例如查到可疑的 trigger 就順手刪掉）會把「調查」跟「處置」混在一起，事後說不清楚攻擊者留下的東西哪些是自己動手清掉的、哪些原本就不存在，稽核與後續通報都會失去依據。
- **是否通知受影響的人是使用者要做的決定**，不是自動化流程能自己判斷的一步——資料涵蓋兒童的身分證字號等個資，通知義務的判斷留給人。失效的樣子：自動化流程自己決定「這次影響不大不用通知」或反過來自動發出通知，兩種都是拿走了本該由人承擔的判斷與責任。
- **洩漏當下已經存在的備份、資料庫 dump、瀏覽器快取裡的密文，都是用洩漏的那把金鑰加密的**——輪替救不回它們；這些副本永遠暴露，直到它們自然過期或被找出來個別處理。
- **從 Vercel 移除 k_old（步驟 7）要等 #1466（密文出現在 client payload）解決之後才能做**——在那之前，RSC payload 或瀏覽器快取裡可能還留著用 k_old 加密的密文副本，任何拿到那份洩漏金鑰的人都還解得開它們；rotation 本身碰不到瀏覽器端的這些副本，app 也從來不會去解密它們，所以移除 k_old 前，這批副本的暴露狀態不會因為 rotation 而改變。

### 規則

- **kid 永遠不重複使用；一個 kid 對應的位元組永遠不原地修改**，輪替一律是新增一個 kid，不是換掉舊 kid 的內容。失效的樣子：如果把某個 kid 對應的 key bytes 直接換掉，等於在原地竄改一個本應不可變的映射——所有還沒被重新加密、標著那個 kid 的舊密文瞬間全部解不開，而且沒有任何錯誤訊息會指出「key 被換掉了」這個原因，看到的只是一片解密失敗，很難聯想到根因。
- **dev、prod 用的金鑰各自獨立，不共用**。失效的樣子：共用一把金鑰不會產生任何錯誤——傷害在於 dev 的金鑰散落在更多機器與檔案裡，dev 那邊一洩漏，prod 的資料也跟著暴露。（反過來「拿錯環境的金鑰」才會讓 preflight／reveal 全部失敗，就是本節開頭的「陷阱」。）
- **金鑰永遠不出現在指令列參數，也永遠不印到終端機畫面**。失效的樣子：指令列參數會進 shell history 與進程列表（`ps`）；印到畫面會留在終端機 scrollback 與任何終端機 log 或螢幕錄影裡——兩者都是「當下看起來一切正常，直到有人事後翻歷史紀錄或錄影才發現」的洩漏路徑。

### rollback floor 現況（S2 → S3b）

S2 導入時的回退方式是「把 `ENCRYPTION_WRITE_KID` 拿掉、redeploy／restart，資料照樣以 legacy 格式寫入」——這個回退方式**只在 legacy 格式還沒退場之前**成立。legacy 退場（S3b：拿掉 legacy 的 encode／decode 分支）在另一個 PR 做，一旦它上線，rollback floor 就上升到「**第一個帶著 `ENCRYPTION_WRITE_KID` 設定值上線的部署**」。實際能安全回退的底線是下面兩者中**較晚**的那個：(a) 這個 phase-2 floor；(b) 最近一次輪替步驟 3 的部署（第一個用 k_new 寫入的部署）。失效的樣子：回退到 (b) 之前的部署，那個 build 的 keyring 裡沒有 k_new，所有 `v1:k_new:` 的資料按「顯示」都會失敗。S2 那種「拿掉 write kid 就能退回」的做法**不再適用**——`encrypt` 在沒有 write kid 時會直接 throw，不會退回成 legacy 寫入。之後任何回退都只能是「把 write kid 指到另一個仍在 keyring 裡的 kid」，不能指望退回沒有 kid 的狀態。

### dev 演練（尚未執行）

在對 prod 真正輪替之前，規劃是先在 dev 上完整跑一次上面 8 步，驗證 runbook 本身寫得對，而不是直接拿 prod 試錯。演練的結局跟一般 rotation 不一樣：**dev 這次的 k_new 會變成 dev 之後永久使用的金鑰**，不是跑完就丟——所以步驟 8 的「k_old 銷毀」在 dev 演練裡照樣走完，k_old 不會被刻意留著等 rollback 之外的理由。

- 8 步全部在 dev 上跑一次，每一個「使用者跑的環境／金鑰操作」與每一次 `--apply` 都需要使用者自己動手，不代跑。
- 驗收標準：跑完後 dev 的計數顯示每一欄都是 `v1:k_new:`（沒有 legacy、沒有 k_old 殘留），並且每一種欄位型別都至少「顯示」一筆驗證解密正常。
- k_new 演練完之後同時留在 secrets image（離線備份）與 `.env.local`（讓本機 `npm run dev` 能繼續寫入／解密）兩處。
- 這次演練跟前面「prod 重新加密：runtime route」不是同一件事——dev 本機本來就拿得到完整 dev keyring，不需要 runtime route，直接用「按環境跑」段落裡 dev 那條腳本指令即可。

### 現況（generic，不含金鑰值）

**prod 只剩新 kid（k2）**。寫入和儲存都用它，備份在 secrets image。舊 kid（k1）已在 **2026-10-05** 從 Vercel 的 Production 與 Preview 移除（#1287）。k1 沒有離線備份，所以這次移除就是銷毀，**沒有回退**：任何 `v1:k1:` 密文從此都解不開。移除後重新部署，prod 的加密欄位仍正常顯示。

**移除前確認過的條件**（2026-10-04 確認，2026-10-05 執行）：

- **PITR／Supabase 備份**：prod 是 Free plan，沒有 PITR，也沒有 Supabase 的自動備份。
- **手動 dump**：本機沒有 prod dump，使用者也確認其他裝置與雲端都沒有。
- **#1549 每日備份**：從輪替完成後才開始，當時 prod 加密欄位已全部是新 kid（22 筆，2026-10-04），不依賴 k1。
- **#1466**（密文出現在 client payload）：已關閉。

**還要做的驗收**：第一份 prod 備份（#1549 S3）的 manifest 跑出來後，看 `## encrypted_kids`，除了 `null`（該列這欄沒有值）只能有新 kid。若出現舊 kid 或 `other`，代表 prod 還有新 kid 解不開的列：停下來回報、查是哪一欄。資料不會因此復原，但要知道壞了哪些。

---

## Runtime DB role (futari_app)

> #1467。`drizzle/0072_futari_app_role.sql` 建立角色並授權；`scripts/ops/drop-futari-app-role.sql` 拆掉它。本節是 generic 的操作程序——不含任何連線字串、密碼、主機名稱。

**角色分工**

| 誰 | 連線 | 身分 |
|---|---|---|
| app runtime（Vercel、本機 `npm run dev`） | `DATABASE_URL`（pooler） | `futari_app`（逐環境切換完成之後；切換之前仍是 `postgres`） |
| migrations（`drizzle-kit migrate`） | `DATABASE_URL_DIRECT` | `postgres`，不變 |
| pg_cron jobs | DB 內部 | `postgres`，不變 |
| 需要管理權限的整合測試（seed `auth.users`、套 DDL、呼叫 SECURITY DEFINER function，例如 `__tests__/actions/accountDeletion0068.test.ts`） | `DATABASE_URL_DIRECT` | `postgres` |

### 為什麼是 BYPASSRLS

DB session 裡沒有 JWT claims——授權在 app 程式碼裡做（`requireViewerGroup`，見 [authorization-design.md](specs/authorization-design.md)），RLS policy 是給 client 端 anon key 用的。`futari_app` 不帶 BYPASSRLS 的話，policy 看不到任何 `auth.uid()`，每一條 Drizzle 查詢都會被 RLS 過濾掉。

- **失效的樣子**：不是權限錯誤，是**每個查詢都靜默回 0 筆**——dashboard 全空、記帳像沒存進去（INSERT 會被 `WITH CHECK` 擋成 42501，但讀取完全沒有錯誤）。看到「換了連線之後資料全不見」先查 `rolbypassrls`，不要去查資料。

### 擋得住／擋不住

- **擋得住**：建立角色（換掉密碼也還活著的後門）、DDL（`ALTER`／`DROP`／關 RLS／`TRUNCATE`）、改寫 `auth.*`、`cron` 排程加 `net.http_post` 把資料送出去、讀 `vault.decrypted_secrets`、讀 `storage.*`、在 `public` 建 function／table、建 schema。
- **擋不住**：**`DATABASE_URL` 外洩後，對方仍然讀得到、改得到 app 的每一筆資料**——BYPASSRLS 加上 public 全表的 SELECT／INSERT／UPDATE／DELETE，就是 app 本身能做的全部事情。另外 PUBLIC 預設的 `TEMPORARY` 讓它能建 temp table（session 結束就消失，碰不到其他 schema）。這個角色縮小的是「外洩之後能不能擴權、能不能留下來」，不是「外洩之後看不看得到資料」。
- **`postgres` 的密碼輪替之前，這份保護只涵蓋「目前這份 runtime env」外洩**：舊的 `postgres` 連線字串還在本機 env 檔與 secrets image 裡，拿到它的人仍有完整權限。輪替 `postgres` 密碼是另一個步驟（#1467 S4b），要等 Production 切換穩定之後。
- **規則：`futari_app` 的授權永遠只到 public 的 DML（加上 sequence 的 USAGE／SELECT）**。要多給任何東西（別的 schema、function EXECUTE、TRUNCATE）都要先過一次新的安全審查。測試撞到 42501 而那個測試本來就需要管理權限，修法是把測試換到 `DATABASE_URL_DIRECT`，不是加 grant。
  - **失效的樣子**：一次「順手補個 grant 讓測試過」不會有任何錯誤，只會讓這個角色慢慢長回 `postgres` 的樣子——控制點是 0072 之後每一個含 `futari_app` 的 migration 都要被當成安全變更審查。

### 連線方式：只有一種

所有 `postgres` 與 `futari_app` 的 psql session 都走 **service file + password file**，兩個檔都放在 secrets image 上：

```
PGSERVICEFILE="<secrets image>/pg_service.conf" PGPASSFILE="<secrets image>/.pgpass" \
  psql service=futari_dev_admin -f <file>.sql
```

- Service 名稱：`futari_dev_admin`、`futari_dev_app`、`futari_prod_admin`、`futari_prod_app`。
- `pg_service.conf` 只放 `host`／`port`／`user`／`dbname`（pooler 的 user 是 `futari_app.<project-ref>` 這種格式）；**密碼只在 `.pgpass`**（`host:port:dbname:user:<secret>` 一行一筆）。
- `.pgpass` 權限必須是 `600`。**失效的樣子**：權限太寬時 libpq 會印一行 `WARNING: password file … has group or world access` 然後**直接忽略這個檔**，接著改成在提示字元要你輸入密碼——看起來像「密碼錯了」，其實是檔案權限。
- 需要 psql 的每一步都由使用者自己跑；agent 只寫 SQL 檔、讀輸出（計數／名稱／OK-DENIED），**不經手任何密碼**，也不對 app 角色跑 psql。

### 禁止事項（`futari_app` 與 `postgres` 的密碼都適用）

- **不用直接帶密碼值的 libpq 環境變數**（只用 `PGPASSFILE` 指向檔案）；**不把連線字串或密碼放在指令列參數**（`psql "<url>"`、`-c` 帶密碼）。失效的樣子：兩者都會進 shell history 與進程列表（`ps`），當下什麼錯都沒有。
- **不把密碼寫進 SQL 文字**（包括自己打 `ALTER ROLE … WITH` 帶明文）。Supabase 對 `postgres` 開了 DDL statement logging，明文會原封不動進 Logs Explorer，任何能開 dashboard 的人都看得到、而且留存。失效的樣子：指令成功、角色能登入，一切正常——密碼只是安靜地躺在 log 裡。
- **不用 dashboard 的 SQL editor 做任何碰密碼的事**（它會留查詢歷史）。
- **密碼不進 repo（本 repo 是公開的）、不進任何 log、不進 agent transcript**。`tests/futari-app-role-guard.test.ts` 會掃本節與 `scripts/ops/drop-futari-app-role.sql`／`0072`，出現密碼形狀的字串就失敗；它擋不住 log 與 transcript，那兩個只能靠上面的做法。

### 啟用步驟（每個環境：先 dev，再 prod；全部由使用者執行）

1. **跑 migration**（dev：`npm run db:migrate`；prod：見上方〈Prod：npm script 到不了〉），然後照〈Dev：跑完必須驗證資料效果〉直接查資料確認 0072 真的跑了：`select rolname, rolcanlogin, rolbypassrls from pg_roles where rolname = 'futari_app'` 要有一列、`rolcanlogin = false`、`rolbypassrls = true`。
2. **確認 `SHOW password_encryption;` 是 `scram-sha-256`**（admin service）。不是就停。失效的樣子：若是 `md5`，下一步 psql 仍會在 client 端雜湊，但存進去的是 md5 驗證值——能登入、不報錯，只是比預期弱。
0. **工具**：需要 psql（macOS：`brew install libpq`，它是 keg-only，不會進 PATH——用 `/opt/homebrew/opt/libpq/bin/psql` 或自己加 PATH）。指令從文件複製時，留意貼進來的不換行空白（NBSP）。失效的樣子：zsh 回 `command not found: psql service=futari_dev_admin`——整串被當成一個指令名稱，因為中間的「空白」其實是 NBSP；手打一次就好。
3. **產生密碼並寫好 `.pgpass`**：`python3 scripts/ops/futari-app-pgpass.py "<secrets image>" <env>`（prod 要多帶 `--admin-env-file <存 prod DATABASE_URL_DIRECT 的檔>`，因為 `.env.local` 指向 dev）。它產生 64 hex 的新密碼寫進 `futari_<env>_app.pw`，並把 admin／app 兩行寫進 `.pgpass`，都是 `600`、不印出任何秘密；`futari_<env>_app.pw` 已存在就拒絕執行，避免重跑時產生第二組、跟伺服器上的對不起來。
4. **設定密碼**：`psql service=futari_<env>_admin` 裡執行 **`\password futari_app`**（一定要帶角色名稱），在提示字元貼上 `pbcopy < "<secrets image>/futari_<env>_app.pw"` 的內容，貼完 `pbcopy < /dev/null` 清掉剪貼簿。psql 在 client 端算好 SCRAM 驗證值才送出。
   - **失效的樣子（漏了角色名稱）**：`\password` 不帶參數改的是**目前登入的角色**，也就是 `postgres`。Supabase 會擋下來（`permission denied to alter role`），所以不會真的改到——但 `futari_app` 也就沒有密碼，下一步連線測試會得到 `EAUTHQUERY … unsupported or invalid secret format`（Supavisor 的說法是「這個角色沒有可用的密碼」，不是「密碼錯」）。重跑 `\password futari_app` 即可。
   - **剪貼簿是第二個外洩面**：沒清掉的剪貼簿會在下一次貼上時跟著出去——聊天框、issue、或替 agent 打字的瀏覽器工具（2026-10-01 dev 切換時，一段 terminal 輸出就是這樣被貼進了測試紀錄的描述；那段不含密碼，但下一次可能有）。
5. **開放登入**：`ALTER ROLE futari_app LOGIN;`
6. **確認 log 乾淨**：Logs Explorer（`postgres_logs`）搜 `PASSWORD`。Supabase 會把密碼語句記成 `ALTER USER "futari_app" …`，密碼值的位置顯示成 `{REDACTED}`——看到 `{REDACTED}` 或 `SCRAM-SHA-256$…` 都是乾淨的；同時確認被改的角色是 `"futari_app"`，不是 `"postgres"`（那就是步驟 4 漏了角色名稱）。
7. **連線測試一次**（circuit breaker，見下）：`psql service=futari_<env>_app -c 'select current_user'`，回 `futari_app` 才往下。
8. **寫進 env**：
   - dev：`python3 scripts/ops/futari-app-db-url.py "<secrets image>" dev` 從 service file + `.pgpass` 組出 transaction pooler（6543、`?pgbouncer=true`）的 URL，原地改寫 `.env.local` 的 `DATABASE_URL`（worktree 的 symlink 照樣有效），舊的那行備份到 `dev-DATABASE_URL.postgres.bak`（`600`）。退回：同一指令加 `--rollback`。之後重啟 `npm run dev`。
   - prod：`… prod --pbcopy` 把 URL 放進剪貼簿，貼到 Vercel 的 `DATABASE_URL`（標 **Sensitive**），然後**立刻** `pbcopy < /dev/null`。不寫進任何檔案。
     - **Vercel 不讓你改 Sensitive 變數的環境勾選**：原本 Production＋Preview 共用一個 Sensitive 的 `DATABASE_URL` 時，取消勾選 Preview 會被擋。做法是刪掉重建成兩個（Production 用舊值、Preview 用新值）。正在跑的部署不受影響，因為環境變數在部署建立時就固定了；但刪掉到重建 Production 之間不能有 Production 部署。Production 的值重貼之後，要等下一次 Production 部署才算驗收。
     - **驗收時要看 prod 資料庫，不是看 Vercel**：`pg_stat_activity` 要出現 `futari_app`／Supavisor 的連線。閒置連線會被回收，所以要先打一個請求，否則「沒有連線」什麼都說明不了。
   - **驗收**（dev 2026-10-01 的做法）：`pg_stat_activity` 裡 runtime 連線全是 `futari_app`；dashboard 有資料（BYPASSRLS 生效——沒生效的樣子是畫面空白、不報錯）；新增／編輯／刪除一筆紀錄＋月回顧留言成功；主要頁面 200；`postgres_logs` 從切換時間起沒有 permission denied。這條 log 查詢要先用切換前的時間窗確認抓得到已知錯誤，才能相信它回的「0 筆」。

### Circuit breaker：失敗一次就退回，不重試

Supabase 的 pooler 對同一來源的連續認證失敗會暫時封鎖該 IP（約 150 秒內 10 次失敗 → 封鎖約 120 秒）。

- 改任何 Vercel env 之前，先照步驟 7 從本機用**完全相同**的值連一次。
- Preview 驗證先只打**一個**請求；失敗就立刻把 env 改回去，不重試、不「再部署一次看看」。
- **失效的樣子**：錯的密碼進了 Vercel，每個 lambda 都在重試，幾秒內就把 Vercel 出口 IP 送進封鎖名單——之後連**正確**的連線也會連續兩分鐘失敗，看起來像是「改回去也沒用」，其實是還在封鎖期。

### 每次 migration 之後：覆蓋檢查

0072 的 `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` 讓之後 `postgres` 建的 table／sequence 自動授權給 `futari_app`。**只涵蓋 `postgres` 建的物件**——用別的角色建的（例如在 dashboard 以其他身分建表）不會被涵蓋。每次跑完 migration（dev 與 prod 都一樣），用 admin service 跑：

```sql
-- 必須 0 列：任何一列 = runtime 讀寫不了的 public table
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
  and not (has_table_privilege('futari_app', c.oid, 'SELECT')
       and has_table_privilege('futari_app', c.oid, 'INSERT')
       and has_table_privilege('futari_app', c.oid, 'UPDATE')
       and has_table_privilege('futari_app', c.oid, 'DELETE'));

-- 必須 2 列（objtype r 與 S）：default privileges 還在
select da.defaclobjtype
from pg_default_acl da join pg_namespace n on n.oid = da.defaclnamespace, aclexplode(da.defaclacl) a
where n.nspname = 'public' and pg_get_userbyid(da.defaclrole) = 'postgres'
  and a.grantee = (select oid from pg_roles where rolname = 'futari_app')
group by 1;
```

- **失效的樣子**：新表的 migration 部署後什麼事都沒有，直到 prod 第一次寫那張表時丟 `permission denied for table …`（42501）——在那之前沒有任何東西會失敗。有列就補 `GRANT SELECT, INSERT, UPDATE, DELETE ON "<table>" TO futari_app`（寫成新的 migration），不要改用別的角色。

### 錯誤監看

切換期間與之後，看 Supabase **Logs Explorer 的 `postgres_logs`**，篩 `user_name = 'futari_app'` 且 SQLSTATE `42501`；再加 Sentry（`lib/db/sanitizeError.ts` 清掉值但保留 `code`）。**不用 `pg_stat_statements`**——失敗的語句不會進它的統計，看起來會是「零錯誤」。

- **失效的樣子**：只看 `pg_stat_statements` 或只看 Vercel 回應碼，權限錯誤可能被 server action 轉成一般錯誤訊息，畫面上只是「儲存失敗」，不會有人聯想到 DB 角色。

### 逾時設定（安全網，不是調校）

0072 設了 `statement_timeout = 30s`、`idle_in_transaction_session_timeout = 60s`（只作用在 `futari_app`；migration 與 pg_cron 不受影響）。

- **失效的樣子**：合法的長查詢被砍會丟 57014 `canceling statement due to statement timeout`；交易開著不動超過 60 秒，連線會被終止（25P03）。看到這兩個 code 先確認是不是有 query 真的變慢了，不要直接把逾時調大。
- `futari_app` 可以對自己 `ALTER ROLE … SET` 改掉這兩個值——所以事故處理要 `RESET ALL` 再重設（見下）。

### 依請求清除單一保留章節（#1701，手動；先在 dev 跑過）

情境：離開的人 X 還活著、不想刪帳號，但要求把留在孤兒帳本裡、自己「過去的時光」那段共同章節清掉（走 privacy 頁的「寫信給我們」）。沒有 app 內入口，也沒有新函式；用 0096 的 `_prune_ledger` 本身，只是先讓 X 不再是那段章節的成員。**不可逆**（章節紀錄與 X 的回看都消失），所以：

- **誰的請求**：只受理 X 本人從註冊的 email 寄來的請求（比對 `auth.users.email`）；一句話確認是哪一段章節（日期範圍）。別人（包括曾經的伴侶）的請求不受理。
- **範圍限制**：只處理**孤兒帳本**裡、成員恰為「已刪除的留下者 D（該帳本的 `member_a`）＋X」的**一段**已關閉章節。章節還有別的活著的成員、或帳本仍有現任成員，停下來問擁有者；X 若要的其實是整個帳號刪除，請 X 走 app 內刪除（會走同一條 `_prune_ledger`）。
- 以 `postgres`（admin）執行；`_prune_ledger` 沒有給任何 app 角色 grant。

事前（唯讀，記下結果）：

```sql
-- :g = 帳本 id, :e = 章節 (GroupEpochs.id), :x = X 的 auth.users.id
SELECT g.id, g.member_a, g.member_b, (SELECT count(*) FROM auth.users u WHERE u.id = g.member_a) AS member_a_alive
  FROM "OikosGroups" g WHERE g.id = :'g';             -- member_b 為 NULL、member_a_alive = 0
SELECT id, started_at, ended_at, member_a_id, member_b_id FROM "GroupEpochs" WHERE id = :'e' AND group_id = :'g';
                                                       -- ended_at 不為 NULL，成員恰為 member_a 與 :x
SELECT count(*) FILTER (WHERE ended_at IS NOT NULL) AS closed_epochs FROM "GroupEpochs" WHERE group_id = :'g';
```

執行（單一 transaction；任何一個前置條件不成立就 ROLLBACK）：

```sql
BEGIN;
-- 讓 X 不再是這段章節的成員：章節只剩已刪除的 D（墓碑 Profiles 仍在），名字槽維持「已離開的夥伴」。
-- #1782：名字槽的標記一起設（標記才是讀取端的判斷依據；只寫字面值，英文、日文的讀者會看到繁中字樣）。
UPDATE "GroupEpochs" e
   SET member_a_id = g.member_a, member_b_id = NULL,
       member_a_name = '已離開的夥伴', member_a_name_is_left_label = true,
       member_b_name = NULL, member_b_name_is_left_label = false
  FROM "OikosGroups" g
 WHERE e.id = :'e' AND e.group_id = :'g' AND g.id = e.group_id
   AND g.member_b IS NULL AND e.ended_at IS NOT NULL
   AND ((e.member_a_id = g.member_a AND e.member_b_id = :'x')
     OR (e.member_b_id = g.member_a AND e.member_a_id = :'x'));
-- 必須剛好 1 列，否則 ROLLBACK。
SELECT public._prune_ledger(:'g');
-- 事後檢查（還在 transaction 內）：
SELECT count(*) FROM "GroupEpochs" e JOIN auth.users u ON u.id IN (e.member_a_id, e.member_b_id)
 WHERE e.id = :'e';                                   -- 0
-- 如果 X 是這個帳本最後一位活著的前成員，_prune_ledger 回傳 'purged'，整個帳本已刪；否則該章節的交易／旅行／出遊／月回顧等已隨之刪除（以章節日期範圍抽查 CashTransactions、Trips、Outings 筆數 = 0）。
COMMIT;
```

事後：X 的「過去的時光」不再列出該章節（請 X 確認）；跑上面三條不變式仍為 0；在擁有者的請求紀錄寫下日期與帳本 id（不寫內容）。**這段 SQL 會改 `GroupEpochs`，寫好之後先在 dev 用 0096 的測試夾具跑一遍**（`__tests__/actions/deletionKeepsChapter1701*.test.ts` 的情境）再用在 prod；跑 dev 時若 `GroupEpochs` 有 trigger 或 CHECK 擋下 UPDATE，不要繞過，回報擁有者重新設計。

### 事故處理：懷疑 `futari_app` 的密碼外洩

1. **換密碼**：admin service 裡 `\password futari_app`（照啟用步驟 3–4；步驟 3 的腳本看到舊的 `futari_<env>_app.pw` 會拒絕執行，先把它改名成 `.pw.old`，新密碼上線後再刪；dev 的 `.env.local` 要先 `futari-app-db-url.py … dev --rollback` 再重跑，因為它看到已經是 `futari_app` 會拒絕），更新 `.pgpass` 與各環境 env（Vercel 標 Sensitive），redeploy。需要立刻切斷時先 `ALTER ROLE futari_app NOLOGIN;`（會造成 app 停擺，直到新密碼上線再 `LOGIN`）。
2. **重設角色設定**：`ALTER ROLE futari_app RESET ALL;` 再重跑 0072 最後兩條 `ALTER ROLE futari_app SET …`。
3. **踢掉既有連線**：`select pg_terminate_backend(pid) from pg_stat_activity where usename = 'futari_app';`（`postgres` 在 Supabase 上是 `pg_signal_backend` 的成員）。換密碼不會中斷已經登入的 session，這一步不能省。
4. **唯讀確認沒有留下東西**：`futari_app` 擁有的物件必須是 0（`pg_class`／`pg_proc`／`pg_namespace`／`pg_type`／`pg_largeobject_metadata` 的 owner），`pg_auth_members` 裡它不屬於任何角色，再跑一次上方覆蓋檢查確認沒有多出來的授權。同〈緊急輪替〉：全程唯讀，查完再處置。
5. **對方可能已經自己改了密碼**：一般角色可以改自己的密碼，症狀是 app 突然全面 28P01（認證失敗）。處理方式一樣是步驟 1，admin 的 `\password` 會蓋過去。
6. **資料本身已暴露**：這個角色本來就讀得到全部 app 資料（見「擋不住」），是否需要通知使用者是使用者的決定，同〈緊急輪替〉。

### Rollback

1. 把 `DATABASE_URL` 改回原本的 `postgres` pooler URL（原值保留在 secrets image），redeploy／重啟 dev server。
2. 要不要連角色一起拆：確認**沒有任何環境還在用 `futari_app`**之後，admin service 跑 `scripts/ops/drop-futari-app-role.sql`。
   - **失效的樣子**：順序反過來（先拆角色再改 env），app 在拆的那一刻開始每個請求都連不上 DB，沒有漸進的徵兆。
3. 之後要重建：用 admin 身分重跑 `0072` 的內容（idempotent）——`db:migrate` 不會重跑已記錄的 migration——再從〈啟用步驟〉2 開始。

---

## Prod backup (futari_backup)

> #1549。prod 是 Supabase Free plan：**沒有自動備份、沒有 PITR**，在這之前從沒備份過。`drizzle/0081_futari_backup_role.sql` 建唯讀角色；`drizzle/0082_backup_auth_views.sql` 建 `backup_auth` 的兩個唯讀 view（auth 資料只從這裡讀）；`scripts/ops/backup-prod.sh` 每天備份；`scripts/ops/backup-restore-drill.sh` 演練還原；`scripts/ops/drop-futari-backup-role.sql` 拆角色。本節是 generic 的操作程序——不含連線字串、主機名稱、Drive 路徑、金鑰。

**流程一覽**

| 環節 | 在哪裡 | 說明 |
|---|---|---|
| 排程 | 使用者的 Mac（桌機、常開），launchd 每天 08:00（不排凌晨的原因見設定步驟 8） | `~/Library/LaunchAgents/local.futari.backup.plist` → `~/.local/libexec/futari-backup/futari-backup-run.sh`（先比對 SHA-256）→ `backup-prod.sh` |
| 連線 | session pooler、`sslmode=verify-full` | 身分 `futari_backup`；密碼在 macOS 鑰匙圈，執行時寫成暫存的 600 `PGPASSFILE`，結束即刪 |
| 一致性 | 一個 `REPEATABLE READ` 交易 `pg_export_snapshot()` 後一直開著 | `pg_dump --snapshot`、兩段 auth 的 `COPY`（第二個 session `SET TRANSACTION SNAPSHOT`）與 manifest 的計數都來自同一個快照；同時最多 2 條連線 |
| 加密 | `pg_dump \| age -r <公鑰>`、`COPY … TO STDOUT \| age -r <公鑰>` 串流 | 硬碟上從來沒有明文；公鑰在安裝時寫死進安裝的副本，不從設定檔讀 |
| 上傳 | rclone → Google Drive（`drive.file` scope） | 上傳後比對大小與 md5，寫 `LAST_OK`，再清舊備份 |
| 解密金鑰 | 「Futari Backup Key」dmg（密碼和 Futari Secrets **不同**）＋一份**異地的紙本** | 只有演練與還原時掛載 |

每份備份是 Drive 上的一個資料夾 `futari-prod-<UTC 時間>/`，**4 個檔**（manifest 的 `## dump` 寫 `bundle_format 2`）：

- `public.dump.age`：public＋drizzle 的 schema 與資料（`pg_dump -Fc`）。
- `auth-users.copy.age`、`auth-identities.copy.age`：`auth.users`、`auth.identities` 的資料，**只有資料**——`COPY (SELECT r FROM backup_auth.<表>) TO STDOUT` 的輸出，一行一個整列的 jsonb（`to_jsonb`，含 generated 欄位；還原時略過）。
- `manifest.txt.age`：計數、加密欄位各 kid 的筆數、realtime publication、`cron.job`、extensions、auth 上的 trigger、各表與欄位的 ACL、版本、`bundle_format`。

`bundle_format 1`（auth 是 pg_dump 檔 `auth.dump.age`）從來沒有真的產生過——0081 的 auth grant 在 Supabase 上被拒，備份在第一次跑之前就改成現在的格式；演練腳本只接受 2。

**保留**：最新 30 份；永遠不少於 7 份；未滿 30 天的不刪。清掉的進 Drive 垃圾桶（再留約 30 天）——所以一份資料最長約 **60 天**後才真正消失，隱私權政策寫的就是這個數字。改保留規則＝改隱私權政策。

### 擋得住／擋不住

- **擋得住**：
  - `futari_backup` 外洩後的寫入、DDL、建角色、讀 `vault.decrypted_secrets`、讀 `storage.*`、讀 auth 的其他表（sessions、refresh tokens、MFA）——它只有 SELECT／USAGE，而且只在 public、drizzle、`backup_auth.users`／`backup_auth.identities`（schema `backup_auth` 的 USAGE）、`cron.job`。對 schema `auth` 本身**沒有任何權限**。
  - 透過 view 改 auth 資料：兩個 view 加了 `OFFSET 0`，不是可更新的 view（DELETE 會 55000）；角色本來也只有 SELECT。備份每次在 `privileges` 階段確認自己對 `backup_auth` 沒有 INSERT／UPDATE／DELETE／TRUNCATE、沒有 CREATE，有就拒絕執行。
  - Drive 帳號被入侵：拿到的是 age 密文，沒有 identity 解不開。
  - 備份檔或暫存目錄被別的使用者帳號讀到：目錄 700、檔案 600，也沒有明文 dump。
- **擋不住**：
  - **`futari_backup` 的密碼外洩＝全部 app 資料加上 `auth.users`、`auth.identities`（Email、各種 token 欄位）都讀得到**——BYPASSRLS 加上全表 SELECT，就是一份完整的備份。`backup_auth` 的 view 是 `postgres` 擁有、以 `postgres` 的權限讀的**同一份資料**（整列，每個欄位），換成 view 沒有縮小暴露面，只是不用動 schema `auth` 的權限。這個角色縮小的是「能不能改、能不能留下來」，不是「看不看得到」。
  - **鑰匙圈擋不住以你身分執行的程式，包括 agent**：對 `/usr/bin/security` 點過「永遠允許」之後，同一使用者的任何程序都能讀出這個密碼。SHA-256 檢查也一樣——同一使用者能改腳本，也能改 `SHA256SUMS`。它擋的是手滑與裝錯版本，不是同帳號的惡意程式。
  - **age identity＋任何一份備份＝那一天的全部資料**。加密欄位在備份裡仍是密文，要再加上 `ENCRYPTION_KEYS` 的 k2 才讀得到；其餘欄位就是明文。
  - `default_transaction_read_only` 只是護欄：session 可以自己 `SET` 回來。真正的控制是 grant 只有 SELECT。
  - 擁有 Drive 帳號的人可以刪光備份；Drive 垃圾桶的 30 天是最後一道緩衝。
- **規則：`futari_backup` 的授權永遠只有上面那幾處的 SELECT／USAGE**，`tests/futari-backup-role-guard.test.ts` 會擋。要多給（別的 schema、`pg_read_all_data`、EXECUTE、SECURITY DEFINER 函式）先過一次新的安全審查。
  - **失效的樣子**：某個 grant 被拒、或備份讀不到某張表時，最快的「修法」是給 `pg_read_all_data`——不會有任何錯誤，只是這個角色從此讀得到 vault、storage 與每一個 schema。遇到就停下來問，不要這樣補。
  - **撤回紀錄（2026-10-05）**：這裡原本寫「`auth.*` 的 grant 被拒就**停**」，當成 migration 出錯的訊號。實際上那是 Supabase 的常態：`auth` 屬於 `supabase_admin`，`postgres` 對它只有不帶 grant option 的 USAGE，所以 0081 的 `GRANT USAGE ON SCHEMA auth TO futari_backup` 一定被拒（WARNING 01007，什麼都沒給；dev 上確認過），表的 grant 成功了也用不到。解法是 0082 的 `backup_auth` view，不是停下來、更不是更大的權限。0081 本身已套用、不改；它那行在 prod 會照樣跳 WARNING，無害。0082 也把 0081 給 `auth.users`／`auth.identities` 的表 grant 收回。
- **`backup_auth` 的 view 必須維持「擁有者權限」**（不開 `security_invoker`）：view 以擁有者 `postgres` 的權限讀 `auth`，`futari_backup` 才不需要 `auth` 的任何權限。
  - **失效的樣子**：有人為了清掉 Supabase advisor 的警告把 view 設成 `security_invoker=on`——設定當下什麼都沒壞；之後**每一晚**的備份都在 `copy-auth-users` 階段失敗，錯誤種類 `permission`（`permission denied for table users`）。改回來：`ALTER VIEW backup_auth.users RESET (security_invoker);`（identities 同），或用 admin service 重跑 0082 的內容（最後的 DO 區塊會拒絕帶選項的 view）。
- **Supabase Auth 升級不會被這兩個 view 擋住**：view 是 `to_jsonb(整列)`，在 `pg_depend` 只記整張表、不記任何欄位，所以 Supabase Auth 自己的 migration（DROP COLUMN、ALTER COLUMN TYPE、RENAME）照常執行，新欄位自動出現在 `r` 裡（dev 上在會 rollback 的交易裡實測過）。所以沒有欄位漂移檢查，也沒有 refresh 腳本。
  - **失效的樣子**：如果有人把 view 改成列出欄位（`SELECT id, email, … FROM auth.users`），平常一切正常；直到某次 Supabase Auth rollout 要改那個欄位，Auth 的 migration 失敗——**使用者登入失敗**，Supabase 的 Auth log 出現 `2BP01`（cannot drop … because other objects depend on it）或 `0A000`（cannot alter type of a column used by a view），訊息裡點名 `backup_auth`。立刻用 admin service 跑 `DROP SCHEMA backup_auth CASCADE;`（只是 view，不丟資料；當晚備份會失敗），讓 Auth 恢復，再把 0082 的整列版本重套回去。
- **BYPASSRLS 是必要的**：沒有它，`pg_dump` 遇到第一張有 RLS 的表就失敗；`cron.job` 也受 pg_cron 的 RLS 保護，manifest 會列出 0 個 job。**不要用 `pg_dump --enable-row-security` 繞過**：session 沒有 JWT，每條 policy 的 `auth.uid()` 都是 NULL，備份會「成功」，但每張表都是 0 筆——只有還原那天才會發現。

### 設定步驟（每個環境：先 dev，再 prod；全部由使用者執行）

0. **工具**：`brew install age rclone postgresql@17`，演練另外要 Supabase CLI 與 colima（docker）。`postgresql@17` 是 keg-only，路徑在 `/opt/homebrew/opt/postgresql@17/bin`。**pg_dump 的大版本要等於伺服器的大版本**（目前 17）；Supabase 升級到 18 時，腳本會在 `tools` 或 `snapshot` 階段失敗並說明，裝 `postgresql@18`、改設定檔的 `PG_BIN_DIR` 與 `PG_MAJOR`。
1. **跑 migration**（見〈Drizzle Migrations〉；0081 與 0082），然後直接查資料：`select rolname, rolcanlogin, rolbypassrls, rolconnlimit from pg_roles where rolname = 'futari_backup'` 要有一列、`false`／`true`／`2`。再確認：
   - `true`：`has_schema_privilege('futari_backup', 'backup_auth', 'USAGE')`、`has_table_privilege('futari_backup', 'backup_auth.users', 'SELECT')`、`has_table_privilege('futari_backup', 'backup_auth.identities', 'SELECT')`、`has_table_privilege('futari_backup', 'cron.job', 'SELECT')`。
   - `false`：`has_table_privilege('futari_backup', 'backup_auth.users', 'INSERT,UPDATE,DELETE,TRUNCATE')`（identities 同）；anon／authenticated／service_role 對 `backup_auth` 的 USAGE 與兩個 view 的 SELECT。
   - **預期是 `false`**：`has_schema_privilege('futari_backup', 'auth', 'USAGE')`。這是 Supabase 的常態，不是錯（見上方撤回紀錄）；備份不讀 `auth`。
   - 0082 最後的 DO 區塊會逐一核對 `backup_auth` 的擁有者、ACL 與 view 選項，不符就 RAISE、整個 migration 失敗——那時**停下來問**，不要手動補 grant。cron 的 grant 失敗也一樣停。
   - **dev 的例外**：dev 已經套用過時間更晚的 outing migration，drizzle 只套用 `when` 比最後一筆新的項目，所以 `npm run db:migrate` 在 dev 上會**靜默跳過** 0082（沒有錯誤，`backup_auth` 就是不存在）。dev 的 0082 是 2026-10-05 用 admin service 手動執行檔案內容套上的，不補 journal 列（已經有更新的項目）。prod 沒有這個問題：0081、0082、outing 會依序套用。
     - **失效的樣子**：在 dev 以外的環境也遇到同樣的跳過時，migration「成功」，備份當晚在 `privileges` 階段失敗，`last-run.err` 有 `relation "backup_auth.users" does not exist`。
   - **MFA 檢查**（用 admin service 查，dev 演練與 prod 都要）：`select count(*) from auth.mfa_factors`。是 `0` 就照現狀繼續；**大於 0 就停下來問 owner**，決定要不要把 `auth.mfa_factors` 加進備份（要加就是另一次 review 過的改動：migration 的 grant、`backup-prod.sh` 的 `--table`、演練的比對一起改），不要自己先加。
   - **失效的樣子**：有人開了 MFA，備份照樣每晚成功、演練照樣 PASS；直到真的還原那天，這些人的第二因素全部消失，登入流程要他們重新設定或直接卡住。
2. **產生 age 金鑰**：建一個新的加密 dmg「Futari Backup Key」，密碼和 Futari Secrets **不同**，掛載後：

   ```
   age-keygen | age -p > "/Volumes/Futari Backup Key/key.age"
   ```

   `age-keygen` 把公鑰（`age1…`）印在畫面上，記下來（公鑰不是秘密）；私鑰直接經 pipe 進 `age -p` 用 passphrase 加密，不落地。
   - **紙本（必要）**：在沒有錄影、沒有 agent 的終端機視窗執行 `age -d "/Volumes/Futari Backup Key/key.age" | grep AGE-SECRET-KEY`，手抄那一行，抄完 ⌘K 清掉 scrollback、關掉視窗。紙本放在**不同地點**（不是跟 Mac 放一起）。
   - **失效的樣子**：dmg 密碼忘了、紙本又抄錯一個字，每一份備份都還在、每晚都還「成功」，只是永遠解不開——直到真的要還原那天。所以 **prod 的第一次演練一定用紙本**（`--identity-paper`）。
3. **設定密碼**：照〈Runtime DB role〉的禁止事項（不進 SQL 文字、不進指令列、不進 dashboard SQL editor）。產生一組隨機值放進剪貼簿（例如 `openssl rand -hex 32 | pbcopy`），然後：
   - `psql service=futari_<env>_admin` 裡執行 **`\password futari_backup`**（一定要帶角色名稱，原因同 futari_app 步驟 4），貼上；
   - 存進鑰匙圈，`-w` 一定放**最後**、不帶值，讓它用提示字元問：

     ```
     security add-generic-password -s futari-backup -a futari_backup -U -w
     ```

   - `pbcopy < /dev/null` 清剪貼簿；admin service 裡 `ALTER ROLE futari_backup LOGIN;`；Logs Explorer 確認只看到 `{REDACTED}`（同 futari_app 步驟 6）。
   - **失效的樣子**：`-w` 後面直接接密碼，密碼就進了 shell history 與 `ps`，指令一樣成功。
4. **設定檔**：`~/.config/futari-backup/`（700），兩個檔都是 600：
   - `pg_service.conf`：一個 `[futari_prod_backup]` 區段（dev 用 `[futari_dev_backup]`），只放 `host`／`port`（session pooler）／`dbname`／`user`（`futari_backup.<project-ref>` 格式）／`sslmode=verify-full`／`sslrootcert=<Supabase dashboard 下載的 CA 檔路徑>`。**不放密碼**——出現 `password` 欄位腳本就拒絕執行。
   - `config`：`KEY=value` 一行一個。必填 `RCLONE_DEST=<remote>:<資料夾>`；可選 `PG_BIN_DIR`、`PG_MAJOR`、`AGE_BIN`、`RCLONE_BIN`、`PG_SERVICE`、`KEYCHAIN_SERVICE`、`KEYCHAIN_ACCOUNT`、`BUNDLE_PREFIX`（dev 演練用 `futari-dev`，`RCLONE_DEST` 可以是本機資料夾）。不認得的 key、或 `AGE_RECIPIENT`，腳本都拒絕執行。
   - **失效的樣子**：權限太寬（不是 700／600）時腳本在 `preflight` 停下；`--dry-run` 會列出原因。
   - **pooler 主機照 dashboard 的 Connect 抄，不要從另一個環境推**：dev 與 prod 的 session pooler 主機名稱可能只差一個字（`aws-0-…`／`aws-1-…`），不能互相套用。
     - **失效的樣子**：主機抄錯時，第一次跑在 `snapshot` 階段失敗，錯誤種類 `other`，`last-run.err` 裡是 tenant 找不到。不是密碼錯，不會觸發認證封鎖。
   - **同一台 Mac 先演練 dev、再設 prod 時**：狀態目錄 `~/Library/Application Support/futari-backup/` 裡的 `counts.prev`、`LAST_OK` 是 dev 那一次留下的。prod 第一次跑之前，先把它們改名（例如加 `.dev`）或刪掉；`config` 改成 prod 前也先留一份 dev 的副本。
     - **失效的樣子**：prod 第一次跑在 `sanity` 階段失敗，幾乎每張表都被標成 `halved`／`zero`——拿 dev 的大量測試資料當基準比對。不要用 `--accept-counts` 蓋過去，搬走 dev 的狀態檔再跑，基準才乾淨。
5. **rclone**：`rclone config` 新增一個 Google Drive remote，scope 選 **`drive.file`**（只看得到它自己建的檔案）。token 存在 `~/.config/rclone/rclone.conf`，確認是 600。
   - **失效的樣子**：選成完整的 `drive` scope 一樣能用，只是這個 token 外洩時，整個 Google Drive 都跟著暴露。
   - **scope 用選單編號選，不要自己打字**：打成 `drive.file.`（多一個句點）時 rclone 照樣存檔，Google 授權頁才回 `400 invalid_scope`。
   - **「Configure this as a Shared Drive」回答 `n`**：`drive.file` 列不了共用雲端硬碟，答 `y` 會以 `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` 結束——但 token 已經寫進設定檔了。
   - **用自己的 OAuth client，不用 rclone 內建的**：rclone 內建的共用 client_id 會在 2026 年內停用（rclone 自己的警告）。在 Futari 的 Google Cloud 專案建一個「Desktop app」類型的 OAuth client，把 client_id／client_secret 填進這個 remote（不經過指令列），再 `rclone config reconnect <remote>:`。該專案的 OAuth 同意畫面要是「正式版」（In production）。
     - **失效的樣子**：用內建 client 時，某天起每晚在 `upload` 階段失敗；用的 client 停在「測試」狀態時，token 7 天後過期，同樣是 `upload` 失敗，`rclone config reconnect` 只能撐 7 天。
   - **檢查 token 存在時只看欄位名稱**（例如 `grep -oE '^[a-z_]+ *=' rclone.conf`），不要用 sed 遮罩後印整個檔：macOS 的 BSD sed 不認 `\s`，遮罩靜默失效，refresh token 整段印出來。印出來了就到 Google 帳戶的第三方存取撤銷 rclone、刪掉設定檔裡的 token、重新授權。
6. **安裝**：從 review 過的 tag 安裝（dev 演練可加 `--allow-untagged`）：

   ```
   git checkout <tag>
   scripts/ops/install-backup.sh --recipient <age1… 公鑰>
   ```

   然後先跑 `/bin/bash ~/.local/libexec/futari-backup/futari-backup-run.sh --dry-run`（不連任何東西、不讀鑰匙圈，只列計畫與本機檢查），再不帶參數手動跑一次。第一次手動跑時鑰匙圈會問 `security` 能不能讀這個項目，選「永遠允許」。
   - **失效的樣子**：沒有手動跑過就直接交給 launchd，排程時間跳出的詢問視窗沒人回答，每次都在 `credential` 階段失敗。
7. **載入排程**：`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.futari.backup.plist`（`RunAtLoad` 是 false，載入當下不會跑）。驗收：隔天 Drive 上的 `LAST_OK` 是當天早上 08:00 左右的時間。
8. **驗證通知（prod）**：`kickstart` 只對已載入的排程有效，所以排在載入之後。暫時把 `RCLONE_DEST` 改成不存在的 remote，`launchctl kickstart gui/$(id -u)/local.futari.backup`，確認 launchd 底下真的跳出通知、桌面出現 `FUTARI-BACKUP-FAILED.txt`，再改回來、刪掉標記。
   - 通知是 `osascript` 發的，macOS 把它算在「工序指令編寫程式」（Script Editor）名下：**系統設定 → 通知 → 工序指令編寫程式**要允許，樣式建議選「持續」。
   - **專注模式（例如「睡眠」）開著時，通知不會跳出來**，只會收進通知中心。這是排程改在 08:00、不排凌晨的原因：凌晨失敗的通知沒人看得到，要等使用者自己去翻。要讓它穿過專注模式，在該專注模式的「允許的通知」加入工序指令編寫程式。
   - **失效的樣子**：測試時桌面標記有出現、通知卻沒跳——先看通知中心；在那裡就是專注模式或通知設定，不是腳本壞了。桌面標記不受這兩者影響，是比較可靠的那一道。
9. **演練一次**（見下方〈還原演練〉）。prod 的第一次用紙本。

### 每次 migration 之後：覆蓋檢查

0081 的 default privileges 只涵蓋 `postgres` 建的物件。每次 migration 之後（dev 與 prod）用 admin service 跑：

```sql
-- 必須 0 列：任何一列 = 備份讀不到的表
select n.nspname, c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'drizzle') and c.relkind in ('r', 'p')
  and not has_table_privilege('futari_backup', c.oid, 'SELECT');
```

- **失效的樣子**：migration 本身一切正常；當晚的備份在 `dump-public` 階段失敗，錯誤種類是 `permission`。有列就補 `GRANT SELECT ON "<table>" TO futari_backup`（寫成新的 migration）。

### 平常的樣子、失效的樣子

成功時 `~/Library/Logs/futari-backup.log`（600，只有階段、計數、大小、exit code）最後一行是 `done futari-prod-…`，Drive 的 `LAST_OK` 更新。工具的原始錯誤訊息在 `~/Library/Application Support/futari-backup/last-run.err`（600，每次覆寫）——裡面有主機與使用者名稱，**這兩個檔都不要貼到任何公開的地方，也不要貼進 agent session**。

失敗時：macOS 通知＋桌面上的 `FUTARI-BACKUP-FAILED.txt`。這個標記檔**不會自己消失**——之後跑成功也不會刪，修好、確認一次成功之後手動刪。log 的 `FAILED stage=…` 告訴你停在哪裡：

| stage | 常見原因 | 怎麼辦 |
|---|---|---|
| `checksum` | 安裝的副本被改過或沒裝完 | 從 review 過的 tag 重跑安裝 |
| `preflight` | 設定檔、權限、工具路徑；或今天已經認證失敗過 | `--dry-run` 看原因 |
| `credential` | 鑰匙圈鎖著、項目不見、存取被拒 | 確認鑰匙圈在登入期間不會自動上鎖；手動跑一次重新允許 |
| `snapshot`（auth） | 密碼不對 | **當天不重試**（pooler 連續認證失敗會封鎖 IP，見〈Circuit breaker〉）。修好後 `--clear-auth-block` 手動跑 |
| `snapshot`（tls） | CA 檔錯或過期、或 pooler 換了憑證 | 重新下載 CA；**不要**改成 `sslmode=require` |
| `tools` | pg_dump 大版本和設定不符 | 見設定步驟 0 |
| `privileges`（`relation "backup_auth.users" does not exist`） | 資料庫沒有 `backup_auth`：還原之後沒重套 0082，或 `db:migrate` 跳過了它（見設定步驟 1） | admin service 執行 `drizzle/0082_backup_auth_views.sql` 的內容 |
| `privileges`（`write-privilege`） | 有人給了 `futari_backup` 對 `backup_auth` 的寫入權限或 CREATE | **當成事故**：查是誰、什麼時候給的，收回後再跑 |
| `dump-public` | 新表沒有 grant；或等鎖超過 60 秒 | 覆蓋檢查；鎖的話隔天通常就好 |
| `copy-auth-users`／`copy-auth-identities`（`permission`） | view 被設成 `security_invoker`；或 `backup_auth` 的 grant 被收回 | 見上方〈擋得住／擋不住〉的 view 規則；重套 0082 |
| `sanity` | 某張表（上次 ≥ 10 筆）不見了、歸零、或少了一半以上；或 `auth.users`／`Profiles` 是 0 | **先確認是不是 prod 真的掉資料**。是的話不要 `--accept-counts`——之前的備份才是好的那份，30 天內都不會被清掉。確定是預期內的（migration 刪表、清資料）才 `--accept-counts` 手動跑一次 |
| `upload`／`verify` | Drive token 過期或被撤銷、空間滿 | `rclone config reconnect <remote>:` |
| `prune` | 清舊備份失敗 | 今天的備份已經上傳並驗證過；只是清理沒做完 |

**已接受的盲點（使用者 2026-10-04 決定，不加外部 heartbeat）**：如果排程**根本沒跑**（plist 沒載入、macOS 更新後被停用、Mac 關機），**不會有任何通知**——失敗通知只在腳本有跑起來時才會出現。最長可能約 30 天沒人發現，直到下一次每月演練看到 `LAST_OK` 的日期。所以演練的第一步就是看 `LAST_OK`。

### 還原演練（每月；使用者在自己的終端機跑）

輸出只有計數、錯誤數與物件名稱，但**不要貼進 agent session、issue 或 PR**。

1. 看 Drive 上 `LAST_OK` 的日期：不是昨天或今天，就是上面那個盲點發生了——先查排程。
2. 掛載「Futari Backup Key」（或準備紙本）。把最新的備份下載到本機：`rclone copy <remote>:<資料夾>/<bundle> <本機目錄>`。
3. 起一個用完即丟的本機 Supabase（PG 17）：在空的暫存目錄 `supabase init` → `supabase start`。colima 的 VM 磁碟要排除在 Time Machine 之外（`tmutil addexclusion` 加到 colima 的目錄），否則還原出來的資料會跟著進時光機。
4. 跑：

   ```
   scripts/ops/backup-restore-drill.sh --bundle <本機目錄> --identity "/Volumes/Futari Backup Key/key.age"
   scripts/ops/backup-restore-drill.sh --bundle <本機目錄> --identity-paper     # 用紙本
   ```

   腳本只接受 `127.0.0.1` 而且 public 沒有任何表的目標；順序跟真正還原一樣（見下），除了 cron：**只比對、不建 job、不載入任何 Vault 機密**。
   腳本只接受 `bundle_format 2`，四個檔要齊。auth 的兩個檔只當**資料**載入（見下方真正還原步驟 3），每張表印出筆數與「沒還原的 key」——正常是 generated 欄位（`users` 的 `confirmed_at`、`identities` 的 `email`）；出現別的名稱代表本機 stack 的 Auth 版本比備份舊，那些欄位的資料不會進來。
5. **通過條件**（腳本最後印 `DRILL PASS`）：`role does not exist` 錯誤 0、計數／加密 kid／表與欄位與 function 的 ACL／publication／auth trigger 跟 manifest 0 差異、本機 active 的 cron job 0、anon／authenticated 讀得到的 `*_encrypted` 欄位 0。
   - 其他 pg_restore 錯誤（例如 `schema "public" already exists`）會列出物件名稱，不影響判定；第一次 dev 演練時記下基準數字，之後數字變了就去看 `drill-*.err`。
   - 可選：用 k2 的 keyring 對本機這份資料跑 `scripts/reencrypt-pii.ts` dry-run，預期 preflight 0 失敗。這個腳本能不能指向本機 stack，第一次 dev 演練時確認。
6. 收尾：`supabase stop --no-backup`、刪掉本機的 bundle 目錄、退出 dmg、收好紙本。
   - **失效的樣子**：忘了 `--no-backup`，還原出來的 prod 資料留在 docker volume 裡，沒有任何提示。

### 真正還原（prod 壞了）

順序跟演練相同；不同的只有 cron／Vault 與最後幾步。全部用 admin service（〈Runtime DB role〉的連線方式）對**目標** project 執行。每一步都寫了漏掉時的樣子——它們都不會在還原當下報錯。

1. **先建全域角色**：`futari_app`、`futari_backup`，NOLOGIN，執行 `0072` 與 `0081` 開頭的 DO 區塊。
   - 漏掉：pg_restore 對每個給這兩個角色的 GRANT 報 `role … does not exist`，然後繼續——表都在，grant 都沒了；app 切回 `futari_app` 後每個查詢 42501。
2. **default privileges 先關**：

   ```sql
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
   ```

   - 漏掉：還原出來的每張表都帶著 Supabase 預設給 anon／authenticated 的 ALL，Data API 重新打開（#1518），沒有任何錯誤。
   - service_role 也要關：pg_dump 的 GRANT 是相對於內建預設（owner＋PUBLIC）寫的，不看來源的 default privileges，所以目標預設裡留著的角色會拿到來源沒有的權限。漏掉的樣子：演練在第 7 步報 `function ACLs 4 difference(s)`（`frozen_copy_visible`、`viewer_in_chapter` 多了 `service_role=X`），2026-10-06 第一次 dev 演練撞到。
3. **還原順序**：
   1. `age -d -i <identity> public.dump.age | pg_restore -d <目標> --section=pre-data`。
   2. **重套 0082**：`psql -X -v ON_ERROR_STOP=1 -f drizzle/0082_backup_auth_views.sql`（用 review 過的 repo 裡那份）。還原出來的 `drizzle.__drizzle_migrations` 已經列著 0082，`db:migrate` 不會再跑它。
      - 漏掉：還原本身一切正常；之後第一個晚上的備份在 `privileges` 階段失敗，`relation "backup_auth.users" does not exist`。
   3. `age -d … public.dump.age | pg_restore -d <目標> --section=data`。
   4. **auth 資料（只當資料）**，`users` 先、`identities` 後。**絕對不要**把解密出來的內容直接 pipe 進 `psql`（那會把每一行當指令執行，一行 `\!` 就是在你的 Mac 上跑 shell）。照 `scripts/ops/backup-restore-drill.sh` 的 `restore_auth` 做：
      - `CREATE SCHEMA futari_restore_staging; CREATE TABLE futari_restore_staging.users (r jsonb NOT NULL);`
      - `age -d … auth-users.copy.age | psql -X -v ON_ERROR_STOP=1 -c "SET client_encoding = 'UTF8'" -c "\copy futari_restore_staging.users (r) FROM STDIN"`——指令只來自 `-c`，stdin 只是 `\copy` 的資料。
      - 用演練腳本裡那個 DO 區塊 `INSERT INTO auth.users (<欄位>) SELECT <欄位> FROM futari_restore_staging.users s CROSS JOIN LATERAL jsonb_populate_record(NULL::auth.users, s.r) x`：欄位＝目標表非 generated、而且在資料裡出現的 key，名稱符合 `^[a-z_][a-z0-9_]*$`、用 `format('%I')` 加引號；插入筆數要等於 staging 筆數。
      - `identities` 同上；最後 `DROP SCHEMA futari_restore_staging CASCADE;`。
      - 漏掉 staging 的清理：auth 的完整內容留在一個沒人會看的 schema 裡，沒有任何錯誤。
   5. `age -d … public.dump.age | pg_restore -d <目標> --section=post-data`。auth 的資料要在 post-data（外鍵）之前、在步驟 4 的 trigger 之前。
4. **重套 `db/triggers/handle_new_user.sql`**（它不在 migrations 裡，不在 dump 裡）。
   - 漏掉：既有使用者一切正常，**新註冊的人沒有 Profiles 列**，登入後畫面壞掉。
   - 這個檔案改過之後，dev 與 prod 都要手動套一次（見「`handle_new_user` 的手動套用」）。
5. **realtime publication**：依 manifest 的 `## publication` 把表加回 `supabase_realtime`。
   - 漏掉：畫面不再即時更新，重新整理才看得到，沒有錯誤。
6. **Vault 與 cron**：
   - 先建 Vault 機密，值從 Futari Secrets dmg 讀，不打字、不進指令列。`notify-recurring-push`（0100 起）讀三項：`oikos_cron_secret_key`、`oikos_project_url`、過渡期的 `oikos_service_role_key`（#1834 S5 之後就不需要）。psql 裡：

     ```
     \set srk `cat "<dmg 上存 service_role key 的檔案>"`
     SELECT vault.create_secret(:'srk', 'oikos_service_role_key', 'Auth bearer for notify-recurring-push cron');
     \unset srk
     ```
     `oikos_cron_secret_key`、`oikos_project_url` 照〈呼叫者驗證〉→〈只有 owner 能做的事〉第 1–4 步建。
   - 再依 manifest 的 `## cron` 逐一 `SELECT cron.schedule('<jobname>', '<schedule>', convert_from(decode('<base64 command>', 'base64'), 'UTF8'));`。還原到**新的** project 時：0100 之後的 command 不含網址或金鑰，全部從 Vault 讀，所以 command 不用改；要改的是 Vault——`oikos_project_url` 放**新 project** 的網址、`cron` key 在新 project 重建一把再放進 `oikos_cron_secret_key`（舊 project 的那把在新 project 會被 gateway 以 `UNAUTHORIZED_INVALID_API_KEY` 擋下、函式沒有 `[auth]` 行，見上方〈失效的樣子〉）、`oikos_service_role_key` 放新 project 自己的 legacy JWT。函式也要部署到新 project（`verify_jwt` 讀回 `false`）。備份早於 0100 時，command 裡是寫死的舊 prod 網址：先照常 schedule，再手動執行一次 `drizzle/0100_recurring_push_cron_secret_key.sql` 的內容。
   - 漏掉：定期收支推播不再送出，**帳號刪除也不再自動執行**——隱私權政策承諾的 14 天就此失效，而且沒有任何錯誤。
7. **重新套用備份日之後處理過的刪除**：
   - **先** `npm run db:migrate`（指向目標 project），**再**手動跑一次 `SELECT public.process_account_deletions();`。順序不能反：備份早於 `0096`（#1701）時，備份裡的 `process_account_deletions` 是舊本體，留下的人（單人狀態）的刪除會走整本 cascade，把本來要留給離開的人的共同章節整本硬刪。先 migrate 才會換成新本體，並建好 `sweep-orphan-ledgers` job（也要核對 `cron.job` 有它：`SELECT jobname, schedule FROM cron.job WHERE jobname = 'sweep-orphan-ledgers';` → `0 15 * * *`）。
     - 漏掉的樣子：沒有任何錯誤；離開的人打開「過去的時光」，那段章節不見了，而且救不回來（只剩下一份備份）。
     - 在備份時已提出、之後才到期的刪除請求，就是在這一步重新執行的。
   - 備份之後才提出的刪除請求不在備份裡。從客服信件，以及舊 prod 還讀得到時拿它的 `auth.users`／`Profiles.deletion_requested_at` 比對，逐一補上。
   - 漏掉：已經刪除的帳號和資料，在還原後又回來了。
   - 備份早於 `0089`（#1618）時，月回顧快照裡還有付款人的名字（`largest_expense_paid_by_name`）。開放 app 之前跑 `npm run db:migrate`（指向目標 project）會重新套用 0089，回填 id 並清掉名字；之後這個必須是 0：`SELECT count(*) FROM "MonthlyReviewSnapshots" WHERE largest_expense_paid_by_name IS NOT NULL;`。
     - 漏掉：已刪除帳號的真名回到對方的月回顧「最大一筆」，沒有任何錯誤。
   - 備份早於 `0090`（#1622）時，離開帳本時自動建立的帳本可能還叫「某某 的家計簿」。`npm run db:migrate` 會重新套用 0090；若目標的 journal 已有 0090 那一列，就手動跑一次 `psql -f drizzle/0090_ledger_autoname.sql`（idempotent）。之後 `psql -f scripts/ops/ledger-autoname-audit-0090.sql` 的 `matched` 必須是 0（只印數字，不印名字）。
     - 漏掉：帳本名又帶回某個人的真名（包括已刪除帳號者），沒有任何錯誤。
8. **比對**：`psql -f scripts/ops/futari-backup-manifest.sql` 的輸出逐段對 manifest（演練腳本只接受本機目標，這裡手動比）。再跑一次上方的覆蓋檢查，以及〈Runtime DB role〉的覆蓋檢查。
   - **孤兒帳本不變式（#1701）**，三條都必須是 0（只印數字，不印內容）。「孤兒」＝`OikosGroups.member_a` 在 `auth.users` 已無列且 `member_b IS NULL`：

     ```sql
     -- (1) 沒有任何活著的前成員的孤兒帳本（應該已被清掉）
     SELECT count(*) FROM "OikosGroups" g
      WHERE g.member_b IS NULL
        AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.member_a)
        AND NOT EXISTS (
          SELECT 1 FROM "GroupEpochs" e JOIN auth.users u ON u.id IN (e.member_a_id, e.member_b_id)
           WHERE e.group_id = g.id AND e.ended_at IS NOT NULL);

     -- (2) 孤兒帳本裡仍有加密欄位（愛物名稱、旅行／出遊分享連結等）
     SELECT count(*) FROM "Assets" a JOIN "OikosGroups" g ON g.id = a.group_id
      WHERE g.member_b IS NULL
        AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.member_a)
        AND a.name_encrypted IS NOT NULL;
     SELECT count(*) FROM "Outings" o JOIN "OikosGroups" g ON g.id = o.group_id
      WHERE g.member_b IS NULL
        AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.member_a)
        AND (o.share_token_hash IS NOT NULL OR o.share_token_encrypted IS NOT NULL);

     -- (3) 提出刪除超過 15 天仍在（刪除排程壞了或某個帳號卡住）
     SELECT count(*) FROM "Profiles"
      WHERE deletion_requested_at < now() - interval '15 days';
     ```

     - (1) 不是 0：`sweep_orphan_ledgers` 沒在跑或一直失敗。沒有任何錯誤，只是沒人看得到的帳本留在資料庫；看 Postgres log 有沒有 `sweep_orphan_ledgers: failed for` 或 `prune of … failed` WARNING。
     - (2) 不是 0：保留章節的去識別沒做完（0096 的規則比 app 讀取的寬）。
     - (3) 不是 0：多半是 solo 分支的 `_prune_ledger` raise，整個區塊 rollback，每天一筆 `process_account_deletions: failed for <uid>` WARNING，帳號過了 14 天還在（#1377 的樣子）。**不要**為了讓它過去把該帳本改成直接 cascade：那會毀掉離開的人的章節。先修 `_prune_ledger` 失敗的原因。
9. **角色登入**：`futari_app`、`futari_backup` 照各自的步驟重設密碼、`LOGIN`，更新 env。
10. **加密金鑰**：manifest 的 `## encrypted_kids` 列出這份備份需要哪些 kid；目標環境的 `ENCRYPTION_KEYS` 必須都有。
11. **撤銷所有捷徑金鑰（#1536）**：`UPDATE "ShortcutKeys" SET revoked_at = now() WHERE revoked_at IS NULL;`，並請使用者到設定頁重新產生。
   - 漏掉：備份早於某次撤銷時，那把已撤銷的金鑰會跟著還原、重新有效；拿到它的人又能把卡片送進主人的待確認，沒有任何錯誤。
12. 備份之後到壞掉之間的資料（最多約一天）沒有了；要不要通知使用者，是使用者的決定。

### 事故處理

**懷疑 age identity 外洩**（dmg 與其密碼、或紙本被人看到）：

1. 照設定步驟 2 產生新的 identity（新的 dmg、新的紙本），用新的公鑰重跑安裝。
2. 手動跑一次備份並驗證，用新的 identity 演練一次。
3. 新的備份確定存在之後，才刪掉 Drive 上**所有**舊的備份資料夾，並清空 Drive 垃圾桶裡的它們（`rclone cleanup <remote>:`）。順序反過來的話，中間有一段時間完全沒有可用的備份。
4. 已經被複製走的舊備份救不回來：拿到舊 identity 又拿到某份舊備份的人，讀得到那一天的資料。要不要通知使用者，是使用者的決定（同〈緊急輪替〉）。

**懷疑 `futari_backup` 的密碼外洩**：

1. `ALTER ROLE futari_backup NOLOGIN;`（備份暫停，不影響 app）。
2. 踢掉既有連線（換密碼不會中斷已登入的 session）：

   ```sql
   WITH targets AS MATERIALIZED (
     SELECT pid FROM pg_stat_activity WHERE usename = 'futari_backup' AND pid <> pg_backend_pid()
   )
   SELECT pid, pg_terminate_backend(pid) FROM targets;
   ```

3. 換密碼：`\password futari_backup`，`security add-generic-password -s futari-backup -a futari_backup -U -w` 更新鑰匙圈（照設定步驟 3）。
4. `ALTER ROLE futari_backup RESET ALL;` 再重跑 0081 的 `ALTER ROLE futari_backup SET default_transaction_read_only = on;`（角色可以改自己的設定）。
5. 唯讀確認沒有留下東西：`futari_backup` 擁有的物件 0、`pg_auth_members` 裡不屬於任何角色、`has_table_privilege` 的 INSERT／UPDATE／DELETE 在 public 與 `backup_auth` 全是 false、`backup_auth` 沒有 CREATE。全程唯讀，查完再處置（同〈緊急輪替〉）。
6. `ALTER ROLE futari_backup LOGIN;`，手動跑一次備份。
7. 這個角色本來就讀得到全部 app 資料與 `auth.users`（見「擋不住」），應視為資料已暴露；是否通知使用者是使用者的決定。

**懷疑 Drive 帳號或 rclone token 外洩**：在 Google 帳戶的第三方存取裡撤銷 rclone，`rclone config reconnect`。備份本身是密文；要擔心的是對方是否也拿到了 identity。

### Rollback

1. `launchctl bootout gui/$(id -u)/local.futari.backup`，刪掉 plist 與 `~/.local/libexec/futari-backup/`。
2. admin service 跑 `scripts/ops/drop-futari-backup-role.sql`（先收回 default privileges，再 DROP ROLE），再跑 `scripts/rollback/0082_backup_auth_views.down.sql`（`DROP SCHEMA backup_auth CASCADE`，只有 view、不丟資料）。順序反過來（先拆角色、排程還在）的樣子：下一次排程跑的時候失敗通知，其他都不受影響。
3. 刪掉 Drive 上的備份資料夾並清空垃圾桶；在 Google 帳戶撤銷 rclone；`security delete-generic-password -s futari-backup -a futari_backup`。
4. 隱私權政策的備份段落一起改回去——政策寫著「保留約 60 天」，實際做法要跟它一致。

---

## pg_cron → Edge Function 授權：走 Vault

pg_cron job 呼叫 Edge Function 時要帶的金鑰（以及網址），**存 Supabase Vault，job 執行時才讀，不可用 `ALTER DATABASE postgres SET app.*`，也不可在 migration 套用時把值寫進 command**。

**Why**：Supabase 2024 年收掉了一般使用者對自訂 GUC 的 `ALTER DATABASE SET` 權限（`42501 permission denied`）。舊文件／舊 PR 模板還在教這個 pattern，而且它**靜默失敗**：schedule 建立成功，但每日觸發送出的是空的 header，Edge Function 全數拒絕。不把值寫進 command，是因為 `cron.job.command` 是 `futari_backup` 讀得到、每份備份 manifest 都會抄一份的文字（#1834 F7）；寫進去的金鑰就跟著每份備份外流。

**How**：

1. 操作者每個 project 用 `vault.create_secret` 建好需要的項目（值從 Futari Secrets dmg 讀，不打字、不進指令列；`notify-recurring-push` 需要哪三項、怎麼建，見下一節〈只有 owner 能做的事〉）。
2. cron body 內用 `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '<secret_name>'` 讀回組進 header 與網址——現行範例見 [drizzle/0100_recurring_push_cron_secret_key.sql](../../drizzle/0100_recurring_push_cron_secret_key.sql)（它取代 0056；0056 取代了用 ALTER 寫壞的 0055）。
3. 需要 extensions：`pg_cron`、`pg_net`、`supabase_vault`（`SELECT * FROM pg_extension WHERE extname IN ('pg_net','pg_cron','supabase_vault')` 驗證；缺了到 Dashboard → Database → Extensions 開）

---

## 推播 edge function：呼叫者驗證與 Android FCM 金鑰（#968、#1834）

`supabase/functions/send-recurring-push` 每晚 16:10 UTC 由 `notify-recurring-push` cron 呼叫，iOS 走 APNs、Android 走 FCM HTTP v1。兩條分支各自包起來：FCM 的金鑰、OAuth 或網路出錯，不會擋住 APNs，反之亦然。

### 呼叫者驗證

自 #1834 起只有一層，在函式裡：

- **cron 送什麼**（`drizzle/0100`）：`apikey: <Vault oikos_cron_secret_key>`——該 project 在 Dashboard 建的**具名 secret key `cron`**（`sb_secret_…`）。過渡期另外照舊送 `Authorization: Bearer <Vault oikos_service_role_key>`（legacy service_role JWT），只為了讓 #1834 之前的函式在切換當中照樣回 200；新函式完全不看它，#1834 S5 會拿掉（見〈legacy key 退場〉）。網址是 `<Vault oikos_project_url>/functions/v1/send-recurring-push`，每個 project 打自己（0056 寫死 prod 網址，dev 的 cron 一直打 prod）。
- **函式驗什麼**（`callerAuth.ts#checkCronApiKey`，在任何 DB 查詢之前）：`apikey` header 必須等於 runtime 注入的 `SUPABASE_SECRET_KEYS`（以金鑰名稱為 key 的 JSON）裡名為 `cron` 的那一把，常數時間比對。只認 `cron`：不認 `default`、不認任何其他名稱；**不讀 `Authorization`**。`SUPABASE_SECRET_KEYS` 缺、不是 JSON、沒有 `cron`、或 `cron` 不是 `sb_secret_…` → 一律拒絕（fail closed）。不符回 401，函式 log 只有一行 `[auth] reject reason=<原因>`，不記 header、金鑰或 env 的任何部分；通過時不記 log。
- **DB client** 用 `SUPABASE_SECRET_KEYS` 的 `default`，不再用 `SUPABASE_SERVICE_ROLE_KEY`（Supabase 文件說那是 legacy key 的變數，legacy 停用後它裝什麼沒有文件；F3）。
- **`supabase/config.toml` 釘 `verify_jwt = false`**。理由：secret key 不是 JWT，gateway 驗不了；Supabase 文件（[API keys](https://supabase.com/docs/guides/api/api-keys)）明寫用 secret key 呼叫的函式要設 `verify_jwt = false`、在程式裡驗金鑰，而且 `verify_jwt` 這關本來就同時放行 anon key 與當 bearer 送的 `sb_` key，通過它不代表呼叫者是誰。**所以 `checkCronApiKey` 是函式前面唯一的一道**：任何讓它多收一點的改動（加回退路徑、多認一個名稱、讀 `Authorization`、設定缺了就放行）都等於讓任何人都能隨時讓每個家庭的手機收到推播、耗掉 FCM 配額。`tests/push-caller-auth-968.test.ts` 釘住這些。
- **接受的風險（F5）**：`sb_secret_…` 有完整的 DB 權限（繞過 RLS），跟現在的 legacy service_role JWT 一樣大，不是退步。pg_net 送出前，解密後的 header 會短暫出現在 `net.http_request_queue`；能讀那張表的登入角色就看得到。S3 會唯讀確認 `futari_app`、`futari_backup` 讀不到它（`has_table_privilege('<role>', 'net.http_request_queue', 'SELECT')` 要是 `false`）並回報。要把暴露縮到只剩推播，可以改用只有這個函式認得的隨機 token（owner 之後再決定，不在 #1834）。

**撤回紀錄（2026-10-25，#1834）**：這一節原本有一小節「不准關掉 verify_jwt」，`supabase/config.toml` 與 `callerAuth.ts` 頂端也寫「verify_jwt 必須維持 true、不准帶 `--no-verify-jwt` 部署」，測試釘住 `verify_jwt = true` 並掃 repo 裡的部署指令。那條規則只在「gateway 驗 legacy JWT 簽章、函式只讀聲明（role／ref／exp）」的設計下成立：關掉 gateway，聲明誰都能寫。#1834 把聲明檢查整個拿掉、換成函式自己驗具名 secret key，gateway 驗不了這種 key，所以現在是**必須 `false`**。引用舊規則的地方都已改寫：`supabase/config.toml`、`callerAuth.ts` 頂端、`tests/push-caller-auth-968.test.ts`（改釘 `false`，部署指令掃描移除）、本節的部署後讀回、[observability-design.md](specs/observability-design.md) 推播那條、CHANGELOG `[Unreleased]` 的 #968 條目。下一個人可能又推導出「關掉 verify_jwt 很危險，應該打開」——打開不會多擋任何人（anon key 照樣過 gateway），只會在 cron 不再送 legacy `Authorization`（S5）或 legacy key 停用那天讓 cron 401。

**撤回紀錄（2026-10-23，#968）**：S4b 第一版要求 bearer **完全等於**函式的 `SUPABASE_SERVICE_ROLE_KEY`（雜湊後常數時間比對）。dev 部署證明前提不成立：hosted runtime 的 `SUPABASE_SERVICE_ROLE_KEY` 是 41 字元的新版 `sb_` secret key，prod 的 cron 送的是 legacy JWT，兩者永遠對不上；照那版上 prod 的樣子是 cron 16:10 UTC 照常觸發、`net._http_response.status_code` 401、沒有推播、其他地方都沒有錯誤。現在比對的對象是 `SUPABASE_SECRET_KEYS` 的 `cron`，不是 `SUPABASE_SERVICE_ROLE_KEY`；不要加回後者。

**失效的樣子**（共同症狀都是 cron 不是 200、沒有推播、其他地方沒有錯誤；差別在函式 log）：

- `reason=no_key_config`：函式環境的 `SUPABASE_SECRET_KEYS` 沒有名為 `cron` 的 `sb_secret_…`——這個 project 還沒建 `cron` key、名稱打錯（要全小寫 `cron`）、或 key 建立後 runtime 還沒拿到（重新部署函式再測）。**每一個**呼叫都被拒。
- `reason=no_apikey`：請求沒帶 `apikey`。cron 的 job 還是舊形狀（0100 沒套上，或跑了 down script 但函式還是新的）。
- `reason=mismatch`：帶了 `apikey`，是這個 project 認得的 key，但不是 `cron`（例如 publishable、`default`、legacy JWT 或其他不像 `sb_` key 的字串）。值前後的空白在傳輸時就被拿掉了，不會造成 mismatch；Vault 裡的空白由 0100 的 precondition 擋下。
- 401、函式 log **沒有** `[auth]` 行：被 gateway 擋了，函式根本沒執行。有兩種，看 `function_edge_logs` 那一列分辨：
  - `sb_error_code=UNAUTHORIZED_INVALID_API_KEY`（`apikey.error` 是 `bad_length`／`bad_checksum` 之類）：`apikey` 的值**長得像 `sb_` key 但不是這個 project 的任何一把 key**——就算 `verify_jwt=false`，gateway 也會先驗 `sb_` 形狀的 `apikey`（2026-10-25 dev 實測）。代表 Vault `oikos_cron_secret_key` 是別的 project 的、`cron` key 在 Dashboard 換過或刪掉但 Vault 沒更新、或值被截斷／多了字元。修 Vault（`vault.update_secret`）後再測。
  - 沒有 `apikey` 錯誤：`verify_jwt` 又被打開了（讀回見下），而且 cron 送的 legacy JWT 無效或已不送。
- 500、`[push] no default secret key`：`SUPABASE_SECRET_KEYS` 沒有 `default`。
- `net._http_response` 是錯誤或沒有列、函式完全沒被呼叫：Vault `oikos_project_url` 不對。0100 的 precondition 會在 migration 時擋下缺漏或格式錯的 Vault 項目（migration 失敗、job 不動），所以這多半是事後被改過。

#### verify_jwt 必須是 false（每次部署後讀回）

- 部署用一般指令，不帶旗標：`supabase functions deploy send-recurring-push --project-ref <ref>`（CLI 讀 `config.toml` 的 `verify_jwt = false`）。
- 讀回：Management API `GET /v1/projects/{ref}/functions/send-recurring-push`，回應的 `verify_jwt` 必須是 `false`；或在 Dashboard 這個函式的設定頁確認 JWT 驗證是關的。
- 讀到 `true`：過渡期 cron 還送 legacy Bearer，所以當下多半照常 200——**失效是延遲的**，S5 拿掉 Bearer 或 legacy key 停用那天才變成 401、函式沒有 `[auth]` log。立刻用一般指令重新部署，再讀回一次。不要為了「加強」把它打開。
- `supabase/config.toml` 只放 functions 設定，**不要跑 `supabase config push`**（會把 CLI 的本機預設推到 hosted project 的 auth 等設定上）。

#### 只有 owner 能做的事（每個 project：先 dev，再 prod）

agent 不建金鑰、不寫 Vault、不碰 prod；以下由 owner 自己做。

1. **建 `cron` key**：Dashboard → Project Settings → API Keys → Secret keys → 新增，名稱填 `cron`（全小寫、一字不差；函式只認這個名稱）。dev（`ufhcprrauwsxdmscbkrf`）先，prod（`cxbnlahuhdvrbwcnzoqo`）後。
2. **存進 Futari Secrets dmg**：dmg 掛載後把值存成一個檔（例如 `supabase-<env>-cron-secret-key.txt`），不貼進任何對話、不 `cat`、不印。
3. **建 Vault 項目**（`psql service=futari_<env>_admin`，值從檔案讀，不打字）：

   ```
   \set k `cat "<dmg 上存 cron key 的檔案>"`
   SELECT vault.create_secret(:'k', 'oikos_cron_secret_key', 'apikey for notify-recurring-push cron (#1834)');
   \unset k
   SELECT vault.create_secret('https://<該 project 的 ref>.supabase.co', 'oikos_project_url', 'Base URL for notify-recurring-push cron (#1834)');
   ```

   `oikos_project_url` 不是機密（就是公開的 project 網址），但一定是**這個 project 自己的**，結尾不加 `/`。`oikos_service_role_key`（0056）不動，過渡期還要用。
4. **讀回**（只看長度與前綴；網址可以整個看）：

   ```sql
   SELECT name, length(decrypted_secret), left(decrypted_secret, 10)
   FROM vault.decrypted_secrets WHERE name IN ('oikos_cron_secret_key', 'oikos_service_role_key');
   SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'oikos_project_url';
   ```

   預期 `oikos_cron_secret_key` 以 `sb_secret_` 開頭（2026-10 量到的 secret key 是 41 字元）；網址是這個 project 的。
   - **失效的樣子**：值多了換行或空白、網址結尾多了 `/`、放成別的 project 的——0100 的 precondition 讓 migration 直接失敗，訊息只點名哪一個 Vault 項目，不印值。修正 Vault 再跑。
5. **prod 每一個寫入都要 owner 的一句明確的話**：套 0100、部署函式、以及 S4 第 5(c) 步的手動正向呼叫（附帶效果：有待確認卡的家庭當天可能多收到一次提醒）。

#### dev 驗收（S3；owner 做完上面 1–4 之後，agent 可以跑）

1. 照〈Drizzle Migrations〉先算待套用清單，再 `npm run db:migrate`。
2. **關卡：讀回 job 結構**（只看布林，不讀值）：

   ```sql
   SELECT schedule,
          command ~ $r$name = 'oikos_cron_secret_key'$r$ AS apikey_from_vault,
          command ~ $r$name = 'oikos_project_url'$r$    AS url_from_vault,
          command ~ $r$'apikey'$r$                      AS sends_apikey,
          command ~ $r$'Authorization'$r$               AS sends_bearer,
          command ~ 'https?://|supabase\.co|sb_secret_|eyJ' AS has_literal
   FROM cron.job WHERE jobname = 'notify-recurring-push';
   ```

   預期 `10 16 * * * | t | t | t | t | f`。dev 的 migration 歷史被污染過（見上），`db:migrate` 可能回報成功卻跳過 0100：那就手動執行 0100 的檔案內容（idempotent）再讀一次。**不符就停，不要部署函式。**
   - 同時唯讀確認 F5：`has_table_privilege('futari_app', 'net.http_request_queue', 'SELECT')`、`futari_backup` 同，兩者都要 `false`；回報結果。
   - dev 特有、預期內：dev 的 Vault `oikos_service_role_key` 是 `sb_…` key 不是 legacy JWT（2026-10-23 量到），所以從 0100 套上到新函式部署之間，dev 的 cron 打 dev 會被舊函式以 `reason=not_jwt` 擋掉。prod 的是 legacy JWT，沒有這個空窗。
3. **部署新函式前**：對**現在的** dev 函式送一次雙 header 請求，要 200——證明 gateway 不會因為多了 `apikey` 而擋下 legacy Bearer：

   ```bash
   SR=$(supabase projects api-keys --project-ref ufhcprrauwsxdmscbkrf -o json | jq -r '.[] | select(.name=="service_role") | .api_key')
   CK=$(cat "<dmg 上存 dev cron key 的檔案>")
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $SR" -H "apikey: $CK" \
     -H 'Content-Type: application/json' -d '{}' \
     https://ufhcprrauwsxdmscbkrf.supabase.co/functions/v1/send-recurring-push
   ```

   不是 200 就停下來回報（gateway 擋雙 header 的話，這個切換順序不成立）。
4. 部署新函式到 dev（一般指令），讀回 `verify_jwt: false`。
5. **手動矩陣**（金鑰都放 shell 變數，不印出；原因從函式 log 讀）：沒有 header → 401 `no_apikey`；`apikey: <publishable key>` → 401 `mismatch`；`apikey: <default secret key>` → 401 `mismatch`；只有 legacy Bearer → 401 `no_apikey`；`apikey: $CK` → 200。
   - 拿到 `no_key_config`：`cron` key 建立後 runtime 還沒拿到 `SUPABASE_SECRET_KEYS` 的新內容。記下來、重新部署、再測。
6. 下一次 dev 16:10 UTC 執行 → `net._http_response` 200（只 select `id, status_code, timed_out, created`）。
   - **dev 做不到這一步（2026-10-25 量到）**：dev 沒有安裝 `pg_net`（`pg_extension` 裡只有 `pg_cron`、`supabase_vault`，也沒有 `net` schema），所以 dev 的排程每晚呼叫 `net.http_post` 都會失敗，不會真的打到函式；F5 的 `net.http_request_queue` 權限檢查在 dev 也無從查起。dev 只能用步驟 3–5 的手動請求驗證；排程本身的 200 要到 prod（S4.7）才看得到。失效的樣子：在 dev 等 16:10 等不到任何 `net._http_response`，不是 0100 壞了。
   - 2026-10-25 dev 實測結果：0100 讀回 `10 16 * * * | t | t | t | t | f`；雙 header 打舊函式 200；新函式 `verify_jwt=false`；矩陣 none→401 `no_apikey`、publishable→401 `mismatch`、default→401 `mismatch`、legacy Bearer only→401 `no_apikey`、cron→200。

#### prod 切換（S4；每一個寫入都要 owner 的一句明確的話）

排在某次 16:10 UTC 執行**剛結束之後**，留約 24 小時發現問題與回滾。

1. **Vault 預檢**（admin service，唯讀）：上面 owner 第 4 步的兩條查詢。預期 `oikos_cron_secret_key` 是 `sb_secret_…`、`oikos_service_role_key` 仍是 `219 | eyJ…`（legacy JWT，過渡期還要它）、網址是 `https://cxbnlahuhdvrbwcnzoqo.supabase.co`。
2. 照〈Prod：npm script 到不了〉先比對待套用清單，再套 0100。
3. **關卡**：同 dev 第 2 步讀回 job 結構。**不符就停，不部署函式。**
4. 部署函式（一般指令，`--project-ref cxbnlahuhdvrbwcnzoqo`），讀回 `verify_jwt: false`。
5. **部署當天的檢查**（原因只從函式 log 讀）：
   - (a) 沒有任何 header 的 POST → 401，`reason=no_apikey`。
   - (b) 用 prod 的 **publishable key** 當 `apikey`（`PK=$(supabase projects api-keys --project-ref cxbnlahuhdvrbwcnzoqo -o json | jq -r '.[]|select(.type=="publishable")|.api_key')`）→ 401，函式 log `reason=mismatch`。這證明請求到得了函式、`SUPABASE_SECRET_KEYS` 解析得到、而且有 `cron`（設定壞掉會先回 `no_key_config`）。拿到 `no_key_config` → 回滾。**不要用隨機的 `sb_secret_…` 當錯誤值**：gateway 會先以 `UNAUTHORIZED_INVALID_API_KEY` 擋下、函式根本沒執行，看起來像「沒有 `[auth]` 行」，會被誤判成 `verify_jwt` 被打開（2026-10-25 dev 實測）。
   - (c) owner 同意後，走 cron 的同一條路手動呼叫一次（admin service）：

     ```sql
     SELECT net.http_post(
       url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'oikos_project_url' LIMIT 1) || '/functions/v1/send-recurring-push',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'oikos_service_role_key' LIMIT 1),
         'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'oikos_cron_secret_key' LIMIT 1)
       ),
       body := '{}'::jsonb
     );
     -- 用回傳的 id，只查狀態碼：
     SELECT id, status_code, timed_out, created FROM net._http_response WHERE id = <回傳的 id>;
     ```

     要 200。這證明 Vault 的 key 等於函式認的 `cron`，而且 `default` 建的 DB client 能查詢。**不要 select `headers`**。
6. 第 5 步任何一項不通過 → 照下面〈回滾〉的順序做完，要在下一次 16:10 UTC 之前。
7. 下一次 16:10 UTC 執行之後 6 小時內（pg_net 預設只留 6 小時），唯讀查：

   ```sql
   SELECT id, status_code, timed_out, created
   FROM net._http_response
   WHERE created >= date_trunc('day', now()) + interval '16 hours 10 minutes'
   ORDER BY created
   LIMIT 5;
   ```

   - 只看狀態碼；**不要 select `headers`、`content`**。200：通過。查不到任何列：多半是超過 6 小時被清掉，隔天再查。

#### 回滾（照順序）

1. 從 #1834 之前的 commit 開 detached worktree（`git worktree add --detach <dir> <commit>`），在裡面重新部署函式：`supabase functions deploy send-recurring-push --project-ref <ref>`，不帶其他旗標（那份 `config.toml` 是 `verify_jwt = true`、函式是聲明檢查）。
2. 讀回 `verify_jwt: true`。**確認了才做下一步。**
3. `psql "$DATABASE_URL_DIRECT" -1 -v ON_ERROR_STOP=1 -f scripts/rollback/0100_recurring_push_cron_secret_key.down.sql`，跑檔頭的 post-check。它還原 0056 的 header 形狀（只有 Bearer），但網址仍從 Vault `oikos_project_url` 讀——沒有寫死的網址，dev 不會被指回 prod。
4. 下一次執行 → 200。
- **順序反過來的樣子**：先跑 down script、新函式還在線上——新函式不看 `Authorization`，job 又沒了 `apikey`，下一次 16:10 UTC 401、`reason=no_apikey`、沒有推播。
- 回滾後要再往前：重新部署新函式，再手動執行一次 0100 的檔案內容（journal 已記錄 0100，`db:migrate` 不會再跑它），再走一次 dev 第 2 步的關卡。

#### `cron` key 外洩

1. Dashboard 刪掉那把 `cron`，建一把新的、同樣叫 `cron`，存進 dmg。
2. 更新 Vault（psql，值從檔案讀）：

   ```
   \set k `cat "<dmg 上的新檔案>"`
   SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'oikos_cron_secret_key'), :'k');
   \unset k
   ```

3. 先在 dev 測：不重新部署，`SUPABASE_SECRET_KEYS` 是否已經換成新 key（dev 第 5 步的 `apikey: <新 key>` → 200）。拿到 `mismatch`／`no_key_config` 就重新部署再測，並把結果記在這裡。
4. prod 同樣更新後，避開 16:10 UTC，照 S4 第 5(c) 步手動正向呼叫一次。
- 刪 key 到 Vault 更新之間 cron 會 401（gateway 以 `UNAUTHORIZED_INVALID_API_KEY` 擋下，函式沒有 `[auth]` 行）；外洩時接受這個空窗。

#### legacy key 退場（#1834 S5，2026 年底前）

Supabase 預計在 2026 年底停用 legacy JWT API key（anon／service_role）。#1834 讓 cron 改用具名 key，但過渡期的 `Authorization: Bearer <legacy JWT>` 還在。在 Dashboard 停用 legacy key **之前**，另開一條 PR：

1. 新 migration 從 `notify-recurring-push` 拿掉 `Authorization` header（它自己的 precondition 不再要求 `oikos_service_role_key`；0100 的只在套用那一次跑），dev → prod 照上面的關卡讀回。
2. 刪 Vault `oikos_service_role_key`。
3. 確認 web app 的 `NEXT_PUBLIC_SUPABASE_ANON_KEY`（Vercel prod／preview 與本機）已經是 `sb_publishable_…`，不是 legacy anon JWT（F8）。
   - **失效的樣子**：這一步漏掉、legacy key 一停用，web app 對 Supabase 的每個請求都失敗——登入、讀資料全壞。
4. 以上都完成，才在 Dashboard 停用 legacy key。

### 發送上限、截止時間與 summary log（#1827 S1）

每個登入的人都能寫自己的 PushTokens 列；#1827 之前函式照表格順序一筆一筆送、APNs 沒有逾時，一個帳號塞一千筆就能吃掉整次執行。現在：

- **讀取**：待確認卡的 `group_id` 與 PushTokens 都用 keyset 分頁讀到空頁為止（`keysetPages.ts`），不受 project「Max rows」截斷。讀取出錯只記 `[push] query error code=…`（支出，回 500）／`[push] income query error code=…`（收入，照常送支出的）／`[push] token query error code=…`（回 200、這次不送）。
- **排程**（`sendPlan.ts`）：帳本間輪流、帳本內兩個成員輪流；每人最多 10、每帳本最多 20、每次最多 2000。
- **發送**（`sendPool.ts`）：每個平台 8 個併發，APNs 與 FCM 同時跑；每個請求 10 秒逾時；開始讀取後約 100 秒就不再發新的，兩個分支一律跑完失效 token 的刪除。
- **每次 200 都有一行**：`[push] summary sent=<n> skipped_by_cap=<n> skipped_by_deadline=<n>`，只有計數。

**平常的樣子**：兩個 skipped 都是 0。**失效的樣子**：

- `skipped_by_cap` > 0：有人超過 10 台裝置、帳本超過 20、或整次超過 2000。0101 套上後每人只會剩 10 列，所以多半是帳本或整次的上限；先唯讀數 PushTokens 每人、每帳本的列數（只數，不讀 token）。
- `skipped_by_deadline` > 0：APNs／FCM 回得很慢，同一次 log 會有很多 `status=network`。持續出現就是有家庭每晚收不到。
- 完全沒有 summary 行、cron 不是 200：函式在中途被平台砍掉（超過 wall-clock），或是 `[auth]`／`no default secret key` 那幾種（見上面〈呼叫者驗證〉）。

**部署**：只動函式，不需要 migration；跟 0101 哪個先都可以。prod 部署要 owner 的一句明確的話，而且**必須在 #1834 的 prod 切換（上面 S4）做完、檢查都通過之後**（兩者都改 `index.ts`，這版疊在 #1834 上）。部署後：讀回 `verify_jwt: false`；跑 S4 第 5 步的 (a) 沒有 header → 401 `no_apikey`、(b) 錯的 `sb_secret_…` → 401 `mismatch`；下一次 16:10 UTC 執行回 200，函式 log 有 summary 行。回滾：從 #1834 的函式 commit 開 detached worktree 重新部署，讀回 `verify_jwt`。

### PushTokens 格式與筆數上限（0101，#1827 S2）

`drizzle/0101_push_token_format_cap.sql`：刪掉格式不合的列，加完整驗證的 CHECK `push_tokens_token_format`（apns：大小寫 hex、64–512、偶數長度；fcm：`[A-Za-z0-9_:-]`、20–512）；BEFORE UPDATE trigger 讓 `updated_at` 跟著每次重新註冊更新；AFTER INSERT trigger 讓每個 user_id 最多 10 列，超過就刪最久沒重新註冊的。數字的唯一來源是 `lib/pushTokenFormat.ts`。

**套用前（每個環境，唯讀，只數不讀 token）**：

```sql
SELECT platform, count(*) AS total,
       count(*) FILTER (WHERE NOT (
         (platform = 'apns' AND token ~ '^[0-9A-Fa-f]+$' AND char_length(token) BETWEEN 64 AND 512 AND char_length(token) % 2 = 0)
         OR (platform = 'fcm' AND token ~ '^[A-Za-z0-9_:-]+$' AND char_length(token) BETWEEN 20 AND 512))) AS will_delete
FROM "PushTokens" GROUP BY platform;
SELECT max(n) FROM (SELECT count(*) AS n FROM "PushTokens" GROUP BY user_id) s;
```

prod 2026-10-25：41 列全是 apns、`will_delete` 0、每人最多 2。`will_delete` 不是 0 就先停下來看是哪一種格式（長度、大小寫），不要照跑——那可能是真的裝置。

**dev**（agent 不自己跑，交給 owner／協調者）：照〈Drizzle Migrations〉先算待套用清單，`npm run db:migrate`，然後**一定要查資料確認真的套上了**（dev 歷史被污染，可能回報成功卻跳過）：

```sql
SELECT convalidated, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'push_tokens_token_format';
SELECT tgname FROM pg_trigger WHERE tgrelid = '"PushTokens"'::regclass AND NOT tgisinternal ORDER BY 1;
SELECT proname, prosecdef, proconfig,
       has_function_privilege('anon', oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', oid, 'EXECUTE') AS authenticated
FROM pg_proc WHERE proname IN ('push_tokens_touch_updated_at', 'push_tokens_enforce_cap');
```

預期：`t` 與兩個平台的條件；`PushTokens_enforce_cap`、`PushTokens_touch_updated_at`；`push_tokens_enforce_cap` 是 `t | {search_path=""}`，兩個函式的 anon／authenticated 都是 `f`。沒套上就手動跑檔案本體（idempotent）：`psql "$DATABASE_URL_DIRECT" -1 -v ON_ERROR_STOP=1 -f drizzle/0101_push_token_format_cap.sql`。之後重跑 dev DB 測試：`npx vitest run --no-file-parallelism __tests__/actions/pushTokens1605.test.ts __tests__/actions/dataApiGrants1518.test.ts`（allowlist 不該多任何一行）。

**prod**：發版時套，要 owner 的一句明確的話；順序上排在 #1834 的 prod 切換之後（不是技術依賴，是一次只動一件事）。照〈Prod：npm script 到不了〉先比對待套用清單，再跑上面「套用前」的計數、套用、再跑一次 dev 那三條查詢。之後 Sentry 會出現的新訊號見下。

**失效的樣子**：

- Sentry `push token upsert failed code=23514`（`area: push`、`op: token_upsert`）：CHECK 擋掉了某台裝置的 token。如果不只一兩則，多半是 Apple／Google 改了格式，真機收不到推播、畫面上什麼都沒有。先跑下面的 rollback（或至少 `ALTER TABLE "PushTokens" DROP CONSTRAINT push_tokens_token_format`），再看格式改 `lib/pushTokenFormat.ts` 與新 migration。
- `code=42501`：換帳本當下的競態（0087），零星出現是預期內的。
- 有人回報「重灌很多次之後最舊那台收不到」：那就是上限在淘汰，預期內（每人 10 台）。

**回滾**：`psql "$DATABASE_URL_DIRECT" -1 -v ON_ERROR_STOP=1 -f scripts/rollback/0101_push_token_format_cap.down.sql`，跑檔頭的 post-check（三個 0）。跟程式碼沒有順序關係；刪掉或淘汰的列不會回來，真的裝置下次打開 App 會重新註冊。

### FCM 金鑰（Supabase function secrets）

| secret | 內容 |
|---|---|
| `FCM_CLIENT_EMAIL` | service account 的 email：`futari-fcm-sender@oikos-pj.iam.gserviceaccount.com` |
| `FCM_PRIVATE_KEY_PEM` | 下載的金鑰 JSON 裡的 PEM 私鑰；保留 JSON 的 `\n` 跳脫也可以，程式會換回換行 |
| `FCM_PRIVATE_KEY_ID` | 同一把金鑰的 key id（JWT 的 `kid`） |

- Firebase project id `oikos-pj` 和 token URI `https://oauth2.googleapis.com/token` 寫死在 `fcm.ts`，不是 secret。
- SA 只有 `roles/firebasecloudmessaging.admin`。**dev、prod 各用一把不同的 key**（同一個 SA）；prod 那把的 key id 開頭是 `bb467751`。dev 那把建立後把開頭 8 碼記在這裡。
- 設定方式：三行寫在加密 dmg 掛載後的檔案裡，`supabase secrets set --project-ref <ref> --env-file <dmg 裡的檔案>`。**不要用 `NAME=value` 寫在指令列**：會留在 shell history 與行程列表。不要 `cat`、不要印出這個檔案。確認只用 `supabase secrets list --project-ref <ref>`（只顯示名稱與 digest）。
- 函式每次執行只換一次 OAuth access token，只存在那次執行的記憶體裡，不寫進任何地方，也不寫進 log。

**失效的樣子**（每一種都是 Android 使用者靜靜收不到推播，iOS 照常，沒有任何畫面上的錯誤；只有函式 log 看得到）：

- secret 沒設或有一個是空的：每晚一行 `[fcm] secrets missing; skipping FCM sends`。
- key 已刪除、key id 對不上、email 打錯：`[fcm] oauth failed status=400 error=invalid_grant`（log 只記 OAuth 回應的 `error` 欄位）。
- PEM 貼壞（少一段、多了引號）：`[fcm] branch failed: <錯誤名稱>`。
- `[fcm] stale-delete breaker tripped`：這次超過一半的 FCM 發送回 400，函式這次一個 FCM token 都沒刪。多半是 payload 或設定壞了，不是大量手機失效；先查最近的部署。

### 金鑰輪替與撤銷

規劃內輪替（建議跟 Apple OAuth secret 一起排，見下方「Sign in with Apple」雷點 2）：

1. 使用者在 Google Cloud Console（或自己用 `!` 跑 gcloud）替 `futari-fcm-sender` 建一把新 key，JSON 直接存進加密 dmg。
2. dev：用新 key 更新三個 secret（`--env-file`），驗證：dev Android build 收到一則推播，函式 log 沒有 `[fcm] oauth failed`。
3. prod：同樣更新，驗證：下一次 16:10 UTC 執行的函式 log 沒有 `[fcm] oauth failed`／`[fcm] branch failed`。
4. 確認 prod 用新 key 跑過之後，才在 Console 刪除舊 key。順序反過來的樣子：舊 key 刪掉到新 secret 生效之間，Android 推播全部 `invalid_grant`。

懷疑 key 外洩：直接在 Console 刪除那把 key（不等新 key），接受 Android 推播中斷到新 key 設好；再照上面 1–3 補新 key。已經換出去的 access token 刪 key 後最多還能用 1 小時，無法提早作廢。

---

## Supabase Auth：JWT 簽章金鑰與 refresh token（#1540）

**JWT 簽章金鑰：先輪替、等它簽過的 access token 全部過期（~1 小時）之後才 revoke**；並在兩個 project 的 Auth 設定確認 refresh token reuse interval（唯讀查看）。失效的樣子：提早 revoke 會讓 `getUser()` 回 `bad_jwt`，`proxy.ts` 把它當「確定被拒」清掉登入 cookie——所有在那一小時內簽發 token 的使用者同時被登出，沒有任何錯誤。

---

## Sign in with Apple 外部設定

Apple Developer Portal + 兩個 Supabase project 都已設定完成（#903 / PR #910）。具體 ID 值與 `.p8` 私鑰不進 public repo——ID 存單機 agent memory，私鑰存密碼管理器。

**雷點 1 — Supabase「Client IDs」順序有意義**：Supabase 拿清單**第一個**當 web authorize 的 `client_id`，必須 **Services ID 在前、Bundle ID 在後**。Bundle ID 排第一時，web/Android OAuth 會被 Apple 以 `invalid_client` 擋下（Bundle ID 不是合法的 web Services ID）。Bundle ID 仍要留在清單裡供 native `signInWithIdToken` 驗 token。

**雷點 2 — OAuth Secret 每 6 個月過期**：Supabase 的「Secret Key (for OAuth)」是用 .p8 + Team/Service/Key ID 產的 JWT，**約 2026-12 到期**；到期前用 Supabase 文件頁的產生工具重產，並更新 dev / prod 兩個 project。過期的症狀：web/Android Apple 登入壞掉、native 不受影響。

**驗證**（不需 anon key）：

```
curl -sI "https://<ref>.supabase.co/auth/v1/authorize?provider=apple"
```

看 `Location` header 的 `client_id` 是否為 Services ID。

---

## GA / Ko-fi 收益歸因：不可移除

`app/layout.tsx` 的 `<GoogleAnalytics gaId="G-YHXFBMRQ3S">` 是**跨產品共用**的 property，服務 Ko-fi 收益來源歸因；`components/KofiWidget.tsx` 的 `kofi_widget_click` 事件（repo 內唯一的 `gtag` 呼叫）是歸因鏈的輸入。

**Why 看起來可刪但不能刪**：從 Oikos 單體看，142 KiB 的 GA 只為一個事件、且已有 PostHog / Vercel Analytics，像是效能 easy win——但它承載跨產品商業需求。

**也不要 lazy load gtag（例如比照 #1520 用 `whenIdle` 延後）**。除了 `app/layout.tsx` 那道「只在 production deployment 載入」的 gate（#1116），不要再加任何條件。理由有兩個：

- **Ko-fi 點擊會無聲消失**：`KofiWidget` 呼叫的是 `window.gtag?.(…)`，`window.gtag` 還沒定義前這次呼叫什麼都不做。延後載入，太早發生的 `kofi_widget_click` 就直接不見，不會有任何錯誤。
- **GA 是品牌頁唯一完整的流量基準**：#1520 之後，品牌頁的 PostHog 會晚 1–2 秒才啟動，太快離開的訪客不會進 PostHog。observability-design.md 因此指定「跨部署日比流量看 GA」。gtag 一延後，這個基準就跟著偏掉。

**撤回紀錄（2026-10-06）**：這裡原本寫「歸因需要 pageview + referrer 上下文」，這個理由不成立。Ko-fi 收益歸因（#1308）只用 `kofi_widget_click` 的 `source` 加點擊時間，去對 Ko-fi 的交易時間，不用 pageview 也不用 referrer。規則本身沒變，換掉的只是理由。以後如果有人再以「歸因需要 pageview」為由反對改動 GA，先回來看這段。

**How**：landing JS 的效能工作對準 first-party chunks 與 PostHog module，把這 142 KiB 當必要商業成本。見 oikos#922 與 `components/KofiWidget.tsx` 檔頭註解（runtime iOS gate + `SOURCE` 歸因常數）。

**已接受的風險（#1300）**：這個 property 收得到 Futari 的原始網址，包括邀請 token（`dl`／`dr`）和 `/records` 的篩選值。原因是共用串流上開著「依瀏覽器歷史記錄計算網頁變化」，而它不能為了 Futari 單獨關掉。GA 後台的網址不會跟著 token 失效；要清除只能在 GA 後台處理。完整脈絡和什麼會改變這個決定，見 [observability-design.md](specs/observability-design.md)「GA 會收到原始網址」那條。**不要在這條串流上關歷史記錄設定**：Wildcard／blog 的站內換頁 page view 會一起消失。
