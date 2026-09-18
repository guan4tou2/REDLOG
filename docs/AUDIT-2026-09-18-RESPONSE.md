# 2026-09-18 稽核報告回應與修復紀錄

本文件對應 [`AUDIT-2026-09-18-app-ai-log.md`](./AUDIT-2026-09-18-app-ai-log.md)，記錄已完成的修復、尚未處理的項目分析，以及對「非工作內容或目標資訊」的改善建議。

修復分支：`fix/audit-2026-09-18-findings`
PR：https://github.com/guan4tou2/REDLOG/pull/114

---

## 一、已完成修復

### Commit 1 — 四大優先項 (`3f34324`)

原始稽核報告中的首批結構性問題。

### Commit 2 — P0 安全修復 (`011a99d`)

| 項目 | 修復內容 |
|------|----------|
| Sidecar cursor 解耦 | sidecar 寫入與 JSONL 讀取位置分離，cursor 基於已完成解析單位 |
| 檔案權限 | sidecar 建立時設定 0o600 |
| Redaction 擴充 | 新增 Slack、npm、HuggingFace、Google OAuth、URI credentials、Base64 key pattern |

### Commit 3 — P1 修復 (`e23b789`)

| 項目 | 修復內容 |
|------|----------|
| Incremental SHA-256 | `runningHash: crypto.Hash` 取代每次全檔 `fileSha256`，O(1) snapshot hashing |
| WebFetch URL 掃描 | `WebFetch` redaction 欄位從 `['prompt']` 擴充至 `['prompt', 'url']` |
| `.bak` 清理 | `retention.ts` agent-transcripts sweep 現在也清理 `.bak` 檔案 |

### Commit 4 — P2 修復 (`e6fdd75`)

| 項目 | 修復內容 |
|------|----------|
| P2-1 chokidar regex | `ignored` 從 statSync 回呼改為正規表示式，消除 TOCTOU |
| P2-2 transcript_uuid 反正規化 | `events` 表新增 `transcript_uuid` 欄位 + 部分索引；`buildSeedIndex` 不再 `json_extract` 全表掃描 |
| P2-3 refusal/permission 擷取 | 擷取 `model_refusal`、`api_error`、`toolDenialKind`、`toolResultRemedy` |
| P2-4 token usage 擴充 | `cache_creation`、`cache_read`、`thinking_tokens`、`service_tier`、`stop_reason`、`imageBlockCount` |
| P2-5 write coalescing | watcher change handler 50ms debounce，合併高頻 chokidar 事件 |
| P2-6 drift per-type | `driftAdvisoryFired` 從 `boolean` 改為 `Set<string>`；控制字元清洗 |
| P2-7 multi-tool 測試 | 新增 3 個測試案例（2 tool_use、2 tool_result、單一非陣列）|

### Commit 5 — 補充核對 6 項 (`2e8151b`)

| # | 報告原文 | 修復方式 | 檔案 |
|---|---------|---------|------|
| 1 | tool result 可能配錯 session | `pendingTool` key 改為 `${session_id}:${tool_use_id}` 複合鍵 | `TranscriptView.tsx` |
| 2 | 未知 exit status 顯示成功 | `d.exit_code` 為 null/undefined 時顯示 `exit unknown` | `TranscriptView.tsx` |
| 3 | 已中斷 AI 工具仍顯示 pending | `buildBlocks` 新增 `tool_interrupted` 處理，標記 `outputNote: 'interrupted'` | `TranscriptView.tsx` |
| 4 | 複製 Markdown 靜默截斷 | 超過 `MAX_INLINE` 時附加 `[truncated — X total]` 標記 | `TranscriptView.tsx` |
| 5 | session registry 跨專案殘留 | `stopHost()` 新增 `sessionRegistry.clear()` | `tailer-host.ts` |
| 6 | DB error 60 秒後自動消失 | 新增 `dbErrorTotal` 累計計數 + `dbErrorFirstAt` 首次錯誤時間戳，分離「目前可寫入」與「曾有缺口」 | `capture-health.ts` |

### Commit 7 — 暫停語意與專案歸屬

