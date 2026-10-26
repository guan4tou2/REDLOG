# Feature Specification: 紀錄工作流程與操作入口整合

**Created**: 2026-10-19
**Status**: Draft
**Input**: 全面檢查本輪討論的安裝、設定、擷取、HUD、插件與匯出，整理為規格；減少摩擦，不增加無關功能。

## User Scenarios & Testing

### US1 — 安裝後接上自己的終端與網頁（P1）

操作者使用正式安裝包建立專案，接上外部終端與需要的網頁來源，正常工作即留下紀錄。

**Why this priority**: 先確保記得到，再改善閱讀面。
**Independent Test**: 在支援的平台乾淨環境依畫面完成接入，執行測試指令及 HTTPS 請求，從保存的紀錄讀回。

**Acceptance Scenarios**:
1. 安裝包與架構相符；依賴缺少、權限拒絕、離線有可理解的原因與恢復方式；安裝完成不冒充擷取驗證完成。
2. Bash、Zsh、PowerShell 自動偵測並可手動選擇適用環境；macOS 不提供 WSL 安裝。PowerShell 不因位於 macOS 而一律隱藏。WSL 是環境，不是第四種 shell。
3. 外部終端為主要入口，內建終端保留備用；安裝後明示是否需開新分頁，收到該來源的指令及輸出後才報驗證成功。
4. 一般網頁代理的可自動安裝與啟動操作在 App 完成，不將正常流程轉到終端貼命令。需要系統授權或缺少安裝工具時，如實說明，不宣稱已完成。
5. HTTP 與 HTTPS 同頁，以 HTTPS 作主要驗證；保留 HTTP 紀錄。略過憑證檢查的測試不證明使用者瀏覽器已信任憑證。
6. 建立專案不要求啟用 AI、剪貼簿、程序／連線監看、自動 Loot；這些來源的預設關閉行為須逐項驗收。

### US2 — 從儀表板直接修改設定（P1）

**Why this priority**: 日常修復來源不必重走新手流程。
**Independent Test**: 從儀表板分別進入終端、網頁設定，修改後返回；再從首次引導完成相同行為。

**Acceptance Scenarios**:
1. 日常「擷取來源」進設定；來源專屬入口定位到對應區塊。首次引導仍可使用相同設定能力，不維護另一套語義。
2. 設定頁清楚區分本專案與本機設定，不強制指定頁數或照搬 Magpie 全部導覽。
3. 搜尋欄位能定位設定；已有搜尋與保存回饋必須保留。未完成或無效文字不可悄悄套用，儲存失敗保留輸入並可重試。
4. 切換專案不將舊表單寫進新專案；改顯示或網頁 scope 不應無故重啟擷取來源。真的需重啟時說明影響與生效時點。
5. 首次安裝步驟完成後不長期佔滿日常設定畫面；詳細命令、診斷、移除方法按需查看，仍能直接修正特定步驟。

### US3 — 正常工作，資料能可信地保存（P1）

**Why this priority**: UI 簡化不能犧牲輸出與歸屬。
**Independent Test**: 外部 shell 執行正常、錯誤、空輸出、互動、重導向及長時間指令，關閉重開後讀回；加入保存失敗情境。

**Acceptance Scenarios**:
1. 正常前景命令不要求逐條選模式或手動儲存；時間、結束碼、可擷取的輸出相連。混流不偽裝成可分離 stdout/stderr。
2. Ctrl-C、Ctrl-Z/fg、終端縮放、密碼不回顯不因錄製被破壞；未證明所有工具適用前不承諾全覆蓋。
3. 背景延後輸出能追溯原指令並依既有契約去重；不因此強迫一般使用者操作「分段模式」。
4. 檔案、截圖、錄影保留來源。時間重疊只是候選關聯，不能當成已證實由某指令產生。截圖不冒充 GUI 文字紀錄，工具輸出不冒充原始 stdin。
5. 磁碟滿、寫入失敗、附件遺失、截斷有可見且可回查的結果；來源正在跑不代表資料保存成功。
6. 未歸屬暫存不得被說成目前專案漏記；按實際計數單位與檔案時間說明，移至可清理位置。未經明確操作不刪既有資料、不歸入當前專案。
7. 已有專案身分的離線補送保持隔離；本規格不授權把不明來源資料認領到目前專案。

### US4 — HUD 看 IP，使用單一標記入口（P1）

