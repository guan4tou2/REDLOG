# 全流程靜態盤點與規格依據

日期：2026-10-19（Asia/Taipei）。狀態：完成本輪全流程靜態盤點；未完成全平台人工驗收。

## 2026-10-21 狀態更新（優先於下方歷史盤點）

- 本次重新 fetch，main 為 `0d79823b`。下方 10/19 的分支清單是歷史證據，不是目前待辦。
- #409、#410、#411、#412、#417、#418 已合併：終端來源文案、背景輸出去重／匯出／閱讀／搜尋、Transcript 排序、儀表板進來源設定。
- #413–#416、#419–#429 中前述更新、HUD、匯出、平台、spool、hook 修正也已進 main；HUD 草稿已有專案身分檢查，不再列為缺口。
- Transcript 畫面排序與 Markdown 交付順序分離，不能因畫面最新在前就推論匯出也倒序。
- 未合併 #432 `fix/windows-followups`，head `53812e840c5f2a12e36c10684758534a7c914f44`：WSL 以帶 token 的 whoami 判斷舊目錄、Git Bash payload 經 stdin、匯出失敗診斷及測試 fixture 修正。三平台 unit、兩個 install-smoke、E2E 均 SUCCESS。這是 CI 結果，不是本次親自執行 Windows 驗收。
- #432 作者記錄的限制：WSL NAT 未測；whoami 回 503 時仍接受原目錄且缺該案例；#344 偶發匯出失敗只加診斷、尚未修復；作者 Windows 本機全測有 baseline 同樣失敗的項目。不能用 CI 全綠抹去這些限制。
- AI 目前仍靜態引入三 adapters；個別來源開關已完成，但 US5 的真正按需安裝未完成。
- 匯出已有範圍說明、格式記憶與目的地選擇；單一視窗中完整分離格式／範圍仍屬部分完成。
- 最新正式 release 仍為 v0.18.3（2026-10-16）；#391 發版準備仍開啟，沒有新版本交付。
- 本輪只讀取遠端／程式並更新文件，沒有合併 #432、發版或執行人工矩陣；28 項仍 NOT RUN。

下一步順序：先核對 #432 的 WSL 503／NAT 邊界與匯出失敗實際原因，再在同一候選安裝包驗收安裝→shell/HTTPS→HUD→查回→匯出。UI 新增功能與 AI 安裝架構不混入這輪安裝修正。

## 基準與檢查方法

- 已重新 fetch；遠端 main 固定為 `f7e9b6b3b2cd50a82faea7f6372e83b336a03dab`。本機工作樹 HEAD `c50286526c0d4a3e0dbae74b7d1f32e49bd3b70b` 較舊，沒有 checkout/pull 混入新程式。
- 以 `git show <commit>:<path>` 與分支 diff 讀取程式、Spec 050/056/060/061、打包設定。不是對舊 checkout 宣稱最新行為。
- 本次已存在 `package-lock.json` 修改，不屬於本次文件工作，未改動。
- 使用者 HUD 截圖證明可見文案與排列；程式證明按鈕對應行為。本輪沒有啟動候選安裝包或操作 macOS/Windows/Linux 真機。任何 PASS 不能從本文件推得。
- 本次範圍完整覆蓋安裝→設定→擷取→HUD→閱讀→匯出→退出更新；不是逐行安全審查、效能認證或每個外掛的全面驗證。

## 證據索引與結論

以下檔案均以基準 main 為準；證據是讀取的元件／函式，不保證安裝包行為。

