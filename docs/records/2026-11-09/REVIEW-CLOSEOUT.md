# 11 月 9 日審查處理紀錄

基準為 main `3e455574`。本文記錄本輪結果；全域設計使用 UIUX-STANDARD，功能契約沿用各自 Spec。

## 已處理

- 設定頁改為 HOME_SECTIONS 單一頁面註冊表，頁面名稱、三個分類及路由從同一份資料取得。移除已失去導航用途的 groups。
- 搜尋時顯示一個結果列表，清空後回到分類首頁。頁名命中與欄位命中在同一列表合併，保留點擊定位、返回及自動保存。
- 相關單元 25 項、Electron 8 項通過。另保存並檢視 900×700 的搜尋畫面；結果列可讀，原分類列表已收起。
- #636 與新主線的 locale 衝突已整合，保留兩邊所有 key。原始分支繼續承載 IP／Pivot／CDP 修正。

## 效能重測

本機 macOS arm64、Node v26.13.0，使用 20 萬筆同為 agent 的合成事件，查詢不存在的 Codex 來源。每種查詢 10 次。SQL fixture 用於查詢成本，事件未簽章。完整數據在 health-miss-measurement.json。

| 查詢 | 首次 | 中位數 |
|---|---:|---:|
| 主線索引查詢 | 0.069 ms | 0.018 ms |
| 相同 fixture 強制全掃描 | 909.816 ms | 98.981 ms |

實際計畫使用 `idx_events_agent_kind_ts`。主線已修正此來源分類查詢的掃描問題，先前建議「再建立 lastSeen 快取」需重新評估收益。此數據僅證明這條查詢；Windows 開專案 29.8 秒、匯出記憶體及時間軸 frame time 仍須使用原 workload 重測。重測腳本為 `docs/perf-audit-2026-11/bench-health-miss.ts`，可透過既有 run.mjs 執行。

## 仍需完成的工程工作

| 追蹤 | 核對後的實際缺口 | 結案證據 |
|---|---|---|
| #550 cast 內容 | evidence-content 已辨識 cast-recording。通用文字窗口仍未提供 cast 範圍。既有 readCastRange 為非同步，內容服務目前為同步，接入需保留專案邊界、範圍與內容版本。 | 2 MB、多 part、ANSI／UTF-8 邊界、缺檔、變更及讀取失敗；搜尋／複製／另存與實際投影一致。合併 PTY 輸出使用正確名稱。 |
| #591 Reader 語義 | 先盤點 ContentDescriptor 的 status／capture 與各 Reader 映射。Empty 是已保存零長度；unknown／missing／changed／not-captured 各有不同依據。 | 同資料在 Shell／HTTP／AI 的讀取失敗、截斷與恢復矩陣；原始資料不因顯示狀態改寫。 |
| #587 效能 | 來源分類查詢索引已有修正；匯出主程序與時間軸互動需獨立量測。 | 固定版本／資料集下的開啟時間、frame p95、匯出峰值記憶體、rows／bytes／hash 比對。 |
| #593 六條旅程 | 現有 Electron 測試涵蓋部分流程，部分來源為 fixture。 | 記錄真實工具版本、資料來源、事件與輸出檔案，Windows／WSL／Kali 各留平台證據。 |
| #563 Transcript | Reader 與查詢能力保留。獨立路由收斂須覆蓋舊 deep link、palette 及活動頁 Session 條件。 | 相容入口導向同個 Session／事件，搜尋／工具輸出／時間軸往返均可用。 |
| Spec 070 | PR #584 仍為 Draft，涵蓋來源服務、連線與保存等不同狀態。 | 先落地共用狀態契約，再分批驗收各 Adapter；Burp／DNS 另有來源能力邊界。 |
| Timeline 控制邏輯 | 已有子元件及幾何模組；繼續拆分應選資料讀取、選取或 viewport 的單一責任。 | 每批保留定位、增量、專案切換、縮放、返回與不完整範圍測試；檔案行數單獨不作結案條件。 |

## 議題整理依據

#589 的時間軸入口與返回已有實作，獨立 Transcript 仍屬該單未結部分。#590 的雙欄導航已移除，剩餘為深層來源修復全程。#507 已處理 stat 前檔案消失，但其他 spool 競態須依原案例確認。#550 的文案誤判已部分修正，通用讀取仍未完成。這些議題需依剩餘驗收縮小追蹤，避免整單被錯標為完成。

本輪尚未完成 cast 文字投影、匯出背景串流、Timeline 資料控制拆分、Burp／DNS Adapter 或跨作業系統正式包驗收。這些列在上述完成條件，供後續批次執行。

## 完整檢查紀錄

typecheck、verify:specs、verify:architecture、verify:i18n 通過。設定修正分支原生完整單元結果為 5908 passed／4 failed／41 skipped，其中一項 narrow-viewport 仍要求搜尋顯示分類列，已按新契約改為單一結果列表並複驗；包含該測試的 39 項設定／窄窗測試通過。其餘三項為 relay-contract 兩項及 shell-token-not-in-argv 一項，在相同主線產品碼的 #636 分支亦重現（該分支 5915 passed／3 failed／41 skipped）。這些結果與 CI 分開記錄，未將完整本機單元標為全綠。
