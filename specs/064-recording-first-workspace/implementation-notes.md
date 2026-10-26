# 現況、範圍收斂與後續切法

**Status**: Draft specification only · 2026-10-26。
本次尚未建立 UI 實作分支、改造導覽或發布；沒有將文件描述當已完成成果。

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

## 4. 先定契約，再替換表面

後續 planning 必須明確回答：

1. Activity 穩定身分、來源原始 IDs、部分配對／跨頁合併、時間範圍、命中與背景如何表示。
2. Action、Provider、Actor、Source、Session、Outcome、完整性如何從**確實存在**的欄位投影；未知的處理。查詢先於 cursor／統計，所有 surface 及匯出共用。
3. 大輸出的 reader／內容錨點如何跨 inline、sidecar、chunk、cast part；沒有偏移資料時的可用降級，不造假全量內容。
4. 全域專案 query 與局部 find、閱讀模式、原始／操作層級、精確選取如何區分；一個可追蹤 context，不能多套互相覆寫的狀態。
5. 匯出當前查詢、單 Activity、Session 與原始證據如何映射到既有 ExportPlan。哪些上下文是必要 companions，哪些只有閱讀相關性。
6. 來源設定的本機／專案範圍、唯一主要動作、AI 真正安裝內容、平台限制、修復與診斷如何沿用既有 lifecycle。

這些是跨層 contract 的 planning 工作；本次不寫新的儲存 schema、不將規格假裝成 API 已支援。

## 5. 分批落地與退場 gate

| 批次 | 內容 | 通過才往下的條件 |
| --- | --- | --- |
| R0 紀錄可用收口 | 沿 #317 修漏記／歸屬／長輸出／保存故障、安裝接入、最小讀取與交付；小型失敗修復入口先做。 | 對候選及宣稱平台有真實來源、重啟及成品證據；未測限制公開，#432 不因 UI 規格直接合併。 |
| R1 工作區契約及原型 | 三閱讀模式、Session、Activity 映射、查詢／匯出邊界；以五個實際任務驗證結構。 | 不改原始事件；使用者可找回長內容；沒有新來源／AI／隱私設定擴張。 |
| R2 活動、搜尋與 I/O | 沿用 query／cursor、Inspector／Transcript／Replay，整合條件、內容定位與返回。 | UX-06–10／13／18 對等；未覆蓋 cast／sidecar 時不能關掉現有深搜入口。 |
| R3 導覽／證據／目標 | 五主入口、Evidence 子分類、目標唯讀判定與設定跳轉、全域動作及鍵盤。 | 原十一能力有對應入口，選取／匯出／返回不退步；不以減少頁數充作功能通過。 |
| R4 Settings 重分組 | 五類目的導覽；內建／外部來源、平台及授權、原地修復與欄位搜尋。 | UX-01–03／14–16 對等；不改既有設定 ownership／生命週期、不新增雙重開關。 |
| R5 視覺及全產品驗收 | 字體／間距／狀態／排版／微互動、鍵盤／縮放／語系／HUD。 | 任務量測及適用矩陣有明確結果；沒有以舊候選或 seed 取代真實 producer。 |

規格及可丟棄原型可在可靠性驗收等待時進行；主介面替換與擷取後端修正保持可分辨的交付單位，不能為改版混入大批 recorder 改寫。開發拆成可獨立 review 的 bounded change，不要求一次實作全部頁面。

R3 新導覽落地時同步修訂 `docs/UIUX-STANDARD.md` §5.3 的既有固定順序註記及對應 tests。該標準目前仍描述現行導覽，本份 Draft 不把未實作設計變成已發布行為。`docs/UIUX-CONTROLS-AND-COPY.md` 的少文案規則與既有 domain invariants 持續有效。

## 6. 文件邊界與未完成事項

本次完成 Specify：需求、UX 契約、驗收標準、現況／分批界線與品質檢查。下一步才是 bounded Plan／Tasks、原型及實作；沒有為此新增 GitHub issue、修改遠端、建立實作分支、merge 或發版。

不得把本份規格套回歷史版本宣稱缺陷都存在，也不得把本地候選變更算成 main 已修復。既有規格／驗收保留其當時版本；新導覽尚未人工驗收，狀態全部 NOT RUN。
