# Feature Specification: 統一探索與管理入口 — 插件列表與詳情(第一輪 A)

**Feature Branch**: 建議 `feat/plugin-explore-and-manage-a`
**Created**: 2026-11-04
**Status**: Draft
**Input**: 使用者提供的插件面板重整規劃(「統一探索與管理入口」方案與五項實作契約)、`PluginsPanel.tsx` 現況審查、`LAYOUT-RELIABILITY.md` 的容器寬度布局慣例。

## 決策與範圍

RedLog 的插件管理目前的設定→插件頁是一列一列展開的平面清單:`ContributionResults` 把整個診斷內嵌在每列的標題下,列一長資訊就全擠在一起;沒有搜尋、沒有「需要處理」的彙整、也沒有獨立的詳情檢視。官方整合(AI 擷取來源)的安裝、更新、解除安裝已在設定→擷取來源的 `AgentsPanel` 完成,不重做、不複製。

本規格(Speek 065,批次 A)把設定→插件改成**可搜尋的列表＋詳情**,並建立**分層狀態 View Model**——把「安裝、信任、功能生效、專案設定、實際擷取」五個維度分開呈現,不壓成單一 status。範圍止於 Renderer UI 與資料合併契約;官方整合的統一安裝入口、與擷取來源的雙向定位、以及安裝邊界由後續批次承接(見「批次界線」)。

### 五個維度

| 維度 | 主要來源 | 狀態 | A 批次角色 |
| --- | --- | --- | --- |
| 安裝 | 官方整合管理器 `official-agents` | 未安裝/已安裝/可更新/衝突/錯誤 | 契約先定;行目前由 `AgentsPanel` 擁有(`isHidden` 維持隱藏),B 批次併入時以 pluginId 合併 |
| 信任 | 插件載入與信任機制 | 已授權/待授權/內容變更/停用/錯誤 | A 全部呈現(`status` 軸) |
| 功能生效 | Contribution Report | 已接受/部分拒絕/全部拒絕/待確認 | A 全部呈現(`report` 軸);`report === null` 是「尚無診斷」,不是全部成功 |
| 專案設定 | Project Config(`agentTailer.sources`) | 已啟用/未啟用/需重新授權 | 契約先定;數值主要在 B 批次(AgentsPanel 既有) |
| 實際擷取 | Capture Health | 最近收到事件/長時間沒有事件/錯誤 | A 先不接線;「沒收到事件 ≠ 故障」的健康判定(來源類型＋執行狀態＋錯誤)屬後續契約 |

「需處理」是跨維度**篩選**,不是新的第五個 status。清單見「需處理」章節。

### 批次界線

- **A(本規格)**:搜尋、需處理篩選、列表＋詳情、分層 View Model、布局依內容容器寬度。
- **B(下一批,不在本規格)**:官方整合在插件頁的安裝/更新/解除安裝唯一入口;移除 `AgentsPanel` 的重複操作(改跳轉);插件與擷取來源雙向定位;官方整合衝突/錯誤納入「需處理」;擷取健康維度接線。原 `AgentsPanel` 操作流程須同步重驗證。
- **C(獨立)** 安裝邊界:本機匯入可行性、衝突恢復與安全檢查;不覆蓋非受管檔案、不繞過信任。

### 必須保留的既有行為

- 隱藏規則(`isHidden`):official agent 行、`OWNED_ELSEWHERE`(starter-pack、builtin-tools、pack-*、c2-tailers/pcap-capture/transparent-proxy)維持現狀——隱藏的是**選擇**,不是**狀態**;disabled 的行永遠顯示。
- 啟用/停用、信任授予/撤銷、reload、open folder、consent dialog 的既有語意與稽核(`config_changed` 事件)不因換版式而繞過現有 IPC。
- 載入中/空/讀取失敗＋重試狀態保持(read-state 矩陣既有契約)。
- 授權是**全域**的:插件信任綁 pluginId＋內容 Hash＋Capabilities,不包裝成專案層級授權,也不在 UI 上如此宣稱。

## User Scenarios & Testing *(mandatory)*

| 故事 | 優先級 | 交付階段 |
| --- | --- | --- |
| US1 搜尋插件、US2 需要處理的插件一眼看到 | P0 | A |
| US3 讀完整診斷不遺失 | P1 | A |

### User Story 1 — 搜尋插件(P0)

操作者裝了幾個插件後想在設定→插件找特定一個。輸入名稱、id、作者、描述、capabilities 或 contributes 的任何片段都能即時縮小列表;內建 pack 的英文 manifest 描述以既有翻譯行呈現,搜尋也能命中。找不到時顯示空結果,而不是整個列表消失。

### User Story 2 — 需要處理的插件一眼看到(P0)

操作者想知道「現在哪個插件要我決定」。頁面提供「需處理」篩選,列出任何維度有異常的行:待授權、內容變更、載入錯誤、contribution 被拒/部分被拒、API 版本超前、Terminal profile 未套用。篩選開啟時顯示計數;沒有待處理項時顯示「全部已處理」而不是空列表。列表上每行只顯示**最重要的一項異常**,完整診斷在詳情。

### User Story 3 — 讀完整診斷(P1)