**Why this priority**: 使用者已確認 HUD 用途與單一標記按鈕。
**Independent Test**: 使用實際桌面 HUD 點標記、展開詳細內容、取消與儲存，再測保持展開及滑鼠穿透恢復。

**Acceptance Scenarios**:
1. 保留現有 HUD 的 IP 顯示，預設開啟；不新增精簡模式，不以本次整理刪減既有 IP 功能。
2. 「快速／仔細」合為「新增標記」；彈出視窗先提供簡單輸入，詳細內容可展開，不強迫填完進階欄位。
3. 標記指向點擊當下的時間與專案；使用者取消不新增紀錄，儲存失敗不顯示成功。編輯期間專案改變不得存進另一專案。
4. 既有標記入口共用一致的欄位與驗證；原有即時標記快捷鍵可保留，不新增一套模式。完成後合理恢復原操作焦點。
5. 「保持展開」「滑鼠穿透」使用可理解名稱，與標記動作分組；穿透開啟前可知道恢復方法，實際恢復路徑有效。

### US5 — 可選插件明確安裝，按專案啟用（P1）

**Why this priority**: 使用者要求 AI 插件不預設安裝，單一總開關不符合需求。
**Independent Test**: 乾淨安裝只安裝一個 AI 擷取插件，選工作目錄後啟用；其他工具產生的對話不得被讀取或寫入。

**Acceptance Scenarios**:
1. Claude Code、Codex 作為官方可選擷取插件分別提供，預設未安裝、不載入、不監看對話；停用不能偽裝成未安裝。
2. 安裝的是 RedLog 擷取插件，不是 AI 工具本體。插件清楚說明來源、用途與支援範圍；未偵測到工具不顯示已記錄。
3. 安裝為本機層級；啟用與記錄範圍為專案層級，在同一項目可完成，不在多處維護不同語義的開關。
4. 啟用前明示會讀哪些目錄與資料。不能以空範圍悄悄代表整台電腦；無法判定工作歸屬時不自動寫進前景專案。
5. 停用停止後續讀取；解除安裝移除擷取整合但保留已保存證據。更新不能擴大授權範圍或自動啟用另一工具。
6. 可保存來源提供的訊息、工具呼叫／結果與 session 資訊；不承諾隱藏推理、原始輸入、所有桌面版／網頁版對話，也不把 AI 宣稱的執行當成獨立觀察證據。

### US6 — 同一個匯出流程交付正確範圍（P1）

**Why this priority**: 減少選擇歧義，但維持既有選取及證據契約。
**Independent Test**: 在超過一頁的結果套用篩選，從列表匯出，逐項核對檔案與預覽；重做空 scope、附件排除與失敗重試。

**Acceptance Scenarios**:
1. 各處匯出進入一致的視窗；從列表進入承接目前選取條件。選「整個專案」是明確的另一種範圍，不因換格式而擴大。
2. 格式與範圍分開選：證據包、HAR、JSON、NDJSON 保留用途說明；既有其他有用格式不因整合被默默移除。
3. 預覽顯示實際格式適用的紀錄數、條件、排除與附件，不以目前已載入頁面代表全部匹配；HAR 不使用全部事件數冒充流量數。
4. 附件承接既有選取及政策、可逐項排除；整段錄影或跨目標附件如實揭露，不聲稱已按事件篩選剪裁。
5. 空網頁 scope 在預覽明示尚未依網頁 scope 篩選，允許確認匯出或補設；不阻擋其他操作，也不聲稱已遮蔽。指令不自動套網頁 scope。
6. 預覽後新增事件、篩選變動、附件變動遵守既有預覽／執行一致性契約，不能靜默換成另一份內容。
7. 一次匯出確認後執行；系統檔案選擇器不算重複確認。失敗保留選項並可重試；成功才能顯示完成及在資料夾顯示。
8. 匯出交付不是專案備份／還原；不承諾從部分證據包還原原始完整專案。

### US7 — 退出與更新不意外中斷工作（P1，沿用 061）

**Why this priority**: 已記錄資料的保存比增加常駐狀態面板重要。
**Independent Test**: 有活動來源時下載更新、選稍後、再主動重啟；另測關閉視窗與退出。

**Acceptance Scenarios**:
1. 關閉視窗、退出、暫停擷取與暫停自動捲動語義分開。
2. 下載完成不自行重啟；主動重啟前說明當下受影響工作並完成必要收尾。
3. 更新後只針對可能受影響來源驗證；不要求每次重跑整個設定。支援平台以實際安裝包與驗收證據為準。

