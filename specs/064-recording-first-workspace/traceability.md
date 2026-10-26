# Requirement → 責任位置／資料契約 → 驗收追溯

**Status**: Draft mapping · 2026-10-26。責任位置是既有程式的重用／規劃候選，不宣稱已實作或必須新增同名元件。FR 為 [主規格](spec.md) 的穩定 ID；測試均見 [UX 任務](acceptance.md)、[CT 契約案例](contract-acceptance.md)，完整端到端尚未通過；局部 query／IPC／來源實跑證據見 verification.md。

- UX：[操作契約](ux-contract.md)；C1：[Activity／Tool](contracts/activity-projection.md)；C2：[搜尋覆蓋](contracts/search-coverage.md)。
- C3：[Content Viewer](contracts/content-viewer.md)；C4：[Anchor](contracts/evidence-anchor.md)；C5：[Export](contracts/export-snapshot.md)；C6：[Capture／Terminal App](contracts/capture-boundaries.md)。
- S1 Capture Baseline → S2 Activity Core → S3 Reading & Evidence → S4 Navigation & Polish，完成門檻見 [實作切分](implementation-notes.md#5-四階段交付與退場-gate)。

元件位於 `src/renderer/src/components/`，App 位於 `src/renderer/src/App.tsx`，FilterContext／sidebarOrder 位於 `src/renderer/src/lib/`。資料契約由 `src/core/`、來源 adapters、`src/main/` 的既有責任承接；跨表面只建立一套 canonical 語意，不能由各頁自行猜測。新增 resolver／型別須由後續 bounded Plan 定義，這裡沒有指定新資料表或框架。

| 需求 | 可觀察責任 | 既有元件／資料契約的責任位置 | 契約 | 驗收案例 | 階段 |
| --- | --- | --- | --- | --- | --- |
| FR-001 | 接入／記錄／交付 | FirstRunView、CaptureHealth、ExportMenu | C5/C6 | UX-01/05/18 | S1–S4 |
| FR-002 | 能力承接／主導覽 | App、sidebarOrder | UX | UX-19 | S4 |
| FR-003 | 三閱讀方式 | Timeline、TranscriptView、SearchPanel | C1/C3 | UX-08/19 | S2–S3 |
| FR-004 | Shell／Terminal App／平台 | RecordTerminalFlow、HooksPanel；terminal-enrollment、shell adapters | C6 | UX-01/03；CT-08/09 | S1 |
| FR-005 | 接入與修復直達 | FirstRunView、CaptureHealth、HttpCaptureStep、Settings | UX/C6 | UX-02/03 | S1 |
| FR-006 | 入口、過濾與擷取分離 | Settings、FilterContext、tailer-host、terminal-enrollment | C6 | UX-03/11/15；CT-09/15 | S1/S4 |
| FR-007 | 導覽與返回上下文 | App、sidebarOrder、FilterContext | C1/C3/C6 | UX-10/19；CT-15 | S2–S4 |
| FR-008 | 投影與原始來源 | TimelineEventLog、TranscriptView；activity-projection、activity-queries／event-queries | C1 | UX-06/09；CT-01 | S2 |
| FR-009 | 獨立來源維度 | TranscriptView、FilterBar；query/contract、AI adapters | C1 | UX-04/08/09；CT-02/10 | S2 |
| FR-010 | 配對 | TimelineEventLog、TranscriptView；operation-pair-key、activity-projection／activity-queries、來源 command/tool IDs | C1 | UX-04/08；CT-01/02 | S2 |
| FR-011 | 缺口不可被噪音隱藏 | Timeline、CaptureHealth；ingest、tailer-host | C1/C6 | UX-05；CT-16 | S1–S2 |
| FR-012 | 順序與晚到 | TimelineEventLog、TranscriptView；query cursor | C1 | UX-04/10；CT-01 | S2 |
| FR-013 | 配對／執行狀態 | TranscriptView、TimelineEventDetails；來源結果欄位 | C1 | UX-04/08；CT-02/10 | S2 |
| FR-014 | 未知來源可讀 | TimelineEventDetails、TranscriptView；原始 Event | C1 | UX-09；CT-02/10 | S2 |
| FR-015 | 單一查詢入口 | SearchPanel、FilterBar、FilterContext；query/contract | C2 | UX-06；CT-04 | S2 |
| FR-016 | 條件語意 | FilterContext；query/contract、event-queries | C2 | UX-06；CT-04 | S2 |
| FR-017 | 整案求值／cursor | SearchPanel；query/contract、event-queries | C1/C2 | UX-06/18；CT-01/04 | S2 |
| FR-018 | 命中／群組／背景數量 | TimelineEventLog、SearchPanel、ExportMenu；投影及 plan counts | C1/C2/C5 | UX-06/13；CT-01/04 | S2–S3 |
| FR-019 | 命中展開／查詢狀態 | SearchPanel、TimelineEventInspector；query/contract | C2 | UX-06/18；CT-03/04 | S2 |
| FR-020 | cast／長內容搜尋 | SearchPanel、ReplayCommand；cast-index、http-body-index | C2/C3 | UX-18；CT-03/04/11 | S2–S3 |
| FR-021 | 同查詢／舊回覆失效 | FilterContext、SearchPanel、App；query/contract、export-plan | C2/C5 | UX-06/10；CT-04 | S2–S3 |
| FR-022 | 詳情與來源附近開啟 | TimelineEventInspector、TimelineEventDetails、TranscriptView、ReplayCommand | C3 | UX-07/10；CT-11/12 | S3 |
| FR-023 | 有界讀取／內容 Find | ReplayCommand、TranscriptView；既有 body/cast readers | C2/C3 | UX-07/18；CT-11/12 | S3 |
| FR-024 | 預覽／保存／可用性 | TimelineEventDetails、ReplayCommand；Evidence ref、reader、retention | C3/C4/C5/C6 | UX-05/07；CT-06/11/14/16 | S1/S3 |
| FR-025 | 輸出方向與 PTY | TranscriptView、SessionReplayPlayer；來源 stream metadata | C3 | UX-04/07；CT-12 | S1/S3 |
| FR-026 | 增量及閱讀位置 | Timeline、TranscriptView、SessionReplayPlayer | C1/C3 | UX-10/18；CT-12 | S2–S3 |
| FR-027 | AI 內容／Thinking | TranscriptView、AgentsPanel；Claude/Codex adapters | C1/C3 | UX-08；CT-10/12 | S3 |
| FR-028 | 真實來源動作 | HooksPanel、BrowserPage、CaptureControlPage；來源 lifecycle | UX/C6 | UX-01/02/15 | S1/S4 |
| FR-029 | 安裝／授權／落盤證明 | CaptureHealth、RecordTerminalFlow、HttpCaptureStep、AgentsPanel | C6 | UX-01/02/05；CT-08/16 | S1 |
| FR-030 | AI opt-in 及授權 | AgentsPanel、PluginsPanel；agent-capture-policy、tailer-host | C6 | UX-14；CT-15/16 | S1 |
| FR-031 | 設定範圍／失敗恢復 | Settings、AgentsPanel；既有 config ownership／IPC | UX/C6 | UX-14/15；CT-16 | S1/S4 |
| FR-032 | 暫停／停止／卸載 | CaptureHealth、AgentsPanel、HooksPanel；ingest、來源 host | C6 | UX-02/05/14；CT-15/16 | S1 |
| FR-033 | 來源擴充／宣告邊界 | PluginsPanel、CaptureControlPage；plugin host／manifest | UX | UX-15 | S4 |
| FR-034 | 證據類型／版本 | MarkerDetail、既有截圖／Loot／Bookmark 讀取入口 | C4 | UX-12；CT-14 | S3 |
| FR-035 | 片段標記 | MarkerDetail、TimelineEventDetails；來源 Event／Evidence ref | C4 | UX-12；CT-13/14 | S3 |
| FR-036 | 詳情／跨頁跳轉 | App、TimelineEventInspector、TargetView；來源 Event links | C1/C3 | UX-09/12 | S2–S3 |
| FR-037 | 不同匯出選取 | ExportMenu；export-selection、export-plan | C5 | UX-13；CT-05/07 | S3 |
| FR-038 | 預覽執行／成品 | ExportMenu；export-plan、export-attachments、bundle-export、data-export IPC | C5 | UX-13；CT-05/06 | S1/S3 |
| FR-039 | 網頁 Scope／附件限制 | ScopeStatus、ScopePage、TargetView；canonical scope／export policy | C5 | UX-11/13；CT-07 | S1/S3 |
| FR-040 | Settings 五目的分類 | Settings 及既有各設定頁；config ownership | UX | UX-15/19 | S4 |
| FR-041 | HUD 獨立用途 | HudPage；既有 HUD window／焦點／穿透 | UX | UX-17 | S4 |
| FR-042 | 品牌與少文案布局 | 既有 CSS tokens／共用控制；UIUX-CONTROLS-AND-COPY | UX | UX-16 | S4 |
| FR-043 | 尺寸／語系／鍵盤／狀態 | 各受影響控制、windows 最小尺寸、locales | UX/C3 | UX-16 | 全階段，S4 總驗收 |
| FR-044 | 安全內容呈現 | TimelineEventDetails、TranscriptView、ReplayCommand；既有安全轉換 | C3/C4 | UX-16；CT-12 | 全階段，S3 共用契約 |
| FR-045 | 退出／更新／恢復 | App；既有 updater／shutdown／Terminal Manager | UX/C6 | UX-17 | S1/S4 |
| FR-046 | 穩定 Activity 身分 | TimelineEventLog、TranscriptView；投影、query cursor、來源 IDs | C1 | CT-01/02 | S2 |
| FR-047 | 內容覆蓋／索引狀態 | SearchPanel／ActivityResults；event-queries、http-body-index、cast-index、retention | C2/C4 | CT-03/04/14 | S2 |
| FR-048 | 凍結範圍／附件版本 | ExportMenu；export-plan、export-selection、export-attachments、data-export IPC | C5 | CT-05/06/07 | S1 不退步，S3 擴選取 |
| FR-049 | Terminal App 身分／範圍 | HooksPanel、RecordTerminalFlow；terminal-enrollment、shell adapters／可信 origin resolver 待規劃 | C6 | CT-08/09 | S1 |
| FR-050 | 非 Shell AI Tool | TranscriptView、FilterBar；Claude/Codex adapters、canonical action projection | C1 | CT-10 | S2 |
| FR-051 | 共用內容閱讀語意 | EventContentReader／ActivityResults（部分）；TranscriptView、TimelineEventDetails、ReplayCommand 待對齊；evidence-content／content-contract／IPC | C2/C3 | CT-11/12 | S3 |
| FR-052 | 可追溯內容座標 | MarkerDetail、SearchPanel；reader／cast part mapping／Evidence ref | C4 | CT-13/14 | S3 |
| FR-053 | Session／授權生效邊界 | CaptureHealth、AgentsPanel；terminal-enrollment、terminal-manager、tailer-host、ingest | C6 | CT-09/15/16 | S1 |

## 使用及變更規則

同一 FR 跨階段時，先完成基礎行為，再擴新選取／導覽，不把既有正確性延後到視覺批次。實作任務須引用 FR、C／UX、驗收 ID 及候選版本；需求變更同步改此表與對應案例，不能只勾 task。驗收結果記在各 bounded feature 的 verification，不在本表把預期當成 PASS。

本表完整涵蓋 FR-001–053；FR-046–053 是細化原需求的跨層保證，不重複建立八套 UI 或八個新系統。CT 案例可合併成共享 fixture／少量 table-driven integration checks，僅真實來源、原生權限及人工任務才需要獨立走測。

## 2026-10-27 slice

- FR-047 → http-body-index.ts／http-body-search.test.ts／evidence-content.test.ts：超過 16 MiB 的 body 分段全文覆蓋，來源版本及同 ref 交集；raw JSONL／一般附件／Cast 的其他限制保留。
- FR-037–039／FR-048 → export-plan.ts／export-selection.ts／export-attachments.ts／data-export.ts／ExportMenu.tsx／ActivityResults.tsx：固定 Activity／Session 成員、保守錄影、逐項 opt-in、成品內容核對；filtered-export.test.ts 及 macOS Electron 成品讀回。
- UX-16／17 → http-body-search.spec.ts：原生 resize + root／status-bar 填滿驗收，避免 viewport emulation 的假通過。完整平台／使用者矩陣未完成。
