# Tasks: 活動紀錄與時間軸 — 對齊 Stitch 設計決策

## S0 — 現況調查

- [ ] T001 調查 HTTP 詳情排列、選取狀態來源、Reader 後備、Scope／AI／截圖字串清單、統計來源;結果寫入 implementation-notes.md。

## S1 — 文案語意(US1)

- [ ] T002 [US1] 先 RED:黑名單斷言——使用者可見字串不含「凍結」「Chain-of-Thought」「已確認違規」等(FR-001、FR-003、FR-004)。
- [ ] T003 [US1] 先 RED:Scope 未設定／未知時事件顯示「尚未判定」，不標範圍外(FR-002)。
- [ ] T004 [US1] 實作 en／zh-TW 字串與標題;更新受影響的 test／e2e 斷言;`verify:i18n` 綠。

## S2 — HTTP(US2)

- [ ] T005 [US2] 先 RED:Request 在上、Response 在下;內容保留換行(FR-005)。
- [ ] T006 [US2] 實作或補斷言(視 T001)。

## S3 — 共用選取與 Reader(US3)

- [ ] T007 [US3] 先 RED:列表選取後切到時間軸，選取不變;「在時間軸定位」定位當前事件(FR-006)。
- [ ] T008 [US3] 先 RED:沒有專屬實作的來源走 Generic Reader，不報錯，顯示通用欄位(FR-007)。
- [ ] T009 [US3] 實作單一選取來源與 Generic Reader。
- [ ] T010 [US3] 計數由同一份資料算出;被截斷標示總數(FR-009)。

## S4 — 標準／泳道(US4)

- [ ] T011 [US4] 先 RED:預設標準;切換保留選取與縮放;偏好 per-project 記住(FR-008)。
- [ ] T012 [US4] 實作(依 D3)。

## S5 — 識別字(FR-010)

- [ ] T013 先 RED:既有事件(含 `scope_violation`)重載後 `chain.verify()` 為 ok;舊 `warnOnViolation` 的 config 仍被讀取。
- [ ] T014 依 D1 實作符號重命名;持久化值不變，或依 B 雙值讀取。

## 收尾

- [ ] T015 五道 push gate + build;e2e;`verification.md`;Spec 069 在全部任務完成並驗證前維持 Draft。
