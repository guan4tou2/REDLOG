# 後續工作計畫

> **狀態**：current — 「下一步做什麼」的唯一頁面；現況只在 [目前狀態](CURRENT-STATUS.md)  
> **範圍**：執行順序、依賴與 issue 歸屬；功能契約與任務在各 `specs/NNN-slug/`  
> **最後核對**：2026-11-12 補記之二的階段狀態依 `main@56c9fe6c`，其餘內容依 `main@a087c16c`；2026-11-12 補記一節依 `main@aaee01fd`，該節列到的 issue 於當日查詢；批次與 issue 表為 2026-10-30（`main@ae0544b5`，GitHub 19 個 open issues）；2026-11-11 補記一節依 `main@9f60882d` 的 git 紀錄，issue 狀態未重新查詢

更新：2026-10-30。核對基準：`main@ae0544b5`，GitHub 19 個 open issues；本文件整理執行順序，不新增功能契約、升級 spec 狀態或宣告發版。上一批修復與驗證見 [2026-10-29 完成紀錄](records/2026-10-29/UIUX-COMPLETION-2026-10-29.md)。

目前程式／CI／候選產物摘要見 [目前狀態](CURRENT-STATUS.md)。

## 2026-11-12 補記之二：根因審查後的主線

依 `main@a087c16c`。來源、抽查與決定見 [根因審查與落地計畫](records/2026-11-12/ROOT-CAUSE-REVIEW.md)；各階段可借用的既有設計見 [同類系統的設計參考](research/PRIOR-ART-SUMMARY.md)，動手前先讀對應的一節。這裡只排順序。下一節「剩餘工作」的個別項目多數是這些階段的症狀，動手時以階段為單位，不逐項修補。

狀態於 2026-11-12 晚間依 `main@56c9fe6c` 重新核對。三欄分開記：**已決定**（寫進紀錄或規格）、**已實作**（合併進 `main`）、**已驗證**（在哪裡、以什麼方式看到它成立）。文件寫得完整不等於後兩欄成立。

| 階段 | 內容 | 前提 | 已決定 | 已實作 | 已驗證 |
|---|---|---|---|---|---|
| 0 | 量測與記帳：略過要有理由且 CI 上該有的能力缺了就失敗；檢查建置結果的測試真的執行；主行程停頓能歸因到處理程式 | — | 是 | 前半（#706：略過記帳、CI 順序、能力宣告、行尾、元件宣告位置）。主行程停頓的歸因、建置結果的測試未做 | #706 的部分在三個平台的 CI 執行 |
| 1 | 核心替事件蓋上身分與來源，納入雜湊 | 0 | 是（[Spec 071](../specs/071-event-provenance-and-ingestion-contract/spec.md)，Draft；決定 O1–O18） | 否。第一階段（只加測試，釘住既有行為）進行中，未合併 | 否 |
| 2 | 專案執行期物件：資源清單與單一的設定檢視 | 0 | 方向已定，無規格 | 否；#702 為其前置的一部分 | 否 |
| 3 | 每個專案一個查詢工作執行緒；衍生資料增量化 | 0、2 | 方向已定，無規格 | 否 | 否 |
| 4 | 統一的寫入契約：信封、回執、冪等鍵、遺失帳本、共用的用戶端規格 | 1 | 是（Spec 071） | 否 | 否 |
| 5 | 單一的來源狀態模型與詞表（八個來源狀態、四個整體狀態、完整性獨立） | 2、4 | 詞表已定，無規格 | 否 | 否 |
| 6 | 介面的讀取模型、變更通知、計數定義、篩選歸屬、導覽狀態 | 3 | 方向已定，無規格 | 否；#701、#705 為其前置的一部分 | 否 |
| 7 | 驗證的後續：測試掌控時間、`test/` 與 `e2e/` 納入型別檢查、QA 腳本成為夜間測試、多版本 shell 容器、正式版啟動測試 | 平行 | 是 | 否 | 否 |

獨立於主線、已合併：

