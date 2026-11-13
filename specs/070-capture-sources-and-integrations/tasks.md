# Tasks: 截取來源、設定導航與外部工具整合

> 2026-11-13 註記：本規格部分由 Spec 075 取代，範圍見 [spec.md](spec.md) 開頭的註記；動手前先對照，被取代的需求不要依這裡的任務重做。

> 草稿。每任務 tests 先行;D1 決議前不開工 S2 之後。

## S0 — 查證(先於一切)
- [ ] T001 重現 `ls`／`ls -al`:內建 PTY、外部 zsh／bash、`redlog-run`;分流 inline／ref／cast／streamed;先弄清隔離 HOME 下收不到 `command_end` 的原因。
- [ ] T002 確認 `castProbe` 位移與最後一段輸出的先後(假設驗證)。
- [ ] T003 盤點外掛安裝機制與 CDP 連接器現況(審查兩項主張)。

## S1 — 完整性(US3、FR-009)
- [ ] T004 定義 `capture_status`,決議 D2;對齊 `ActivityState`／`lateOutput`。
- [ ] T005 Reader 在 partial／interrupted／unknown 時提示。

## S1b — 程序到網路關聯(US10、US11、FR-015–017;P0 先於 S2)
- [ ] T016 RED 測試重現背景指令誤歸因:同一 shell pid 先後兩個 `command_start`,舊指令的後續 socket 不得歸給新指令;不確定時回傳 null。
- [ ] T017 歸因加入生命週期／時間區間與五元組;不確定時保留未歸因事件。
- [ ] T018 輪詢缺口與 400 飽和在 Reader／時間軸可見(FR-016),不移除上限。
- [ ] T019 指令 Reader 聚合網路活動摘要(目的地、Port、連線數、缺口提示)。
- [ ] T020 以專案 Scope 標示範圍外目的地(連線與 DNS 分開)。
- [ ] T021 專案選項:包含 loopback 測試流量(D6)。

## S1c — DNS 與 PCAP(US12、FR-018–020)
- [ ] T022 `pcap-parse.js` 解析標準 DNS,輸出獨立 DNS 事件(fixtures 先行,含 NXDOMAIN)。
- [ ] T023 截取設定顯示 DNS 能力狀態與缺少的需求;DoH／DoT 文案。
- [ ] T024 觀測位置說明(SSH／Docker／VM)。

## S2 — 狀態契約(US1、US2、US4、US7、US8)
- [ ] T006 `CaptureSourceStatus` 與由觀測導出狀態的函式(先 RED)。
- [ ] T007 HTTP 六態與「測試截取」診斷(FR-006)。
- [ ] T008 重連文案與缺口保留(FR-005)。
- [ ] T009 異常列表資料驅動、搜尋＋篩選同時生效。

## S3 — Shell(US5、FR-007、FR-008)
- [ ] T010 Shell 偵測列表與安裝／修復／驗證／還原。
- [ ] T011 PTY 原始保存不被使用者規則影響;內部標記不外露的斷言。

## S4 — Burp(US6、FR-010、FR-011)
- [ ] T012 外掛 manifest 與連線健康;Extension 原型(非阻塞佇列)。
- [ ] T013 來源標記與重複交易關聯規則。

## S5 — 大量 HTTP(US9)
- [ ] T014 工作階段聚合顯示,原始事件保留。

## 收尾
- [ ] T015 五道 gate、e2e、`verification.md`;全部完成並驗證前維持 Draft。
