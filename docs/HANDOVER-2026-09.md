# 交接 — 2026-09-04

這一輪從「設計專案與 repo 對帳」開始，做完了設計稿 turn 8–9 的五項提案，順帶清掉一批既有缺陷。
八個 PR（#25–#32）已併入 `main` @ `952e968`。

這份文件寫的是**接手的人需要知道、但從 diff 看不出來的事**：每個決定的理由、還開著什麼、
以及這個 codebase 有哪些會咬人的地方。規範本身在 [`UIUX-STANDARD.md`](UIUX-STANDARD.md)，
設計專案往返記錄在 [`design-project-sync.md`](design-project-sync.md)。

---

## 現在的狀態

```
main @ 952e968 · v0.14.3
分支：只有 main（本機與遠端）
開著的 PR：0
封存 tag：archive/ux-design-and-tickets（見下方「已關閉的方向」）
```

驗證（**照這個順序**，原因見下方「native module 的 ABI 陷阱」）：

```bash
npm run typecheck && npm test && npm run build
npx electron-rebuild -f -w better-sqlite3 && npx playwright test
npm rebuild better-sqlite3     # 換回 Node ABI，否則下次 npm test 會整批 skip
```

目前基準：typecheck 乾淨 · unit **1055 passed (98 files)** · e2e **89 passed, 1 skipped**。

---

## 這一輪做了什麼

| PR | 內容 | 值得記住的決定 |
|---|---|---|
| #25 | 設計專案對帳 + §21 rule-6 測試 | 設計稿長到 22 節、repo 只有 11 節的部分鏡像，兩邊都不知道對方動了 |
| #26 | **8b 標記修訂** | 修訂是新的鏈上事件，不是 UPDATE。fold 的排序刻意不用 Timeline 的比較器 |
| #27 | **8a 範圍回溯** | 撤回由「違規紀錄」算，不是重掃語料 |
| #28 | **9a/9b/5c 漸進揭露** | 每個「比較寬鬆的解鎖判準」都會讓某一頁說謊 |
| #29 | 設計稿全文進 repo | 反方向的整份複製才安全；加上實作狀態註記 |
| #30 | 四個安靜的缺陷 | 包含一份宣稱自己已出貨的規格文件 |
| #31 | **typecheck 進 CI** | 367 → 0，其中三個是活的 bug |
| #32 | **書籤裁決** | quickmarks 本來就不是紀錄，是產品一直宣稱它是 |

### 三個核心決定，展開來說

**8b — 為什麼修訂是新事件。** `events` 表用兩個 trigger 拒絕 UPDATE 與 DELETE，那是設計而不是
要繞過的障礙。所以修訂寫成 `marker` + `data.subtype:'amended'`，只夾帶變更欄位，原列一個位元組
都沒動；操作員看到的標記是 (原列, 修訂們) 的 fold（`lib/markerFold.ts`）。復原就是再修一次。

排序上有個坑值得記住：fold **不能**用 Timeline 的 `eventCompare`（當時），因為牆鐘時間會在 NTP
校正時回跳，而「最後一次修訂勝出」必須指寫入順序。後來 #30 把那個比較器的死碼修掉並抽成
`lib/eventOrder.ts`，兩邊現在共用同一份。

**8a — 撤回為什麼不重掃。** 語料大半在 logged 層，30 天後被 retention 清掉。重掃式的撤回會讓
那些違規永遠掛著，因為來源列已經不在了。所以撤回是從**違規紀錄**本身算的。另外三個必須知道的：
- `in_scope` 判定也寫成 `system.scope_violation` 列（遵循度統計需要正面證據），**不能**算成既有
  違規，否則新排除的主機會變成「改判」而不是「新標」。
- 候選目標用 SQL 依 live 路徑的方式推導，**不是 `target_id`**——DNS producer 存的是帶結尾點的
  FQDN，當初判定的是去點形式，而網域比對是精確比對。
- 寫入包在單一 transaction 裡，catch 必須先 `invalidateChainHeadCache()`：`insertEvent` 每次成功
  INSERT 就推進快取、只在該次 INSERT 失敗時重置，所以其他原因造成的 rollback 會讓下一筆插入接到
  一個不存在的列上。

**9b — 每個寬鬆版都會讓某一頁說謊。** 這是整個功能真正的工作量所在：
- 「證據」不能定義成「非 housekeeping」。alert runtime 每次開專案就啟動、IP policy 無條件送出第一
  筆判定（離線也送），所以幾秒內就有一筆非 housekeeping 的上鏈列——首次執行畫面會自己消失。用正面
  述詞 `EVIDENCE_SQL`；`HOUSEKEEPING_SQL` 刻意不擴大，因為 Timeline 鏡像它、那筆判定該留在時間軸上。
