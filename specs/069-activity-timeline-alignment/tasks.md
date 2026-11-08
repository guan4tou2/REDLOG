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

- [x] T011 [US4] 先 RED:預設標準;切換保留選取與縮放;偏好 per-project 記住(FR-008)。  `e2e/timeline-standard-mode.spec.ts` (now in e2e/timeline-track.spec.ts) 鎖住;依賴泳道的 e2e 改用 `openSwimLanes`。
- [x] T012 [US4] 實作(D3):現有版面標為「進階泳道」,新增單軌依序的「標準時間軸」為預設。

## S5 — 識別字(FR-010)

- [x] T013 先 RED:既有事件(含 `scope_violation`)重載後 `chain.verify()` 為 ok;舊 `warnOnViolation` 的 config 仍被讀取。(`test/scope-persisted-contract.test.ts`;RED 是常數模組不存在,其餘為不變量守門)
- [x] T014 依 D1=A 實作程式內符號重命名(D2 範圍內的 key);持久化值 `scope_violation`／`warnOnViolation` 不變,集中成具名常數。(`src/core/scope-vocabulary.ts`;不改:`scope_violation`、`violation_id`、`warnOnViolation`、HTTP API 回傳欄位 `scopeViolations`／`violations`／`violationCount`;其餘符號、IPC、i18n key、檔名、testid 皆改為 observation)

## S6 — 視覺重做(US5)

