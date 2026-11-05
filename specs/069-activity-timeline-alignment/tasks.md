# Tasks: 活動紀錄與時間軸 — 對齊 Stitch 設計決策

## S0 — 現況調查

- [x] T001 調查 HTTP 詳情排列、選取狀態來源、Reader 後備、Scope／AI／截圖字串清單、統計來源;結果寫入 implementation-notes.md。

## S1 — 文案語意(US1)

- [x] T002 [US1] 先 RED:黑名單斷言——使用者可見字串不含「凍結」「Chain-of-Thought」「已確認違規」等(FR-001、FR-003、FR-004)。
- [x] T003 [US1] 先 RED:未宣告 Scope 時任何目標都是 `no-scope`、不被標為範圍外(FR-002)。調查發現引擎已滿足,以測試鎖住;不另造「尚未判定」字樣。
- [x] T004 [US1] 實作 en／zh-TW 字串與標題;更新受影響的 test／e2e 斷言;`verify:i18n` 綠。

## S2 — HTTP(US2)

- [x] T005 [US2] 先 RED:Request 在上、Response 在下;內容保留換行(FR-005)。(`test/http-detail-tabs.test.tsx`;舊實作 6 項失敗已確認)
- [x] T006 [US2] 實作:`HttpDetail` 有配對時以兩個 section 上下排列、移除頁籤;`e2e/layout-reliability.spec.ts` 改指 `http-section-response`。調查筆記原判「已滿足」有誤:原本是頁籤,一次只看一半。

## S3 — 共用選取與 Reader(US3)

- [x] T007 [US3] 先 RED:列表選取後切到時間軸，選取不變;「在時間軸定位」定位當前事件(FR-006)。
- [x] T008 [US3] 先 RED:沒有專屬實作的來源走 Generic Reader，不報錯，顯示通用欄位(FR-007)。
- [x] T009 [US3] 實作單一選取來源與 Generic Reader。
- [x] T010 [US3] 計數由同一份資料算出;被截斷標示總數(FR-009)。(行為本來就成立;`test/timeline-count-truth.test.tsx` 兩種模式鎖住,非 RED 先行)

## S4 — 標準／泳道(US4)

- [x] T011 [US4] 先 RED:預設標準;切換保留選取與縮放;偏好 per-project 記住(FR-008)。  `e2e/timeline-standard-mode.spec.ts` 鎖住;依賴泳道的 e2e 改用 `openSwimLanes`。
- [x] T012 [US4] 實作(D3):現有版面標為「進階泳道」,新增單軌依序的「標準時間軸」為預設。

## S5 — 識別字(FR-010)

- [ ] T013 先 RED:既有事件(含 `scope_violation`)重載後 `chain.verify()` 為 ok;舊 `warnOnViolation` 的 config 仍被讀取。
- [ ] T014 依 D1=A 實作程式內符號重命名(D2 範圍內的 key);持久化值 `scope_violation`／`warnOnViolation` 不變,集中成具名常數。

## S6 — 視覺重做(US5)

- [x] T016 產出 token／版面差異清單(implementation-notes.md);結論:#575 即現行 token,基準=現行 app,Stitch 的對比不足處不照抄(FR-011)。
- [x] T017 共用外框:標題列已是 40px(原型 h-10);狀態列 32→28px(原型 h-7),控制項保 24px 目標;側邊欄**維持 150px**——寬度是最長導覽標籤加快捷鍵欄,原型的 224/240px 只會在名稱與數字之間造成空白欄(Sidebar.tsx 註解)。尺寸由 `e2e/shared-frame.spec.ts` 鎖住。
- [ ] T018 活動紀錄與時間軸頁面對齊基準。
- [ ] T019 其餘頁面依批次對齊(各自一個 PR)。
- [ ] T020 [US6] 為設定導航改型另寫規格(070):深層連結、`gen:settings-search`、e2e helper、`SettingsPage` 型別的遷移計畫;未完成前不動 `Settings.tsx` 結構。

## S7 — 指令顯示(FR-013–015)

- [x] T021 Timeline:`unfinishedCommandIds` 標出無結束事件的 `command_start`,列標題與詳情顯示「執行中／狀態未知」。
- [x] T022 `CommandEndDetail` 空 STDOUT 不顯示(FR-014)。
- [x] T023 Activity 列顯示結果(FR-015):`ActivitySummary.result` 取自配對的 `command_end`。

## 收尾

- [ ] T015 五道 push gate + build;e2e;`verification.md`;Spec 069 在全部任務完成並驗證前維持 Draft。