- 「目標」只算**指令**推導出的目標。proxy addon 對每筆 HTTP／DNS、連線監控對每個 socket 都會蓋
  `target_id`，跨型別去算的話開一次瀏覽器就解鎖兩頁。
- HTTP 等 logged 層的流量（那頁只查 logged 層）；標記等書籤列，不是 `marker` 事件。
- 首次執行畫面必須**閂鎖**：直接讀「還沒有資料」的話，第一列進來的瞬間畫面就被卸載，而那正是它
  要讓人看到的一刻。這是 e2e 抓到的。

---

## 還開著的事

按「接手時的價值 ÷ 風險」排序。每一項都寫清楚為什麼還沒做。

### 1. 內部識別字改名（書籤）— 中等，機械性，有外部契約風險

#32 只改了使用者可見的一半。程式碼裡仍是舊名：

| 現在 | 應為 | 需要別名嗎 |
|---|---|---|
| `src/core/db/findings.ts` · `QuickMark` 型別 | `bookmarks.ts` · `Bookmark` | 否，純內部 |
| `src/renderer/src/components/FindingsView.tsx` | `BookmarksView.tsx` | 否 |
| `quickmarks:*` IPC 頻道 + preload bridge | `bookmarks:*` | 否，前後端同時改 |
| `GET|POST /api/quickmarks` | `/api/bookmarks` | **是**，舊路由要保留 |
| CLI `quickmark` / `quickmarks` 動詞 | `bookmark` | **是** |
| 外掛能力字串 `read:findings` + `findings.list` | `read:bookmarks` | **是**，這串活在第三方 manifest 裡 |
| SQL 表名 `quickmarks` | `bookmarks` | **需要人決定**（見下） |

**為什麼還沒做**：三個外部契約（REST、CLI、外掛能力）要連別名一起改才不會弄壞已安裝的整合，
而那和 #32 的行為變更（移出證據包）混在同一個 PR 裡會讓兩者都難 review。

**SQL 表名要人決定**：`ALTER TABLE quickmarks RENAME TO bookmarks` 是既有 migration 區塊裡的一行，
但舊版本 RedLog 開啟已遷移的專案會找不到表、那頁變空。如果有混用版本的工作流程，就別改。

**現在有 typecheck 了**，這正是讓這種大範圍改名安全的守衛。

### 2. 書籤沒有保存期限清理 — 小，但裁決之後更該做

`src/core/retention.ts` 會清 casts、screenshots、agent 逐字稿、http bodies 與 `events_logged`，
但 `quickmark` 這個字在裡面出現 **0 次**。

一個存著貼上憑證與擷取到的外部 IP（`quickmarks:create` 會注入 `alertRuntime.ipStatus().externalIP`）
的私人便條本永久留存，在「它只是便條本、不是紀錄」這個裁決之後**更**站不住腳，不是更站得住。
沒有 keep-days，也沒有任何清理路徑。

### 3. `redlog-verify.py` 從不檢查 `manifest["files"]` — 結構性的洞

驗證器只走事件鏈。`manifest.json` 列的每個檔案都有 SHA-256，但驗證器從不重算它們，所以
`screenshots/`、`casts/`、`chain_anchors.json`、`operators.json` 全都是「列在 manifest 但從不檢查」。

`quickmarks.json` 是其中最尖銳的一例——它是唯一連對應鏈上紀錄都沒有的條目——#32 移掉了那一例，
**洞還在**。收件人拿到證據包，無法察覺截圖或錄影被換掉。

### 4. `SPEC-SCOPE-AWARE-LIFECYCLE.md` 的規格尚未實作

#30 改寫了它那段「✅ shipped」的假宣告（點名的模組一個都不存在），但規格本身仍然成立：
scope-aware sanitize 與 artifact rotation 都還沒做。文件現在誠實了，東西還沒有。

### 5. 設計專案已知、但仍是單向的部分

`github.md` 已回寫（見 `design-project-sync.md` 2026-09-04），但設計專案的
`docs/UIUX-STANDARD.md` **刻意沒有被覆寫**——那份 22 節是著作處，整份寫回會蓋掉設計側內容。
repo 這份是它的鏡像加實作狀態註記。要改規範本身，去設計專案改，再同步回來。

### 6. `env.d.ts` 仍是手抄的 preload 鏡像

#31 把它補正了，但它仍會漂。真正的修法是讓它推導自 preload（`typeof api`），這樣漂移不可能發生；
代價是 `env.d.ts` 會從 global script 變成 module，連帶影響每個裸用 `ProjectMeta` / `HookInfo` 等
全域型別的檔案。屬於另一次重構。

