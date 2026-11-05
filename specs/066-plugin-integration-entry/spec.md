# Feature Specification: 統一探索與管理入口 — 官方整合入口、雙向定位與擷取健康(B 批次)

**Feature Branch**: 建議 `feat/plugin-integration-entry-b`
**Created**: 2026-11-04
**Status**: Draft
**Input**: Spec 065 批次界線(「B:官方整合在插件頁的安裝/更新/解除安裝唯一入口;移除 `AgentsPanel` 的重複操作(改跳轉);插件與擷取來源雙向定位;官方整合衝突/錯誤納入需處理;擷取健康維度接線」)、`AgentsPanel.tsx`／`official-agents.ts`／`capture-health.ts` 現況審查。

## 決策與範圍

A 批次(Spec 065)把設定→插件做成可搜尋列表＋五軸詳情,但**官方整合(Claude Code／Codex 等 AI 擷取來源)仍留在設定→擷取來源的 `AgentsPanel`**:安裝、更新、解除安裝的按鈕在那裡,而插件頁把官方整合的列以 `isHidden` 隱藏;詳情的「安裝」軸對所有插件只說「插件資料夾」,「專案」軸指向擷取來源列,「擷取健康」軸寫「後續版本列入」。

B 批次把官方整合收斂成**一個入口**:插件頁。插件頁成為安裝／更新／解除安裝的唯一操作處;`AgentsPanel` 保留專案層級的擷取設定(工作路徑、session、每專案開關),把重複的安裝操作改成**跳到插件頁該整合的詳情**。同時接上**雙向定位**(插件 ↔ 擷取來源)與**擷取健康維度**。

範圍止於 Renderer 與既有的唯讀合併查詢;不新增可執行插件的能力、不繞過信任與稽核、不改安裝邊界(屬 C)。

### 五個維度在 B 的角色

| 維度 | 主要來源 | 狀態 | B 批次角色 |
| --- | --- | --- | --- |
| 安裝 | `officialAgents()` 目錄＋磁碟 receipt | 未安裝／已安裝／可更新／衝突／錯誤 | **B 全部呈現與操作**;未安裝的整合也要列(目前 `plugins:list` 只含已安裝者) |
| 信任 | 插件載入與信任機制 | 已授權／待授權／內容變更／停用／錯誤 | 沿用 A;官方整合為 bundled 來源,受信任狀態照實顯示 |
| 功能生效 | Contribution Report | 已接受／部分拒絕／待確認 | 沿用 A |
| 專案設定 | Project Config(`agentTailer.sources`) | 已啟用／未啟用／需重新授權 | **B 呈現**(唯讀摘要＋跳轉到擷取來源列做設定) |
| 實際擷取 | Capture Health(`agent-<kind>`) | 最近事件／長時間沒有事件／錯誤／未知 | **B 接線**(A 顯示「不適用」) |

「需處理」維持跨維度**篩選**;B 把官方整合的 `conflict`／`error`／`update-available` 納入。

### 批次界線

- **A(Spec 065,已完成)**:搜尋、需處理篩選、列表＋詳情、五軸 View Model、容器寬度布局。
- **B(本規格)**:官方整合在插件頁的安裝/更新/解除安裝唯一入口;`AgentsPanel` 去重並改跳轉;插件與擷取來源雙向定位;官方整合衝突/錯誤納入需處理;擷取健康維度接線;`AgentsPanel` 既有操作流程同步回歸。
- **C(獨立,不在本規格)** 安裝邊界:本機匯入可行性、衝突恢復與安全檢查;不覆蓋非受管檔案、不繞過信任。

### 必須保留的既有行為

- 所有插件／官方整合的狀態變更仍走既有 IPC(`plugins:installOfficialAgent`／`uninstallOfficialAgent`／`plugins:setEnabled` 等)與稽核(`config_changed` 事件);新入口不得另開繞過信任或稽核的路徑。
- 官方整合的安裝是**機器層級**變更,解除安裝前必須先說清楚什麼會停止、什麼會保留(沿用 `confirmGraded` 的 consequences 語意)。
- 信任仍是**全域**(pluginId＋內容 Hash＋Capabilities),不包裝成專案授權。
- 隱藏規則對**非官方整合**維持原樣(starter-pack、builtin-tools、pack-*、c2-tailers/pcap-capture/transparent-proxy;disabled 永遠顯示);只改變官方整合列不再隱藏。
- `AgentsPanel` 的專案擷取設定(workPaths、sessions、每專案 `enabled`、`sourceRoot`、`emitThinking`、`scopeChanged`、`captureBoundary`、last seen)行為與文字不變。
- 載入中/空/讀取失敗＋重試(read-state 矩陣)、consent dialog、容器寬度布局與窄版返回維持。

