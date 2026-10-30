# 後續工作計畫

更新：2026-10-30。核對基準：`main@ae0544b5`，GitHub 19 個 open issues；本文件整理執行順序，不新增功能契約、升級 spec 狀態或宣告發版。上一批修復與驗證見 [2026-10-29 完成紀錄](records/2026-10-29/UIUX-COMPLETION-2026-10-29.md)。

目前程式／CI／候選產物摘要見 [目前狀態](CURRENT-STATUS.md)。

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
| UI 標準與文案必要性 | [UIUX-STANDARD](UIUX-STANDARD.md)、[Controls and copy](UIUX-CONTROLS-AND-COPY.md) | 視覺提案不能改保存／授權語意 |
| 全產品視覺工作與頁面矩陣 | [Forensic Editorial](UIUX-FORENSIC-EDITORIAL.md)、Spec 062 T087–T092 | 不以本次局部 UI 修正代替 |
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
