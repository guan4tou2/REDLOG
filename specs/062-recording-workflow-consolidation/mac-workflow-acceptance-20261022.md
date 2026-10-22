# Mac 設定與 HUD 子流程 — 2026-10-22

本紀錄承接 AI 安裝驗收，補上設定失敗／重試與 HUD 原生操作。只使用合成資料與隔離專案，不代表整份跨平台矩陣通過。

## 候選與隔離

- 基準：`b5c4723b` 加本次 T020 的主視窗／HUD 原生快捷鍵綁定；package 版本 0.18.3，Mac arm64 / Electron 44.4.1。
- 設定故障及原有 HUD 操作先在 AI 候選執行；候選與雜湊見 [AI 驗收](ai-mac-acceptance-20261022.md)。
- T020 修正候選：`/private/tmp/redlog-hud-recovery-20261022-dist/mac-arm64/RedLog.app`。
- 修正候選 `app.asar` SHA-256：`12309dcd14ee6b881cc2d152c62e045487075a302ca6b71e90eb8613268e6def`。
- 必要打包資源與 deep/strict 簽章驗證通過；ad-hoc 簽章，未公證，沒有宣稱完成 DMG 覆蓋安裝或公開發版。
- HOME：`/private/tmp/redlog-ai-native-20261022/home`，另指定隔離 profile；專案 `AI-Native-Acceptance`，目錄 `ai-native-acceptance-mvitb0ez`。未開啟真實專案。

## 原生操作結果

操作透過原生介面逐步讀取／點擊，不以 Electron E2E 代替手動驗收。

| 子步驟 | 實際結果 | 判定 |
| --- | --- | --- |
| HUD 預設開啟、展開、保持展開、隱藏 | 可操作；展開後只有一個一般標記入口，保持展開狀態有勾選／提示 | PASS（Mac 子步驟） |
| HUD 標記與鍵盤儲存 | 點擊後填入 `HUD-NATIVE-1022-TIME`，等待後以 Tab／Return 儲存；回主視窗，事件位於原專案 | PASS（此案例） |
| 標記來源時間 | DB 的事件 timestamp 與 `source_timestamp` 同為 `1792632309473`，`source=hud`；沒有另用獨立時鐘量測點擊時間，不據此宣稱所有延遲／故障案例通過 | 子步驟 PASS |
| 設定寫入失敗 | 僅將隔離專案 config.yaml 暫設唯讀，修改 flashOnExposed；檔案雜湊未變，主程序有 EACCES；UI 顯示「儲存失敗，你的修改還在。」及「重試」 | PASS |
| 恢復權限與重試 | 先恢復原本檔案權限，再點重試；UI 顯示已儲存，讀回修改值。沒有修改真實專案或系統權限 | PASS |
| 快速切頁 | 將 flashOnExposed 恢復 true 後立即切到關於；正常退出後仍保存 true | PASS（此案例） |
| 穿透與設定恢復 | 啟用穿透後設定顯示 true；從設定關閉後持久化 false | PASS |
| T020 主視窗快捷鍵 | 修正候選的主視窗聚焦時，⌘⇧P 將勾選 true 改為 false，磁碟讀回也為 false；再次按鍵維持 false | PASS |
| 全域快捷鍵 | 原候選的註冊查詢為 true，但操作者回覆已按後未觀察到關閉；修正候選從 Finder 送出相同按鍵後仍為 true。回 RedLog 自己的視窗按鍵可關閉 | **未通過／原因未確定** |
| 正常結束 | 確認停止並結束，程序 exit 0；沒有殘留診斷 inspector，flashOnExposed=true、passThrough=false，原唯讀故障權限已恢復為 0644 | PASS |
| 關於頁更新說明 | 正確呈現此 Mac 的手動下載／DMG 更新方式；沒有實際安裝另一版本 | 僅說明檢查；T012 保留 |

## 自動化與修正

- RED：新增原生 window-event 測試在修正前為 2 failed / 1 passed。
- 在 main 與 HUD 的 WebContents 綁定同一組既有退出快捷鍵；只關閉穿透。全域與視窗重複投遞不會反向啟用，沒有新按鈕或模式。
- 相關單元／元件測試：7 files / 73 passed，涵蓋持久化、重複投遞、一般輸入及錯誤修飾鍵不被攔截，以及既有設定儲存／標記／更新測試。
- Electron HUD 回歸：7 passed（尺寸、展開／隱藏、縮放與兩種視窗的退出快捷鍵）。打包候選另跑快捷鍵案例：1 passed。
- Playwright 的 CDP keyboard 未產生 `before-input-event`（診斷記錄為 undefined）；原生路徑改用 Electron `sendInputEvent`，沒有手動 emit 被測事件或跳過斷言。實際主視窗按鍵另以上表原生操作驗證。HUD 視窗的按鍵目前是原生輸入管線整合測試，未冒稱兩個視窗都經操作者實按。
- typecheck、architecture、build 與打包資源／簽章檢查通過。這是有界修正，沿用先前 4082-pass 全回歸；沒有因文件整理再重跑全套。

## 使用者提供的 Electron 當機報告

報告為 Electron PID 10253，2026-10-22 09:43:11，SIGABRT。PID／時間與本輪沙盒內 E2E 啟動完全相符；堆疊停在 HIServices `_RegisterApplication`／AppKit 初始化，尚未進入 RedLog 的操作流程。

同一版程式在獲准的沙盒外環境啟動，快捷鍵案例及七項 HUD 回歸均通過；原生打包候選亦正常退出。這些差異支持「沙盒啟動環境失敗」的判斷，不能用它宣稱產品所有啟動情境都安全。沒有為此改產品碼、降級 Electron 或關閉安全保護。當機原文留在使用者附件，不納入 repo。

## 收斂邊界

T020 的視窗內恢復已完成。**T011 仍開啟**：全域按鍵註冊成功不等於真的送達，尚未確定是 OS／原生輸入工具還是 App 全域路徑造成；設定恢復路徑可用，不把它算成全域驗收通過。

T009 保留尚未完成的完整設定／專案切換矩陣；T008、T010、T012 與 T013 也維持未完成。沒有將此 Mac 子流程改寫成 Windows/Linux 安裝、實際更新或完整跨平台驗收。