| 項目 | 修復內容 | 檔案 |
|------|----------|------|
| 離線 spool 專案歸屬 | hooks 產生 spool 時嵌入 `_identity`（來自 `active-identity.json`）；replay 時比對身分，不符標記 `spool_attribution: 'mismatched'`，無身分標記 `'unattributed'` | `main/index.ts`, `shell-preexec-hook.sh`, `shell-hook.ps1`, `mitmproxy-addon.py`, `pcap-agent.py` |
| AI 暫停期間補收 | `SessionState` 新增 `pauseSkippedLines` / `pauseStartedAt`；暫停時消耗但不處理行數；恢復時發出 `capture_gap` 系統事件 | `tailer-host.ts` |
| 暫停寫入終端 `.cast` | 已在 P1 中由 `eventBus.paused` gate 覆蓋 | *(先前 commit)* |
| 切換專案保留舊 terminal | 已在 P1 中由 `stopProject` finalization 覆蓋 | *(先前 commit)* |
| AI 來源縮短清空舊副本 | 已在 P1 中由 sidecar archive 覆蓋 | *(先前 commit)* |

---

## 二、尚未處理項目 — 分析與建議

### 2.1 暫停語意與專案歸屬 — ✅ 已完成

5 項子問題全數解決（見 Commit 7），其中 3 項在 P0/P1 先行修復。

### 2.2 AI 原始保存與解析 — ✅ 已完成

#### 2.2.1 半行 JSONL 重啟後漏解析

- **修復**：`registerSession` 時掃描 sidecar 尾部 64 KB，truncate 到最後一個 `\n` 邊界。重啟後不完整的半行從 source 重新讀取並與新資料合併。Hash 從 truncated sidecar 重新 seed，保持一致性。
- **檔案**：`tailer-host.ts`

#### 2.2.2 Transcript UI 先取 2,000 筆混合所有種類

- **修復**：`TranscriptView.load()` 改為 per-type balanced query（agent 800 / shell 400 / scanner 300 / system 200 / marker 100 / loot 100 / pivot 100），`Promise.all` 並行查詢後 dedup + 時間排序合併。AI 對話事件不再被 HTTP 事件擠出。
- **檔案**：`TranscriptView.tsx`

### 2.3 搜尋、篩選與匯出

| # | 問題 | 建議做法 |
|---|------|---------|
| 1 | 類型 filter 由 200 筆結果產生 | 從 DB 直接查詢 `DISTINCT agent_type` 建立固定 facets |
| 2 | 空結果時清除入口消失 | 搜尋列常駐顯示已套條件與清除按鈕 |
| 3 | 搜尋沒有非同步請求序號保護 | AbortController + request serial number，只接受最後一筆 |
| 4 | 證據包成功後 UI 顯示失敗 | 統一 `ExportMenu` / `data-export.ts` 回傳型別（`zipPath` vs `outDir`）|
| 5 | 全部匯出只取 100,000 筆 | 分頁串流匯出，完成後核對筆數，標示是否為完整 |
| 6 | 外部 HTTP body 沒一起交付 | `bundle-export.ts` 依事件收集 `http-bodies/` refs，打包後檢查缺檔 |
| 7 | 非標的 body 物件未遮蔽 | `scope-sanitize.ts` 擴充處理結構化 / base64 body |
| 8 | 附件與文字 scope 政策不一致 | 交付前可排除附件；無法判定歸屬者明示「未分類」 |

### 2.4 UI/UX 最小改善

報告建議的操作路徑：選專案 → 確認記錄中 → 找事件 → 看細節 → 確認交付 → 匯出

- **狀態區分**：未啟用 / 等待資料 / 記錄中 / 暫停 / 錯誤 — 目前 capture-health 已有 verdict，需在 UI 顯示最後收到資料時間
- **共用篩選**：搜尋 / HTTP / AI 使用一致的時間、目標、來源篩選
- **匯出確認頁**：顯示條件、事件數、附件選擇、遮蔽政策

---

## 三、非工作內容與目標資訊 — 做法與改善建議

### 3.1 統一流量擷取與 Proxy/SOCKS 配置

**問題**：稽核報告「擷取涵蓋」提到多種流量類型（HTTP、DNS、WebSocket、TCP/UDP），是否設定統一 proxy 就不需要特別處理？

**分析**：

設定 `http_proxy` / `https_proxy` 或 SOCKS proxy 讓工具流量走 mitmproxy **可以覆蓋大部分 HTTP(S) 流量**，但以下邊界仍需注意：

