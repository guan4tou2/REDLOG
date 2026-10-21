# Mac 匯出整合驗收（2026-10-21–22）

使用隔離 HOME 與先前建立的 Mac-Acceptance-20261021 專案。原生操作由桌面 accessibility／點擊／鍵盤逐步執行；Playwright 自動測試分開列，不冒充人工操作。沒有開啟真實交戰專案。候選 App 不覆蓋 /Applications/RedLog.app。

## 已完成的原生流程

候選：`/private/tmp/redlog-export-dialog-20261021-dist/mac-arm64/RedLog.app`，0.18.3 本機測試包，不是已發佈版本。

1. 從搜尋 `MAC-SEARCH-OUTPUTONLY1021` 開啟匯出：直接出現單一視窗；預覽為 1 筆，保留完整搜尋條件及隱藏私人流量條件。
2. JSON 換 NDJSON：範圍及查詢不變，確認一次成功；回到搜尋，焦點恢復匯出按鈕。
3. 讀實際檔案 `.../exports/redlog-2026-10-21T13-20-05.ndjson`：恰好 1 筆，command 為 `printf 'MAC-SEARCH-%s\n' OUTPUTONLY1021`，stdout 為 `MAC-SEARCH-OUTPUTONLY1021`。
4. 重開預設仍為「目前篩選結果」，記住 NDJSON；明確改「整個專案」後，格式仍是 NDJSON。
5. 換證據包後仍是整個專案：預覽 examined=54 / included=47 / excludedPersonal=7。取消 `artifacts/611b780d7c47-report.txt`，預覽排除數變 1、指紋改變。
6. 開原生目的地選擇器並取消：保留原專案 exports 路徑與附件排除選擇。
7. 確認匯出 `.../exports/bundle-2026-10-21T13-21-39`：manifest 與剛看到的指紋一致 `512d043996ea77f7ecb77656eae973a5cf7b01f499b17f8f17261ed2b9761f19`；counts included=47、attachmentsExcludedByOperator=1；被排除檔案不存在。
8. 執行包內 redlog-verify.py：exit 0，45 筆簽章有效、5 個 manifest 檔案 hash 相符；2 筆 logged 存在。此包屬 projection，不能聲稱來源鏈完整，驗證器也明確標示 Source chain NOT VERIFIED、omitted chained=7。
9. 重開後 Escape 一次關閉，回到原查詢，焦點恢復匯出入口。
10. 大視窗截圖檢視：長目的地縮略、有完整 title，條件及警告可換行，附件可捲動，確認／取消固定於底部。

## 手動發現並修正

勾選附件會移除舊預覽、計算後再建立列表，導致鍵盤焦點落到背景。新增失敗測試確認此缺陷，再加入受限制的焦點恢復：僅焦點落到 body 時回原附件；不搶走使用者移到其他控制的焦點。元件回歸通過。最後候選包 `/private/tmp/redlog-export-dialog-final-20261022-dist/mac-arm64/RedLog.app` 原生驗收：Tab 移到附件，空白鍵排除後 checkbox=0、excluded=1、指紋改變，焦點仍在同一個附件。

## 自動化補充

- 9 檔匯出與小視窗相關測試，68 tests passed；包含 11 個新單一視窗行為測試。
- Electron export-preview / external-session / filtered-export：最後7條通過，包含追加的附件焦點及底部按鈕區可見性測試。
- 擴大 filtered-export 為 106 筆匹配（搜尋每頁 100）：英／繁中各 1 條通過。未按載入更多，NDJSON→JSON 仍保留 query；輸出包含全部 106 筆，且不含 preview 後新增的匹配事件。
- 擴大時原測試等待最早一筆，該筆已不在第一頁，屬 fixture 定位失敗；改等第一頁可見的最新一筆，保留匯出逐筆比較，沒有放寬資料斷言。

## 限制

本輪不改安裝、系統 CA 或擷取來源，不把之前安裝驗收重算成此次通過。Windows／Linux 原生新介面未驗收。小視窗 800×850 已有 Electron 雙語測試，附件焦點已原生確認；800×850的附件焦點與按鈕遮擋幾何斷言另由Electron通過。最後將捲動內容與按鈕區分開的CSS有build及Electron回歸，沒有再封裝做原生窄視窗驗收。AI 可選安裝尚未實作，062 整份維持 Draft。

## 收尾

候選包 codesign --verify --deep --strict 通過，仍屬 ad-hoc，不是公證發版。原生驗收App經正常退出確認停止代理，程序已結束。原生捲動工具有短暫noWindowsAvailable／輸入延遲，未將無變化的點擊當作成功；改以後續AX＋截圖核對實際狀態。測試包、隔離資料與輸出保留於private tmp供檢閱，沒有刪真實證據。