| ID | 程式定位 | 核對結果 | 處置 |
| --- | --- | --- | --- |
| A01 | `electron-builder.yml`，mac/win/linux/extraResources | 配置 DMG/ZIP arm64、NSIS x64、DEB x64；DEB 宣告 python3/curl；mac ad-hoc 簽章不等於公證 | 保留安裝優先，不宣稱 Intel Mac/Linux ARM 正式包已驗收；ZIP 不能直接定性成 portable |
| A02 | `DashboardView.tsx`，onSetup | 日常來源入口仍 setSetupOpen(true) 進 FirstRunView | 已有修正分支，整合後實測 |
| A03 | `Settings.tsx`，writeConfig/loadConfig/pending saves | 已有保存中／成功／失敗、重試、離頁 flush、expectProjectId | 不重做；無效輸入與多來源狀態需行為驗收 |
| A04 | `lib/settingsSearch.ts`，searchSettings；Settings findText | 已搜尋欄位文案並定位 | 先前「只搜頁名」已過時；驗收可見欄位覆蓋，不再開新引擎 |
| A05 | `core/dependency-install.ts`；`main/services/dependency-installer.ts` | 可在 App spawn 安裝；缺工具與 sudo 會回 prerequisite/manual | 一般 mitm 安裝接既有能力；不能聲稱所有系統授權已 App 化 |
| A06 | `settings/HooksPanel.tsx`；`core/hooks-manager.ts` | main 尚未包含平台排除修正；mitm 入口有待接線 | 參照已存在分支；PowerShell 不等於 Windows-only |
| A07 | `OverlayApp.tsx`，底部 action row | 快速=即時標記；仔細=開完整標記；圓圈=穿透；方框=保持展開 | 單一新增標記、詳細欄位展開；保持 IP/HUD 預設開 |
| A08 | `core/config.ts`，overlay.autoShow | main 已預設 true | 已完成，不再列缺口 |
| A09 | `core/spool-replay.ts`，summarizeUnattributedSpool；CaptureHealth | 計數檔案及 mtime，文案卻說指令數與輸入時間；顯示於專案健康度 | 改單位與位置，已有分支；不能說資料已消失 |
| A10 | `main/services/agent-tailer.ts`；`plugins/pack-ai-agents/plugin.json` | 三 adapters 靜態引入、一包提供，main 不是個別按需安裝 | 個別開關分支只是部分改善，真正可選安裝仍待設計 |
| A11 | `settings/PluginsPanel.tsx`，OWNED_ELSEWHERE | 核心與 packs 隱藏避免兩處開關，disabled row 仍顯示供恢復 | 新插件頁不可再製造同一旗標的重複控制；需可恢復損壞狀態 |
| A12 | `settings/AgentsPanel.tsx`；tailer-host.cwdPassesGate | 已有目錄範圍入口，空 watchPaths 可廣泛匹配 | 新插件啟用要明示範圍；不是只增加說明就滿足未安裝 |
| A13 | `ExportMenu.tsx`，loadPreview/executeExportPlan/AttachmentList | 已共用 plan 預覽、逐附件選取、失敗留視窗、空 scope 說明 | 保留，不重做核心 |
| A14 | `ExportMenu.tsx`，menu options/currentFormat | 目前選取格式選單與全專案 JSON/NDJSON/Bundle 選項混排 | 格式與範圍改為獨立選項，不能換格式擴大選取 |
| A15 | `main/ipc/data-export.ts`；`core/export-plan.ts`；Spec 056 | 已有選取、scope snapshot、plan 執行契約；056 為 Implemented | 人工核對真實匯出，不把 code presence 當全格式驗收 |
| A16 | `main/services/update-flow.ts`；updater；Spec 061 | #408 已合，下載與重啟分開；061 也移除無依據門檻與過重重驗證要求 | 先前「main 下載後立刻重啟」已過時；剩下安裝包流程需驗收 |
| A17 | `core/config.ts`，packs/loot；CaptureControlPage | hostMonitors/aiAgents/windowsOutput 預設 false；loot disabledRules 僅列部分規則 | 不可把「全部進階預設關」當已完成；自動 Loot 全域預設須單獨核對 |
| A18 | Spec 052/055；terminal/file-watcher/screenshot/connection services | 已有終端、錄影、檔案、截圖與連線路徑 | 只記為既有能力，依人工矩陣驗證範圍；不宣稱所有輸入／封包可記 |

## 已存在的分支：先整合，不平行重做

以下是 fetch 時的分支內容，不等於已合併／測試通過；實作前重新核對。

| 分支 | 固定 commit | 已看到的變更與限制 |
| --- | --- | --- |
| `fix/sources-link-to-settings` | `2ca2d30bd166` | Dashboard 改導向設定。 |
| `fix/no-wsl-on-mac` | `d451b44b8e6a` | hooks-manager 排除非 Windows 的 shell-wsl，保留 PowerShell 區別。 |
| `fix/mitm-run-in-app` | `b3ce5b443746` | HooksPanel 呼叫既有安裝服務；仍有缺 prerequisite/manual fallback；狀態恢復要驗收。 |
| `fix/unattributed-notice` | `fc26b0dec27f` | 提示移到保存設定、文案修正、shell 無身分路徑調整；需驗證有身分離線補送未退步。 |
| `feat/ai-capture-scope-text` | `ee79730960b4` | 各 agent 選擇、來源位置與範圍說明；仍靜態引入 adapters，未滿足真正未安裝。 |
| `fix/spec060-thresholds-md-order` | `76b85fa8e27c` | 移除 060 的任意門檻；不重複寫另一份相反規格。 |
| `fix/late-chunk-dedup-export` | `372c2266640c` | 背景片段去重與匯出；需與閱讀／搜尋分支合併驗收。 |
| `feat/transcript-late-output` | `815fc4e081ee` | 延後輸出呈現於指令內。 |
| `feat/search-late-output` | `f9c096dd5347` | 輸出命中跳回指令。 |
| `feat/update-about-state` | `4ae0da9e26fe` | 更新狀態入口，接續 061。 |
| `feat/update-evidence` | `b8a42201015a` | 更新前保存紀錄，接續 061。 |
| `feat/update-manual-path` | `98b7796e8ef5` | 手動更新路徑與啟動檢查。 |

