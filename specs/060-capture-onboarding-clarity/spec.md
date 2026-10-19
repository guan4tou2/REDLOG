# Feature Specification: 低摩擦擷取設定與完整性呈現

**Created**: 2026-10-18
**Status**: Draft
**Input**: 將手動內測發現整理成可實作、可驗收的規格；外部終端優先，清楚回答到底記到了什麼。

## User Scenarios & Testing

### User Story 1 — 第一次接上自己的終端（P1）

操作者建立專案後，不需要先理解證據鏈、外掛或 CA，就能選擇自己的 shell 並確認記錄。

**Why this priority**: 先有可靠的指令與輸出，再進行其他設定。
**Independent Test**: 在乾淨使用者環境，由未看過程式的人照畫面完成外部終端接入。

**Acceptance Scenarios**:
1. Given 新專案，When 建立完成，Then 首屏提供「記錄我的終端」「記錄網頁流量」，不自動打開內建終端。
2. Given 偵測到 Zsh，When 改選 Bash，Then 安裝位置、前置需求、驗證指令均跟隨 Bash，Zsh 的事件不算 Bash 成功。
3. Given hook 安裝成功，When 尚未收到事件，Then 顯示「已安裝，等待新終端」，不顯示已記錄輸出。
4. Given 開新分頁並執行畫面上的驗證，When 收到指令及預期 stdout/stderr，Then 分別顯示指令、輸出驗證結果與來源；輸出未到要有下一步。
5. Given 中途離開或關閉 App，When 再進入專案，Then 可在固定「擷取設定」入口續做；不得因內建終端成功就把外部終端標成成功。

### User Story 2 — 設好網頁擷取但不迷失在憑證細節（P1）

**Why this priority**: 自用瀏覽器是主要路徑，安裝 CA 不代表已擷取到流量。
**Independent Test**: 對一個指定瀏覽器完成代理設定及 HTTPS 驗證，並讀回測試請求。

**Acceptance Scenarios**:
1. Given 未設定瀏覽器，When 開啟網頁卡片，Then 只展開當前步驟：代理 → 憑證 → 驗證；CA 指紋、手動命令、移除方法可按需展開。
2. Given HTTP 已收到但 HTTPS 未通，When 查看結果，Then 網頁卡片不得顯示 HTTPS 已驗證；HTTP 原始紀錄仍保留。
3. Given 憑證驗證被略過的測試客戶端，When HTTPS 通過，Then 只能說該路徑收到 HTTPS，不宣稱使用者瀏覽器已信任 CA。
4. Given 設定失敗，When 逾時，Then 依已知證據提示未經代理、憑證問題、暫停或原因未知；不得從逾時猜定原因。
5. Given 已接上的瀏覽器，When 測試一筆回應不超過 4 KiB 的文字流量，Then 一次選取事件即可讀到完整 body，不再按第二次載入；較大 body 明示預覽大小及完整內容入口。

### User Story 3 — 知道記錄的邊界並交付證據（P1）

**Why this priority**: 「有畫面」和「證據已保存」不能混為一談。
**Independent Test**: 手動執行正常、錯誤、互動、重導向指令，讀回紀錄並匯出核對。

**Acceptance Scenarios**:
1. Given 有 stdout 與 stderr 的指令，When 結束後讀回，Then 指令、時間、結束碼及輸出可取得；若混流則明示混流，不捏造兩條獨立串流。
2. Given 互動輸入，When 查看證據，Then 區分指令文字、終端回顯、輸出與錄影；只有輸出包含輸入字串，不得宣稱已擷取原始 stdin。
3. Given 超過擷取上限或背景命令仍在輸出，When 查看完整性，Then 顯示截斷、持續記錄或分段狀態；跟隨片段能連回來源指令。
4. Given 網頁 scope 空白，When 預覽匯出，Then 說明網頁流量尚未依 scope 篩選，可確認匯出或補設；不得同時聲稱「範圍外已遮蔽」。
5. Given 已設網頁 scope，When 匯出，Then 指令與輸出不自動套用網頁 scope；錄影與附件逐項選擇，預覽與交付一致。
6. Given GUI、檔案輸出或互動工具未被該來源涵蓋，When 查看來源能力，Then 明示要另加附件、截圖或 session 錄影，不宣稱全部已記錄。

### User Story 4 — 只看需要的設定（P2）

**Why this priority**: 降低認知負擔，不增加設定頁數。
**Independent Test**: 在 macOS、Windows、Linux 個別查看預設設定頁。

**Acceptance Scenarios**:
1. Given macOS，When 開啟指令設定，Then 優先顯示適用 shell；Windows 專用步驟收在其他平台，不佔主要流程。
2. Given 尚未啟用 AI、剪貼簿、程序、連線或自動 Loot，When 首次設定，Then 不要求設定它們；進階來源預設關閉，秘密遮蔽不因此被關閉。
3. Given 一般代理收到 HTTP，When 透明代理從未啟動，Then 透明代理不得顯示曾經擷取；同類事件不能替另一來源提供驗證。
4. Given 停止捲動，When 查看狀態，Then 顯示「自動捲動已暫停」，與「擷取已暫停」分開。