### Edge Cases

- 無專案、專案切換、同一工作目錄可能對應多個專案、來源晚到與舊表單。
- 路徑包含空格／中文、權限拒絕、依賴缺少、離線、安裝取消、安裝完成卻無法執行。
- 沒有輸出、非零結束碼、大量／二進位輸出、背景程序、互動終端及密碼輸入。
- 截圖空檔、附件變動／遺失、正在寫入的錄影、保存失敗、匯出取消與重試。
- 插件未安裝／停用／損壞／版本不支援；來源存在不等於讀取成功。
- HUD 真實視窗拖曳區、收合、穿透、快捷鍵、取消標記與焦點；不能僅由網頁模擬點擊宣稱通過。

## Requirements

### Functional Requirements

| ID | 必須符合的行為 | 驗收 |
| --- | --- | --- |
| FR-001 | 安裝與接入沿用外部終端優先、平台適用性及實際證據驗證 | US1.1–3 |
| FR-002 | 一般代理安裝／啟動可在 App 內完成；HTTP/HTTPS 同頁且驗證誠實 | US1.4–5 |
| FR-003 | 進階來源逐項預設關閉，不阻擋核心接入 | US1.6 |
| FR-004 | 日常來源入口直接到設定；首次引導共用相同能力 | US2.1、5 |
| FR-005 | 設定範圍、保存結果及錯誤可理解；不跨專案寫入或無故重啟來源 | US2.2–4 |
| FR-006 | 保持指令與輸出歸屬、互動行為及完整性揭露，不新增日常錄製步驟 | US3.1–5 |
| FR-007 | 未歸屬提示按真實單位顯示，不混入本專案健康度、不靜默認領或刪除 | US3.6–7 |
| FR-008 | HUD 保留 IP 用途與預設開啟，標記合為單一入口、詳細欄位展開 | US4.1–2 |
| FR-009 | 標記時間／專案固定，取消不寫入；HUD 控制名稱與恢復操作清楚 | US4.3–5 |
| FR-010 | 官方 AI 擷取插件分別安裝，未安裝不讀取；安裝不等於啟用 | US5.1–3 |
| FR-011 | 插件使用明確專案範圍，停用／解除安裝不刪證據、不擴大權限 | US5.4–6 |
| FR-012 | 匯出以單一流程分離格式與範圍，保留全部匹配結果 | US6.1–3 |
| FR-013 | 網頁 scope、附件與遮蔽說明符合實際處理，命令不被網頁 scope 靜默排除 | US6.4–5 |
| FR-014 | 匯出沿用既有一致性契約、失敗可重試、成功可找到檔案 | US6.6–8 |
| FR-015 | 退出、暫停與更新按實際影響處理，不重造更新系統 | US7 |
| FR-016 | 沿用既有視覺元件、繁中／英文與鍵盤操作；空、載入、失敗均可辨識 | US1–7、人工驗收矩陣 |

### Key Entities

- **擷取來源**：能力、所屬環境、專案範圍、已觀察結果；安裝與保存成功是不同事實。
- **設定範圍**：本機或本專案；變更生效時間與保存結果。
- **標記草稿**：來源時間、來源專案、選填內容；取消不是已保存標記。
- **可選插件**：可取得、已安裝、已啟用是不同事實；讀取範圍需明確。
- **匯出選取**：格式、範圍、附件與處理政策；遵循既有領域定義，不另造規則。

## Success Criteria

### Measurable Outcomes

- SC-001：每個宣告支援的安裝環境都有具體 PASS／FAIL／NOT RUN 證據；NOT RUN 不可算通過。
- SC-002：儀表板來源入口全部到達對應日常設定；HUD 僅保留一個一般標記按鈕。
- SC-003：未安裝的 AI 插件對測試對話資料的讀取與寫入為零；只啟用一項不連帶擷取其他工具。
- SC-004：測試匯出與預覽選取逐項相符，未載入頁面不造成遺漏；資料變動無靜默擴大或錯包。
- SC-005：所有負向情境不出現錯誤成功標示；互動終端測試不因錄製破壞操作。
- SC-006：設定搜尋、現有儲存回饋、專案隔離、HUD IP 顯示及更新兩步流程沒有退步。

## Assumptions