| 邊界 | 說明 | 建議 |
|------|------|------|
| Certificate pinning | 部分工具（curl with --pinnedpubkey、某些 Go binary）會拒絕 mitmproxy CA | 需逐工具測試；記錄哪些工具已驗證可走 proxy |
| 不走系統 proxy 的工具 | Electron app、某些 Go binary 不讀環境變數 | 逐一設定 `HTTP_PROXY` 或用 iptables/pf 透明重導 |
| HTTP/3 (QUIC) | mitmproxy 目前只部分支援 HTTP/3 | 可透過防火牆阻擋 UDP/443 迫使降級為 HTTP/2 |
| gRPC / WebSocket 長連線 | mitmproxy 可攔截但解析深度有限 | 記錄「已擷取但未完整解析」的狀態 |
| DNS-over-HTTPS / TLS | 繞過 mitmproxy 的 DNS 模式 | 在 proxy 層阻擋，或另開 mitmproxy DNS 模式 |
| 非 HTTP 流量（TCP/UDP） | proxy 無法處理原始 TCP/UDP | 需要 pcap / 透明代理 / 專用擷取插件 |
| 本機流量（127.0.0.1） | 很多 proxy 設定排除 localhost | 確認 `NO_PROXY` 不包含需要監控的本地服務 |

**建議做法**：

1. **建立擷取涵蓋矩陣**：在 `docs/` 或 Settings UI 列出每種流量類型的擷取狀態（已驗證 / 部分 / 未覆蓋）
2. **在 capture-health 顯示 proxy 狀態**：偵測 `HTTP_PROXY` / `HTTPS_PROXY` 環境變數是否設定
3. **不宣稱「全部抓到」**：RedLog 用來源狀態與缺口資訊表達涵蓋度

### 3.2 hash/簽章的正確邊界

稽核報告強調：**hash / 驗章可協助檢查已保存資料的完整性，不能證明所有來源都被擷取，也不能證明來源所描述的行為確實發生。**

- 產品用語需避免暗示「chain verified = 完整保存所有操作」
- 在匯出報告和 UI 中明確標示涵蓋範圍和已知缺口
- RedLog 的定位是「統一紀錄入口」，不是「完整保存證明」

### 3.3 AI 工具結果的正確解讀

報告補充核對第 1-3 項提到的根本問題：

- **AI 說成功不等於工具執行成功**
- **工具結果也不等於外部目標一定發生預期效果**
- **「尚未收到結果」和「仍在執行」是不同狀態**

這些不是程式缺陷而是語意設計。建議：

- Transcript UI 對 tool 結果加入 disclaimner：「此為 AI agent 回報的工具輸出，不代表外部系統實際狀態」
- 時間軸對長時間 pending 的 tool call 顯示「⏳ 未收到結果」而非什麼都不顯示
- 匯出時在 metadata 標記哪些事件來自 AI agent 自我報告

### 3.4 Scope 政策的語意澄清

報告指出：目前 scope 是「保留 metadata、遮蔽部分內容」，不是「整筆非標的事件排除」。

- command、URL query、headers、cookies **可能含內容或秘密**
- 是否保留需要明確的交付政策選擇
- 無 target / 未設定 scope 應標「未分類」，不代表 in-scope
- 原始證據保存與對外交付衍生副本應保持分離

### 3.5 建議執行順序

依稽核報告建議，剩餘工作分四階段：

1. **暫停語意與專案歸屬**（§2.1）— 跨子系統政策統一，風險最高
2. **AI 原始保存與解析**（§2.2）— transcript checkpoint + UI 分頁
3. **交付正確性**（§2.3）— 搜尋/匯出 8 項修正
4. **共用 filter + UI 驗收**（§2.4）— 最後收尾

不建議此階段增加協查案件管理、清理任務追蹤、SIEM 規則平台或 agent 編排。

---

## 四、驗證狀態

- TypeScript 編譯：零錯誤（`npx tsc --noEmit` 通過）
- 測試：55 tests passed（agent-transcript-tailer 27 + retention 21 + secret-redaction 7）
- 分支共 5 個 commit：原始四項 → P0 → P1 → P2 → 補充核對 6 項
- 尚未完成實機 UI 驗收（稽核報告明示需要新版桌面與窄視窗操作驗收）
