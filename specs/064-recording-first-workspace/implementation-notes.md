# 現況、範圍收斂與後續切法

**Status**: Draft · implementation in progress · 2026-10-26。
隔離候選已開始 S1／S2 的核心修正；尚未替換主導覽或發布。進度與候選證據見 [verification.md](verification.md)，不能把局部通過當成整份規格完成。

## 1. 依據與版本界線

- 靜態程式碼基準：`4d528ba588ecb0f5c90c1c99ff70b6c72f897ed5`，對應使用者本次審查版本；不宣稱這是之後所有時間的最新遠端。
- 本地工作樹：`codex/first-use-recording-guidance`。此處另有尚未提交的接入、AI 及 Spec 063 修正；本次規格不能將它們當成已合 main／已發版。
- 使用者提供四份文件：Timeline 項目精簡、移除泳道、完整 I/O 閱讀、全面 UI/UX 與產品設計審查，以及對話中的搜尋／設定整併建議。後續收斂優先於早期示意。
- 已讀取 [#317](https://github.com/guan4tou2/REDLOG/issues/317)、[#290](https://github.com/guan4tou2/REDLOG/issues/290)、[#291](https://github.com/guan4tou2/REDLOG/issues/291)、[#292](https://github.com/guan4tou2/REDLOG/issues/292)、[#296](https://github.com/guan4tou2/REDLOG/issues/296) 本文。這些本次仍開啟；本規格不關閉或重複建立工單。
- 公開工單 #317 的已確認原則仍適用：外部終端優先、網頁 Scope 不丟指令、證據包／HAR 主路徑、敏感來源 opt-in、紀錄／接入／交付優先於時間軸大改。

## 2. 已解決的設計衝突

| 先前不同提議 | 本規格決定 |
| --- | --- |
| 保留十八泳道，或移除泳道 | 目標改為單一 Activity Log；十八種原始來源／事件語意不因此刪除。 |
| 五頁就算簡化 | 五主入口是目標；I/O、Session、索引搜尋、證據找回與交付對等才是切換 gate。 |
| Activity 只要一張列表 | 同工作區保留活動、I/O、AI 對話三閱讀方式；不用三個主選單。 |
| 原始事件／重要活動／診斷三個主模式 | 操作／原始事件分層，診斷進階查詢；避免疊出多組互相抵觸的模式。 |
| 目標與 Scope 都能改規則 | 目標負責活動與判定；唯一規則編輯入口在 Settings。網頁 Scope 不自動變 Shell 停記／丟棄政策。 |
| 所有證據都叫 Findings | 截圖／附件、Marker、Bookmark、Loot 分開；Loot 不代表已確認漏洞。 |
| 新來源全都做成 Plugin | 保留內建與外部整合的混合架構；操作一致不等於實作方式相同。 |
| AI 來源列 Claude／Codex／OpenCode | 官方只留 Claude Code／Codex，預設不安裝；既有歷史事件以通用讀取／匯出保留。 |
| 先換視覺 token／加動畫 | 可靠性與核心任務優先；視覺延用既有系統，最後驗收微互動。 |

這些是規格收斂，不把舊提議的問題全認定為已重現缺陷。主動新增 source、protocol、儲存遷移及 AI 聊天均不在範圍。

## 3. 現有能力與待做差異

| 面向 | 可沿用的實作 | 後續必要差異／限制 |
| --- | --- | --- |
| 事件／來源／資料 | Event Store、ingest、兩個 tier、sidecar、cast、來源 lifecycle、外掛 host | 不另造 evidence store，不因 UI 分組改 tier／原文／因果。 |
| Timeline | `Timeline.tsx`、`timeline/TimelineEventLog.tsx`、Inspector、`lib/timelineEvents.ts` | 已有 log 元件可盤點；現行 Shell 配對仍以 PID＋command，需補來源穩定身分。不能直接把所有新需求當既有能力。 |
| Transcript | `TranscriptView.tsx`、`TimelineEventDetails.tsx`、Replay、AI Tool 配對 | 沒有新的完整三模式工作區；長輸出／sidecar 可讀、內容定位、跨模式上下文須逐項證明。 |
| 查詢 | `SearchPanel.tsx`、`FilterBar.tsx`、`lib/FilterContext.tsx`、`core/query/contract.ts`、`db/event-queries.ts` | 現有 FilterContext 仍以單一 agentType／target 等為主；Action／Provider／Actor／結果／完整性複選不能只在前端加選單，必須先定義一致 query contract。 |
| 錄影索引 | cast index、body index、Search 錯誤／索引狀態 | 現有 Search 在 target／type／time／scope 等事件條件啟用時跳過缺少對應 metadata 的 cast；尚未對等前不可移除深搜能力。 |
| 導覽 | `App.tsx`、`lib/sidebarOrder.ts`、命令面板、跨頁 context | 目前仍十一工作入口＋Settings；整併時同步快捷鍵、deep link、返回、匯出 context，不留永久雙套主查詢。 |
| Settings | `Settings.tsx` 與現有 Hooks／Browser／CaptureControl／Agents／Plugins 等頁 | 目前十二個內部頁面已分組且有搜尋、自動保存／定位；改五類是整理既有任務，不重建設定中心。 |
| AI | 可選套件、專案 workPaths／啟用邊界、Session 排除、Claude／Codex provider host | 保留隱私門檻。來源狀態及安裝操作不在外掛頁再開另一套；Thinking 顯示與 sidecar 保存不同。 |
| 交付 | `ExportMenu.tsx`、ExportPlan、附件逐項排除、最近成品 | 直接沿用；需定義 Activity 選取、原始命中、必要上下文及 Session 的映射，不把可讀 Markdown 當全量原始包。 |
| HUD | 既有 IP／OPSEC、標記、穿透及焦點 | 保留獨立且預設開啟；原生恢復仍須按候選驗收，不變迷你 Dashboard。 |
| 小缺陷／長輸出 | 本地 Scope 載入、Target 計數與 Spec 063 終端分段候選 | 屬本地候選，非 main 已交付。#290 的 HTTP/SSE/WS 與跨平台 gate 仍需獨立完成，不能被本規格掩蓋。 |

檔案路徑用於後續 planning 盤點，不指定一定建立新的元件或資料表。Activity 可沿用既有純投影；若要抽共用模組，先證明它解決已存在的多個使用情境。

## 4. 已補的跨層契約與實作規劃界線

| 契約 | 已決定的語意 | bounded Plan 才決定的細節 |
| --- | --- | --- |
| [C1](contracts/activity-projection.md) | 穩定投影鍵、配對／衝突、來源參照、AI Tool 分類。 | 既有純投影的抽取位置、群組查詢／cursor 實作及效能。 |
| [C2](contracts/search-coverage.md) | 各內容覆蓋／索引／條件／定位，未涵蓋不等於零筆。 | 既有 FTS／cast／body index 的 metadata 與增量失效處理。 |
| [C3](contracts/content-viewer.md)／[C4](contracts/evidence-anchor.md) | 有界讀取、Find／Copy／Restore、來源版本與座標精度。 | 沿既有 reader 增補的最小 IPC 型別、chunk 大小及可讀轉換映射。 |
| [C5](contracts/export-snapshot.md) | 固定 plan／prefix、並行改寫失敗、跨目標錄影明確選取。 | Activity／Session 選取接入既有 ExportPlan，不另寫預覽引擎。 |
| [C6](contracts/capture-boundaries.md) | Session／專案／暫停生效邊界，Terminal App 的可信身分與 unknown 拒絕。 | 支援 OS 的可信 resolver／生命週期接線；沒有證據就不宣稱可隔離。 |

這些是擬定契約，不是新增 schema、API 已支援或人工驗收已通過的聲明。[追溯表](traceability.md) 指定現有候選責任位置；同一需求由一處 canonical 語意服務多個 surface，不要求新增同名元件／框架。

## 5. 四階段交付與退場 gate

| 階段 | 範圍與依賴 | 完成門檻 |
| --- | --- | --- |
| S1 Capture Baseline | 沿 #317／#290 收口安裝接入、錄製歸屬、長輸出、恢復、最小讀取與基本匯出；先定 C6、保留 C5 不退步。US1／2 為 P0。 | 真實來源→落盤→重啟讀回→交付；CT-08／09／15／16、UX-01–05 及基本 UX-13／14 通過適用平台。未知 App 不假隔離；#432 不直接合併。 |
| S2 Activity Core | 依 S1 建 C1／C2，單一日誌、穩定群組、Session、整案查詢、分頁與原事件定位；沿既有 query／cursor。 | CT-01–04／10、UX-06／08／09 及查詢正確性／效能通過；同一原始集合與 cursor 不重複、不漏列。尚未搜尋對等不能移除舊 Search。 |
| S3 Reading & Evidence | 依 S2 接 C3／C4、完整 I/O／AI 閱讀、長內容定位、片段標記及 C5 Activity／Session 選取與附件政策。 | CT-05–07／11–14、UX-07／10／12／13 通過；預覽／成品／來源相符、跨目標錄影不誤交付。尚未完整閱讀對等不能移除 Transcript。 |
| S4 Navigation & Polish | 前三階段能力成立後，五主入口、目標／證據整併、Settings 五分類、快捷鍵、窄窗、微互動及全產品走測。 | UX-11／15–19、既有十一能力對照及全部量化／平台矩陣有結果；原生 HUD／焦點須實測，未測不當 PASS。 |

每階段均保留最小視窗、鍵盤、安全呈現及錯誤修復，不把基本可用性拖到最後。S1 的基本匯出使用既有 Event／附件 plan；S3 才新增 Activity／Session 選取，不互相等待。設定重分組屬 S4，但既有授權、保存失敗、來源修復入口屬 S1。

每階段拆為可獨立 review 的 bounded change，前一階段的必要 gate 未通過不能藉導覽／視覺完成繞過；文件與可丟棄原型可並行。前三階段沿既有入口驗證，不以永久雙套查詢作過渡結果。

S4 新導覽落地時同步修訂 `docs/UIUX-STANDARD.md` §5.3 的固定順序與對應測試。該標準目前仍描述現行導覽，本 Draft 不把未實作設計當已發布行為；少文案規則與 domain invariants 持續有效。

## 6. 文件邊界與未完成事項

本次完成 Specify 及審查補充：53 項需求、六份跨層契約、追溯表、驗收標準、四階段界線與品質檢查。後續已建立 plan／tasks 並開始實作；尚未新增 GitHub issue、修改遠端、merge 或發版。

不得把本份規格套回歷史版本宣稱缺陷都存在，也不得把本地候選變更算成 main 已修復。既有規格／驗收保留其當時版本；新導覽尚未人工驗收，整體 UX 矩陣維持 NOT RUN；局部擷取、設定與配對結果另記 verification.md。