## 擷取覆蓋：需驗收的能力邊界

| 資料 | 預期紀錄／來源 | 不能推論成 |
| --- | --- | --- |
| 外部 shell 指令 | 指令、時間、shell、cwd、結束資訊 | 任何終端／任意 shell 都完整支援 |
| stdout/stderr | 依擷取路徑保存輸出、標明混流與截斷 | 沒有截斷、可還原所有二進位或分離串流 |
| 互動 session | 可用的 PTY／錄影與可取得的文字 | 原始鍵盤紀錄、密碼側錄、遠端每道命令都有獨立 exit |
| 檔案產物 | 指定監看／手動加檔與來源關聯 | 自動找齊任意 -o/重導向檔案、候選等於確定來源 |
| 網頁 HTTP/HTTPS | 經已設定來源的 request/response、body 邊界 | 全部網路協定、pinning/QUIC/不走代理工具均可解密 |
| DNS／連線 | 各來源實際觀察資料 | HTTP 正常就代表 DNS 完整、輪詢等於完整封包 |
| 截圖／GUI | 畫面附件、時間與目標關聯 | BloodHound/RDP/瀏覽器操作都有結構化文字 |
| 標記 | 人工註記與時間、專案、引用 | 自動證明被描述的動作已發生 |
| AI | 插件提供的對話／工具事件與來源限制 | 原始完整 shell 輸出、不可見推理、所有產品介面 |
| 剪貼簿／程序／Loot | 明確啟用後依來源能力取得 | 預設全開、秘密分類一定正確 |

以上矩陣是驗收邊界，不是新增全量網路錄製、鍵盤側錄或 GUI 解析的需求。

## 切片順序與既有規格關係

1. 先整合已存在的日常設定入口、平台判斷、mitm 安裝、未歸屬提示分支（US1–3），驗證沒有跨專案／離線補送退步。
2. HUD 單一標記入口（US4）：小幅 UI 及草稿歸屬變更，不重設 HUD 外觀/IP 功能。
3. 匯出操作整理（US6）：沿用 Spec 056/ExportPlan，只整理範圍與格式；延後輸出分支先收斂再核對交付。
4. AI 可選安裝（US5）：獨立切片，接續 Spec 050 個別來源能力；不以已寫 per-agent 開關宣稱完成插件安裝生命週期。
5. Spec 061 現有更新分支接續驗收，不併成第二套更新設計。安裝包驗收是交付必要條件，不留作無限期「以後」。

062 是整合規格，不授權把以上所有切片塞進單一大 PR。此輪只完成規格與盤點，不生成已完成的 implementation tasks。

## 尚未成為需求的提案

- 固定四組設定頁、刪時間軸、刪報告模式、強制某匯出格式、記住上次格式：沒有足夠操作證據，本輪不指定。
- 完全無專案時停止新增匿名 spool：已有分支嘗試；保留既有資料、有身分補送與不默默認領為硬性底線。其他 producers 是否同樣寫匿名 spool 尚待實測，不宣稱全部修完。
- 第一次 AI 啟用不匯入歷史、標記時間取點擊時：草案預設，需實作規劃檢查既有資料語義。

## 參考與限制

- Magpie：[官方 README](https://github.com/yetone/magpie)、[插件文件](https://github.com/magpie-community/plugins)。借用集中設定與個別插件操作概念，沒有手動操作其 App；不宣稱外觀細節已完整比較。
- 本機 autonomous-pentest-agent：`llmrec/llmrec.go`、`llmrec/capture.go`、`agent/provider.go`，只讀程式，沒有讀對話資料或憑證。它控制自己的模型呼叫，不能推論 RedLog 能無侵入記錄任意外部 App。
- 遠端變動中的分支可能互相依賴；上述 SHA 是可重現證據，不是永久最新狀態。