## User Scenarios & Testing *(mandatory)*

| 故事 | 優先級 | 交付階段 |
| --- | --- | --- |
| US4 在插件頁安裝／更新／解除安裝官方整合 | P0 | B |
| US5 從插件跳到擷取來源、再跳回 | P1 | B |
| US6 讀到每個來源的擷取健康 | P1 | B |

### User Story 4 — 官方整合的單一入口(P0)

操作者想知道「有哪些官方 AI 整合、哪些裝了、哪些要更新」,並在同一個地方完成安裝／更新／解除安裝。插件頁列出**每個**官方整合,包括尚未安裝的;每個整合的詳情顯示安裝狀態與對應操作;安裝／更新／解除安裝完成後,列表與詳情讀回真實狀態,而不是把按下的結果先畫上去。

### User Story 5 — 雙向定位(P1)

操作者在插件頁看到某個官方整合需要調整專案擷取,能一鍵跳到擷取來源的那一列;在擷取來源頁看到某個整合要安裝／更新,能一鍵跳到插件頁該整合的詳情。兩邊互相定位到**具體那一列**,不是只跳頁首。

### User Story 6 — 擷取健康(P1)

操作者在插件詳情讀到這個來源的擷取健康:最後一次收到事件的時間、長時間沒有事件、或最近的錯誤。**沒收到事件不等於故障**:未啟用、或本來就不該一直在跑的來源,不因沒有事件被標成故障;健康讀取失敗時顯示「狀態未知」,不把上一筆結果當成現在。

### Edge Cases

- **未安裝**的官方整合在 `plugins:list` 沒有列:不得因此讓它消失,也不得顯示成「已停用」或「已受信任」(Spec 065 FR-041:缺失與不適用可區分)。
- 官方整合 `state: 'conflict'`(磁碟上的目錄不是受管檔案／與安裝紀錄不符)或 `'error'`:列入需處理,詳情給具體訊息與可行的下一步(開啟資料夾),不提供會破壞非受管檔案的自動「修復」。
- `update-available`:需處理要算到;更新是原地換檔,失敗要回到舊版並回報(既有 `install` 的 swap/backup 語意)。
- 已安裝但專案未啟用:專案軸顯示「已安裝、未為此專案啟用」,不等於停用、也不等於健康。
- 健康快照讀取失敗:顯示「狀態未知」而非沿用舊值;不得因此把來源標成故障或解除故障。
- 官方整合在 `plugins:list` 的 id 與 `officialAgents()` 的 pluginId 相同時,合併成同一列;`agentKind ↔ pluginId` 由目錄提供,不得用字串猜。
- 從擷取來源跳轉時,若該整合未安裝(插件頁有它的列但無已載入插件),仍要定位到該列並顯示「未安裝」。

## Requirements *(mandatory)*

### Functional Requirements

#### 安裝維度與統一入口

- **FR-001** 插件頁列出每個官方整合(來自 `officialAgents()` 目錄),包括尚未安裝者;以 `pluginId` 為合併鍵,與 `plugins:list` 的同 id 插件合成**一列**,同一整合不得重複。
- **FR-002** 安裝維度顯示目錄的真實狀態:未安裝/已安裝/可更新/衝突/錯誤;未安裝不得顯示成停用或受信任。
- **FR-003** 插件詳情提供官方整合的安裝／更新／解除安裝操作,作為唯一入口;操作走既有 IPC 與稽核,完成後讀回真實狀態。
- **FR-004** 解除安裝前說明後果(什麼停止、什麼保留),沿用既有分級確認語意;`conflict`/`error` 不提供覆蓋非受管檔案的自動修復。
- **FR-005** 官方整合的 `conflict`/`error`/`update-available` 計入「需處理」,詳情給具體錯誤訊息與下一步。
- **FR-006** 安裝維度的合併資料來源不得改變既有 `plugins:list` 對一般插件的語意;新增欄位或唯讀查詢皆可,不得刪既有欄位。