| 項目 | 已實作 | 已驗證 | 未驗證 |
|---|---|---|---|
| Bundle 驗證涵蓋附件與匯出封存（bundle 第 4 版） | #711 | 兩個驗證器共用的測試向量在三個平台的 CI；e2e 在 Ubuntu；macOS 真實 app 經 API 匯出後以獨立驗證器驗過 | 匯出選單的路徑；打包版中工作執行緒與主行程之間的封存往返 |
| 同毫秒事件的穩定排序 | #708 | 單元測試與 e2e | 跨層（chained／logged）同毫秒的順序仍不是寫入順序 |
| 工具鏈與 Electron 45 | #710、#714 | 三個平台的 CI；macOS 真實 app 12 個 e2e | tag 建置才跑的打包檢查、系統匣 |

進行中、未合併（各自一個分支）：輸出完整程度與閱讀器的呈現修正；hook 安裝位置與初始化不輸出；外掛的三項安全修正；#695 剩餘兩項與 Windows 上反覆逾時的測試。

### 驗收規則

1. **擷取可信度是第一條驗收主線。** 階段 1、4 的每一步不以 API 回傳成功為準，而是從真實來源（shell、HTTP、AI 工具）一路驗到：事件已持久化、讀得回來、遺失有缺口紀錄、匯出後獨立驗證器通過。對應 Spec 071 的 T091；能自動化的部分併入階段 7 的夜間測試。
2. **介面的驗收跟著核心契約走，不等階段 6。** 每完成一個核心契約，就在真實 app 中核對讀它的畫面（儀表板、來源設定、活動紀錄、時間軸）說的是同一件事，並把結果記在該變更的驗證紀錄。
3. **已決定、已實作、已驗證分開記。** 本頁與各紀錄的狀態一律用上表三欄的意思；「已驗證」要寫明平台與方式，沒有跑過的寫「否」。

同日另有兩份審查（[外掛系統](records/2026-11-12/root-cause/08-plugin-system.md)、[設定時的選擇與多重性](records/2026-11-12/root-cause/09-setup-choices-and-multiplicity.md)），其十項決定見根因審查 §4。它們不另開階段，掛在既有階段上：

| 工作 | 掛在 | 狀態 |
|---|---|---|
| 官方 AI adapter 從 app 本體執行，同意改為專案層 | 2 | 未開始 |
| 安裝帳本：每個寫入的檔案有精確的還原紀錄；移除不留殘餘 | 2 | 未開始 |
| 單一、有版本的 manifest；bundled id 不可被覆蓋；移除簽章欄位與 pack 的機器層停用 | 4 | 未開始 |
| 每個來源一把只能寫入的憑證；停用即撤銷；heartbeat 不寫成事件；未登記的種類預設 logged | 1、4 | 已進 Spec 071；未實作 |
| 提權步驟只執行驗證過的複本；說明文字不作為邏輯 | 獨立 | 未開始 |
| Hook 裝到所有有 adapter 的 shell；以啟動訊號為「有載入」的證據；初始化不輸出；執行期自我檢查 | 4、5 | 未開始 |
| 被切換專案的終端改為暫停並可恢復 | 2 | 未開始 |
| 目標歸屬標註來源，每個終端沿用自己的最近目標 | 1 | 未開始 |
| 機器層級的設定檔 | 2 | 未開始 |

不做：把內建來源改成外掛或框架化管線；依行數拆 `Timeline.tsx` 或 `src/main/index.ts`；階段 1 之前拆 API 伺服器；整批搬動 `src/core`；引入相依注入容器或全域狀態庫；更動證據的資料格式。

## 2026-11-12 補記：可用性審查之後的剩餘工作

依 `main@aaee01fd`。來源與量測條件見 [可用性審查收尾](records/2026-11-12/USABILITY-AUDIT-CLOSEOUT.md) §4；這裡只排順序。issue 狀態為 2026-11-12 查詢：#685–#692 已關閉，#695 保留。

