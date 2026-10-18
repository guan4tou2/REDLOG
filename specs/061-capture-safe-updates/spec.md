# Feature Specification: 不中斷擷取的應用程式更新

**Created**: 2026-10-18
**Status**: Draft
**Input**: 參考其他桌面 App，降低更新摩擦，同時避免正在記錄的交戰被重啟中斷。

## User Scenarios & Testing

### User Story 1 — 清楚知道有沒有更新（P1）

**Why this priority**: 已安裝版、開發版和下載頁不能混為一談。
**Independent Test**: 從已安裝包的「關於」完成成功、失敗及離線三種檢查。

**Acceptance Scenarios**:
1. Given 關於頁，When 查看，Then 顯示目前版本、安裝類型、適用更新方式及上次檢查結果。
2. Given 正在檢查，When 再按檢查，Then 不重複發起流程；有可見進度或忙碌回饋。
3. Given 網路失敗、服務拒絕或沒有適用安裝包，When 檢查結束，Then 不說已是最新版；提供重試或官方下載入口。
4. Given air-gap，When 自動或手動檢查，Then 不發出更新網路請求，並說明目前政策與調整位置。
5. Given 新版本只有原始碼／tag 或其他平台安裝包，When 檢查，Then 不提供本機可直接安裝的承諾。

### User Story 2 — 下載不打斷工作（P1）

**Why this priority**: 下載同意不等於任何未來時間都同意中斷 session。
**Independent Test**: 一邊持續輸出、一邊下載，完成後仍能記錄與搜尋。

**Acceptance Scenarios**:
1. Given 有適用更新，When 選擇下載，Then 可繼續操作 App，看到進度、取消及失敗重試。
2. Given 下載完成，When 正在擷取，Then 顯示「已準備完成」，不自動重啟、不彈無法關閉的置頂視窗。
3. Given 新版待安裝，When 選擇稍後或關閉主視窗到背景，Then 擷取持續，更新入口仍可找回。
4. Given 下載中斷或完整性驗證失敗，When 重試或取消，Then 現有版本可繼續工作，未驗證檔案不得安裝。

### User Story 3 — 主動選擇重啟並知道代價（P1）

**Why this priority**: 內建終端和代理連線無法靠重開 App 自動復原原本遠端 session。
**Independent Test**: 在有終端、代理與錄影時走安裝確認，分別取消和完成一次。

**Acceptance Scenarios**:
1. Given 已準備完成，When 按「安裝並重新啟動」，Then 即時列出會結束的內建終端、代理連線與尚未完成寫入；預設動作為稍後。
2. Given 使用者確認停止並更新，When 開始重啟，Then 完成必要的證據寫入與錄影收尾，保存更新前狀態；失敗要可重試／取消，不可把未保存當成功。
3. Given 確認期間擷取狀態改變，When 執行，Then 重新確認受影響資源，不沿用過時的影響清單。
4. Given 更新後首次啟動，When 開啟，Then 確認實際版本、恢復先前專案入口並重新檢查來源；不宣稱原本 PTY／網路 session 已恢復。
5. Given 外部 shell 已載入舊 hook，When App 已更新，Then 明示需要重新載入或開新分頁；來源未驗證前不顯示已同步。

### User Story 4 — 各平台有可完成的更新路徑（P2）

**Why this priority**: 統一入口不代表假裝每個平台都支援 App 內安裝。
**Independent Test**: 每種正式安裝類型從前一版升級一次。

**Acceptance Scenarios**:
1. Given 支援 App 內更新的 Windows 安裝包，When 操作，Then 走下載／待重啟／影響確認流程。
2. Given macOS 暫無合格簽章與更新配送，When 操作，Then 明示「下載安裝檔」及替換流程；不得聲稱自動安裝完成。
3. Given Linux 由套件管理器管理，When 更新，Then 說明管理來源並提供適用操作；只有實際設定官方套件來源時才宣稱可由它更新。
4. Given 不支援自動安裝的平台，When 返回 App，Then 以實際版本判斷更新結果，保留未完成提示。

### Edge Cases

- 離線、代理限制、GitHub 限流、更新服務無回應、磁碟不足、下載取消。
- 已下載後切換到 air-gap；不得偷偷連線補檔，完整離線包仍可供操作者決定安裝。
- 多次點擊、多視窗、下載途中結束 App、App 崩潰、OS 強制結束。
- 重啟前證據收尾失敗、匯出執行中、來源持續送事件。
- 安裝失敗或啟動失敗：保留專案資料，提供官方重新安裝／診斷路徑，不自動刪庫。
- 新版資料格式不可逆：安裝前說明並保留可復原副本；不承諾任意降版可讀。

