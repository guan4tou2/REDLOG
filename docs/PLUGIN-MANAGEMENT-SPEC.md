# REDLOG 插件探索與管理規範

> 遠端同步校正（2026-11-04）：本文件原檢查基準為 f51037e0。同步時遠端 main 已為 eaa40e46（PR #567），Spec 065 插件 A 批次搜尋、需處理與列表/詳情已合併；B/C 與完整驗收仍未完成。舊文中的「尚未實作／最新 spec 到064」是當時快照，不代表目前遠端。詳見 UIUX-SYNC-STATUS.md。
狀態：Draft（待實作；非 Verified）
GitHub issue：https://github.com/guan4tou2/REDLOG/issues/568
日期：2026-11-04
基準：main f51037e07c3b6fe199338769eb809d1830dfda40
範圍：插件管理 UI、官方可選整合、與擷取來源的導航契約。

## 1. 目的與既有能力
讓使用者找到可安裝能力、理解安裝及信任狀態，並直達專案擷取操作。保留既有插件核心與設計系統。
PluginsPanel 已有授權、撤銷、全域停用、contribution 診斷及請求順序保護。
official-agents 已有官方隨包目錄、安裝紀錄、checksum、衝突判斷、安裝、更新及解除安裝；不得重建另一套。
目前信任為全域內容 hash/capabilities 授權，不是專案信任。

## 2. 管理責任與遷移
- 設定 → 插件：探索、安裝、更新至隨附版本、解除安裝、全域信任及診斷。
- 擷取來源：專案範圍、啟用/停用、驗證、最近收到的證據。
- 插件詳情僅讀取專案擷取狀態，提供「管理擷取來源」定位連結，不複製專案開關。
- #435 曾規定來源頁是官方 AI 唯一操作入口。本規範提出新的安裝入口安排，必須與來源頁在同一批次遷移：來源頁安裝控制改為直達指定插件的連結，安裝完成可返回原來源。
- 不新增主 Sidebar 插件入口；不讓 plugin/pack/member 變成三道必開開關。
- 無專案時可管理本機安裝，專案操作顯示需先選擇專案。
- 全域撤銷/停用/解除安裝須顯示全專案影響，不能誤稱本專案停用。
- 內建功能不一律重新變成插件開關；必要異常與恢復入口不得被隱藏。

## 3. 功能需求
P01 搜尋名稱、用途、pluginId；已安裝/可用整合是列表範圍，「需處理」為可疊加篩選。
P02 以 pluginId 合併一般插件與官方目錄，同一插件只一列；agentKind 僅作官方管理器映射。
P03 桌面列表/詳情；窄視窗採單頁切換，返回保留條件、選取、位置。沿用 Button/Modal/FieldGroup、tokens、密度。
P04 列表呈現用途與主要異常；詳情呈現版本、來源、實際生效能力、權限、修改範圍及可執行動作。
P05 狀態分為 installation、trust、contribution、project capture 四個維度；active 不等於正在擷取，heartbeat 不等於資料完整。
P06 需處理包含待授權、hash 變更、錯誤、衝突、API 不相容與部分 contribution 被拒絕；正常停用不算故障。更新另行標示。
P07 安裝成功後重新讀取權威狀態；不自動啟用專案。使用現有 manager 執行隨附版本更新。
P08 未知/讀取失敗/無資料/無搜尋結果必須可區分；錯誤保留重試與原因。
P09 既有安全對話框焦點、Escape 取消、禁止誤觸背景授權等行為保留；不得提供注定被拒絕的第三方 tailer 執行授權。
P10 取消、失敗、部分變更依後端結果刷新；保留舊請求不得覆蓋新狀態的保護。
P11 對外導覽使用穩定 pluginId/sourceId 與返回位置，不依顯示名稱尋找；無效 ID 顯示可返回列表的結果。
P12 本機匯入延後至確認安全安裝 API；現階段保留資料夾/重新載入，不新增空按鈕。
P13 權限、資料來源與修改範圍只呈現已驗證資訊；未知保留未知，不能從作者欄位推斷官方身分。
P14 進階收合只容納次要診斷/樣本測試；阻斷原因及下一步不可收起。

## 4. 後端與資料契約
沿用既有 IPC/manager，新增薄的 view model；renderer 不直接讀取檔案或維護第二份真相。
官方目錄回傳的版本、作者、說明由受驗證 Manifest 補齊。
狀態更新後使插件列表與來源頁快取失效；專案切換隔離請求與快取鍵。
安裝目錄衝突不得自動覆蓋；解除安裝不得刪原始事件、附件或證據鏈。
trust 內容變更沿用重新確認機制，不能因 UI 搬遷而遷移為自動同意。
若後端尚無可靠停止/卸載協調，先補齊在用來源與解除安裝順序，不能只讓 UI 先消失。

## 5. 分批交付
A：列表、搜尋、詳情、需處理篩選與既有行為回歸。
B：官方目錄合併、安裝/更新/卸載與來源頁雙向定位，遷移舊安裝控制。
C（後續）：本機匯入與更完整失敗恢復；須先核對 API 與檔案安全邊界。
不包含：Marketplace、遠端 registry、自動更新、任意版本切換、第三方 executable host、Activation Events、新 Parser/Exporter/UI API、專案層級 trust。
manifest.ts 明確拒絕未實作 mappers/exporters，不能包裝為已有功能。

## 6. 驗收
- [ ] 搜尋及篩選不隱藏必要故障；無結果與載入失敗不同。
- [ ] 官方整合安裝後僅一列；重啟後狀態一致。
- [ ] 安裝不擴大專案授權；切換專案不殘留上一專案狀態。
- [ ] 來源 → 指定插件 → 安裝 → 返回指定來源 → 啟用 → 真實事件保存並可閱讀。
- [ ] 更新、衝突、hash 變更、部分 contribution 拒絕均顯示正確動作。
- [ ] 解除安裝中途失敗、撤銷後 profile 同步失敗不宣稱完整成功。
- [ ] 原始證據保留、第三方 tailer 邊界不退化。
- [ ] 鍵盤選取、焦點返回、中英文、空/載入/錯誤、桌面及窄視窗可操作。
- [ ] 既有選取/請求競態測試通過，Electron 實際操作受影響路徑。
實作時按 CLAUDE.md 跑 typecheck → verify:specs → verify:architecture → verify:i18n → npm test，及相關 E2E。此文件建立不代表以上已通過。

## 7. 證據與關聯
- [PluginsPanel](https://github.com/guan4tou2/REDLOG/blob/f51037e07c3b6fe199338769eb809d1830dfda40/src/renderer/src/components/settings/PluginsPanel.tsx)
- [官方 manager](https://github.com/guan4tou2/REDLOG/blob/f51037e07c3b6fe199338769eb809d1830dfda40/src/core/plugins/official-agents.ts)
- [Manifest](https://github.com/guan4tou2/REDLOG/blob/f51037e07c3b6fe199338769eb809d1830dfda40/src/core/plugins/manifest.ts)
- [trust](https://github.com/guan4tou2/REDLOG/blob/f51037e07c3b6fe199338769eb809d1830dfda40/src/core/plugins/trust.ts)
- [VS Code Extensions](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)：參考搜尋、列表、詳情；不照搬權限模式。
- #435 來源管理、#546 狀態/閱讀契約、#557 來源導航、#499 工具 profile。沿用其既有工作，不重開相同缺陷。

