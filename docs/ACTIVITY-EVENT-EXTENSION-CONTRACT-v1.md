# REDLOG — Activity Event Extension Contract v1

**狀態：Proposed｜2026-11-05**  
本提案定義活動事件從來源接入、核心保存到閱讀的共同契約。v1 是本文件版本；儲存 envelope、事件內容 schema 與插件 API 各自管理版本。下文「須」代表目標行為。

## 1. 所有權

REDLOG 以被動記錄、可查明、不做報告為定位。Adapter 解析來源格式，提供穩定識別、來源順序、增量資料與觀測依據，並辨識來源重送。Core 依接收時的專案與權限驗證歸屬，負責持久去重、保存、完整性判定、附件存取、索引、遮蔽、關聯驗證與交付。來源回報的完整度和核心儲存／驗證結果分別記錄。Adapter 的權限止於已授權的接入介面。

## 2. 外層語意與版本

| 欄位 | 契約 |
| --- | --- |
| eventId、projectId、sourceId、sourceEventId | 核心配置穩定的邏輯事件識別。來源識別以專案、來源及 producer instance 定界，避免同名 Session 或命令碰撞。 |
| kind、schemaVersion | 保留原始 Kind 與內容版本。Adapter 版本及核心 envelope 版本分別記錄。 |
| occurredAt、receivedAt、startedAt、endedAt、timeSemantics | 核心記錄收到時間，來源提供可證實的發生與起訖時間。瞬間、區間、進行中、未知分開；缺失時間保留未知。 |
| lifecycle、sourceResult、captureCompleteness、revision | 生命週期、執行結果、內容完整性互相獨立。例如命令可已結束、Exit 1、內容完整；等待授權時結果仍待定。 |
| payload、contentRefs、metadata | 保存版本化標準內容。引用記錄類型、可用性、已知大小與完整性。原始內容依實際取得與保存政策記錄參照或缺失原因；大型內容沿用核心內容服務。 |
| relationType、targetEventId、direction、provenance | 每條關係保留方向與依據。未到達的目標暫待解析；反向導航從同一關係產生。僅時間鄰近時提供附近事件查詢。 |

## 3. 事件更新與證據

- 一次 Shell 執行或 AI Turn 在活動列表中沿用同一邏輯識別。來源提供穩定更新鍵（如片段 ID 或序號）及其所屬事件；核心第一次接受更新時記錄證據，並為邏輯事件配置遞增 revision。原始證據記錄 ID 和邏輯事件 ID 分別保留，能追溯每個修訂。
- 以來源更新鍵判定重送。同鍵同內容再次到達時回傳既有結果；同鍵異內容記錄衝突供診斷。來源無可靠鍵時須標示去重限制，相同文字可以是兩次真實輸出。
- 顯示順序採已知來源序號；核心 revision 表示接受修訂的順序。亂序抵達或重新連線時保存已見片段與缺口。完成訊號使生命週期結束；晚到輸出可補齊內容並形成新修訂，舊的 running 訊號不得讓事件重新執行。
- 持久去重與修訂提交須能在重啟後重試。最新列表與索引可由已接受記錄重建；同一事件顯示一列，歷史修訂與已保存的原始資料仍可查明。

## 4. Kind、Registry 與閱讀能力

| v1 內建 Kind | 內建 Reader | 資料重點 |
| --- | --- | --- |
| shell.execution | Command Reader | 指令、結束碼、獨立輸出流與完整性 |
| http.exchange | HTTP Reader | 實際取得的 Request／Response、重複 Header、Body 參照 |
| ai.conversation | Transcript Reader | Session、Turn 與有序訊息；Tool Call 與 Tool Result 共用呼叫識別 |
| artifact.file | Attachment Reader | 核心附件參照、大小與實際可用性 |
| observation.generic | Generic Reader | 可讀的結構化欄位、內容及關聯 |

Core 依 Kind 與 schema 版本解析圖示、軌道、搜尋欄位、適用 metadata、Reader 及交付能力。Registry 管理能力描述，事件仍由既有事件儲存管理。Scope 可作為帶規則依據的附加判定或衍生觀測。

新增同類來源只需 Adapter 與必要宣告。對可接受但未知的 Kind，保留其名稱與通用外層，透過 Generic Reader 提供基本搜尋、閱讀及交付。需要專業互動時才新增可重用的內建 Reader。插件僅宣告相容能力；第三方可執行 Reader 須另提隔離與權限設計。