### Edge Cases

- 未支援的登入 shell、同時安裝多個 shell、WSL 與主機各自安裝、無權限寫入 profile。
- 驗證期間切換 shell／專案、代理重啟或 CA 改變、事件晚到、讀取狀態失敗。
- 指令輸出為空、非零結束碼、二進位、大量輸出、背景輸出、Ctrl-C、Ctrl-Z/fg。
- 密碼／不回顯輸入不得為滿足「完整」而新增按鍵監聽；原始證據中已含敏感資料仍依現有保護策略處理。
- 匯出時仍寫入的錄影、遺失附件、磁碟滿、寫入失敗與來源閒置。

## Requirements

### Functional Requirements

| ID | 必須符合的行為 | 驗收依據 |
| --- | --- | --- |
| FR-001 | 外部終端優先；內建終端是明確備用入口；Bash、Zsh、PowerShell 各自適配 | US1.1–4 |
| FR-002 | 自動偵測可手動改選；顯示實際安裝位置、重新開終端與移除方法 | US1.2–3 |
| FR-003 | 安裝、來源存活、指令收到、輸出收到、歷史成功是不同事實；顯示驗證時間及來源 | US1.3–5、US4.3 |
| FR-004 | 擷取設定可隨時重入；部分成功允許開始工作，未完成項可追蹤 | US1.5 |
| FR-005 | 一張網頁卡涵蓋 HTTP/HTTPS，以 HTTPS 驗證為主要完成條件；保留客戶端及 CA 限制 | US2.1–4 |
| FR-006 | 小文字 body 直接完整呈現；UI 預覽省略與原始擷取截斷使用不同文案 | US2.5、US3.3 |
| FR-007 | 每條路徑公開輸入／輸出／錄影／檔案能力與限制；不把回顯當原始輸入 | US3.1–3、6 |
| FR-008 | 非標的排除作用於閱讀與交付，不因此停止本機擷取；指令不套網頁 scope | US3.4–5 |
| FR-009 | 匯出說明依實際選取與處理結果產生；空 scope 不聲稱已遮蔽 | US3.4–5 |
| FR-010 | 設定依平台、來源啟用狀態漸進展開；進階來源不阻擋核心設定 | US4.1–2 |
| FR-011 | 狀態按來源識別；一般代理事件不替透明代理或另一 shell 作證 | US4.3 |
| FR-012 | 未知、失敗、閒置、停用、等待驗證有不同提示與可行恢復操作 | US1.3、US2.4、Edge Cases |
| FR-013 | 優先沿用現有元件與繁中／英文文案；鍵盤可完成流程，焦點在步驟切換後合理保留 | SC-003 |
| FR-014 | HUD 預設開啟；使用者可在設定關閉並保留自己的選擇（2026-10-18 營運者決定，取代原「首次設定不自動彈 HUD」） | US1.1 |

### Key Entities

- **Source capability**：來源能提供的指令、輸出、回顯、錄影、附件及限制。
- **Verification result**：專案、來源、shell／環境、驗證時間、收到的證據種類及有效條件。
- **Capture completeness**：完整、截斷、仍在擷取、分段、未擷取、失敗或未知。
- **Export disclosure**：實際套用的網頁 scope、排除、附件與未處理範圍。

## Success Criteria

### Measurable Outcomes

- SC-001：3 位未參與開發的測試者，在依賴已備妥的環境，各於 5 分鐘內完成一種外部 shell 的指令及輸出驗證；不得由測試員補充畫面外命令。
- SC-002：來源錯配、HTTP-only、空 scope、擷取截斷四類負向案例，不得出現錯誤成功／完整標示。
- SC-003：1280×800、800×600 與 150% 縮放下，主要按鈕可見或可自然捲動到達，無全頁橫向捲動；Tab 可到達每個互動元件，錯誤不只靠顏色。
- SC-004：驗收矩陣全部記錄 PASS／FAIL／NOT RUN；任何 NOT RUN 不得以「全平台完整擷取」交付。最低矩陣見 manual-acceptance.md。
- SC-005：測試包內的已選指令、輸出、HTTPS body 與附件，逐項可對回預覽與原始記錄；缺漏有明確說明。

## Assumptions

- 桌面 App 為範圍；手機不列本次實作平台。
- 不新增按鍵側錄、C2 框架適配器、封包引擎或外掛市場；已有進階來源只整理呈現。
- 不重做已落地的擷取引擎；以現有能力為基礎修正設定、驗證與完整性揭露。
- 060 接續 059、049、052、056；不改變來源證據、專案隔離和 ExportPlan 的既有契約。
- 自動更新另見 [061](../061-capture-safe-updates/spec.md)。採 Constitution 的 Evidence Integrity、Surface Truthfulness、Explicit Failure 與 Preview/Execute Consistency。
- 基準為 2026-10-18 對 c429fb3e 建置的手動內測；建置時存在 Bash 未提交修改。撰寫時 HEAD 已為 23a15aec，後續變更未重新全面驗收，不能把本文件的發現當成最新 HEAD 全部仍可重現。
