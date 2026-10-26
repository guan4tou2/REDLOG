# C6 — 擷取歸屬、有效邊界與 Terminal App 身分

**Status**: Draft contract · 2026-10-26。適用 FR-004／006／029–032、FR-049、FR-053；驗收 CT-08／09／15／16。優先於改版導覽，沿用現有 enrollment、ingest、來源 host 與錄製生命週期。

## 1. 錄製 Binding 及有效邊界

一次錄製 binding 必須能追溯 project、operator（來源確實提供時）、source instance／Session、policy/config revision、generation、已確認保存位置，以及開始／停止原因與有效邊界。來源缺欄位就標未知，不用目前前景專案補造舊資料身分。

按鈕點擊不是生效證明。UI 先呈現 pending；來源 host／寫入入口套用或撤銷規則並確認後，才宣稱已停止／已授權。邊界同時有可比較的 generation／來源位置或序列，不只依不可信來源時間戳判斷。

- 暫停／停止／撤銷之後的新原文，不得先保存 sidecar、raw chunk 或索引再決定是否產生 Event。已提交的合法 prefix 保留；恢復不得補保存暫停區間。
- 已在途資料只有能證明屬於邊界前且原 project／授權仍有效，才按該邊界完成。跨邊界批次無法安全拆分就保守拒絕／記 capture gap，不假裝零遺漏，也不把被拒原文留在稍後可重播 spool。
- 確認失敗不顯示成功停用／啟用；必要的邊界／錯誤紀錄只含狀態 metadata，不包含被拒絕私人內容。

## 2. 專案、Session、重啟

| 情境 | 歸屬規則 |
| --- | --- |
| 外部 Shell enrollment | 已接入 Session 綁原 project。切換後停止原錄製，不默默改綁 B；沿既有流程明確建立新 binding／新終端。 |
| 內建 PTY 跨專案仍存活 | 終端程序可延續，但每個 project 的錄製 binding、檔案與事件分開。continues 關聯不能把 A 的原文複製進 B。 |
| AI vendor Session 延續 | vendor Session ID 不等於永久授權。B 需要自己的整合／路徑／啟用授權；舊 watcher generation 不得繼續寫入 B，回到 A 也不得追補未授權區間。 |
| Source 重啟／App 重啟 | 沒有可靠來源延續身分就新 Session／binding；還原閱讀頁不等於重啟原程序。 |
| HTTP／WebSocket 跨切換 | 已開始 flow 綁其原 generation；後續 response／frame 不以目前專案重歸屬。無法合法續存時停止並標缺口。 |
| spool 無身分／不符 | 不猜目前 project；按既有隔離／拒絕政策處理，不寫目前 DB。 |

AI 的來源根目錄、workPaths、安裝識別及啟用邊界沿既有隱私政策；改動需要重新確認的項目使舊授權失效。Session 排除只能縮小權限；解除排除不是補讀先前私人內容。卸載不刪 vendor 原始對話及既有合法證據。

## 3. Terminal App 身分等級

| 等級 | 可用依據與承諾 |
| --- | --- |
| verified-origin | 支援 OS 上由可信本機 resolver 觀測 App／執行檔身分、程序出生識別與 PID、process／PTY lineage、觀測時間及適用範圍。可用於正向限定。 |
| environment-hint | TERM_PROGRAM、WT_SESSION 等只作候選提示；Shell 名稱、前景 App、可自行設定的旗標都不能單獨證明來源。 |
| unknown／conflict | 缺可信鏈或證據互相矛盾，不升格為已隔離。 |

不以程序 basename 或 producer payload 自填 `verified=true` 作證明。程序查詢亦不得收集無關的命令列秘密。此設計防止誤收其他終端，不承諾抵抗有同使用者／root 權限、能改寫 App 或檔案的惡意程序。

「只記 Warp」必須正向驗證是 Warp 的終端來源；其他 App、unknown／conflict 一律不開始新擷取，不退回記錄所有 App。無法可靠限定的平台／環境，設定不得顯示已隔離成功；可明確選擇所有外部終端或可信接入的單一 Session，不偷偷降級。

## 4. 繼承與適用範圍

- 同一可信本機程序／PTY lineage 下的子 Bash／Zsh 可繼承來源；Shell 名稱改變不改 Terminal App。PID 重用須靠出生識別避免錯配。
- tmux 分離／重新連接、setsid、SSH、容器或 WSL 造成來源鏈中斷時須重新驗證或 unknown；不能只憑繼承環境變數宣稱仍只記 Warp。WSL 是執行環境，Windows host App 身分需另有可驗證鏈。
- App 自己管理的內建 PTY，只能由擁有該程序的 Terminal Manager 證明，不採任意 `REDLOG_TERMINAL=1` 旗標。外部 App 篩選的範圍應明確，內建終端是使用者另外開啟的來源；不能宣稱整台電腦已隔離。
- App 選擇／撤銷變更須套用現有 Session、背景 producer 及待寫入資料的有效邊界；不能只影響下次開新 Shell。被拒內容不先存 spool，稍後也不因改回所有終端而補讀。

## 5. 現況與驗收證據

初始盤點的 terminal-app helper／PowerShell hook 主要依 TERM_PROGRAM／WT_SESSION 與內建旗標，不能當作 verified-origin。本輪候選已改 macOS 的 OS 程序／bundle 觀測，未支援平台拒絕受限模式；使用者協助的真實 Warp／另一終端與合成 I/O 結果見 [verification.md](../verification.md)。這不等於 tmux／WSL／Windows 的完整原生驗收；環境變數單元測試仍不能代替真實 App 隔離證據。

驗收須在同一 OS、同一 Shell、至少兩種真實 Terminal App，核對獲准及被拒來源實際落盤／spool／sidecar；另測假提示、身分未知、子 Shell、背景輸出、切專案與重啟。無法驗證的環境標 UNSUPPORTED／NOT RUN，不以 UI 選項存在當通過。