## 5. 歷史閱讀、UI 與權限

- 在保存當下留存標準化內容、schema 版本、來源出處與原始資料／附件參照。停用、移除或升級插件後，核心仍可解讀標準內容及重建索引。未知版本走通用閱讀；依既有留存政策已不存在的內容呈現其可用性。
- 顯示、搜尋摘要、複製及一般匯出採用一致的遮蔽政策。原始資料交付是獨立、具權限與範圍的操作。核心依實際結果判定已保存或已驗證。
- 全寬列表負責查找，獨立時間軸呈現區間與並行，浮動 Inspector 提供相關摘要，單欄 Reader 閱讀已保存內容。四者共用選取事件、修訂與返回位置。Stitch 負責畫面與互動範例。
- 先完成核心 Registry，再版本化開放宣告。保留既有 Manifest 驗證、權限與信任檢查，包含對未實作 mappers、exporters 的拒絕。第一階段僅接受可驗證資料，禁止第三方注入 React、HTML、JavaScript 或直接存取專案 SQLite。

## 6. 與現有程式對照

以下依本機 f51037e0 原始碼盤點。實作前在目標分支補齊實際資料流與 fixture。

| 已有機制 | v1 接合點與待證事項 |
| --- | --- |
| [ingest](../src/core/ingest.ts)、[事件與 envelope](../src/core/db/event-types.ts) | 沿用接收政策、既有分級保存、rawRef、mapper 版本與 tsSource。核對 engagementId、id、timestamp、createdAt 的產生位置，再決定邏輯 ID、修訂及 receivedAt 的實際映射。 |
| [事件註冊表](../src/core/event-registry.ts)、[插件註冊與移除](../src/core/plugins/contributions.ts)、[Manifest 驗證](../src/core/plugins/manifest.ts) | 現有註冊依 agentType 提供呈現資訊；解除註冊後，歷史閱讀需靠核心保有的 Kind、版本與標準內容。另驗證能力衝突及不相容版本。 |
| [內容契約](../src/core/content-contract.ts)、[內容讀取與定位](../src/core/evidence-content.ts)、[內容另存](../src/core/saved-content-delivery.ts) | 重用 ContentRef、分段讀取、欄位內查找及內容錨點。跨事件全文索引、遮蔽後搜尋與各交付入口的一致性須另行驗證。 |
| [活動工作區](../src/renderer/src/components/RecordingWorkspace.tsx)、[時間軸](../src/renderer/src/components/Timeline.tsx)、[Transcript](../src/renderer/src/components/TranscriptView.tsx) | 盤點來源條件與既有 Session 導航。以共用投影接入 Reader，使用真實保存資料比對內容及返回行為。 |

## 7. 交付順序與驗收

0. **盤點**。在目標 main 產出新舊欄位、寫入路徑、權限及既有 Reader 對照表。
1. **核心契約**。先用重送、亂序、完成後晚到及重啟案例驗證修訂，確認最新投影與歷史證據均可重建。
2. **Registry**。接入 Kind 分派、搜尋、時間軸及 Generic Reader。以一個未知 Kind 驗證基本搜尋、開啟內容與另存。
3. **內建 Adapter**。以 Claude Code、Codex 建立基線，再加入第三個 AI 測試來源。驗收差異限於 Adapter、必要宣告與測試；活動列表、時間軸、Inspector、Transcript Reader 均無來源專屬修改。再依序驗證 Shell、HTTP、附件與一般觀測。
4. **Manifest**。測舊插件、版本不相容、拒絕未實作欄位、權限變更與單來源故障。只有相容性及隔離回歸通過才發布新宣告。

整合驗收還須實際完成下列路徑：

- 停用／移除插件並重啟，重建索引後搜尋、閱讀及另存舊資料，核對標準內容與原始參照。
- 搜尋測試 HTTP Request、Response 及 AI Tool Result 中僅出現在完整已保存內容的字串，開啟後定位正確片段；受政策限制或部分索引須清楚呈現範圍。
- 在 running、waiting、ended 與截斷的組合下，比對列表、時間軸、Inspector 與 Reader 的事件身分、修訂與狀態。
- 使用測試敏感值核對顯示、複製及一般匯出結果；注入跨專案參照、失敗 Adapter 及未授權宣告，確認核心拒絕越權且其他來源仍能寫入與閱讀。

詳細分批任務與驗收矩陣見[實作計畫](SOURCE-EXTENSION-CONTRACT-PLAN.md)。