---

## 這個 codebase 會咬人的地方

接手前讀完這一節，可以省下我這輪踩過的每一個坑。

### native module 的 ABI 陷阱

`better-sqlite3` 是原生模組，**vitest 需要 Node ABI，e2e 需要 Electron ABI**。切換：

```bash
npx electron-rebuild -f -w better-sqlite3   # 換成 Electron ABI（跑 e2e 前）
npm rebuild better-sqlite3                  # 換回 Node ABI（跑 unit 前）
```

忘了換回來的症狀是 **unit 測試整批 skip 而不是失敗**——DB 相關的 suite 用
`describe.skipIf(!available)` 保護。看到 `Tests 8 skipped (8)` 就是這件事。

那個保護的正確寫法在 `test/cast-index.test.ts:11-21`：**必須 `new Database(':memory:')` 探測**，
只 import 是不夠的（binding 是延遲載入的，import-only 的守衛會回報「可用」然後在被測模組內部炸掉）。

### TDZ：只在打包後才出現的崩潰

React hook 的 dep array 在 render 時求值。一個 hook 若引用**宣告在它下面**的 `const`，在
esbuild 打包後會是 temporal-dead-zone 崩潰——而 **vitest 看不到**，因為它是逐檔轉譯原始碼。

這個 codebase 已經被咬過**三次**（`TargetView` 的 listNav、`Timeline` 的 `collapsedBands`、
`App` 的 visibility memo）。相關檔案裡都寫了契約註解，照著擺：`Timeline.tsx` 的 fold memo 在
`effectsById` 之後、`badgesById` 之前，`App.tsx` 的 visibility memo 緊接狀態區。

**e2e 是唯一的守衛。** 動過 Timeline.tsx 或 App.tsx 的 hook 順序就跑 `npm run build && npm run e2e`。

### 兩層事件表

`events`（上鏈）與 `events_logged`（支撐證據，30 天後清）。`classifyTier` 決定去哪一張，
未列出的 pair 預設 chained。**任何 join 或聚合都必須考慮兩張表**——語料大半在 logged 層
（所有 HTTP、DNS、browser console、agent thinking）。

已知的例外：`searchEvents` 只查 `events`。這是既有行為，不是這輪造成的。

### 腳本化編輯要 assert

我這輪犯過一次：一個 `s.replace(old, new)` 的錨點不符、靜默跳過，害 `scopeSignalFor` 的 import
沒落地。dispatch 在 insert 之前，所以**任何帶目標的 shell POST 都會 500,連事件都沒寫進去**——
擷取靜默停掉，三個 commit 後才被 e2e 抓到。

現在有 typecheck 會接住這一類。但仍然：批次編輯後，grep 一下該編輯應該引入的識別字。

### 不要對正在編輯的檔案下 `git checkout --`

它會還原到 HEAD，包含未提交的工作。我用它撤銷一行故意改壞的測試，連帶清掉了同一個檔案裡
一小時的改動。

### 從原始碼解析的守衛測試

這個 repo 有一批測試是讀 `.ts` 原始碼、用 regex 斷言規則的（`design-tokens`、`lane-colours`、
`buttons`、`truncation`、`danger-not-on-numbers`、`list-keyboard`、`i18n-keys`、
`housekeeping-parity`、`redaction-boundary`、`typecheck-guard`）。改 UI 前先看它們要什麼。

兩個容易忘的：**截斷的 span 一定要有 `title`**；**危險紅絕不出現在數字上**（`tabular-nums` 與
danger 類名不能出現在同一個 className）。

### i18n 掃描器看不到動態鍵

`test/i18n-keys.test.ts` 只掃字面 `t('a.b')`。用變數組出來的鍵它看不到——`sidebar.http_history`
就是這樣漏掉的，那個鍵兩本語言檔都沒有，直接把鍵名印給操作員。

掃描器現在也認 `reasonKey: 'a.b'` 字面值。再有這種模式，記得一起加進去。

---

## 已關閉的方向

**PR #8「時間軸重建軸線」** 已關閉未合併，分支封存為 tag `archive/ux-design-and-tickets`。
47 個 commit 沒有進 main。

關的理由是**方向不同，不是過期**：它的核心動作是換掉泳道模型並刪除 `TargetView.tsx`，而 main
後來出貨的目標聚焦（`47cc2ef`）、18 泳道分帶（`183b9ac`）與 §22 漸進揭露都建立在那兩樣東西上——
§22 更是把「目標」當成一個依資料揭露的頁面，而不是要移除的頁面。

要回頭撿：

```bash
git checkout -b revive archive/ux-design-and-tickets
git cherry -v main archive/ux-design-and-tickets | grep '^+'
```
