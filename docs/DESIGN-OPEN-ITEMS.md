# 開放項目設計

寫於 2026-09-06。把 [`HANDOVER-2026-09.md`](HANDOVER-2026-09.md) 的「還開著的事」與這幾輪
審視新發現的項目,各自寫成**可執行的設計**:問題、決定、步驟、外部契約衝擊、狀態。

**每一項都標狀態,且預設是「設計/未實作」。** 這個 repo 有 spec 宣稱出貨卻沒實作的漂移前例
(`SPEC-SCOPE-AWARE-LIFECYCLE.md` 曾點名不存在的模組),所以這份文件的規則是:**沒實作就
大字寫「未實作」,實作了就把該節搬進對應的實作文件並在這裡標「已實作 → 見 X」。** 這份不是
願景,是工作清單。

排序在最後一節。先做的是「有隱私/安全後果」的,再做「會漂的」,最後做「純外觀」。

---

## 1. 書籤 retention 清理 — 小,隱私後果,先做

**狀態:已實作 → 見 PR #36。** `config.retention.bookmarks.keepDays`、`deleteBookmarksOlderThan`、`sweepBookmarks` + `system.bookmarks_pruned` 稽核列已落地,下方為原始設計存查。

**問題。** `src/core/retention.ts` 會清 casts、screenshots、agent 逐字稿、http bodies、
`events_logged`,但 `quickmark` 這個字在裡面出現 **0 次**。書籤(quickmarks)會注入貼上的
憑證與 `alertRuntime.ipStatus().externalIP`(擷取到的外部 IP),永久留存。在「書籤只是便條本、
不是紀錄」的裁決(PR #32)之後,永久留存**更**站不住腳。

**決定。** 加一條 `sweepBookmarks`,與既有 sweep 同形狀:config 有 `retention.bookmarks.keepDays`
(預設 0 = 永久,與其他 keep-days 一致,不改既有行為),>0 時每次開專案掃、刪超過天數的列。
書籤不上鏈,所以刪除不需要 `*_pruned` 上鏈事件——但**要寫一筆 `system.bookmarks_pruned`
稽核列**(數量,不含內容),因為「一批便條消失」該可解釋。

**步驟。**
1. `config.ts`:`retention.bookmarks.keepDays?: number`,預設段補 `bookmarks: { keepDays: 0 }`。
2. `db/findings.ts`:加 `deleteBookmarksOlderThan(cutoffMs): number`(純 SQL DELETE + count)。
3. `retention.ts`:`sweepBookmarks(cfg, ids)`,回傳刪除數;`startProject` 在 `sweepRetention`
   之後呼叫,>0 時 `insertEvent('system', { subtype: 'bookmarks_pruned', count })`。
4. 測試:`test/retention.test.ts` 加一例(seed 舊/新書籤、掃、斷言只刪舊的 + 稽核列)。

**契約衝擊。** 無。純新增,預設關。

---

## 2. 每專案 token 隔離 — 小,安全,誠實看待價值

**狀態:已實作 → 見 PR #36。** 每專案 token + 全域 `~/.redlog/api-token` 鏡像已落地。價值中低的分析仍成立,存查於下。

**問題。** token 是全域一份(`~/.redlog/api-token`),跨所有專案共用。多客戶交戰用同一把
secret。

**先講清楚它其實買到什麼。** RedLog 同一時間只服務**一個**開啟中的專案(`projectOpen` 閘,
`onApiProjectOpen/Close`),沒開專案時每條非 health route 回 503。所以「並發隔離」這個直覺其實
不成立——你無法在專案 A 開著時查專案 B。每專案 token 真正買到的只是**每場交戰換一把 secret**
(降低 token 外洩的橫向影響、交戰結束可作廢),不是並發隔離。因此這是安全衛生,不是關鍵洞。

**決定。** 每專案一把 token,寫在 `~/.redlog/projects/<id>/api-token`(0600),開專案時載入為
current primary token;全域 `~/.redlog/api-token` 保留為「當前開啟專案的 token」的鏡像,讓現有
hook/CLI 不改也能運作(它們每次呼叫都讀檔,所以切專案自動換 token 生效)。

**步驟。**
1. `project-manager.ts`:建專案時產生並寫入 per-project token;`openProject` 載入它。
2. `api-server.ts`:`writePrimaryToken` 改成「若專案有 token 檔則用之,否則產生並寫回」;
   同時鏡像到全域 `~/.redlog/api-token`(現有 hook 讀這裡)。
3. operator 綁定:primary operator 的 `token_hash` 隨專案 token 走(每專案 operators 表本來就
   獨立,因為 DB 是 per-project)。
4. 測試:兩個專案各自的 token 不同;用 A 的 token 打 B(切換後)被 401。

**契約衝擊。** hook/CLI 讀 `~/.redlog/api-token`,鏡像保留 → **不破**。若日後想拿掉全域鏡像,
才會動到 hook,屆時要別名期。

---

## 3. Scope-aware sanitize + artifact rotation — 中大,證據性

**狀態:已實作。** (a) 匯出時的 scope-aware sanitize → 見 PR #36(`scope-sanitize.ts`、`bundle-export` 的 `maskOutOfScope` + manifest `sanitizedOutOfScope`)。(b) artifact rotation 依範圍排序 → 見 PR #43:`retention.ts` `sweepArtifactStore`(casts/screenshots 各有 store 位元組預算 `terminal.castStoreMaxBytes` / `screenshots.maxBytes`,超標時 out-of-scope 的先淘汰、in-scope 的 pin 住,`cast_evicted`/`screenshot_evicted` 稽核 + Timeline「evidence removed」徽章)。取代 `SPEC-SCOPE-AWARE-LIFECYCLE.md`(該 spec 的宣稱已於 2026-09-04 更正為「未實作」,規格本身仍成立)。

**問題。** 兩件事沒做:(a) 匯出時的 sanitize 目前是全域 allow/deny + entropy,不看**範圍**——
一個明確標為 out-of-scope 的主機,它的 body 與截圖不會因為出範圍而被優先遮蔽或排除;(b)
artifact(bodies、casts、screenshots)的輪替只看時間/大小,不看範圍——in-scope 的證據和
out-of-scope 的無關資料同等對待。

**決定。**
- **Sanitize 讀範圍。** 匯出 sanitize 時,對 `target_id` 落在 `excludeTargets` 或明確 out-of-scope
  的事件,其 body/preview 欄位預設遮蔽(可覆寫),並在 manifest 記 `sanitized_out_of_scope: N`。
  這把「抓完整、匯出才 sanitize」的既有立場,補上「範圍」這個維度。
- **Rotation 保留 in-scope。** body-eviction 已經有「in-scope 的 body 永不淘汰(pin)」的雛形
  (`sweepBodyStore` 的 pin 就是 scope)。把同一條規則延伸到 casts/screenshots:輪替時
  out-of-scope 的先淘汰,in-scope 的後淘汰。

**步驟。**
1. `sanitize.ts`:加一個 scope-aware 判定(讀 `config.scope` + 事件 `target_id`),對 out-of-scope
   事件的敏感欄位標為預設遮蔽;`bundle-export.ts` 匯出時套用並在 manifest 記數。
2. `retention.ts`:`sweepBodyStore` 的 scope-pin 抽成共用判定,`sweep casts/screenshots` 也吃它。
3. 測試:seed in/out-of-scope 事件 + artifact,斷言匯出遮蔽了 out-of-scope 的、rotation 先刪
   out-of-scope 的、in-scope 的留著。

**契約衝擊。** 匯出內容改變(out-of-scope 預設遮蔽)——這是**行為變更**,要在 CHANGELOG 明說,
並提供「不依範圍遮蔽」的覆寫,免得既有流程的匯出突然變樣。

---

## 4. `env.d.ts` 推導自 preload — 中,防漂

**狀態:已實作 → 見 PR #37。** `env.d.ts` 已改為 `typeof api` 推導,preload 具名 export `api: RedLogAPI`。下方設計存查。

**問題。** `src/renderer/src/env.d.ts`(405 行)手抄 preload 的 `window.redlog` 契約,24 namespace、
約 100 method,會漂(交接文件與審計都記過)。#31 補正過一次,但手抄的本質沒變。

**決定。** 讓型別**推導自 preload 的實際 `api` 物件**,漂移在型別層就不可能發生。preload 目前是
`contextBridge.exposeInMainWorld('redlog', api)`;把 `api` 具名 export,`env.d.ts` 改成
`type RedLog = typeof import('../../preload').api; interface Window { redlog: RedLog }`。

**代價(要知道)。** `env.d.ts` 會從 global script 變成 module,連帶影響每個裸用全域型別
(`ProjectMeta`、`HookInfo`、`RedLogEvent` 等)的檔案——它們得改成 import。這是一次性的機械改動,
但範圍廣,是它一直沒做的原因。建議獨立一個 PR,typecheck 當守衛。

**步驟。**
1. preload:`export const api = { ... }`(目前是內聯給 exposeInMainWorld)。
2. `env.d.ts`:刪手抄介面,改推導;保留純資料型別(`ProjectMeta` 等)或搬到 `src/core` 供兩端 import。
3. 修每個因 module 化而缺 import 的檔(typecheck 會逐一點名)。

**契約衝擊。** 純內部型別。無執行期改變。

---

## 5. 內部識別字改名 QuickMark → Bookmark — 中,機械性,有外部契約

**狀態:已實作 → 見 PR #40。** 內部改名(型別、IPC、component、SQL 表 `ALTER TABLE … RENAME`)與外部別名(`/api/bookmarks`、CLI `bookmark`、`read:bookmarks` + 舊路由/動詞/能力別名)皆落地。下方別名策略存查。

**問題。** 程式碼、IPC、REST、CLI、外掛能力字串仍是 `quickmark`/`findings`。

**決定與別名策略(逐項)。**

| 現在 | 應為 | 別名期 |
|---|---|---|
| `db/findings.ts` · `QuickMark` 型別、`FindingsView.tsx` | `bookmarks.ts` · `Bookmark`、`BookmarksView.tsx` | 否,純內部,前後端同時改 |
| `quickmarks:*` IPC + preload bridge | `bookmarks:*` | 否 |
| `GET\|POST /api/quickmarks` | `/api/bookmarks` | **是**,舊路由保留一段 |
| CLI `quickmark`/`quickmarks` 動詞 | `bookmark` | **是**,舊動詞保留 |
| 外掛能力 `read:findings` + `findings.list` | `read:bookmarks` | **是**,活在第三方 manifest 裡 |
| SQL 表名 `quickmarks` | `bookmarks` | **需人決定**(見下) |

**SQL 表名要人決定。** `ALTER TABLE quickmarks RENAME TO bookmarks` 是一行 migration,但舊版本
RedLog 開已遷移的專案會找不到表、那頁變空。若有混用版本的工作流程,**別改表名**,只改程式碼裡的
稱呼。這是唯一需要產品決定的點。

**步驟。** 分兩個 PR:(a) 純內部改名(型別、IPC、component、SQL 若決定改);(b) 外部契約改名 +
別名(REST、CLI、外掛能力)。typecheck 是這種大範圍改名的守衛(現在有了)。

**契約衝擊。** 三個外部契約,故要別名期;混同一 PR 會讓 review 很難。

---

## 6. §4 單一字標 `REDL(●)G` — 中,外觀

**狀態:已實作 → 見 PR #36。** `components/Wordmark.tsx`(即時文字、em 環、`#d75f63`、<16px 收成實心點)已取代圖片 + 純文字識別區塊。下方設計存查。

**決定。** 做一個即時文字元件(**不是 SVG**——規範 §16 明說手排向量字標壞過三處),環以 em 表示、
`box-sizing: border-box`、隨字級縮放:外徑 `0.72em`、環寬 `0.115em`、內點 `0.216em`、上移 `0.02em`,
16px 以下環收成實心點,顏色永遠 `#d75f63`。

**步驟。**
1. `components/Wordmark.tsx`:一個 `<span>REDL<span ring/>G</span>`,環用 em + border-box。
2. 換掉標題列(`App.tsx`)與 `ProjectPicker.tsx` 兩處的「圖片 + 純文字」識別區塊;字標落地後
   那張圖片整個消失。
3. 測試:`test/mark-assets.test.ts` 風格的幾何斷言(環外徑 = em、border-box)。

**契約衝擊。** 無。

---

## 7. Linux 多尺寸圖示 + 寫死的視窗底色 — 小,外觀/打包

**狀態:已實作 → 見 PR #36(視窗底色 + 圖示目錄)。殘留:Linux 是否真的進 release matrix 仍待量。** `windows.ts` 三處已改 `#121214`;`resources/icons/<N>x<N>.png` 已產出、`electron-builder.yml` `linux.icon` 指向目錄。但「Linux 進 release CI」尚未驗證(見 §7a 步驟 3),在確認前圖示是否真的出貨仍是先量再修。

**問題。** (a) `electron-builder.yml` `linux.icon: resources/icon-256.png` 是單張,每個 panel 自己縮糊
(正是 `RING_MIN_PX` 要避免的);(b) `src/main/windows.ts` 三處寫死 `#0a0a0a`(`backgroundColor`
+ Windows `titleBarOverlay.color`),但 tokens 早把視窗底改成 `#121214`,載入會閃一下暗底,Windows
原生標題列色帶永遠差一階。

**決定。** (a) `tools/make-icons.py` 產一個 `resources/icons/` 目錄,檔名 `<N>x<N>.png`,
`linux.icon` 指向目錄;先確認 Linux 真的進 release CI(目前那條路徑從沒產出 artifact,要先量再修)。
(b) `windows.ts` 三處 `#0a0a0a` → `#121214`,與 tokens 一致。

**步驟。**
1. `windows.ts`:改三處字面值(最小、可先做)。
2. `make-icons.py`:輸出 `icons/<N>x<N>.png`;`electron-builder.yml` `linux.icon` 指向目錄。
3. 確認 Linux 進 release matrix(否則這是先量再修)。

**契約衝擊。** 無。(b) 可以立刻做,(a) 依賴 Linux 是否真的出貨。

---

## 8. Plugin-kernel 完成路徑 — 大,架構(設計已在別處)

**狀態:地基已實作(PR #36),完整外掛化為設計。** 見 [`DESIGN-plugin-kernel.md`](DESIGN-plugin-kernel.md)。

已落地:`raw-store`、`mappers`、`ingest`、envelope 欄位、plugin 角色欄位、`/api/events` 與 PS
transcript 走 ingest。

**尚待設計/實作的完成路徑:**
1. **內建 target extractor 宣告化 + 外掛化(E1 Option A #41、Option B #44)已實作。** Option A 立起 `STRATEGIES` 註冊表 + 宣告式資料;Option B 把整張工具→策略表搬進 bundled pack `plugins/builtin-tools/plugin.json`,`target-extractor.ts` 不再有任何 per-tool 資料,啟動時 `initPlugins()` 經 `registerTargetExtractors` 註冊該 pack;precedence 以 source 決定(user 蓋 bundled)、載入順序在測試 setup 與啟動路徑都解掉、`plugins/` 加進 `extraResources` 才會隨包出貨(連帶修好 c2-tailers 從沒打包的舊漏)。停用該 pack 即移除內建。
2. **Starter pack 預裝。** 把 shell hook + 內建終端機 + 代理 tailer + mitmproxy 宣告成一包預裝、
   可移除的 producer 外掛,首次執行仍成立。
3. **pcap producer + 透明代理 + socket→pid→指令 對照器**(見 [`DESIGN-traffic-attribution.md`](DESIGN-traffic-attribution.md))。
   這三樣是**核心/producer**,不是加值外掛,因為它們決定「能不能記到」。
4. **manifest schemaVersion 雙版本讀取** + 擷取健康度改讀 manifest 而非寫死清單。

排序見那份文件的 §5。**紅線不變:不做報告產出、不做多人中央架構。**

---

## 排序(價值 ÷ 風險)

原始九項中的 §1、§2、§4、§5、§6、§7(視窗底色+圖示)、§8-1(E1 Option A)已於
2026-09-06 隨 PR #36/#37/#40/#41 出貨並在上方各節標「已實作 → 見 X」。**還開著的殘留:**

| 順位 | 項目 | 大小 | 為何這個順位 / 卡在哪 |
|---|---|---|---|
| 1 | Linux 進 release matrix(§7a) | S | 圖示已產出,但 Linux 是否真的出 artifact 未量,先量再修 |
| 2 | Plugin-kernel 完成路徑(§8-2/3/4) | L | starter pack 預裝、pcap/透明代理/socket→pid 對照、manifest 雙版本讀取 |

每一項落地後,把對應節改標「已實作 → 見 X」並把設計搬進實作文件,別讓這份變成下一個
「看起來要做、其實沒做」的漂移源。
