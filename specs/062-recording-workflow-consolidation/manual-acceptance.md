# 人工驗收矩陣

日期：2026-10-19，更新於 2026-10-22。下列為完整跨平台案例；尚未完整執行的列維持 NOT RUN。Mac 已完成的步驟、結果與限制見 [Mac 實機紀錄](mac-acceptance-20261021.md)，不可把子步驟 PASS 當成整列跨平台通過。

每次記錄：候選 commit、安裝包版本/檔案雜湊、OS/架構、shell 版本、測試專案、實際步驟、預期/實際結果、輸出檔或畫面位置。不得使用私人對話或真實秘密作測試資料。

## 平台

- macOS arm64：正式 DMG 安裝、Bash、Zsh；PowerShell 在工具可用時驗收。不顯示 WSL。
- Windows x64：NSIS、PowerShell；WSL 以 Linux 環境另驗，不把主機成功算成客體成功。
- Linux x64：DEB、Bash、Zsh；其他架構/安裝方式只有實際提供並驗證才可宣稱支援。
- 平台不適用填 N/A 並寫理由；不可拿 N/A 隱藏已宣告支援卻未測的項目。

| ID | 對應 | 操作與應觀察結果 | 狀態 |
| --- | --- | --- | --- |
| M01 | US1 | 乾淨環境安裝→首次啟動→建立專案；缺依賴有處理方式，不只驗證安裝包存在 | NOT RUN |
| M02 | US1 | 偵測 shell→手動改選→安裝→新分頁→執行有 stdout/stderr/exit 的測試指令→重開 App 讀回 | NOT RUN |
| M03 | US1 | macOS 沒有 WSL；有 pwsh 可設定；Windows/WSL 分別辨識身分與路徑 | NOT RUN |
| M04 | US1–2 | mitm 缺少時從設定直接安裝；成功、取消、無權限、缺安裝工具各走一次，無卡住的 loading | NOT RUN |
| M05 | US1 | 受控 HTTP/HTTPS 端點驗證；HTTP-only 不算 HTTPS；略過 CA 的客戶端不算瀏覽器已信任 | NOT RUN |
| M06 | US2 | 日常來源按鈕直接進設定；返回保留原頁狀態；已完成引導不強制重跑 | NOT RUN |
| M07 | US2 | 搜尋「憑證/輸出/保留/IP」等可見欄位→定位；中英文、鍵盤、小視窗與系統縮放按鈕可到達 | NOT RUN |
| M08 | US2 | 快速切頁、儲存失敗/重試、未完成輸入、切專案；無失敗假成功、跨專案或無故重啟來源 | NOT RUN |
| M09 | US3 | 空輸出、錯誤碼、大量輸出、二進位、背景延後輸出；核對歸屬、截斷與重複 | NOT RUN |
| M10 | US3 | 本機受控 ssh/nc/互動程式：Ctrl-C、Ctrl-Z/fg、resize、密碼不回顯；不外連未授權系統 | NOT RUN |
| M11 | US3 | 重導向/工具輸出檔、手動加檔、截圖、錄影：重開後可取得；候選來源不冒充確定 | NOT RUN |
| M12 | US3 | 在隔離測試目錄模擬寫入拒絕、附件遺失、磁碟配額不足；提示與保存結果一致，不填滿真實磁碟 | NOT RUN |
| M13 | US3 | 無專案提示不算本專案漏記；計數單位正確；不自動清除/認領；已有專案離線資料仍正確補送 | NOT RUN |
| M14 | US4 | 實際 HUD 初始開啟、IP 更新、收合/關閉/拖動有效；只有一個一般標記按鈕 | NOT RUN |
| M15 | US4 | 點標記→等待→儲存：時間取原點擊；展開/取消/失敗/切專案不誤存；焦點合理恢復 | NOT RUN |
| M16 | US4 | 保持展開可辨識；穿透前知道退出方式，啟用後實際用快捷鍵/選單恢復 | NOT RUN |
| M17 | US5 | 未安裝 AI 插件時用檔案存取觀察確認未讀取對話，而非只看資料庫沒有事件 | NOT RUN |
| M18 | US5 | 僅安裝/啟用一個插件與一個目錄；另一工具/另一目錄/另一專案不被收進來 | NOT RUN |
| M19 | US5 | 停用、卸載、損壞插件、更新：不刪既有證據、不動其他設定、不擴大範圍 | NOT RUN |
| M20 | US6 | 超過一頁匹配資料；目前篩選→JSON/NDJSON/Bundle，換格式不變範圍；全專案須明確選擇 | NOT RUN |
| M21 | US6 | 網頁 method/status/host/text/time 篩選→HAR：交換關聯、數量、body 與預覽逐項相符 | NOT RUN |
| M22 | US6 | 空 scope、exclude、私人流量、命令混合：篩選/遮蔽說明正確，命令不受網頁 scope 誤排除 | NOT RUN |
| M23 | US6 | 排除一個附件，其他預設選取不丟失；跨目標錄影揭露整段；預覽後變動附件不可錯包 | NOT RUN |
| M24 | US6 | 預覽後新增事件、改頁面 filter、執行失敗/重試：符合預覽邊界，不使用失效 plan | NOT RUN |
| M25 | US6 | 匯出完成→在資料夾顯示→實際打開檔案/核對 manifest；證據包依其完整鏈/投影語義驗證 | NOT RUN |
| M26 | US7 | 有來源活動時下載更新→稍後：不中斷；確認重啟→收尾→新版本讀回並新增紀錄 | NOT RUN |
| M27 | US7 | 關窗、暫停擷取、暫停捲動、退出分別操作；來源與資料結果符合文案 | NOT RUN |
| M28 | US1–7 | 空／載入／失敗狀態、鍵盤順序、Esc、窄視窗/縮放、繁中英文，不只靠顏色辨識 | NOT RUN |