#### AgentsPanel 去重與跳轉

- **FR-010** `AgentsPanel` 不再提供安裝／更新／解除安裝按鈕;保留專案擷取設定(workPaths、sessions、每專案 `enabled`、`sourceRoot`、`emitThinking`、scope 變更提示、last seen)。
- **FR-011** 需要安裝／更新／移除的整合,`AgentsPanel` 提供跳到插件頁該整合詳情的入口;不是只跳頁首。
- **FR-012** `AgentsPanel` 既有行為與文字(session 排除、scopeChanged、captureBoundary、`agent-raw-copy`)不變;專案開關語意保留。

#### 雙向定位

- **FR-020** 插件頁的官方整合詳情提供跳到對應擷取來源列的入口。
- **FR-021** 從擷取來源跳到插件頁時,定位到該整合的詳情(未安裝也要定位到該列)。
- **FR-022** 跳轉只做檢視定位,不寫入設定、不觸發擷取變更、不開啟確認框。

#### 擷取健康

- **FR-030** 詳情的「擷取健康」軸以 `useCaptureHealth` 共用快照(同一份狀態列／儀表板／設定頁)呈現:最近事件時間、長時間無事件、最近錯誤。
- **FR-031** 「沒收到事件 ≠ 故障」:健康判定同時考慮來源類型、是否應在執行(已安裝＋專案已啟用)、與 `lastError`;未啟用且從未收到不報故障。
- **FR-032** 健康讀取失敗時顯示「狀態未知」,不把上一筆結果當成現在(沿用 Capture Health 既有語意);失敗不得自行把來源標成故障或解除故障。
- **FR-033** 官方整合的專案軸顯示「已安裝/未為此專案啟用」等認知層級,與健康軸分開,不合併成單一顏色。

### Key Entities

- **官方整合列**:`officialAgents()` 的 `{ agentKind, pluginId, name, state, installationId, error }` 與 `plugins:list` 的 `PluginView` 以 `pluginId` 合併;未安裝者只有目錄側資料。
- **擷取來源列**:設定→擷取來源的 `CaptureControlPage`/`AgentsPanel`,以 `agentKind` 為鍵;與插件頁以 `pluginId ↔ agentKind` 對應。
- **健康來源**:Capture Health 的 `agent-<agentKind>` 條目(`lastEventAt`、`state`、`lastError`),由共用快照提供。
- **導航意圖**:`{ page: 'plugins'|'captureControl', focus: pluginId|agentKind }` 的檢視定位,不持久化。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- 每個官方整合(含未安裝)在插件頁只有一列;狀態與 `officialAgents()` 一致,未安裝不被誤顯示為停用或受信任。
- 安裝／更新／解除安裝只在插件頁一處;`AgentsPanel` 不再有重複的安裝按鈕,且可一鍵跳到該整合的插件詳情。
- 雙向跳轉都定位到具體列／詳情,且不改設定;未安裝整合也能被定位到。
- 衝突/錯誤/可更新出現在「需處理」,詳情有具體原因。
- 健康軸顯示最近事件／長時間無事件／錯誤;讀取失敗顯示未知;未啟用且無事件不誤報故障。
- 既有 `AgentsPanel` 專案擷取流程(session、scope、captureBoundary)、插件既有操作與 read-state 回歸全綠;五道 push gate 通過。

## Assumptions

- `officialAgents()` 目錄已回傳所有可用整合與其狀態(含未安裝),列出未安裝者不需 C 批次的安裝邊界改動。
- `agentKind ↔ pluginId` 對應由目錄提供;擷取健康已按 `agent-<agentKind>` 提供每來源資料。
- 雙向定位用設定頁既有的 `setTab` 與焦點意圖;不需要新路由或深連結。
- 不引進 Marketplace、Activation Events 或新的插件執行環境;不新增可執行程式型插件的能力。
- 驗收在 macOS 原生 Electron 進行;Windows 原生布局與安裝包由後續平台 gate 承接。
