# Tasks: 截取來源、設定導航與外部工具整合

> 草稿。每任務 tests 先行;D1 決議前不開工 S2 之後。

## S0 — 查證(先於一切)
- [ ] T001 重現 `ls`／`ls -al`:內建 PTY、外部 zsh／bash、`redlog-run`;分流 inline／ref／cast／streamed;先弄清隔離 HOME 下收不到 `command_end` 的原因。
- [ ] T002 確認 `castProbe` 位移與最後一段輸出的先後(假設驗證)。
- [ ] T003 盤點外掛安裝機制與 CDP 連接器現況(審查兩項主張)。

## S1 — 完整性(US3、FR-009)
- [ ] T004 定義 `capture_status`,決議 D2;對齊 `ActivityState`／`lateOutput`。
- [ ] T005 Reader 在 partial／interrupted／unknown 時提示。

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