- [x] T016 產出 token／版面差異清單(implementation-notes.md);結論:#575 即現行 token,基準=現行 app,Stitch 的對比不足處不照抄(FR-011)。
- [x] T017 共用外框:標題列已是 40px(原型 h-10);狀態列 32→28px(原型 h-7),控制項保 24px 目標;側邊欄**維持 150px**——寬度是最長導覽標籤加快捷鍵欄,原型的 224/240px 只會在名稱與數字之間造成空白欄(Sidebar.tsx 註解)。尺寸由 `e2e/shared-frame.spec.ts` (now in e2e/app-shell.spec.ts) 鎖住。 **更正(2026-11-07):** 側邊欄現為 240px(收合 48px),見 `Sidebar.tsx` 與 T019;上文「維持 150px」是 #590 之前的決定,已被取代。
- [x] T018 活動紀錄與時間軸頁面對齊基準。逐項比對 `app-reference` 的活動紀錄／時間軸:結構(計數行、可展開的操作組、列內時間／來源／結果碼、「在原處查看」、單軌時間軸)現行元件已具備;差異只剩兩處並已改:列間分隔由 `border`(#74747c)改為 `border-subtle`(T016 規定的列分隔),展開列加淡底色。未做:原型的「回放」按鈕屬轉錄／回放功能,不在本批;未以瀏覽器逐像素比對(只跑單元守門測試)。
  - **2026-11-08 更新(系統事件)**:截圖比對發現 RedLog 自身狀態事件(HTTP 代理啟動、出口 IP 判定、air-gap、開啟專案)以原始名稱 `system: ip_verdict` 等排在操作紀錄最上方,原型的操作紀錄只有操作。改為:這些事件有中文標題(`eventTitle`,未列出的子類型顯示「系統事件:名稱」);操作紀錄中連續 3 筆以上的系統事件收成一列「N 筆系統事件」(`activity-system-fold`,點開展開,`lib/activityFolds.ts`)。範圍觀測不收(屬於發現,不是狀態);有搜尋條件時不收;展開中的列或 Reader 所在的列所屬的段落維持展開。活動 id 與分頁不變,只在畫面上收合。測試:`test/activity-folds.test.ts`、`test/event-title-missing-fields.test.ts`。
  - **2026-11-07 更新(時間軸工具列)**:`340e4111` 當時不採用原型的範圍預設;使用者之後要求完整採用 Stitch 05 工具列,此處以此為準。兩列工具列(`timeline/TimelineToolbar.tsx`):第一列「範圍」預設(最近 1 小時／全階段／自訂區間)**寫入共用篩選**(spec 038,與篩選列同一份 `timeRange`,自訂區間共用 `TimeRangeFields`),縮放 −／百分比(唯讀 `timeline-zoom-level`)／＋／重設全貌;第二列當前錨點(未選取為「—」)、「總計 N 筆事件」只在沒有更舊事件可載入時才說「總計」(否則維持「N／M」)、標準時間軸｜多軌泳道模式、活動紀錄(App 層 `openActivity`,返回時重新聚焦當前選取)、搜尋區間。全階段的跨度(例如「25h 07m」)是 B:尚無專案跨度 API,僅在未設範圍且 `!hasMore` 時以已載入資料計算。**2026-11-08 更新(B 已做)**:新增 `events:span`(`spanEvents`,與 `events:count` 同一組條件,含範圍與層級篩選),回傳第一筆與最後一筆的時間;全階段跨度改用它,尚有更舊事件未載入時也能顯示,之後即時進來的事件以已載入範圍擴充。`events:span` 讀取失敗時退回原規則(僅 `!hasMore` 時以已載入資料計算)。測試:`test/shared-filter-tier.test.ts`、`test/timeline-project-span.test.tsx`、`test/timeline-toolbar.test.tsx`。`?` 與「⋯ 更多」(AI 逐輪、略過閒置、工作階段邊界)、跟隨徽章、載入較舊都保留。
  - **2026-11-08 更新(時間軸多軌泳道)**:使用者決定泳道模式**隱藏**底部事件列表(與 Stitch 05 原型一致);選取事件仍開啟既有詳情窗格。泳道面板標頭在 `timeline-lane-scroll` 之外(`timeline/TimelineLanesHeader.tsx`):「多軌並行泳道」、「N 軌有事件」、時間範圍(尚有更舊事件未載入時標為「已載入範圍」)、「折疊回標準流」(`timeline-lanes-collapse`,等同切換標準模式)。每軌標題為「名稱 (N 筆)」,N 只算已載入的列,未載入完時寫「N+」;不採用原型的軌道副標(「規則引擎審計守護」等,資料無法支持)。列表獨有而仍保留的兩條提示(`log-hidden-toggle`、`log-attribution-blind`)在泳道下留在泳道下方;折疊摘要與列內摘要只在標準模式可見。
- [ ] T019 其餘頁面依批次對齊(各自一個 PR)。原則(2026-11-06 使用者):**顏色與字體維持現行 token,其餘排版照原型**。已做:側邊欄(240px、標題、方框快捷鍵;T017 補)、設定首頁(#598)、HTTP 歷程標題列的常駐「擷取設定」連結。**HTTP 歷程沒有 Stitch 頁**——手上的 Stitch 只有專案啟動／選擇、設定、活動紀錄、外掛管理;能比對的只有 repo 的 `app-reference`,它與現行版面已一致(同樣八欄、表格＋詳情分割),唯一差異即上述連結。證據頁已對齊(#609)。終端機頁已對齊 Stitch:加頁首標題與「擷取說明」對話框(螢幕錄影 .cast 與指令事件 hook 兩條獨立軌),以及作用中分頁的狀態列(螢幕、Hook、目錄、結束碼;結束後保留「部分暫停／部分未錄／錄製失敗」摘要)。重啟分頁改為全新工作階段,不沿用舊分頁的錄製歷史、hook 與目錄。不採用原型的模擬錄製／PID／Session ID／計時器、固定 shell 清單與頁尾承諾文案;搜尋、字級 8–32、shell 選單維持 xterm 與真實偵測。儀表板已對齊 Stitch(最新版 868 行):加頁首標題與一行說明、快捷鍵預設收合;中繼(Pivot)由「用時間排序串箭頭」的拓撲改為偵測節點列表(工具、位址、路由欄位、最後出現),不宣稱轉送關係或通道健康;Pivot 讀取失敗與「沒有節點」分開(`usePivotRead` 有 loading／ready／error),IP 讀取失敗時節點仍獨立顯示。**儀表板版面(第二步)**:頁首加 OVERVIEW 眉標與右側「狀態以各來源最後回報為準」;網路卡改為標題「目前對外網路連線」+ 狀態標籤 + 右對齊更新時間 + 對外／內網 IP 的 kv 列;記錄概況改為大總數 + 「已上鏈／本機僅記錄(不參與鏈結雜湊)／OTS 錨定」三列 + 「查看活動紀錄」;專案摘要改為 id／名稱／操作者／範圍 kv 列,範圍未設定以警示色顯示並有「查看範圍」。OTS 只送出未確認時寫「已送出,尚未確認」,不寫「已錨定」。擷取狀態(CaptureHealth)已依原型(#622、#628):標題列(狀態色條、主句、副句、徽章)、指令與 HTTP 兩條核心列(`capture-core-commands`/`capture-core-http`)、頁尾說明、其他來源預設收合(`capture-more-sources`,展開後有說明與「管理來源」)。**更正(2026-11-08)**:此處原寫「尚未做」,是 #622 之前的紀錄。需要處理、首次使用本來就沿用既有元件與真實狀態,不動。HUD overlay(`OverlayApp.tsx`)仍有同樣的時間排序箭頭,未在本次範圍。其餘頁面(目標)同樣需要原型才能「完全依照」,未提供前不動。
  - **2026-11-08 更新(時間軸底部摘要列)**:`timeline/TimelineDetailBar.tsx` 取代「選取即開啟詳情」:單擊只選取並顯示底部摘要列,雙擊/Enter/「詳情」才開啟 `timeline-detail-body`;抵達型導航仍開啟本體;Reader 開啟狀態由 Timeline 持有(`TimelineEventDetails`/`HttpDetail` 改為可受控),不新增第二個 Reader。契約見 FR-008。測試:`test/timeline-bar.test.tsx`、`test/timeline-pan-not-click.test.tsx`、`test/detail-step.test.tsx`;e2e 中需要本體的步驟(`timeline-evidence` 的 marker-amend 與相關指令、`timeline-track` 的詳情標頭)改用雙擊。
  - **2026-11-08 更新(尺規兩端標籤)**:截圖比對時尺規最左、最右的時間標籤被切成「:12」「03:」,且因標籤以刻度置中、超出軌道,100% 時仍有幾 px 橫向捲動。改為靠近兩端的標籤向內對齊(`tickLabelAlign`,原型同此),時間軸列裁切超出內容。測試:`test/timeline-time-map.test.ts`、e2e `timeline-track`(100% 時 `scrollWidth - clientWidth <= 1`)。
  - **2026-11-08 更新(縮放 100% 即全貌、卡片列緊接尺規)**:使用者決定拿掉軌道 2000px 下限。縮放 100% 為已載入範圍剛好放進視窗(`baseTrackW` 即軌道區寬度),也是縮放下限(`MIN_ZOOM = 1`,「−」在 100% 停用;舊的 0.25 等存檔值退回 100%)。標準模式的軌道區只取尺規與單列高度,其餘高度給卡片列;兩者之間的拖曳分隔(`timeline-log-resize`)因此移除——標準模式只有一列可看,泳道模式本就隱藏卡片列。測試:`test/timeline-track-wiring.test.ts`、`test/timeline-lanes-panel.test.tsx`、`test/timeline-toolbar.test.tsx`、e2e `timeline-track`。
  - **2026-11-08 更新(時間軸密度波形與重點視窗)**:密度條改為原型的波形(SVG 面積,`lib/minimapWindow.ts`),上方標題列「事件密度分佈波形」(尚有更舊事件未載入時加「（已載入範圍）」與既有 `minimap-partial`)、已載入的時間跨度(`minimap-span`)、右側高密度事件區段(`minimap-densest`);高密度區段在波形上加深並以虛線標出該段最多事件的分格。可視範圍框即「重點視窗」(`minimap-window`):拖曳框身平移時間軸,拖曳兩側把手(`minimap-window-start`/`-end`)調整範圍,放開時依新寬度縮放(下限為最大縮放可顯示的寬度);框外仍是拖曳選取放大、點擊跳至該時間。波形分格依時間線性,與開啟「略過閒置」時的軌道位置不同,這是既有行為,未在本次處理。測試:`test/minimap-window.test.ts`、e2e `timeline-track` 的重點視窗。
  - 目標與範圍(單欄設計提案,非 Stitch 匯出稿,2026-11-06 使用者採用):兩頁共用頁首——標題、說明、「範圍規則 ↗」進設定、頁籤各帶數量(目標／範圍觀測)、範圍狀態列(已設定含允許／排除數,未設定,讀取失敗,後者不等於未設定)。目標頁:面板含標題與說明、搜尋、全部／範圍內／範圍外分段篩選(未設定或讀取失敗時後兩者停用)、整列可點、徽章(範圍內／範圍外／範圍未知)、「目前目標」徽章;「設為目前目標」「在時間軸定位」「加入授權範圍」移進展開區(加入範圍仍走延遲寫入與撤銷)。**行為變更**:沒有任何範圍規則時,目標不再顯示為範圍內,而是「範圍未知」。範圍觀測頁:範圍外觀測面板(顯示已清除改為勾選)、記錄完整性面板、規則編輯留在設定。
  - **2026-11-08 更新(單欄置中)**:儀表板(載入骨架與正式內容)與目標／範圍兩頁(頁首、目標頁、範圍觀測頁)的內容改為置中單欄,最大寬度 1080px(`lib/pageColumn.ts` 的 `PAGE_COLUMN`);只設上限,窄視窗不變。內距與捲動軸留在外層,捲動軸仍貼視窗邊緣。首次使用畫面(`FirstRunView`)與其他頁面未動。無單元測試量測這些頁的寬度;e2e 僅檢查水平溢位,不受上限影響。
  - 證據(Stitch 單欄稿定稿,2026-11-06 使用者採用;稿內兩份串接的 HTML 以第一份為準):三頁共用頁首——標題、說明(視窗太矮時收起,避免高倍率縮放把頁面內容擠出畫面)、頁籤。計數只放在整個專案可得的總數:截圖(事件計數)與書籤;戰利品頁算的是事件內的命中,另放一個數字會與頁面對不上,故不放。**截圖**:來源篩選常駐(含「全部」與各來源數量,篩成單一來源後仍可取消——舊版此時整排篩選會消失)、搜尋(檔名／雜湊／來源,只搜尋已載入的並明說)、清單／網格切換(預設清單,記在本機)、清單列(144×81 縮圖、檔名、來源、差異、時間、記錄雜湊值與「未於此處重新驗證」)、常駐的放大／複製雜湊／在資料夾顯示／刪除圖示鈕(取代 hover 才出現的 ×)、已刪除顯示「檔案已刪除 · 保留事件紀錄」。**戰利品**:頂部聲明「僅為特徵命中,不代表憑證有效」、類型篩選常駐含「全部」、搜尋、整列點開在原處展開、「在時間軸定位」改為展開區內的按鈕(舊版整張卡片一點就跳走;Enter 改為展開,⌘↩ 仍到時間軸)。**書籤**:任何寬度皆單欄(列表 → 詳情／編輯 → 返回,搜尋、捲動位置與未儲存草稿沿用),搜尋一開始就在(舊版要 5 筆以上才出現),列表顯示備註首行。**沒有採用**:原型的假縮圖(向量畫面,正式版用真實截圖)、書籤列表的 URL 參數遮蔽(原型自述不是通用清洗,且詳情本就顯示完整 URL)、假的成功提示、固定錄製狀態與示範資料、三頁共用一個錯誤開關(維持各頁各自的載入／空／失敗狀態)。
  - **2026-11-08 更新(截圖縮圖載入失敗)**:縮圖圖片讀不到時(檔案不存在、未寫入或無法讀取),原框內改顯示「無法載入圖片」(清單與網格皆然,框的大小不變),並收起需要檔案的「預覽」與「在資料夾顯示」,保留複製雜湊與刪除。這與「檔案已刪除 · 保留事件紀錄」是兩回事:已刪除由資料得知,載入失敗是畫面顯示時才發現,故不合併。測試:`test/screenshots-view.test.tsx`。
  - 外掛管理(Stitch 外掛管理頁定稿版):單欄「列表 → 詳情 → 返回」(不分寬窄)、搜尋加四個篩選分頁(全部／已安裝／官方與內建／需處理,各帶數量)、列改為整列可點(圖示、類型、狀態、摘要、識別碼;開關移進詳情)、詳情依「標頭與動作 → 專案擷取來源(僅官方整合,只顯示狀態與連結,不在此切換專案擷取)→ 權限與信任(信任狀態與「要求的權限」分開,不畫綠勾)→ 規格(收合)→ 進階試跑(收合)」排列;返回列表只在第一次由列表進入時記捲動位置。正式版的五軸診斷、同意對話框、安裝／更新／移除與錯誤處理全部保留。沒有專屬擷取來源的外掛不再顯示 project／health 兩軸。「開啟資料夾」「重新載入」兩個真實功能保留在列表頂部(原型把它們拿掉了,因為那是假按鈕;這兩個是真的)。原型的 JS 重複與假資料不採用。
- [x] T020 [US6] 設定導航改單欄(#590):`Settings.tsx` 只換導航外殼——首頁是依群組的單欄頁面清單(含搜尋),點進頁面有「← 返回設定」;各子頁元件、`SettingsPage` 型別、深層連結(`request.page`、`pluginFocus`、`captureFocus`)、搜尋索引(`searchSettings`)皆不變;`data-settings-page` 改在清單列上,新增 `data-page` 於內容區供 e2e 斷言,`openSettingsPage` helper 先回清單再進頁。窄視窗專用的 `<select>` 一併移除(單欄在任何寬度都成立)。群組沿用現有五組,未改成原型的三區塊(該分法是文案決定,另議)。**已被取代**:之後 `351b7741`(settings home follows the Stitch layout)把首頁改為原型的三區塊「擷取／專案／其他」,見 `Settings.tsx` 的 `HOME_SECTIONS`;上文「沿用現有五組」只描述 #590 當時的狀態。

## S7 — 指令顯示(FR-013–015)

- [x] T021 Timeline:`unfinishedCommandIds` 標出無結束事件的 `command_start`,列標題與詳情顯示「執行中／狀態未知」。
- [x] T022 `CommandEndDetail` 空 STDOUT 不顯示(FR-014)。
- [x] T023 Activity 列顯示結果(FR-015):`ActivitySummary.result` 取自配對的 `command_end`。

## 收尾

- [ ] T015 五道 push gate + build;e2e;`verification.md`;Spec 069 在全部任務完成並驗證前維持 Draft。