操作者在詳情看到這個插件的完整故事:載入與信任狀態、每類 contribution 的 accepted/rejected/waiting(含被拒項目的名稱與原因)、宣告的 capabilities、審核內容(terminal profiles 與 capture installs)、以及載入失敗或 API 版本超前的具體訊息。`report === null` 時明確顯示「尚無診斷結果」,不顯示成「全部成功」。

### Edge Cases

- 無描述、多 capabilities、超長被拒清單:詳情內有界捲動,列表截斷但不吞診斷。
- `apiAhead`:宣告式插件「讀已知部分」仍列入與可搜尋;程式型插件是 `error`,需處理照算。
- `profilesError`(shell 的 profiles 快照沒更新):同一份錯誤對所有行成立,詳情照實呈現,不冒充插件自身錯誤。
- disabled 且 `OWNED_ELSEWHERE`:該行仍顯示(可能是唯一能復原它的入口)。
- 官方 agent 行(現階段隱藏):View Model 以 pluginId 為鍵,保證未來 B 併入時**同一插件只有一列**、不重複。

## Requirements *(mandatory)*

### Functional Requirements

#### 列表與辨識

- **FR-001** 列表以 pluginId 為唯一鍵去重;任何資料來源(一般 plugin、官方 agent、capture pack)未來併入時合併到同一行,不得產生重複列。
- **FR-002** 行內保留:名稱、版本、信任狀態徽章、privileged tier 警示、單行異常摘要;描述與貢獻摘要僅在詳情完整展開。
- **FR-003** 每行只顯示最重要的一項異常作為摘要;其餘診斷在詳情(「診斷不遺失」以詳情完整呈現為準)。

#### 搜尋與篩選

- **FR-010** 單一搜尋框即時過濾,比對欄位:名稱、id、作者、描述、capabilities、contributes 種類;內建 pack 以翻譯後描述行比對。
- **FR-011** 「需處理」篩選:任一維度有異常的行。異常定義至少涵蓋:載入錯誤、hash 變更待重授、待授權、apiAhead、contribution 被拒/部分被拒/等待、profilesError。篩選器顯示計數;開啟且無結果時顯示「全部已處理」。
- **FR-012** 篩選與搜尋可並用(交集);清空任一不互相重置。

#### 詳情

- **FR-020** 單一詳情檢視,不做內部頁籤、不堆疊多張卡片(AGENTS.md:避免巢狀卡片與重複控制項)。
- **FR-021** 詳情呈現全部五維度分區(安裝/信任/功能生效/專案設定/擷取健康),各維度狀態獨立顯示,不得合併成單一 status 顏色。
- **FR-022** 功能生效區逐類列出 accepted/rejected/waiting 與每項被拒名稱＋原因;`report === null` 顯示「尚無診斷」。
- **FR-023** 詳情保留對該插件的操作(啟用/停用、授予/撤銷信任、reload),與列表操作一致,不另造第二套。

#### 布局

- **FR-030** 列表與詳情的並排/切換依**內容容器寬度**(`useContainerWidth`,非視窗寬度)決定:充足時並排,不足時切換並提供明確返回;不產生第三層 sidebar。
- **FR-031** 詳情在窄布局卸載時不遺失:重新進入同一插件顯示同一份資料(狀態由列表資料重建,不做局部快照)。

#### 狀態 View Model

- **FR-040** Renderer 建立薄 View Model(非合併欄位),以 pluginId 鍵入;維度來源各自為陣列/物件,不拼成單一 status 字串。
- **FR-041** 維度資料缺失與「該維度不適用」要可區分(例如未安裝的官方整合不顯示「已停用」)。

### Key Entities

- `PluginViewModel`:以 `pluginId` 為鍵的五維度聚合(install/trust/effect/project/health),資料來自 `plugins:list` 的 `PluginView`(含 `status`、`report`、`profilesError`、`apiAhead`)與後續批次接上的 `officialAgents.list()`、capture health。
- `needsAttention(p)`:由各維度異常推導的純函式,決定「需處理」篩選與單行異常摘要。
- 列表/詳情切換狀態:僅為 UI 呈現狀態,不寫入設定;由容器寬度 hook 驅動。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- 搜尋任一可搜尋欄位的片段,命中且不再要求先看到全列表。
- 「需處理」計數與內容一致:每一異常行都被列出,無異常行不誤列;清空後顯示「全部已處理」。
- 任一插件的完整診斷(全部 contribution 群組、被拒原因、profilesError、error)都能在詳情讀到;`report === null` 不顯示成成功。
- 同一插件在全頁只出現一次;UI 版式重排(寬↔窄)後詳情資料一致、返回可達。
- 既有操作(啟用/停用/信任/撤銷/reload/open folder)與 read-state(載入/空/失敗＋重試)行為回歸全綠;五道 push gate 通過。
- A 驗收不依賴官方整合安裝操作;該部分屬 B。

## Assumptions

- 不引進 Marketplace、Activation Events 或新的插件執行環境。
- 「需處理」計數是即時運算,不另存狀態;插件清單已由 `plugins:list` 全量回傳,無需新 IPC。
- 官方整合的專案擷取開關與擷取路徑設定留在 `AgentsPanel`,插件頁不複製(B 只把安裝/信任管理搬來並跳轉)。
- 詳情版式的驗收在 macOS 原生 Electron 進行;Windows 原生布局由後續平台 gate 承接。