先做（會卡住擷取或操作）：

| 項目 | 追蹤 | 下一步 |
|---|---|---|
| 開啟後第一次搜尋的主行程停頓（約 7 萬筆時 4–5 秒） | #695 | 先在閒置機器上重跑負載腳本確認它是否就是活動頁那次停頓；再決定把首次走訪移到背景，或保存來源簽章以略過走訪 |
| 單一戰利品事件的命中數沒有上限（8 MiB 相異雜湊輸出擷取約 8.5 秒） | #695 | 設上限並在事件上標明被截斷，連同遮蔽 denylist 的大小一起量測 |
| 設定儲存失敗時表單內容未保留 | 無 | 重現後修正；屬寫入失敗處理的漏網 |
| hook 另外四處（`redlog-run` 的 `mktemp -t`、Python 路徑失敗靜默丟棄、`redlog-send.sh` 無 `--max-time`、engagement id 截斷） | 無 | 各自補測試後修正 |

再做（可見但不擋操作）：

| 項目 | 下一步 |
|---|---|
| 時間軸刻度頭尾標籤重疊 | 首尾刻度改為靠邊對齊或在重疊時省略 |
| 時間軸事件列表的「範圍未判定」逐列顯示；活動頁交錯出現時不收合 | 需在查詢層分組，先確認是否值得 |
| HTTP 完整度訊息未含筆數、時間軸上匯出未指明範圍、三個頁面無共用篩選提示、戰利品頁無載入中狀態 | 逐項重現；其中半數走查失敗是腳本找不到元素，先修腳本再判定 |
| 兩個因 1 秒等待而偶發失敗的元件測試 | 找出競賽點，不再只放寬等待 |

等決定（不動手）：設定頁內容寬度標準、時間軸文字 13px 下限、`native`／`relayed` 與 tier 標章的用詞、lint 第六道 gate、統一鍵盤層、首次使用主要按鈕、時間軸右側停靠、縮放 1 倍是否一次載完歷史、另外兩個 fuse。

需要其他環境：Windows PowerShell／Git Bash／WSL、Linux 非 UTF-8 目錄、真實輸入法、多螢幕、簽章與公證。沒有環境時保留 NOT RUN。

## 2026-11-11 補記：併入 2026-11-04～07 的 UI/UX 計畫

2026-11-04～07 寫在 `docs/` 根目錄的剩餘實作計畫、跨頁分析、重新核對與設計差異矩陣，已移入 [records/](records/README.md)，不再各自維護待辦。其中仍可能未完成的項目集中在下表；「git 紀錄」欄只列 `main@9f60882d` 上看得到的相關合併，不代表 issue 已關閉或驗收完成，動手前重新讀 issue 與程式。

