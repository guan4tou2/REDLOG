# 2026-09-27 改善實作進度

基準：main 6140d61（v0.18.0）。工作分支：codex/evidence-workflow-completion。
承接 [完整盤點](2026-09-27-app-design-audit.md)，不是宣告所有建議已完成。
本批由使用者於 2026-09-28 授權提交／推送至工作分支；確切版本以 Git 紀錄為準。GitHub issues 未關閉。

## 已實作的缺陷修正

- F01：HAR 使用預覽核准的 redacted events，禁止 execute 重新擴大查詢。
- F02：bundle 只帶 surviving event 引用的截圖與 body；do-not-export 與 orphan 圖片不外流，包含直接匯出入口。
- F03：附件 path/bytes/SHA-256 固定於 preview；變動、消失或 copy 不一致阻擋完成包。cast 先複製驗證，再 scrub。
- F04：直接 HAR 不再默默限制 50,000 events。
- #223：Settings 初次讀取可重試、拒絕儲存不送成功通知、StrictMode 正確更新；scope 重試會重讀 scope。
- #223：設定寫入依專案序列化，close 前 flush；失敗保留 draft 並阻擋 close；離開/重開設定不遺失未存內容。
- F06：設定指令只展示可複製草稿，不向任何既有 PTY 寫入。
- F07：截圖/目標頁 query rejection 可重試；目標切換丟棄過期回覆，分頁失敗保留已載入資料。
- F08：時間篩選測試固定時鐘，避免午夜把正確跨日顯示判成錯誤。
- #217：首次 command 前提供 focus 與 Web setup；Web focus 不要求先使用內建終端。
- F09：真實 HTTPS 測試找到憑證 IP SAN 無法 JSON 序列化，整筆 response 會遺失；已改為文字，IPv4／IPv6 回歸通過。
- F10：800–1400px 的操作列／狀態列不再裁切，長專案名稱截短；窄視窗首次使用終端改上下排列。
- #220：Spec 040 實作 per-client／per-protocol／per-attempt 驗證，request-only 不通過；代理重啟清除結果，失敗可見，CA 存在與系統信任分開。
- #224：clipboard 必須獨立 opt-in；Settings/Health/producer 共用選擇規則。

## 驗證紀錄

缺陷先重現再修正。三個 export artifact 測試、五個 Settings/filter 測試、
三個讀取/切換測試、Web-before-command、clipboard opt-in 均曾於修改前失敗。
設定 queue、草稿元件先建行為測試，初次因尚無實作而失敗。

- 完整 Vitest：269 files passed / 1 skipped，2773 tests passed / 11 skipped。
  跳過：9 個 opt-in performance tests、2 個非本平台 ACL tests。
- 最初 sandbox run 的 localhost EPERM 與 watcher notification 失敗，
  在允許本機服務環境重驗：51 tests passed；未為環境限制修改產品。
- 移除 production 未使用的 attachment-count helper 後，export regression 39 tests passed。
- typecheck、build、Spec Kit gate 通過；architecture gate 抓到上述 unused helper，移除後通過。
- Electron 17 個場景通過；設定 draft 重開改善後重跑受影響 14 個場景全部通過。
- 使用隔離 HOME；未改操作者的真實 shell profile、CA trust 或真實專案。
- 已檢視 Web setup 與 command draft 真實畫面；Web 標題仍寫 command 的文案亦已修正，相關 Electron 首次使用流程已通過。

明確 defect 採 constitution 容許的 assess → fix → verify；沒有把原有
Verified specs 偷改成「新功能已完成」。下一批跨層 verification contract
需有界 Spec，引用既有 domain/Spec 039，不逆向重寫整個專案。

## 尚未完成，繼續工作範圍

- #218：外部 shell stdout/stderr、tmux、長互動 session 的使用者驗證流程。
- #219：per-session target context；不可用全域 active target 冒充確定歸因。
- #221：產物原檔有界保存、hash 與指令 provenance。
- #222：操作者逐附件選擇，cast scope 風險明示；目前仍為整份 session 附件，未承諾自動裁切。
- F05：所有匯出承接 canonical query filter。
- #225：沿用 Transcript 的人工挑選 Markdown 材料，不新增報告編輯器。
- #226：macOS 本機打包 App 已驗證 HTTP/HTTPS 與 session helper；尚欠 Windows／WSL、下載安裝及 Gatekeeper 路徑。不是宣告三平台發版驗收完成。

## 2026-09-28 來源驗證與窄視窗收尾

- HTTP／onboarding／proxy／CA／addon：6 files、59 tests passed。
- 真實 mitmproxy 12.2.3 + Electron 44.4.1：本機 Chromium HTTP、外部 curl HTTPS（404 body），分格驗證成功；無關請求不通過。
- 開發版真實 HTTPS 起初失敗：只存 request。Python 回歸明確重現
  `TypeError: Object of type IPv4Address is not JSON serializable`；SAN 轉字串後原流程通過。
- 重新打包 macOS ARM App（未簽章、未發布），在隔離 HOME 中驗證同一條 HTTP/HTTPS 路徑及已打包 session helper。
- 窄視窗鍵盤與幾何檢查涵蓋 800／1000／1400px、中英、長專案名稱；不把原本 1400px 截圖當窄視窗通過。
- 未修改使用者 root CA trust。測試 origin CA 與 curl trust 只限暫存目錄／子程序。
- 詳細命令、工作流 gate 與限制：[Spec 040 verification](../../specs/040-http-verification-attempts/verification.md)。
- 上述 2773 tests 是前一批完整 suite；本批是針對修改追加驗證，沒有宣稱重新跑過全套。

本輪收尾：最終開發版桌面 E2E 9/9；最終 macOS 打包 App 的窄視窗、HTTP/HTTPS、session helper 3/3。typecheck／build／architecture／Spec Kit／package resources gate 通過。Spec 040 已 Verified；其餘待辦維持上列範圍。

## F05 最新核對（未實作）

再次核對目前工作樹：HTTP 頁的 method／status／text 是 flow 層篩選，
匯出仍把 filtered flows 的時間最小／最大值轉成 time-range；不能代表
完整查詢條件。JSON／NDJSON／bundle 的 boundedSubset 仍明確不支援。
下一個有界實作應讓 ExportPlan 接 canonical EventFilter 與 flow 條件，
並區分「目前查詢結果」與「全部專案」。不以已載入 event IDs 假冒全量查詢，
也不把來源 hash chain 的部分資料宣稱為完整證據鏈。本輪沒有偷改這項能力。
