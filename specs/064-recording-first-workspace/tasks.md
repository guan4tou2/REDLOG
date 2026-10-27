# Tasks: 紀錄優先工作區

依 plan.md 與 C1–C6；S1→S2→S3→S4。每故事 tests→實作→整合→原生驗收。沒有 [P] 的任務按依賴順序；不為本次任務啟動額外代理。


## Setup

- [x] T001 建立 plan／research／data-model／quickstart，記錄憲章及研究決策於 specs/064-recording-first-workspace/。

## S1 — US1／US2

- [x] T002 [US1] 在 test/terminal-origin.test.ts 先驗證偽造 TERM_PROGRAM／WT_SESSION／內建旗標不能通過受限擷取（RED）。
- [x] T003 [US1] 在 hooks/terminal_app.py／shell-common.sh 共用可信 origin，未知 fail closed；依實際可驗平台調整 shell-hook.ps1 與 HooksPanel.tsx。
- [ ] T004 [US1] 在 test/terminal-origin.test.ts／hooks-panel-terminal-policy.test.tsx 驗證正向身分、斷鏈、policy 變更與未支援環境；真實 Warp／另一 App 走 CT-08／09。
- [ ] T005 [US2] 在 test/ingest.test.ts／external-session.test.ts／relay-late-output.test.ts 補跨邊界故障案例，先驗證 CT-15／16。
- [ ] T006 [US2] 沿 src/core/ingest.ts、src/main/services/tailer-host.ts、hooks/ 修復剩餘 binding／暫停／延遲落盤邊界。
- [x] T007 [US2] 驗證 Spec 063 長輸出／cast 分段／基本匯出，於 specs/064-recording-first-workspace/verification.md 記候選與成品，不借舊結果。
- [ ] T008 [US1] 完成適用平台的 UX-01–05／基本 UX-13／14，於 verification.md 記錄 S1 gate；未測平台保留 NOT RUN。

## S2 — US3／US4

- [ ] T009 [US3] 在 test/timeline-events.test.ts 先驗 CT-01／02：穩定 ID、跨頁配對、亂序／重送／衝突與來源 fallback。
- [ ] T010 [US3] 於 src/core/ 與 src/renderer/src/lib/timelineEvents.ts 接入 C1 canonical 投影；查詢層解析跨頁群組，不更改原始 Event。
- [ ] T011 [US4] 於 optional-plugins/claude-code/adapter.ts、codex/adapter.ts 與共用投影驗 CT-10，實作非 Shell toolAction／unknown。
- [ ] T012 [US3] 在 test/ 搜尋整合案例先驗 CT-03／04；各內容覆蓋、索引 revision、條件限制、失敗及陳舊命中。
- [ ] T013 [US3] 於 src/core/query/contract.ts、db/event-queries.ts、http-body-index.ts、cast-index.ts 接 C2 覆蓋／cursor／統計。
- [ ] T014 [US3] 於 Timeline／SearchPanel／FilterContext 整合單一查詢及 Activity 列表，保留舊深搜能力到對等 gate。
- [ ] T015 [US3] 依 acceptance.md 完成 S2 查詢正確性、CT-01–04／10 及大量資料效能，記 verification.md。

## S3 — US3／US4／US6

- [ ] T016 [US3] 在 test/ reader／內容整合案例先驗 CT-11／12：長內容 Find／Copy／版本／位置／錯誤。
- [ ] T017 [US3] 沿 src/core/ readers 與 src/main/ipc/、preload 接 C3 ContentRef／有界讀取搜尋，供 HTTP／Shell／AI 共用。
- [ ] T018 [US4] 於 TranscriptView.tsx／TimelineEventDetails.tsx／ReplayCommand.tsx 實作三閱讀方式、Session 及側欄／全寬位置保持。
- [ ] T019 [US6] 在 test/ 先驗 CT-13／14；實作 src/core/ reader 及 MarkerDetail.tsx 的來源版本／raw 與可讀座標映射。
- [ ] T020 [US6] 在 test/export-attachments.test.ts／filtered-export.test.ts 先驗 CT-05–07：並行資料／改寫／跨目標 cast。
- [x] T021 [US6] 於 src/core/export-plan.ts、export-selection.ts、export-attachments.ts 實作 Activity／Session 固定邊界及保守附件預選。
- [ ] T022 [US6] 於 ExportMenu.tsx 及 data-export IPC 呈現同一 plan、逐附件選擇、失敗／重新確認及找回成品。
- [ ] T023 [US6] 完成 UX-07／10／12／13、CT-05–07／11–14；讀回來源與成品並記 verification.md 的 S3 gate。

## S4 — US5／US6／US7

- [x] T024 [US5] 於 Settings.tsx 及既有設定頁整理五類／唯一入口／搜尋直達，不改儲存 ownership 或 AI 授權邊界。
- [ ] T025 [US6] 於 App.tsx／sidebarOrder.ts 整併五主入口、目標／證據，待前段 parity 成立才移除舊 Search／Transcript 導覽。
- [ ] T026 [US7] 同步 docs/UIUX-STANDARD.md、指令面板／快捷鍵及受影響導覽測試，不加舊入口 shim。
- [ ] T027 [US7] 於 styles/index.css 與受影響元件驗 UX-16／17：窄窗、高縮放、語系、鍵盤、HUD、狀態及必要安全警告。
- [ ] T028 [US7] 依 acceptance.md 完成人工任務、來源／平台矩陣、五人量測及 S4 parity；於 verification.md 記實測與限制。