## Requirements

### Functional Requirements

| ID | 必須符合的行為 | 驗收依據 |
| --- | --- | --- |
| FR-001 | 固定版本與更新入口，顯示平台適用性、目前版、目標版、更新說明及上次檢查結果 | US1、US4 |
| FR-002 | 檢查、可下載、下載中、已準備完成、收尾中、安裝中、失敗、不可用有明確狀態；禁止重複流程 | US1.2–3、US2 |
| FR-003 | 正常連網環境預設自動檢查、手動同意下載；不得自動重啟。可關閉自動檢查，air-gap 優先 | US1.4、US2 |
| FR-004 | 下載和重啟是兩次獨立操作；完成下載不授權後續自動終止擷取 | US2.2–3、US3.1 |
| FR-005 | 重啟影響確認使用當下狀態；不以早先下載同意略過 | US3.1–3 |
| FR-006 | 重啟前保存已接受的事件、完成錄影收尾，並記錄更新前後版本與可判定的擷取中斷 | US3.2、4 |
| FR-007 | 可選的外部時間戳服務不可用，不等同本機寫入失敗；分別呈現，不要求為更新打開外連 | US1.4、US3.2 |
| FR-008 | 驗證下載完整性與發行者來源後才能執行；失敗保留現有可用安裝 | US2.4 |
| FR-009 | 更新後依實際運行版本確認成功，重新檢查代理、hook 與來源能力 | US3.4–5 |
| FR-010 | 手動下載／套件管理器路徑明示限制，不能假裝下載頁開啟等於已更新 | US4 |
| FR-011 | 沿用 App 視覺、鍵盤操作和繁中／英文；不新增不可關閉的下載浮窗 | US2、SC-004 |
| FR-012 | 更新診斷只記版本、階段、錯誤及時間，不上傳專案證據或指令輸出 | Edge Cases |

### Key Entities

- **Update candidate**：版本、適用平台／架構／安裝類型、更新說明、可取得的官方安裝包。
- **Update attempt**：檢查、下載、驗證、安裝結果與恢復操作。
- **Restart impact**：當下會停止的來源、session、錄影與未完成工作。
- **Post-update readiness**：實際版本與各來源重新驗證狀態；不等同遠端工作階段恢復。

## Success Criteria

### Measurable Outcomes

- SC-001：持續輸出期間完成下載，再等至少 60 秒，App 不重啟；期間測試序號無因下載而遺失。
- SC-002：重啟確認取消後，原本終端與代理仍可使用，擷取保持原狀。
- SC-003：對每種正式支援的安裝方式，完成前一正式版 → 候選版的實機升級、專案開啟與新事件擷取；未跑平台標 NOT RUN，不宣稱全平台完成。
- SC-004：使用者從關於頁可在三個操作內到達更新狀態或官方下載入口；檢查中、離線、下載失敗及待重啟均有明確文案。
- SC-005：更新驗收同時覆蓋無來源、內建終端、外部 shell、代理、匯出中五種情境；每種皆核對實際資料保存與影響提示。

## Assumptions

- 本規格只定更新行為，不要求為第一輪自動更新建立套件倉庫、測試通道或任意降版系統。
- macOS 自動安裝以合格簽章、配送與真機驗收為前提；未具備時保留誠實的手動路徑。
- OS 強制關機不能保證與使用者主動更新一樣的收尾，仍須在下次啟動呈現可判定的異常中斷。
- 與 [060](../060-capture-onboarding-clarity/spec.md) 共用來源狀態語義；遵守 Constitution 的 Evidence Integrity、Explicit Failure、Evidence Provenance。
- 參考 Firefox 的下載後再重啟設計、VS Code 的更新設定及 Linux 套件管理路徑；這些是設計參考，不是 REDLOG 已支援的能力。
- 參考資料（查閱 2026-10-18）：[Firefox](https://support.mozilla.org/en-US/kb/update-firefox-latest-release)、[VS Code FAQ](https://code.visualstudio.com/docs/supporting/faq)、[VS Code Linux](https://code.visualstudio.com/docs/setup/linux)。
- 手動內測僅確認 macOS 開發建置的檢查入口回覆 0.18.3；Windows 自動重啟風險來自當時 updater 程式檢查，未實機執行升級。