| 項目 | 原始紀錄 | 2026-11-11 git 紀錄 | 下一步 |
|---|---|---|---|
| 輸出完整性與閱讀（批次 A；#550、#546、#591） | [剩餘實作計畫](records/2026-11-04/UIUX-REMAINING-IMPLEMENTATION-PLAN.md) §2 | #546 修正（#671）、#591 修正（#676）；#550 無對應提交 | 依原計畫 A1 在實際來源重現 `ls`／`ls -al`，再判斷是否仍有缺口 |
| 真實 HTTPS 客戶端→保存→閱讀（批次 B；#289、#435） | 同上 §3 | 只有文案調整（`90085f9a`）；無真實 HTTPS 驗收紀錄 | 需有 mitmdump 的環境，照原驗收條件執行 |
| 設定資訊架構與插件邊界（批次 C；#435、#557、#568） | 同上 §4；[插件原始提案](records/2026-11-04/PLUGIN-MANAGEMENT-SPEC.md) | 設定單欄與首頁（#590）、來源警告直達設定列（#677）、來源頁跳轉連結（`7ea86a30`）；Spec 065–067、070 仍 Draft | 由 Spec 065–067、070 的 tasks 接續 |
| 首次準備與大專案效能（批次 D；#587） | 同上 §5；[設計差異矩陣](records/2026-11-07/UIUX-DESIGN-IMPLEMENTATION-MATRIX.md) | #601、#657、#672、#673、#683 為效能修正 | 依原計畫同條件量測前後，未量測不宣稱改善 |
| Windows Shell 真機（批次 E；#434） | 同上 §6 | 無 | 依批次 2，需 Windows 環境 |
| 逐字稿入口收斂（#563、#589） | 設計差異矩陣「逐字稿」 | 逐字稿閱讀改經活動工作區（`a7935fa7`，#659），`e2e/app-shell.spec.ts` 已有經活動「輸入／輸出」分頁到達逐字稿的案例（非 `fixme`）；#589 時間軸往返保留位置（#596） | 重新讀 #563／#589，確認是否只剩關單或文件 |
| 長期失敗的 `relay-contract`／`shell-token-not-in-argv` | [專案啟動驗證](records/2026-11-04/PROJECT-STARTUP-VERIFICATION-2026-11-04.md) | 兩檔於 `ea51d90b` 調整等待與憑證隔離 | 以完整 `npm test` 確認是否仍失敗 |
| HTML 參考稿 | 剩餘實作計畫 §7 | `prototypes/app-reference/index.html`（`b4725847`） | 只作參考，不是產品來源 |

## 從哪裡接續

先完成下列「對帳」批次，再處理可靠性與長流、HUD／更新、全產品視覺驗收，最後依 Spec 064 stage gate 整併導覽。沒有其他平台或真人環境時，先完成 Mac 可獨立進行的工作；其餘保留 BLOCKED／NOT RUN，不等待環境才修已知資料遺失。

目前有實作不等於整份 spec 完成；unchecked 也不等於完全沒有程式碼。實作、測試、原生驗收、發布分開記錄。時間預估要在缺口重現後給，這裡不以日期假裝已取得測試環境。

## 文件與追蹤的權威

