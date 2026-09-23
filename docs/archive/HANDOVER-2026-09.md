# 交接 — 2026-09-04

這一輪從「設計專案與 repo 對帳」開始，做完了設計稿 turn 8–9 的五項提案，順帶清掉一批既有缺陷。
九個 PR（#25–#33）已併入 `main`，之後又換掉了整組標誌（`feat/new-mark`）。

這份文件寫的是**接手的人需要知道、但從 diff 看不出來的事**：每個決定的理由、還開著什麼、
以及這個 codebase 有哪些會咬人的地方。規範本身在 [`UIUX-STANDARD.md`](../UIUX-STANDARD.md)，
設計專案往返記錄在 [`design-project-sync.md`](../design-project-sync.md)。

---

## 現在的狀態

```
main · v0.14.3
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

目前基準：typecheck 乾淨 · unit **1087 passed (99 files)** · e2e **89 passed, 1 skipped**。
圖示另外有一個不進 CI 的檢查（要 `rsvg-convert`）：`python3 tools/make-icons.py --check`。
CI 擋得住的部分在 `test/mark-assets.test.ts`，它讀的是磁碟上的位元組。

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
| #33 | 這份交接 | — |
| — | **換標** | 規範說舊標「已被取代」說了八個月，出貨的圖示一直都還是舊的 |

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

### 7. §4 的單一字標仍未實作

第三期檢查表把「單一字標 `REDL(●)G` 取代『R 方塊 + REDLOG』並列」打勾了，但標題列
（`App.tsx`）與 Project Picker 兩處都還是「圖片 + 純文字 REDLOG」，而且那串字用的是
`text-red-500`（tailwind 設定裡是 `#cf5459`），不是規範要的 `#d75f63`。勾已改回未勾。

**為什麼還沒做**：那是一個新元件——環要以 em 表示、`box-sizing: border-box`、隨字級縮放，
還要換掉兩個畫面的識別區塊。跟換標同一個 PR 做會讓兩邊都難 review。換標這輪只把**圖片**
換成新標，圖片本身在字標落地後會整個消失。

### 8. Linux 只拿到一張 256px 圖示

`electron-builder.yml` 的 `linux.icon` 指向單一 PNG。要給 Linux 真正的多尺寸圖示集，
它得指向一個**目錄**，裡面的檔名是 `<N>.png` 或 `<N>x<N>.png`——`icon-256.png` 不符合那個規則。
每個 panel／launcher 都會自己把 256 縮下去，正是 `RING_MIN_PX` 要避免的糊法。

**為什麼還沒做**：得多開一個目錄放同樣的 PNG 副本，而 Linux 目前根本不在 release CI 的建置與
上傳清單裡——那條路徑從來沒產出過 artifact。先量再修。

### 9. `extraResources` 指向一個不存在的目錄

`electron-builder.yml` 有 `- from: mcp`，但 `mcp/` 在 `ddc2606`（2026-08-23）就被刪了，沒有任何建置步驟會重建它。每次打包都會印一行
「file source doesn't exist」警告。這比換標早很多，換標只是又碰了同一個檔。
移掉那一行是包裝行為的變更（等於宣告不再隨 app 出貨 stdio MCP bridge），要人決定。

### 10. 三處寫死的 `#0a0a0a` 是換色之前的視窗底色

`src/main/windows.ts` 的 `backgroundColor` 與 Windows `titleBarOverlay.color` 都寫死 `#0a0a0a`，
但 tokens 早就把視窗底色改成 `#121214`（`tailwind.config.js` 裡那段註解就在講這次換色）。
後果：載入時會閃一下比較暗的底，而 Windows 上那條原生標題列色帶跟它旁邊的標題列**永遠**差一階。
（Project Picker 也有同一個字面值，這次順手改掉了，因為新標的切角是透明的、看得出來。）

**為什麼沒一起改**：那是配色修正，不是換標。混進同一個 PR 會讓兩件事都難 review——
這正是換標本身被拆成獨立 PR 的理由。

### 11. 八個守衛測試 import 一個沒宣告的相依

`fast-glob` 出現在八個 source-scanning 守衛測試裡，但 `package.json` 從頭到尾沒有它——
它能 resolve 只是因為 tailwindcss 把它 hoist 到了 `node_modules` 根目錄。
Tailwind 一升版或 hoisting 一變，這一整族守衛會同時紅掉，而且錯誤訊息會指向 import 而不是原因。
把它加進 `devDependencies` 就好。


---

## 這個 codebase 會咬人的地方

仍然有效，已搬到 [ARCHITECTURE.md](../ARCHITECTURE.md#這個-codebase-會咬人的地方)（2026-09-23）。

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