## 驗收規則

- 自動化可驗證資料契約與故障案例，但不能冒充實際桌面點擊、安裝、系統權限及焦點行為。
- 先跑受影響案例，再按整合影響擴大；不以單元測試或 build 成功代替可使用結論。
- 執行人只將真的完成項目改為 PASS；FAIL 附重現與證據；NOT RUN 必須保留並列入交付限制。


## 2026-10-22 AI Mac 子流程

[AI Mac 原生操作紀錄](ai-mac-acceptance-20261022.md) 補上 M18/M19/M28 的 Mac 子步驟：原生資料夾選擇、Codex 單項安裝與授權、鍵盤停用、卸載及重裝後證據保留。它沒有涵蓋跨平台整列或插件更新故障等所有情境，因此上表整體 NOT RUN 保留；未安裝零讀取的觀察來源也另外標示為 packaged 自動化。

## 2026-10-22 設定與 HUD 子流程

[Mac 設定與 HUD 操作紀錄](mac-workflow-acceptance-20261022.md) 補上 M08/M14–M16 的部分步驟：真實寫入拒絕／重試、快速切頁保存、標記儲存與主視窗穿透恢復。T020 視窗內快捷鍵修正通過原生操作及整合驗證；其他 App 在前景時的全域恢復仍未通過，T011 不關閉。跨平台整列與其餘案例狀態保留。

## 2026-10-23 排版與實際匯出子流程

[排版與交付紀錄](manual-layout-20261023.md) 的 T055–T057 補上原生 Mac
大小視窗及 M20/M21/M23/M25 的部分實際產物驗收：搜尋 JSON/NDJSON、
整專案證據包排除一份錄影、Finder 定位，以及 4xx HAR。發現並修正
bundle 的隱性錄影個資替換與空 HTTP 篩選摘要。修正後確認納入錄影
bytes 相同，包內驗證器通過。這些採既有合成資料與 source build，沒有
補跑跨平台整列、超過一頁的手動資料或所有故障案例，整體狀態維持。

## 2026-10-24 內測候選與部分完成狀態

[本輪內測紀錄](internal-acceptance-20261024.md) 分開記錄原候選的實際安裝包
測試、截圖所指出的部分來源已驗證版面、原生寬版與自動化窄版，以及 Windows／
Linux runner 結果。NOT RUN 列表示完整案例仍未跑完，不抹除已有子步驟的證據，
也不將來源版或 CI 自動化冒充下載信任、桌面手動操作或原生 WSL 驗收。

## 2026-10-24 合併後 main

[合併後 Mac 驗收](post-merge-mac-acceptance-20261024.md) 記錄 375f2ee3 的實際 DMG／ZIP 資源、安裝副本與 AI journey，以及原生新建／設定保存／專案隔離／更新檢查。保存重試發現的殘留錯誤另列 T072。僅補 Mac 子步驟，不更改上方完整跨平台列的 NOT RUN 或 T008–T013。


2026-10-25 bounded follow-up: reused the already-open isolated Mac package for
source settings, explicit Zsh install/waiting state, actual bundle completion,
Finder selection, Last export reopening and native smaller-window inspection.
See verification.md T073–T078 for exact evidence and test-consolidation results.
This does not complete the broader T008–T013/platform matrix.


## 2026-10-25 最近匯出跨重啟

verification.md T081 補上新 Mac DMG 的原生 M25 子流程：專案外自訂目錄、實際匯出、正常退出與重開、讀回原完成時間及路徑、Finder 選取同一份成品，以及包內驗證器。只補此子流程，不把整列跨平台 NOT RUN 改為 PASS。


### 2026-10-25 first-use / terminal-app follow-up

T082–T084 have bounded automated/source evidence. T085/T086 native UI inspection
remains NOT RUN: desktop locked; Warp is unavailable to the native tool. After
unlocking, use the final artifact and SHA in verification.md, not the intermediate
copy currently in the isolated test folder. Inspect About build identity,
Settings → Commands & terminals → terminal app selection (save/reopen/error),
late activation → visible ordinary-command output proof, own-browser initiation
and 1600/800 window layouts. Real PowerShell, Warp UI, clean-OS installation and
system CA trust still require their own acceptance; the 99 focused tests and
resource checks do not replace those steps.


### 2026-10-26 terminal-app and source proof

The previous pending checkpoint is superseded by verification.md's ready-dist
record: assisted Warp save and restart retention passed; native command/output
proof and exact persisted stdout/stderr/exit code passed using installed Zsh.
The identifier-based denial was checked in controlled PTYs, not Warp's GUI.
Own-browser direct opening and unverified-client timeout were observed; no CA
trust was changed. Native live-resize screenshots remained inconsistent with
accessibility, so terminal-settings visual resize is NOT ACCEPTED. T085 and the
full platform matrix stay open; bounded T086 is complete with those limits.
