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

- [x] T013 先 RED:既有事件(含 `scope_violation`)重載後 `chain.verify()` 為 ok;舊 `warnOnViolation` 的 config 仍被讀取。(`test/scope-persisted-contract.test.ts`;RED 是常數模組不存在,其餘為不變量守門)
- [x] T014 依 D1=A 實作程式內符號重命名(D2 範圍內的 key);持久化值 `scope_violation`／`warnOnViolation` 不變,集中成具名常數。(`src/core/scope-vocabulary.ts`;不改:`scope_violation`、`violation_id`、`warnOnViolation`、HTTP API 回傳欄位 `scopeViolations`／`violations`／`violationCount`;其餘符號、IPC、i18n key、檔名、testid 皆改為 observation)

## S6 — 視覺重做(US5)

- [x] T016 產出 token／版面差異清單(implementation-notes.md);結論:#575 即現行 token,基準=現行 app,Stitch 的對比不足處不照抄(FR-011)。
- [x] T017 共用外框:標題列已是 40px(原型 h-10);狀態列 32→28px(原型 h-7),控制項保 24px 目標;側邊欄**維持 150px**——寬度是最長導覽標籤加快捷鍵欄,原型的 224/240px 只會在名稱與數字之間造成空白欄(Sidebar.tsx 註解)。尺寸由 `e2e/shared-frame.spec.ts` 鎖住。
- [x] T018 活動紀錄與時間軸頁面對齊基準。逐項比對 `app-reference` 的活動紀錄／時間軸:結構(計數行、可展開的操作組、列內時間／來源／結果碼、「在原處查看」、單軌時間軸)現行元件已具備;差異只剩兩處並已改:列間分隔由 `border`(#74747c)改為 `border-subtle`(T016 規定的列分隔),展開列加淡底色。未做:原型的「回放」按鈕屬轉錄／回放功能,不在本批;未以瀏覽器逐像素比對(只跑單元守門測試)。
- [ ] T019 其餘頁面依批次對齊(各自一個 PR)。原則(2026-11-06 使用者):**顏色與字體維持現行 token,其餘排版照原型**。已做:側邊欄(240px、標題、方框快捷鍵;T017 補)、設定首頁(#598)、HTTP 歷程標題列的常駐「擷取設定」連結。**HTTP 歷程沒有 Stitch 頁**——手上的 Stitch 只有專案啟動／選擇、設定、活動紀錄、外掛管理;能比對的只有 repo 的 `app-reference`,它與現行版面已一致(同樣八欄、表格＋詳情分割),唯一差異即上述連結。其餘頁面(目標、證據、終端、總覽)同樣需要原型才能「完全依照」,未提供前不動。
  - 外掛管理(Stitch 外掛管理頁定稿版):單欄「列表 → 詳情 → 返回」(不分寬窄)、搜尋加四個篩選分頁(全部／已安裝／官方與內建／需處理,各帶數量)、列改為整列可點(圖示、類型、狀態、摘要、識別碼;開關移進詳情)、詳情依「標頭與動作 → 專案擷取來源(僅官方整合,只顯示狀態與連結,不在此切換專案擷取)→ 權限與信任(信任狀態與「要求的權限」分開,不畫綠勾)→ 規格(收合)→ 進階試跑(收合)」排列;返回列表只在第一次由列表進入時記捲動位置。正式版的五軸診斷、同意對話框、安裝／更新／移除與錯誤處理全部保留。沒有專屬擷取來源的外掛不再顯示 project／health 兩軸。「開啟資料夾」「重新載入」兩個真實功能保留在列表頂部(原型把它們拿掉了,因為那是假按鈕;這兩個是真的)。原型的 JS 重複與假資料不採用。
- [x] T020 [US6] 設定導航改單欄(#590):`Settings.tsx` 只換導航外殼——首頁是依群組的單欄頁面清單(含搜尋),點進頁面有「← 返回設定」;各子頁元件、`SettingsPage` 型別、深層連結(`request.page`、`pluginFocus`、`captureFocus`)、搜尋索引(`searchSettings`)皆不變;`data-settings-page` 改在清單列上,新增 `data-page` 於內容區供 e2e 斷言,`openSettingsPage` helper 先回清單再進頁。窄視窗專用的 `<select>` 一併移除(單欄在任何寬度都成立)。群組沿用現有五組,未改成原型的三區塊(該分法是文案決定,另議)。

## S7 — 指令顯示(FR-013–015)

- [x] T021 Timeline:`unfinishedCommandIds` 標出無結束事件的 `command_start`,列標題與詳情顯示「執行中／狀態未知」。
- [x] T022 `CommandEndDetail` 空 STDOUT 不顯示(FR-014)。
- [x] T023 Activity 列顯示結果(FR-015):`ActivitySummary.result` 取自配對的 `command_end`。

## 收尾

- [ ] T015 五道 push gate + build;e2e;`verification.md`;Spec 069 在全部任務完成並驗證前維持 Draft。