- 本文件是本輪工作流程整合規格，不是全產品 retro-spec；每個實作切片先對照已存在分支，不開平行重寫。
- 用戶明確要求：HUD 預設開、單一標記入口、來源進設定、mitm 直接執行、macOS 不提供 WSL、AI 插件不預設安裝。
- 草案採用的細節：標記時間取點擊當下、標題選填、保留既有快捷鍵；AI 預設從啟用時開始且不自動匯入歷史。這些是可調整設計預設，不是假稱逐項經用戶確認。
- 不預先鎖定四組設定導覽、證據包預選或記住上次格式；需以現有頁面操作驗收決定，不建立任意 4KiB、5 分鐘、固定測試人數門檻。
- 不新增 compact HUD、插件市場、模型閘道、鍵盤側錄、C2 控制、flag/proof、案件管理、報告產生器或舊版本相容 shim。
- 不刪時間軸、Transcript 或既有擷取能力；不為每個來源新增常駐狀態儀表板。桌面為產品範圍，小視窗／縮放需驗收，手機 App 不在本輪。
- 沿用 Constitution；相關既有規格為 050、051、052、056、057、059、060、061。AI 真正可選安裝比 050 個別開關更進一步，實作前須同步其契約，不能以本草案宣稱已完成。
- 領域契約：`docs/domain/SPEC-capture-source-lifecycle.md`、`SPEC-export-event-selection.md`、`SPEC-scope-evaluation.md`、`SPEC-search-query-semantics.md`、`SPEC-target-identity.md`。從專案根目錄讀取；本機舊 checkout 缺少的文件以稽核基準 commit 為準。
- 來源、程式核對、待合分支與限制見 [audit.md](audit.md)；完整人工驗收見 [manual-acceptance.md](manual-acceptance.md)。本規格不代表功能已通過驗收。

## Source placement follow-up (2026-10-24)

Official AI integrations have one actionable source entry: install/remove, choose allowed working directories, record new content, and recover a disabled integration without visiting generic plugin management. Third-party plugin controls remain machine-wide. Source installation never opts a project into capture. Source details use expandable controls; headings, buttons and state carry the ordinary workflow without repeated descriptions.

Claude/Codex source directories resolve in order: an explicit absolute project source directory, the corresponding absolute vendor environment directory (CLAUDE_CONFIG_DIR/projects or CODEX_HOME/sessions), then the vendor default. Working-directory permission remains independent. Changing the source directory stops recording until explicit reauthorization; defaults and source changes cannot import old conversation content. Detection, health and runtime must name the same directory. Original vendor transcripts are never moved or deleted.

Review all existing work/settings pages at representative desktop and narrow window sizes. This is a desktop Electron app: narrow-window coverage does not claim mobile application support. No marketplace, new AI workspace, project-data relocation or whole-app redesign is added.

User clarification (2026-10-24): AI integrations are actual optional code packages supplied offline with the app. Uninstalled providers are neither registered nor executed; installation copies only that provider. Provider identity, default/source environment paths and parsing belong to its package, not a fixed core provider switch. Loading requires valid installed bytes and explicit project permission; removal stops/unloads it and preserves all captured evidence. This does not authorize executing arbitrary third-party parser code in-process.


### 2026-10-25 — First-time internal-test handoff clarification

A novice must distinguish the supplied internal candidate from an older public
asset with the same package version. The existing About version line includes
build provenance; a modified tree and missing Git identity are explicit.
Installer use documentation is separate from source-build requirements.

Command arrival is evidence of command capture, not proof of retained output.
The existing Bash/Zsh output canary is directly visible after activation;
interactive-session guidance stays optional. This does not invent a PowerShell
output capability or redefine the shared command-evidence store.

Dependency repair lists only the currently requested command or web source.
Returning from an external prerequisite installation rechecks availability
without running an installer or granting capture. The own-browser check has a
direct verification-URL action. Its timeout starts only after the operator
initiates a check; received nonce reports may still verify a manually opened
URL. Certificate and per-client trust boundaries remain unchanged.

### Terminal app selection and prompt isolation (2026-10-25)

The operator may restrict external shell capture to a terminal application (for
example Warp), independently of selecting Bash, Zsh or PowerShell. This is a
machine preference, not engagement network scope. A specific choice excludes
unknown applications; built-in fallback capture remains available. New terminal
sessions apply the choice before registering capture hooks; already loaded hooks
must not deliver commands from an excluded application. No installer rewrites a
prompt theme. Descriptor restoration/draining must precede prompt-rendering hooks
so prompt text is neither reordered with command output nor saved as that output.
A late valid activation canary completes the same attempt after the help timeout;
retry/shell/project changes continue to invalidate the previous attempt.