## Cross-cutting verification

- [ ] T029 更新 specs/064-recording-first-workspace/traceability.md／verification.md、CHANGELOG.md；完成相關 gates、build／E2E／package smoke 及 Converge，不將未測標完成。

## Dependencies / delivery

T001→T002–T008→T009–T015→T016–T023→T024–T028→T029。共用 fixture 可批次驗證，不能把故障注入或原生驗收省略。不同 reader fixture 可在無檔案衝突時平行跑，但本輪由主代理依序實作；未滿足 stage gate 不換主導覽。

## 2026-10-26 checkpoint

- T002／T003：可信 macOS App origin、未知拒絕、unsupported 平台不提供假隔離、設定保存／窄窗；已完成本輪實作。T004 的真實 Warp／另一終端已驗，但 tmux／重接等原生情境仍未全部驗，保留未勾。
- T007：本候選的離線長輸出、原生 cast 分段、I/O 取回、bundle／verifier／重啟已在 macOS 驗證；不是其他平台通過。
- T009／T010 進行中：已修 PID／文字誤折疊、provider／Session／capture namespace 錯配、衝突覆蓋、跨頁補齊及命中高亮；POSIX 傳來源 Session。已補 act1 ID、資料庫先分組後分頁、快照／群組計數／來源集合及 IPC；Activity 閱讀介面與 C2 覆蓋接線未完成。PowerShell 缺來源 Session／command ID 時保留未配對，不加 PID fallback。
- 其餘來源／隱私邊界、搜尋覆蓋、Viewer／anchor、匯出附件政策、導覽／Settings 整併及原生平台／使用者量測依原任務續做。unchecked 是未完成，不是已交付後續建議。

## 2026-10-26 — Search / Activity / saved-content slice

- T012／T013 部分落地：body index 重新核對原件、base64 解碼文字、缺檔後重試、revision／snapshot 內的 coverage 變更；Cast 有條件排除與 50 筆限制明示。Cast generation、AI raw JSONL／一般附件全文覆蓋尚未齊，不勾完整 C2。
- T014 部分落地：既有 Search 增加「操作／原始事件」，共用 query／filter；群組先分頁、命中來源優先、展開讀取及原始事件返回位置。未切換主導覽或移除舊 Search／Transcript。
- T016／T017 部分落地：ContentRef 綁 project／Event／field／hash，UTF-8 有界讀取、可取消的全文 Find、視窗複製及錯誤保留。尚無所有 Reader／cast 的版本契約對等、完整片段座標與跨模式恢復，因此維持未勾。
- T021／T022 的 Activity／Session 固定選取尚未完成；目前匯出入口只宣告「命中事件」，仍走既有 query → ExportPlan，不把整個群組背景或完整 Session 當成已選取。

## 2026-10-27 — macOS export / large-output slice

- [x] T030 移除 body 檔案 16 MiB 略過政策，採有界 UTF-8 分段索引；全檔尾端、多段 AND、同 Event 不同 ref 不混合、巨大 token／標點邊界及來源改寫以實際搜尋驗證。
- [x] T031 由展開的 Activity 選擇操作或來源 Session，沿同一 ExportPlan 完成 JSON／NDJSON／Bundle；配對 companions、project／capture／provider namespace、固定資料集合、附件明選、完整 prefix、新 part 排除與成品讀回。
- [x] T032 修正 Activity E2E 的 viewport emulation：使用原生視窗 800×700／1600×1000，核對原生 content size、root／status bar 右下邊界及 overflow；保存截圖並實際查看。

T021 的核心實作已完成。T012–T018、T020／T022／T023 仍為複合任務，不能因這輪功能完成便宣告所有 reader、anchor、一般附件／raw AI 搜尋、C5 全矩陣或跨平台人工驗收已齊。本輪交付到既有候選分支；合併、安裝包與發版狀態另行驗收。

## 2026-10-27 — shared reading workspace integration

- [x] T033 沿既有 Search 入口提供共用搜尋框、操作／輸入輸出／AI 對話／原始事件；空查詢可瀏覽，保留 Cast 深搜、內容 Find、Activity／Session 匯出與原始 Event 返回。
- [x] T034 保留已開啟讀取模式、來源 Event 與 stdout／stderr 各自的內容視窗及 Find；隱藏 reader 延後 live refresh，舊 export contribution 清理不得清掉新 owner。
- [x] T035 Settings 五類使用原有 routes、欄位搜尋及保存 ownership；不新增來源開關或安裝生命週期。
- [x] T036 本批 native 視窗／高縮放／雙語實際截圖及相關回歸驗收；記錄具體覆蓋與未完成 gate。

T014／T018 僅新增閱讀入口整合，不將 Session 完整選擇、Markdown／raw 座標映射、所有檔案索引及 S2／S3 contract 矩陣宣告完成。T025 主導覽退場仍等待原定 parity gate；本批不藉由減少選單繞過 gate。

## 2026-10-27 — Windows internal candidate

- [x] T037 將 shared reading workspace、無專案時不包 PTY 指令、#432 剩餘的 first-run mock 修正合成單一候選 `integrate/spec064-internal`；在 Windows 跑四道 gate、完整 unit、WSL 完整 e2e、NSIS 打包與 installed smoke，失敗項以 main 同環境對照，記 verification.md。

T037 是自動化與打包驗收，不是 Windows 原生人工操作（PowerShell 接入 canary、閱讀模式、DPI）。那些及 T004／T008 的 Windows 列仍 NOT RUN。