| 問題 | 維護位置 | 不在此重複維護 |
|---|---|---|
| 下一批做什麼、依賴與暫緩 | 本文件；公開母單 [#317](https://github.com/guan4tou2/REDLOG/issues/317) | 不重寫各 spec tasks |
| 原始產品需求與工具／平台測試集合 | [#295](https://github.com/guan4tou2/REDLOG/issues/295)、[#296](https://github.com/guan4tou2/REDLOG/issues/296) | 不當作三套功能清單 |
| 功能契約、任務與 feature 狀態 | [Spec 索引](../specs/README.md) → 各 feature 的 spec／plan／tasks | 不因母單關閉就升 Verified |
| 穩定領域語意 | [domain/](domain/glossary.md)；capture、scope、query、selection 契約 | 不由歷史審查重新定義 |
| UI 標準與文案必要性 | [UIUX-STANDARD](UIUX-STANDARD.md)（含 §25 控制項與文案） | 視覺提案不能改保存／授權語意 |
| 全產品視覺工作與頁面矩陣 | [Forensic Editorial](design/UIUX-FORENSIC-EDITORIAL.md)、Spec 062 T087–T092 | 不以本次局部 UI 修正代替 |
| 跨頁 Stitch 設計決策與 React 整合契約（2026-11-11 補列） | [UIUX-STITCH-DESIGN](design/UIUX-STITCH-DESIGN.md)（Draft，2026-11-06 快照） | 不是第二套 UI 標準；其狀態表是當日快照 |
| 每次實測的版本、步驟、產物與限制 | 各 spec verification／acceptance；跨 feature 紀錄放 [records/](records/README.md) | 不把歷史產物 hash 移到新版本 |
| 跨平台與五位使用者環境缺口 | [#457](https://github.com/guan4tou2/REDLOG/issues/457)，回填原驗收文件 | 不新增另一份完整測試矩陣 |
| 測試命令與成品驗證 | [TESTING](TESTING.md)、[PACKAGED-SMOKE](PACKAGED-SMOKE.md)、[CLAUDE.md](../CLAUDE.md) | 不硬編寫會過期的測試總數 |

## 執行批次

| 順序／批次 | 唯一 feature／追蹤 | 具體下一步 | 完成條件與環境 |
|---|---|---|---|
| 0 對帳與診斷 | Spec 061／062／063／064；#317 | 依實際 Interface、既有測試及 verification 對帳 unchecked；先核對 063 分段／匯出、061 update flow、064 C1／Reader／Export。只補實測缺口，不重做現有 Module | 每項可區分「待實作／局部實作待驗／環境受阻」並指向證據；保留完整 gate，不能只勾文件。Mac 可做 |
| 1 可靠保存與長流 | Spec 063、064 S1；#291／#290／#288 | 沿現有 ingest／spool／relay／cast／HTTP 保存路徑，逐來源驗暫停、跨專案、重啟、受控寫入失敗、持續輸出及途中斷線；先重現再修 | 已落盤 bytes 可讀回；拒絕／缺口可追溯；命令不被阻塞或重播；原件與匯出一致。真實 ENOSPC／Kali／Windows 另保留門檻 |
| 2 接入、能力與交付閉環 | Spec 047／052／056／059／060／062；#434／#289／#293／#435／#436／#292 | 重驗現有外部 shell／HTTPS 接入、來源授權、scope、手動附件、失敗重試、最近交付找回；對 #293 建立能力與實證對照，沿既有狀態與文件 | Bash／Zsh／PowerShell 及各環境分列；client capture／CA trust 分開；preview、附件與成品符合契約；不承諾 raw 附件自動清洗 |
| 3 HUD 與安全更新 | Spec 062 T011／T012、Spec 061；#317 | Mac 原生驗其他 App 前景時退出 HUD 穿透；實際候選驗下載→稍後→取消／確認重啟→證據讀回。先核對現有 UpdateFlow 與 quitImpact | 真實按鍵送達、焦點／磁碟狀態一致；未確認不重啟；收尾失敗不冒稱成功；更新前後版本與資料可核對。需要操作者原生配合的部分如實記錄 |
| 4 全產品視覺與操作一致性 | Spec 062 T085／T087–T092；#298／#435／#436 | 依既有頁面矩陣：foundation → 核心工作頁 → 證據／設定／交付 → 全矩陣回歸；T085／087 收既有原生 resize 缺口 | 空／載入／失敗／成功、繁中／英文、窄寬窗／縮放／鍵盤有實際 Electron 證據；不只 token tests，不新增重複提示 |
| 5 工作區 parity 與導覽 | Spec 064 S2→S3→S4 | 先完成 Activity 投影／query 與非 Shell tool action，再完成三種閱讀模式、位置恢復與 fragment 座標、ExportPlan 對等；最後五主入口 | CT-01–16 及 UX-01–19 適用 gate 齊備後才移除舊入口；保留原始 Event、深搜及附件能力；不先做大型 Timeline 改版 |
| 6 原生驗收與發布收斂 | #226／#296／#457；Spec 062 T013、064 T029 | 用精確 commit 建候選，執行來源／安裝／故障／使用者任務矩陣；回填 spec、issue、release 限制與 hash | 適用平台有成品及讀回證據；跨版本不借 PASS；未測維持限制。發版另依實際授權執行 |

批次 1–3 的必要原生驗收不延到最後才第一次執行；批次 6 是彙整與發布 gate。文件對帳及其他不依賴環境的工作可先推進。以上是依賴順序，沒有建立自動排程或新任務。

## 19 個 open issues 的歸屬

狀態為 2026-10-30 查詢快照；本次依附件整理 labels 與 #317 里程碑，不修改原驗收 checkboxes。每批執行前重新讀取對應 issue 的最新紀錄。

| Issue | 角色／批次 | 現在應如何處理 |
|---|---|---|
| [#317](https://github.com/guan4tou2/REDLOG/issues/317) | 執行母單／全部 | 管理順序與 HUD／更新／最終 gate；不複製需求矩陣 |
| [#295](https://github.com/guan4tou2/REDLOG/issues/295) | 需求索引 | 保留需求追溯，不當成全新 feature |
| [#296](https://github.com/guan4tou2/REDLOG/issues/296) | 驗收集合／1–6 | 工具、指令、網路、附件、平台案例結果與版本 |
| [#457](https://github.com/guan4tou2/REDLOG/issues/457) | 環境與真人驗收協調 | Windows／WSL／Git Bash／Linux、ENOSPC／中斷與五人量測；結果回原文件 |
| [#291](https://github.com/guan4tou2/REDLOG/issues/291) | 可靠性／1 | 本次 pause／rollback／spool 證據只是部分門檻，不關整單 |
| [#290](https://github.com/guan4tou2/REDLOG/issues/290) | 長流／1 | 依來源盤點持續落盤，SSE／WS／PTY 中斷與交付 |
| [#288](https://github.com/guan4tou2/REDLOG/issues/288) | 終端透明性／1–2 | 真實 Kali、shell upgrade、100 指令及同機延遲基準 |
| [#326](https://github.com/guan4tou2/REDLOG/issues/326) | 原生 WSL／1–2 | 已有修復，D1–D4 實機仍待；label 暫緩不表示缺陷未修 |
| [#345](https://github.com/guan4tou2/REDLOG/issues/345) | Git Bash／1–2 | 已改 stdin，G1–G3 仍待實機 |
| [#344](https://github.com/guan4tou2/REDLOG/issues/344) | Windows 偶發匯出診斷 | 暫緩；收集真實失敗碼／候選／成品後重現。若重現證據遺失，提升到批次 1；不因 Mac 成功關閉 |
| [#434](https://github.com/guan4tou2/REDLOG/issues/434) | shell 接入／2 | 共用操作已合併，依平台補驗；不造第二套 wizard |
| [#289](https://github.com/guan4tou2/REDLOG/issues/289) | HTTP 接入／2 | 歷史與失效已補；完整 client／CA／代理死亡恢復仍依矩陣 |
| [#293](https://github.com/guan4tou2/REDLOG/issues/293) | 能力定義／2 | HTTP 內容、DNS、socket metadata 與未覆蓋情境分開 |
| [#292](https://github.com/guan4tou2/REDLOG/issues/292) | 手動證據／2 | 先驗手動保存與來源找回；自動 argv 歸因延後，不擴大監看範圍 |
| [#435](https://github.com/guan4tou2/REDLOG/issues/435) | 來源操作／2、4 | 既有安裝／專案啟用與授權邊界，完整操作驗收未齊 |
| [#436](https://github.com/guan4tou2/REDLOG/issues/436) | 交付／2、4 | 本次格式政策／原始附件警告已補，仍驗全流程與平台，不重建 ExportPlan |
| [#298](https://github.com/guan4tou2/REDLOG/issues/298) | 設定與讀取失敗／4 | 修正已合併部分保留證據；窄窗／高縮放與完整設定矩陣未齊 |
| [#226](https://github.com/guan4tou2/REDLOG/issues/226) | 安裝／發布／2、6 | 原生安裝、升級、移除、支援宣稱及精確成品驗收 |
| [#294](https://github.com/guan4tou2/REDLOG/issues/294) | Deferred | PCAP 新能力不進核心批次，不阻擋已承諾來源的可靠性修復 |

## 舊 spec 與任務對帳原則

[Spec 索引](../specs/README.md) 保留每一份的正式狀態；本次不刪除、不改號、不一律勾 tasks。

- 047／052／056：主要剩原生或安裝包 gate，不能重新開發 setup／recorder／export。
- 048／049／051／054／057／058：逐需求對照 062／064 和目前程式。若被涵蓋，先記錄逐項對應與未涵蓋差額，再依專案規則決定原 spec 的狀態；不直接將 Draft 改 Verified 或 Withdrawn。
- 059／060：接入與完整性需求已部分由 062／064 承接；保留原規格的外部終端／HTTPS／授權要求，不再建立第三套設定流程。
- 061：task 未勾，但 `update-flow.ts`／`update-status.ts`／`update-anchor.ts` 等已存在；待正式驗收與缺口核對。
- 063：tasks 仍列分段及 companion export；064 T007 與 verification 已有 Mac 證據。先核對跨來源及平台差額，不能再寫一套 cast rotation。
- 064：C1、Reader、Export 與設定分類有局部實作；T016／017 等跨面 gate 仍未全齊。本次 17 MiB／版本化 Reader／匯出測試不能取代完整 CT／UX。

## 本次文件整理的完成界線

- [x] 建立本計畫、19 issues 歸屬及先後依賴，保留原追蹤權威。
- [x] 建立全部 64 specs 索引，列出剩餘狀態與對帳類型。
- [x] 將 9 份 2026-10-29 審查／提案／驗收快照移入 `docs/records/2026-10-29/`，修正本機連結。
- [x] 更新文件入口、架構導覽及檔案放置規則，保留歷史內容。

本次整理儲存庫文件、索引與契約映射檢查，並更新 GitHub labels／#317 里程碑；未修改產品程式、issue open／closed 狀態或 feature 正式狀態。後續實作仍按各批驗證，不把本節勾選當成 feature 完成。


## 下一里程碑：可驗證的跨平台 Recording Workflow

不另建另一份 NEXT-MILESTONE 或新大型 spec。先以指定 commit 重建候選與 smoke，接著 Windows／WSL／Git Bash → Kali／Linux → Mac 原生回歸；缺少其他平台時先做本機不依賴環境的可靠性與故障驗證。來源接入與保存穩定後才做五人量測。Timeline／Reader 拆分依觀測差額決定。

### 062／064 共用驗收的單一結果位置

| 交集 | 結果唯一位置 | 另一 feature 的處理 |
|---|---|---|
| 安裝／設定／shell 接入、HUD、更新 | 062 `manual-acceptance.md` M01–M16／M26–M28 及 verification | 064 UX-01–05／16–17 引用具體候選、對應 M ID 與差額，不複製 PASS 表 |
| 身分、pause／spool／project binding | 064 `contract-acceptance.md` CT-08／09／15／16 及 verification | 062 T010 記 M 情境結果並引用對應 CT 證據；#291 不另創結果矩陣 |
| Activity／query／Reader／fragment／export selection | 064 CT-01–07／10–14、verification 與 coverage manifest | 062 匯出與找回任務引用該 CT，另驗產品操作；不拿 UI 完成代替內容契約 |
| 全產品視覺、兩語系、resize／focus | 062 T087–T092 與 Forensic Editorial 頁面矩陣 | 064 parity 引用同一候選的頁面證據，補新工作區特有差額 |

CT 的自動化檔案／平台／證據指標見 064 `coverage-manifest.json`；完整語意與驗收結論仍由 CT 原表決定。檢查器只檢查映射、檔案與狀態一致，不因測試檔存在自動判 PASS。

GitHub 分類採少量獨立的 priority／type／status／area labels；326／345 的程式修復與待原生驗收分開，344／294 保留 deferred。不新增 issue、不關閉完整 gate；#317 維護最新里程碑並保留歷史本文。公開母單只引用已提交程式與既有契約，不把本機未提交整理寫成已上線。


## 本次整理驗證

- 本機文件連結檢查、`typecheck`、`verify:specs`、`verify:architecture`、`verify:i18n` 通過。
- 契約映射檢查器 4 項測試通過；CT 原表未因此升級，64 spec 正式狀態與既有 task checkboxes 保留。
- 2026-10-30 推送前依序完成五道檢查；完整單元／契約測試 **4465 PASS、31 SKIP、0 FAIL**（444 檔通過、6 檔跳過，147.81 秒）。未重跑原生驗收、未重建安裝成品；本輪沒有產品行為變更，不沿用舊 DMG 冒充新候選。
