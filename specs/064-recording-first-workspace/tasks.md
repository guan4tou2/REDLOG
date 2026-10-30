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
- [x] T012 [US3] 在 test/ 搜尋整合案例先驗 CT-03／04；各內容覆蓋、索引 revision、條件限制、失敗及陳舊命中。
- [x] T013 [US3] 於 src/core/query/contract.ts、db/event-queries.ts、http-body-index.ts、cast-index.ts 接 C2 覆蓋／cursor／統計。
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

## 2026-10-27 — Session / Reader / fragment / primary navigation

- [x] T037 由整案儲存事件分頁列出 Shell／AI Session，分離 project／capture／provider namespace；Claude Code／Codex 選擇沿共同查詢引擎求值，Reader／Session 匯出共用快照；晚到資料只由明確更新納入。
- [x] T038 共用 Reader 原地放大、Escape／焦點返回、欄位 Find／位置保留；UTF-8 byte 片段標記經主程序驗證來源版本與摘要，再存 append-only marker。重開片段高亮原文，missing／changed／denied 不以相近文字替代。
- [x] T039 五主工作區＋備用 Terminal；目標／範圍與截圖／戰利品／書籤使用既有路由頁籤，同步命令面板、數字快捷鍵及共用 E2E 導覽 helper。原始事件 Timeline／連續 Transcript 仍是可達的真實頁面，沒有舊路由 shim。
- [x] T040 更新需求追溯／驗證紀錄，完成相關 gates、單次 App 的 Session→Reader→片段→匯出→導覽整合流程及原生版面檢查。

T019 僅完成保存 UTF-8 文字的原始 byte 座標；ANSI 不剝除或猜測映射，binary／Markdown 渲染／cast 時間片段座標尚未對等。T025 的主選單整理已落地，舊視圖程式退場仍受完整 parity gate 約束。其餘複合任務與原生平台／五人任務量測不借本批結果勾選。

## 2026-10-27 — complete saved-content delivery

- [x] T041 C3／FR-023／051：區分視窗複製、1 MiB 上限的完整保存文字複製及有界另存 bytes；驗證原件版本、專案切換、取消、目的檔保護／失敗清理與大型成品讀回。

## 2026-10-27 — Windows internal candidate

- [x] T042 將 shared reading workspace、無專案時不包 PTY 指令、#432 剩餘的 first-run mock 修正合成單一候選 `integrate/spec064-internal`；在 Windows 跑四道 gate、完整 unit、WSL 完整 e2e、NSIS 打包與 installed smoke，失敗項以 main 同環境對照，記 verification.md。

T042 是自動化與打包驗收，不是 Windows 原生人工操作（PowerShell 接入 canary、閱讀模式、DPI）。那些及 T004／T008 的 Windows 列仍 NOT RUN。（原記為 T037，與同日 Session／Reader 批次撞號，整合時改號。）

## 2026-10-28 — Windows native acceptance

- [x] T043 以 PR #448 的 Windows install smoke 安裝包做原生驗收：安裝、PowerShell 接入 canary、四種閱讀模式、Settings 五類與搜尋、125% DPI、系統匣結束確認、重開保留、`/S` 原地升級。發現並修正 PowerShell 指令未配對、HUD 與設定的 macOS 文案三項，於重建安裝包上複驗，記 verification.md。

- [x] T044 App 啟動時將已接入 shell 的 `~/.redlog/` hook 副本更新為內建版本（bash／zsh 含支援檔、PowerShell），只動 rc／profile 已載入的副本、不新增接入；以真實 `/S` 升級複驗。WSL distro 沒有副本：rc 直接 source 安裝目錄內的 hook，同目錄升級即更新（路徑失效見 T047）。

- [x] T045 主視窗只在 `ready-to-show` 顯示；本機 GPU 合成下從未顯示過的視窗不會繪製，事件不來，凡非最大化啟動皆隱藏（升級與非正常結束只是巧合）。改為頁面載入後 500 ms 仍隱藏即顯示，以 `/S` 升級與無狀態檔啟動複驗。

T004／T008 的正式 Windows 列仍 NOT RUN。

## 2026-10-28 — bounded Reader / source-settings closeout

- [x] T046 在另存來源內容前保留未套用 scope／遮蔽的提醒；開啟 saved Reader 時收起重複輸出，保留指令／結果狀態並於關閉時恢復；mitmproxy 設定與移除步驟集中至瀏覽器與 HTTP 擷取，同步設定搜尋及受影響的雙語窄窗／另存驗收。

## 2026-10-28 — WSL hook line for another build

- [x] T047 WSL rc 那行指向其他 build（別的安裝位置、dev checkout）時，狀態不再算「已安裝」，安裝／驗證修復會換成目前路徑、保留 rc 其餘內容；兩段腳本以 `wsl.exe -e` 執行並以位置參數傳路徑。先寫 RED 測試，並在 Ubuntu 26.04 與 kali 實跑。

## 2026-10-28 — search coverage (C2 / CT-03–04)

- [x] T048 接入已保存文字附件與已確認 AI JSONL prefix 的索引／原文讀取；保留原件雜湊、專案邊界、binary／未確認內容及不適用條件的實際覆蓋狀態。修正 Cast 追加／改寫／清理的版本與實體分段定位，將 query cursor 綁 dataset／索引 revision；完成故障回歸、相關 gates／build 與既有搜尋 Electron 流程，記錄邊界。

T012／T013 本批完成（macOS source build＋DB／unit，見最新 verification）；搜尋仍沿既定 token／prefix 語意及明示限制，不承諾 binary／OCR／未確認 bytes。T015 的效能與完整 S2 gate、C3/C4 的跨 Reader／轉換座標及其餘平台／人工驗收不由本批代勾。

## 2026-10-28 — uninstall removes enrolments; tray speaks the app's language

- [x] T049 Windows 解除安裝前以 `RedLog.exe --remove-hooks` 移除 PowerShell profile 與各 WSL 發行版 rc 中本 build 的接入行（hook 副本已被手動刪除也照樣移除；保留使用者自己的內容；升級時不執行）；系統匣選單隨 App 語言，結束確認改為一般按鈕；內測說明補升級、結束、無視窗與移除。先寫 RED 測試，並以實際安裝包在本機跑安裝 → 原地升級 → 解除安裝。

## 2026-10-30 排程與文件整理

依 [工作計畫](../../docs/WORK-PLAN.md) 對帳後接續原 S1→S2→S3→S4；本次不代勾完整 gate。

- T004–T008：保留 origin／binding／pause／落盤的完整故障與原生門檻；本次 project-open rollback／spool E2E 是局部補強。
- T009–T015：C1 投影與搜尋已有局部實作和性能證據，先核對配對／來源／非 Shell tool action 差額，再接 Activity parity。
- T016–T023：HTTP／Shell 已接版本化 Reader，17 MiB／政策／實際成品已有補測；跨 Reader 的模式位置保持、fragment 座標及完整 CT-05–07／11–14 未因此完成。
- T025–T029：前段 parity 成立後才切換五主入口／移除舊入口；全產品視覺基礎沿 062 T087–T092，不再複製成另一套設計計畫。

本次已驗證範圍、精確候選與未測限制見 [2026-10-29 完成紀錄](../../docs/records/2026-10-29/UIUX-COMPLETION-2026-10-29.md)；正式 feature 狀態仍 Draft。#457 僅協調環境與真人量測，不能取代本 spec 的 CT／UX 原表。
