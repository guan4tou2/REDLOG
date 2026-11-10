# UI 色彩、邊框與間距一致性檢查

基準：`main` c614cbf3；本次修正分支 `fix/ui-style-consistency`。本紀錄是檢查證據，
全域規則仍只有 `docs/UIUX-STANDARD.md`。

## 結果與修正

| 項目 | 檢查結果／處理 |
| --- | --- |
| 色票 | 主要工作區使用現有 theme。終端機外框、選取頁籤及搜尋列三處舊色改用 bg／elevated／surface；xterm ANSI 保留。body 改引用共用色票。 |
| 色碼檢查 | 原守門漏掉 Tailwind 方括號色碼，且整個 TerminalView 在例外名單。本次讓方括號色碼在所有 Renderer 檔案都被檢查；字串 API 例外不再豁免周邊 UI class。 |
| 邊框 | 一般控制項／卡片沿用 1px 與 border；列間分隔沿用 border-subtle。文件舊表格與現行色票不同，補記現行 border #74747c、border-subtle #4a4a53 的辨識度理由，未調暗程式色票。 |
| 圓角 | 插件列表／詳情卡片由 4px 與半透明表面對齊共用 8px、surface、density 內距；其他卡片維持 8px；Activity Reader、標記、匯出、插件授權、終端機說明、時間軸說明與關聯圖對話框對齊 12px。保留各 Reader 內容及圖片的既有背景。 |
| 間距 | 儀表板問題列、紀錄／IP 卡片、擷取列與說明對話框改消費 density token；避免外層變緊密、內層仍固定 p-4。一般／緊密內距為 16／10px，頁面區塊距離仍為 24／14px。 |
| 鍵盤焦點 | IconButton 預設改為外置 2px 焦點環與 2px offset，沿用共用 accent 色。 |
| 字級與文字對比 | 沿用現有 13px 下限、字型與灰階文字 token；由既有 contrast／字級守門檢查，不新增另一套字級。 |

## 實際畫面覆蓋

- Electron：1440×900、1440×900 放大 1.25、800×900 放大 1.25。
- 11 個工作區：儀表板、活動紀錄、時間軸、終端機、目標、範圍、截圖、戰利品、書籤、HTTP、設定。
- 額外補拍插件列表／詳情與終端機說明對話框；不進行安裝或授權。
- 實際 CSS 量測：儀表板一般／緊密卡片 padding、表面色、1px 邊框與 8px 圓角；
  終端機外框色、說明對話框的 12px 圓角、表面色與視窗容納範圍。
- 截圖使用測試 IP，不帶入操作員的真實網路地址。

## 保留的差異與限制

儀表板、目標與全寬紀錄工作區各自的最大寬度承載不同內容，不強制一樣寬。
終端機 ANSI、時間軸來源色、圖片預覽、HUD 切角及精簡標題列不當作一般卡片重畫。
這次未驗收 Windows 原生顯示、所有 hover／錯誤組合，亦不代表完整擷取旅程或安裝版驗收。
`UIUX-STANDARD.md` §3／§4 與 §25.4 對輸入框圓角、quiet 邊框的歷史敘述仍有差異；
本次明確記錄此落差，保留既有輸入框與 Button 行為，不透過全域覆寫改變所有控制項。

## 驗證

- `typecheck`、`verify:specs`、`verify:architecture`、`verify:i18n` 通過。
- 推送前最終完整單元測試：5,932 passed／41 skipped（173.66s）；依 `CLAUDE.md`
  順序重新通過四個檢查後執行。最後插件樣式也已包含於這次完整檢查。
- 插件與設計系統相關 8 檔另外通過：82 passed（1.34s）。
- Electron 殼層與設定互動：34 passed；最後視覺／密度 4 案另行執行，結果見下。
- 第一次密度檢查把宣告的 CSS 1px 與 Chromium 在 zoom 0.9 下量化後的
  0.555556px 比較，誤報失敗；改用同一 zoom 下的 1px 參考線比對。
  未放寬成任意邊框寬度，保留卡片表面色、圓角、padding 的獨立量測。

- 最終 Electron 視覺／密度：4 passed（39.2s）；插件卡片的 surface 與 8px 圓角
  在桌面、放大與窄視窗均有 CSS 斷言，終端機說明對話框均可完整容納。
- 最終畫面共 43 張（專案選擇器 1 張；每種尺寸 11 個工作區與 3 個補充狀態）。
  本機輸出：`test-results/visual/{desktop,large-text,narrow}/`，未提交測試產物。
- `git diff --check` 通過；本次修正使用獨立分支 `fix/ui-style-consistency`，不直接修改 main。
