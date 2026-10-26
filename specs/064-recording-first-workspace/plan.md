# Implementation Plan: 紀錄優先工作區

**Status**: In progress · 2026-10-26。本 plan 不將整份 Spec 064 視為已完成；既有候選由本工作樹繼續驗證，不重置其他變更。

## Technical Context

TypeScript／React／Electron／SQLite、現有 Python POSIX relay 及 PowerShell adapter；使用 package-lock 與既有 Vitest／Playwright。沿用 ingest、enrollment、query cursor、FTS／body／cast index、ExportPlan、readers／Inspector／Transcript。無新依賴、新儲存引擎或 UI 框架。

## Constitution Check

證據不改寫；投影／條件 canonical；部分結果、未知與失敗明示；預覽與執行同一 plan。跨專案及來源選擇先測故障再改碼。來源修改須真實落盤驗收，平台不可用不能升 Verified。檔案與隱私政策依 C1–C6；存在衝突先改契約，不以實作方便降低要求。

## S1 Capture Baseline

先移除環境提示作為 Terminal App 隔離依據。POSIX 的來源解析集中在已隨 hook 安裝的 terminal_app.py：macOS 使用有界程序祖先查詢及 App bundle executable／identifier；無法驗證的環境 fail closed。tmux／ssh／WSL 來源鏈不能直接推定。所有 POSIX gate 共用此解析；每次資料送出重新套用最新選擇。PowerShell 無可靠 process-origin 證明時拒絕受限選項，不接受 WT_SESSION 自我聲明。設定只提供已支援的限定能力；不以此宣稱其他平台已支援。

接續沿 Spec 063 候選驗證長輸出、分段、恢復、project generation／在途資料及基本匯出。既有流程保持可用，不等待新導覽。

## S2 Activity Core

由 C1 穩定來源鍵與已知工具分類取代 PID＋文字配對。於既有 query 層解析投影、群組 cursor／計數；同一查詢供列表、三閱讀模式與匯出。已量測的十萬筆反覆重算成本，以目前 read connection 的 SQLite TEMP 衍生索引收斂；只存群組鍵、分類及 payload digest，增量補新 row，retention／失敗後重建、closeDB 時丟棄，不新增證據表或持久化 schema。C2 的覆蓋回報沿現有索引逐類附 metadata，不能用 React 對當頁假全文查詢。

## S3 Reading & Evidence

沿現有 readers 補來源版本、有界 read/find/copy 與 C4 anchor；介面重用現有控制，避免建立萬用巨型元件。C5 在 canonical ExportPlan 固定 Activity／Session 原始 IDs、companion、附件 prefix／digest；跨目標錄影另選，不在 renderer 製造另一規則。

## S4 Navigation & Polish

前三階段能力對等後才換五主入口，Settings 五分類及快捷鍵共用定義。保留 HTTP 工作台、可選 Terminal、獨立預設 HUD；AI 只有 Claude Code／Codex。版面、語系、鍵盤與最小視窗依 acceptance 矩陣走測，不靠新增說明文案補救。

## Verification / Dependencies

每項風險行為先 RED 再 GREEN；相關整合、typecheck、build、受影響 E2E 後才標完成。真實來源／跨平台驗收與合成 fixture 分開，S1 必要 gate 未完不以後段視覺工作掩蓋。對照 traceability.md 與 contract-acceptance.md；全產品五人任務與效能指標仍需量測。

分批順序 S1→S2→S3→S4。無部署／push／合併授權；只在既有隔離候選實作，提交另按使用者指示。
