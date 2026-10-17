---
status: planned
related_specs: [recurring, inbox-layer, transactions]
related_issues: ["#1536", "#1488", "#1754"]
---

# 捷徑送來的待確認（Shortcut pending）

> iPhone 的「捷徑」把一筆花費送進 Futari，Futari 不直接記帳，而是產生一張**只有自己看得到**的待確認卡；本人按「記下」或「改一下」之後才進共同帳本。

## 為什麼（what / why）

- #1488 第一版的捷徑只會「打開 App、帶入一筆填好的記一筆」，還是要人按存檔。使用者在 Apple Pay／LINE Pay 付款通知之後提出：讓捷徑在背景送出，但**不要直接寫進帳本**——付款通知可能重複、可能是不想記的私人花費，直接寫入會讓伴侶看到不該看的、也會多記。
- 所以落點是「待確認」，跟定期支出的待確認同一種體驗：記下、改一下、略過。
- 只走網頁 API，不做 App Intents：不必改原生殼、不必送審（App Intents 留給之後）。

## 給誰看、誰能做（who）

- **只有金鑰主人**看得到、能確認自己的待確認卡；伴侶看不到，也不會即時收到。確認之後才是共同帳本裡的一筆，付款人是本人，分攤用帳本預設。
- 金鑰一人一把，在設定頁「捷徑金鑰」產生；只顯示一次，可重新產生（舊的立刻失效）或撤銷。
- 金鑰外流的影響只限「有人能往你的待確認裡塞卡片」，不會直接進帳本（使用者 2026-10-17 接受這個風險）。設定頁提醒不要分享含金鑰的捷徑。

## 行為

- **送進來**：`POST /api/shortcut/pending`，`Authorization: Bearer <金鑰>`，JSON `{ amount, category?, note? }`（驗證規則同 `lib/quickAdd.ts`）。金鑰錯、撤銷、帳號不在或在刪除寬限期，一律同一個 401。每把金鑰每小時最多 30 張，每人同時最多 50 張未處理。
- **卡片**：日期是建立當天（Asia/Taipei）。有備註才能一鍵「記下」；沒有備註只能「編輯後記下」，不寫入任何預設描述。沒分類的記成「其他」。
- **30 天**：沒處理的卡片 30 天後不再顯示、也不能確認，每日 cron `cleanup-shortcut-pending` 把它刪掉。
- **確認**：同一交易裡先搶下卡片再寫入，兩台裝置同時按只會記一筆；餘額、首筆事件、`record_created`（`via: 'shortcut'`）與手動記帳走同一個 helper（`lib/transactionWriteEffects.ts`）。
- **過去章節**：被釘在過去章節時不顯示卡片，確認也會被拒絕（同定期支出）。

## 和 Inbox layer 的關係

這是 [inbox-layer](inbox-layer-design.md) 預言的「第三種待確認」：定期支出的 `PendingExpenseOccurrences` 綁在規則上（`rule_id` NOT NULL），不能直接重用，所以另開 `ShortcutPendingExpenses`。兩者的差別：

- 這張表**沒有** `resolved_tx_id`：確認時直接刪掉卡片，不留指向交易的外鍵——避免 #1689 那種「外鍵擋住每週清理 cron」的事再發生。
- 以 `user_id` 歸屬、不存 `group_id`：卡片是「人」的，確認時才決定寫進哪本帳本（當下開著的那一章）。

將來真的做 Inbox layer 時，這張表是合併的候選之一。

## 不做

- App Intents／原生背景執行（要改原生殼、送審）。
- 教學頁改成新流程：等實機確認「錢包」自動化能不能把金額傳給捷徑（#1754 的實機結論），另開一張。教學頁的捷徑範本**不能**內含金鑰，要用「匯入問題」讓使用者自己貼。

## 失效的樣子（給維護的人）

- 還原 prod 備份後沒有撤銷所有金鑰：已撤銷的金鑰跟著復活，沒有任何錯誤（ops-runbook〈真正還原〉第 11 步）。
- 鎖的順序反過來（先鎖金鑰列、再等 Profiles 列）：和設定頁的產生／撤銷互相等待，Postgres 中止其中一個（40P01），使用者看到「沒有成功」。
- `proxy.ts` 的 public 例外從完全比對改成前綴比對（`startsWith('/api/shortcut')`）：之後新增的 `/api/shortcut*` 路由都會跳過登入檢查，而且不會有任何錯誤。現在的完全比對由 `tests/shortcut-pending-route-1536.test.ts` 守住。
